/*
  The leave request, the days it covers, who approved it, and the ledger
  that is the only record of a balance.

  docs/ATTENDANCE-LEAVE.html sections 11, 12 and 14.

  THE BALANCE IS NOT STORED ANYWHERE. It is SUM(Days) over dbo.tblLeaveLedger
  for an employee, a category and a cycle, and dbo.vwLeaveBalance at the
  bottom of this file is the only place that sum is written down.

  That is the single most important decision in the leave module, so it is
  worth saying why. A stored BalanceDays column has to be updated by every
  path that touches leave - apply, approve, reject, cancel, withdraw,
  accrue, credit a comp-off, correct by hand, lapse at year end - and the
  day one of those paths is added without its decrement, the number is
  wrong. Not wrong loudly: wrong by half a day, for one person, discovered
  months later, with no way to reconstruct what it should have been.

  An append-only ledger cannot drift, because there is nothing to drift
  from. Every change is a row that says what happened, when, and because of
  what. "Why is my balance 11.5?" is answerable by reading the rows.

  HOLDS. An applied-for, not-yet-approved day must not be spendable twice,
  and must not yet be deducted. So a HOLD row is written on apply with
  IsHold = 1; the balance ignores it and "available" subtracts it. On
  approval the hold is reversed and a DEBIT written; on rejection the hold
  is reversed and nothing else. IsHold is a FLAG and not a sign, because a
  negative held number would be subtracted twice the first time somebody
  summed the column without reading the comment.

  SourceId IS POLYMORPHIC AND HAS NO FOREIGN KEY. It points at a leave
  request, a comp-off credit, an adjustment or a lapse job depending on
  SourceType. It is the only unconstrained reference in this schema and it
  is deliberate: the alternative is four nullable columns with four
  constraints, of which exactly one is ever set.

  Note for hand-written queries: these tables carry filtered indexes, so SQL
  Server refuses INSERT/UPDATE/DELETE unless QUOTED_IDENTIFIER is ON. The
  driver and SSMS set it ON already; sqlcmd does not, so run sqlcmd with -I.
*/

/* -------------------------------------------------------------------------
   1 - the request.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblLeaveRequest', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblLeaveRequest (
        LeaveRequestId   BIGINT         IDENTITY(1,1) NOT NULL,

        EmployeeDetailId BIGINT         NOT NULL,
        LeaveTypeId      BIGINT         NOT NULL,

        /*
          Resolved from the POLICY'S cycle type, not from the date alone. A
          floating holiday taken in February belongs to that calendar year's
          cycle while CL/SL taken the same week belongs to the financial
          year's - the date cannot tell them apart, only the policy can.
        */
        LeaveCycleId     BIGINT         NOT NULL,

        FromDate         DATE           NOT NULL,
        ToDate           DATE           NOT NULL,

        /*
          FULL / FIRST_HALF / SECOND_HALF. Only meaningful on a single-day
          request; the CHECK below enforces that, because "the first half of
          a week" is not a thing the charge calculation can price.
        */
        DayPart          NVARCHAR(12)   NOT NULL
            CONSTRAINT DF_tblLeaveRequest_DayPart DEFAULT 'FULL',

        -- CHARGEABLE days, after the sandwich rule has been applied. Not the
        -- span of the date range.
        TotalDays        DECIMAL(5,2)   NOT NULL,
        -- Of which added by the sandwich rule. Separate so the employee can
        -- be shown why four days were charged for a two-day absence.
        SandwichDays     DECIMAL(5,2)   NOT NULL
            CONSTRAINT DF_tblLeaveRequest_SandwichDays DEFAULT 0,

        /*
          The split, stored rather than recomputed. When somebody on
          probation applies for three days with one day of CL/SL left, two
          days fall through to LWP - and the payslip has to be explainable
          next month without re-running the balance as it stood that day.
        */
        PaidDays         DECIMAL(5,2)   NOT NULL
            CONSTRAINT DF_tblLeaveRequest_PaidDays DEFAULT 0,
        LWPDays          DECIMAL(5,2)   NOT NULL
            CONSTRAINT DF_tblLeaveRequest_LWPDays DEFAULT 0,

        Reason           NVARCHAR(1000) NOT NULL,
        ContactDuringLeave NVARCHAR(100) NULL,
        DocumentUrl      NVARCHAR(2048) NULL,

        Status           NVARCHAR(20)   NOT NULL
            CONSTRAINT DF_tblLeaveRequest_Status DEFAULT 'PENDING_MANAGER',

        /*
          Denormalised from the approval trail for the list screens, which
          would otherwise join to tblLeaveApproval and take its newest row
          for every line of a grid.
        */
        CurrentApproverId BIGINT        NULL,
        DecidedAt        DATETIME2(3)   NULL,

        CancelledAt      DATETIME2(3)   NULL,
        CancelReason     NVARCHAR(500)  NULL,

        CreatedBy        BIGINT         NULL,
        ModifiedBy       BIGINT         NULL,
        CreatedAt        DATETIME2(3)   NOT NULL
            CONSTRAINT DF_tblLeaveRequest_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt       DATETIME2(3)   NOT NULL
            CONSTRAINT DF_tblLeaveRequest_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt        DATETIME2(3)   NULL,

        CONSTRAINT PK_tblLeaveRequest PRIMARY KEY CLUSTERED (LeaveRequestId),

        CONSTRAINT FK_tblLeaveRequest_Employee
            FOREIGN KEY (EmployeeDetailId)
            REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblLeaveRequest_LeaveType
            FOREIGN KEY (LeaveTypeId)  REFERENCES dbo.tblLeaveType (LeaveTypeId),
        CONSTRAINT FK_tblLeaveRequest_Cycle
            FOREIGN KEY (LeaveCycleId) REFERENCES dbo.tblLeaveCycle (LeaveCycleId),
        CONSTRAINT FK_tblLeaveRequest_CurrentApprover
            FOREIGN KEY (CurrentApproverId)
            REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblLeaveRequest_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblLeaveRequest_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblLeaveRequest_DayPart
            CHECK (DayPart IN ('FULL', 'FIRST_HALF', 'SECOND_HALF')),
        CONSTRAINT CK_tblLeaveRequest_Status
            CHECK (Status IN ('DRAFT', 'PENDING_MANAGER', 'PENDING_HR',
                              'APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN')),
        CONSTRAINT CK_tblLeaveRequest_DateRange
            CHECK (ToDate >= FromDate),
        -- See DayPart above.
        CONSTRAINT CK_tblLeaveRequest_HalfDayIsOneDay
            CHECK (DayPart = 'FULL' OR FromDate = ToDate),
        CONSTRAINT CK_tblLeaveRequest_Days
            CHECK (TotalDays > 0 AND SandwichDays >= 0
               AND PaidDays >= 0 AND LWPDays >= 0),
        -- The split must add up, or the payslip and the balance disagree.
        CONSTRAINT CK_tblLeaveRequest_SplitAddsUp
            CHECK (PaidDays + LWPDays = TotalDays)
    );

    -- "My leave", newest first, and the employee's history screen.
    CREATE INDEX IX_tblLeaveRequest_Employee_From
        ON dbo.tblLeaveRequest (EmployeeDetailId, FromDate DESC)
        INCLUDE (LeaveTypeId, Status, TotalDays)
        WHERE DeletedAt IS NULL;

    -- The approver's queue.
    CREATE INDEX IX_tblLeaveRequest_Status_Created
        ON dbo.tblLeaveRequest (Status, CreatedAt)
        INCLUDE (EmployeeDetailId, LeaveTypeId, FromDate, ToDate)
        WHERE DeletedAt IS NULL;

    -- "Who is off this week" - the team calendar, and the overlap check the
    -- apply screen runs before it lets somebody submit.
    CREATE INDEX IX_tblLeaveRequest_DateRange
        ON dbo.tblLeaveRequest (FromDate, ToDate)
        INCLUDE (EmployeeDetailId, Status)
        WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   2 - one row per calendar date in the request.

   Expanded rather than kept as a range, because the interesting questions
   are all per-day: which dates were sandwich days, which fell through to
   LWP, which were half. A range cannot answer any of them, and the
   attendance close needs to look a single date up without parsing ranges.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblLeaveRequestDay', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblLeaveRequestDay (
        LeaveRequestDayId BIGINT        IDENTITY(1,1) NOT NULL,

        LeaveRequestId    BIGINT        NOT NULL,
        LeaveDate         DATE          NOT NULL,

        -- WORKING = an ordinary working day inside the range.
        -- SANDWICH = a week-off or holiday charged by the sandwich rule.
        DayType           NVARCHAR(12)  NOT NULL
            CONSTRAINT DF_tblLeaveRequestDay_DayType DEFAULT 'WORKING',

        DayPart           NVARCHAR(12)  NOT NULL
            CONSTRAINT DF_tblLeaveRequestDay_DayPart DEFAULT 'FULL',

        -- Which specific dates ran out of paid balance. The LWP split in
        -- section 08, at the resolution payroll actually needs.
        IsLWP             BIT           NOT NULL
            CONSTRAINT DF_tblLeaveRequestDay_IsLWP DEFAULT 0,

        ChargedDays       DECIMAL(3,2)  NOT NULL
            CONSTRAINT DF_tblLeaveRequestDay_ChargedDays DEFAULT 1.00,

        CreatedBy         BIGINT        NULL,
        CreatedAt         DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblLeaveRequestDay_CreatedAt DEFAULT SYSUTCDATETIME(),

        CONSTRAINT PK_tblLeaveRequestDay PRIMARY KEY CLUSTERED (LeaveRequestDayId),

        CONSTRAINT FK_tblLeaveRequestDay_Request
            FOREIGN KEY (LeaveRequestId) REFERENCES dbo.tblLeaveRequest (LeaveRequestId),
        CONSTRAINT FK_tblLeaveRequestDay_CreatedBy
            FOREIGN KEY (CreatedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblLeaveRequestDay_DayType
            CHECK (DayType IN ('WORKING', 'SANDWICH')),
        CONSTRAINT CK_tblLeaveRequestDay_DayPart
            CHECK (DayPart IN ('FULL', 'FIRST_HALF', 'SECOND_HALF')),
        CONSTRAINT CK_tblLeaveRequestDay_ChargedDays
            CHECK (ChargedDays IN (0.00, 0.50, 1.00))
    );

    -- A date cannot appear twice in one request.
    CREATE UNIQUE INDEX UQ_tblLeaveRequestDay_Request_Date
        ON dbo.tblLeaveRequestDay (LeaveRequestId, LeaveDate);

    -- "Is this person on leave on this date" - asked by the attendance close
    -- and by the alert sweep, for every employee, every day.
    CREATE INDEX IX_tblLeaveRequestDay_Date
        ON dbo.tblLeaveRequestDay (LeaveDate) INCLUDE (LeaveRequestId, DayPart);
END;
GO

/* -------------------------------------------------------------------------
   3 - the approval trail. APPEND-ONLY.

   One row per decision, not one row per request. A request that goes to the
   manager and then to HR has two rows; a rejection and a resubmission has
   more. No ModifiedAt and no DeletedAt - an approval that can be edited
   afterwards is not an approval.

   ApproverRole is recorded as it was AT THE TIME. The person who approved
   this as a reporting manager may not be one next year, and the trail must
   still say in what capacity they acted.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblLeaveApproval', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblLeaveApproval (
        LeaveApprovalId BIGINT         IDENTITY(1,1) NOT NULL,

        LeaveRequestId  BIGINT         NOT NULL,

        -- 1 = reporting manager, 2 = HR. Second levels exist only where the
        -- policy sets RequiresSecondApproval.
        ApprovalLevel   TINYINT        NOT NULL
            CONSTRAINT DF_tblLeaveApproval_ApprovalLevel DEFAULT 1,

        ApproverId      BIGINT         NOT NULL,
        ApproverRole    NVARCHAR(30)   NOT NULL,

        Action          NVARCHAR(20)   NOT NULL,
        Remarks         NVARCHAR(1000) NULL,

        ActedAt         DATETIME2(3)   NOT NULL
            CONSTRAINT DF_tblLeaveApproval_ActedAt DEFAULT SYSUTCDATETIME(),

        CONSTRAINT PK_tblLeaveApproval PRIMARY KEY CLUSTERED (LeaveApprovalId),

        CONSTRAINT FK_tblLeaveApproval_Request
            FOREIGN KEY (LeaveRequestId) REFERENCES dbo.tblLeaveRequest (LeaveRequestId),
        CONSTRAINT FK_tblLeaveApproval_Approver
            FOREIGN KEY (ApproverId) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblLeaveApproval_Action
            CHECK (Action IN ('SUBMITTED', 'APPROVED', 'REJECTED',
                              'CANCELLED', 'WITHDRAWN', 'FORWARDED')),
        CONSTRAINT CK_tblLeaveApproval_ApproverRole
            CHECK (ApproverRole IN ('MANAGER', 'SECONDARY_MANAGER', 'HR', 'HR_ADMIN', 'ADMIN', 'EMPLOYEE'))
    );

    -- The trail of one request, in order. The only way this is read.
    CREATE INDEX IX_tblLeaveApproval_Request
        ON dbo.tblLeaveApproval (LeaveRequestId, ActedAt);

    -- "What have I approved" - an approver's own history.
    CREATE INDEX IX_tblLeaveApproval_Approver
        ON dbo.tblLeaveApproval (ApproverId, ActedAt DESC);
END;
GO

/* -------------------------------------------------------------------------
   4 - the ledger. APPEND-ONLY, and the only record of a balance.

   See the header. Nothing in this table is ever updated or deleted; a
   mistake is corrected by writing a REVERSAL or an ADJUSTMENT, which is
   what makes the history readable afterwards.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblLeaveLedger', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblLeaveLedger (
        LeaveLedgerId    BIGINT        IDENTITY(1,1) NOT NULL,

        EmployeeDetailId BIGINT        NOT NULL,
        LeaveTypeId      BIGINT        NOT NULL,
        LeaveCycleId     BIGINT        NOT NULL,

        /*
          OPENING              carry-forward from the previous cycle
          ACCRUAL              the monthly or annual grant
          CONFIRMATION_RELEASE EL opening when probation ends
          COMP_OFF_CREDIT      HR crediting an approved comp-off
          HOLD                 applied for, awaiting a decision
          DEBIT                approved and spent
          LWP_DEBIT            unpaid days, counted but never deducted from
                               a paid balance
          REVERSAL             undoing a hold or a debit
          ADJUSTMENT           HR correcting by hand
          LAPSE                unused days expiring at cycle end
        */
        EntryType        NVARCHAR(25)  NOT NULL,

        -- SIGNED. A credit is positive, a debit negative. A hold carries its
        -- days as a positive number and is identified by IsHold, not a sign.
        Days             DECIMAL(6,2)  NOT NULL,

        IsHold           BIT           NOT NULL
            CONSTRAINT DF_tblLeaveLedger_IsHold DEFAULT 0,

        /*
          Polymorphic, and the only unconstrained reference in this schema -
          see the header. LEAVE_REQUEST / COMP_OFF / ADJUSTMENT / ACCRUAL /
          CYCLE_CLOSE.
        */
        SourceType       NVARCHAR(20)  NOT NULL,
        SourceId         BIGINT        NULL,

        -- The date the entry is ABOUT, which is not the date it was written:
        -- an accrual posted late still belongs to its own month.
        EffectiveDate    DATE          NOT NULL,

        -- Mandatory for ADJUSTMENT, enforced in the service rather than by a
        -- CHECK so the message can name the field.
        Remarks          NVARCHAR(500) NULL,

        CreatedBy        BIGINT        NULL,
        CreatedAt        DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblLeaveLedger_CreatedAt DEFAULT SYSUTCDATETIME(),

        CONSTRAINT PK_tblLeaveLedger PRIMARY KEY CLUSTERED (LeaveLedgerId),

        CONSTRAINT FK_tblLeaveLedger_Employee
            FOREIGN KEY (EmployeeDetailId)
            REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblLeaveLedger_LeaveType
            FOREIGN KEY (LeaveTypeId)  REFERENCES dbo.tblLeaveType (LeaveTypeId),
        CONSTRAINT FK_tblLeaveLedger_Cycle
            FOREIGN KEY (LeaveCycleId) REFERENCES dbo.tblLeaveCycle (LeaveCycleId),
        CONSTRAINT FK_tblLeaveLedger_CreatedBy
            FOREIGN KEY (CreatedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblLeaveLedger_EntryType
            CHECK (EntryType IN ('OPENING', 'ACCRUAL', 'CONFIRMATION_RELEASE',
                                 'COMP_OFF_CREDIT', 'HOLD', 'DEBIT', 'LWP_DEBIT',
                                 'REVERSAL', 'ADJUSTMENT', 'LAPSE')),
        CONSTRAINT CK_tblLeaveLedger_SourceType
            CHECK (SourceType IN ('LEAVE_REQUEST', 'COMP_OFF', 'ADJUSTMENT',
                                  'ACCRUAL', 'CYCLE_CLOSE')),
        -- A zero-day entry records nothing and would only ever be noise.
        CONSTRAINT CK_tblLeaveLedger_NonZero
            CHECK (Days <> 0),
        /*
          Only an unapproved application is a hold.

          THIS IS TOO NARROW, AND 021 WIDENS IT. The reversal that clears a
          hold must carry the flag too, or the hold never cancels. Left as
          it was written because this file has been applied - see the note
          at the top of 021_leave_ledger_fixes.sql.
        */
        CONSTRAINT CK_tblLeaveLedger_HoldIsHold
            CHECK (IsHold = 0 OR EntryType = 'HOLD')
    );

    /*
      THE index. Every balance read is this exact query - one employee, one
      category, one cycle - and the view below runs it for every row it
      returns.
    */
    CREATE INDEX IX_tblLeaveLedger_Employee_Type_Cycle
        ON dbo.tblLeaveLedger (EmployeeDetailId, LeaveTypeId, LeaveCycleId)
        INCLUDE (Days, IsHold, EntryType);

    -- The statement screen: one person's entries in date order.
    CREATE INDEX IX_tblLeaveLedger_Employee_Effective
        ON dbo.tblLeaveLedger (EmployeeDetailId, EffectiveDate DESC);

    -- "Which ledger rows did this request write" - read when a request is
    -- rejected or cancelled and its hold has to be reversed.
    CREATE INDEX IX_tblLeaveLedger_Source
        ON dbo.tblLeaveLedger (SourceType, SourceId) WHERE SourceId IS NOT NULL;
END;
GO

/* -------------------------------------------------------------------------
   5 - settle the debt 016 left behind.

   tblAttendanceDay.LeaveRequestId was created as a plain column because
   this table did not exist yet. Its own batch, as in 005 and 017.
   ------------------------------------------------------------------------- */

IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_tblAttendanceDay_LeaveRequest'
)
BEGIN
    ALTER TABLE dbo.tblAttendanceDay
        ADD CONSTRAINT FK_tblAttendanceDay_LeaveRequest
            FOREIGN KEY (LeaveRequestId) REFERENCES dbo.tblLeaveRequest (LeaveRequestId);
END;
GO

/* -------------------------------------------------------------------------
   6 - dbo.vwLeaveBalance.

   THE ONE PLACE THE BALANCE SUM IS WRITTEN DOWN. Every screen that shows a
   balance reads this view; no service computes its own, because two
   versions of this arithmetic is how the dashboard and the apply screen
   come to disagree about whether somebody has half a day left.

   Four figures, and they are not the same question:

     Accrued    everything granted - opening, accruals, comp-off credits
     Consumed   everything spent, as a positive number
     Balance    what the ledger adds up to, holds excluded
     Available  Balance minus holds. What the apply screen must check

   LWPDaysConsumed is deliberately NOT subtracted from anything. The HR
   document is explicit that LWP must never be deducted from paid leave; it
   is a count of unpaid days for payroll and it sits alongside the balance
   rather than inside it.

   CREATE OR ALTER so a later migration can revise it, and alone in its own
   batch because CREATE VIEW must be the first statement in one.
   ------------------------------------------------------------------------- */
GO
CREATE OR ALTER VIEW dbo.vwLeaveBalance
AS
SELECT
    l.EmployeeDetailId,
    l.LeaveTypeId,
    l.LeaveCycleId,

    -- Grants only.
    SUM(CASE WHEN l.IsHold = 0
              AND l.EntryType IN ('OPENING', 'ACCRUAL', 'CONFIRMATION_RELEASE',
                                  'COMP_OFF_CREDIT')
              AND l.Days > 0
             THEN l.Days ELSE 0 END)                       AS AccruedDays,

    -- Spends, flipped to a positive number: "7.5 days used" reads better
    -- than "-7.5 days used" on every screen that shows it.
    SUM(CASE WHEN l.IsHold = 0 AND l.EntryType = 'DEBIT'
             THEN -l.Days ELSE 0 END)                      AS ConsumedDays,

    -- Unpaid days. A separate figure - see the header.
    -- ABS() is wrong for the row that UNDOES one; 021 replaces this view.
    SUM(CASE WHEN l.EntryType = 'LWP_DEBIT'
             THEN ABS(l.Days) ELSE 0 END)                  AS LWPDaysConsumed,

    -- Applied for, not yet decided.
    SUM(CASE WHEN l.IsHold = 1 THEN l.Days ELSE 0 END)     AS HeldDays,

    -- The ledger's own total. Holds are not in it: they have not been spent.
    SUM(CASE WHEN l.IsHold = 0 AND l.EntryType <> 'LWP_DEBIT'
             THEN l.Days ELSE 0 END)                       AS BalanceDays,

    -- What may actually be applied for today.
    SUM(CASE WHEN l.IsHold = 0 AND l.EntryType <> 'LWP_DEBIT'
             THEN l.Days ELSE 0 END)
  - SUM(CASE WHEN l.IsHold = 1 THEN l.Days ELSE 0 END)     AS AvailableDays,

    MAX(l.CreatedAt)                                       AS LastEntryAt
FROM dbo.tblLeaveLedger AS l
GROUP BY l.EmployeeDetailId, l.LeaveTypeId, l.LeaveCycleId;
GO

/*
  Compensatory off: two tables, because the HR document makes it two acts.

  docs/ATTENDANCE-LEAVE.html section 09.

  THE RULE THAT SHAPES THIS FILE, quoted from the HR document: a comp-off is
  never credited merely because attendance exists on a weekend. The manager
  approves that the work happened; HR then credits a day, by hand. Approval
  alone grants nothing.

  That is why one table would be wrong. With a single row carrying a Status
  of APPROVED, "approved" and "credited" are the same fact, and the day the
  balance is granted is the day the manager clicks - which is exactly what
  the HR document forbids. Two tables make the gap between them visible, and
  the gap is where HR's outstanding queue lives.

      tblCompOffRequest   the employee asks, the manager agrees it happened
      tblCompOffCredit    HR grants the day

  APPROVED_AWAITING_CREDIT IS THE WHOLE POINT OF THE STATUS LIST. Without
  it, a request the manager approved and HR has not yet credited is
  indistinguishable from one that has been credited, and it silently
  disappears from everybody's screen - the employee believes they have a
  day, HR never sees it, and nothing is wrong until somebody tries to spend
  it.

  WHY THE CREDIT CARRIES RemainingDays. The ledger is the authority on the
  balance, as always. RemainingDays is denormalised so the apply screen can
  show "2 comp-offs, expiring 14 March and 2 April" without joining the
  ledger to the credits to work out which credit each debit came from -
  comp-offs expire individually, and the balance alone cannot say when.

  ExpiresOn IS NULL UNTIL HR CONFIRMS A VALIDITY PERIOD. That is one of the
  open questions in section 28, not an oversight. A NULL expiry means the
  credit does not lapse, which is the safe reading of silence - the opposite
  default would start quietly destroying days nobody agreed to destroy.

  Note for hand-written queries: these tables carry filtered indexes, so SQL
  Server refuses INSERT/UPDATE/DELETE unless QUOTED_IDENTIFIER is ON. The
  driver and SSMS set it ON already; sqlcmd does not, so run sqlcmd with -I.
*/

/* -------------------------------------------------------------------------
   1 - the request.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblCompOffRequest', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblCompOffRequest (
        CompOffRequestId BIGINT         IDENTITY(1,1) NOT NULL,

        EmployeeDetailId BIGINT         NOT NULL,

        -- The day that was worked. Not the day off being asked for - that
        -- comes later, as an ordinary leave request against the comp-off
        -- category.
        WorkedOnDate     DATE           NOT NULL,

        /*
          The attendance row that evidences the work. Nullable: the US team
          and anyone exempt from punching have no row to point at, and the
          HR document does not require one - the manager's agreement is the
          evidence. When it IS present, the approver can see the hours.
        */
        AttendanceDayId  BIGINT         NULL,

        WorkedMinutes    INT            NULL,

        Reason           NVARCHAR(500)  NOT NULL,

        Status           NVARCHAR(30)   NOT NULL
            CONSTRAINT DF_tblCompOffRequest_Status DEFAULT 'PENDING_MANAGER',

        -- The reporting manager. Approval alone credits nothing - see the
        -- header.
        ApprovedBy       BIGINT         NULL,
        ApprovedAt       DATETIME2(3)   NULL,
        ApproverRemarks  NVARCHAR(1000) NULL,

        CreatedBy        BIGINT         NULL,
        ModifiedBy       BIGINT         NULL,
        CreatedAt        DATETIME2(3)   NOT NULL
            CONSTRAINT DF_tblCompOffRequest_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt       DATETIME2(3)   NOT NULL
            CONSTRAINT DF_tblCompOffRequest_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt        DATETIME2(3)   NULL,

        CONSTRAINT PK_tblCompOffRequest PRIMARY KEY CLUSTERED (CompOffRequestId),

        CONSTRAINT FK_tblCompOffRequest_Employee
            FOREIGN KEY (EmployeeDetailId)
            REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblCompOffRequest_AttendanceDay
            FOREIGN KEY (AttendanceDayId)
            REFERENCES dbo.tblAttendanceDay (AttendanceDayId),
        CONSTRAINT FK_tblCompOffRequest_ApprovedBy
            FOREIGN KEY (ApprovedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblCompOffRequest_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblCompOffRequest_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblCompOffRequest_Status
            CHECK (Status IN ('PENDING_MANAGER', 'APPROVED_AWAITING_CREDIT',
                              'CREDITED', 'REJECTED', 'CANCELLED')),
        CONSTRAINT CK_tblCompOffRequest_WorkedMinutes
            CHECK (WorkedMinutes IS NULL OR WorkedMinutes > 0)
    );

    /*
      ONE REQUEST PER WORKED DAY. Filtered to the live statuses so a
      rejected request does not lock the day - the employee may raise it
      again with a better reason, which is the whole point of a rejection
      that is not a cancellation.
    */
    CREATE UNIQUE INDEX UQ_tblCompOffRequest_Employee_WorkedOn
        ON dbo.tblCompOffRequest (EmployeeDetailId, WorkedOnDate)
        WHERE DeletedAt IS NULL
          AND Status IN ('PENDING_MANAGER', 'APPROVED_AWAITING_CREDIT', 'CREDITED');

    -- The manager's queue, and then HR's. Both read by status, oldest
    -- first - APPROVED_AWAITING_CREDIT is HR's outstanding list.
    CREATE INDEX IX_tblCompOffRequest_Status_Created
        ON dbo.tblCompOffRequest (Status, CreatedAt)
        INCLUDE (EmployeeDetailId, WorkedOnDate)
        WHERE DeletedAt IS NULL;

    -- "My comp-offs", newest first.
    CREATE INDEX IX_tblCompOffRequest_Employee
        ON dbo.tblCompOffRequest (EmployeeDetailId, WorkedOnDate DESC)
        WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   2 - the credit.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblCompOffCredit', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblCompOffCredit (
        CompOffCreditId  BIGINT        IDENTITY(1,1) NOT NULL,

        CompOffRequestId BIGINT        NOT NULL,
        EmployeeDetailId BIGINT        NOT NULL,

        -- 1.00. The HR document specifies one day per approved request; the
        -- column takes a figure so a half day for a half Saturday is a
        -- decision rather than a schema change.
        Days             DECIMAL(3,2)  NOT NULL
            CONSTRAINT DF_tblCompOffCredit_Days DEFAULT 1.00,

        /*
          HR, and never a job. The whole reason this table exists is that
          the credit is a human act - see the header - so the column is NOT
          NULL and the service refuses to write it on anyone's behalf.
        */
        CreditedBy       BIGINT        NOT NULL,
        CreditedAt       DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblCompOffCredit_CreditedAt DEFAULT SYSUTCDATETIME(),

        -- NULL until HR confirms a validity period - section 28.
        ExpiresOn        DATE          NULL,

        -- Denormalised, see the header. Maintained by the leave service as
        -- comp-off days are spent; the ledger remains the authority on the
        -- total.
        RemainingDays    DECIMAL(3,2)  NOT NULL
            CONSTRAINT DF_tblCompOffCredit_RemainingDays DEFAULT 1.00,

        Status           NVARCHAR(20)  NOT NULL
            CONSTRAINT DF_tblCompOffCredit_Status DEFAULT 'AVAILABLE',

        Remarks          NVARCHAR(500) NULL,

        CreatedBy        BIGINT        NULL,
        ModifiedBy       BIGINT        NULL,
        CreatedAt        DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblCompOffCredit_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt       DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblCompOffCredit_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt        DATETIME2(3)  NULL,

        CONSTRAINT PK_tblCompOffCredit PRIMARY KEY CLUSTERED (CompOffCreditId),

        CONSTRAINT FK_tblCompOffCredit_Request
            FOREIGN KEY (CompOffRequestId)
            REFERENCES dbo.tblCompOffRequest (CompOffRequestId),
        CONSTRAINT FK_tblCompOffCredit_Employee
            FOREIGN KEY (EmployeeDetailId)
            REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblCompOffCredit_CreditedBy
            FOREIGN KEY (CreditedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblCompOffCredit_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblCompOffCredit_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblCompOffCredit_Status
            CHECK (Status IN ('AVAILABLE', 'CONSUMED', 'LAPSED')),
        CONSTRAINT CK_tblCompOffCredit_Days
            CHECK (Days > 0 AND RemainingDays >= 0 AND RemainingDays <= Days)
    );

    /*
      ONE CREDIT PER REQUEST. This is the index that makes double-crediting
      impossible rather than merely unlikely - two HR users opening the same
      outstanding request, or one of them double-clicking, and the second
      insert fails at the database instead of granting a second day.
    */
    CREATE UNIQUE INDEX UQ_tblCompOffCredit_Request
        ON dbo.tblCompOffCredit (CompOffRequestId) WHERE DeletedAt IS NULL;

    -- "What comp-off do I have left, and when does it expire" - the apply
    -- screen, and the lapse job's daily sweep.
    CREATE INDEX IX_tblCompOffCredit_Employee_Status
        ON dbo.tblCompOffCredit (EmployeeDetailId, Status, ExpiresOn)
        INCLUDE (RemainingDays)
        WHERE DeletedAt IS NULL;

    -- The lapse job, which asks only "what expires on or before today".
    CREATE INDEX IX_tblCompOffCredit_ExpiresOn
        ON dbo.tblCompOffCredit (ExpiresOn)
        WHERE DeletedAt IS NULL AND Status = 'AVAILABLE' AND ExpiresOn IS NOT NULL;
END;
GO

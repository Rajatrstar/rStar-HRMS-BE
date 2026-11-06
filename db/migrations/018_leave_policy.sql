/*
  Leave policy: the cycles time is measured in, the sandwich rules, the
  policy rows themselves, per-employee overrides, and who is offered what.

  docs/ATTENDANCE-LEAVE.html sections 02-09 and 13.

  THE STRUCTURAL DECISION OF VERSION 2.0, and the reason tblLeaveYear in the
  first draft became tblLeaveCycle here:

      TWO CYCLES RUN AT ONCE.

  CL/SL and Earned Leave run on the financial year, 1 April to 31 March. The
  floating / restricted holiday runs on the calendar year, 1 January to 31
  December. A single "LeaveYear" integer cannot express that - an employee
  who joins in November has a floating entitlement that resets three months
  before their CL/SL does, and with one year number per row the system has
  no way to say which of the two it means. So a cycle is a ROW with a TYPE,
  every ledger entry points at one, and the policy says which type it uses.

  tblLeaveType ALREADY EXISTS - it is master data from 009 and is seeded with
  the company's real categories. This migration does not duplicate it. A
  LEAVE TYPE is the name on the dropdown; a LEAVE POLICY is the rules behind
  that name for a given cohort and a given date range. One type, many
  policies over time.

  WHY A POLICY IS EFFECTIVE-DATED rather than edited in place: last year's
  approved leave was charged under last year's rules, and a balance that
  recomputes when somebody edits the policy is a balance nobody can defend
  in a payroll dispute. A revised policy is a new row.

  THE FOUR FLAGS THAT CARRY THE HR DOCUMENT'S AWKWARD CASES:

    AvailableDuringProbation   may it be applied for at all
    VisibleDuringProbation     does it appear on the dashboard, at zero
    IsPaid                     0 for Leave Without Pay
    TracksBalance              0 for LWP - it counts consumption, it has no
                               balance to spend

  The last two are what let LWP be a real leave category without lying about
  a balance it does not have. The HR document is explicit that LWP must
  never be deducted from paid leave, and these two columns are how that
  becomes a property of the data rather than an `if` somewhere.

  Note for hand-written queries: these tables carry filtered indexes, so SQL
  Server refuses INSERT/UPDATE/DELETE unless QUOTED_IDENTIFIER is ON. The
  driver and SSMS set it ON already; sqlcmd does not, so run sqlcmd with -I.
*/

/* -------------------------------------------------------------------------
   1 - the leave cycle.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblLeaveCycle', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblLeaveCycle (
        LeaveCycleId BIGINT        IDENTITY(1,1) NOT NULL,

        -- FINANCIAL (1 Apr - 31 Mar) or CALENDAR (1 Jan - 31 Dec).
        CycleType    NVARCHAR(12)  NOT NULL,

        -- "FY 2026-27", "CY 2027". What the dashboard tile and every
        -- dropdown shows, so the two never disagree about how a year is
        -- written.
        CycleLabel   NVARCHAR(20)  NOT NULL,

        StartDate    DATE          NOT NULL,
        EndDate      DATE          NOT NULL,

        /*
          Stops a backdated application landing in a settled cycle. Closing
          a year is a deliberate act - after it, corrections go through an
          ADJUSTMENT ledger entry in the current cycle, which is visible,
          rather than by quietly moving a day into a year payroll has
          already paid out.
        */
        IsClosed     BIT           NOT NULL
            CONSTRAINT DF_tblLeaveCycle_IsClosed DEFAULT 0,
        ClosedBy     BIGINT        NULL,
        ClosedAt     DATETIME2(3)  NULL,

        CreatedBy    BIGINT        NULL,
        ModifiedBy   BIGINT        NULL,
        CreatedAt    DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblLeaveCycle_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt   DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblLeaveCycle_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt    DATETIME2(3)  NULL,

        CONSTRAINT PK_tblLeaveCycle PRIMARY KEY CLUSTERED (LeaveCycleId),

        CONSTRAINT FK_tblLeaveCycle_ClosedBy
            FOREIGN KEY (ClosedBy)   REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblLeaveCycle_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblLeaveCycle_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblLeaveCycle_CycleType
            CHECK (CycleType IN ('FINANCIAL', 'CALENDAR')),
        CONSTRAINT CK_tblLeaveCycle_Range
            CHECK (EndDate > StartDate)
    );

    -- One cycle of each type per start date, and one label per type.
    CREATE UNIQUE INDEX UQ_tblLeaveCycle_Type_StartDate
        ON dbo.tblLeaveCycle (CycleType, StartDate) WHERE DeletedAt IS NULL;
    CREATE UNIQUE INDEX UQ_tblLeaveCycle_Type_Label
        ON dbo.tblLeaveCycle (CycleType, CycleLabel) WHERE DeletedAt IS NULL;

    /*
      "Which cycle of this type contains this date" - resolved on every
      apply, every accrual and every balance read. The single most frequent
      lookup in the leave module.
    */
    CREATE INDEX IX_tblLeaveCycle_Type_Range
        ON dbo.tblLeaveCycle (CycleType, StartDate, EndDate)
        INCLUDE (CycleLabel, IsClosed)
        WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   2 - sandwich rules.

   Section 12. Three modes were specified and all three are selectable,
   because which one a company uses is a policy argument rather than a
   technical one:

     IGNORE_WEEKOFF          Friday and Monday off = 2 days. The weekend is
                             not charged.
     COUNT_WHEN_BOTH_FLANKS  Friday and Monday off = 4 days, because the
                             employee was absent on both sides of the
                             weekend. Friday alone is still 1.
     COUNT_ALWAYS            every non-working day inside the range is
                             charged, whichever side it falls.

   A table rather than a column on the policy, so one rule can be shared by
   several categories and changed in one place - and so a location can run a
   different rule, which the two-office setup will eventually need.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblSandwichRule', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblSandwichRule (
        SandwichRuleId BIGINT        IDENTITY(1,1) NOT NULL,

        RuleName       NVARCHAR(100) NOT NULL,
        Mode           NVARCHAR(30)  NOT NULL,

        -- NULL = every location, as elsewhere in this schema.
        LocationId     BIGINT        NULL,

        -- Whether declared holidays inside the range are charged too, not
        -- just week-offs. Separate from Mode because the two questions are
        -- genuinely independent.
        IncludeHolidays BIT          NOT NULL
            CONSTRAINT DF_tblSandwichRule_IncludeHolidays DEFAULT 0,

        Description    NVARCHAR(500) NULL,

        IsActive       BIT           NOT NULL
            CONSTRAINT DF_tblSandwichRule_IsActive DEFAULT 1,

        CreatedBy      BIGINT        NULL,
        ModifiedBy     BIGINT        NULL,
        CreatedAt      DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblSandwichRule_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt     DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblSandwichRule_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt      DATETIME2(3)  NULL,

        CONSTRAINT PK_tblSandwichRule PRIMARY KEY CLUSTERED (SandwichRuleId),

        CONSTRAINT FK_tblSandwichRule_Location
            FOREIGN KEY (LocationId) REFERENCES dbo.tblOrganizationLocation (LocationId),
        CONSTRAINT FK_tblSandwichRule_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblSandwichRule_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblSandwichRule_Mode
            CHECK (Mode IN ('IGNORE_WEEKOFF', 'COUNT_WHEN_BOTH_FLANKS', 'COUNT_ALWAYS'))
    );

    CREATE UNIQUE INDEX UQ_tblSandwichRule_Name
        ON dbo.tblSandwichRule (RuleName) WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   3 - the leave policy.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblLeavePolicy', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblLeavePolicy (
        LeavePolicyId            BIGINT        IDENTITY(1,1) NOT NULL,

        -- The category this is the rulebook for. CL/SL is ONE type and one
        -- policy row - the HR document treats them as a single balance.
        LeaveTypeId              BIGINT        NOT NULL,

        -- The cohort. Both NULL = everybody.
        LocationId               BIGINT        NULL,
        EmploymentType           NVARCHAR(30)  NULL,

        -- FINANCIAL for CL/SL and EL, CALENDAR for floating, NONE for LWP
        -- and comp-off, which do not belong to a cycle at all.
        CycleType                NVARCHAR(12)  NOT NULL
            CONSTRAINT DF_tblLeavePolicy_CycleType DEFAULT 'FINANCIAL',

        /*
          Two separate questions, deliberately two columns.

          AvailableDuringProbation - may somebody on probation apply for it.
          1 for CL/SL and LWP; 0 for EL.

          VisibleDuringProbation - does it appear on their dashboard at all.
          Section 10 of the HR document shows EL on the probation dashboard
          with a zero balance and the note "starts after confirmation",
          which is information rather than an offer. Collapsing these into
          one flag loses exactly that.
        */
        AvailableDuringProbation BIT           NOT NULL
            CONSTRAINT DF_tblLeavePolicy_AvailableDuringProbation DEFAULT 0,
        VisibleDuringProbation   BIT           NOT NULL
            CONSTRAINT DF_tblLeavePolicy_VisibleDuringProbation DEFAULT 1,

        -- 0 for LWP. Read by payroll.
        IsPaid                   BIT           NOT NULL
            CONSTRAINT DF_tblLeavePolicy_IsPaid DEFAULT 1,

        /*
          0 for LWP, and this is the column that keeps the HR document's
          prohibition true: a category that tracks no balance can have
          nothing deducted from it. Its ledger rows are LWP_DEBIT entries
          counted separately, never offset against paid leave.
        */
        TracksBalance            BIT           NOT NULL
            CONSTRAINT DF_tblLeavePolicy_TracksBalance DEFAULT 1,

        -- MONTHLY / ANNUAL / NONE.
        AccrualFrequency         NVARCHAR(20)  NOT NULL
            CONSTRAINT DF_tblLeavePolicy_AccrualFrequency DEFAULT 'NONE',
        -- How much each accrual grants. 1.00 for probation CL/SL and for EL.
        AccrualDays              DECIMAL(5,2)  NOT NULL
            CONSTRAINT DF_tblLeavePolicy_AccrualDays DEFAULT 0,

        /*
          WHERE THE MONTHLY CLOCK STARTS. This column exists because the two
          source documents disagree and HR's own question 3 asks a third
          version:

            CYCLE_START    1 April, the same day for everybody
            MONTH_START    the 1st of each month - the original requirement
            PROBATION_END  the confirmation anniversary - the HR document
            JOINING_DATE   the joining anniversary

          Recorded in section 28 as open. Whichever answer HR settles on is
          then a configuration value, not a rewrite of the accrual job.
        */
        AccrualAnchor            NVARCHAR(30)  NOT NULL
            CONSTRAINT DF_tblLeavePolicy_AccrualAnchor DEFAULT 'MONTH_START',

        -- Whether a mid-cycle joiner gets a reduced first-year entitlement.
        ProRateOnJoining         BIT           NOT NULL
            CONSTRAINT DF_tblLeavePolicy_ProRateOnJoining DEFAULT 1,

        -- The ceiling for the cycle. 1 for floating / restricted. NULL =
        -- no ceiling beyond what accrues.
        AnnualQuota              DECIMAL(5,2)  NULL,
        -- How much may be carried into the next cycle. 0 = use it or lose it.
        MaxCarryForward          DECIMAL(5,2)  NULL,

        AllowHalfDay             BIT           NOT NULL
            CONSTRAINT DF_tblLeavePolicy_AllowHalfDay DEFAULT 1,
        -- 0 would mean "cannot be applied for retrospectively", which
        -- maternity and bereavement both need to be able to do.
        AllowBackdated           BIT           NOT NULL
            CONSTRAINT DF_tblLeavePolicy_AllowBackdated DEFAULT 1,
        -- How far ahead the employee must ask. 0 = no notice required.
        MinNoticeDays            INT           NOT NULL
            CONSTRAINT DF_tblLeavePolicy_MinNoticeDays DEFAULT 0,
        -- Beyond this many days in one application, a document is expected.
        RequiresDocumentAfterDays INT          NULL,

        -- NULL = this category has no sandwich behaviour at all.
        SandwichRuleId           BIGINT        NULL,

        -- Comp-off expiry, in days from the credit. NULL until HR confirms
        -- one - section 28.
        ValidityDays             INT           NULL,

        -- Maternity and paternity go to HR as well as to the manager.
        RequiresSecondApproval   BIT           NOT NULL
            CONSTRAINT DF_tblLeavePolicy_RequiresSecondApproval DEFAULT 0,

        EffectiveFrom            DATE          NOT NULL,
        EffectiveTo              DATE          NULL,

        IsActive                 BIT           NOT NULL
            CONSTRAINT DF_tblLeavePolicy_IsActive DEFAULT 1,

        CreatedBy                BIGINT        NULL,
        ModifiedBy               BIGINT        NULL,
        CreatedAt                DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblLeavePolicy_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt               DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblLeavePolicy_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt                DATETIME2(3)  NULL,

        CONSTRAINT PK_tblLeavePolicy PRIMARY KEY CLUSTERED (LeavePolicyId),

        CONSTRAINT FK_tblLeavePolicy_LeaveType
            FOREIGN KEY (LeaveTypeId)    REFERENCES dbo.tblLeaveType (LeaveTypeId),
        CONSTRAINT FK_tblLeavePolicy_Location
            FOREIGN KEY (LocationId)     REFERENCES dbo.tblOrganizationLocation (LocationId),
        CONSTRAINT FK_tblLeavePolicy_SandwichRule
            FOREIGN KEY (SandwichRuleId) REFERENCES dbo.tblSandwichRule (SandwichRuleId),
        CONSTRAINT FK_tblLeavePolicy_CreatedBy
            FOREIGN KEY (CreatedBy)      REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblLeavePolicy_ModifiedBy
            FOREIGN KEY (ModifiedBy)     REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblLeavePolicy_CycleType
            CHECK (CycleType IN ('FINANCIAL', 'CALENDAR', 'NONE')),
        CONSTRAINT CK_tblLeavePolicy_AccrualFrequency
            CHECK (AccrualFrequency IN ('MONTHLY', 'ANNUAL', 'NONE')),
        CONSTRAINT CK_tblLeavePolicy_AccrualAnchor
            CHECK (AccrualAnchor IN ('CYCLE_START', 'MONTH_START', 'PROBATION_END', 'JOINING_DATE')),
        CONSTRAINT CK_tblLeavePolicy_Days
            CHECK (AccrualDays >= 0
               AND (AnnualQuota     IS NULL OR AnnualQuota     >= 0)
               AND (MaxCarryForward IS NULL OR MaxCarryForward >= 0)
               AND (ValidityDays    IS NULL OR ValidityDays    >  0)
               AND MinNoticeDays >= 0),
        CONSTRAINT CK_tblLeavePolicy_EffectiveRange
            CHECK (EffectiveTo IS NULL OR EffectiveTo >= EffectiveFrom),
        /*
          A category that tracks no balance cannot accrue into one. This is
          the LWP invariant written as a constraint rather than trusted to a
          code path - get it wrong and LWP starts silently granting days.
        */
        CONSTRAINT CK_tblLeavePolicy_NoBalanceNoAccrual
            CHECK (TracksBalance = 1 OR (AccrualFrequency = 'NONE' AND AccrualDays = 0))
    );

    /*
      One policy per (type, cohort, start date). The date is in the key
      because a revised policy is a new row - see the header - so the same
      category and cohort legitimately appears many times over the years.
    */
    CREATE UNIQUE INDEX UQ_tblLeavePolicy_Type_Cohort_From
        ON dbo.tblLeavePolicy (LeaveTypeId, LocationId, EmploymentType, EffectiveFrom)
        WHERE DeletedAt IS NULL;

    -- "Which policies apply to this person on this date" - the resolver
    -- behind the dashboard, the apply screen and the accrual job.
    CREATE INDEX IX_tblLeavePolicy_Effective
        ON dbo.tblLeavePolicy (EffectiveFrom, EffectiveTo)
        INCLUDE (LeaveTypeId, LocationId, EmploymentType, CycleType)
        WHERE DeletedAt IS NULL AND IsActive = 1;
END;
GO

/* -------------------------------------------------------------------------
   4 - per-employee overrides.

   "Customize leave policy for certain employees" from the requirement list.
   An override is not a second policy: it borrows the whole rulebook and
   replaces one or two numbers on it, so a change to the underlying policy
   still reaches the people who have an exception.

   Reason is NOT NULL. An exception nobody has to justify becomes an
   exception nobody can review.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblEmployeeLeavePolicy', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblEmployeeLeavePolicy (
        EmployeeLeavePolicyId BIGINT        IDENTITY(1,1) NOT NULL,

        EmployeeDetailId      BIGINT        NOT NULL,
        LeavePolicyId         BIGINT        NOT NULL,

        -- NULL means "do not override this one" - which is why they are
        -- nullable rather than copies of the policy's values.
        OverrideAnnualQuota   DECIMAL(5,2)  NULL,
        OverrideAccrualDays   DECIMAL(5,2)  NULL,

        EffectiveFrom         DATE          NOT NULL,
        EffectiveTo           DATE          NULL,

        Reason                NVARCHAR(500) NOT NULL,

        IsActive              BIT           NOT NULL
            CONSTRAINT DF_tblEmployeeLeavePolicy_IsActive DEFAULT 1,

        CreatedBy             BIGINT        NULL,
        ModifiedBy            BIGINT        NULL,
        CreatedAt             DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblEmployeeLeavePolicy_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt            DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblEmployeeLeavePolicy_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt             DATETIME2(3)  NULL,

        CONSTRAINT PK_tblEmployeeLeavePolicy PRIMARY KEY CLUSTERED (EmployeeLeavePolicyId),

        CONSTRAINT FK_tblEmployeeLeavePolicy_Employee
            FOREIGN KEY (EmployeeDetailId)
            REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeLeavePolicy_Policy
            FOREIGN KEY (LeavePolicyId) REFERENCES dbo.tblLeavePolicy (LeavePolicyId),
        CONSTRAINT FK_tblEmployeeLeavePolicy_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeLeavePolicy_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblEmployeeLeavePolicy_Days
            CHECK ((OverrideAnnualQuota IS NULL OR OverrideAnnualQuota >= 0)
               AND (OverrideAccrualDays IS NULL OR OverrideAccrualDays >= 0)),
        CONSTRAINT CK_tblEmployeeLeavePolicy_EffectiveRange
            CHECK (EffectiveTo IS NULL OR EffectiveTo >= EffectiveFrom),
        -- An override that overrides nothing is a row with no effect and no
        -- way for a reviewer to tell it was a mistake.
        CONSTRAINT CK_tblEmployeeLeavePolicy_HasOverride
            CHECK (OverrideAnnualQuota IS NOT NULL OR OverrideAccrualDays IS NOT NULL)
    );

    CREATE UNIQUE INDEX UQ_tblEmployeeLeavePolicy_Employee_Policy_From
        ON dbo.tblEmployeeLeavePolicy (EmployeeDetailId, LeavePolicyId, EffectiveFrom)
        WHERE DeletedAt IS NULL;

    CREATE INDEX IX_tblEmployeeLeavePolicy_Employee
        ON dbo.tblEmployeeLeavePolicy (EmployeeDetailId, EffectiveFrom DESC)
        WHERE DeletedAt IS NULL AND IsActive = 1;
END;
GO

/* -------------------------------------------------------------------------
   5 - leave mapping: which categories a cohort is offered at all.

   "Employee Leaves Mapping" from the requirement list. A row is a GRANT:
   maternity leave mapped to female employees in India with twelve months'
   tenure means exactly that cohort sees it on the apply screen, and nobody
   else does.

   Distinct from tblLeavePolicy, which says how a category BEHAVES. Mapping
   says whether it is on offer. Keeping them apart is what lets one policy
   serve several mapped cohorts without copying its rules.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblLeaveMapping', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblLeaveMapping (
        LeaveMappingId   BIGINT        IDENTITY(1,1) NOT NULL,

        LeaveTypeId      BIGINT        NOT NULL,

        -- Every criterion is NULLable and NULL means "do not filter on
        -- this". A row with all four NULL offers the category to everybody.
        LocationId       BIGINT        NULL,
        EmploymentType   NVARCHAR(30)  NULL,
        -- Maternity and paternity are the reason this column exists.
        Gender           NVARCHAR(30)  NULL,
        MinTenureMonths  INT           NULL,

        -- Whether somebody on probation is offered it, independent of the
        -- policy's own flag: mapping decides the audience, policy decides
        -- the rules, and either can exclude.
        AvailableDuringProbation BIT   NOT NULL
            CONSTRAINT DF_tblLeaveMapping_AvailableDuringProbation DEFAULT 0,

        IsActive         BIT           NOT NULL
            CONSTRAINT DF_tblLeaveMapping_IsActive DEFAULT 1,

        CreatedBy        BIGINT        NULL,
        ModifiedBy       BIGINT        NULL,
        CreatedAt        DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblLeaveMapping_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt       DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblLeaveMapping_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt        DATETIME2(3)  NULL,

        CONSTRAINT PK_tblLeaveMapping PRIMARY KEY CLUSTERED (LeaveMappingId),

        CONSTRAINT FK_tblLeaveMapping_LeaveType
            FOREIGN KEY (LeaveTypeId) REFERENCES dbo.tblLeaveType (LeaveTypeId),
        CONSTRAINT FK_tblLeaveMapping_Location
            FOREIGN KEY (LocationId)  REFERENCES dbo.tblOrganizationLocation (LocationId),
        CONSTRAINT FK_tblLeaveMapping_CreatedBy
            FOREIGN KEY (CreatedBy)   REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblLeaveMapping_ModifiedBy
            FOREIGN KEY (ModifiedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblLeaveMapping_MinTenureMonths
            CHECK (MinTenureMonths IS NULL OR MinTenureMonths >= 0)
    );

    -- One mapping per (type, cohort). NULLs compare equal in a unique index,
    -- so the everybody row can only be declared once.
    CREATE UNIQUE INDEX UQ_tblLeaveMapping_Type_Cohort
        ON dbo.tblLeaveMapping (LeaveTypeId, LocationId, EmploymentType, Gender)
        WHERE DeletedAt IS NULL;

    -- "What may this person apply for" - the apply screen's first query.
    CREATE INDEX IX_tblLeaveMapping_Cohort
        ON dbo.tblLeaveMapping (LocationId, EmploymentType)
        INCLUDE (LeaveTypeId, Gender, MinTenureMonths)
        WHERE DeletedAt IS NULL AND IsActive = 1;
END;
GO

/* -------------------------------------------------------------------------
   6 - settle the two debts 017 left behind.

   tblRestrictedHolidayMapping.LeaveCycleId and
   tblRestrictedHolidayOptIn.LeaveCycleId were created as plain columns
   because tblLeaveCycle did not exist yet. Their own batch, because a
   constraint cannot reference a table created in the same one.
   ------------------------------------------------------------------------- */

IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_tblRestrictedHolidayMapping_Cycle'
)
BEGIN
    ALTER TABLE dbo.tblRestrictedHolidayMapping
        ADD CONSTRAINT FK_tblRestrictedHolidayMapping_Cycle
            FOREIGN KEY (LeaveCycleId) REFERENCES dbo.tblLeaveCycle (LeaveCycleId);
END;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_tblRestrictedHolidayOptIn_Cycle'
)
BEGIN
    ALTER TABLE dbo.tblRestrictedHolidayOptIn
        ADD CONSTRAINT FK_tblRestrictedHolidayOptIn_Cycle
            FOREIGN KEY (LeaveCycleId) REFERENCES dbo.tblLeaveCycle (LeaveCycleId);
END;
GO

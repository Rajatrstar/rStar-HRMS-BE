/*
  Attendance: the day, the punches that made it, and the corrections to it.

  docs/ATTENDANCE-LEAVE.html sections 15-19. Seven tables, and the shape of
  all of them follows from one decision:

      THE DAY IS THE SPINE, NOT THE PUNCH.

  tblAttendanceDay holds exactly one row per employee per date, and every
  other table in this module points at it. The alternative - deriving the
  day from the punches whenever anyone asks - cannot represent the days that
  matter most: a holiday with no punches, a week-off, somebody on approved
  leave, somebody present by default who never punches at all. Those are not
  absences, and a model built on punches has no row to say so.

  A punch is therefore EVIDENCE, and the day is the ANSWER. The nightly close
  reads the evidence and writes the answer; nothing else writes WorkedMinutes.

  WHY PUNCHES ARE APPEND-ONLY: a check-in time that can be edited is not a
  record of when somebody arrived, it is a record of what was last typed. A
  wrong punch is corrected through tblRegularizationRequest - which keeps
  both the original and the correction, and names who approved it. That is
  the difference between an attendance system and a spreadsheet.

  MIDNIGHT. A punch at 00:30 on the evening shift belongs to the PREVIOUS
  day's attendance row. AttendanceDayId on the punch is what settles it:
  the attachment is decided once, when the punch is accepted, by the shift
  in force - not re-derived later by code that has to guess.

  CROSS-MODULE COLUMNS. LeaveRequestId points at a table that does not exist
  until 019, so it is created here as a plain column and the FOREIGN KEY is
  added at the bottom of 019 - the same way 005 settled the WorkLocationId
  debt that 001 left behind. HolidayId is constrained in 017.

  Note for hand-written queries: these tables carry filtered indexes, so SQL
  Server refuses INSERT/UPDATE/DELETE unless QUOTED_IDENTIFIER is ON. The
  driver and SSMS set it ON already; sqlcmd does not, so run sqlcmd with -I.
*/

/* -------------------------------------------------------------------------
   1 - the status catalog.

   IDS ARE FIXED AND OWNED BY THE CODE, exactly like dbo.tblModule. They are
   seeded from ATTENDANCE_STATUS_CATALOG in src/enums/attendance.enum.js and
   every id is stored in tblAttendanceDay rows forever.

   DELIBERATELY NOT IN THE MASTER-DATA REGISTRY, although its shape would fit.
   The design document groups it with the editable lookups; it does not
   belong there. The nightly close branches on PRESENT and HALF_DAY by name,
   so a screen that lets somebody rename "Present" or soft-delete it would
   break the job that writes the table - and the failure would appear hours
   later, as every employee being marked absent.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblAttendanceStatus', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblAttendanceStatus (
        -- Not IDENTITY: the application supplies the number, and it never
        -- changes. See the note above.
        AttendanceStatusId INT           NOT NULL,

        StatusCode         NVARCHAR(20)  NOT NULL,
        StatusName         NVARCHAR(50)  NOT NULL,
        Description        NVARCHAR(255) NULL,

        /*
          Whether a day with this status counts as attended for payroll.
          A column rather than a list in code, because "does a half day count
          as present" is a payroll question that differs by company and must
          not be answered by a hard-coded set of ids.
        */
        CountsAsPresent    BIT           NOT NULL
            CONSTRAINT DF_tblAttendanceStatus_CountsAsPresent DEFAULT 0,

        -- Hex, for the calendar grid. The frontend should not keep its own
        -- colour map and disagree with the legend.
        ColorHex           NVARCHAR(7)   NULL,
        SortOrder          INT           NOT NULL
            CONSTRAINT DF_tblAttendanceStatus_SortOrder DEFAULT 0,

        IsActive           BIT           NOT NULL
            CONSTRAINT DF_tblAttendanceStatus_IsActive DEFAULT 1,

        CreatedAt          DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblAttendanceStatus_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt         DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblAttendanceStatus_ModifiedAt DEFAULT SYSUTCDATETIME(),

        CONSTRAINT PK_tblAttendanceStatus PRIMARY KEY CLUSTERED (AttendanceStatusId),
        CONSTRAINT UQ_tblAttendanceStatus_StatusCode UNIQUE (StatusCode)
    );
END;
GO

/* -------------------------------------------------------------------------
   2 - the attendance day.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblAttendanceDay', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblAttendanceDay (
        AttendanceDayId    BIGINT        IDENTITY(1,1) NOT NULL,

        EmployeeDetailId   BIGINT        NOT NULL,
        AttendanceDate     DATE          NOT NULL,

        /*
          The shift AS RESOLVED on that date, copied here rather than looked
          up on read. tblShift is effective-dated precisely so history
          survives a timing change; storing the id here is the other half of
          that - it keeps the row pointing at the version it was judged by,
          even after somebody closes that row and opens a new one.

          NULL only for a day created before any shift was assigned.
        */
        ShiftId            BIGINT        NULL,

        AttendanceStatusId INT           NOT NULL,

        /*
          First IN and last OUT, denormalised from the punches.

          A copy of data that lives in tblAttendancePunch, and worth it: the
          monthly grid is thirty-one of these per employee, and computing
          MIN/MAX over the punch table for each cell turns one index scan
          into a thousand. The punches remain the record; these are the
          close job's reading of them.
        */
        FirstCheckInAt     DATETIME2(3)  NULL,
        LastCheckOutAt     DATETIME2(3)  NULL,

        -- Written by the nightly close, never by a client. Net of the
        -- shift's unpaid break.
        WorkedMinutes      INT           NULL,
        -- Past the shift's grace-in. 0 means on time, NULL means not judged.
        LateMinutes        INT           NULL,
        EarlyOutMinutes    INT           NULL,

        /*
          Section 19: some people - the US team, and anyone HR grants an
          exemption - are present unless something says otherwise. This flag
          records that the row was written by the auto-mark job rather than
          by a punch, so "present" and "presumed present" stay distinguishable
          on the exception report.
        */
        IsDefaultPresent   BIT           NOT NULL
            CONSTRAINT DF_tblAttendanceDay_IsDefaultPresent DEFAULT 0,

        -- Set when the day was closed by an approved regularization, so the
        -- grid can show the marker without joining to the request table.
        IsRegularized      BIT           NOT NULL
            CONSTRAINT DF_tblAttendanceDay_IsRegularized DEFAULT 0,

        /*
          Plain columns for now; the FOREIGN KEYs are added at the bottom of
          017 (holiday) and 019 (leave request). See the header.
        */
        HolidayId          BIGINT        NULL,
        LeaveRequestId     BIGINT        NULL,

        Remarks            NVARCHAR(500) NULL,

        CreatedBy          BIGINT        NULL,
        ModifiedBy         BIGINT        NULL,
        CreatedAt          DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblAttendanceDay_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt         DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblAttendanceDay_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt          DATETIME2(3)  NULL,

        CONSTRAINT PK_tblAttendanceDay PRIMARY KEY CLUSTERED (AttendanceDayId),

        CONSTRAINT FK_tblAttendanceDay_Employee
            FOREIGN KEY (EmployeeDetailId)
            REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblAttendanceDay_Shift
            FOREIGN KEY (ShiftId) REFERENCES dbo.tblShift (ShiftId),
        CONSTRAINT FK_tblAttendanceDay_Status
            FOREIGN KEY (AttendanceStatusId)
            REFERENCES dbo.tblAttendanceStatus (AttendanceStatusId),
        CONSTRAINT FK_tblAttendanceDay_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblAttendanceDay_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblAttendanceDay_Minutes
            CHECK ((WorkedMinutes   IS NULL OR WorkedMinutes   >= 0)
               AND (LateMinutes     IS NULL OR LateMinutes     >= 0)
               AND (EarlyOutMinutes IS NULL OR EarlyOutMinutes >= 0))
    );

    /*
      ONE ROW PER EMPLOYEE PER DAY. This is the constraint the whole module
      rests on - it is what lets the punch endpoint, the auto-mark job, the
      leave approver and the regularization approver all write the same day
      without any of them having to check whether one of the others got
      there first. Each does an upsert and the index settles the race.
    */
    CREATE UNIQUE INDEX UQ_tblAttendanceDay_Employee_Date
        ON dbo.tblAttendanceDay (EmployeeDetailId, AttendanceDate)
        WHERE DeletedAt IS NULL;

    -- One person's month: the self-service calendar, and the manager's grid
    -- one employee at a time.
    CREATE INDEX IX_tblAttendanceDay_Employee_Date
        ON dbo.tblAttendanceDay (EmployeeDetailId, AttendanceDate DESC)
        INCLUDE (AttendanceStatusId, WorkedMinutes, LateMinutes)
        WHERE DeletedAt IS NULL;

    -- "Who was absent / late / missing a punch today" - the exception list
    -- HR opens every morning, and what the alert sweep reads.
    CREATE INDEX IX_tblAttendanceDay_Date_Status
        ON dbo.tblAttendanceDay (AttendanceDate, AttendanceStatusId)
        INCLUDE (EmployeeDetailId)
        WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   3 - the punches. APPEND-ONLY.

   No ModifiedBy, no ModifiedAt, no DeletedAt. See the header: a punch that
   can be changed is not evidence of anything.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblAttendancePunch', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblAttendancePunch (
        PunchId         BIGINT        IDENTITY(1,1) NOT NULL,

        AttendanceDayId BIGINT        NOT NULL,

        PunchType       NVARCHAR(10)  NOT NULL,
        PunchAt         DATETIME2(3)  NOT NULL,

        -- WEB / MOBILE / BIOMETRIC / KIOSK / SYSTEM. SYSTEM is a punch
        -- written by an approved regularization, which is why the source is
        -- recorded at all: "who said this happened".
        Source          NVARCHAR(20)  NOT NULL
            CONSTRAINT DF_tblAttendancePunch_Source DEFAULT 'WEB',

        IpAddress       NVARCHAR(45)  NULL,
        UserAgent       NVARCHAR(500) NULL,
        Remarks         NVARCHAR(500) NULL,

        /*
          Normally the employee themselves. Different from the day's
          EmployeeDetailId when an approved regularization writes the punch -
          and then this column names the approver, which is the audit trail.
        */
        CreatedBy       BIGINT        NULL,
        CreatedAt       DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblAttendancePunch_CreatedAt DEFAULT SYSUTCDATETIME(),

        CONSTRAINT PK_tblAttendancePunch PRIMARY KEY CLUSTERED (PunchId),

        CONSTRAINT FK_tblAttendancePunch_Day
            FOREIGN KEY (AttendanceDayId)
            REFERENCES dbo.tblAttendanceDay (AttendanceDayId),
        CONSTRAINT FK_tblAttendancePunch_CreatedBy
            FOREIGN KEY (CreatedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblAttendancePunch_PunchType
            CHECK (PunchType IN ('IN', 'OUT')),
        CONSTRAINT CK_tblAttendancePunch_Source
            CHECK (Source IN ('WEB', 'MOBILE', 'BIOMETRIC', 'KIOSK', 'SYSTEM'))
    );

    -- The close job's read: every punch of one day, in order.
    CREATE INDEX IX_tblAttendancePunch_Day_PunchAt
        ON dbo.tblAttendancePunch (AttendanceDayId, PunchAt);
END;
GO

/* -------------------------------------------------------------------------
   4 - present-by-default exemptions.

   Section 19. The requirement names the US team, but the grant is per
   employee and date-ranged rather than per location: "the US office" is a
   fact about where somebody sits, and "we do not ask this person to punch"
   is a decision somebody made and should have to justify. Reason is NOT NULL
   for that reason.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblAttendanceExemption', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblAttendanceExemption (
        AttendanceExemptionId BIGINT        IDENTITY(1,1) NOT NULL,

        EmployeeDetailId      BIGINT        NOT NULL,

        EffectiveFrom         DATE          NOT NULL,
        -- NULL means open-ended, which is the normal case for an employee
        -- whose role simply does not involve punching.
        EffectiveTo           DATE          NULL,

        Reason                NVARCHAR(500) NOT NULL,

        -- Who granted it. Not the same as CreatedBy in intent, and kept
        -- separate so an import can set CreatedBy without claiming somebody
        -- authorised it.
        GrantedBy             BIGINT        NULL,

        CreatedBy             BIGINT        NULL,
        ModifiedBy            BIGINT        NULL,
        CreatedAt             DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblAttendanceExemption_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt            DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblAttendanceExemption_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt             DATETIME2(3)  NULL,

        CONSTRAINT PK_tblAttendanceExemption PRIMARY KEY CLUSTERED (AttendanceExemptionId),

        CONSTRAINT FK_tblAttendanceExemption_Employee
            FOREIGN KEY (EmployeeDetailId)
            REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblAttendanceExemption_GrantedBy
            FOREIGN KEY (GrantedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblAttendanceExemption_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblAttendanceExemption_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblAttendanceExemption_EffectiveRange
            CHECK (EffectiveTo IS NULL OR EffectiveTo >= EffectiveFrom)
    );

    -- "Is this person exempt on this date" - asked by the auto-mark job for
    -- every employee, every night.
    CREATE INDEX IX_tblAttendanceExemption_Employee_Effective
        ON dbo.tblAttendanceExemption (EmployeeDetailId, EffectiveFrom, EffectiveTo)
        WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   5 - alert settings.

   Section 16: "every 10 minutes for 2 hours, starting 9 minutes after the
   shift begins, configurable by Admin and HR Admin".

   All four numbers are columns because all four were given as configurable.
   Per location, because the two offices start at different times and an
   alert cadence that suits one is noise in the other. NULL location is the
   organisation-wide default, matching tblShift.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblAttendanceAlertSetting', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblAttendanceAlertSetting (
        AttendanceAlertSettingId BIGINT        IDENTITY(1,1) NOT NULL,

        -- NULL = the organisation default.
        LocationId               BIGINT        NULL,

        -- MISSED_CHECK_IN / MISSED_CHECK_OUT.
        AlertType                NVARCHAR(30)  NOT NULL,

        -- Minutes after the shift boundary before the first alert fires.
        DelayMinutes             INT           NOT NULL
            CONSTRAINT DF_tblAttendanceAlertSetting_DelayMinutes DEFAULT 9,
        -- How often it repeats.
        IntervalMinutes          INT           NOT NULL
            CONSTRAINT DF_tblAttendanceAlertSetting_IntervalMinutes DEFAULT 10,
        -- For how long in total. 120 = two hours.
        WindowMinutes            INT           NOT NULL
            CONSTRAINT DF_tblAttendanceAlertSetting_WindowMinutes DEFAULT 120,

        /*
          The sweep runs on a timer; this is the clock time it begins looking
          on any given day. Stored so the job has nothing hard-coded in it,
          and so a location in another timezone can be swept at its own
          morning rather than ours.
        */
        SweepTime                TIME(0)       NULL,

        -- Section 16 again: somebody on approved leave is not missing, and
        -- must not be alerted. A flag rather than an assumption.
        SkipWhenOnLeave          BIT           NOT NULL
            CONSTRAINT DF_tblAttendanceAlertSetting_SkipWhenOnLeave DEFAULT 1,
        SkipOnHoliday            BIT           NOT NULL
            CONSTRAINT DF_tblAttendanceAlertSetting_SkipOnHoliday DEFAULT 1,
        -- An employee who never punches must never be chased for not punching.
        SkipWhenExempt           BIT           NOT NULL
            CONSTRAINT DF_tblAttendanceAlertSetting_SkipWhenExempt DEFAULT 1,

        -- Also copy the reporting manager after this many alerts. NULL = never.
        NotifyManagerAfter       INT           NULL,

        IsActive                 BIT           NOT NULL
            CONSTRAINT DF_tblAttendanceAlertSetting_IsActive DEFAULT 1,

        CreatedBy                BIGINT        NULL,
        ModifiedBy               BIGINT        NULL,
        CreatedAt                DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblAttendanceAlertSetting_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt               DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblAttendanceAlertSetting_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt                DATETIME2(3)  NULL,

        CONSTRAINT PK_tblAttendanceAlertSetting
            PRIMARY KEY CLUSTERED (AttendanceAlertSettingId),

        CONSTRAINT FK_tblAttendanceAlertSetting_Location
            FOREIGN KEY (LocationId)
            REFERENCES dbo.tblOrganizationLocation (LocationId),
        CONSTRAINT FK_tblAttendanceAlertSetting_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblAttendanceAlertSetting_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblAttendanceAlertSetting_AlertType
            CHECK (AlertType IN ('MISSED_CHECK_IN', 'MISSED_CHECK_OUT')),
        CONSTRAINT CK_tblAttendanceAlertSetting_Minutes
            CHECK (DelayMinutes >= 0 AND IntervalMinutes > 0 AND WindowMinutes > 0)
    );

    -- One rule per location per alert type. NULLs compare equal in a unique
    -- index, so the organisation-wide default can also only exist once.
    CREATE UNIQUE INDEX UQ_tblAttendanceAlertSetting_Location_Type
        ON dbo.tblAttendanceAlertSetting (LocationId, AlertType)
        WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   6 - regularization type.

   THIS ONE IS ORDINARY MASTER DATA - Name / Description / IsActive - and it
   joins the existing registry in src/enums/master-data.enum.js. Unlike the
   attendance statuses above, no code branches on which type a request
   carries: it is a label on a form, and HR adding "system outage" to the
   list should not be a deploy.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblRegularizationType', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblRegularizationType (
        RegularizationTypeId BIGINT        IDENTITY(1,1) NOT NULL,

        Name                 NVARCHAR(150) NOT NULL,
        Description          NVARCHAR(500) NULL,

        IsActive             BIT           NOT NULL
            CONSTRAINT DF_tblRegularizationType_IsActive DEFAULT 1,

        CreatedBy            BIGINT        NULL,
        ModifiedBy           BIGINT        NULL,
        CreatedAt            DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblRegularizationType_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt           DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblRegularizationType_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt            DATETIME2(3)  NULL,

        CONSTRAINT PK_tblRegularizationType PRIMARY KEY CLUSTERED (RegularizationTypeId),
        CONSTRAINT FK_tblRegularizationType_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblRegularizationType_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblRegularizationType_Name
        ON dbo.tblRegularizationType (Name) WHERE DeletedAt IS NULL;

END;
GO

/* -------------------------------------------------------------------------
   7 - the regularization request.

   Section 17: raised within 24 hours (configurable), approved by the
   reporting manager, HR Admin or Admin.

   PreviousAttendanceStatusId is the column that makes an approval auditable.
   Without it, approving a correction overwrites the day's status and there
   is nothing left to say what it was - so "my absence was wrongly recorded"
   and "my absence was correctly recorded and then quietly changed" look
   identical afterwards.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblRegularizationRequest', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblRegularizationRequest (
        RegularizationRequestId    BIGINT        IDENTITY(1,1) NOT NULL,

        EmployeeDetailId           BIGINT        NOT NULL,
        AttendanceDate             DATE          NOT NULL,

        /*
          Nullable: a day with no punches at all may have no attendance row
          yet when the request is raised. The approval creates one.
        */
        AttendanceDayId            BIGINT        NULL,
        RegularizationTypeId       BIGINT        NOT NULL,

        -- What the employee says the times should have been. Either may be
        -- NULL - a missing check-out is a correction to one end only.
        RequestedCheckInAt         DATETIME2(3)  NULL,
        RequestedCheckOutAt        DATETIME2(3)  NULL,

        Reason                     NVARCHAR(1000) NOT NULL,

        Status                     NVARCHAR(20)  NOT NULL
            CONSTRAINT DF_tblRegularizationRequest_Status DEFAULT 'PENDING',

        /*
          Captured when the request is raised, from the alert setting's
          window. Stored on the row rather than computed on read, so a later
          change to the configured window cannot retrospectively expire - or
          un-expire - a request somebody already submitted.
        */
        SubmissionDeadline         DATETIME2(3)  NULL,

        -- The audit pair. Set on approval, never cleared.
        PreviousAttendanceStatusId INT           NULL,
        NewAttendanceStatusId      INT           NULL,

        ApprovedBy                 BIGINT        NULL,
        ApprovedAt                 DATETIME2(3)  NULL,
        ApproverRemarks            NVARCHAR(1000) NULL,

        CreatedBy                  BIGINT        NULL,
        ModifiedBy                 BIGINT        NULL,
        CreatedAt                  DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblRegularizationRequest_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt                 DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblRegularizationRequest_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt                  DATETIME2(3)  NULL,

        CONSTRAINT PK_tblRegularizationRequest PRIMARY KEY CLUSTERED (RegularizationRequestId),

        CONSTRAINT FK_tblRegularizationRequest_Employee
            FOREIGN KEY (EmployeeDetailId)
            REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblRegularizationRequest_Day
            FOREIGN KEY (AttendanceDayId)
            REFERENCES dbo.tblAttendanceDay (AttendanceDayId),
        CONSTRAINT FK_tblRegularizationRequest_Type
            FOREIGN KEY (RegularizationTypeId)
            REFERENCES dbo.tblRegularizationType (RegularizationTypeId),
        CONSTRAINT FK_tblRegularizationRequest_PreviousStatus
            FOREIGN KEY (PreviousAttendanceStatusId)
            REFERENCES dbo.tblAttendanceStatus (AttendanceStatusId),
        CONSTRAINT FK_tblRegularizationRequest_NewStatus
            FOREIGN KEY (NewAttendanceStatusId)
            REFERENCES dbo.tblAttendanceStatus (AttendanceStatusId),
        CONSTRAINT FK_tblRegularizationRequest_ApprovedBy
            FOREIGN KEY (ApprovedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblRegularizationRequest_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblRegularizationRequest_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblRegularizationRequest_Status
            CHECK (Status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED')),
        /*
          A correction that corrects nothing is a request nobody can action.
          Cheaper to refuse here than to leave an approver guessing what they
          are being asked to agree to.
        */
        CONSTRAINT CK_tblRegularizationRequest_HasTime
            CHECK (RequestedCheckInAt IS NOT NULL OR RequestedCheckOutAt IS NOT NULL)
    );

    /*
      A day cannot be under correction twice at once.

      Filtered to PENDING and APPROVED, which is the point: a REJECTED
      request must not block a corrected resubmission, and that is exactly
      the case a plain unique index would get wrong.
    */
    CREATE UNIQUE INDEX UQ_tblRegularizationRequest_Employee_Date_Open
        ON dbo.tblRegularizationRequest (EmployeeDetailId, AttendanceDate)
        WHERE DeletedAt IS NULL AND Status IN ('PENDING', 'APPROVED');

    -- The approver's queue, oldest first - the order they should be worked.
    CREATE INDEX IX_tblRegularizationRequest_Status_Created
        ON dbo.tblRegularizationRequest (Status, CreatedAt)
        INCLUDE (EmployeeDetailId, AttendanceDate)
        WHERE DeletedAt IS NULL;

    -- "My regularizations", newest first.
    CREATE INDEX IX_tblRegularizationRequest_Employee
        ON dbo.tblRegularizationRequest (EmployeeDetailId, AttendanceDate DESC)
        WHERE DeletedAt IS NULL;
END;
GO

/*
  REFERENCE DATA IS SEEDED BY 022, NOT HERE.

  The nine attendance statuses and the four regularization reasons belong
  with this migration and were originally written into it - but this file
  had already been applied by a running dev server before they were added,
  and a migration is recorded by filename, so editing it would have left one
  database holding the rows and another not. They live in
  022_attendance_reference_data.sql, which is idempotent and so is correct
  for a fresh database and for the one that already ran this file.
*/

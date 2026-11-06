/*
  Holidays, by location - and the floating / restricted holiday an employee
  picks once a year.

  docs/ATTENDANCE-LEAVE.html sections 07 and 20. Five tables.

  WHY A HOLIDAY AND ITS LOCATIONS ARE TWO TABLES. New Year's Day is one
  holiday observed in both offices; Thanksgiving is observed in one. Storing
  LocationId on the holiday itself would mean two New Year rows that must be
  renamed together, re-dated together, and that drift apart the first time
  somebody edits one - and then the calendar quietly disagrees with itself
  across two offices.

  NORMAL vs RESTRICTED, and what "restricted" actually means here. A normal
  holiday is a day the office is closed: nobody applies for it, attendance is
  marked HOLIDAY, and it costs no leave. A restricted holiday is a day on a
  curated list from which each employee may choose ONE per calendar year -
  Holi for one person, Good Friday for another. It is an opt-in, not a
  closure, and that is why it has a request table of its own.

  THE ONE-PER-YEAR RULE IS ENFORCED BY AN INDEX, not only by the service.
  UQ_tblRestrictedHolidayOptIn_Employee_Cycle is what makes a double-submit,
  a retried request or a second browser tab fail at the database rather than
  quietly grant somebody two floating holidays.

  CALENDAR YEAR, NOT FINANCIAL YEAR. The floating holiday runs 1 January to
  31 December while CL/SL and EL run April to March - which is why
  LeaveCycleId points at tblLeaveCycle and the cycle carries a type. The FK
  is added at the bottom of 018, because that table does not exist yet.

  Note for hand-written queries: these tables carry filtered indexes, so SQL
  Server refuses INSERT/UPDATE/DELETE unless QUOTED_IDENTIFIER is ON. The
  driver and SSMS set it ON already; sqlcmd does not, so run sqlcmd with -I.
*/

/* -------------------------------------------------------------------------
   1 - the two holiday types.

   Fixed ids owned by the code, like dbo.tblAttendanceStatus in 016 and for
   the same reason: the attendance close branches on RESTRICTED, so this is
   not an editable lookup however much its three columns look like one.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblHolidayType', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblHolidayType (
        HolidayTypeId INT           NOT NULL,

        TypeCode      NVARCHAR(20)  NOT NULL,
        TypeName      NVARCHAR(50)  NOT NULL,
        Description   NVARCHAR(255) NULL,

        /*
          A normal holiday applies to everybody at the location; a restricted
          one applies only to the person who picked it. One flag, and every
          read path that would otherwise have to hard-code "WHERE
          HolidayTypeId = 2" asks this instead.
        */
        RequiresOptIn BIT           NOT NULL
            CONSTRAINT DF_tblHolidayType_RequiresOptIn DEFAULT 0,

        IsActive      BIT           NOT NULL
            CONSTRAINT DF_tblHolidayType_IsActive DEFAULT 1,

        CreatedAt     DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblHolidayType_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt    DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblHolidayType_ModifiedAt DEFAULT SYSUTCDATETIME(),

        CONSTRAINT PK_tblHolidayType PRIMARY KEY CLUSTERED (HolidayTypeId),
        CONSTRAINT UQ_tblHolidayType_TypeCode UNIQUE (TypeCode)
    );
END;
GO

/* -------------------------------------------------------------------------
   2 - the holiday.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblHoliday', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblHoliday (
        HolidayId     BIGINT        IDENTITY(1,1) NOT NULL,

        HolidayName   NVARCHAR(150) NOT NULL,
        HolidayDate   DATE          NOT NULL,
        HolidayTypeId INT           NOT NULL,

        /*
          Redundant with YEAR(HolidayDate), and kept anyway. HR uploads a
          fresh restricted list each year and the screen is organised by
          year, so this is the column every list query filters on - and a
          filter on YEAR(HolidayDate) is not sargable, which turns the
          calendar screen into a table scan.
        */
        HolidayYear   SMALLINT      NOT NULL,

        Description   NVARCHAR(500) NULL,

        /*
          Switched off rather than removed when a declared holiday is
          cancelled - attendance rows from before the cancellation point at
          it, and they must still resolve to a name.
        */
        IsActive      BIT           NOT NULL
            CONSTRAINT DF_tblHoliday_IsActive DEFAULT 1,

        CreatedBy     BIGINT        NULL,
        ModifiedBy    BIGINT        NULL,
        CreatedAt     DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblHoliday_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt    DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblHoliday_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt     DATETIME2(3)  NULL,

        CONSTRAINT PK_tblHoliday PRIMARY KEY CLUSTERED (HolidayId),

        CONSTRAINT FK_tblHoliday_Type
            FOREIGN KEY (HolidayTypeId) REFERENCES dbo.tblHolidayType (HolidayTypeId),
        CONSTRAINT FK_tblHoliday_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblHoliday_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        -- The year column and the date must agree, or the calendar screen
        -- silently loses a row.
        CONSTRAINT CK_tblHoliday_YearMatchesDate
            CHECK (HolidayYear = YEAR(HolidayDate))
    );

    /*
      The same holiday cannot be declared twice on the same date.

      Deliberately NOT unique on the date alone: two different observances
      can legitimately fall on one day in a company with offices in two
      countries, and the location mapping is what separates them.
    */
    CREATE UNIQUE INDEX UQ_tblHoliday_Name_Date
        ON dbo.tblHoliday (HolidayName, HolidayDate) WHERE DeletedAt IS NULL;

    -- The calendar screen, and the close job's "is today a holiday" lookup.
    CREATE INDEX IX_tblHoliday_Year_Date
        ON dbo.tblHoliday (HolidayYear, HolidayDate)
        INCLUDE (HolidayTypeId, HolidayName)
        WHERE DeletedAt IS NULL AND IsActive = 1;
END;
GO

/* -------------------------------------------------------------------------
   3 - which locations observe it.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblHolidayLocation', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblHolidayLocation (
        HolidayLocationId BIGINT       IDENTITY(1,1) NOT NULL,

        HolidayId         BIGINT       NOT NULL,
        LocationId        BIGINT       NOT NULL,

        CreatedBy         BIGINT       NULL,
        ModifiedBy        BIGINT       NULL,
        CreatedAt         DATETIME2(3) NOT NULL
            CONSTRAINT DF_tblHolidayLocation_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt        DATETIME2(3) NOT NULL
            CONSTRAINT DF_tblHolidayLocation_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt         DATETIME2(3) NULL,

        CONSTRAINT PK_tblHolidayLocation PRIMARY KEY CLUSTERED (HolidayLocationId),

        CONSTRAINT FK_tblHolidayLocation_Holiday
            FOREIGN KEY (HolidayId)  REFERENCES dbo.tblHoliday (HolidayId),
        CONSTRAINT FK_tblHolidayLocation_Location
            FOREIGN KEY (LocationId) REFERENCES dbo.tblOrganizationLocation (LocationId),
        CONSTRAINT FK_tblHolidayLocation_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblHolidayLocation_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblHolidayLocation_Holiday_Location
        ON dbo.tblHolidayLocation (HolidayId, LocationId) WHERE DeletedAt IS NULL;

    -- "The holiday list for this office" - what every employee sees, and
    -- what the nightly close reads per employee's work location.
    CREATE INDEX IX_tblHolidayLocation_Location
        ON dbo.tblHolidayLocation (LocationId, HolidayId) WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   4 - restricted-holiday mapping: who gets the list, and how many picks.

   "Restricted Mapping" in the requirement list means mapping the restricted
   holidays TO EMPLOYEES - which cohort may choose from the list, and how
   many choices they get. It is not a blackout or concurrency rule.

   PickQuota is 1 per the HR document. It is a column rather than a constant
   because "two floating holidays next year" is a policy announcement, and a
   policy announcement should not be a release.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblRestrictedHolidayMapping', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblRestrictedHolidayMapping (
        RestrictedHolidayMappingId BIGINT       IDENTITY(1,1) NOT NULL,

        -- Both NULL = every employee, everywhere. The usual case.
        LocationId                 BIGINT       NULL,
        EmploymentType             NVARCHAR(30) NULL,

        /*
          Plain column here; the FOREIGN KEY to dbo.tblLeaveCycle is added at
          the bottom of 018. Always a CALENDAR cycle - the floating holiday
          year is January to December, which is the whole reason cycles
          carry a type.
        */
        LeaveCycleId               BIGINT       NOT NULL,

        PickQuota                  TINYINT      NOT NULL
            CONSTRAINT DF_tblRestrictedHolidayMapping_PickQuota DEFAULT 1,

        IsActive                   BIT          NOT NULL
            CONSTRAINT DF_tblRestrictedHolidayMapping_IsActive DEFAULT 1,

        CreatedBy                  BIGINT       NULL,
        ModifiedBy                 BIGINT       NULL,
        CreatedAt                  DATETIME2(3) NOT NULL
            CONSTRAINT DF_tblRestrictedHolidayMapping_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt                 DATETIME2(3) NOT NULL
            CONSTRAINT DF_tblRestrictedHolidayMapping_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt                  DATETIME2(3) NULL,

        CONSTRAINT PK_tblRestrictedHolidayMapping
            PRIMARY KEY CLUSTERED (RestrictedHolidayMappingId),

        CONSTRAINT FK_tblRestrictedHolidayMapping_Location
            FOREIGN KEY (LocationId)
            REFERENCES dbo.tblOrganizationLocation (LocationId),
        CONSTRAINT FK_tblRestrictedHolidayMapping_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblRestrictedHolidayMapping_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblRestrictedHolidayMapping_PickQuota
            CHECK (PickQuota >= 1)
    );

    -- One rule per cohort per cycle. NULLs compare equal, so the
    -- everybody-everywhere row can also exist only once.
    CREATE UNIQUE INDEX UQ_tblRestrictedHolidayMapping_Cohort
        ON dbo.tblRestrictedHolidayMapping (LeaveCycleId, LocationId, EmploymentType)
        WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   5 - the employee's pick.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblRestrictedHolidayOptIn', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblRestrictedHolidayOptIn (
        RestrictedHolidayOptInId BIGINT        IDENTITY(1,1) NOT NULL,

        EmployeeDetailId         BIGINT        NOT NULL,
        HolidayId                BIGINT        NOT NULL,

        -- Plain column; FK added at the bottom of 018 with the one above.
        LeaveCycleId             BIGINT        NOT NULL,

        Status                   NVARCHAR(20)  NOT NULL
            CONSTRAINT DF_tblRestrictedHolidayOptIn_Status DEFAULT 'PENDING',

        Reason                   NVARCHAR(500) NULL,

        ApprovedBy               BIGINT        NULL,
        ApprovedAt               DATETIME2(3)  NULL,
        ApproverRemarks          NVARCHAR(500) NULL,

        CreatedBy                BIGINT        NULL,
        ModifiedBy               BIGINT        NULL,
        CreatedAt                DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblRestrictedHolidayOptIn_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt               DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblRestrictedHolidayOptIn_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt                DATETIME2(3)  NULL,

        CONSTRAINT PK_tblRestrictedHolidayOptIn
            PRIMARY KEY CLUSTERED (RestrictedHolidayOptInId),

        CONSTRAINT FK_tblRestrictedHolidayOptIn_Employee
            FOREIGN KEY (EmployeeDetailId)
            REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblRestrictedHolidayOptIn_Holiday
            FOREIGN KEY (HolidayId) REFERENCES dbo.tblHoliday (HolidayId),
        CONSTRAINT FK_tblRestrictedHolidayOptIn_ApprovedBy
            FOREIGN KEY (ApprovedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblRestrictedHolidayOptIn_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblRestrictedHolidayOptIn_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblRestrictedHolidayOptIn_Status
            CHECK (Status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'))
    );

    /*
      ONE PICK PER EMPLOYEE PER CYCLE - the rule from section 07, enforced
      where it cannot be raced past.

      Filtered to PENDING and APPROVED so that a rejected or cancelled pick
      frees the slot and the employee can choose again. A plain unique index
      would lock them out of the year over a request somebody turned down,
      which is the opposite of what the policy says.

      PickQuota above allows more than one some day. When it does, this index
      becomes the quota's floor rather than its ceiling and the service
      counts - the index still correctly refuses a second pick while the
      quota is 1, which is today's rule.
    */
    CREATE UNIQUE INDEX UQ_tblRestrictedHolidayOptIn_Employee_Cycle
        ON dbo.tblRestrictedHolidayOptIn (EmployeeDetailId, LeaveCycleId)
        WHERE DeletedAt IS NULL AND Status IN ('PENDING', 'APPROVED');

    -- "Who picked this holiday" - the approver's queue, and the headcount
    -- HR checks before the day arrives.
    CREATE INDEX IX_tblRestrictedHolidayOptIn_Holiday
        ON dbo.tblRestrictedHolidayOptIn (HolidayId, Status) WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   6 - settle the debt 016 left behind.

   tblAttendanceDay.HolidayId was created as a plain column because this
   table did not exist yet. Its own batch, because a constraint cannot
   reference a table created in the same one.
   ------------------------------------------------------------------------- */

IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_tblAttendanceDay_Holiday'
)
BEGIN
    ALTER TABLE dbo.tblAttendanceDay
        ADD CONSTRAINT FK_tblAttendanceDay_Holiday
            FOREIGN KEY (HolidayId) REFERENCES dbo.tblHoliday (HolidayId);
END;
GO

/* -------------------------------------------------------------------------
   7 - seed the two holiday types.

   Here rather than in the access seeder: they are two rows that the schema
   itself is incomplete without - tblHoliday.HolidayTypeId is NOT NULL and
   has nothing to point at until they exist. MERGE so re-running is safe.
   ------------------------------------------------------------------------- */

MERGE dbo.tblHolidayType WITH (HOLDLOCK) AS target
USING (VALUES
        (1, N'NORMAL',     N'Normal Holiday',     0,
         N'A day the office is closed. Applies to everyone at the location.'),
        (2, N'RESTRICTED', N'Restricted Holiday', 1,
         N'A day from a curated list. Each employee may choose their own, within the quota.')
      ) AS source (HolidayTypeId, TypeCode, TypeName, RequiresOptIn, Description)
   ON target.HolidayTypeId = source.HolidayTypeId
 WHEN MATCHED THEN UPDATE SET
      TypeCode      = source.TypeCode,
      TypeName      = source.TypeName,
      RequiresOptIn = source.RequiresOptIn,
      Description   = source.Description,
      IsActive      = 1,
      ModifiedAt    = SYSUTCDATETIME()
 WHEN NOT MATCHED THEN
      INSERT (HolidayTypeId, TypeCode, TypeName, RequiresOptIn, Description)
      VALUES (source.HolidayTypeId, source.TypeCode, source.TypeName,
              source.RequiresOptIn, source.Description);
GO

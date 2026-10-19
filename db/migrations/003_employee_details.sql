/*
  Employee profile - the HR record for a person.

  This is the "future employee profile table" that 001_employee_login.sql keeps
  itself separate from: credentials live in dbo.EmployeeLogin, everything a
  human would recognise as an employee record lives here, and EmployeeId joins
  the two. A person can exist here with no login (not every employee signs in),
  which is why that column is nullable - but when it is set it must be unique,
  so one login never maps to two profiles.

  Soft delete: DeletedAt is the only way a row leaves. Nothing is ever DELETEd,
  because payroll, leave and audit history all point at these ids. Every read
  path must filter WHERE DeletedAt IS NULL - the unique indexes below are
  filtered the same way, so a deleted employee's code and work email are freed
  for reuse while the row is kept.

  DepartmentId, DesignationId and WorkLocationId are plain columns for now:
  the departments, designations and work_locations tables do not exist yet, so
  there is nothing to point a FOREIGN KEY at. The constraints get added in the
  migration that creates those tables. ManagerId is a real FK already, because
  it points back at this table.

  Times are UTC (SYSUTCDATETIME()), as everywhere else in this schema.

  Note for hand-written queries: this table carries filtered indexes, so SQL
  Server refuses INSERT/UPDATE/DELETE on it unless QUOTED_IDENTIFIER is ON.
  The driver and SSMS set it ON already; sqlcmd does not, so run sqlcmd with -I.
*/

IF OBJECT_ID('dbo.tblEmployeeDetails', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblEmployeeDetails (
        EmployeeDetailId    BIGINT          IDENTITY(1,1) NOT NULL,

        -- The login this profile belongs to. NULL for an employee with no
        -- account; unique when set, so the join is always one-to-one.
        EmployeeId          INT             NULL,

        -- Human-facing identifier, e.g. EMP001. Unique among live rows.
        EmployeeCode        NVARCHAR(50)    NOT NULL,

        FirstName           NVARCHAR(100)   NOT NULL,
        MiddleName          NVARCHAR(100)   NULL,
        LastName            NVARCHAR(100)   NOT NULL,

        -- Official address. Unique among live rows; it is how HR and most
        -- integrations identify a person.
        WorkEmail           NVARCHAR(255)   NOT NULL,
        PersonalEmail       NVARCHAR(255)   NULL,
        Phone               NVARCHAR(20)    NULL,

        DateOfBirth         DATE            NULL,
        -- Free text rather than a CHECK: the list of accepted answers changes,
        -- and a schema change is the wrong cost for that. Values come from
        -- GENDER in src/enums/employee.enum.js.
        Gender              NVARCHAR(30)    NULL,
        -- TEXT is deprecated in SQL Server; NVARCHAR(MAX) is its replacement.
        Address             NVARCHAR(MAX)   NULL,

        -- FKs in waiting - see the header note.
        DepartmentId        BIGINT          NULL,
        DesignationId       BIGINT          NULL,
        WorkLocationId      BIGINT          NULL,
        -- The location as written, so a profile reads correctly before the
        -- work_locations table exists and for anyone who has no id yet.
        WorkLocation        NVARCHAR(150)   NULL,

        -- Self-reference: this employee's manager.
        ManagerId           BIGINT          NULL,

        -- Values come from EMPLOYMENT_TYPE / EMPLOYMENT_STATUS in
        -- src/enums/employee.enum.js. Constrained below.
        EmploymentType      NVARCHAR(30)    NOT NULL,
        EmploymentStatus    NVARCHAR(30)    NOT NULL
            CONSTRAINT DF_tblEmployeeDetails_EmploymentStatus DEFAULT 'Active',

        DateOfJoining       DATE            NOT NULL,
        ProbationEndDate    DATE            NULL,
        DateOfLeaving       DATE            NULL,

        ProfilePhotoUrl     NVARCHAR(2048)  NULL,

        -- Distinct from EmploymentStatus: that is where the person stands with
        -- the company, this is whether the record is in play at all. An exited
        -- employee stays IsActive = 0 without being deleted.
        IsActive            BIT             NOT NULL
            CONSTRAINT DF_tblEmployeeDetails_IsActive DEFAULT 1,

        -- Who touched the row. EmployeeLogin ids, nullable because a seed or a
        -- migration has no human behind it.
        CreatedBy           INT             NULL,
        ModifiedBy          INT             NULL,

        CreatedAt           DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmployeeDetails_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt          DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmployeeDetails_ModifiedAt DEFAULT SYSUTCDATETIME(),
        -- Soft delete. NULL means live.
        DeletedAt           DATETIME2(3)    NULL,

        CONSTRAINT PK_tblEmployeeDetails PRIMARY KEY CLUSTERED (EmployeeDetailId),

        CONSTRAINT FK_tblEmployeeDetails_Login
            FOREIGN KEY (EmployeeId)  REFERENCES dbo.EmployeeLogin (EmployeeId),
        CONSTRAINT FK_tblEmployeeDetails_Manager
            FOREIGN KEY (ManagerId)   REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeDetails_CreatedBy
            FOREIGN KEY (CreatedBy)   REFERENCES dbo.EmployeeLogin (EmployeeId),
        CONSTRAINT FK_tblEmployeeDetails_ModifiedBy
            FOREIGN KEY (ModifiedBy)  REFERENCES dbo.EmployeeLogin (EmployeeId),

        -- Cheap guards against a typo reaching the table. The accepted values
        -- are the enum in src/enums/employee.enum.js; widening the list means
        -- a migration, which is the point.
        CONSTRAINT CK_tblEmployeeDetails_EmploymentType CHECK (
            EmploymentType IN ('FullTime', 'PartTime', 'Contract', 'Intern', 'Consultant')
        ),
        CONSTRAINT CK_tblEmployeeDetails_EmploymentStatus CHECK (
            EmploymentStatus IN ('Active', 'OnLeave', 'NoticePeriod', 'Exited', 'Suspended')
        ),
        -- A leaving date before the joining date is always a data-entry error.
        CONSTRAINT CK_tblEmployeeDetails_LeavingAfterJoining CHECK (
            DateOfLeaving IS NULL OR DateOfLeaving >= DateOfJoining
        )
    );

    /*
      Filtered uniqueness: only live rows compete. Soft-deleting an employee
      releases their code and work email instead of blocking the next hire.
    */
    CREATE UNIQUE INDEX UQ_tblEmployeeDetails_EmployeeCode
        ON dbo.tblEmployeeDetails (EmployeeCode) WHERE DeletedAt IS NULL;

    CREATE UNIQUE INDEX UQ_tblEmployeeDetails_WorkEmail
        ON dbo.tblEmployeeDetails (WorkEmail)    WHERE DeletedAt IS NULL;

    -- One profile per login, enforced only where a login is actually set.
    CREATE UNIQUE INDEX UQ_tblEmployeeDetails_EmployeeId
        ON dbo.tblEmployeeDetails (EmployeeId)   WHERE EmployeeId IS NOT NULL;

    -- "Who reports to X" and "who is in department Y" are the two list screens
    -- this table exists to serve.
    CREATE INDEX IX_tblEmployeeDetails_ManagerId
        ON dbo.tblEmployeeDetails (ManagerId)    WHERE DeletedAt IS NULL;

    CREATE INDEX IX_tblEmployeeDetails_DepartmentId
        ON dbo.tblEmployeeDetails (DepartmentId) WHERE DeletedAt IS NULL;
END;

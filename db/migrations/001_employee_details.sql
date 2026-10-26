/*
  The employee. THE table this schema is built around.

  Everything that is about a person hangs off EmployeeDetailId: their manager,
  their roles, their permissions, who created which row. Credentials are a
  satellite - dbo.EmployeeLogin in 002 carries a NOT NULL EmployeeDetailId
  pointing back here, so a login cannot exist without a person, while a person
  can exist with no way to sign in. Plenty of employees never log in.

  WHY THIS DIRECTION, since the first cut had it the other way round. A
  nullable EmployeeId on this table modelled the same cardinality, but it put
  the optional half on the main entity and left "a login with no profile"
  representable - which the resolver and the scope helper then had to carry
  branches for. Moving the key onto the login makes that case unrepresentable
  rather than handled, and removes the translation between two id spaces that
  every row-scoped query previously had to get right.

  This table is created FIRST for that reason: a FOREIGN KEY cannot reference a
  table that does not exist yet, so the file order is the dependency order.

  CreatedBy and ModifiedBy are self-references - an employee record is created
  by an employee. Both are nullable, because a seed or a migration has no human
  behind it, and because the very first row has nobody to point at.

  Soft delete: DeletedAt is the only way a row leaves. Nothing is ever DELETEd,
  because payroll, leave and audit history all point at these ids. Every read
  path must filter WHERE DeletedAt IS NULL - the unique indexes below are
  filtered the same way, so a deleted employee's code and work email are freed
  for reuse while the row is kept.

  DepartmentId and DesignationId are plain columns for now: those tables do not
  exist yet, so there is nothing to point a FOREIGN KEY at. WorkLocationId gets
  its constraint in 005, which creates the locations table. ManagerId is a real
  FK already, because it points back at this table.

  Times are UTC (SYSUTCDATETIME()), as everywhere else in this schema.

  Note for hand-written queries: this table carries filtered indexes, so SQL
  Server refuses INSERT/UPDATE/DELETE on it unless QUOTED_IDENTIFIER is ON.
  The driver and SSMS set it ON already; sqlcmd does not, so run sqlcmd with -I.
*/

IF OBJECT_ID('dbo.tblEmployeeDetails', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblEmployeeDetails (
        EmployeeDetailId    BIGINT          IDENTITY(1,1) NOT NULL,

        -- Human-facing identifier, e.g. EMP001. Unique among live rows.
        EmployeeCode        NVARCHAR(50)    NOT NULL,

        FirstName           NVARCHAR(100)   NOT NULL,
        MiddleName          NVARCHAR(100)   NULL,
        LastName            NVARCHAR(100)   NOT NULL,

        -- Official address. Unique among live rows; it is how HR and most
        -- integrations identify a person. Note this is NOT the login address:
        -- dbo.EmployeeLogin.Email is what you sign in with, and the two are
        -- allowed to differ.
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
        -- The location as written, so a profile reads correctly for anyone who
        -- has no location id yet.
        WorkLocation        NVARCHAR(150)   NULL,

        -- Self-reference: this employee's manager. The TEAM scope compares
        -- against this directly now - same id space, no translation.
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

        -- Who touched the row: EmployeeDetailIds, self-referencing. Nullable
        -- because a seed or a migration has no human behind it.
        CreatedBy           BIGINT          NULL,
        ModifiedBy          BIGINT          NULL,

        CreatedAt           DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmployeeDetails_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt          DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmployeeDetails_ModifiedAt DEFAULT SYSUTCDATETIME(),
        -- Soft delete. NULL means live.
        DeletedAt           DATETIME2(3)    NULL,

        CONSTRAINT PK_tblEmployeeDetails PRIMARY KEY CLUSTERED (EmployeeDetailId),

        CONSTRAINT FK_tblEmployeeDetails_Manager
            FOREIGN KEY (ManagerId)   REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeDetails_CreatedBy
            FOREIGN KEY (CreatedBy)   REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeDetails_ModifiedBy
            FOREIGN KEY (ModifiedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

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
        ),
        -- Nobody manages themselves. One level of nonsense the self-FK cannot
        -- catch on its own, and it would make the TEAM scope return the
        -- manager twice.
        CONSTRAINT CK_tblEmployeeDetails_NotOwnManager CHECK (
            ManagerId IS NULL OR ManagerId <> EmployeeDetailId
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

    -- "Who reports to X" and "who is in department Y" are the two list screens
    -- this table exists to serve.
    CREATE INDEX IX_tblEmployeeDetails_ManagerId
        ON dbo.tblEmployeeDetails (ManagerId)    WHERE DeletedAt IS NULL;

    CREATE INDEX IX_tblEmployeeDetails_DepartmentId
        ON dbo.tblEmployeeDetails (DepartmentId) WHERE DeletedAt IS NULL;
END;

/*
  Master data: the five lookup lists every other screen picks from.

    tblParentDepartment  the top of the department tree - Technology,
                         Client Engagement and Operations in the export.
    tblDepartment        a department, optionally under a parent.
    tblDesignation       job titles.
    tblLeaveType         the leave calendar's categories.
    tblCategory          help-desk and announcement categories.

  WHY FIVE TABLES AND NOT ONE "tblLookup" with a TypeId: a generic key-value
  lookup table makes every foreign key impossible. A department has a real
  parent, employees point at a department and a designation, and leave
  balances will point at a leave type. None of that can be enforced against a
  table whose meaning depends on a discriminator column, and the first bug it
  produces is an employee whose "department" is a leave type.

  SHAPE. Every table carries the same seven columns - Name, Description,
  IsActive and the four audit columns - which is what lets one service and one
  controller serve all five (src/services/master-data.service.js). Only
  tblDepartment adds anything: ParentDepartmentId.

  NAME IS UNIQUE AMONG LIVE ROWS, filtered on DeletedAt like tblOrganization:
  soft-deleting "QA" frees the name for a new one. Nothing resurrects a
  deleted row by name.

  Soft delete, as everywhere else here. tblEmployeeDetails.DepartmentId and
  .DesignationId point at two of these tables, so a row never leaves - the
  delete endpoint stamps DeletedAt and refuses while anybody still points at
  it.

  THIS MIGRATION PAYS THE DEBT 001 AND 007 LEFT BEHIND. 001 says DepartmentId
  and DesignationId are "plain columns for now: those tables do not exist
  yet", and 007 says "when those tables arrive the text stays as the imported
  value and the id becomes the authority". This is that migration, so the two
  foreign keys go on at the bottom, each in its own batch.

  Times are UTC (SYSUTCDATETIME()), as everywhere else in this schema.

  Note for hand-written queries: these tables carry filtered indexes, so SQL
  Server refuses INSERT/UPDATE/DELETE unless QUOTED_IDENTIFIER is ON. The
  driver and SSMS set it ON already; sqlcmd does not, so run sqlcmd with -I.
*/

/* -------------------------------------------------------------------------
   Parent departments. First, because tblDepartment references it.
   ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.tblParentDepartment', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblParentDepartment (
        ParentDepartmentId  BIGINT          IDENTITY(1,1) NOT NULL,

        Name                NVARCHAR(150)   NOT NULL,
        Description         NVARCHAR(500)   NULL,

        IsActive            BIT             NOT NULL
            CONSTRAINT DF_tblParentDepartment_IsActive DEFAULT 1,

        CreatedBy           BIGINT          NULL,
        ModifiedBy          BIGINT          NULL,
        CreatedAt           DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblParentDepartment_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt          DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblParentDepartment_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt           DATETIME2(3)    NULL,

        CONSTRAINT PK_tblParentDepartment PRIMARY KEY CLUSTERED (ParentDepartmentId),
        CONSTRAINT FK_tblParentDepartment_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblParentDepartment_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblParentDepartment_Name
        ON dbo.tblParentDepartment (Name) WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   Departments.
   ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.tblDepartment', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblDepartment (
        DepartmentId        BIGINT          IDENTITY(1,1) NOT NULL,

        -- NULL is a department that sits at the top of the tree. "Innergy" in
        -- the export has no parent, and neither does a parent department that
        -- is also a department in its own right.
        ParentDepartmentId  BIGINT          NULL,

        Name                NVARCHAR(150)   NOT NULL,
        Description         NVARCHAR(500)   NULL,

        IsActive            BIT             NOT NULL
            CONSTRAINT DF_tblDepartment_IsActive DEFAULT 1,

        CreatedBy           BIGINT          NULL,
        ModifiedBy          BIGINT          NULL,
        CreatedAt           DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblDepartment_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt          DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblDepartment_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt           DATETIME2(3)    NULL,

        CONSTRAINT PK_tblDepartment PRIMARY KEY CLUSTERED (DepartmentId),
        CONSTRAINT FK_tblDepartment_ParentDepartment
            FOREIGN KEY (ParentDepartmentId)
            REFERENCES dbo.tblParentDepartment (ParentDepartmentId),
        CONSTRAINT FK_tblDepartment_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblDepartment_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblDepartment_Name
        ON dbo.tblDepartment (Name) WHERE DeletedAt IS NULL;

    -- "Which departments are under this parent" - the list screen's filter,
    -- and the guard that refuses to delete a parent still in use.
    CREATE INDEX IX_tblDepartment_ParentDepartmentId
        ON dbo.tblDepartment (ParentDepartmentId) WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   Designations.
   ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.tblDesignation', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblDesignation (
        DesignationId       BIGINT          IDENTITY(1,1) NOT NULL,

        Name                NVARCHAR(150)   NOT NULL,
        Description         NVARCHAR(500)   NULL,

        IsActive            BIT             NOT NULL
            CONSTRAINT DF_tblDesignation_IsActive DEFAULT 1,

        CreatedBy           BIGINT          NULL,
        ModifiedBy          BIGINT          NULL,
        CreatedAt           DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblDesignation_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt          DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblDesignation_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt           DATETIME2(3)    NULL,

        CONSTRAINT PK_tblDesignation PRIMARY KEY CLUSTERED (DesignationId),
        CONSTRAINT FK_tblDesignation_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblDesignation_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblDesignation_Name
        ON dbo.tblDesignation (Name) WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   Leave types.
   ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.tblLeaveType', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblLeaveType (
        LeaveTypeId         BIGINT          IDENTITY(1,1) NOT NULL,

        Name                NVARCHAR(150)   NOT NULL,
        Description         NVARCHAR(500)   NULL,

        -- The export's "Is Leave Type enabled" lands here: a type that is off
        -- stays on file for the history pointing at it, and simply stops
        -- being offered on the apply-for-leave screen.
        IsActive            BIT             NOT NULL
            CONSTRAINT DF_tblLeaveType_IsActive DEFAULT 1,

        CreatedBy           BIGINT          NULL,
        ModifiedBy          BIGINT          NULL,
        CreatedAt           DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblLeaveType_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt          DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblLeaveType_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt           DATETIME2(3)    NULL,

        CONSTRAINT PK_tblLeaveType PRIMARY KEY CLUSTERED (LeaveTypeId),
        CONSTRAINT FK_tblLeaveType_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblLeaveType_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblLeaveType_Name
        ON dbo.tblLeaveType (Name) WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   Categories.
   ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.tblCategory', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblCategory (
        CategoryId          BIGINT          IDENTITY(1,1) NOT NULL,

        Name                NVARCHAR(150)   NOT NULL,
        Description         NVARCHAR(500)   NULL,

        IsActive            BIT             NOT NULL
            CONSTRAINT DF_tblCategory_IsActive DEFAULT 1,

        CreatedBy           BIGINT          NULL,
        ModifiedBy          BIGINT          NULL,
        CreatedAt           DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblCategory_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt          DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblCategory_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt           DATETIME2(3)    NULL,

        CONSTRAINT PK_tblCategory PRIMARY KEY CLUSTERED (CategoryId),
        CONSTRAINT FK_tblCategory_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblCategory_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblCategory_Name
        ON dbo.tblCategory (Name) WHERE DeletedAt IS NULL;
END;
GO

/*
  The debt from 001 and 007, settled: DepartmentId and DesignationId become
  real foreign keys.

  The orphan check runs first rather than letting SQL Server fail with
  "conflicted with the FOREIGN KEY constraint", because the likely cause here
  is not corruption. Until now the two columns accepted any integer, and an
  import that wrote Zoho's own ids (1.92226e17) into them leaves rows pointing
  at departments that never existed in THIS database. Clearing them or mapping
  them is a data decision somebody has to make, and this says so instead of
  leaving a 547 to be deciphered.
*/
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_tblEmployeeDetails_Department')
BEGIN
    IF EXISTS (
        SELECT 1
          FROM dbo.tblEmployeeDetails AS e
         WHERE e.DepartmentId IS NOT NULL
           AND NOT EXISTS (SELECT 1
                             FROM dbo.tblDepartment AS d
                            WHERE d.DepartmentId = e.DepartmentId)
    )
        THROW 50009, 'tblEmployeeDetails.DepartmentId holds ids matching no row in tblDepartment. Clear or map them, then re-run the migration.', 1;

    ALTER TABLE dbo.tblEmployeeDetails
        ADD CONSTRAINT FK_tblEmployeeDetails_Department
            FOREIGN KEY (DepartmentId) REFERENCES dbo.tblDepartment (DepartmentId);
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_tblEmployeeDetails_Designation')
BEGIN
    IF EXISTS (
        SELECT 1
          FROM dbo.tblEmployeeDetails AS e
         WHERE e.DesignationId IS NOT NULL
           AND NOT EXISTS (SELECT 1
                             FROM dbo.tblDesignation AS d
                            WHERE d.DesignationId = e.DesignationId)
    )
        THROW 50009, 'tblEmployeeDetails.DesignationId holds ids matching no row in tblDesignation. Clear or map them, then re-run the migration.', 1;

    ALTER TABLE dbo.tblEmployeeDetails
        ADD CONSTRAINT FK_tblEmployeeDetails_Designation
            FOREIGN KEY (DesignationId) REFERENCES dbo.tblDesignation (DesignationId);
END;
GO

-- The guard that refuses to delete a designation somebody still holds. 001
-- already indexed DepartmentId for the same reason on that side.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_tblEmployeeDetails_DesignationId')
    CREATE INDEX IX_tblEmployeeDetails_DesignationId
        ON dbo.tblEmployeeDetails (DesignationId) WHERE DeletedAt IS NULL;

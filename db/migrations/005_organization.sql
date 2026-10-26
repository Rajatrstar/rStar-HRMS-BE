/*
  The organisation and the places it operates from.

  Two tables, one master-detail pair:

    tblOrganization          who this HRMS belongs to - the "Basic details"
                             screen. Name, logo, contact and primary address.
    tblOrganizationLocation  the master list of sites. Employees point at it
                             today; leave calendars, holidays and attendance
                             shifts are the obvious next users.

  WHY THE ADDRESS IS COLUMNS, not one NVARCHAR(MAX) blob like
  tblEmployeeDetails.Address: the location grid composes a one-line address out
  of the parts, and headcount gets grouped by city and country. Neither is
  possible once the parts are concatenated, and splitting a blob afterwards is
  a data migration with no clean answer.

  THIS MIGRATION PAYS A DEBT 003 LEFT BEHIND. The header of
  003_employee_details.sql says WorkLocationId is a plain column "for now...
  the constraints get added in the migration that creates those tables". This
  is that migration, so the FOREIGN KEY goes on at the bottom - in its own
  batch, because a constraint cannot reference a table created in the same one.

  Locations are soft-deleted like everything else here, because
  tblEmployeeDetails.WorkLocationId points at them. The delete endpoint refuses
  while anybody still works at one.

  No CHECK on OrganizationType: like Gender in 003 it is a suggestion list that
  changes with the sales deck, and a schema change is the wrong cost for that.
  The values live in ORGANIZATION_TYPE in src/enums/organization.enum.js.

  Times are UTC (SYSUTCDATETIME()), as everywhere else in this schema.

  Note for hand-written queries: these tables carry filtered indexes, so SQL
  Server refuses INSERT/UPDATE/DELETE unless QUOTED_IDENTIFIER is ON. The
  driver and SSMS set it ON already; sqlcmd does not, so run sqlcmd with -I.
*/

IF OBJECT_ID('dbo.tblOrganization', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblOrganization (
        OrganizationId      BIGINT          IDENTITY(1,1) NOT NULL,

        -- The trading name, as it appears on the settings screen.
        OrganizationName    NVARCHAR(200)   NOT NULL,
        -- A URL, not a file. Upload handling is a separate concern, and this
        -- column should not have to change when it arrives.
        LogoUrl             NVARCHAR(2048)  NULL,
        Website             NVARCHAR(2048)  NULL,
        -- Free text, no CHECK - see the header note.
        OrganizationType    NVARCHAR(100)   NULL,

        ContactPerson       NVARCHAR(150)   NULL,
        ContactNumber       NVARCHAR(20)    NULL,
        -- Required, like the asterisk on the form. This is the address a
        -- vendor or an auditor writes to.
        ContactEmail        NVARCHAR(255)   NOT NULL,

        -- Primary address: the registered office. Not a work location - those
        -- live in the table below, and an employee is assigned to one of them.
        AddressLine1        NVARCHAR(255)   NULL,
        AddressLine2        NVARCHAR(255)   NULL,
        City                NVARCHAR(100)   NULL,
        State               NVARCHAR(100)   NULL,
        Country             NVARCHAR(100)   NULL,
        PostalCode          NVARCHAR(20)    NULL,

        IsActive            BIT             NOT NULL
            CONSTRAINT DF_tblOrganization_IsActive DEFAULT 1,

        CreatedBy           INT             NULL,
        ModifiedBy          INT             NULL,
        CreatedAt           DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblOrganization_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt          DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblOrganization_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt           DATETIME2(3)    NULL,

        CONSTRAINT PK_tblOrganization PRIMARY KEY CLUSTERED (OrganizationId),
        CONSTRAINT FK_tblOrganization_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.EmployeeLogin (EmployeeId),
        CONSTRAINT FK_tblOrganization_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.EmployeeLogin (EmployeeId)
    );

    -- Filtered, like tblRole and unlike tblPermission: soft-deleting an
    -- organisation frees its name. Nothing resurrects one by code.
    CREATE UNIQUE INDEX UQ_tblOrganization_OrganizationName
        ON dbo.tblOrganization (OrganizationName) WHERE DeletedAt IS NULL;
END;

IF OBJECT_ID('dbo.tblOrganizationLocation', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblOrganizationLocation (
        LocationId          BIGINT          IDENTITY(1,1) NOT NULL,

        -- NOT NULL: a location with no organisation is not a thing this
        -- product has. The parent is never hard-deleted, so there is no
        -- cascade rule to decide on.
        OrganizationId      BIGINT          NOT NULL,

        -- "India", "US" on the locations grid.
        LocationName        NVARCHAR(150)   NOT NULL,
        -- Optional short code for imports and payroll files. Unique per
        -- organisation among live rows WHEN SET - see the index below.
        LocationCode        NVARCHAR(50)    NULL,

        Email               NVARCHAR(255)   NULL,

        AddressLine1        NVARCHAR(255)   NULL,
        AddressLine2        NVARCHAR(255)   NULL,
        City                NVARCHAR(100)   NULL,
        State               NVARCHAR(100)   NULL,
        Country             NVARCHAR(100)   NULL,
        PostalCode          NVARCHAR(20)    NULL,

        -- An IANA zone name - "Asia/Kolkata", "America/Chicago". Text rather
        -- than an offset, because an offset is wrong twice a year.
        TimeZone            NVARCHAR(100)   NULL,
        Description         NVARCHAR(500)   NULL,

        IsActive            BIT             NOT NULL
            CONSTRAINT DF_tblOrganizationLocation_IsActive DEFAULT 1,

        CreatedBy           INT             NULL,
        ModifiedBy          INT             NULL,
        CreatedAt           DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblOrganizationLocation_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt          DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblOrganizationLocation_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt           DATETIME2(3)    NULL,

        CONSTRAINT PK_tblOrganizationLocation PRIMARY KEY CLUSTERED (LocationId),
        CONSTRAINT FK_tblOrganizationLocation_Organization
            FOREIGN KEY (OrganizationId) REFERENCES dbo.tblOrganization (OrganizationId),
        CONSTRAINT FK_tblOrganizationLocation_CreatedBy
            FOREIGN KEY (CreatedBy)      REFERENCES dbo.EmployeeLogin (EmployeeId),
        CONSTRAINT FK_tblOrganizationLocation_ModifiedBy
            FOREIGN KEY (ModifiedBy)     REFERENCES dbo.EmployeeLogin (EmployeeId)
    );

    -- Two organisations may both have a "Head Office"; one may not have two.
    CREATE UNIQUE INDEX UQ_tblOrganizationLocation_Name
        ON dbo.tblOrganizationLocation (OrganizationId, LocationName)
        WHERE DeletedAt IS NULL;

    -- The code is optional, so this filter carries IS NOT NULL as well:
    -- without it the second code-less location would collide with the first.
    CREATE UNIQUE INDEX UQ_tblOrganizationLocation_Code
        ON dbo.tblOrganizationLocation (OrganizationId, LocationCode)
        WHERE DeletedAt IS NULL AND LocationCode IS NOT NULL;

    -- The list screen's whole query: every live location of one organisation.
    CREATE INDEX IX_tblOrganizationLocation_Organization
        ON dbo.tblOrganizationLocation (OrganizationId) WHERE DeletedAt IS NULL;
END;
GO

/*
  The debt from 003, settled. Its own batch: a FOREIGN KEY cannot reference a
  table created in the same one.

  If this ever fails with "conflicted with the FOREIGN KEY constraint", some
  row already carries a WorkLocationId matching no location. That is real
  corruption and the migration SHOULD stop - fix the rows, then re-run.
*/
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_tblEmployeeDetails_WorkLocation')
    ALTER TABLE dbo.tblEmployeeDetails
        ADD CONSTRAINT FK_tblEmployeeDetails_WorkLocation
            FOREIGN KEY (WorkLocationId) REFERENCES dbo.tblOrganizationLocation (LocationId);
GO

-- "Associated users" on the locations grid, and the guard that refuses to
-- delete a location somebody still works at. Both are a seek with this.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_tblEmployeeDetails_WorkLocationId')
    CREATE INDEX IX_tblEmployeeDetails_WorkLocationId
        ON dbo.tblEmployeeDetails (WorkLocationId) WHERE DeletedAt IS NULL;

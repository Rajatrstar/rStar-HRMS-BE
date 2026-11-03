/*
  Master data, part two: the dropdown lists behind the employee form.

  WHERE THESE CAME FROM. "Zoho Master data.xlsx" marks every field that is a
  dropdown in yellow. 009 already built the five that existed before it -
  parent departments, departments, designations, leave types and categories -
  so this migration builds the rest: 23 lists, one table each.

  WHAT IS DELIBERATELY NOT HERE, and why:

    Designation, Department      built by 009. Nothing is re-created.
    Employee Status              tblEmployeeDetails.IsActive already carries
                                 Active/Inactive. A second, editable list
                                 saying the same thing is how the two drift.
    WFO Required (Yes/No)        tblEmployeeDetails.WorkFromOffice is a BIT.
                                 A lookup table of "Yes" and "No" is a
                                 checkbox with extra steps.
    System Role                  dbo.tblGroup from 004, with its own screen
                                 and its own rights matrix. A role is not a
                                 label, it is a set of permissions.
    Office / Seating Location    dbo.tblOrganizationLocation from 005.
    Legal Entity                 dbo.tblOrganization from 005.
    Additional Accessories       the same values as Asset Type, so it reads
                                 tblAssetType.
    Dependent Relationship       the same values as the emergency-contact
                                 relationship, so it reads tblRelationship.

  SHAPE: identical to 009 - Name, Description, IsActive and the four audit
  columns - which is what lets one service, one controller and one route loop
  serve all of them (src/services/master-data.service.js).

  NAME IS UNIQUE AMONG LIVE ROWS, filtered on DeletedAt, as in 009:
  soft-deleting a row frees its name again.

  NO FOREIGN KEYS ONTO tblEmployeeDetails YET. 001 and 007 store these fields
  as text (Gender, MaritalStatus, JobRole, EmployeeBand, SourceOfHire,
  EmploymentType, OnboardingStatus, TaxRegime and the rest), and the imported
  Zoho values do not all match the lists below. Turning each column into an
  id is a data migration with a mapping decision per column - the same debt
  009 settled for DepartmentId and DesignationId, and it is settled the same
  way when somebody has agreed the mapping. Until then these tables feed the
  dropdowns and the text columns keep what was imported.

  Times are UTC (SYSUTCDATETIME()), as everywhere else in this schema.

  Note for hand-written queries: these tables carry filtered indexes, so SQL
  Server refuses INSERT/UPDATE/DELETE unless QUOTED_IDENTIFIER is ON. The
  driver and SSMS set it ON already; sqlcmd does not, so run sqlcmd with -I.
*/

/* Gender options on the personal details form */
IF OBJECT_ID('dbo.tblGender', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblGender (
        GenderId     BIGINT          IDENTITY(1,1) NOT NULL,

        Name         NVARCHAR(150)   NOT NULL,
        Description  NVARCHAR(500)   NULL,

        IsActive     BIT             NOT NULL
            CONSTRAINT DF_tblGender_IsActive DEFAULT 1,

        CreatedBy    BIGINT          NULL,
        ModifiedBy   BIGINT          NULL,
        CreatedAt    DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblGender_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt   DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblGender_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt    DATETIME2(3)    NULL,

        CONSTRAINT PK_tblGender PRIMARY KEY CLUSTERED (GenderId),
        CONSTRAINT FK_tblGender_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblGender_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblGender_Name
        ON dbo.tblGender (Name) WHERE DeletedAt IS NULL;
END;
GO

/* Marital status options on the personal details form */
IF OBJECT_ID('dbo.tblMaritalStatus', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblMaritalStatus (
        MaritalStatusId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name              NVARCHAR(150)   NOT NULL,
        Description       NVARCHAR(500)   NULL,

        IsActive          BIT             NOT NULL
            CONSTRAINT DF_tblMaritalStatus_IsActive DEFAULT 1,

        CreatedBy         BIGINT          NULL,
        ModifiedBy        BIGINT          NULL,
        CreatedAt         DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblMaritalStatus_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt        DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblMaritalStatus_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt         DATETIME2(3)    NULL,

        CONSTRAINT PK_tblMaritalStatus PRIMARY KEY CLUSTERED (MaritalStatusId),
        CONSTRAINT FK_tblMaritalStatus_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblMaritalStatus_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblMaritalStatus_Name
        ON dbo.tblMaritalStatus (Name) WHERE DeletedAt IS NULL;
END;
GO

/* How an emergency contact or a dependent is related to the employee */
IF OBJECT_ID('dbo.tblRelationship', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblRelationship (
        RelationshipId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name             NVARCHAR(150)   NOT NULL,
        Description      NVARCHAR(500)   NULL,

        IsActive         BIT             NOT NULL
            CONSTRAINT DF_tblRelationship_IsActive DEFAULT 1,

        CreatedBy        BIGINT          NULL,
        ModifiedBy       BIGINT          NULL,
        CreatedAt        DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblRelationship_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt       DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblRelationship_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt        DATETIME2(3)    NULL,

        CONSTRAINT PK_tblRelationship PRIMARY KEY CLUSTERED (RelationshipId),
        CONSTRAINT FK_tblRelationship_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblRelationship_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblRelationship_Name
        ON dbo.tblRelationship (Name) WHERE DeletedAt IS NULL;
END;
GO

/* Skills and areas of expertise an employee can be tagged with */
IF OBJECT_ID('dbo.tblSkill', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblSkill (
        SkillId      BIGINT          IDENTITY(1,1) NOT NULL,

        Name         NVARCHAR(150)   NOT NULL,
        Description  NVARCHAR(500)   NULL,

        IsActive     BIT             NOT NULL
            CONSTRAINT DF_tblSkill_IsActive DEFAULT 1,

        CreatedBy    BIGINT          NULL,
        ModifiedBy   BIGINT          NULL,
        CreatedAt    DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblSkill_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt   DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblSkill_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt    DATETIME2(3)    NULL,

        CONSTRAINT PK_tblSkill PRIMARY KEY CLUSTERED (SkillId),
        CONSTRAINT FK_tblSkill_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblSkill_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblSkill_Name
        ON dbo.tblSkill (Name) WHERE DeletedAt IS NULL;
END;
GO

/* The terms an employee is engaged on */
IF OBJECT_ID('dbo.tblEmploymentType', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblEmploymentType (
        EmploymentTypeId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name               NVARCHAR(150)   NOT NULL,
        Description        NVARCHAR(500)   NULL,

        IsActive           BIT             NOT NULL
            CONSTRAINT DF_tblEmploymentType_IsActive DEFAULT 1,

        CreatedBy          BIGINT          NULL,
        ModifiedBy         BIGINT          NULL,
        CreatedAt          DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmploymentType_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt         DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmploymentType_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt          DATETIME2(3)    NULL,

        CONSTRAINT PK_tblEmploymentType PRIMARY KEY CLUSTERED (EmploymentTypeId),
        CONSTRAINT FK_tblEmploymentType_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmploymentType_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblEmploymentType_Name
        ON dbo.tblEmploymentType (Name) WHERE DeletedAt IS NULL;
END;
GO

/* The kind of role an employee holds, independent of their job title */
IF OBJECT_ID('dbo.tblJobRole', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblJobRole (
        JobRoleId    BIGINT          IDENTITY(1,1) NOT NULL,

        Name         NVARCHAR(150)   NOT NULL,
        Description  NVARCHAR(500)   NULL,

        IsActive     BIT             NOT NULL
            CONSTRAINT DF_tblJobRole_IsActive DEFAULT 1,

        CreatedBy    BIGINT          NULL,
        ModifiedBy   BIGINT          NULL,
        CreatedAt    DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblJobRole_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt   DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblJobRole_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt    DATETIME2(3)    NULL,

        CONSTRAINT PK_tblJobRole PRIMARY KEY CLUSTERED (JobRoleId),
        CONSTRAINT FK_tblJobRole_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblJobRole_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblJobRole_Name
        ON dbo.tblJobRole (Name) WHERE DeletedAt IS NULL;
END;
GO

/* Internal grade bands */
IF OBJECT_ID('dbo.tblEmployeeBand', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblEmployeeBand (
        EmployeeBandId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name             NVARCHAR(150)   NOT NULL,
        Description      NVARCHAR(500)   NULL,

        IsActive         BIT             NOT NULL
            CONSTRAINT DF_tblEmployeeBand_IsActive DEFAULT 1,

        CreatedBy        BIGINT          NULL,
        ModifiedBy       BIGINT          NULL,
        CreatedAt        DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmployeeBand_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt       DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmployeeBand_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt        DATETIME2(3)    NULL,

        CONSTRAINT PK_tblEmployeeBand PRIMARY KEY CLUSTERED (EmployeeBandId),
        CONSTRAINT FK_tblEmployeeBand_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeBand_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblEmployeeBand_Name
        ON dbo.tblEmployeeBand (Name) WHERE DeletedAt IS NULL;
END;
GO

/* The countries the company employs people in */
IF OBJECT_ID('dbo.tblWorkLocationCountry', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblWorkLocationCountry (
        WorkLocationCountryId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name                    NVARCHAR(150)   NOT NULL,
        Description             NVARCHAR(500)   NULL,

        IsActive                BIT             NOT NULL
            CONSTRAINT DF_tblWorkLocationCountry_IsActive DEFAULT 1,

        CreatedBy               BIGINT          NULL,
        ModifiedBy              BIGINT          NULL,
        CreatedAt               DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblWorkLocationCountry_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt              DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblWorkLocationCountry_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt               DATETIME2(3)    NULL,

        CONSTRAINT PK_tblWorkLocationCountry PRIMARY KEY CLUSTERED (WorkLocationCountryId),
        CONSTRAINT FK_tblWorkLocationCountry_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblWorkLocationCountry_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblWorkLocationCountry_Name
        ON dbo.tblWorkLocationCountry (Name) WHERE DeletedAt IS NULL;
END;
GO

/* Where an employee works from */
IF OBJECT_ID('dbo.tblWorkMode', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblWorkMode (
        WorkModeId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name         NVARCHAR(150)   NOT NULL,
        Description  NVARCHAR(500)   NULL,

        IsActive     BIT             NOT NULL
            CONSTRAINT DF_tblWorkMode_IsActive DEFAULT 1,

        CreatedBy    BIGINT          NULL,
        ModifiedBy   BIGINT          NULL,
        CreatedAt    DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblWorkMode_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt   DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblWorkMode_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt    DATETIME2(3)    NULL,

        CONSTRAINT PK_tblWorkMode PRIMARY KEY CLUSTERED (WorkModeId),
        CONSTRAINT FK_tblWorkMode_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblWorkMode_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblWorkMode_Name
        ON dbo.tblWorkMode (Name) WHERE DeletedAt IS NULL;
END;
GO

/* Whether an employee's time is billed to a client */
IF OBJECT_ID('dbo.tblBillabilityType', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblBillabilityType (
        BillabilityTypeId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name                NVARCHAR(150)   NOT NULL,
        Description         NVARCHAR(500)   NULL,

        IsActive            BIT             NOT NULL
            CONSTRAINT DF_tblBillabilityType_IsActive DEFAULT 1,

        CreatedBy           BIGINT          NULL,
        ModifiedBy          BIGINT          NULL,
        CreatedAt           DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblBillabilityType_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt          DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblBillabilityType_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt           DATETIME2(3)    NULL,

        CONSTRAINT PK_tblBillabilityType PRIMARY KEY CLUSTERED (BillabilityTypeId),
        CONSTRAINT FK_tblBillabilityType_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblBillabilityType_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblBillabilityType_Name
        ON dbo.tblBillabilityType (Name) WHERE DeletedAt IS NULL;
END;
GO

/* The project or client an employee is assigned to */
IF OBJECT_ID('dbo.tblProjectClient', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblProjectClient (
        ProjectClientId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name              NVARCHAR(150)   NOT NULL,
        Description       NVARCHAR(500)   NULL,

        IsActive          BIT             NOT NULL
            CONSTRAINT DF_tblProjectClient_IsActive DEFAULT 1,

        CreatedBy         BIGINT          NULL,
        ModifiedBy        BIGINT          NULL,
        CreatedAt         DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblProjectClient_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt        DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblProjectClient_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt         DATETIME2(3)    NULL,

        CONSTRAINT PK_tblProjectClient PRIMARY KEY CLUSTERED (ProjectClientId),
        CONSTRAINT FK_tblProjectClient_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblProjectClient_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblProjectClient_Name
        ON dbo.tblProjectClient (Name) WHERE DeletedAt IS NULL;
END;
GO

/* The cost center an employee's salary is booked against */
IF OBJECT_ID('dbo.tblCostCenter', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblCostCenter (
        CostCenterId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name           NVARCHAR(150)   NOT NULL,
        Description    NVARCHAR(500)   NULL,

        IsActive       BIT             NOT NULL
            CONSTRAINT DF_tblCostCenter_IsActive DEFAULT 1,

        CreatedBy      BIGINT          NULL,
        ModifiedBy     BIGINT          NULL,
        CreatedAt      DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblCostCenter_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt     DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblCostCenter_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt      DATETIME2(3)    NULL,

        CONSTRAINT PK_tblCostCenter PRIMARY KEY CLUSTERED (CostCenterId),
        CONSTRAINT FK_tblCostCenter_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblCostCenter_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblCostCenter_Name
        ON dbo.tblCostCenter (Name) WHERE DeletedAt IS NULL;
END;
GO

/* How a hire reached the company */
IF OBJECT_ID('dbo.tblSourceOfHire', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblSourceOfHire (
        SourceOfHireId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name             NVARCHAR(150)   NOT NULL,
        Description      NVARCHAR(500)   NULL,

        IsActive         BIT             NOT NULL
            CONSTRAINT DF_tblSourceOfHire_IsActive DEFAULT 1,

        CreatedBy        BIGINT          NULL,
        ModifiedBy       BIGINT          NULL,
        CreatedAt        DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblSourceOfHire_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt       DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblSourceOfHire_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt        DATETIME2(3)    NULL,

        CONSTRAINT PK_tblSourceOfHire PRIMARY KEY CLUSTERED (SourceOfHireId),
        CONSTRAINT FK_tblSourceOfHire_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblSourceOfHire_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblSourceOfHire_Name
        ON dbo.tblSourceOfHire (Name) WHERE DeletedAt IS NULL;
END;
GO

/* Where a new joiner has got to in onboarding */
IF OBJECT_ID('dbo.tblOnboardingStatus', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblOnboardingStatus (
        OnboardingStatusId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name                 NVARCHAR(150)   NOT NULL,
        Description          NVARCHAR(500)   NULL,

        IsActive             BIT             NOT NULL
            CONSTRAINT DF_tblOnboardingStatus_IsActive DEFAULT 1,

        CreatedBy            BIGINT          NULL,
        ModifiedBy           BIGINT          NULL,
        CreatedAt            DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblOnboardingStatus_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt           DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblOnboardingStatus_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt            DATETIME2(3)    NULL,

        CONSTRAINT PK_tblOnboardingStatus PRIMARY KEY CLUSTERED (OnboardingStatusId),
        CONSTRAINT FK_tblOnboardingStatus_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblOnboardingStatus_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblOnboardingStatus_Name
        ON dbo.tblOnboardingStatus (Name) WHERE DeletedAt IS NULL;
END;
GO

/* Where a background check has got to */
IF OBJECT_ID('dbo.tblBackgroundVerificationStatus', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblBackgroundVerificationStatus (
        BackgroundVerificationStatusId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name                             NVARCHAR(150)   NOT NULL,
        Description                      NVARCHAR(500)   NULL,

        IsActive                         BIT             NOT NULL
            CONSTRAINT DF_tblBackgroundVerificationStatus_IsActive DEFAULT 1,

        CreatedBy                        BIGINT          NULL,
        ModifiedBy                       BIGINT          NULL,
        CreatedAt                        DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblBackgroundVerificationStatus_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt                       DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblBackgroundVerificationStatus_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt                        DATETIME2(3)    NULL,

        CONSTRAINT PK_tblBackgroundVerificationStatus PRIMARY KEY CLUSTERED (BackgroundVerificationStatusId),
        CONSTRAINT FK_tblBackgroundVerificationStatus_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblBackgroundVerificationStatus_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblBackgroundVerificationStatus_Name
        ON dbo.tblBackgroundVerificationStatus (Name) WHERE DeletedAt IS NULL;
END;
GO

/* The tax regime an employee has elected */
IF OBJECT_ID('dbo.tblTaxRegime', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblTaxRegime (
        TaxRegimeId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name          NVARCHAR(150)   NOT NULL,
        Description   NVARCHAR(500)   NULL,

        IsActive      BIT             NOT NULL
            CONSTRAINT DF_tblTaxRegime_IsActive DEFAULT 1,

        CreatedBy     BIGINT          NULL,
        ModifiedBy    BIGINT          NULL,
        CreatedAt     DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblTaxRegime_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt    DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblTaxRegime_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt     DATETIME2(3)    NULL,

        CONSTRAINT PK_tblTaxRegime PRIMARY KEY CLUSTERED (TaxRegimeId),
        CONSTRAINT FK_tblTaxRegime_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblTaxRegime_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblTaxRegime_Name
        ON dbo.tblTaxRegime (Name) WHERE DeletedAt IS NULL;
END;
GO

/* The kinds of government identity document on file */
IF OBJECT_ID('dbo.tblGovernmentIdType', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblGovernmentIdType (
        GovernmentIdTypeId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name                 NVARCHAR(150)   NOT NULL,
        Description          NVARCHAR(500)   NULL,

        IsActive             BIT             NOT NULL
            CONSTRAINT DF_tblGovernmentIdType_IsActive DEFAULT 1,

        CreatedBy            BIGINT          NULL,
        ModifiedBy           BIGINT          NULL,
        CreatedAt            DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblGovernmentIdType_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt           DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblGovernmentIdType_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt            DATETIME2(3)    NULL,

        CONSTRAINT PK_tblGovernmentIdType PRIMARY KEY CLUSTERED (GovernmentIdTypeId),
        CONSTRAINT FK_tblGovernmentIdType_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblGovernmentIdType_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblGovernmentIdType_Name
        ON dbo.tblGovernmentIdType (Name) WHERE DeletedAt IS NULL;
END;
GO

/* The kinds of document an employee record can hold */
IF OBJECT_ID('dbo.tblDocumentType', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblDocumentType (
        DocumentTypeId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name             NVARCHAR(150)   NOT NULL,
        Description      NVARCHAR(500)   NULL,

        IsActive         BIT             NOT NULL
            CONSTRAINT DF_tblDocumentType_IsActive DEFAULT 1,

        CreatedBy        BIGINT          NULL,
        ModifiedBy       BIGINT          NULL,
        CreatedAt        DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblDocumentType_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt       DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblDocumentType_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt        DATETIME2(3)    NULL,

        CONSTRAINT PK_tblDocumentType PRIMARY KEY CLUSTERED (DocumentTypeId),
        CONSTRAINT FK_tblDocumentType_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblDocumentType_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblDocumentType_Name
        ON dbo.tblDocumentType (Name) WHERE DeletedAt IS NULL;
END;
GO

/* Where the check on an uploaded document has got to */
IF OBJECT_ID('dbo.tblDocumentVerificationStatus', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblDocumentVerificationStatus (
        DocumentVerificationStatusId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name                           NVARCHAR(150)   NOT NULL,
        Description                    NVARCHAR(500)   NULL,

        IsActive                       BIT             NOT NULL
            CONSTRAINT DF_tblDocumentVerificationStatus_IsActive DEFAULT 1,

        CreatedBy                      BIGINT          NULL,
        ModifiedBy                     BIGINT          NULL,
        CreatedAt                      DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblDocumentVerificationStatus_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt                     DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblDocumentVerificationStatus_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt                      DATETIME2(3)    NULL,

        CONSTRAINT PK_tblDocumentVerificationStatus PRIMARY KEY CLUSTERED (DocumentVerificationStatusId),
        CONSTRAINT FK_tblDocumentVerificationStatus_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblDocumentVerificationStatus_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblDocumentVerificationStatus_Name
        ON dbo.tblDocumentVerificationStatus (Name) WHERE DeletedAt IS NULL;
END;
GO

/* The kinds of company asset issued to employees, and the accessories list */
IF OBJECT_ID('dbo.tblAssetType', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblAssetType (
        AssetTypeId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name          NVARCHAR(150)   NOT NULL,
        Description   NVARCHAR(500)   NULL,

        IsActive      BIT             NOT NULL
            CONSTRAINT DF_tblAssetType_IsActive DEFAULT 1,

        CreatedBy     BIGINT          NULL,
        ModifiedBy    BIGINT          NULL,
        CreatedAt     DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblAssetType_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt    DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblAssetType_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt     DATETIME2(3)    NULL,

        CONSTRAINT PK_tblAssetType PRIMARY KEY CLUSTERED (AssetTypeId),
        CONSTRAINT FK_tblAssetType_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblAssetType_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblAssetType_Name
        ON dbo.tblAssetType (Name) WHERE DeletedAt IS NULL;
END;
GO

/* Specific device models that can be issued */
IF OBJECT_ID('dbo.tblAssetModel', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblAssetModel (
        AssetModelId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name           NVARCHAR(150)   NOT NULL,
        Description    NVARCHAR(500)   NULL,

        IsActive       BIT             NOT NULL
            CONSTRAINT DF_tblAssetModel_IsActive DEFAULT 1,

        CreatedBy      BIGINT          NULL,
        ModifiedBy     BIGINT          NULL,
        CreatedAt      DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblAssetModel_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt     DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblAssetModel_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt      DATETIME2(3)    NULL,

        CONSTRAINT PK_tblAssetModel PRIMARY KEY CLUSTERED (AssetModelId),
        CONSTRAINT FK_tblAssetModel_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblAssetModel_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblAssetModel_Name
        ON dbo.tblAssetModel (Name) WHERE DeletedAt IS NULL;
END;
GO

/* Education levels on the qualification form */
IF OBJECT_ID('dbo.tblQualification', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblQualification (
        QualificationId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name              NVARCHAR(150)   NOT NULL,
        Description       NVARCHAR(500)   NULL,

        IsActive          BIT             NOT NULL
            CONSTRAINT DF_tblQualification_IsActive DEFAULT 1,

        CreatedBy         BIGINT          NULL,
        ModifiedBy        BIGINT          NULL,
        CreatedAt         DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblQualification_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt        DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblQualification_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt         DATETIME2(3)    NULL,

        CONSTRAINT PK_tblQualification PRIMARY KEY CLUSTERED (QualificationId),
        CONSTRAINT FK_tblQualification_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblQualification_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblQualification_Name
        ON dbo.tblQualification (Name) WHERE DeletedAt IS NULL;
END;
GO

/* Fields of study on the qualification form */
IF OBJECT_ID('dbo.tblSpecialization', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblSpecialization (
        SpecializationId   BIGINT          IDENTITY(1,1) NOT NULL,

        Name               NVARCHAR(150)   NOT NULL,
        Description        NVARCHAR(500)   NULL,

        IsActive           BIT             NOT NULL
            CONSTRAINT DF_tblSpecialization_IsActive DEFAULT 1,

        CreatedBy          BIGINT          NULL,
        ModifiedBy         BIGINT          NULL,
        CreatedAt          DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblSpecialization_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt         DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblSpecialization_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt          DATETIME2(3)    NULL,

        CONSTRAINT PK_tblSpecialization PRIMARY KEY CLUSTERED (SpecializationId),
        CONSTRAINT FK_tblSpecialization_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblSpecialization_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblSpecialization_Name
        ON dbo.tblSpecialization (Name) WHERE DeletedAt IS NULL;
END;
GO

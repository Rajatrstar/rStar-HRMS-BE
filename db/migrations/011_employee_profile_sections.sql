/*
  The repeating sections of an employee profile, and the documents uploaded
  against it.

    tblEmployeeWorkExperience  previous employers - one row per job.
    tblEmployeeEducation       qualifications - one row per degree/course.
    tblEmployeeDependent       family members the employee declares.
    tblEmployeeDocument        uploaded files: the PAN and Aadhaar scans.

  WHY CHILD TABLES AND NOT JSON ON tblEmployeeDetails: each section is a list
  of rows the edit screen adds to and removes from, and two of them point at
  master data (tblQualification, tblSpecialization, tblRelationship). A JSON
  column could hold the rows but could not carry those foreign keys, and
  "everybody with an MBA" would become a full scan of parsed text.

  SHAPE. The three row sections share one layout - EmployeeDetailId, their own
  fields, and the five audit columns - which is what lets one service and one
  controller serve all three (src/services/employee-section.service.js).

  Soft delete, as everywhere else here. Saving a section stamps DeletedAt on
  the rows the client dropped instead of removing them.

  DOCUMENTS STORE A PATH, NOT THE FILE. The bytes live on disk under
  UPLOAD_DIR; FileUrl is the path the API serves them from. At most one live
  document of each type per employee - uploading again replaces it, and the
  filtered unique index is what makes "replace" safe under a double submit.

  Times are UTC (SYSUTCDATETIME()), as everywhere else in this schema.

  Note for hand-written queries: these tables carry filtered indexes, so SQL
  Server refuses INSERT/UPDATE/DELETE unless QUOTED_IDENTIFIER is ON. The
  driver and SSMS set it ON already; sqlcmd does not, so run sqlcmd with -I.
*/

/* -------------------------------------------------------------------------
   Work experience.
   ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.tblEmployeeWorkExperience', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblEmployeeWorkExperience (
        EmployeeWorkExperienceId  BIGINT          IDENTITY(1,1) NOT NULL,
        EmployeeDetailId          BIGINT          NOT NULL,

        CompanyName               NVARCHAR(200)   NOT NULL,
        JobTitle                  NVARCHAR(150)   NOT NULL,
        FromDate                  DATE            NOT NULL,
        -- NULL while the job is still current.
        ToDate                    DATE            NULL,
        JobDescription            NVARCHAR(4000)  NULL,
        -- "Relevant" in the Zoho sheet: does this job count towards the
        -- experience the role asks for.
        IsRelevant                BIT             NULL,

        CreatedBy                 BIGINT          NULL,
        ModifiedBy                BIGINT          NULL,
        CreatedAt                 DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmployeeWorkExperience_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt                DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmployeeWorkExperience_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt                 DATETIME2(3)    NULL,

        CONSTRAINT PK_tblEmployeeWorkExperience PRIMARY KEY CLUSTERED (EmployeeWorkExperienceId),
        CONSTRAINT FK_tblEmployeeWorkExperience_Employee
            FOREIGN KEY (EmployeeDetailId) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeWorkExperience_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeWorkExperience_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT CK_tblEmployeeWorkExperience_Dates
            CHECK (ToDate IS NULL OR ToDate >= FromDate)
    );

    CREATE INDEX IX_tblEmployeeWorkExperience_EmployeeDetailId
        ON dbo.tblEmployeeWorkExperience (EmployeeDetailId) WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   Education.
   ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.tblEmployeeEducation', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblEmployeeEducation (
        EmployeeEducationId  BIGINT          IDENTITY(1,1) NOT NULL,
        EmployeeDetailId     BIGINT          NOT NULL,

        InstituteName        NVARCHAR(250)   NOT NULL,
        -- The level (Graduate, Post Graduate...) and the subject, both from
        -- master data. Degree is the free-text name on the certificate
        -- ("B.Tech", "MBA") because no list will ever cover every one.
        QualificationId      BIGINT          NULL,
        SpecializationId     BIGINT          NULL,
        Degree               NVARCHAR(150)   NULL,
        DateOfCompletion     DATE            NULL,
        -- Percentage, CGPA or class - written as the certificate writes it.
        Grade                NVARCHAR(50)    NULL,

        CreatedBy            BIGINT          NULL,
        ModifiedBy           BIGINT          NULL,
        CreatedAt            DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmployeeEducation_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt           DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmployeeEducation_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt            DATETIME2(3)    NULL,

        CONSTRAINT PK_tblEmployeeEducation PRIMARY KEY CLUSTERED (EmployeeEducationId),
        CONSTRAINT FK_tblEmployeeEducation_Employee
            FOREIGN KEY (EmployeeDetailId) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeEducation_Qualification
            FOREIGN KEY (QualificationId) REFERENCES dbo.tblQualification (QualificationId),
        CONSTRAINT FK_tblEmployeeEducation_Specialization
            FOREIGN KEY (SpecializationId) REFERENCES dbo.tblSpecialization (SpecializationId),
        CONSTRAINT FK_tblEmployeeEducation_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeEducation_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE INDEX IX_tblEmployeeEducation_EmployeeDetailId
        ON dbo.tblEmployeeEducation (EmployeeDetailId) WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   Dependents.
   ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.tblEmployeeDependent', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblEmployeeDependent (
        EmployeeDependentId  BIGINT          IDENTITY(1,1) NOT NULL,
        EmployeeDetailId     BIGINT          NOT NULL,

        Name                 NVARCHAR(150)   NOT NULL,
        RelationshipId       BIGINT          NOT NULL,
        DateOfBirth          DATE            NULL,
        Gender               NVARCHAR(30)    NULL,
        ContactNumber        NVARCHAR(20)    NULL,

        CreatedBy            BIGINT          NULL,
        ModifiedBy           BIGINT          NULL,
        CreatedAt            DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmployeeDependent_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt           DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmployeeDependent_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt            DATETIME2(3)    NULL,

        CONSTRAINT PK_tblEmployeeDependent PRIMARY KEY CLUSTERED (EmployeeDependentId),
        CONSTRAINT FK_tblEmployeeDependent_Employee
            FOREIGN KEY (EmployeeDetailId) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeDependent_Relationship
            FOREIGN KEY (RelationshipId) REFERENCES dbo.tblRelationship (RelationshipId),
        CONSTRAINT FK_tblEmployeeDependent_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeDependent_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE INDEX IX_tblEmployeeDependent_EmployeeDetailId
        ON dbo.tblEmployeeDependent (EmployeeDetailId) WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   Documents.
   ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.tblEmployeeDocument', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblEmployeeDocument (
        EmployeeDocumentId   BIGINT          IDENTITY(1,1) NOT NULL,
        EmployeeDetailId     BIGINT          NOT NULL,

        -- EMPLOYEE_DOCUMENT_TYPE in src/enums/employee.enum.js. A new type
        -- means widening this CHECK and that enum together.
        DocumentType         NVARCHAR(30)    NOT NULL,
        -- Where the API serves the file from, e.g.
        -- /uploads/employees/42/pan-<uuid>.jpg. Never an absolute disk path.
        FileUrl              NVARCHAR(500)   NOT NULL,
        OriginalFileName     NVARCHAR(255)   NULL,
        MimeType             NVARCHAR(100)   NOT NULL,
        FileSizeBytes        INT             NOT NULL,

        CreatedBy            BIGINT          NULL,
        ModifiedBy           BIGINT          NULL,
        CreatedAt            DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmployeeDocument_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt           DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblEmployeeDocument_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt            DATETIME2(3)    NULL,

        CONSTRAINT PK_tblEmployeeDocument PRIMARY KEY CLUSTERED (EmployeeDocumentId),
        CONSTRAINT FK_tblEmployeeDocument_Employee
            FOREIGN KEY (EmployeeDetailId) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeDocument_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeDocument_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT CK_tblEmployeeDocument_DocumentType
            CHECK (DocumentType IN ('PAN', 'AADHAAR'))
    );

    CREATE UNIQUE INDEX UQ_tblEmployeeDocument_EmployeeType
        ON dbo.tblEmployeeDocument (EmployeeDetailId, DocumentType) WHERE DeletedAt IS NULL;
END;
GO

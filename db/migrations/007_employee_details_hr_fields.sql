/*
  Brings dbo.tblEmployeeDetails up to the column set HR actually keeps, taken
  from the Zoho People export (employee.xlsx, 71 columns).

  ADDITIVE ON PURPOSE. 001 is not rewritten and the database is not rebuilt:
  there is live data in here now - logins, roles, an organisation - and every
  change below either adds a column or widens a CHECK, so nothing already
  stored becomes invalid. Running this on a populated database is safe.

  WHAT WAS LEFT OUT, and why, so the next person does not think it was missed:

    - Age. Derived from DateOfBirth. Storing it means it is wrong from the
      next birthday onwards, and the export's own value for one row is 0.
    - Year of Date of Joining / Birth / Exit. The export truncates real dates
      to a year; the DATE columns already here hold the whole thing.
    - CREATED BY / MODIFIED BY as "RSTR148  - Shakun Arora". CreatedBy and
      ModifiedBy are EmployeeDetailIds, which survive a rename.
    - Zoho Role, and Location / Department as Zoho's internal numeric ids
      (1.92226e17). Our own role tables and WorkLocationId / DepartmentId
      answer these; keeping Zoho's ids as well would be two sources of truth.
      ZohoUserId and ZohoRecordId ARE kept - an import needs something stable
      to match a person on.

  On the shape of what is added: this takes the table past seventy columns,
  which is wide. It is one row per person with no repeating groups, so it is
  not WRONG, but if employment history or assets ever need more than today's
  single value, those are the parts to lift into their own tables first.

  Note: this table carries filtered indexes, so SQL Server refuses writes to
  it unless QUOTED_IDENTIFIER is ON. sqlcmd needs -I; the driver sets it.
*/

/* ---------------------------------------------------------------------------
  1. The INT counter.

  SQL Server allows exactly ONE identity column per table and
  EmployeeDetailId BIGINT IDENTITY already is it, so a second IDENTITY is not
  available. A SEQUENCE with a DEFAULT behaves the same way from the caller's
  side - omit the column on INSERT and a number appears - and it is the
  supported way to get a second auto-incrementing column.

  Two things it does that an identity does not:
    - the next value can be read without inserting a row
    - the counter is an object of its own, so it can be reset or shared

  Adding it NOT NULL with this default backfills the rows already in the table,
  numbering them 1..n, and keeps counting from there.
--------------------------------------------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.sequences WHERE name = 'seqEmployeeSerialNo')
    CREATE SEQUENCE dbo.seqEmployeeSerialNo AS INT START WITH 1 INCREMENT BY 1;
GO

IF COL_LENGTH('dbo.tblEmployeeDetails', 'EmployeeSerialNo') IS NULL
    ALTER TABLE dbo.tblEmployeeDetails
        ADD EmployeeSerialNo INT NOT NULL
            CONSTRAINT DF_tblEmployeeDetails_EmployeeSerialNo
            DEFAULT (NEXT VALUE FOR dbo.seqEmployeeSerialNo);
GO

/*
  Not filtered on DeletedAt, unlike EmployeeCode and WorkEmail. A serial
  number is not a name being freed for reuse - it identifies one row for all
  time, and handing a departed employee's number to a new hire would make two
  different people share it in anything already printed or exported.
*/
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_tblEmployeeDetails_EmployeeSerialNo')
    CREATE UNIQUE INDEX UQ_tblEmployeeDetails_EmployeeSerialNo
        ON dbo.tblEmployeeDetails (EmployeeSerialNo);
GO

/* ---------------------------------------------------------------------------
  2. The new columns.

  Every one is NULLable. A row that exists today has no value for any of them,
  and NOT NULL with a made-up default would record a guess as if it were a
  fact. HR fills them in as the data arrives.
--------------------------------------------------------------------------- */

-- Where this person came from in Zoho. An import matches on these; nothing
-- else reads them.
IF COL_LENGTH('dbo.tblEmployeeDetails', 'ZohoUserId') IS NULL
    ALTER TABLE dbo.tblEmployeeDetails ADD
        ZohoUserId          NVARCHAR(50)    NULL,
        ZohoRecordId        NVARCHAR(50)    NULL,
        -- "Internal Employee ID" in the sheet: a second code some teams use
        -- alongside EmployeeCode (RSTR157).
        InternalEmployeeId  NVARCHAR(50)    NULL;
GO

-- Name and contact. The existing Phone column is the PERSONAL mobile; these
-- are the work line, which is a different number and often shared.
IF COL_LENGTH('dbo.tblEmployeeDetails', 'NickName') IS NULL
    ALTER TABLE dbo.tblEmployeeDetails ADD
        NickName                 NVARCHAR(150)  NULL,
        WorkPhone                NVARCHAR(20)   NULL,
        WorkPhoneExtension       NVARCHAR(20)   NULL,
        EmergencyContactNumber   NVARCHAR(20)   NULL,
        EmergencyContactRelation NVARCHAR(50)   NULL;
GO

/*
  Addresses, structured. The existing Address column stays as the present
  address written out in full - the sheet carries both the free-text form and
  the broken-out fields, and they are not always consistent with each other,
  so neither can be derived from the other.
*/
IF COL_LENGTH('dbo.tblEmployeeDetails', 'PresentAddressLine1') IS NULL
    ALTER TABLE dbo.tblEmployeeDetails ADD
        PresentAddressLine1   NVARCHAR(255)  NULL,
        PresentAddressLine2   NVARCHAR(255)  NULL,
        PresentCity           NVARCHAR(100)  NULL,
        PresentState          NVARCHAR(100)  NULL,
        PresentCountry        NVARCHAR(100)  NULL,
        PresentPostalCode     NVARCHAR(20)   NULL,

        PermanentAddress      NVARCHAR(MAX)  NULL,
        PermanentAddressLine1 NVARCHAR(255)  NULL,
        PermanentAddressLine2 NVARCHAR(255)  NULL,
        PermanentCity         NVARCHAR(100)  NULL,
        PermanentState        NVARCHAR(100)  NULL,
        PermanentCountry      NVARCHAR(100)  NULL,
        PermanentPostalCode   NVARCHAR(20)   NULL;
GO

/*
  Job. Designation and Department join WorkLocation in being stored as written
  as well as by id: the id tables do not exist yet, and a profile still has to
  read correctly in the meantime. When those tables arrive the text stays as
  the imported value and the id becomes the authority.
*/
IF COL_LENGTH('dbo.tblEmployeeDetails', 'Designation') IS NULL
    ALTER TABLE dbo.tblEmployeeDetails ADD
        Designation      NVARCHAR(150)  NULL,
        Department       NVARCHAR(150)  NULL,
        JobRole          NVARCHAR(150)  NULL,
        EmployeeBand     NVARCHAR(50)   NULL,
        -- Employee / Contractor / Vendor. Distinct from EmploymentType: this
        -- is what the person IS to the company, not how they are engaged.
        UserType         NVARCHAR(50)   NULL,
        SourceOfHire     NVARCHAR(100)  NULL,
        SeatingLocation  NVARCHAR(150)  NULL;
GO

/*
  Experience. TotalExperience is text because the export writes a band
  ("0 to 50"), not a number; CurrentExperience is years at this company and
  does arrive as a figure.
*/
IF COL_LENGTH('dbo.tblEmployeeDetails', 'TotalExperience') IS NULL
    ALTER TABLE dbo.tblEmployeeDetails ADD
        TotalExperience    NVARCHAR(50)   NULL,
        CurrentExperience  DECIMAL(5, 2)  NULL;
GO

-- Dates the original table had no column for.
IF COL_LENGTH('dbo.tblEmployeeDetails', 'DateOfRehire') IS NULL
    ALTER TABLE dbo.tblEmployeeDetails ADD
        DateOfRehire       DATE  NULL,
        ContractorEndDate  DATE  NULL;
GO

-- Personal details and the profile blurbs.
IF COL_LENGTH('dbo.tblEmployeeDetails', 'MaritalStatus') IS NULL
    ALTER TABLE dbo.tblEmployeeDetails ADD
        MaritalStatus  NVARCHAR(30)   NULL,
        AboutMe        NVARCHAR(MAX)  NULL,
        -- "Ask me about / Expertise".
        Expertise      NVARCHAR(MAX)  NULL,
        Tags           NVARCHAR(500)  NULL;
GO

/*
  Government identifiers. Deliberately NOT indexed and not unique: they are
  the most sensitive values in the table, an index would make them cheap to
  enumerate, and the export already contains rows where they are junk. If a
  uniqueness rule is ever wanted it belongs on verified data only.
*/
IF COL_LENGTH('dbo.tblEmployeeDetails', 'PanNumber') IS NULL
    ALTER TABLE dbo.tblEmployeeDetails ADD
        PanNumber     NVARCHAR(20)  NULL,
        AadharNumber  NVARCHAR(20)  NULL;
GO

-- Where the person is in each HR workflow. Free text: these lists are owned
-- by whoever runs the process and change without a release.
IF COL_LENGTH('dbo.tblEmployeeDetails', 'OnboardingStatus') IS NULL
    ALTER TABLE dbo.tblEmployeeDetails ADD
        OnboardingStatus             NVARCHAR(50)  NULL,
        ApprovalStatus               NVARCHAR(50)  NULL,
        -- "BGV" in the sheet.
        BackgroundVerificationStatus NVARCHAR(50)  NULL;
GO

-- How and on what they work.
IF COL_LENGTH('dbo.tblEmployeeDetails', 'WorkFromOffice') IS NULL
    ALTER TABLE dbo.tblEmployeeDetails ADD
        -- Yes/No in the export. NULL means nobody has said.
        WorkFromOffice         BIT            NULL,
        -- "B/NB": Billable / Non-Billable.
        BillableStatus         NVARCHAR(20)   NULL,
        ProjectName            NVARCHAR(200)  NULL,
        TaxRegime              NVARCHAR(20)   NULL,
        SystemConfiguration    NVARCHAR(500)  NULL,
        AdditionalAccessories  NVARCHAR(500)  NULL;
GO

/*
  The other two reporting lines. ManagerId already holds the primary one and
  drives the TEAM scope; these do not, deliberately. Widening TEAM to follow
  three manager columns is a decision about who can see whose data, and it
  belongs in the access-control layer rather than arriving as a side effect of
  an import.
*/
IF COL_LENGTH('dbo.tblEmployeeDetails', 'SecondaryManagerId') IS NULL
    ALTER TABLE dbo.tblEmployeeDetails ADD
        SecondaryManagerId  BIGINT  NULL,
        AdditionalManagerId BIGINT  NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_tblEmployeeDetails_SecondaryManager')
    ALTER TABLE dbo.tblEmployeeDetails
        ADD CONSTRAINT FK_tblEmployeeDetails_SecondaryManager
            FOREIGN KEY (SecondaryManagerId) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_tblEmployeeDetails_AdditionalManager')
    ALTER TABLE dbo.tblEmployeeDetails
        ADD CONSTRAINT FK_tblEmployeeDetails_AdditionalManager
            FOREIGN KEY (AdditionalManagerId) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId);
GO

-- Same guard the primary manager already has: nobody reports to themselves.
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_tblEmployeeDetails_NotOwnSecondaryManager')
    ALTER TABLE dbo.tblEmployeeDetails
        ADD CONSTRAINT CK_tblEmployeeDetails_NotOwnSecondaryManager CHECK (
            SecondaryManagerId IS NULL OR SecondaryManagerId <> EmployeeDetailId
        );
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_tblEmployeeDetails_NotOwnAdditionalManager')
    ALTER TABLE dbo.tblEmployeeDetails
        ADD CONSTRAINT CK_tblEmployeeDetails_NotOwnAdditionalManager CHECK (
            AdditionalManagerId IS NULL OR AdditionalManagerId <> EmployeeDetailId
        );
GO

/* ---------------------------------------------------------------------------
  3. Widen the two vocabularies.

  The export says Employment Type "Permanent" and Employee Status "Inactive" /
  "Resigned". None of those three pass the CHECKs written in 001, so importing
  real data would fail on the first row.

  Both lists are WIDENED, not replaced: the existing words are in use by rows
  already here, and dropping them would make this migration destructive for no
  gain. The cost is two vocabularies describing one thing, which is the honest
  state of affairs until somebody decides which one wins.

  Adding another value later means another migration AND the matching entry in
  src/enums/employee.enum.js. That pairing is the point - a new employment
  type should be a decision, not a typo that lands in the table.
--------------------------------------------------------------------------- */
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_tblEmployeeDetails_EmploymentType')
    ALTER TABLE dbo.tblEmployeeDetails DROP CONSTRAINT CK_tblEmployeeDetails_EmploymentType;
GO

ALTER TABLE dbo.tblEmployeeDetails
    ADD CONSTRAINT CK_tblEmployeeDetails_EmploymentType CHECK (
        EmploymentType IN (
            -- 001
            'FullTime', 'PartTime', 'Contract', 'Intern', 'Consultant',
            -- the Zoho export's vocabulary
            'Permanent', 'Temporary'
        )
    );
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_tblEmployeeDetails_EmploymentStatus')
    ALTER TABLE dbo.tblEmployeeDetails DROP CONSTRAINT CK_tblEmployeeDetails_EmploymentStatus;
GO

ALTER TABLE dbo.tblEmployeeDetails
    ADD CONSTRAINT CK_tblEmployeeDetails_EmploymentStatus CHECK (
        EmploymentStatus IN (
            -- 001
            'Active', 'OnLeave', 'NoticePeriod', 'Exited', 'Suspended',
            -- the Zoho export's vocabulary
            'Inactive', 'Resigned', 'Terminated'
        )
    );
GO

/* ---------------------------------------------------------------------------
  4. Indexes for the lookups this data makes possible.
--------------------------------------------------------------------------- */

-- An import's matching key: find the row this Zoho record already became.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_tblEmployeeDetails_ZohoRecordId')
    CREATE UNIQUE INDEX UQ_tblEmployeeDetails_ZohoRecordId
        ON dbo.tblEmployeeDetails (ZohoRecordId)
        WHERE ZohoRecordId IS NOT NULL AND DeletedAt IS NULL;
GO

-- "Who is on project X" and "who is billable" are the two reports this import
-- exists to make answerable.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_tblEmployeeDetails_ProjectName')
    CREATE INDEX IX_tblEmployeeDetails_ProjectName
        ON dbo.tblEmployeeDetails (ProjectName)
        WHERE DeletedAt IS NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_tblEmployeeDetails_BillableStatus')
    CREATE INDEX IX_tblEmployeeDetails_BillableStatus
        ON dbo.tblEmployeeDetails (BillableStatus)
        WHERE DeletedAt IS NULL;
GO

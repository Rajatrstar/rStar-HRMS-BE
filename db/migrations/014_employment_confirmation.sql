/*
  Probation and confirmation - the gate every leave rule in this module hangs on.

  docs/ATTENDANCE-LEAVE.html sections 01 and 03. The HR document makes
  probation a STATE rather than a date that has passed: CL/SL is granted one
  day a month while on probation, EL does not accrue at all, and the leave
  dashboard shows a different set of tiles. Nothing downstream can ask "is
  this person confirmed?" of a date alone, because HR must be able to confirm
  somebody early or extend them - both of which a computed value cannot say.

  NAMING NOTE, AND IT IS NOT THE NAME THE DOCUMENT USES.

  The design document calls this column EmploymentStatus. That name is
  already taken: dbo.tblEmployeeDetails.EmploymentStatus has existed since
  001, carries CK_tblEmployeeDetails_EmploymentStatus, and answers a
  different question - Active / OnLeave / NoticePeriod / Exited / Suspended,
  i.e. where somebody stands with the company. Widening that CHECK to also
  hold PROBATION and CONFIRMED would make one column answer two questions,
  and "Exited" would then silently mean "not on probation".

  So the new column is ConfirmationStatus. The two are independent and both
  are needed: an exited employee was still either confirmed or not, and the
  final-settlement calculation reads exactly that.

  WHY ProbationMonths IS A COLUMN rather than a constant. Three months is the
  default in the HR document, but it is also the number HR changes for a
  specific hire. As a column that is a field on a form; as a constant it is a
  deploy, and in the meantime somebody records the exception in a spreadsheet.

  WHY ConfirmedOn IS SEPARATE FROM ProbationEndDate. ProbationEndDate is when
  probation was scheduled to end; ConfirmedOn is when it actually did. They
  differ whenever HR confirms early or signs off late, and EL accrual starts
  from the second one (section 06). Collapsing them would make an early
  confirmation invisible the moment the scheduled date was rewritten.

  Note for hand-written queries: the tables below carry filtered indexes, so
  SQL Server refuses INSERT/UPDATE/DELETE unless QUOTED_IDENTIFIER is ON. The
  driver and SSMS set it ON already; sqlcmd does not, so run sqlcmd with -I.
*/

/* -------------------------------------------------------------------------
   1 - the three new columns on the employee record.

   All three are added with defaults and backfilled, rather than left NULL:
   every existing row describes a real person who is either on probation or
   not, and a NULL would make "unknown" a third state that every read path
   would have to handle forever.
   ------------------------------------------------------------------------- */

IF COL_LENGTH('dbo.tblEmployeeDetails', 'ConfirmationStatus') IS NULL
BEGIN
    ALTER TABLE dbo.tblEmployeeDetails
        ADD ConfirmationStatus NVARCHAR(20) NOT NULL
            CONSTRAINT DF_tblEmployeeDetails_ConfirmationStatus DEFAULT 'PROBATION';
END;
GO

IF COL_LENGTH('dbo.tblEmployeeDetails', 'ProbationMonths') IS NULL
BEGIN
    -- TINYINT: 0-255 months. 0 is meaningful - a rehire or a senior hire who
    -- joins confirmed, which the HR document allows for by exception.
    ALTER TABLE dbo.tblEmployeeDetails
        ADD ProbationMonths TINYINT NOT NULL
            CONSTRAINT DF_tblEmployeeDetails_ProbationMonths DEFAULT 3;
END;
GO

IF COL_LENGTH('dbo.tblEmployeeDetails', 'ConfirmedOn') IS NULL
BEGIN
    -- NULL while on probation. Set once, by the nightly job or by HR.
    ALTER TABLE dbo.tblEmployeeDetails ADD ConfirmedOn DATE NULL;
END;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
     WHERE name = 'CK_tblEmployeeDetails_ConfirmationStatus'
)
BEGIN
    ALTER TABLE dbo.tblEmployeeDetails
        ADD CONSTRAINT CK_tblEmployeeDetails_ConfirmationStatus
            CHECK (ConfirmationStatus IN ('PROBATION', 'CONFIRMED'));
END;
GO

/*
  Backfill, once.

  Anybody whose probation end date has already passed is confirmed - that is
  what the date meant before this column existed, and leaving them on
  PROBATION would stop EL accruing for the entire existing workforce on the
  first night the accrual job runs.

  ConfirmedOn is set to ProbationEndDate for those rows. It is the best fact
  available: the real confirmation date was never recorded, and inventing
  today's date would claim everybody was confirmed on the day this migration
  ran, which is worse than a date that is at least the right one in policy.

  A row with no ProbationEndDate at all keeps the PROBATION default, and the
  service computes a date for it from DateOfJoining the next time it is saved.
*/
UPDATE dbo.tblEmployeeDetails
   SET ConfirmationStatus = 'CONFIRMED',
       ConfirmedOn        = ProbationEndDate
 WHERE ProbationEndDate IS NOT NULL
   AND ProbationEndDate <= CAST(SYSUTCDATETIME() AS DATE)
   AND ConfirmationStatus = 'PROBATION'
   AND ConfirmedOn IS NULL;
GO

-- The confirmation job's daily question: "who is due today?". Filtered, so
-- the index holds only the people still on probation rather than the whole
-- company - a handful of rows, and it shrinks as they are confirmed.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_tblEmployeeDetails_ProbationDue'
       AND object_id = OBJECT_ID('dbo.tblEmployeeDetails')
)
BEGIN
    CREATE INDEX IX_tblEmployeeDetails_ProbationDue
        ON dbo.tblEmployeeDetails (ProbationEndDate)
        INCLUDE (ConfirmationStatus)
        WHERE ConfirmationStatus = 'PROBATION' AND DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   2 - the history of every change.

   APPEND-ONLY. No ModifiedBy, no ModifiedAt, no DeletedAt - the whole value
   of this table is that a row never changes after it is written. It is the
   answer to "why is this person still on probation in month seven", and an
   editable answer is not an answer.

   Both FromStatus and ToStatus are recorded rather than just the new one, so
   a reversal - CONFIRMED back to PROBATION, which should be rare and
   questioned - is visible as itself rather than inferred by reading the
   previous row.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblEmploymentStatusHistory', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblEmploymentStatusHistory (
        EmploymentStatusHistoryId BIGINT        IDENTITY(1,1) NOT NULL,

        EmployeeDetailId          BIGINT        NOT NULL,

        FromStatus                NVARCHAR(20)  NOT NULL,
        ToStatus                  NVARCHAR(20)  NOT NULL,

        -- Populated on EXTEND and SHORTEN; NULL on a plain confirmation.
        OldProbationEndDate       DATE          NULL,
        NewProbationEndDate       DATE          NULL,

        ChangeType                NVARCHAR(20)  NOT NULL,

        /*
          Mandatory, including for the automatic job - which writes
          "Probation period completed on <date>". A nullable reason column
          becomes an empty one, and then the table answers "when" but never
          "why", which is the question it exists for.
        */
        Reason                    NVARCHAR(500) NOT NULL,

        /*
          The automatic job writes itself as the actor rather than leaving
          this NULL: NULL would be indistinguishable from a row written
          before the column existed. The job uses the employee id configured
          as the system actor, and ChangeType = 'AUTO_CONFIRM' is what
          identifies it as a job either way.
        */
        ChangedBy                 BIGINT        NULL,
        ChangedAt                 DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblEmploymentStatusHistory_ChangedAt DEFAULT SYSUTCDATETIME(),

        CONSTRAINT PK_tblEmploymentStatusHistory
            PRIMARY KEY CLUSTERED (EmploymentStatusHistoryId),

        CONSTRAINT FK_tblEmploymentStatusHistory_Employee
            FOREIGN KEY (EmployeeDetailId)
            REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmploymentStatusHistory_ChangedBy
            FOREIGN KEY (ChangedBy)
            REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblEmploymentStatusHistory_FromStatus
            CHECK (FromStatus IN ('PROBATION', 'CONFIRMED')),
        CONSTRAINT CK_tblEmploymentStatusHistory_ToStatus
            CHECK (ToStatus   IN ('PROBATION', 'CONFIRMED')),
        CONSTRAINT CK_tblEmploymentStatusHistory_ChangeType
            CHECK (ChangeType IN ('AUTO_CONFIRM', 'MANUAL_CONFIRM', 'EXTEND', 'SHORTEN'))
    );

    -- One employee's timeline, newest first. The only way this table is read.
    CREATE INDEX IX_tblEmploymentStatusHistory_Employee
        ON dbo.tblEmploymentStatusHistory (EmployeeDetailId, ChangedAt DESC);
END;
GO

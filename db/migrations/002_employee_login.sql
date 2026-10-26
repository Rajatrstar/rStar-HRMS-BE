/*
  Login credentials. A satellite of dbo.tblEmployeeDetails, not the other way
  round.

  One row per person who can sign in. EmployeeDetailId is NOT NULL and unique,
  which is the whole point of this direction:

    - a login ALWAYS has an employee behind it, enforced by the database
      rather than hoped for by the code
    - an employee may have no login at all, which is the common case for staff
      who never touch the system
    - "signed in but no profile" is unrepresentable, so nothing downstream
      needs a branch for it

  EmployeeId stays the primary key, but it is now only a credential id. It is
  NOT the subject of anything: roles, groups, permission overrides and every
  CreatedBy/ModifiedBy in this schema key on EmployeeDetailId. The token
  carries EmployeeDetailId for the same reason.

  Keeping credentials in their own table still earns its place - HR data and
  authentication data get read, cached and permissioned independently, and a
  query over employees never drags a password hash through memory.

  Times are stored as UTC (SYSUTCDATETIME), never local time, so the values stay
  correct across time zones and daylight-saving changes.
*/

IF OBJECT_ID('dbo.EmployeeLogin', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.EmployeeLogin (
        EmployeeId      INT             IDENTITY(1,1) NOT NULL,

        -- The person these credentials belong to. NOT NULL by design.
        EmployeeDetailId BIGINT         NOT NULL,

        Email           NVARCHAR(256)   NOT NULL,
        -- bcrypt output is 60 chars; the extra room allows a future rehash to
        -- a longer format without a schema change.
        HashPassword    NVARCHAR(255)   NOT NULL,

        -- Second factor. Both are NULL whenever no login is in progress, and
        -- are cleared as soon as an OTP is used or a new one is issued.
        Otp             NVARCHAR(10)    NULL,
        OtpExpiresTime  DATETIME2(3)    NULL,

        LastLoginedAt   DATETIME2(3)    NULL,

        CreatedAt       DATETIME2(3)    NOT NULL
            CONSTRAINT DF_EmployeeLogin_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt      DATETIME2(3)    NOT NULL
            CONSTRAINT DF_EmployeeLogin_ModifiedAt DEFAULT SYSUTCDATETIME(),

        CONSTRAINT PK_EmployeeLogin PRIMARY KEY CLUSTERED (EmployeeId),

        CONSTRAINT FK_EmployeeLogin_Employee
            FOREIGN KEY (EmployeeDetailId) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    /*
      Lookups are always by email, and an address must identify one account.
      The database collation is case-insensitive, so Admin@x.com and admin@x.com
      collide here exactly as a user would expect.
    */
    CREATE UNIQUE INDEX UQ_EmployeeLogin_Email
        ON dbo.EmployeeLogin (Email);

    /*
      One login per employee. NOT filtered, unlike most unique indexes here:
      this table has no DeletedAt, so every row is live and all of them
      compete. Revoking access means deleting the row or deactivating the
      employee, not soft-deleting a credential.
    */
    CREATE UNIQUE INDEX UQ_EmployeeLogin_EmployeeDetailId
        ON dbo.EmployeeLogin (EmployeeDetailId);
END;

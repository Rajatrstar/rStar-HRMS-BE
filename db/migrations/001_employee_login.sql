/*
  Login credentials for an employee.

  One row per person who can sign in. Kept separate from the (future) employee
  profile table so that HR data and authentication data can be read, cached and
  permissioned independently.

  Times are stored as UTC (SYSUTCDATETIME), never local time, so the values stay
  correct across time zones and daylight-saving changes.
*/

IF OBJECT_ID('dbo.EmployeeLogin', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.EmployeeLogin (
        EmployeeId      INT             IDENTITY(1,1) NOT NULL,

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

        CONSTRAINT PK_EmployeeLogin PRIMARY KEY CLUSTERED (EmployeeId)
    );

    /*
      Lookups are always by email, and an address must identify one account.
      The database collation is case-insensitive, so Admin@x.com and admin@x.com
      collide here exactly as a user would expect.
    */
    CREATE UNIQUE INDEX UQ_EmployeeLogin_Email
        ON dbo.EmployeeLogin (Email);
END;

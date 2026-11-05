/*
  MustChangePassword on dbo.EmployeeLogin.

  Set to 1 when HR invites an employee: the login is created with a
  temporary password that HR hands over, so the employee must replace it
  before reaching anything. /auth/verify-otp refuses such an account and
  /auth/set-password is the only way through; it writes the new hash and
  clears the flag in one statement.

  A forgot-password reset clears it too - a password the employee chose
  themselves is exactly what the flag is waiting for.

  NOT NULL with a default of 0, so every login that already exists keeps
  signing in exactly as before.
*/

IF COL_LENGTH('dbo.EmployeeLogin', 'MustChangePassword') IS NULL
    ALTER TABLE dbo.EmployeeLogin ADD MustChangePassword BIT NOT NULL
        CONSTRAINT DF_EmployeeLogin_MustChangePassword DEFAULT 0;

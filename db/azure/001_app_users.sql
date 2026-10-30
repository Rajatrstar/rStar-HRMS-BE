/*
  Azure SQL: the two accounts the API uses.

  NOT a migration. db/migrations is applied automatically and runs as whoever
  is in .env; these statements create those users in the first place, so they
  are run once, by hand, as the server administrator. Keeping the file out of
  db/migrations is what stops the migration runner trying to create the users
  it is already connected as.

  Run it against the rStarHRMS database itself - not master:

    sqlcmd -S <server>.database.windows.net -d rStarHRMS -U <admin> -P <password> -G -i db/azure/001_app_users.sql

  Both are CONTAINED users: the password lives in this database rather than in
  a master-level login. That is what lets the database be failed over, copied
  or restored to another logical server and still be usable, without an
  orphaned-user repair step on the other side.

  Replace both passwords before running. Azure enforces complexity, and a
  rejected password fails the whole batch.
*/

-- ---------------------------------------------------------------------------
-- The API's own account: read and write the data, and nothing structural.
-- This is the one that goes in .env on a deployed server.
-- ---------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'hrms_app')
    CREATE USER hrms_app WITH PASSWORD = 'REPLACE-ME-app-Str0ng!Passw0rd';
GO

ALTER ROLE db_datareader ADD MEMBER hrms_app;
ALTER ROLE db_datawriter ADD MEMBER hrms_app;
GO

-- ---------------------------------------------------------------------------
-- The deployment account: the same, plus the right to change the schema.
--
-- Separate from hrms_app on purpose. A SQL injection that reaches the database
-- as hrms_app can read and corrupt rows, which is bad; as a user that can also
-- DROP TABLE it is unrecoverable. Migrations run rarely and deliberately, so
-- they can afford to use their own credentials - see .env.azure.example.
-- ---------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'hrms_deploy')
    CREATE USER hrms_deploy WITH PASSWORD = 'REPLACE-ME-deploy-Str0ng!Passw0rd';
GO

ALTER ROLE db_datareader ADD MEMBER hrms_deploy;
ALTER ROLE db_datawriter ADD MEMBER hrms_deploy;
ALTER ROLE db_ddladmin  ADD MEMBER hrms_deploy;
GO

-- The migration runner records what it has applied, and 007 creates a
-- SEQUENCE. db_ddladmin covers tables and indexes but CREATE SEQUENCE is
-- granted at database level, so it is granted explicitly.
GRANT CREATE TABLE, CREATE SEQUENCE, CREATE VIEW TO hrms_deploy;
GO

SELECT
    principal = dp.name,
    role      = r.name
FROM sys.database_principals AS dp
LEFT JOIN sys.database_role_members AS drm ON drm.member_principal_id = dp.principal_id
LEFT JOIN sys.database_principals  AS r   ON r.principal_id = drm.role_principal_id
WHERE dp.name IN ('hrms_app', 'hrms_deploy')
ORDER BY dp.name, r.name;

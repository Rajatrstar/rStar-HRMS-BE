/*
  Error log, widened - see 012_error_log.sql for the table itself.

  Two new values, so two CHECK constraints are replaced:

    Severity 'WARN'    403 and 409 are now logged too. They are the client's
                       side of the line - a missing right, a duplicate, a
                       rule refused - so they are kept apart from the server's
                       own faults (ERROR) rather than mixed in with them.

    Source 'CLIENT'    POST /api/v1/error-logs: the frontend reporting its own
                       failures (a crashed screen, a script error), so the
                       admin dashboard shows both halves of a problem in one
                       list.

  Dropped and re-added rather than altered: SQL Server has no ALTER for a
  CHECK definition.
*/

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_tblErrorLog_Source')
    ALTER TABLE dbo.tblErrorLog DROP CONSTRAINT CK_tblErrorLog_Source;

ALTER TABLE dbo.tblErrorLog ADD CONSTRAINT CK_tblErrorLog_Source
    CHECK (Source IN ('API', 'JOB', 'PROCESS', 'STARTUP', 'CLIENT'));

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_tblErrorLog_Severity')
    ALTER TABLE dbo.tblErrorLog DROP CONSTRAINT CK_tblErrorLog_Severity;

ALTER TABLE dbo.tblErrorLog ADD CONSTRAINT CK_tblErrorLog_Severity
    CHECK (Severity IN ('WARN', 'ERROR', 'FATAL'));

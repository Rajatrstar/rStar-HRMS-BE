/*
  The reference rows the attendance tables cannot work without.

  WHY THIS IS NOT PART OF 016, WHERE IT BELONGS. These rows were written
  into 016 as it was being built, but that file had already been applied by
  a dev server running with DB_AUTO_MIGRATE on. A migration is recorded in
  dbo._Migrations BY FILENAME, so an edit to an applied file changes nothing
  for that database and quietly produces two different schemas from the same
  source - which is the failure the numbered-file discipline exists to
  prevent. 016 therefore stays as it ran, and the rows live here.

  Both statements are idempotent and both are correct on a database that has
  never seen them, so a fresh database and the dev one converge.

  WHAT THE TWO LISTS ARE, AND WHY THEY ARE DIFFERENT KINDS OF THING:

    tblAttendanceStatus   OWNED BY THE CODE. The ids are fixed, they are
                          stored in every tblAttendanceDay row forever, and
                          the nightly close branches on them by name. MERGEd
                          by id, so renaming one or changing its colour is an
                          edit here. NOT editable on a screen - a renamed or
                          soft-deleted "Present" would break the job that
                          writes the table, hours later, as an entire office
                          marked absent.

    tblRegularizationType ORDINARY MASTER DATA. Nothing branches on which
                          reason a correction carries; it is a label on a
                          form. Inserted only when the table is empty, so HR
                          editing or adding to the list survives a re-run.
                          It is served by the shared master-data registry.
*/

/* -------------------------------------------------------------------------
   1 - the nine attendance statuses.

   MERGE on the id, because the id is the contract - ATTENDANCE_STATUS in
   src/enums/attendance.enum.js - and the rest of the row is presentation.
   ------------------------------------------------------------------------- */

MERGE dbo.tblAttendanceStatus WITH (HOLDLOCK) AS target
USING (VALUES
        (1, N'PRESENT',       N'Present',        1, N'#15803d', 10,
         N'Worked at least the shift''s full-day minutes.'),
        (2, N'ABSENT',        N'Absent',         0, N'#b91c1c', 20,
         N'No punches, no leave, no holiday and not a week off.'),
        (3, N'LATE',          N'Late',           1, N'#b45309', 30,
         N'Present, but checked in after the shift''s grace period.'),
        (4, N'HALF_DAY',      N'Half Day',       1, N'#a16207', 40,
         N'Worked at least the half-day minutes but less than a full day.'),
        (5, N'MISSING_PUNCH', N'Missing Punch',  0, N'#c2410c', 50,
         N'Checked in without checking out, or the reverse. Needs regularization.'),
        (6, N'ON_LEAVE',      N'On Leave',       0, N'#4f46e5', 60,
         N'Covered by an approved leave request.'),
        (7, N'HOLIDAY',       N'Holiday',        0, N'#0e7490', 70,
         N'A declared holiday at the employee''s work location.'),
        (8, N'WEEK_OFF',      N'Week Off',       0, N'#64748b', 80,
         N'A non-working day under the employee''s shift pattern.'),
        (9, N'REGULARIZED',   N'Regularized',    1, N'#047857', 90,
         N'Corrected by an approved regularization request.')
      ) AS source (AttendanceStatusId, StatusCode, StatusName, CountsAsPresent,
                   ColorHex, SortOrder, Description)
   ON target.AttendanceStatusId = source.AttendanceStatusId
 WHEN MATCHED THEN UPDATE SET
      StatusCode      = source.StatusCode,
      StatusName      = source.StatusName,
      CountsAsPresent = source.CountsAsPresent,
      ColorHex        = source.ColorHex,
      SortOrder       = source.SortOrder,
      Description     = source.Description,
      IsActive        = 1,
      ModifiedAt      = SYSUTCDATETIME()
 WHEN NOT MATCHED THEN
      INSERT (AttendanceStatusId, StatusCode, StatusName, CountsAsPresent,
              ColorHex, SortOrder, Description)
      VALUES (source.AttendanceStatusId, source.StatusCode, source.StatusName,
              source.CountsAsPresent, source.ColorHex, source.SortOrder, source.Description);
GO

/* -------------------------------------------------------------------------
   2 - four regularization reasons, as a starting point.

   Only when the table is empty. Unlike the statuses above this list is
   HR's: once they have edited it, re-running this must not reinstate a
   reason they removed or overwrite a wording they changed.
   ------------------------------------------------------------------------- */

IF NOT EXISTS (SELECT 1 FROM dbo.tblRegularizationType)
BEGIN
    INSERT INTO dbo.tblRegularizationType (Name, Description) VALUES
        (N'Missing check-in',  N'Forgot to check in, or the check-in did not register.'),
        (N'Missing check-out', N'Forgot to check out, or the check-out did not register.'),
        (N'Late arrival',      N'Arrived late for a reason that was agreed.'),
        (N'Early exit',        N'Left early for a reason that was agreed.');
END;
GO

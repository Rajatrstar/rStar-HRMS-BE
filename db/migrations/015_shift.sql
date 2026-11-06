/*
  Shifts, their week-off patterns, and who works which one.

  docs/ATTENDANCE-LEAVE.html section 18. Two shifts to begin with - 09:00-18:00
  and 15:00-00:00 - defined per location, because the requirement is
  "shifts (location wise)" and the two offices do not keep the same hours.

  THE ONE IDEA THAT SHAPES ALL THREE TABLES: a shift is EFFECTIVE-DATED.

  A shift's timings are not edited in place. Changing 09:00 to 09:30 writes a
  new row with a new EffectiveFrom and closes the old one, because last
  month's attendance was judged against last month's timings. Edit in place
  and every "late" mark in the archive quietly re-computes the next time
  anybody opens a report - which is how an employee's record of punctuality
  changes without anybody touching it.

  The same reasoning applies to tblEmployeeShift: moving somebody from the
  general shift to the evening shift on 1 March must not make February look
  like they arrived six hours early every day.

  NO OVERLAP IS ENFORCED IN THE SERVICE, NOT HERE. Two live rows for the same
  employee with overlapping date ranges is the error worth catching, and SQL
  Server has no constraint that expresses "no overlapping ranges" without a
  trigger. A trigger that silently rejects a save is harder to debug than a
  service check that returns a 409 naming the row it clashes with, so
  src/services/shift.service.js owns that rule.

  Note for hand-written queries: these tables carry filtered indexes, so SQL
  Server refuses INSERT/UPDATE/DELETE unless QUOTED_IDENTIFIER is ON. The
  driver and SSMS set it ON already; sqlcmd does not, so run sqlcmd with -I.
*/

/* -------------------------------------------------------------------------
   The shift itself.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblShift', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblShift (
        ShiftId           BIGINT        IDENTITY(1,1) NOT NULL,

        -- Short, human, and what appears on the attendance grid: GEN, EVE.
        ShiftCode         NVARCHAR(20)  NOT NULL,
        ShiftName         NVARCHAR(100) NOT NULL,

        /*
          NULL means every location. The company-wide default shift is one
          row with no location, and a site that keeps different hours gets
          its own row - rather than one row per location duplicating the
          same two timings and drifting apart.
        */
        LocationId        BIGINT        NULL,

        -- TIME(0): seconds are noise in a shift definition, and TIME(7)
        -- would invite a comparison that fails on a stray millisecond.
        StartTime         TIME(0)       NOT NULL,
        EndTime           TIME(0)       NOT NULL,

        /*
          The evening shift ends at 00:00, which is BEFORE its start time on
          the clock. Every duration calculation has to know that, and
          deriving it each time is the bug that makes a night shift come out
          as minus fifteen hours worked.

          The CHECK makes the flag and the times agree: it cannot be 0 when
          the end is at or before the start, and it cannot be 1 when the
          shift plainly ends the same day.
        */
        CrossesMidnight   BIT           NOT NULL
            CONSTRAINT DF_tblShift_CrossesMidnight DEFAULT 0,

        -- Unpaid. Deducted from worked minutes by the nightly close.
        BreakMinutes      INT           NOT NULL
            CONSTRAINT DF_tblShift_BreakMinutes DEFAULT 60,

        /*
          Grace. "Late" begins after GraceInMinutes past StartTime, not at
          StartTime - the requirement is a nine o'clock shift, not a
          nine-o'clock-exactly shift, and traffic exists.
        */
        GraceInMinutes    INT           NOT NULL
            CONSTRAINT DF_tblShift_GraceInMinutes  DEFAULT 15,
        GraceOutMinutes   INT           NOT NULL
            CONSTRAINT DF_tblShift_GraceOutMinutes DEFAULT 15,

        /*
          What the nightly close compares worked minutes against. Stored per
          shift rather than computed from Start/End minus break, because a
          part-day shift may count a full day on fewer hours and that is a
          policy decision, not arithmetic.
        */
        FullDayMinutes    INT           NOT NULL
            CONSTRAINT DF_tblShift_FullDayMinutes DEFAULT 480,
        HalfDayMinutes    INT           NOT NULL
            CONSTRAINT DF_tblShift_HalfDayMinutes DEFAULT 240,

        -- The effective-dated pair. EffectiveTo NULL means "still current".
        EffectiveFrom     DATE          NOT NULL,
        EffectiveTo       DATE          NULL,

        IsActive          BIT           NOT NULL
            CONSTRAINT DF_tblShift_IsActive DEFAULT 1,

        CreatedBy         BIGINT        NULL,
        ModifiedBy        BIGINT        NULL,
        CreatedAt         DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblShift_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt        DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblShift_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt         DATETIME2(3)  NULL,

        CONSTRAINT PK_tblShift PRIMARY KEY CLUSTERED (ShiftId),

        CONSTRAINT FK_tblShift_Location
            FOREIGN KEY (LocationId)
            REFERENCES dbo.tblOrganizationLocation (LocationId),
        CONSTRAINT FK_tblShift_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblShift_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblShift_CrossesMidnight
            CHECK (CrossesMidnight = CASE WHEN EndTime <= StartTime THEN 1 ELSE 0 END),
        CONSTRAINT CK_tblShift_Minutes
            CHECK (BreakMinutes >= 0 AND GraceInMinutes >= 0 AND GraceOutMinutes >= 0
               AND FullDayMinutes > 0 AND HalfDayMinutes > 0
               AND HalfDayMinutes <= FullDayMinutes),
        CONSTRAINT CK_tblShift_EffectiveRange
            CHECK (EffectiveTo IS NULL OR EffectiveTo >= EffectiveFrom)
    );

    /*
      The code identifies the shift, but the same shift revised next year is
      a SECOND row with the same code - so the uniqueness is on the code and
      the date it takes effect, not on the code alone.
    */
    CREATE UNIQUE INDEX UQ_tblShift_Code_EffectiveFrom
        ON dbo.tblShift (ShiftCode, EffectiveFrom) WHERE DeletedAt IS NULL;

    -- "Which shifts apply at this location on this date" - the lookup every
    -- punch and every nightly close performs.
    CREATE INDEX IX_tblShift_Location_Effective
        ON dbo.tblShift (LocationId, EffectiveFrom, EffectiveTo)
        WHERE DeletedAt IS NULL AND IsActive = 1;
END;
GO

/* -------------------------------------------------------------------------
   Week offs.

   A separate table rather than seven bit columns on tblShift, because the
   real requirement is not "which days are off" but "which days are off in
   WHICH WEEK" - alternate-Saturday working is two rows (weeks 2 and 4), and
   seven bits cannot say that at all.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblShiftWeekOff', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblShiftWeekOff (
        ShiftWeekOffId  BIGINT        IDENTITY(1,1) NOT NULL,

        ShiftId         BIGINT        NOT NULL,

        -- 1 = Sunday ... 7 = Saturday. Matches T-SQL DATEPART(WEEKDAY) under
        -- the default DATEFIRST of 7 (US English), which is what the server
        -- runs; the service passes the number rather than relying on the
        -- session setting.
        DayOfWeek       TINYINT       NOT NULL,

        /*
          NULL means every week - a plain Sunday off. 1-5 pins it to the
          nth occurrence of that weekday in the month, which is how
          "2nd and 4th Saturday" is expressed: two rows, weeks 2 and 4.
        */
        WeekOfMonth     TINYINT       NULL,

        CreatedBy       BIGINT        NULL,
        ModifiedBy      BIGINT        NULL,
        CreatedAt       DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblShiftWeekOff_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt      DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblShiftWeekOff_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt       DATETIME2(3)  NULL,

        CONSTRAINT PK_tblShiftWeekOff PRIMARY KEY CLUSTERED (ShiftWeekOffId),

        CONSTRAINT FK_tblShiftWeekOff_Shift
            FOREIGN KEY (ShiftId) REFERENCES dbo.tblShift (ShiftId),
        CONSTRAINT FK_tblShiftWeekOff_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblShiftWeekOff_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblShiftWeekOff_DayOfWeek
            CHECK (DayOfWeek BETWEEN 1 AND 7),
        CONSTRAINT CK_tblShiftWeekOff_WeekOfMonth
            CHECK (WeekOfMonth IS NULL OR WeekOfMonth BETWEEN 1 AND 5)
    );

    /*
      One rule per (shift, day, week). Filtered on DeletedAt so a week-off
      that was removed and later restored does not collide with its own
      tombstone.

      WeekOfMonth is nullable and SQL Server treats NULLs as equal in a
      unique index, so "Sunday, every week" can still only be declared once.
    */
    CREATE UNIQUE INDEX UQ_tblShiftWeekOff_Shift_Day_Week
        ON dbo.tblShiftWeekOff (ShiftId, DayOfWeek, WeekOfMonth)
        WHERE DeletedAt IS NULL;
END;
GO

/* -------------------------------------------------------------------------
   Who works which shift, and from when.
   ------------------------------------------------------------------------- */

IF OBJECT_ID('dbo.tblEmployeeShift', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblEmployeeShift (
        EmployeeShiftId  BIGINT        IDENTITY(1,1) NOT NULL,

        EmployeeDetailId BIGINT        NOT NULL,
        ShiftId          BIGINT        NOT NULL,

        EffectiveFrom    DATE          NOT NULL,
        EffectiveTo      DATE          NULL,

        CreatedBy        BIGINT        NULL,
        ModifiedBy       BIGINT        NULL,
        CreatedAt        DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblEmployeeShift_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt       DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblEmployeeShift_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt        DATETIME2(3)  NULL,

        CONSTRAINT PK_tblEmployeeShift PRIMARY KEY CLUSTERED (EmployeeShiftId),

        CONSTRAINT FK_tblEmployeeShift_Employee
            FOREIGN KEY (EmployeeDetailId)
            REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeShift_Shift
            FOREIGN KEY (ShiftId) REFERENCES dbo.tblShift (ShiftId),
        CONSTRAINT FK_tblEmployeeShift_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeShift_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblEmployeeShift_EffectiveRange
            CHECK (EffectiveTo IS NULL OR EffectiveTo >= EffectiveFrom)
    );

    /*
      Two assignments cannot start on the same day for one employee, which is
      the half of "no overlap" an index can actually express. The rest -
      ranges that overlap without sharing a start date - is checked in
      src/services/shift.service.js, where the 409 can name the clashing row.
    */
    CREATE UNIQUE INDEX UQ_tblEmployeeShift_Employee_EffectiveFrom
        ON dbo.tblEmployeeShift (EmployeeDetailId, EffectiveFrom)
        WHERE DeletedAt IS NULL;

    -- "Which shift was this person on, on this date" - resolved on every
    -- punch and for every row the nightly close touches.
    CREATE INDEX IX_tblEmployeeShift_Employee_Effective
        ON dbo.tblEmployeeShift (EmployeeDetailId, EffectiveFrom DESC, EffectiveTo)
        INCLUDE (ShiftId)
        WHERE DeletedAt IS NULL;

    -- The reverse: "who is on this shift", for the assignment screen and for
    -- the guard that refuses to delete a shift somebody still works.
    CREATE INDEX IX_tblEmployeeShift_Shift
        ON dbo.tblEmployeeShift (ShiftId) WHERE DeletedAt IS NULL;
END;
GO

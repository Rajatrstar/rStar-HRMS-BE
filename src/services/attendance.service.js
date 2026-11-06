/**
 * Attendance: punching, the calendar, the team grid, exemptions and alert
 * settings.
 *
 * THE DAY IS THE SPINE. Every write here goes through ensureDay(), which
 * upserts the one tblAttendanceDay row for an employee and a date and lets
 * the unique index settle any race. recomputeDay() then reads the punches
 * and writes the ANSWER - worked minutes, lateness, status. Nothing else
 * writes those three columns, so there is one place where a day's verdict
 * is decided and one place to look when it is wrong.
 *
 * PUNCHES ARE NEVER EDITED. A correction goes through
 * regularization.service.js, which keeps the original and names the
 * approver. That is the difference between an attendance system and a
 * spreadsheet, and it is why this file has no updatePunch().
 */
import { query, queryOne, mutate } from '../helpers/query.helper.js';
import {
  AttendanceDay,
  AttendancePunch,
  AttendanceStatus,
  AttendanceExemption,
  AttendanceAlertSetting,
  EmployeeDetails,
  LeaveRequest,
  LeaveRequestDay,
  ATTENDANCE_DAY_PUBLIC_PROPS,
  ATTENDANCE_PUNCH_PUBLIC_PROPS,
  ATTENDANCE_EXEMPTION_PUBLIC_PROPS,
  ATTENDANCE_ALERT_SETTING_PUBLIC_PROPS,
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import {
  MESSAGES,
  ERROR_CODE,
  ATTENDANCE_STATUS,
  ATTENDANCE_STATUS_CATALOG,
  PUNCH_TYPE,
  PUNCH_SOURCE,
  LEAVE_REQUEST_STATUS,
  DAY_PART,
} from '../enums/index.js';
import {
  today,
  dateOf,
  addDays,
  eachDate,
  daysBetween,
  attendanceDateFor,
  minutesOfDay,
  formatTime,
  toSqlTime,
  isWithin,
} from '../helpers/date.helper.js';
import { resolveShift, isWeekOff } from './shift.service.js';
import { holidayMapFor, approvedRestrictedMapFor } from './holiday.service.js';

const DAY_COLUMNS = AttendanceDay.select(ATTENDANCE_DAY_PUBLIC_PROPS);
const OUTPUT_DAY = ATTENDANCE_DAY_PUBLIC_PROPS.map(
  (p) => `inserted.${AttendanceDay.col(p)} AS ${p}`,
).join(', ');

/** The widest range any endpoint will serve. A year of a calendar, at most. */
const MAX_RANGE_DAYS = 366;

const ID_PROPS = Object.freeze([
  'attendanceDayId',
  'employeeDetailId',
  'shiftId',
  'holidayId',
  'leaveRequestId',
  'punchId',
  'attendanceExemptionId',
  'attendanceAlertSettingId',
  'locationId',
  'grantedBy',
]);

function shape(row) {
  if (!row) return row;

  const copy = { ...row };
  for (const prop of ID_PROPS) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  // A DATE from the driver is a Date; clients want the calendar string.
  if (copy.attendanceDate !== undefined && copy.attendanceDate !== null) {
    copy.attendanceDate = dateOf(copy.attendanceDate);
  }
  if (copy.sweepTime !== undefined) copy.sweepTime = formatTime(copy.sweepTime);

  return copy;
}

const shapeAll = (rows) => rows.map(shape);

/** Rejects a range that runs backwards or is too wide to serve in one go. */
function assertRange(fromDate, toDate) {
  if (toDate < fromDate) {
    throw ApiError.badRequest(MESSAGES.ATTENDANCE_DATE_RANGE, {
      code: ERROR_CODE.INVALID_DATE_RANGE,
    });
  }
  if (daysBetween(fromDate, toDate) + 1 > MAX_RANGE_DAYS) {
    throw ApiError.badRequest(MESSAGES.ATTENDANCE_RANGE_TOO_WIDE, {
      code: ERROR_CODE.DATE_RANGE_TOO_WIDE,
      maxDays: MAX_RANGE_DAYS,
    });
  }
}

/** The employee facts attendance needs: their location and their manager. */
async function loadEmployee(employeeDetailId) {
  const row = await queryOne(
    `SELECT EmployeeDetailId AS employeeDetailId,
            WorkLocationId   AS workLocationId,
            ManagerId        AS managerId,
            FirstName        AS firstName,
            LastName         AS lastName,
            WorkEmail        AS workEmail
       FROM ${EmployeeDetails.table}
      WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL AND IsActive = 1`,
    EmployeeDetails.params({ employeeDetailId }),
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.EMPLOYEE_NOT_FOUND, { code: ERROR_CODE.EMPLOYEE_NOT_FOUND });
  }
  return shape(row);
}

/* -------------------------------------------------------------------------
   The status catalog
   ------------------------------------------------------------------------- */

/** Served so the frontend's legend and colours come from one place. */
export async function listStatuses() {
  const rows = await query(
    `SELECT ${AttendanceStatus.select([
      'attendanceStatusId',
      'statusCode',
      'statusName',
      'description',
      'countsAsPresent',
      'colorHex',
      'sortOrder',
    ])}
       FROM ${AttendanceStatus.table} WHERE IsActive = 1 ORDER BY SortOrder`,
  );
  // Falls back to the enum when the table has not been seeded yet, so a
  // fresh database still serves a usable legend rather than an empty one.
  return rows.length ? rows : ATTENDANCE_STATUS_CATALOG;
}

/* -------------------------------------------------------------------------
   Exemptions - "present by default"
   ------------------------------------------------------------------------- */

/** Is this person exempt from punching on this date? */
export async function isExempt(employeeDetailId, onDate) {
  const row = await queryOne(
    `SELECT TOP (1) AttendanceExemptionId AS attendanceExemptionId
       FROM ${AttendanceExemption.table}
      WHERE EmployeeDetailId = @employeeDetailId
        AND DeletedAt IS NULL
        AND EffectiveFrom <= @onDate
        AND (EffectiveTo IS NULL OR EffectiveTo >= @onDate)`,
    {
      ...AttendanceExemption.params({ employeeDetailId }),
      onDate: AttendanceExemption.param('effectiveFrom', onDate),
    },
  );
  return row !== null;
}

export async function listExemptions({ employeeDetailId = null, onDate = null } = {}) {
  return shapeAll(
    await query(
      `SELECT ${AttendanceExemption.select(ATTENDANCE_EXEMPTION_PUBLIC_PROPS)}
         FROM ${AttendanceExemption.table}
        WHERE DeletedAt IS NULL
          AND (@employeeDetailId IS NULL OR EmployeeDetailId = @employeeDetailId)
          AND (@onDate IS NULL
               OR (EffectiveFrom <= @onDate AND (EffectiveTo IS NULL OR EffectiveTo >= @onDate)))
        ORDER BY EffectiveFrom DESC`,
      {
        ...AttendanceExemption.params({ employeeDetailId }),
        onDate: AttendanceExemption.param('effectiveFrom', onDate),
      },
    ),
  );
}

export async function createExemption(actorId, input) {
  await loadEmployee(input.employeeDetailId);

  const row = await queryOne(
    `INSERT INTO ${AttendanceExemption.table}
            (EmployeeDetailId, EffectiveFrom, EffectiveTo, Reason, GrantedBy, CreatedBy, ModifiedBy)
     OUTPUT ${ATTENDANCE_EXEMPTION_PUBLIC_PROPS.map((p) => `inserted.${AttendanceExemption.col(p)} AS ${p}`).join(', ')}
     VALUES (@employeeDetailId, @effectiveFrom, @effectiveTo, @reason, @actorId, @actorId, @actorId)`,
    {
      ...AttendanceExemption.params({
        employeeDetailId: input.employeeDetailId,
        effectiveFrom: input.effectiveFrom ?? today(),
        effectiveTo: input.effectiveTo ?? null,
        reason: input.reason,
      }),
      actorId: AttendanceExemption.param('grantedBy', actorId),
    },
  );
  return shape(row);
}

export async function updateExemption(actorId, attendanceExemptionId, input) {
  const row = await queryOne(
    `UPDATE ${AttendanceExemption.table}
        SET EffectiveFrom = COALESCE(@effectiveFrom, EffectiveFrom),
            EffectiveTo   = @effectiveTo,
            Reason        = COALESCE(@reason, Reason),
            ModifiedBy    = @actorId,
            ModifiedAt    = SYSUTCDATETIME()
      OUTPUT ${ATTENDANCE_EXEMPTION_PUBLIC_PROPS.map((p) => `inserted.${AttendanceExemption.col(p)} AS ${p}`).join(', ')}
      WHERE AttendanceExemptionId = @attendanceExemptionId AND DeletedAt IS NULL`,
    {
      ...AttendanceExemption.params({
        attendanceExemptionId,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
        reason: input.reason ?? null,
      }),
      actorId: AttendanceExemption.param('modifiedBy', actorId),
    },
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.EXEMPTION_NOT_FOUND, { code: ERROR_CODE.EXEMPTION_NOT_FOUND });
  }
  return shape(row);
}

export async function deleteExemption(actorId, attendanceExemptionId) {
  const rows = await mutate(
    `UPDATE ${AttendanceExemption.table}
        SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
      WHERE AttendanceExemptionId = @attendanceExemptionId AND DeletedAt IS NULL`,
    {
      ...AttendanceExemption.params({ attendanceExemptionId }),
      actorId: AttendanceExemption.param('modifiedBy', actorId),
    },
  );
  if (rows === 0) {
    throw ApiError.notFound(MESSAGES.EXEMPTION_NOT_FOUND, { code: ERROR_CODE.EXEMPTION_NOT_FOUND });
  }
  return { attendanceExemptionId: Number(attendanceExemptionId) };
}

/* -------------------------------------------------------------------------
   Alert settings
   ------------------------------------------------------------------------- */

export async function listAlertSettings() {
  return shapeAll(
    await query(
      `SELECT ${AttendanceAlertSetting.select(ATTENDANCE_ALERT_SETTING_PUBLIC_PROPS)}
         FROM ${AttendanceAlertSetting.table}
        WHERE DeletedAt IS NULL ORDER BY LocationId, AlertType`,
    ),
  );
}

/**
 * The setting in force for a location, falling back to the organisation
 * default - the same most-specific-wins shape as the shift fallback.
 *
 * Returns null when nothing is configured at all, and callers treat that as
 * "do not alert". A hard-coded default here would mean an alert cadence
 * nobody chose firing at people, which is worse than silence.
 */
export async function alertSettingFor(locationId, alertType) {
  const row = await queryOne(
    `SELECT TOP (1) ${AttendanceAlertSetting.select(ATTENDANCE_ALERT_SETTING_PUBLIC_PROPS)}
       FROM ${AttendanceAlertSetting.table}
      WHERE DeletedAt IS NULL AND IsActive = 1
        AND AlertType = @alertType
        AND (LocationId = @locationId OR LocationId IS NULL)
      ORDER BY CASE WHEN LocationId IS NULL THEN 1 ELSE 0 END`,
    AttendanceAlertSetting.params({ locationId, alertType }),
  );
  return shape(row);
}

export async function createAlertSetting(actorId, input) {
  try {
    const row = await queryOne(
      `INSERT INTO ${AttendanceAlertSetting.table}
              (LocationId, AlertType, DelayMinutes, IntervalMinutes, WindowMinutes, SweepTime,
               SkipWhenOnLeave, SkipOnHoliday, SkipWhenExempt, NotifyManagerAfter,
               CreatedBy, ModifiedBy)
       OUTPUT ${ATTENDANCE_ALERT_SETTING_PUBLIC_PROPS.map((p) => `inserted.${AttendanceAlertSetting.col(p)} AS ${p}`).join(', ')}
       VALUES (@locationId, @alertType, @delayMinutes, @intervalMinutes, @windowMinutes, @sweepTime,
               @skipWhenOnLeave, @skipOnHoliday, @skipWhenExempt, @notifyManagerAfter,
               @actorId, @actorId)`,
      {
        ...AttendanceAlertSetting.params({
          locationId: input.locationId ?? null,
          alertType: input.alertType,
          delayMinutes: input.delayMinutes ?? 9,
          intervalMinutes: input.intervalMinutes ?? 10,
          windowMinutes: input.windowMinutes ?? 120,
          // A TIME column: the driver needs a Date, not "HH:mm".
          sweepTime: toSqlTime(input.sweepTime ?? null),
          skipWhenOnLeave: input.skipWhenOnLeave ?? true,
          skipOnHoliday: input.skipOnHoliday ?? true,
          skipWhenExempt: input.skipWhenExempt ?? true,
          notifyManagerAfter: input.notifyManagerAfter ?? null,
        }),
        actorId: AttendanceAlertSetting.param('createdBy', actorId),
      },
    );
    return shape(row);
  } catch (error) {
    if (error?.number === 2601 || error?.number === 2627) {
      throw ApiError.conflict(MESSAGES.ALERT_SETTING_EXISTS, {
        code: ERROR_CODE.ALERT_SETTING_EXISTS,
      });
    }
    throw error;
  }
}

export async function updateAlertSetting(actorId, attendanceAlertSettingId, input) {
  const row = await queryOne(
    `UPDATE ${AttendanceAlertSetting.table}
        SET DelayMinutes       = COALESCE(@delayMinutes, DelayMinutes),
            IntervalMinutes    = COALESCE(@intervalMinutes, IntervalMinutes),
            WindowMinutes      = COALESCE(@windowMinutes, WindowMinutes),
            SweepTime          = @sweepTime,
            SkipWhenOnLeave    = COALESCE(@skipWhenOnLeave, SkipWhenOnLeave),
            SkipOnHoliday      = COALESCE(@skipOnHoliday, SkipOnHoliday),
            SkipWhenExempt     = COALESCE(@skipWhenExempt, SkipWhenExempt),
            NotifyManagerAfter = @notifyManagerAfter,
            IsActive           = COALESCE(@isActive, IsActive),
            ModifiedBy         = @actorId,
            ModifiedAt         = SYSUTCDATETIME()
      OUTPUT ${ATTENDANCE_ALERT_SETTING_PUBLIC_PROPS.map((p) => `inserted.${AttendanceAlertSetting.col(p)} AS ${p}`).join(', ')}
      WHERE AttendanceAlertSettingId = @attendanceAlertSettingId AND DeletedAt IS NULL`,
    {
      ...AttendanceAlertSetting.params({
        attendanceAlertSettingId,
        delayMinutes: input.delayMinutes ?? null,
        intervalMinutes: input.intervalMinutes ?? null,
        windowMinutes: input.windowMinutes ?? null,
        sweepTime: toSqlTime(input.sweepTime ?? null),
        skipWhenOnLeave: input.skipWhenOnLeave ?? null,
        skipOnHoliday: input.skipOnHoliday ?? null,
        skipWhenExempt: input.skipWhenExempt ?? null,
        notifyManagerAfter: input.notifyManagerAfter ?? null,
        isActive: input.isActive ?? null,
      }),
      actorId: AttendanceAlertSetting.param('modifiedBy', actorId),
    },
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.ALERT_SETTING_NOT_FOUND, {
      code: ERROR_CODE.ALERT_SETTING_NOT_FOUND,
    });
  }
  return shape(row);
}

export async function deleteAlertSetting(actorId, attendanceAlertSettingId) {
  const rows = await mutate(
    `UPDATE ${AttendanceAlertSetting.table}
        SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
      WHERE AttendanceAlertSettingId = @attendanceAlertSettingId AND DeletedAt IS NULL`,
    {
      ...AttendanceAlertSetting.params({ attendanceAlertSettingId }),
      actorId: AttendanceAlertSetting.param('modifiedBy', actorId),
    },
  );
  if (rows === 0) {
    throw ApiError.notFound(MESSAGES.ALERT_SETTING_NOT_FOUND, {
      code: ERROR_CODE.ALERT_SETTING_NOT_FOUND,
    });
  }
  return { attendanceAlertSettingId: Number(attendanceAlertSettingId) };
}

/* -------------------------------------------------------------------------
   The day
   ------------------------------------------------------------------------- */

/**
 * Get or create the one row for an employee and a date.
 *
 * MERGE rather than SELECT-then-INSERT: two punches arriving together, or a
 * punch racing the auto-mark job, would both see no row and both insert.
 * HOLDLOCK makes the match and the insert one atomic step, and the unique
 * index is the backstop if it still loses.
 */
async function ensureDay(employeeDetailId, attendanceDate, { shiftId = null, actorId = null } = {}) {
  const row = await queryOne(
    `MERGE ${AttendanceDay.table} WITH (HOLDLOCK) AS target
     USING (SELECT @employeeDetailId AS EmployeeDetailId, @attendanceDate AS AttendanceDate)
        AS source
        ON target.EmployeeDetailId = source.EmployeeDetailId
       AND target.AttendanceDate   = source.AttendanceDate
       AND target.DeletedAt IS NULL
      WHEN MATCHED THEN UPDATE SET
           -- Fills the shift in if the row was created before one was known,
           -- and never overwrites one that is already set.
           ShiftId = COALESCE(target.ShiftId, @shiftId)
      WHEN NOT MATCHED THEN INSERT
           (EmployeeDetailId, AttendanceDate, ShiftId, AttendanceStatusId, CreatedBy, ModifiedBy)
      VALUES (@employeeDetailId, @attendanceDate, @shiftId, @absent, @actorId, @actorId)
      OUTPUT ${OUTPUT_DAY};`,
    {
      ...AttendanceDay.params({ employeeDetailId, attendanceDate, shiftId }),
      // Created as ABSENT and corrected by recomputeDay in the same request.
      // Absent is the safe starting point: a row that fails half way through
      // is then visible on the exception list rather than silently present.
      absent: AttendanceDay.param('attendanceStatusId', ATTENDANCE_STATUS.ABSENT),
      actorId: AttendanceDay.param('createdBy', actorId),
    },
  );
  return shape(row);
}

/**
 * Every punch of one day, in order.
 *
 * Shaped like everything else: BIGINT arrives from the driver as a string,
 * so without this a punch would carry `"punchId": "1"` while the day beside
 * it carried `"attendanceDayId": 1`. One response, two types for the same
 * kind of value, and a client comparing `punch.attendanceDayId === day.attendanceDayId`
 * would silently get false.
 */
async function punchesOf(attendanceDayId) {
  return shapeAll(
    await query(
      `SELECT ${AttendancePunch.select(ATTENDANCE_PUNCH_PUBLIC_PROPS)}
         FROM ${AttendancePunch.table}
        WHERE AttendanceDayId = @attendanceDayId
        ORDER BY PunchAt`,
      AttendancePunch.params({ attendanceDayId }),
    ),
  );
}

/**
 * Worked minutes from a list of punches.
 *
 * Pairs each IN with the next OUT. Unpaired punches are ignored rather than
 * guessed at - somebody who checked in twice and out once has one complete
 * session and one open one, and inventing a close for the open one would
 * invent hours nobody worked. The open session is what makes the day
 * MISSING_PUNCH, which is a question for a human.
 */
function workedMinutesFrom(punches) {
  let total = 0;
  let openAt = null;
  let unpaired = false;

  for (const punch of punches) {
    const at = punch.punchAt instanceof Date ? punch.punchAt : new Date(punch.punchAt);

    if (punch.punchType === PUNCH_TYPE.IN) {
      // A second IN without an OUT: the first one is dangling.
      if (openAt !== null) unpaired = true;
      openAt = at;
    } else if (openAt !== null) {
      total += Math.max(0, Math.round((at.getTime() - openAt.getTime()) / 60_000));
      openAt = null;
    } else {
      // An OUT with nothing open.
      unpaired = true;
    }
  }

  return { totalMinutes: total, openSession: openAt !== null, unpaired };
}

/**
 * Re-read a day's punches and write the verdict.
 *
 * THE ONLY WRITER of WorkedMinutes, LateMinutes, EarlyOutMinutes and - for
 * a day with punches - AttendanceStatusId. Called after every punch and by
 * the nightly close.
 *
 * It does NOT overwrite a day that is on leave, a holiday or a week off.
 * Somebody who comes in for an hour on a public holiday has not turned the
 * holiday into a working day; that hour is evidence for a comp-off request,
 * which is a different conversation.
 */
export async function recomputeDay(attendanceDayId, { shift = null } = {}) {
  const day = shape(
    await queryOne(
      `SELECT ${DAY_COLUMNS} FROM ${AttendanceDay.table}
        WHERE AttendanceDayId = @attendanceDayId AND DeletedAt IS NULL`,
      AttendanceDay.params({ attendanceDayId }),
    ),
  );
  if (!day) return null;

  // A non-working day keeps its status whatever the punches say.
  const protectedStatuses = [
    ATTENDANCE_STATUS.ON_LEAVE,
    ATTENDANCE_STATUS.HOLIDAY,
    ATTENDANCE_STATUS.WEEK_OFF,
  ];
  if (protectedStatuses.includes(Number(day.attendanceStatusId))) return day;

  const punches = await punchesOf(attendanceDayId);
  if (punches.length === 0) return day;

  const resolved =
    shift ??
    (await resolveShift(day.employeeDetailId, day.attendanceDate, {
      workLocationId: (await loadEmployee(day.employeeDetailId)).workLocationId,
    }));

  const { totalMinutes, openSession, unpaired } = workedMinutesFrom(punches);

  const ins = punches.filter((p) => p.punchType === PUNCH_TYPE.IN);
  const outs = punches.filter((p) => p.punchType === PUNCH_TYPE.OUT);
  const firstIn = ins.length ? ins[0].punchAt : null;
  const lastOut = outs.length ? outs[outs.length - 1].punchAt : null;

  // Net of the unpaid break, and never below zero.
  const workedMinutes = Math.max(0, totalMinutes - (resolved?.breakMinutes ?? 0));

  let lateMinutes = null;
  let earlyOutMinutes = null;

  if (resolved && firstIn) {
    const inAt = firstIn instanceof Date ? firstIn : new Date(firstIn);
    const inMinutes = inAt.getUTCHours() * 60 + inAt.getUTCMinutes();
    // Late begins AFTER the grace period, not at the shift's start time.
    const allowed = minutesOfDay(resolved.startTime) + resolved.graceInMinutes;
    lateMinutes = Math.max(0, inMinutes - allowed);
  }

  if (resolved && lastOut && !resolved.crossesMidnight) {
    const outAt = lastOut instanceof Date ? lastOut : new Date(lastOut);
    const outMinutes = outAt.getUTCHours() * 60 + outAt.getUTCMinutes();
    const allowed = minutesOfDay(resolved.endTime) - resolved.graceOutMinutes;
    earlyOutMinutes = Math.max(0, allowed - outMinutes);
  }

  let statusId;
  if (openSession || unpaired) {
    // An open session is not an absence and not a present day. It is a
    // question, and MISSING_PUNCH is what puts it on somebody's list.
    statusId = ATTENDANCE_STATUS.MISSING_PUNCH;
  } else if (resolved && workedMinutes >= resolved.fullDayMinutes) {
    statusId = lateMinutes > 0 ? ATTENDANCE_STATUS.LATE : ATTENDANCE_STATUS.PRESENT;
  } else if (resolved && workedMinutes >= resolved.halfDayMinutes) {
    statusId = ATTENDANCE_STATUS.HALF_DAY;
  } else if (!resolved) {
    // No shift to judge against: record the punches, claim nothing.
    statusId = ATTENDANCE_STATUS.PRESENT;
  } else {
    statusId = ATTENDANCE_STATUS.ABSENT;
  }

  // A regularized day keeps its badge - the correction is the reason the
  // numbers look the way they do, and losing it would hide the audit trail.
  if (day.isRegularized) statusId = ATTENDANCE_STATUS.REGULARIZED;

  const updated = await queryOne(
    `UPDATE ${AttendanceDay.table}
        SET FirstCheckInAt     = @firstCheckInAt,
            LastCheckOutAt     = @lastCheckOutAt,
            WorkedMinutes      = @workedMinutes,
            LateMinutes        = @lateMinutes,
            EarlyOutMinutes    = @earlyOutMinutes,
            AttendanceStatusId = @attendanceStatusId,
            ShiftId            = COALESCE(ShiftId, @shiftId),
            ModifiedAt         = SYSUTCDATETIME()
      OUTPUT ${OUTPUT_DAY}
      WHERE AttendanceDayId = @attendanceDayId AND DeletedAt IS NULL`,
    AttendanceDay.params({
      attendanceDayId,
      firstCheckInAt: firstIn,
      lastCheckOutAt: lastOut,
      workedMinutes,
      lateMinutes,
      earlyOutMinutes,
      attendanceStatusId: statusId,
      shiftId: resolved?.shiftId ?? null,
    }),
  );
  return shape(updated);
}

/* -------------------------------------------------------------------------
   Punching
   ------------------------------------------------------------------------- */

/**
 * The shared half of check-in and check-out.
 *
 * THE MIDNIGHT RULE LIVES HERE. attendanceDateFor() decides which day the
 * punch attaches to using the shift in force, and the decision is then
 * FROZEN as the punch's AttendanceDayId - never re-derived later by code
 * that would have to guess which shift applied at the time.
 */
async function recordPunch(employeeDetailId, punchType, { at, source, ipAddress, userAgent, remarks, actorId }) {
  const punchAt = at ?? new Date();

  if (punchAt.getTime() > Date.now() + 60_000) {
    // A minute of slack for a clock that is slightly ahead; beyond that, a
    // punch in the future is a client bug or somebody gaming the clock.
    throw ApiError.badRequest(MESSAGES.PUNCH_IN_FUTURE, { code: ERROR_CODE.PUNCH_IN_FUTURE });
  }

  const employee = await loadEmployee(employeeDetailId);
  const calendarDate = dateOf(punchAt);

  // Resolved against the calendar date first, because the shift is what
  // tells us whether the punch actually belongs to the day before.
  const shift = await resolveShift(employeeDetailId, calendarDate, {
    workLocationId: employee.workLocationId,
  });
  const attendanceDate = attendanceDateFor(punchAt, shift);

  const day = await ensureDay(employeeDetailId, attendanceDate, {
    shiftId: shift?.shiftId ?? null,
    actorId,
  });

  const existing = await punchesOf(day.attendanceDayId);
  const { openSession } = workedMinutesFrom(existing);

  // The two states a client can get wrong, answered before anything is
  // written: checking in twice, or out without being in.
  if (punchType === PUNCH_TYPE.IN && openSession) {
    throw ApiError.conflict(MESSAGES.ALREADY_CHECKED_IN, { code: ERROR_CODE.ALREADY_CHECKED_IN });
  }
  if (punchType === PUNCH_TYPE.OUT && !openSession) {
    throw ApiError.badRequest(MESSAGES.NOT_CHECKED_IN, { code: ERROR_CODE.NOT_CHECKED_IN });
  }

  await mutate(
    `INSERT INTO ${AttendancePunch.table}
            (AttendanceDayId, PunchType, PunchAt, Source, IpAddress, UserAgent, Remarks, CreatedBy)
     VALUES (@attendanceDayId, @punchType, @punchAt, @source, @ipAddress, @userAgent, @remarks, @actorId)`,
    {
      ...AttendancePunch.params({
        attendanceDayId: day.attendanceDayId,
        punchType,
        punchAt,
        source: source ?? PUNCH_SOURCE.WEB,
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ? String(userAgent).slice(0, 500) : null,
        remarks: remarks ?? null,
      }),
      actorId: AttendancePunch.param('createdBy', actorId ?? employeeDetailId),
    },
  );

  const updated = await recomputeDay(day.attendanceDayId, { shift });
  return { ...updated, punches: await punchesOf(day.attendanceDayId) };
}

export function checkIn(employeeDetailId, context = {}) {
  return recordPunch(employeeDetailId, PUNCH_TYPE.IN, {
    ...context,
    actorId: context.actorId ?? employeeDetailId,
  });
}

export function checkOut(employeeDetailId, context = {}) {
  return recordPunch(employeeDetailId, PUNCH_TYPE.OUT, {
    ...context,
    actorId: context.actorId ?? employeeDetailId,
  });
}

/**
 * Today's state for the punch button: am I in, since when, what is my shift.
 *
 * `isCheckedIn` is computed from the punches rather than stored, because a
 * stored flag is a second copy of a fact the punches already hold - and the
 * two would disagree the first time a punch was written by anything but
 * this endpoint.
 */
export async function todayFor(employeeDetailId, onDate = today()) {
  const employee = await loadEmployee(employeeDetailId);
  const shift = await resolveShift(employeeDetailId, onDate, {
    workLocationId: employee.workLocationId,
  });

  const day = shape(
    await queryOne(
      `SELECT ${DAY_COLUMNS} FROM ${AttendanceDay.table}
        WHERE EmployeeDetailId = @employeeDetailId AND AttendanceDate = @attendanceDate
          AND DeletedAt IS NULL`,
      AttendanceDay.params({ employeeDetailId, attendanceDate: onDate }),
    ),
  );

  const punches = day ? await punchesOf(day.attendanceDayId) : [];
  const { openSession } = workedMinutesFrom(punches);

  return {
    attendanceDate: onDate,
    shift,
    isWeekOff: isWeekOff(shift, onDate),
    isExempt: await isExempt(employeeDetailId, onDate),
    day,
    punches,
    isCheckedIn: openSession,
    checkedInAt: openSession ? punches.filter((p) => p.punchType === PUNCH_TYPE.IN).at(-1)?.punchAt : null,
  };
}

/* -------------------------------------------------------------------------
   Calendars
   ------------------------------------------------------------------------- */

/**
 * One person's calendar for a range.
 *
 * EVERY DATE IN THE RANGE COMES BACK, including the ones with no row. A
 * calendar with gaps forces the client to decide what a missing day means -
 * and it would have to resolve shifts and holidays to decide, which is this
 * service's job. So the days without rows are filled in here from the shift
 * pattern and the holiday list, marked as derived rather than recorded.
 */
export async function calendarFor(employeeDetailId, fromDate, toDate) {
  assertRange(fromDate, toDate);

  const employee = await loadEmployee(employeeDetailId);

  const [rows, holidays, restricted, shift] = await Promise.all([
    query(
      `SELECT ${DAY_COLUMNS} FROM ${AttendanceDay.table}
        WHERE EmployeeDetailId = @employeeDetailId
          AND AttendanceDate BETWEEN @fromDate AND @toDate
          AND DeletedAt IS NULL
        ORDER BY AttendanceDate`,
      {
        ...AttendanceDay.params({ employeeDetailId }),
        fromDate: AttendanceDay.param('attendanceDate', fromDate),
        toDate: AttendanceDay.param('attendanceDate', toDate),
      },
    ),
    holidayMapFor(employee.workLocationId, fromDate, toDate),
    approvedRestrictedMapFor(employeeDetailId, fromDate, toDate),
    resolveShift(employeeDetailId, fromDate, { workLocationId: employee.workLocationId }),
  ]);

  const byDate = new Map(shapeAll(rows).map((row) => [row.attendanceDate, row]));

  return eachDate(fromDate, toDate).map((date) => {
    const recorded = byDate.get(date) ?? null;
    if (recorded) return { ...recorded, isRecorded: true };

    // Nothing recorded: say what the day WAS, and be explicit that this is
    // derived rather than observed.
    const holiday = holidays.get(date) ?? restricted.get(date) ?? null;
    const weekOff = isWeekOff(shift, date);

    return {
      attendanceDate: date,
      employeeDetailId: Number(employeeDetailId),
      shiftId: shift?.shiftId ?? null,
      attendanceStatusId: holiday
        ? ATTENDANCE_STATUS.HOLIDAY
        : weekOff
          ? ATTENDANCE_STATUS.WEEK_OFF
          : null,
      holidayId: holiday?.holidayId ?? null,
      holidayName: holiday?.holidayName ?? null,
      firstCheckInAt: null,
      lastCheckOutAt: null,
      workedMinutes: null,
      lateMinutes: null,
      isRecorded: false,
    };
  });
}

/** A day with its punches - the detail drawer. */
export async function dayDetail(employeeDetailId, attendanceDate) {
  const day = shape(
    await queryOne(
      `SELECT ${DAY_COLUMNS} FROM ${AttendanceDay.table}
        WHERE EmployeeDetailId = @employeeDetailId AND AttendanceDate = @attendanceDate
          AND DeletedAt IS NULL`,
      AttendanceDay.params({ employeeDetailId, attendanceDate }),
    ),
  );
  if (!day) {
    throw ApiError.notFound(MESSAGES.ATTENDANCE_DAY_NOT_FOUND, {
      code: ERROR_CODE.ATTENDANCE_DAY_NOT_FOUND,
    });
  }
  return { ...day, punches: await punchesOf(day.attendanceDayId) };
}

/** Counts by status for a range - the summary tiles. */
export async function summaryFor(employeeDetailId, fromDate, toDate) {
  assertRange(fromDate, toDate);

  const rows = await query(
    `SELECT d.AttendanceStatusId AS attendanceStatusId,
            s.StatusCode         AS statusCode,
            s.StatusName         AS statusName,
            COUNT(*)             AS dayCount,
            SUM(ISNULL(d.WorkedMinutes, 0)) AS workedMinutes,
            SUM(CASE WHEN ISNULL(d.LateMinutes, 0) > 0 THEN 1 ELSE 0 END) AS lateDays
       FROM ${AttendanceDay.table}    AS d
       JOIN ${AttendanceStatus.table} AS s ON s.AttendanceStatusId = d.AttendanceStatusId
      WHERE d.EmployeeDetailId = @employeeDetailId
        AND d.AttendanceDate BETWEEN @fromDate AND @toDate
        AND d.DeletedAt IS NULL
      GROUP BY d.AttendanceStatusId, s.StatusCode, s.StatusName
      ORDER BY s.StatusCode`,
    {
      ...AttendanceDay.params({ employeeDetailId }),
      fromDate: AttendanceDay.param('attendanceDate', fromDate),
      toDate: AttendanceDay.param('attendanceDate', toDate),
    },
  );

  return {
    fromDate,
    toDate,
    byStatus: rows,
    totalRecordedDays: rows.reduce((sum, row) => sum + row.dayCount, 0),
  };
}

/* -------------------------------------------------------------------------
   The team grid
   ------------------------------------------------------------------------- */

/**
 * One day, every employee in scope.
 *
 * `managerId` narrows to a manager's direct reports; omitting it serves the
 * whole company, which is the HR view. WHICH of the two a caller gets is
 * decided in the controller from the module right they hold - a manager
 * reaches this through TEAM_ATTENDANCE and is pinned to their own reports
 * there, so this function does not need to know about rights.
 *
 * Employees with no attendance row are INCLUDED, as a LEFT JOIN with a null
 * status. "Who has not punched yet" is the question the grid exists to
 * answer, and an inner join would silently drop exactly those people.
 */
export async function teamDay({ onDate = today(), managerId = null, locationId = null, attendanceStatusId = null } = {}) {
  const rows = await query(
    `SELECT e.EmployeeDetailId  AS employeeDetailId,
            e.EmployeeCode      AS employeeCode,
            e.FirstName         AS firstName,
            e.LastName          AS lastName,
            e.WorkLocationId    AS workLocationId,
            e.ManagerId         AS managerId,
            d.AttendanceDayId   AS attendanceDayId,
            d.AttendanceStatusId AS attendanceStatusId,
            s.StatusCode        AS statusCode,
            d.FirstCheckInAt    AS firstCheckInAt,
            d.LastCheckOutAt    AS lastCheckOutAt,
            d.WorkedMinutes     AS workedMinutes,
            d.LateMinutes       AS lateMinutes,
            d.IsDefaultPresent  AS isDefaultPresent,
            d.IsRegularized     AS isRegularized
       FROM ${EmployeeDetails.table} AS e
       LEFT JOIN ${AttendanceDay.table} AS d
         ON d.EmployeeDetailId = e.EmployeeDetailId
        AND d.AttendanceDate   = @onDate
        AND d.DeletedAt IS NULL
       LEFT JOIN ${AttendanceStatus.table} AS s
         ON s.AttendanceStatusId = d.AttendanceStatusId
      WHERE e.DeletedAt IS NULL AND e.IsActive = 1
        AND (@managerId  IS NULL OR e.ManagerId      = @managerId)
        AND (@locationId IS NULL OR e.WorkLocationId = @locationId)
        AND (@attendanceStatusId IS NULL OR d.AttendanceStatusId = @attendanceStatusId)
      ORDER BY e.FirstName, e.LastName`,
    {
      onDate: AttendanceDay.param('attendanceDate', onDate),
      managerId: EmployeeDetails.param('managerId', managerId),
      locationId: EmployeeDetails.param('workLocationId', locationId),
      attendanceStatusId: AttendanceDay.param('attendanceStatusId', attendanceStatusId),
    },
  );

  return { attendanceDate: onDate, rows: shapeAll(rows) };
}

/**
 * The morning exception list: absent, late, or missing a punch.
 *
 * Deliberately NOT "everything that is not PRESENT" - a holiday, a week off
 * and approved leave are all correct states that nobody needs to act on,
 * and including them would bury the handful of rows that do need a decision.
 */
export async function exceptionsFor({ onDate = today(), managerId = null, locationId = null } = {}) {
  const statuses = [
    ATTENDANCE_STATUS.ABSENT,
    ATTENDANCE_STATUS.LATE,
    ATTENDANCE_STATUS.MISSING_PUNCH,
    ATTENDANCE_STATUS.HALF_DAY,
  ];

  const rows = await query(
    `SELECT e.EmployeeDetailId   AS employeeDetailId,
            e.EmployeeCode       AS employeeCode,
            e.FirstName          AS firstName,
            e.LastName           AS lastName,
            e.ManagerId          AS managerId,
            d.AttendanceDayId    AS attendanceDayId,
            d.AttendanceStatusId AS attendanceStatusId,
            s.StatusCode         AS statusCode,
            d.FirstCheckInAt     AS firstCheckInAt,
            d.LastCheckOutAt     AS lastCheckOutAt,
            d.LateMinutes        AS lateMinutes,
            d.WorkedMinutes      AS workedMinutes
       FROM ${AttendanceDay.table}    AS d
       JOIN ${EmployeeDetails.table}  AS e ON e.EmployeeDetailId = d.EmployeeDetailId
       JOIN ${AttendanceStatus.table} AS s ON s.AttendanceStatusId = d.AttendanceStatusId
      WHERE d.AttendanceDate = @onDate
        AND d.DeletedAt IS NULL
        AND e.DeletedAt IS NULL AND e.IsActive = 1
        AND d.AttendanceStatusId IN (${statuses.join(', ')})
        AND (@managerId  IS NULL OR e.ManagerId      = @managerId)
        AND (@locationId IS NULL OR e.WorkLocationId = @locationId)
      ORDER BY s.SortOrder, e.FirstName`,
    {
      onDate: AttendanceDay.param('attendanceDate', onDate),
      managerId: EmployeeDetails.param('managerId', managerId),
      locationId: EmployeeDetails.param('workLocationId', locationId),
    },
  );

  return { attendanceDate: onDate, rows: shapeAll(rows) };
}

/* -------------------------------------------------------------------------
   Used by the leave module
   ------------------------------------------------------------------------- */

/**
 * Mark the days of an approved leave request as ON_LEAVE.
 *
 * Called by leave.service.js on approval. Here rather than there because
 * ensureDay() and the status rules belong to this file - the leave service
 * should not be writing attendance rows directly.
 *
 * A HALF DAY IS NOT MARKED ON_LEAVE. The employee is expected for the other
 * half and their punches must still be judged, so the day keeps whatever
 * the punch rules make of it and carries the LeaveRequestId as context.
 */
export async function markLeaveDays(employeeDetailId, leaveRequestId, days, actorId) {
  for (const day of days) {
    const existing = await ensureDay(employeeDetailId, day.leaveDate, { actorId });
    const fullDay = day.dayPart === DAY_PART.FULL;

    await mutate(
      `UPDATE ${AttendanceDay.table}
          SET LeaveRequestId     = @leaveRequestId,
              AttendanceStatusId = CASE WHEN @fullDay = 1 THEN @onLeave ELSE AttendanceStatusId END,
              ModifiedBy         = @actorId,
              ModifiedAt         = SYSUTCDATETIME()
        WHERE AttendanceDayId = @attendanceDayId AND DeletedAt IS NULL`,
      {
        ...AttendanceDay.params({
          attendanceDayId: existing.attendanceDayId,
          leaveRequestId,
          attendanceStatusId: ATTENDANCE_STATUS.ON_LEAVE,
        }),
        onLeave: AttendanceDay.param('attendanceStatusId', ATTENDANCE_STATUS.ON_LEAVE),
        fullDay: AttendanceDay.param('isDefaultPresent', fullDay),
        actorId: AttendanceDay.param('modifiedBy', actorId),
      },
    );
  }
}

/**
 * Undo the above, when an approved request is withdrawn.
 *
 * The day is handed back to recomputeDay() rather than set to a guessed
 * status: the punches, if any, are still the evidence and they are what
 * should decide.
 */
export async function unmarkLeaveDays(leaveRequestId, actorId) {
  const rows = await query(
    `UPDATE ${AttendanceDay.table}
        SET LeaveRequestId     = NULL,
            AttendanceStatusId = @absent,
            ModifiedBy         = @actorId,
            ModifiedAt         = SYSUTCDATETIME()
      OUTPUT inserted.AttendanceDayId AS attendanceDayId
      WHERE LeaveRequestId = @leaveRequestId AND DeletedAt IS NULL`,
    {
      ...AttendanceDay.params({ leaveRequestId }),
      absent: AttendanceDay.param('attendanceStatusId', ATTENDANCE_STATUS.ABSENT),
      actorId: AttendanceDay.param('modifiedBy', actorId),
    },
  );

  for (const row of rows) await recomputeDay(Number(row.attendanceDayId));
  return rows.length;
}

/** Is this person on approved leave on this date? Used by the alert sweep. */
export async function isOnApprovedLeave(employeeDetailId, onDate) {
  const row = await queryOne(
    `SELECT TOP (1) rd.LeaveRequestDayId AS id
       FROM ${LeaveRequestDay.table} AS rd
       JOIN ${LeaveRequest.table}    AS r ON r.LeaveRequestId = rd.LeaveRequestId
      WHERE r.EmployeeDetailId = @employeeDetailId
        AND rd.LeaveDate = @onDate
        AND r.Status = @approved
        AND r.DeletedAt IS NULL`,
    {
      ...LeaveRequest.params({ employeeDetailId }),
      onDate: LeaveRequestDay.param('leaveDate', onDate),
      approved: LeaveRequest.param('status', LEAVE_REQUEST_STATUS.APPROVED),
    },
  );
  return row !== null;
}

export { ensureDay, punchesOf, assertRange, loadEmployee, MAX_RANGE_DAYS };

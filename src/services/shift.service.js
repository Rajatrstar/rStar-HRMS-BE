/**
 * Shifts, their week-off patterns, and who works which one.
 *
 * TWO JOBS, and the second is why this file matters more than its CRUD
 * suggests:
 *
 *   1. Managing shift rows - the ordinary admin screens.
 *   2. Answering "WAS THIS A WORKING DAY FOR THIS PERSON?" - which the
 *      attendance close, the alert sweep, the leave charge calculation and
 *      the sandwich rule all ask, for every employee, for every date.
 *
 * isWorkingDay() is therefore the single most-called function in the
 * module, and resolveWorkingDays() exists so a date range costs one query
 * rather than one per day: a two-week leave application would otherwise be
 * fourteen round trips before it has even priced itself.
 *
 * EFFECTIVE DATING IS ENFORCED HERE, NOT BY A CONSTRAINT. SQL Server cannot
 * express "no overlapping date ranges" without a trigger, and a trigger
 * that silently rejects a save is harder to debug than a 409 naming the row
 * it clashed with. assertNoOverlap() is that check.
 */
import { query, queryOne, mutate, withTransaction } from '../helpers/query.helper.js';
import {
  Shift,
  ShiftWeekOff,
  EmployeeShift,
  SHIFT_PUBLIC_PROPS,
  SHIFT_WEEK_OFF_PUBLIC_PROPS,
  EMPLOYEE_SHIFT_PUBLIC_PROPS,
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { MESSAGES, ERROR_CODE } from '../enums/index.js';
import {
  dayOfWeek,
  weekOfMonth,
  eachDate,
  formatTime,
  toSqlTime,
  rangesOverlap,
  dateOf,
  today,
} from '../helpers/date.helper.js';

const SHIFT_COLUMNS = Shift.select(SHIFT_PUBLIC_PROPS);
const OUTPUT_SHIFT = SHIFT_PUBLIC_PROPS.map((p) => `inserted.${Shift.col(p)} AS ${p}`).join(', ');
const OUTPUT_ASSIGNMENT = EMPLOYEE_SHIFT_PUBLIC_PROPS.map(
  (p) => `inserted.${EmployeeShift.col(p)} AS ${p}`,
).join(', ');

const ID_PROPS = Object.freeze([
  'shiftId',
  'locationId',
  'shiftWeekOffId',
  'employeeShiftId',
  'employeeDetailId',
]);

/**
 * BIGINT comes back from the driver as a string, and TIME(0) comes back as
 * a Date pinned to 1970 - both would reach a client wrong. One place to fix
 * both, rather than remembering at each call site.
 */
function shape(row) {
  if (!row) return row;

  const copy = { ...row };
  for (const prop of ID_PROPS) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  // A bare timestamp would be rendered in the browser's timezone, so 09:00
  // would display as 14:30 for a value that has no timezone at all.
  if (copy.startTime !== undefined) copy.startTime = formatTime(copy.startTime);
  if (copy.endTime !== undefined) copy.endTime = formatTime(copy.endTime);

  /*
    THE EFFECTIVE DATES MUST BE STRINGS, and this is load-bearing rather
    than cosmetic.

    The driver returns a DATE as a Date object. assertNoOverlap() compares
    those values against each other and against the '9999-12-31' sentinel
    that rangesOverlap() uses for an open-ended range - and `someDate <=
    '9999-12-31'` coerces the Date to "Sun Nov 02 2036 ...", which sorts
    AFTER '9'. The comparison is therefore false for every row, the overlap
    check silently passes, and two overlapping assignments reach the
    database.

    Normalising here is what makes the guard work at all. Everything in
    this module compares calendar dates as "YYYY-MM-DD" strings for exactly
    this reason - see the header of src/helpers/date.helper.js.
  */
  for (const prop of ['effectiveFrom', 'effectiveTo']) {
    if (copy[prop]) copy[prop] = dateOf(copy[prop]);
  }

  return copy;
}

const shapeAll = (rows) => rows.map(shape);

const uniqueViolation = (error) => error?.number === 2601 || error?.number === 2627;

/* -------------------------------------------------------------------------
   Shift CRUD
   ------------------------------------------------------------------------- */

/** Every live shift. `onDate` narrows to the ones effective that day. */
export async function listShifts({ locationId = null, onDate = null, includeInactive = false } = {}) {
  return shapeAll(
    await query(
      `SELECT ${SHIFT_COLUMNS}
         FROM ${Shift.table}
        WHERE DeletedAt IS NULL
          AND (@includeInactive = 1 OR IsActive = 1)
          AND (@locationId IS NULL OR LocationId = @locationId OR LocationId IS NULL)
          AND (@onDate IS NULL
               OR (EffectiveFrom <= @onDate AND (EffectiveTo IS NULL OR EffectiveTo >= @onDate)))
        ORDER BY ShiftCode, EffectiveFrom DESC`,
      {
        ...Shift.params({ locationId, effectiveFrom: onDate }),
        onDate: Shift.param('effectiveFrom', onDate),
        includeInactive: Shift.param('isActive', includeInactive ? 1 : 0),
      },
    ),
  );
}

export async function getShift(shiftId) {
  const row = await queryOne(
    `SELECT ${SHIFT_COLUMNS} FROM ${Shift.table}
      WHERE ShiftId = @shiftId AND DeletedAt IS NULL`,
    Shift.params({ shiftId }),
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.SHIFT_NOT_FOUND, { code: ERROR_CODE.SHIFT_NOT_FOUND });
  }
  return shape(row);
}

/**
 * A shift with its week-offs attached - what the edit screen loads and what
 * the working-day calculation needs.
 */
export async function getShiftWithWeekOffs(shiftId) {
  const shift = await getShift(shiftId);
  return { ...shift, weekOffs: await listWeekOffs(shiftId) };
}

/**
 * crossesMidnight is DERIVED, never taken from the client.
 *
 * CK_tblShift_CrossesMidnight would reject a disagreeing pair anyway, but
 * with a constraint name rather than anything a user could act on - and
 * there is no decision for a client to make here: whether 15:00-00:00
 * crosses midnight is arithmetic.
 */
function crossesMidnight(startTime, endTime) {
  return endTime <= startTime;
}

export async function createShift(actorId, input) {
  try {
    const row = await queryOne(
      `INSERT INTO ${Shift.table} (
            ShiftCode, ShiftName, LocationId, StartTime, EndTime, CrossesMidnight,
            BreakMinutes, GraceInMinutes, GraceOutMinutes,
            FullDayMinutes, HalfDayMinutes, EffectiveFrom, EffectiveTo,
            CreatedBy, ModifiedBy)
       OUTPUT ${OUTPUT_SHIFT}
       VALUES (@shiftCode, @shiftName, @locationId, @startTime, @endTime, @crossesMidnight,
               @breakMinutes, @graceInMinutes, @graceOutMinutes,
               @fullDayMinutes, @halfDayMinutes, @effectiveFrom, @effectiveTo,
               @actorId, @actorId)`,
      {
        ...Shift.params({
          shiftCode: input.shiftCode,
          shiftName: input.shiftName,
          locationId: input.locationId ?? null,
          // The driver wants a Date for a TIME column, not a string.
          startTime: toSqlTime(input.startTime),
          endTime: toSqlTime(input.endTime),
          // Derived from the STRINGS, which compare correctly as "HH:mm:ss".
          crossesMidnight: crossesMidnight(input.startTime, input.endTime),
          breakMinutes: input.breakMinutes ?? 60,
          graceInMinutes: input.graceInMinutes ?? 15,
          graceOutMinutes: input.graceOutMinutes ?? 15,
          fullDayMinutes: input.fullDayMinutes ?? 480,
          halfDayMinutes: input.halfDayMinutes ?? 240,
          effectiveFrom: input.effectiveFrom ?? today(),
          effectiveTo: input.effectiveTo ?? null,
        }),
        actorId: Shift.param('createdBy', actorId),
      },
    );
    return shape(row);
  } catch (error) {
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.SHIFT_CODE_EXISTS, { code: ERROR_CODE.CODE_ALREADY_EXISTS });
    }
    throw error;
  }
}

/**
 * Edit a shift in place.
 *
 * A NOTE ON WHAT THIS IS AND IS NOT FOR. Correcting a typo in a name, or
 * closing a row with an EffectiveTo, is an edit. CHANGING THE TIMINGS OF A
 * SHIFT THAT HAS ALREADY JUDGED ATTENDANCE IS NOT - it would silently
 * re-grade every historic "late" against hours that were not in force at
 * the time. The supported way is to close this row and create a new one
 * from the date the new timings begin, which is what effective dating is
 * for and why the create form defaults EffectiveFrom to today.
 *
 * Nothing here enforces that, deliberately: a shift created this morning
 * with the wrong end time must still be fixable, and a service that could
 * not tell the two cases apart would block the common one to prevent the
 * rare one.
 */
export async function updateShift(actorId, shiftId, input) {
  const existing = await getShift(shiftId);

  const startTime = input.startTime ?? existing.startTime;
  const endTime = input.endTime ?? existing.endTime;

  try {
    const row = await queryOne(
      `UPDATE ${Shift.table}
          SET ShiftCode       = @shiftCode,
              ShiftName       = @shiftName,
              LocationId      = @locationId,
              StartTime       = @startTime,
              EndTime         = @endTime,
              CrossesMidnight = @crossesMidnight,
              BreakMinutes    = @breakMinutes,
              GraceInMinutes  = @graceInMinutes,
              GraceOutMinutes = @graceOutMinutes,
              FullDayMinutes  = @fullDayMinutes,
              HalfDayMinutes  = @halfDayMinutes,
              EffectiveFrom   = @effectiveFrom,
              EffectiveTo     = @effectiveTo,
              IsActive        = @isActive,
              ModifiedBy      = @actorId,
              ModifiedAt      = SYSUTCDATETIME()
        OUTPUT ${OUTPUT_SHIFT}
        WHERE ShiftId = @shiftId AND DeletedAt IS NULL`,
      {
        ...Shift.params({
          shiftId,
          shiftCode: input.shiftCode ?? existing.shiftCode,
          shiftName: input.shiftName ?? existing.shiftName,
          locationId: input.locationId === undefined ? existing.locationId : input.locationId,
          startTime: toSqlTime(startTime),
          endTime: toSqlTime(endTime),
          crossesMidnight: crossesMidnight(startTime, endTime),
          breakMinutes: input.breakMinutes ?? existing.breakMinutes,
          graceInMinutes: input.graceInMinutes ?? existing.graceInMinutes,
          graceOutMinutes: input.graceOutMinutes ?? existing.graceOutMinutes,
          fullDayMinutes: input.fullDayMinutes ?? existing.fullDayMinutes,
          halfDayMinutes: input.halfDayMinutes ?? existing.halfDayMinutes,
          effectiveFrom: input.effectiveFrom ?? existing.effectiveFrom,
          effectiveTo: input.effectiveTo === undefined ? existing.effectiveTo : input.effectiveTo,
          isActive: input.isActive ?? existing.isActive,
        }),
        actorId: Shift.param('modifiedBy', actorId),
      },
    );
    return shape(row);
  } catch (error) {
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.SHIFT_CODE_EXISTS, { code: ERROR_CODE.CODE_ALREADY_EXISTS });
    }
    throw error;
  }
}

/**
 * Soft delete, refused while anybody is still assigned.
 *
 * tblAttendanceDay.ShiftId points at this row for every day it ever judged,
 * so it is never hard-deleted - the grid must still be able to say which
 * shift a day was measured against.
 */
export async function deleteShift(actorId, shiftId) {
  await getShift(shiftId);

  const inUse = await queryOne(
    `SELECT TOP (1) EmployeeShiftId AS employeeShiftId
       FROM ${EmployeeShift.table}
      WHERE ShiftId = @shiftId AND DeletedAt IS NULL`,
    EmployeeShift.params({ shiftId }),
  );
  if (inUse) {
    throw ApiError.conflict(MESSAGES.SHIFT_IN_USE, { code: ERROR_CODE.SHIFT_IN_USE });
  }

  const row = await queryOne(
    `UPDATE ${Shift.table}
        SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
      OUTPUT ${OUTPUT_SHIFT}
      WHERE ShiftId = @shiftId AND DeletedAt IS NULL`,
    { ...Shift.params({ shiftId }), actorId: Shift.param('modifiedBy', actorId) },
  );
  return shape(row);
}

/* -------------------------------------------------------------------------
   Week offs
   ------------------------------------------------------------------------- */

export async function listWeekOffs(shiftId) {
  return shapeAll(
    await query(
      `SELECT ${ShiftWeekOff.select(SHIFT_WEEK_OFF_PUBLIC_PROPS)}
         FROM ${ShiftWeekOff.table}
        WHERE ShiftId = @shiftId AND DeletedAt IS NULL
        ORDER BY DayOfWeek, WeekOfMonth`,
      ShiftWeekOff.params({ shiftId }),
    ),
  );
}

/**
 * The week-off pattern is saved AS A WHOLE LIST, not row by row.
 *
 * The screen is a grid of checkboxes and the user's intent is "these are
 * the week-offs now" - expressing that as a sequence of adds and deletes
 * means the backend has to diff what it was sent against what it holds,
 * and a half-applied diff leaves a pattern nobody chose. Replacing the set
 * inside one transaction cannot half-apply.
 *
 * Soft-deleted rather than deleted, like everything else here, and the
 * unique index is filtered on DeletedAt so a pattern that is removed and
 * later restored does not collide with its own tombstone.
 */
export async function saveWeekOffs(actorId, shiftId, weekOffs) {
  await getShift(shiftId);

  await withTransaction(async (run) => {
    await run(
      `UPDATE ${ShiftWeekOff.table}
          SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE ShiftId = @shiftId AND DeletedAt IS NULL`,
      {
        ...ShiftWeekOff.params({ shiftId }),
        actorId: ShiftWeekOff.param('modifiedBy', actorId),
      },
    );

    for (const weekOff of weekOffs) {
      await run(
        `INSERT INTO ${ShiftWeekOff.table}
                (ShiftId, DayOfWeek, WeekOfMonth, CreatedBy, ModifiedBy)
         VALUES (@shiftId, @dayOfWeek, @weekOfMonth, @actorId, @actorId)`,
        {
          ...ShiftWeekOff.params({
            shiftId,
            dayOfWeek: weekOff.dayOfWeek,
            weekOfMonth: weekOff.weekOfMonth ?? null,
          }),
          actorId: ShiftWeekOff.param('createdBy', actorId),
        },
      );
    }
  });

  return listWeekOffs(shiftId);
}

/* -------------------------------------------------------------------------
   Assignment
   ------------------------------------------------------------------------- */

export async function listAssignments({ employeeDetailId = null, shiftId = null } = {}) {
  return shapeAll(
    await query(
      `SELECT ${EmployeeShift.select(EMPLOYEE_SHIFT_PUBLIC_PROPS)}
         FROM ${EmployeeShift.table}
        WHERE DeletedAt IS NULL
          AND (@employeeDetailId IS NULL OR EmployeeDetailId = @employeeDetailId)
          AND (@shiftId IS NULL OR ShiftId = @shiftId)
        ORDER BY EmployeeDetailId, EffectiveFrom DESC`,
      EmployeeShift.params({ employeeDetailId, shiftId }),
    ),
  );
}

/**
 * No two live assignments for one employee may overlap.
 *
 * The index can only catch two rows starting on the same day; ranges that
 * overlap without sharing a start date are this function's job. Done in
 * JavaScript against the employee's rows rather than as a SQL EXISTS,
 * because the 409 can then name the clashing assignment - "you already
 * have a shift from 1 March to 30 April" is actionable, and "conflict" is
 * not.
 */
async function assertNoOverlap(employeeDetailId, effectiveFrom, effectiveTo, exceptId = null) {
  const existing = await listAssignments({ employeeDetailId });

  const clash = existing.find(
    (row) =>
      row.employeeShiftId !== exceptId &&
      rangesOverlap(effectiveFrom, effectiveTo ?? null, row.effectiveFrom, row.effectiveTo),
  );

  if (clash) {
    throw ApiError.conflict(MESSAGES.SHIFT_ASSIGNMENT_OVERLAP, {
      code: ERROR_CODE.SHIFT_ASSIGNMENT_OVERLAP,
      conflictsWith: {
        employeeShiftId: clash.employeeShiftId,
        shiftId: clash.shiftId,
        effectiveFrom: clash.effectiveFrom,
        effectiveTo: clash.effectiveTo,
      },
    });
  }
}

export async function assignShift(actorId, input) {
  await getShift(input.shiftId);
  await assertNoOverlap(input.employeeDetailId, input.effectiveFrom, input.effectiveTo ?? null);

  try {
    const row = await queryOne(
      `INSERT INTO ${EmployeeShift.table}
              (EmployeeDetailId, ShiftId, EffectiveFrom, EffectiveTo, CreatedBy, ModifiedBy)
       OUTPUT ${OUTPUT_ASSIGNMENT}
       VALUES (@employeeDetailId, @shiftId, @effectiveFrom, @effectiveTo, @actorId, @actorId)`,
      {
        ...EmployeeShift.params({
          employeeDetailId: input.employeeDetailId,
          shiftId: input.shiftId,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
        }),
        actorId: EmployeeShift.param('createdBy', actorId),
      },
    );
    return shape(row);
  } catch (error) {
    /*
      UQ_tblEmployeeShift_Employee_EffectiveFrom. assertNoOverlap above
      should already have refused anything this index would reject, so
      reaching here means two requests raced between the check and the
      insert - the check is a read, and a read cannot hold the gap.

      Translated rather than left to become a 500: the caller's situation
      is identical either way, and "conflict" is the honest answer.
    */
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.SHIFT_ASSIGNMENT_OVERLAP, {
        code: ERROR_CODE.SHIFT_ASSIGNMENT_OVERLAP,
      });
    }
    throw error;
  }
}

export async function updateAssignment(actorId, employeeShiftId, input) {
  const existing = shape(
    await queryOne(
      `SELECT ${EmployeeShift.select(EMPLOYEE_SHIFT_PUBLIC_PROPS)}
         FROM ${EmployeeShift.table}
        WHERE EmployeeShiftId = @employeeShiftId AND DeletedAt IS NULL`,
      EmployeeShift.params({ employeeShiftId }),
    ),
  );
  if (!existing) {
    throw ApiError.notFound(MESSAGES.SHIFT_ASSIGNMENT_NOT_FOUND, {
      code: ERROR_CODE.SHIFT_ASSIGNMENT_NOT_FOUND,
    });
  }

  const effectiveFrom = input.effectiveFrom ?? existing.effectiveFrom;
  const effectiveTo = input.effectiveTo === undefined ? existing.effectiveTo : input.effectiveTo;

  await assertNoOverlap(existing.employeeDetailId, effectiveFrom, effectiveTo, employeeShiftId);

  try {
    const row = await queryOne(
      `UPDATE ${EmployeeShift.table}
          SET ShiftId       = @shiftId,
              EffectiveFrom = @effectiveFrom,
              EffectiveTo   = @effectiveTo,
              ModifiedBy    = @actorId,
              ModifiedAt    = SYSUTCDATETIME()
        OUTPUT ${OUTPUT_ASSIGNMENT}
        WHERE EmployeeShiftId = @employeeShiftId AND DeletedAt IS NULL`,
      {
        ...EmployeeShift.params({
          employeeShiftId,
          shiftId: input.shiftId ?? existing.shiftId,
          effectiveFrom,
          effectiveTo,
        }),
        actorId: EmployeeShift.param('modifiedBy', actorId),
      },
    );
    return shape(row);
  } catch (error) {
    // The same race as in assignShift - see the note there.
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.SHIFT_ASSIGNMENT_OVERLAP, {
        code: ERROR_CODE.SHIFT_ASSIGNMENT_OVERLAP,
      });
    }
    throw error;
  }
}

export async function removeAssignment(actorId, employeeShiftId) {
  const rows = await mutate(
    `UPDATE ${EmployeeShift.table}
        SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
      WHERE EmployeeShiftId = @employeeShiftId AND DeletedAt IS NULL`,
    {
      ...EmployeeShift.params({ employeeShiftId }),
      actorId: EmployeeShift.param('modifiedBy', actorId),
    },
  );
  if (rows === 0) {
    throw ApiError.notFound(MESSAGES.SHIFT_ASSIGNMENT_NOT_FOUND, {
      code: ERROR_CODE.SHIFT_ASSIGNMENT_NOT_FOUND,
    });
  }
  return { employeeShiftId: Number(employeeShiftId) };
}

/* -------------------------------------------------------------------------
   Resolution - the part everything else calls
   ------------------------------------------------------------------------- */

/**
 * The shift in force for one employee on one date, with its week-offs.
 *
 * Returns null rather than throwing when nothing is assigned. A new joiner
 * whose shift has not been set yet must not crash the nightly close for the
 * whole company; the job records them as unresolved and moves on.
 *
 * The fallback to a location-wide shift is deliberate and is what makes the
 * system usable before anybody has assigned anything: a company that has
 * created "General 09:00-18:00" with no location gets correct week-offs for
 * every employee from that moment, and per-employee assignment becomes the
 * exception it should be rather than a prerequisite.
 */
export async function resolveShift(employeeDetailId, onDate, { workLocationId = null } = {}) {
  const assigned = await queryOne(
    `SELECT TOP (1) ${SHIFT_PUBLIC_PROPS.map((p) => `s.${Shift.col(p)} AS ${p}`).join(', ')}
       FROM ${EmployeeShift.table} AS es
       JOIN ${Shift.table}         AS s ON s.ShiftId = es.ShiftId AND s.DeletedAt IS NULL
      WHERE es.EmployeeDetailId = @employeeDetailId
        AND es.DeletedAt IS NULL
        AND es.EffectiveFrom <= @onDate
        AND (es.EffectiveTo IS NULL OR es.EffectiveTo >= @onDate)
      ORDER BY es.EffectiveFrom DESC`,
    {
      ...EmployeeShift.params({ employeeDetailId }),
      onDate: EmployeeShift.param('effectiveFrom', onDate),
    },
  );

  const fallback = assigned
    ? null
    : await queryOne(
        /*
          The location's shift, or the organisation-wide one. ORDER BY
          puts a location-specific row first - CASE WHEN LocationId IS NULL
          sorts 1 after 0 - so the more specific shift wins when both exist.
        */
        `SELECT TOP (1) ${SHIFT_COLUMNS}
           FROM ${Shift.table}
          WHERE DeletedAt IS NULL AND IsActive = 1
            AND (LocationId = @workLocationId OR LocationId IS NULL)
            AND EffectiveFrom <= @onDate
            AND (EffectiveTo IS NULL OR EffectiveTo >= @onDate)
          ORDER BY CASE WHEN LocationId IS NULL THEN 1 ELSE 0 END, EffectiveFrom DESC`,
        {
          ...Shift.params({ locationId: workLocationId }),
          workLocationId: Shift.param('locationId', workLocationId),
          onDate: Shift.param('effectiveFrom', onDate),
        },
      );

  const row = assigned ?? fallback;
  if (!row) return null;

  const shift = shape(row);
  return { ...shift, weekOffs: await listWeekOffs(shift.shiftId) };
}

/**
 * Is `date` a week off under this shift's pattern?
 *
 * A row with no WeekOfMonth means every week - a plain Sunday. A row WITH
 * one means the nth occurrence of that weekday in the month, which is how
 * "2nd and 4th Saturday off" is expressed and the only reason this is not
 * a seven-element lookup.
 */
export function isWeekOff(shift, date) {
  if (!shift?.weekOffs?.length) return false;

  const day = dayOfWeek(date);
  const week = weekOfMonth(date);

  return shift.weekOffs.some(
    (rule) =>
      Number(rule.dayOfWeek) === day &&
      (rule.weekOfMonth === null || rule.weekOfMonth === undefined || Number(rule.weekOfMonth) === week),
  );
}

/**
 * Every date in a range, each marked as a working day or not.
 *
 * ONE SHIFT RESOLUTION FOR THE WHOLE RANGE rather than one per day. A shift
 * change mid-range is rare enough, and visible enough on the shift screen,
 * that paying fourteen round trips on every leave application to catch it
 * is the wrong trade - the callers that must be exact about a boundary
 * (the nightly close) resolve per day because they already iterate days.
 *
 * Holidays are NOT considered here. This function knows about shifts;
 * holiday.service.js knows about holidays, and leave.service.js is where
 * the two meet - which keeps either from having to import the other.
 */
export async function resolveWorkingDays(employeeDetailId, fromDate, toDate, options = {}) {
  const shift = await resolveShift(employeeDetailId, fromDate, options);

  return eachDate(fromDate, toDate).map((date) => ({
    date,
    shiftId: shift?.shiftId ?? null,
    isWeekOff: isWeekOff(shift, date),
    // Nothing has told us about holidays yet - the caller merges those in.
    isWorkingDay: !isWeekOff(shift, date),
  }));
}

/** The same question for one date. */
export async function isWorkingDay(employeeDetailId, date, options = {}) {
  const shift = await resolveShift(employeeDetailId, date, options);
  return !isWeekOff(shift, date);
}

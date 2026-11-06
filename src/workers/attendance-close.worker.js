/**
 * The nightly close: turning a day's punches into a day's verdict.
 *
 * For every employee, for each day in the look-back window, it decides what
 * the day WAS and writes the row:
 *
 *   a holiday at their location      -> HOLIDAY
 *   a week off under their shift     -> WEEK_OFF
 *   covered by approved leave        -> ON_LEAVE (left alone, marked on approval)
 *   exempt from punching             -> PRESENT, IsDefaultPresent = 1
 *   has punches                      -> recomputeDay() decides
 *   none of the above                -> ABSENT
 *
 * A LOOK-BACK OF SEVERAL DAYS, not one. A run that was missed - a
 * deployment, an outage, a machine asleep - must be recoverable without
 * anybody writing a backfill script. Re-closing a day that is already
 * closed is harmless, because every step is an upsert and recomputeDay()
 * reaches the same answer from the same punches.
 *
 * WHY IT RUNS AT ALL, given that punching already calls recomputeDay(): the
 * days with NO punches are the ones that matter. Nobody punches on a
 * holiday, nobody punches when they are absent, and the US team never
 * punches at all - so without this job those days simply have no row, and
 * "who was absent last Tuesday" has no answer.
 */
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { query, queryOne, mutate } from '../helpers/query.helper.js';
import { AttendanceDay, EmployeeDetails } from '../models/index.js';
import { ATTENDANCE_STATUS, ERROR_LOG_SOURCE } from '../enums/index.js';
import { today, addDays, eachDate, dateOf } from '../helpers/date.helper.js';
import { resolveShift, isWeekOff } from '../services/shift.service.js';
import { holidayMapFor, approvedRestrictedMapFor } from '../services/holiday.service.js';
import {
  ensureDay,
  recomputeDay,
  isExempt,
  isOnApprovedLeave,
} from '../services/attendance.service.js';
import { expireOverdue } from '../services/regularization.service.js';
import { recordError } from '../services/error-log.service.js';

let timer = null;
/** Guards against a slow run overlapping the next tick. */
let running = false;
/** The last date this process closed, so an hourly tick does one run a day. */
let lastClosedOn = null;

/**
 * Close one employee's day.
 *
 * Returns what it decided, or null when it left the row alone - which it
 * does for a day already marked ON_LEAVE, because the leave approval owns
 * that and re-deciding it here would undo an approval.
 */
async function closeOne(employee, date, context) {
  const existing = await queryOne(
    `SELECT AttendanceDayId AS attendanceDayId, AttendanceStatusId AS attendanceStatusId,
            LeaveRequestId AS leaveRequestId
       FROM ${AttendanceDay.table}
      WHERE EmployeeDetailId = @employeeDetailId AND AttendanceDate = @attendanceDate
        AND DeletedAt IS NULL`,
    AttendanceDay.params({
      employeeDetailId: employee.employeeDetailId,
      attendanceDate: date,
    }),
  );

  // Already settled as leave - the approval wrote it, and it stands.
  if (existing && Number(existing.attendanceStatusId) === ATTENDANCE_STATUS.ON_LEAVE) {
    return null;
  }

  const holiday = context.holidays.get(date) ?? context.restricted.get(date) ?? null;
  const weekOff = isWeekOff(context.shift, date);

  /*
    Order matters, and this is the order the requirements imply: a declared
    holiday beats a week off (the row should name the holiday), both beat
    an exemption, and leave beats everything - which is why it is checked
    first above and again here for a day that has no row yet.
  */
  if (holiday) {
    const day = await ensureDay(employee.employeeDetailId, date, {
      shiftId: context.shift?.shiftId ?? null,
    });
    await mutate(
      `UPDATE ${AttendanceDay.table}
          SET AttendanceStatusId = @attendanceStatusId, HolidayId = @holidayId, ModifiedAt = SYSUTCDATETIME()
        WHERE AttendanceDayId = @attendanceDayId AND DeletedAt IS NULL`,
      AttendanceDay.params({
        attendanceDayId: day.attendanceDayId,
        attendanceStatusId: ATTENDANCE_STATUS.HOLIDAY,
        holidayId: holiday.holidayId,
      }),
    );
    // Punches on a holiday are still recorded - they are the evidence for a
    // comp-off request - but they do not turn the holiday into a work day.
    return 'HOLIDAY';
  }

  if (weekOff) {
    const day = await ensureDay(employee.employeeDetailId, date, {
      shiftId: context.shift?.shiftId ?? null,
    });
    await mutate(
      `UPDATE ${AttendanceDay.table}
          SET AttendanceStatusId = @attendanceStatusId, ModifiedAt = SYSUTCDATETIME()
        WHERE AttendanceDayId = @attendanceDayId AND DeletedAt IS NULL`,
      AttendanceDay.params({
        attendanceDayId: day.attendanceDayId,
        attendanceStatusId: ATTENDANCE_STATUS.WEEK_OFF,
      }),
    );
    return 'WEEK_OFF';
  }

  if (await isOnApprovedLeave(employee.employeeDetailId, date)) {
    // A request approved after the day passed. markLeaveDays() handles the
    // normal case; this catches the backdated one.
    const day = await ensureDay(employee.employeeDetailId, date, {
      shiftId: context.shift?.shiftId ?? null,
    });
    await mutate(
      `UPDATE ${AttendanceDay.table}
          SET AttendanceStatusId = @attendanceStatusId, ModifiedAt = SYSUTCDATETIME()
        WHERE AttendanceDayId = @attendanceDayId AND DeletedAt IS NULL`,
      AttendanceDay.params({
        attendanceDayId: day.attendanceDayId,
        attendanceStatusId: ATTENDANCE_STATUS.ON_LEAVE,
      }),
    );
    return 'ON_LEAVE';
  }

  // Has punches: let the shared rules decide, so a closed day and a
  // just-punched day are judged by the same code.
  if (existing) {
    await recomputeDay(Number(existing.attendanceDayId), { shift: context.shift });
    return 'RECOMPUTED';
  }

  if (context.exempt) {
    const day = await ensureDay(employee.employeeDetailId, date, {
      shiftId: context.shift?.shiftId ?? null,
    });
    await mutate(
      `UPDATE ${AttendanceDay.table}
          SET AttendanceStatusId = @attendanceStatusId, IsDefaultPresent = 1, ModifiedAt = SYSUTCDATETIME()
        WHERE AttendanceDayId = @attendanceDayId AND DeletedAt IS NULL`,
      AttendanceDay.params({
        attendanceDayId: day.attendanceDayId,
        attendanceStatusId: ATTENDANCE_STATUS.PRESENT,
      }),
    );
    return 'DEFAULT_PRESENT';
  }

  // Nothing accounts for the day.
  await ensureDay(employee.employeeDetailId, date, { shiftId: context.shift?.shiftId ?? null });
  return 'ABSENT';
}

/**
 * Close a window of days for everybody.
 *
 * ONE EMPLOYEE'S FAILURE DOES NOT STOP THE REST - a missing shift or a
 * constraint nobody anticipated must not leave the rest of the company
 * unclosed. Failures are counted and logged, and the run reports them.
 */
export async function closeAttendance({ upTo = addDays(today(), -1), days = null } = {}) {
  const lookBack = days ?? env.ATTENDANCE_CLOSE_LOOKBACK_DAYS;
  const from = addDays(upTo, -(lookBack - 1));

  const employees = await query(
    `SELECT EmployeeDetailId AS employeeDetailId,
            WorkLocationId   AS workLocationId,
            DateOfJoining    AS dateOfJoining
       FROM ${EmployeeDetails.table}
      WHERE DeletedAt IS NULL AND IsActive = 1
      ORDER BY EmployeeDetailId`,
  );

  const summary = { from, to: upTo, employees: employees.length, written: 0, failed: [] };

  for (const row of employees) {
    const employee = {
      employeeDetailId: Number(row.employeeDetailId),
      workLocationId: row.workLocationId === null ? null : Number(row.workLocationId),
      dateOfJoining: row.dateOfJoining ? dateOf(row.dateOfJoining) : null,
    };

    try {
      /*
        Resolved once per employee for the whole window rather than per day:
        three days is a short enough window that a shift change inside it is
        both rare and visible on the shift screen, and per-day resolution
        would triple the query count for the entire company.
      */
      const [shift, holidays, restricted, exempt] = await Promise.all([
        resolveShift(employee.employeeDetailId, upTo, {
          workLocationId: employee.workLocationId,
        }),
        holidayMapFor(employee.workLocationId, from, upTo),
        approvedRestrictedMapFor(employee.employeeDetailId, from, upTo),
        isExempt(employee.employeeDetailId, upTo),
      ]);

      const context = { shift, holidays, restricted, exempt };

      for (const date of eachDate(from, upTo)) {
        // Nothing before somebody joined: an employee who started on
        // Wednesday was not absent on Monday.
        if (employee.dateOfJoining && date < employee.dateOfJoining) continue;

        const outcome = await closeOne(employee, date, context);
        if (outcome) summary.written += 1;
      }
    } catch (error) {
      summary.failed.push({ employeeDetailId: employee.employeeDetailId, message: error.message });
    }
  }

  return summary;
}

/** One pass: close the window, then expire stale regularization requests. */
export async function runClose() {
  const summary = await closeAttendance();
  const expired = await expireOverdue();

  logger.info(
    `[attendance:close] ${summary.from}..${summary.to} - ${summary.written} day(s) written ` +
      `for ${summary.employees} employee(s)` +
      (expired > 0 ? `, ${expired} regularization(s) expired` : '') +
      (summary.failed.length > 0 ? `, ${summary.failed.length} failed` : ''),
  );

  for (const failure of summary.failed.slice(0, 10)) {
    logger.warn(`[attendance:close] employee ${failure.employeeDetailId}: ${failure.message}`);
  }

  return { ...summary, expired };
}

/**
 * The tick.
 *
 * Hourly, and it does the work once the configured hour has arrived and it
 * has not already run today. A cron would be neater; an interval that
 * checks the clock keeps this a plain Node process with no scheduler to
 * deploy - the same approach as the email outbox worker next door.
 */
async function tick() {
  if (running) return;

  const now = new Date();
  const currentDate = now.toISOString().slice(0, 10);

  if (now.getUTCHours() < env.ATTENDANCE_CLOSE_HOUR_UTC) return;
  if (lastClosedOn === currentDate) return;

  running = true;
  try {
    await runClose();
    lastClosedOn = currentDate;
  } catch (error) {
    // Never let a bad run kill the interval - tomorrow's should still fire,
    // and the look-back window means it will catch up today's work.
    logger.error('[attendance:close] run failed', error);
    void recordError({
      source: ERROR_LOG_SOURCE.JOB,
      error,
      message: `Attendance close failed: ${error.message}`,
    });
  } finally {
    running = false;
  }
}

export function startAttendanceClose() {
  if (timer || !env.ATTENDANCE_CLOSE_ENABLED) return;

  timer = setInterval(() => void tick(), 60 * 60 * 1000);
  timer.unref();

  logger.info(
    `Attendance close worker started: daily after ${env.ATTENDANCE_CLOSE_HOUR_UTC}:00 UTC, ` +
      `look-back ${env.ATTENDANCE_CLOSE_LOOKBACK_DAYS} day(s)`,
  );

  void tick();
}

export function stopAttendanceClose() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

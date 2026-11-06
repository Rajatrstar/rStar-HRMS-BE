/**
 * The missed-check-in sweep.
 *
 * The requirement: alert an employee who has not checked in, every ten
 * minutes for two hours, starting nine minutes after their shift begins -
 * all four numbers configurable by Admin and HR Admin, and no alert at all
 * for somebody on leave.
 *
 * WHERE THE CADENCE COMES FROM: dbo.tblAttendanceAlertSetting, per
 * location. This worker's own interval only decides how often it LOOKS;
 * whether an alert is due is computed from the setting and the employee's
 * shift. That split is what makes the cadence configurable without a
 * deploy, which is what was asked for.
 *
 * NOTHING IS ALERTED WITHOUT A SETTING. A missing configuration means
 * silence rather than a built-in default: an alert cadence nobody chose
 * firing at the whole company is worse than no alerts.
 *
 * ALERTS GO THROUGH THE EMAIL OUTBOX, like every other mail in this
 * application - queued, not sent inline, so a slow mailbox cannot hold the
 * sweep up and a failed send is retried by the worker that owns retries.
 */
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { query, queryOne } from '../helpers/query.helper.js';
import { AttendanceDay, EmployeeDetails } from '../models/index.js';
import {
  ATTENDANCE_ALERT_TYPE,
  ATTENDANCE_STATUS,
  ERROR_LOG_SOURCE,
} from '../enums/index.js';
import { today, minutesOfDay } from '../helpers/date.helper.js';
import { resolveShift, isWeekOff } from '../services/shift.service.js';
import { holidayMapFor } from '../services/holiday.service.js';
import {
  alertSettingFor,
  isExempt,
  isOnApprovedLeave,
} from '../services/attendance.service.js';
import { recordError } from '../services/error-log.service.js';

let timer = null;
let running = false;

/**
 * How many alerts have already gone out, per employee per day.
 *
 * IN MEMORY, AND DELIBERATELY SO. The alternative is a table of every alert
 * ever sent, which is a lot of rows to keep forever so that a restart does
 * not re-send one message. The cost of being wrong is one duplicate email
 * after a deploy; the cost of the table is permanent. It clears itself when
 * the date changes.
 */
let sentToday = new Map();
let sentDate = null;

function alertCountFor(employeeDetailId) {
  const date = today();
  if (sentDate !== date) {
    sentToday = new Map();
    sentDate = date;
  }
  return sentToday.get(employeeDetailId) ?? 0;
}

function recordAlert(employeeDetailId) {
  sentToday.set(employeeDetailId, alertCountFor(employeeDetailId) + 1);
}

/**
 * Is an alert due for this employee right now, and is it the nth?
 *
 * The window opens at (shift start + DelayMinutes) and closes
 * WindowMinutes later. Inside it, one alert every IntervalMinutes. Outside
 * it, nothing - which is what stops somebody who never comes in being
 * emailed all day.
 */
function alertDue(setting, shift, nowMinutes, alreadySent) {
  const shiftStart = minutesOfDay(shift.startTime);
  const windowStart = shiftStart + setting.delayMinutes;
  const windowEnd = windowStart + setting.windowMinutes;

  if (nowMinutes < windowStart || nowMinutes > windowEnd) return false;

  // How many alerts the schedule says should have gone by now.
  const due = Math.floor((nowMinutes - windowStart) / setting.intervalMinutes) + 1;
  return due > alreadySent;
}

/**
 * One sweep.
 *
 * Reads every active employee once, then skips as early as possible: the
 * cheap tests - week off, no shift, already punched - come before the ones
 * that cost a query.
 */
export async function sweep({ now = new Date() } = {}) {
  const date = today();
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  const employees = await query(
    `SELECT e.EmployeeDetailId AS employeeDetailId,
            e.WorkLocationId   AS workLocationId,
            e.FirstName        AS firstName,
            e.WorkEmail        AS workEmail,
            e.ManagerId        AS managerId,
            d.AttendanceDayId  AS attendanceDayId,
            d.FirstCheckInAt   AS firstCheckInAt,
            d.AttendanceStatusId AS attendanceStatusId
       FROM ${EmployeeDetails.table} AS e
       LEFT JOIN ${AttendanceDay.table} AS d
         ON d.EmployeeDetailId = e.EmployeeDetailId
        AND d.AttendanceDate   = @date
        AND d.DeletedAt IS NULL
      WHERE e.DeletedAt IS NULL AND e.IsActive = 1 AND e.WorkEmail IS NOT NULL`,
    { date: AttendanceDay.param('attendanceDate', date) },
  );

  const outcome = { checked: employees.length, alerted: 0, skipped: 0 };

  for (const row of employees) {
    const employeeDetailId = Number(row.employeeDetailId);
    const workLocationId = row.workLocationId === null ? null : Number(row.workLocationId);

    // Already in: nothing to chase.
    if (row.firstCheckInAt) {
      outcome.skipped += 1;
      continue;
    }
    // Already settled as something that is not an absence.
    if (
      row.attendanceStatusId &&
      [ATTENDANCE_STATUS.HOLIDAY, ATTENDANCE_STATUS.WEEK_OFF, ATTENDANCE_STATUS.ON_LEAVE].includes(
        Number(row.attendanceStatusId),
      )
    ) {
      outcome.skipped += 1;
      continue;
    }

    const setting = await alertSettingFor(workLocationId, ATTENDANCE_ALERT_TYPE.MISSED_CHECK_IN);
    // No configuration, no alerts. See the file header.
    if (!setting) {
      outcome.skipped += 1;
      continue;
    }

    const shift = await resolveShift(employeeDetailId, date, { workLocationId });
    if (!shift) {
      outcome.skipped += 1;
      continue;
    }
    if (isWeekOff(shift, date)) {
      outcome.skipped += 1;
      continue;
    }

    const alreadySent = alertCountFor(employeeDetailId);
    if (!alertDue(setting, shift, nowMinutes, alreadySent)) {
      outcome.skipped += 1;
      continue;
    }

    // The expensive checks, last - only for somebody who would otherwise
    // be alerted right now.
    if (setting.skipOnHoliday) {
      const holidays = await holidayMapFor(workLocationId, date, date);
      if (holidays.has(date)) {
        outcome.skipped += 1;
        continue;
      }
    }
    if (setting.skipWhenOnLeave && (await isOnApprovedLeave(employeeDetailId, date))) {
      outcome.skipped += 1;
      continue;
    }
    if (setting.skipWhenExempt && (await isExempt(employeeDetailId, date))) {
      outcome.skipped += 1;
      continue;
    }

    await queueAlert({
      employee: {
        employeeDetailId,
        firstName: row.firstName,
        workEmail: row.workEmail,
        managerId: row.managerId === null ? null : Number(row.managerId),
      },
      shift,
      setting,
      attemptNumber: alreadySent + 1,
    });

    recordAlert(employeeDetailId);
    outcome.alerted += 1;
  }

  return outcome;
}

/**
 * Queue the alert.
 *
 * Written against the outbox directly rather than through a template so
 * this worker can ship before the attendance email templates exist - the
 * body is deliberately plain. When a template lands, this is the one
 * function to change.
 */
async function queueAlert({ employee, shift, setting, attemptNumber }) {
  const { queueRawMail } = await import('../services/email.service.js');

  const subject = 'Reminder: you have not checked in';
  const text =
    `Hi ${employee.firstName ?? 'there'},\n\n` +
    `Our records show you have not checked in today. Your shift started at ` +
    `${String(shift.startTime).slice(0, 5)}.\n\n` +
    `If you are on leave or working elsewhere, please let your manager know, ` +
    `or raise a regularization request once you have checked in.\n\n` +
    `This is reminder ${attemptNumber}.`;

  // Copy the manager once the configured number of reminders has gone
  // unanswered - escalation, without a separate escalation engine.
  let cc = null;
  if (setting.notifyManagerAfter && attemptNumber >= setting.notifyManagerAfter && employee.managerId) {
    const manager = await queryOne(
      `SELECT WorkEmail AS workEmail FROM ${EmployeeDetails.table}
        WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL AND IsActive = 1`,
      EmployeeDetails.params({ employeeDetailId: employee.managerId }),
    );
    cc = manager?.workEmail ?? null;
  }

  await queueRawMail({
    to: employee.workEmail,
    cc,
    subject,
    html: `<p>${text.replace(/\n/g, '<br>')}</p>`,
    text,
    templateCode: 'ATTENDANCE_MISSED_CHECK_IN',
  });
}

async function tick() {
  if (running) return;
  running = true;

  try {
    const outcome = await sweep();
    if (outcome.alerted > 0) {
      logger.info(
        `[attendance:alert] ${outcome.alerted} reminder(s) queued ` +
          `(${outcome.checked} checked, ${outcome.skipped} skipped)`,
      );
    }
  } catch (error) {
    logger.error('[attendance:alert] sweep failed', error);
    void recordError({
      source: ERROR_LOG_SOURCE.JOB,
      error,
      message: `Attendance alert sweep failed: ${error.message}`,
    });
  } finally {
    running = false;
  }
}

export function startAttendanceAlerts() {
  if (timer || !env.ATTENDANCE_ALERT_ENABLED) return;

  timer = setInterval(() => void tick(), env.ATTENDANCE_ALERT_POLL_SECONDS * 1000);
  timer.unref();

  logger.info(
    `Attendance alert worker started: sweeping every ${env.ATTENDANCE_ALERT_POLL_SECONDS}s ` +
      '(cadence per location comes from tblAttendanceAlertSetting)',
  );
}

export function stopAttendanceAlerts() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

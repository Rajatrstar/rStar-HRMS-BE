/**
 * Attendance vocabulary: the statuses a day can hold, and the small closed
 * lists the attendance tables carry CHECK constraints for.
 *
 * ATTENDANCE_STATUS_CATALOG IS THE SAME KIND OF THING AS MODULE_CATALOG - a
 * list of fixed ids that the code owns and the database copies. The ids are
 * stored in dbo.tblAttendanceDay forever, so renumbering one would silently
 * relabel history: every day recorded as PRESENT would become whatever now
 * holds id 1.
 *
 * WHY THIS IS NOT MASTER DATA, although its three columns look exactly like
 * the editable lookups in master-data.enum.js: the nightly close branches on
 * these by name. A screen that let somebody rename "Present", or switch it
 * off, would break the job that writes the table - and the breakage would
 * surface hours later as an entire office marked absent. Adding a status is
 * a deliberate code change here and a seed, which is the right cost.
 *
 * Every value below that is stored in a column is mirrored by a CHECK
 * constraint in db/migrations/016_attendance.sql. Adding a value means
 * editing both, deliberately.
 */

/** Every attendance status, by name. Services use these, never a number. */
export const ATTENDANCE_STATUS = Object.freeze({
  PRESENT: 1,
  ABSENT: 2,
  LATE: 3,
  HALF_DAY: 4,
  /** Punched in, never out - or the other way round. Needs regularization. */
  MISSING_PUNCH: 5,
  ON_LEAVE: 6,
  HOLIDAY: 7,
  WEEK_OFF: 8,
  /** Was one of the above, and an approved correction changed it. */
  REGULARIZED: 9,
});

/**
 * The rows seeded into dbo.tblAttendanceStatus.
 *
 * `countsAsPresent` is a column rather than a list in code because "does a
 * half day count as attended" is a payroll question whose answer differs by
 * company - and one that must not be answered by a hard-coded set of ids
 * buried in a report.
 */
export const ATTENDANCE_STATUS_CATALOG = Object.freeze([
  {
    attendanceStatusId: ATTENDANCE_STATUS.PRESENT,
    statusCode: 'PRESENT',
    statusName: 'Present',
    description: 'Worked at least the shift’s full-day minutes.',
    countsAsPresent: true,
    colorHex: '#15803d',
    sortOrder: 10,
  },
  {
    attendanceStatusId: ATTENDANCE_STATUS.ABSENT,
    statusCode: 'ABSENT',
    statusName: 'Absent',
    description: 'No punches, no leave, no holiday and not a week off.',
    countsAsPresent: false,
    colorHex: '#b91c1c',
    sortOrder: 20,
  },
  {
    attendanceStatusId: ATTENDANCE_STATUS.LATE,
    statusCode: 'LATE',
    statusName: 'Late',
    description: 'Present, but checked in after the shift’s grace period.',
    // Still a full day's attendance. Lateness is a separate fact, carried
    // by tblAttendanceDay.LateMinutes, not a reduction in the day.
    countsAsPresent: true,
    colorHex: '#b45309',
    sortOrder: 30,
  },
  {
    attendanceStatusId: ATTENDANCE_STATUS.HALF_DAY,
    statusCode: 'HALF_DAY',
    statusName: 'Half Day',
    description: 'Worked at least the half-day minutes but less than a full day.',
    countsAsPresent: true,
    colorHex: '#a16207',
    sortOrder: 40,
  },
  {
    attendanceStatusId: ATTENDANCE_STATUS.MISSING_PUNCH,
    statusCode: 'MISSING_PUNCH',
    statusName: 'Missing Punch',
    description: 'Checked in without checking out, or the reverse. Needs regularization.',
    countsAsPresent: false,
    colorHex: '#c2410c',
    sortOrder: 50,
  },
  {
    attendanceStatusId: ATTENDANCE_STATUS.ON_LEAVE,
    statusCode: 'ON_LEAVE',
    statusName: 'On Leave',
    description: 'Covered by an approved leave request.',
    countsAsPresent: false,
    colorHex: '#4f46e5',
    sortOrder: 60,
  },
  {
    attendanceStatusId: ATTENDANCE_STATUS.HOLIDAY,
    statusCode: 'HOLIDAY',
    statusName: 'Holiday',
    description: 'A declared holiday at the employee’s work location.',
    countsAsPresent: false,
    colorHex: '#0e7490',
    sortOrder: 70,
  },
  {
    attendanceStatusId: ATTENDANCE_STATUS.WEEK_OFF,
    statusCode: 'WEEK_OFF',
    statusName: 'Week Off',
    description: 'A non-working day under the employee’s shift pattern.',
    countsAsPresent: false,
    colorHex: '#64748b',
    sortOrder: 80,
  },
  {
    attendanceStatusId: ATTENDANCE_STATUS.REGULARIZED,
    statusCode: 'REGULARIZED',
    statusName: 'Regularized',
    description: 'Corrected by an approved regularization request.',
    countsAsPresent: true,
    colorHex: '#047857',
    sortOrder: 90,
  },
]);

/** attendanceStatusId -> catalog entry. Built once; the catalog is frozen. */
export const ATTENDANCE_STATUS_BY_ID = Object.freeze(
  new Map(ATTENDANCE_STATUS_CATALOG.map((status) => [status.attendanceStatusId, status])),
);

/** Readable code for a status id, for log lines and error details. */
export function attendanceStatusCode(attendanceStatusId) {
  return (
    ATTENDANCE_STATUS_BY_ID.get(Number(attendanceStatusId))?.statusCode ??
    `status ${attendanceStatusId}`
  );
}

/**
 * The statuses a day may hold without anybody having punched.
 *
 * Used by the nightly close to decide whether a day with no punches is an
 * absence or simply a day nobody was expected to work. Getting this list
 * wrong is how a public holiday turns into a company-wide absence.
 */
export const NON_WORKING_STATUSES = Object.freeze([
  ATTENDANCE_STATUS.HOLIDAY,
  ATTENDANCE_STATUS.WEEK_OFF,
  ATTENDANCE_STATUS.ON_LEAVE,
]);

/** CK_tblAttendancePunch_PunchType. */
export const PUNCH_TYPE = Object.freeze({
  IN: 'IN',
  OUT: 'OUT',
});

/**
 * CK_tblAttendancePunch_Source. Where the punch came from.
 *
 * SYSTEM is a punch written by an approved regularization rather than by a
 * person - which is exactly why the source is recorded at all.
 */
export const PUNCH_SOURCE = Object.freeze({
  WEB: 'WEB',
  MOBILE: 'MOBILE',
  BIOMETRIC: 'BIOMETRIC',
  KIOSK: 'KIOSK',
  SYSTEM: 'SYSTEM',
});

/** The sources a client is allowed to claim. SYSTEM is not among them. */
export const CLIENT_PUNCH_SOURCES = Object.freeze([
  PUNCH_SOURCE.WEB,
  PUNCH_SOURCE.MOBILE,
  PUNCH_SOURCE.BIOMETRIC,
  PUNCH_SOURCE.KIOSK,
]);

/** CK_tblRegularizationRequest_Status. */
export const REGULARIZATION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  /** The submission window closed before anybody acted. */
  EXPIRED: 'EXPIRED',
});

/** Statuses that occupy the one-open-request-per-day slot. */
export const REGULARIZATION_OPEN_STATUSES = Object.freeze([
  REGULARIZATION_STATUS.PENDING,
  REGULARIZATION_STATUS.APPROVED,
]);

/** CK_tblAttendanceAlertSetting_AlertType. */
export const ATTENDANCE_ALERT_TYPE = Object.freeze({
  MISSED_CHECK_IN: 'MISSED_CHECK_IN',
  MISSED_CHECK_OUT: 'MISSED_CHECK_OUT',
});

/**
 * Day of week as T-SQL DATEPART(WEEKDAY) reports it under the default
 * DATEFIRST of 7, which is what the server runs.
 *
 * Named here rather than left as bare numbers in tblShiftWeekOff, because
 * "DayOfWeek = 1" in a service is a number somebody has to go and look up,
 * and getting it wrong moves the entire company's weekend by a day.
 */
export const DAY_OF_WEEK = Object.freeze({
  SUNDAY: 1,
  MONDAY: 2,
  TUESDAY: 3,
  WEDNESDAY: 4,
  THURSDAY: 5,
  FRIDAY: 6,
  SATURDAY: 7,
});

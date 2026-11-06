/**
 * Calendar-date arithmetic, for a module that is almost entirely about dates.
 *
 * ONE RULE, AND EVERYTHING HERE FOLLOWS FROM IT: a calendar date is the
 * STRING "YYYY-MM-DD", never a JS Date.
 *
 * A Date is a point in time, and a point in time has a timezone. The moment
 * one enters this module, "2026-03-01" becomes midnight somewhere and
 * 2026-02-28T18:30:00Z in Asia/Kolkata - so the server's own offset decides
 * which month a leave day falls in, which month an accrual belongs to, and
 * whether somebody's probation ended before or after the 1st. Those bugs do
 * not reproduce on a developer's machine in the same timezone as the server,
 * and they appear as half-day discrepancies months later.
 *
 * So: dates in and out of every function here are strings. They are compared
 * with <, > and ===, which work exactly right on ISO dates because the
 * format sorts lexicographically. The mssql driver accepts a string for a
 * DATE parameter and SQL Server stores it verbatim - no conversion, no
 * offset, nothing to get wrong.
 *
 * Where a Date IS used below it is created with Date.UTC and read with the
 * getUTC* accessors, which makes it a pure calendar calculator with no local
 * timezone anywhere in the arithmetic.
 *
 * TIMESTAMPS ARE A DIFFERENT MATTER. A punch is a real instant and is stored
 * as DATETIME2 in UTC, as everywhere else in this schema. The functions that
 * bridge the two - attendanceDateFor, in particular - say so explicitly.
 */

/** "YYYY-MM-DD". Anything else is rejected rather than coerced. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True when the string is both well-formed and a real calendar date. */
export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  // Round-tripping catches 2026-02-31, which Date happily rolls into March.
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function assertIsoDate(value, label = 'date') {
  if (!isIsoDate(value)) {
    throw new TypeError(`${label} must be a YYYY-MM-DD calendar date, received ${JSON.stringify(value)}`);
  }
  return value;
}

/** A UTC-midnight Date for the arithmetic below. Never returned to a caller. */
function toUtc(isoDate) {
  assertIsoDate(isoDate);
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** The inverse. Always produces a well-formed ISO date. */
function fromUtc(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Today, as the server sees it, in UTC.
 *
 * UTC rather than local on purpose: the rest of the schema stores
 * SYSUTCDATETIME() and a "today" that disagreed with the database's would
 * put a punch on the wrong day for the two offices either side of midnight.
 */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The calendar date a TIMESTAMP falls on, in UTC.
 *
 * Deliberately separate from attendanceDateFor() below: this is the plain
 * conversion, that one knows about night shifts.
 */
export function dateOf(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return date.toISOString().slice(0, 10);
}

/** Days added - or subtracted, with a negative count. */
export function addDays(isoDate, count) {
  const date = toUtc(isoDate);
  date.setUTCDate(date.getUTCDate() + count);
  return fromUtc(date);
}

/**
 * Months added, clamped to the end of the target month.
 *
 * 31 January plus one month is 28 February, not 3 March. JS rolls over by
 * default, which would make a probation that started on the 31st end in the
 * wrong month - and nobody would notice until somebody joined on the 31st.
 */
export function addMonths(isoDate, count) {
  const date = toUtc(isoDate);
  const day = date.getUTCDate();

  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + count);

  // Last day of the month we have landed in.
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));

  return fromUtc(date);
}

/** Whole days from one date to another. Negative when `to` is earlier. */
export function daysBetween(fromDate, toDate) {
  const MS_PER_DAY = 86_400_000;
  return Math.round((toUtc(toDate).getTime() - toUtc(fromDate).getTime()) / MS_PER_DAY);
}

/**
 * Whole months between two dates - tenure, for the leave mapping's
 * MinTenureMonths.
 *
 * A partial month does not count: somebody who joined on 15 January has
 * eleven months of tenure on 14 December, not twelve. Rounding that up
 * would grant maternity leave a month early.
 */
export function monthsBetween(fromDate, toDate) {
  const from = toUtc(fromDate);
  const to = toUtc(toDate);

  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;

  return months;
}

/** Every date from `fromDate` to `toDate`, inclusive. */
export function eachDate(fromDate, toDate) {
  assertIsoDate(fromDate, 'fromDate');
  assertIsoDate(toDate, 'toDate');

  const dates = [];
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/**
 * 1 = Sunday ... 7 = Saturday.
 *
 * Matches DAY_OF_WEEK in src/enums/attendance.enum.js and T-SQL's
 * DATEPART(WEEKDAY) under the default DATEFIRST of 7 - which is what
 * tblShiftWeekOff.DayOfWeek holds. Computed here rather than read from the
 * database so the week-off calculation does not depend on a session setting
 * that a different connection might not share.
 */
export function dayOfWeek(isoDate) {
  return toUtc(isoDate).getUTCDay() + 1;
}

/**
 * Which occurrence of this weekday within its month: the 2nd Saturday
 * returns 2.
 *
 * This is what makes "alternate Saturday off" expressible -
 * tblShiftWeekOff.WeekOfMonth holds 2 and 4, and this is the function that
 * decides whether a given Saturday is one of them.
 *
 * Deliberately NOT the ISO week number, and not ceil(dayOfMonth / 7) applied
 * to the month: it counts occurrences of THAT WEEKDAY, which is the only
 * reading under which "the 2nd Saturday" means what everybody means by it.
 */
export function weekOfMonth(isoDate) {
  return Math.floor((toUtc(isoDate).getUTCDate() - 1) / 7) + 1;
}

/** The first and last date of the month a date falls in. */
export function monthBounds(isoDate) {
  const date = toUtc(isoDate);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();

  return {
    start: fromUtc(new Date(Date.UTC(year, month, 1))),
    end: fromUtc(new Date(Date.UTC(year, month + 1, 0))),
  };
}

/** True when `date` falls within an effective-dated row. NULL `to` is open. */
export function isWithin(date, from, to) {
  if (date < from) return false;
  return to === null || to === undefined || date <= to;
}

/**
 * True when two closed/open date ranges overlap.
 *
 * The check behind SHIFT_ASSIGNMENT_OVERLAP. A NULL end means open-ended,
 * so an open range overlaps everything that starts after it begins - which
 * is exactly the case a naive comparison against NULL gets wrong by
 * answering false.
 */
export function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  const aEnd = aTo ?? '9999-12-31';
  const bEnd = bTo ?? '9999-12-31';
  return aFrom <= bEnd && bFrom <= aEnd;
}

/* -------------------------------------------------------------------------
   Attendance and shifts
   ------------------------------------------------------------------------- */

/**
 * "HH:mm" from a TIME(0) column.
 *
 * The mssql driver hands a TIME back as a Date pinned to 1970-01-01, which
 * would otherwise reach a client as a full timestamp and be rendered in the
 * browser's timezone - so 09:00 would display as 14:30 for somebody in
 * another country, for a value that has no timezone at all.
 */
export function formatTime(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 5);

  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(11, 16);
}

/**
 * The reverse: a "HH:mm" or "HH:mm:ss" string into what the driver will
 * accept for a TIME(0) parameter.
 *
 * THE DRIVER WILL NOT TAKE A STRING. sql.Time rejects "09:00:00" with
 * "Validation failed for parameter. Invalid time." - it wants a Date, and
 * reads only the time part of it. So the string becomes a Date pinned to
 * 1970-01-01 UTC, which is exactly what the driver hands back when reading
 * the column, and formatTime() above is its inverse.
 *
 * Pinned to the epoch on purpose: any other date would put the value in a
 * day that has a timezone offset somewhere, and the whole point of a TIME
 * column is that 09:00 is 09:00 everywhere.
 *
 * Passes a Date straight through, so a caller that already has one - a row
 * read back from the database - can be re-bound without unwrapping it.
 */
export function toSqlTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value;

  const [hours = 0, minutes = 0, seconds = 0] = String(value).split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    throw new TypeError(`Not a time: ${JSON.stringify(value)}`);
  }

  return new Date(Date.UTC(1970, 0, 1, hours, minutes, seconds));
}

/** Minutes since midnight, for a "HH:mm" or "HH:mm:ss" string or a TIME. */
export function minutesOfDay(value) {
  const text = formatTime(value);
  if (text === null) return null;

  const [hours, minutes] = text.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Which attendance day a PUNCH belongs to.
 *
 * THE MIDNIGHT RULE, and the reason this is not just dateOf(). The evening
 * shift runs 15:00 to 00:00; somebody who checks out at 00:30 on Tuesday
 * was working MONDAY's shift, and their check-out must attach to Monday's
 * attendance row - otherwise Monday is a missing punch forever and Tuesday
 * shows a check-out with no check-in.
 *
 * The rule: on a shift that crosses midnight, a punch earlier in the day
 * than the shift's start time belongs to the previous calendar day.
 *
 * Decided ONCE, when the punch is accepted, and stored as the punch's
 * AttendanceDayId - never re-derived later by code that has to guess which
 * shift was in force at the time.
 *
 * @param {Date|string} punchAt    the real instant, UTC
 * @param {object|null} shift      the resolved shift, or null when none
 */
export function attendanceDateFor(punchAt, shift) {
  const punchDate = dateOf(punchAt);
  if (!shift || !shift.crossesMidnight) return punchDate;

  const punchMinutes = (punchAt instanceof Date ? punchAt : new Date(punchAt)).getUTCHours() * 60
    + (punchAt instanceof Date ? punchAt : new Date(punchAt)).getUTCMinutes();
  const startMinutes = minutesOfDay(shift.startTime);

  return punchMinutes < startMinutes ? addDays(punchDate, -1) : punchDate;
}

/* -------------------------------------------------------------------------
   Leave cycles
   ------------------------------------------------------------------------- */

/**
 * The financial year a date falls in, as [start, end].
 *
 * April to March, per FINANCIAL_YEAR_START_MONTH. Used to generate cycles
 * rather than to resolve them - a date is matched against the rows in
 * dbo.tblLeaveCycle, because a cycle that exists in the database and not in
 * this function is the one the ledger points at.
 */
export function financialYearBounds(isoDate, startMonth = 4) {
  const date = toUtc(isoDate);
  const year = date.getUTCFullYear();
  // Before April, we are still in the year that began last April.
  const startYear = date.getUTCMonth() + 1 >= startMonth ? year : year - 1;

  return {
    startDate: `${startYear}-${String(startMonth).padStart(2, '0')}-01`,
    endDate: fromUtc(new Date(Date.UTC(startYear + 1, startMonth - 1, 0))),
    label: `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`,
  };
}

/** The calendar year a date falls in, as [start, end]. */
export function calendarYearBounds(isoDate) {
  const year = toUtc(isoDate).getUTCFullYear();
  return {
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
    label: `CY ${year}`,
  };
}

export { assertIsoDate };

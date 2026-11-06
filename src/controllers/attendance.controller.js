/**
 * Attendance controller: validate input, call the service, shape the reply.
 * No SQL and no business rules live here.
 *
 * THE SELF / TEAM SPLIT IS A PROPERTY OF THE HANDLER, not of a flag.
 *
 * Every `me*` handler reads req.access.employeeDetailId and ignores any
 * employee id in the request entirely - there is no code path by which
 * /attendance/me/check-in can punch for somebody else, because the id never
 * comes from the client. That is a stronger guarantee than a check inside a
 * shared handler, which is one forgotten branch away from being wrong.
 *
 * The team handlers take a `scope` decision instead: a caller who holds
 * TEAM_ATTENDANCE sees their own reports; one who also holds the HR-level
 * module sees everybody. teamScope() is the one place that is decided.
 */
import * as attendanceService from '../services/attendance.service.js';
import * as shiftService from '../services/shift.service.js';
import * as holidayService from '../services/holiday.service.js';
import * as regularizationService from '../services/regularization.service.js';
import { sendSuccess } from '../helpers/response.helper.js';
import { validateBody, validateParams } from '../helpers/validation.helper.js';
import {
  HTTP_STATUS,
  MESSAGES,
  MODULE,
  ACTION,
  CLIENT_PUNCH_SOURCES,
  ATTENDANCE_ALERT_TYPE,
  DAY_OF_WEEK,
  HOLIDAY_TYPE,
  SANDWICH_MODE,
} from '../enums/index.js';
import { today, addDays } from '../helpers/date.helper.js';

/* -------------------------------------------------------------------------
   Shared validation rules
   ------------------------------------------------------------------------- */

const DATE_RANGE_RULES = {
  from: { date: true },
  to: { date: true },
};

const EMPLOYEE_PARAM = { employeeDetailId: { required: true, integer: true } };

/**
 * A month either side of today when the caller gives no range.
 *
 * A default rather than a 400: the calendar screen's first load has no
 * range to send, and making it guess one means the backend's idea of "this
 * month" and the frontend's can differ.
 */
function rangeOf(query) {
  const { from, to } = validateParams(query, DATE_RANGE_RULES);
  return {
    fromDate: from ?? addDays(today(), -30),
    toDate: to ?? addDays(today(), 30),
  };
}

/**
 * Whose rows this caller may see.
 *
 * A manager is pinned to their own reports; somebody who also holds the
 * shift or exemption module - the HR-side screens - sees the whole company.
 * Using an existing right rather than inventing a flag keeps "who is HR"
 * out of the code and on the group screen where it is administered.
 */
function teamScope(req) {
  const isHr =
    req.access.can(MODULE.ATTENDANCE_EXEMPTIONS, ACTION.VIEW) ||
    req.access.can(MODULE.SHIFTS, ACTION.VIEW);

  return isHr ? null : req.access.employeeDetailId;
}

/* -------------------------------------------------------------------------
   Self service - MODULE.MY_ATTENDANCE
   ------------------------------------------------------------------------- */

/** GET /api/v1/attendance/me/today */
export async function meToday(req, res) {
  const data = await attendanceService.todayFor(req.access.employeeDetailId);
  return sendSuccess(res, { message: MESSAGES.ATTENDANCE_FETCHED, data });
}

/** GET /api/v1/attendance/me/calendar?from=&to= */
export async function meCalendar(req, res) {
  const { fromDate, toDate } = rangeOf(req.query);
  const data = await attendanceService.calendarFor(req.access.employeeDetailId, fromDate, toDate);

  return sendSuccess(res, {
    message: MESSAGES.ATTENDANCE_FETCHED,
    data,
    meta: { fromDate, toDate, total: data.length },
  });
}

/** GET /api/v1/attendance/me/summary?from=&to= */
export async function meSummary(req, res) {
  const { fromDate, toDate } = rangeOf(req.query);
  const data = await attendanceService.summaryFor(req.access.employeeDetailId, fromDate, toDate);
  return sendSuccess(res, { message: MESSAGES.ATTENDANCE_SUMMARY_FETCHED, data });
}

/** GET /api/v1/attendance/me/day/:attendanceDate */
export async function meDay(req, res) {
  const { attendanceDate } = validateParams(req.params, {
    attendanceDate: { required: true, date: true },
  });
  const data = await attendanceService.dayDetail(req.access.employeeDetailId, attendanceDate);
  return sendSuccess(res, { message: MESSAGES.ATTENDANCE_DAY_FETCHED, data });
}

const PUNCH_RULES = {
  source: { oneOf: CLIENT_PUNCH_SOURCES },
  remarks: { maxLength: 500 },
};

/**
 * POST /api/v1/attendance/me/check-in
 *
 * THE TIME IS THE SERVER'S, NEVER THE CLIENT'S. A punch time taken from the
 * request body is a punch time the user can choose, and the whole value of
 * an attendance record is that they cannot. A correction goes through
 * regularization, where somebody approves it.
 */
export async function checkIn(req, res) {
  const input = validateBody(req.body, PUNCH_RULES);

  const data = await attendanceService.checkIn(req.access.employeeDetailId, {
    source: input.source,
    remarks: input.remarks,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.CHECKED_IN,
    data,
  });
}

/** POST /api/v1/attendance/me/check-out */
export async function checkOut(req, res) {
  const input = validateBody(req.body, PUNCH_RULES);

  const data = await attendanceService.checkOut(req.access.employeeDetailId, {
    source: input.source,
    remarks: input.remarks,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  return sendSuccess(res, { message: MESSAGES.CHECKED_OUT, data });
}

/* -------------------------------------------------------------------------
   Team and HR - MODULE.TEAM_ATTENDANCE
   ------------------------------------------------------------------------- */

/** GET /api/v1/attendance/team/day?date=&locationId=&statusId= */
export async function teamDay(req, res) {
  const filters = validateParams(req.query, {
    date: { date: true },
    locationId: { integer: true },
    statusId: { integer: true },
  });

  const data = await attendanceService.teamDay({
    onDate: filters.date ?? today(),
    managerId: teamScope(req),
    locationId: filters.locationId ?? null,
    attendanceStatusId: filters.statusId ?? null,
  });

  return sendSuccess(res, {
    message: MESSAGES.ATTENDANCE_FETCHED,
    data,
    meta: { total: data.rows.length },
  });
}

/** GET /api/v1/attendance/team/exceptions?date=&locationId= */
export async function teamExceptions(req, res) {
  const filters = validateParams(req.query, {
    date: { date: true },
    locationId: { integer: true },
  });

  const data = await attendanceService.exceptionsFor({
    onDate: filters.date ?? today(),
    managerId: teamScope(req),
    locationId: filters.locationId ?? null,
  });

  return sendSuccess(res, {
    message: MESSAGES.ATTENDANCE_EXCEPTIONS_FETCHED,
    data,
    meta: { total: data.rows.length },
  });
}

/** GET /api/v1/attendance/employees/:employeeDetailId/calendar */
export async function employeeCalendar(req, res) {
  const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);
  const { fromDate, toDate } = rangeOf(req.query);

  const data = await attendanceService.calendarFor(employeeDetailId, fromDate, toDate);

  return sendSuccess(res, {
    message: MESSAGES.ATTENDANCE_FETCHED,
    data,
    meta: { fromDate, toDate, total: data.length },
  });
}

/** GET /api/v1/attendance/employees/:employeeDetailId/day/:attendanceDate */
export async function employeeDay(req, res) {
  const { employeeDetailId, attendanceDate } = validateParams(req.params, {
    ...EMPLOYEE_PARAM,
    attendanceDate: { required: true, date: true },
  });

  const data = await attendanceService.dayDetail(employeeDetailId, attendanceDate);
  return sendSuccess(res, { message: MESSAGES.ATTENDANCE_DAY_FETCHED, data });
}

/** GET /api/v1/attendance/statuses - the legend. */
export async function statuses(req, res) {
  const data = await attendanceService.listStatuses();
  return sendSuccess(res, { message: MESSAGES.ATTENDANCE_FETCHED, data });
}

/* -------------------------------------------------------------------------
   Regularization - MODULE.REGULARIZATION
   ------------------------------------------------------------------------- */

const REGULARIZATION_RULES = {
  attendanceDate: { required: true, date: true },
  regularizationTypeId: { required: true, integer: true },
  // Full timestamps, not dates - the correction is to a time of day.
  requestedCheckInAt: { maxLength: 40 },
  requestedCheckOutAt: { maxLength: 40 },
  reason: { required: true, maxLength: 1000 },
};

/** GET /api/v1/attendance/regularizations/me */
export async function myRegularizations(req, res) {
  const data = await regularizationService.listForEmployee(req.access.employeeDetailId);
  return sendSuccess(res, {
    message: MESSAGES.REGULARIZATIONS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** POST /api/v1/attendance/regularizations */
export async function createRegularization(req, res) {
  const input = validateBody(req.body, REGULARIZATION_RULES);

  const data = await regularizationService.createRequest(
    req.access.employeeDetailId,
    req.access.employeeDetailId,
    input,
  );

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.REGULARIZATION_CREATED,
    data,
  });
}

/** GET /api/v1/attendance/regularizations/pending */
export async function pendingRegularizations(req, res) {
  const data = await regularizationService.listPending({ managerId: teamScope(req) });
  return sendSuccess(res, {
    message: MESSAGES.REGULARIZATIONS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** GET /api/v1/attendance/regularizations/:regularizationRequestId */
export async function regularizationDetail(req, res) {
  const { regularizationRequestId } = validateParams(req.params, {
    regularizationRequestId: { required: true, integer: true },
  });

  const data = await regularizationService.getRequest(regularizationRequestId);
  return sendSuccess(res, { message: MESSAGES.REGULARIZATION_FETCHED, data });
}

/** PUT /api/v1/attendance/regularizations/:id/approve */
export async function approveRegularization(req, res) {
  const { regularizationRequestId } = validateParams(req.params, {
    regularizationRequestId: { required: true, integer: true },
  });
  const { remarks } = validateBody(req.body, { remarks: { maxLength: 1000 } });

  const data = await regularizationService.approve(req.access.employeeDetailId, regularizationRequestId, {
    remarks,
  });

  return sendSuccess(res, { message: MESSAGES.REGULARIZATION_APPROVED, data });
}

/** PUT /api/v1/attendance/regularizations/:id/reject */
export async function rejectRegularization(req, res) {
  const { regularizationRequestId } = validateParams(req.params, {
    regularizationRequestId: { required: true, integer: true },
  });
  const { remarks } = validateBody(req.body, { remarks: { maxLength: 1000 } });

  const data = await regularizationService.reject(req.access.employeeDetailId, regularizationRequestId, {
    remarks,
  });

  return sendSuccess(res, { message: MESSAGES.REGULARIZATION_REJECTED, data });
}

/** PUT /api/v1/attendance/regularizations/:id/cancel */
export async function cancelRegularization(req, res) {
  const { regularizationRequestId } = validateParams(req.params, {
    regularizationRequestId: { required: true, integer: true },
  });

  const data = await regularizationService.cancel(
    req.access.employeeDetailId,
    req.access.employeeDetailId,
    regularizationRequestId,
  );

  return sendSuccess(res, { message: MESSAGES.REGULARIZATION_CANCELLED, data });
}

/* -------------------------------------------------------------------------
   Shifts - MODULE.SHIFTS
   ------------------------------------------------------------------------- */

const TIME_PATTERN_RULES = { maxLength: 8, minLength: 4 };

const SHIFT_RULES = {
  shiftCode: { required: true, maxLength: 20 },
  shiftName: { required: true, maxLength: 100 },
  locationId: { integer: true },
  startTime: { required: true, ...TIME_PATTERN_RULES },
  endTime: { required: true, ...TIME_PATTERN_RULES },
  breakMinutes: { integer: true, min: 0 },
  graceInMinutes: { integer: true, min: 0 },
  graceOutMinutes: { integer: true, min: 0 },
  fullDayMinutes: { integer: true, min: 1 },
  halfDayMinutes: { integer: true, min: 1 },
  effectiveFrom: { date: true },
  effectiveTo: { date: true },
};

const SHIFT_PARAM = { shiftId: { required: true, integer: true } };

/** GET /api/v1/attendance/shifts */
export async function listShifts(req, res) {
  const filters = validateParams(req.query, {
    locationId: { integer: true },
    onDate: { date: true },
    includeInactive: { boolean: true },
  });

  const data = await shiftService.listShifts({
    locationId: filters.locationId ?? null,
    onDate: filters.onDate ?? null,
    includeInactive: filters.includeInactive ?? false,
  });

  return sendSuccess(res, { message: MESSAGES.SHIFTS_FETCHED, data, meta: { total: data.length } });
}

/** GET /api/v1/attendance/shifts/:shiftId */
export async function shiftDetail(req, res) {
  const { shiftId } = validateParams(req.params, SHIFT_PARAM);
  const data = await shiftService.getShiftWithWeekOffs(shiftId);
  return sendSuccess(res, { message: MESSAGES.SHIFT_FETCHED, data });
}

/** POST /api/v1/attendance/shifts */
export async function createShift(req, res) {
  const input = validateBody(req.body, SHIFT_RULES);
  const data = await shiftService.createShift(req.access.employeeDetailId, input);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.SHIFT_CREATED,
    data,
  });
}

/** PUT /api/v1/attendance/shifts/:shiftId */
export async function updateShift(req, res) {
  const { shiftId } = validateParams(req.params, SHIFT_PARAM);
  const input = validateBody(req.body, {
    ...SHIFT_RULES,
    shiftCode: { maxLength: 20 },
    shiftName: { maxLength: 100 },
    startTime: TIME_PATTERN_RULES,
    endTime: TIME_PATTERN_RULES,
    isActive: { boolean: true },
  });

  const data = await shiftService.updateShift(req.access.employeeDetailId, shiftId, input);
  return sendSuccess(res, { message: MESSAGES.SHIFT_UPDATED, data });
}

/** DELETE /api/v1/attendance/shifts/:shiftId */
export async function deleteShift(req, res) {
  const { shiftId } = validateParams(req.params, SHIFT_PARAM);
  const data = await shiftService.deleteShift(req.access.employeeDetailId, shiftId);
  return sendSuccess(res, { message: MESSAGES.SHIFT_DELETED, data });
}

/** GET /api/v1/attendance/shifts/:shiftId/week-offs */
export async function listWeekOffs(req, res) {
  const { shiftId } = validateParams(req.params, SHIFT_PARAM);
  const data = await shiftService.listWeekOffs(shiftId);
  return sendSuccess(res, { message: MESSAGES.SHIFT_WEEK_OFFS_FETCHED, data });
}

/**
 * PUT /api/v1/attendance/shifts/:shiftId/week-offs
 *
 * The whole pattern at once - see saveWeekOffs() for why it is not a set of
 * row operations. The body is `{ weekOffs: [{ dayOfWeek, weekOfMonth }] }`.
 */
export async function saveWeekOffs(req, res) {
  const { shiftId } = validateParams(req.params, SHIFT_PARAM);

  const weekOffs = Array.isArray(req.body?.weekOffs) ? req.body.weekOffs : [];
  const cleaned = weekOffs.map((row) =>
    validateParams(row, {
      dayOfWeek: { required: true, integer: true, min: DAY_OF_WEEK.SUNDAY },
      weekOfMonth: { integer: true, min: 1 },
    }),
  );

  const data = await shiftService.saveWeekOffs(req.access.employeeDetailId, shiftId, cleaned);
  return sendSuccess(res, { message: MESSAGES.SHIFT_WEEK_OFFS_SAVED, data });
}

/* --- Assignment ----------------------------------------------------------- */

/** GET /api/v1/attendance/shift-assignments */
export async function listAssignments(req, res) {
  const filters = validateParams(req.query, {
    employeeDetailId: { integer: true },
    shiftId: { integer: true },
  });

  const data = await shiftService.listAssignments({
    employeeDetailId: filters.employeeDetailId ?? null,
    shiftId: filters.shiftId ?? null,
  });

  return sendSuccess(res, {
    message: MESSAGES.SHIFT_ASSIGNMENTS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** POST /api/v1/attendance/shift-assignments */
export async function assignShift(req, res) {
  const input = validateBody(req.body, {
    employeeDetailId: { required: true, integer: true },
    shiftId: { required: true, integer: true },
    effectiveFrom: { required: true, date: true },
    effectiveTo: { date: true },
  });

  const data = await shiftService.assignShift(req.access.employeeDetailId, input);
  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.SHIFT_ASSIGNED,
    data,
  });
}

/** PUT /api/v1/attendance/shift-assignments/:employeeShiftId */
export async function updateAssignment(req, res) {
  const { employeeShiftId } = validateParams(req.params, {
    employeeShiftId: { required: true, integer: true },
  });
  const input = validateBody(req.body, {
    shiftId: { integer: true },
    effectiveFrom: { date: true },
    effectiveTo: { date: true },
  });

  const data = await shiftService.updateAssignment(req.access.employeeDetailId, employeeShiftId, input);
  return sendSuccess(res, { message: MESSAGES.SHIFT_ASSIGNMENT_UPDATED, data });
}

/** DELETE /api/v1/attendance/shift-assignments/:employeeShiftId */
export async function removeAssignment(req, res) {
  const { employeeShiftId } = validateParams(req.params, {
    employeeShiftId: { required: true, integer: true },
  });

  const data = await shiftService.removeAssignment(req.access.employeeDetailId, employeeShiftId);
  return sendSuccess(res, { message: MESSAGES.SHIFT_ASSIGNMENT_DELETED, data });
}

/** GET /api/v1/attendance/employees/:employeeDetailId/shift */
export async function employeeShift(req, res) {
  const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);
  const { onDate } = validateParams(req.query, { onDate: { date: true } });

  const data = await shiftService.resolveShift(employeeDetailId, onDate ?? today());
  return sendSuccess(res, { message: MESSAGES.EMPLOYEE_SHIFT_FETCHED, data });
}

/* -------------------------------------------------------------------------
   Holidays - MODULE.HOLIDAY_CALENDAR
   ------------------------------------------------------------------------- */

const HOLIDAY_RULES = {
  holidayName: { required: true, maxLength: 150 },
  holidayDate: { required: true, date: true },
  holidayTypeId: { required: true, integer: true, min: HOLIDAY_TYPE.NORMAL },
  description: { maxLength: 500 },
};

const HOLIDAY_PARAM = { holidayId: { required: true, integer: true } };

/** GET /api/v1/attendance/holidays?year=&locationId=&typeId= */
export async function listHolidays(req, res) {
  const filters = validateParams(req.query, {
    year: { integer: true, min: 2000 },
    locationId: { integer: true },
    typeId: { integer: true },
    from: { date: true },
    to: { date: true },
    includeInactive: { boolean: true },
  });

  const data = await holidayService.listHolidays({
    year: filters.year ?? null,
    locationId: filters.locationId ?? null,
    holidayTypeId: filters.typeId ?? null,
    fromDate: filters.from ?? null,
    toDate: filters.to ?? null,
    includeInactive: filters.includeInactive ?? false,
  });

  return sendSuccess(res, {
    message: MESSAGES.HOLIDAYS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** GET /api/v1/attendance/holidays/types */
export async function holidayTypes(req, res) {
  const data = await holidayService.listHolidayTypes();
  return sendSuccess(res, { message: MESSAGES.HOLIDAY_TYPES_FETCHED, data });
}

/** GET /api/v1/attendance/holidays/:holidayId */
export async function holidayDetail(req, res) {
  const { holidayId } = validateParams(req.params, HOLIDAY_PARAM);
  const data = await holidayService.getHoliday(holidayId);
  return sendSuccess(res, { message: MESSAGES.HOLIDAY_FETCHED, data });
}

/** POST /api/v1/attendance/holidays */
export async function createHoliday(req, res) {
  const input = validateBody(req.body, HOLIDAY_RULES);

  const data = await holidayService.createHoliday(req.access.employeeDetailId, {
    ...input,
    locationIds: Array.isArray(req.body?.locationIds) ? req.body.locationIds.map(Number) : [],
  });

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.HOLIDAY_CREATED,
    data,
  });
}

/** PUT /api/v1/attendance/holidays/:holidayId */
export async function updateHoliday(req, res) {
  const { holidayId } = validateParams(req.params, HOLIDAY_PARAM);
  const input = validateBody(req.body, {
    ...HOLIDAY_RULES,
    holidayName: { maxLength: 150 },
    holidayDate: { date: true },
    holidayTypeId: { integer: true },
    isActive: { boolean: true },
  });

  const data = await holidayService.updateHoliday(req.access.employeeDetailId, holidayId, {
    ...input,
    locationIds: Array.isArray(req.body?.locationIds) ? req.body.locationIds.map(Number) : undefined,
  });

  return sendSuccess(res, { message: MESSAGES.HOLIDAY_UPDATED, data });
}

/** DELETE /api/v1/attendance/holidays/:holidayId */
export async function deleteHoliday(req, res) {
  const { holidayId } = validateParams(req.params, HOLIDAY_PARAM);
  const data = await holidayService.deleteHoliday(req.access.employeeDetailId, holidayId);
  return sendSuccess(res, { message: MESSAGES.HOLIDAY_DELETED, data });
}

/* --- The employee's restricted-holiday pick ------------------------------- */

/** GET /api/v1/attendance/holidays/restricted/options */
export async function restrictedOptions(req, res) {
  const data = await holidayService.restrictedOptionsFor(req.access.employeeDetailId);
  return sendSuccess(res, { message: MESSAGES.RESTRICTED_OPTIONS_FETCHED, data });
}

/** GET /api/v1/attendance/holidays/restricted/me */
export async function myRestrictedHoliday(req, res) {
  const data = await holidayService.restrictedOptionsFor(req.access.employeeDetailId);
  return sendSuccess(res, {
    message: MESSAGES.RESTRICTED_OPT_IN_FETCHED,
    data: data.selection,
    meta: { pickQuota: data.pickQuota, remaining: data.remaining },
  });
}

/** POST /api/v1/attendance/holidays/restricted/opt-in */
export async function optInRestricted(req, res) {
  const input = validateBody(req.body, {
    holidayId: { required: true, integer: true },
    reason: { maxLength: 500 },
  });

  const data = await holidayService.optIn(req.access.employeeDetailId, req.access.employeeDetailId, input);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.RESTRICTED_OPT_IN_CREATED,
    data,
  });
}

/** GET /api/v1/attendance/holidays/restricted/pending */
export async function pendingRestricted(req, res) {
  const data = await holidayService.listPendingOptIns();
  return sendSuccess(res, {
    message: MESSAGES.RESTRICTED_OPTIONS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** PUT /api/v1/attendance/holidays/restricted/:id/decide */
export async function decideRestricted(req, res) {
  const { restrictedHolidayOptInId } = validateParams(req.params, {
    restrictedHolidayOptInId: { required: true, integer: true },
  });
  const input = validateBody(req.body, {
    approve: { required: true, boolean: true },
    remarks: { maxLength: 500 },
  });

  const data = await holidayService.decideOptIn(req.access.employeeDetailId, restrictedHolidayOptInId, {
    approve: input.approve,
    remarks: input.remarks,
  });

  return sendSuccess(res, {
    message: input.approve ? MESSAGES.RESTRICTED_OPT_IN_APPROVED : MESSAGES.RESTRICTED_OPT_IN_REJECTED,
    data,
  });
}

/** PUT /api/v1/attendance/holidays/restricted/:id/cancel */
export async function cancelRestricted(req, res) {
  const { restrictedHolidayOptInId } = validateParams(req.params, {
    restrictedHolidayOptInId: { required: true, integer: true },
  });

  const data = await holidayService.cancelOptIn(
    req.access.employeeDetailId,
    req.access.employeeDetailId,
    restrictedHolidayOptInId,
  );

  return sendSuccess(res, { message: MESSAGES.RESTRICTED_OPT_IN_CANCELLED, data });
}

/* --- Restricted-holiday mapping - MODULE.LEAVE_MAPPING -------------------- */

/** GET /api/v1/attendance/holidays/restricted-mappings */
export async function listRestrictedMappings(req, res) {
  const { leaveCycleId } = validateParams(req.query, { leaveCycleId: { integer: true } });

  const data = await holidayService.listRestrictedMappings({ leaveCycleId: leaveCycleId ?? null });
  return sendSuccess(res, {
    message: MESSAGES.RESTRICTED_MAPPINGS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** POST /api/v1/attendance/holidays/restricted-mappings */
export async function createRestrictedMapping(req, res) {
  const input = validateBody(req.body, {
    leaveCycleId: { required: true, integer: true },
    locationId: { integer: true },
    employmentType: { maxLength: 30 },
    pickQuota: { integer: true, min: 1 },
  });

  const data = await holidayService.createRestrictedMapping(req.access.employeeDetailId, input);
  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.RESTRICTED_MAPPING_CREATED,
    data,
  });
}

/** PUT /api/v1/attendance/holidays/restricted-mappings/:id */
export async function updateRestrictedMapping(req, res) {
  const { restrictedHolidayMappingId } = validateParams(req.params, {
    restrictedHolidayMappingId: { required: true, integer: true },
  });
  const input = validateBody(req.body, {
    pickQuota: { integer: true, min: 1 },
    isActive: { boolean: true },
  });

  const data = await holidayService.updateRestrictedMapping(
    req.access.employeeDetailId,
    restrictedHolidayMappingId,
    input,
  );

  return sendSuccess(res, { message: MESSAGES.RESTRICTED_MAPPING_UPDATED, data });
}

/** DELETE /api/v1/attendance/holidays/restricted-mappings/:id */
export async function deleteRestrictedMapping(req, res) {
  const { restrictedHolidayMappingId } = validateParams(req.params, {
    restrictedHolidayMappingId: { required: true, integer: true },
  });

  const data = await holidayService.deleteRestrictedMapping(
    req.access.employeeDetailId,
    restrictedHolidayMappingId,
  );

  return sendSuccess(res, { message: MESSAGES.RESTRICTED_MAPPING_DELETED, data });
}

/* -------------------------------------------------------------------------
   Exemptions - MODULE.ATTENDANCE_EXEMPTIONS
   ------------------------------------------------------------------------- */

/** GET /api/v1/attendance/exemptions */
export async function listExemptions(req, res) {
  const filters = validateParams(req.query, {
    employeeDetailId: { integer: true },
    onDate: { date: true },
  });

  const data = await attendanceService.listExemptions({
    employeeDetailId: filters.employeeDetailId ?? null,
    onDate: filters.onDate ?? null,
  });

  return sendSuccess(res, {
    message: MESSAGES.EXEMPTIONS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** POST /api/v1/attendance/exemptions */
export async function createExemption(req, res) {
  const input = validateBody(req.body, {
    employeeDetailId: { required: true, integer: true },
    effectiveFrom: { date: true },
    effectiveTo: { date: true },
    // Required: an exemption nobody has to justify is one nobody reviews.
    reason: { required: true, maxLength: 500 },
  });

  const data = await attendanceService.createExemption(req.access.employeeDetailId, input);
  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.EXEMPTION_CREATED,
    data,
  });
}

/** PUT /api/v1/attendance/exemptions/:attendanceExemptionId */
export async function updateExemption(req, res) {
  const { attendanceExemptionId } = validateParams(req.params, {
    attendanceExemptionId: { required: true, integer: true },
  });
  const input = validateBody(req.body, {
    effectiveFrom: { date: true },
    effectiveTo: { date: true },
    reason: { maxLength: 500 },
  });

  const data = await attendanceService.updateExemption(
    req.access.employeeDetailId,
    attendanceExemptionId,
    input,
  );

  return sendSuccess(res, { message: MESSAGES.EXEMPTION_UPDATED, data });
}

/** DELETE /api/v1/attendance/exemptions/:attendanceExemptionId */
export async function deleteExemption(req, res) {
  const { attendanceExemptionId } = validateParams(req.params, {
    attendanceExemptionId: { required: true, integer: true },
  });

  const data = await attendanceService.deleteExemption(
    req.access.employeeDetailId,
    attendanceExemptionId,
  );

  return sendSuccess(res, { message: MESSAGES.EXEMPTION_DELETED, data });
}

/* -------------------------------------------------------------------------
   Alert settings - MODULE.ATTENDANCE_ALERTS
   ------------------------------------------------------------------------- */

const ALERT_RULES = {
  locationId: { integer: true },
  alertType: { required: true, oneOf: Object.values(ATTENDANCE_ALERT_TYPE) },
  delayMinutes: { integer: true, min: 0 },
  intervalMinutes: { integer: true, min: 1 },
  windowMinutes: { integer: true, min: 1 },
  sweepTime: { maxLength: 8 },
  skipWhenOnLeave: { boolean: true },
  skipOnHoliday: { boolean: true },
  skipWhenExempt: { boolean: true },
  notifyManagerAfter: { integer: true, min: 1 },
};

/** GET /api/v1/attendance/alert-settings */
export async function listAlertSettings(req, res) {
  const data = await attendanceService.listAlertSettings();
  return sendSuccess(res, {
    message: MESSAGES.ALERT_SETTINGS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** POST /api/v1/attendance/alert-settings */
export async function createAlertSetting(req, res) {
  const input = validateBody(req.body, ALERT_RULES);
  const data = await attendanceService.createAlertSetting(req.access.employeeDetailId, input);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.ALERT_SETTING_CREATED,
    data,
  });
}

/** PUT /api/v1/attendance/alert-settings/:attendanceAlertSettingId */
export async function updateAlertSetting(req, res) {
  const { attendanceAlertSettingId } = validateParams(req.params, {
    attendanceAlertSettingId: { required: true, integer: true },
  });
  const input = validateBody(req.body, {
    ...ALERT_RULES,
    alertType: { oneOf: Object.values(ATTENDANCE_ALERT_TYPE) },
    isActive: { boolean: true },
  });

  const data = await attendanceService.updateAlertSetting(
    req.access.employeeDetailId,
    attendanceAlertSettingId,
    input,
  );

  return sendSuccess(res, { message: MESSAGES.ALERT_SETTING_UPDATED, data });
}

/** DELETE /api/v1/attendance/alert-settings/:attendanceAlertSettingId */
export async function deleteAlertSetting(req, res) {
  const { attendanceAlertSettingId } = validateParams(req.params, {
    attendanceAlertSettingId: { required: true, integer: true },
  });

  const data = await attendanceService.deleteAlertSetting(
    req.access.employeeDetailId,
    attendanceAlertSettingId,
  );

  return sendSuccess(res, { message: MESSAGES.ALERT_SETTING_DELETED, data });
}

export { SANDWICH_MODE };

/**
 * Attendance routes: path (from the enum) -> guard -> controller method.
 *
 * ACCESS: each endpoint names the MODULE it belongs to and the ACTION it
 * performs - nothing more. WHICH GROUPS hold that action is data, not code:
 * it is set on the Add/Edit Group screen and changed without a deploy.
 *
 * THE SELF / TEAM SPLIT IS EXPRESSED AS TWO MODULES, not as a scope. This
 * access model has no scope - a group holds an action on a module, full stop
 * (see access-control.service.js) - so "everyone may punch; managers may
 * also see their team" becomes MY_ATTENDANCE and TEAM_ATTENDANCE, granted
 * separately. The rights matrix and the menu then agree about what exists.
 *
 * MY_ATTENDANCE is meant to be granted to EVERY group. An employee who
 * cannot reach it cannot punch, which makes the rest of the module useless
 * to them.
 *
 * DECLARATION ORDER MATTERS. Express matches in the order below, so every
 * literal path is declared before the parameterised one that would swallow
 * it: /shifts/:shiftId after /shift-assignments, /holidays/restricted/*
 * and /holidays/types before /holidays/:holidayId. Get this wrong and
 * "types" is read as an id and the request dies in the validator with "must
 * be a whole number" - the same trap ORGANIZATIONS.TYPES carries a note
 * about.
 */
import { Router } from 'express';
import { ROUTES } from '../enums/index.js';
import { MODULE, ACTION } from '../enums/module.enum.js';
import * as attendanceController from '../controllers/attendance.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { requireAccess, requireAnyAccess } from '../middlewares/permission.middleware.js';

const router = Router();

// Every endpoint below needs a valid access token. Mounted once rather than
// repeated per route, so a new endpoint cannot be added unauthenticated by
// forgetting an argument.
router.use(authenticate);

/* -------------------------------------------------------------------------
   Self service - MODULE.MY_ATTENDANCE

   CHECK-IN AND CHECK-OUT ARE ACTION.ADD, not EDIT. A punch is a new record,
   and a group that may view its own attendance without being able to punch
   is a real configuration - a contractor whose hours come from a biometric
   feed, for instance.
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.ATTENDANCE.ME_TODAY,
  requireAccess(MODULE.MY_ATTENDANCE, ACTION.VIEW),
  attendanceController.meToday,
);

router.get(
  ROUTES.ATTENDANCE.ME_CALENDAR,
  requireAccess(MODULE.MY_ATTENDANCE, ACTION.VIEW),
  attendanceController.meCalendar,
);

router.get(
  ROUTES.ATTENDANCE.ME_SUMMARY,
  requireAccess(MODULE.MY_ATTENDANCE, ACTION.VIEW),
  attendanceController.meSummary,
);

router.get(
  ROUTES.ATTENDANCE.ME_DAY,
  requireAccess(MODULE.MY_ATTENDANCE, ACTION.VIEW),
  attendanceController.meDay,
);

router.post(
  ROUTES.ATTENDANCE.CHECK_IN,
  requireAccess(MODULE.MY_ATTENDANCE, ACTION.ADD),
  attendanceController.checkIn,
);

router.post(
  ROUTES.ATTENDANCE.CHECK_OUT,
  requireAccess(MODULE.MY_ATTENDANCE, ACTION.ADD),
  attendanceController.checkOut,
);

/* -------------------------------------------------------------------------
   The status legend.

   Open to anybody who can see their own attendance: it is a list of labels
   and colours, and a calendar that cannot render its own legend is broken.
   ------------------------------------------------------------------------- */

router.get(
  '/statuses',
  requireAnyAccess(MODULE.MY_ATTENDANCE, [ACTION.VIEW, ACTION.ADD]),
  attendanceController.statuses,
);

/* -------------------------------------------------------------------------
   Regularization - MODULE.REGULARIZATION

   RAISING one is ADD; APPROVING one is EDIT. That is the whole access story
   for corrections: a group that may raise but not approve gets ADD, and the
   reporting-manager rule on top of it is enforced in the service.

   /regularizations/me and /regularizations/pending are declared BEFORE
   /regularizations/:id, or both are read as ids.
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.ATTENDANCE.REGULARIZATION_MINE,
  requireAnyAccess(MODULE.REGULARIZATION, [ACTION.VIEW, ACTION.ADD]),
  attendanceController.myRegularizations,
);

router.get(
  ROUTES.ATTENDANCE.REGULARIZATION_PENDING,
  requireAccess(MODULE.REGULARIZATION, ACTION.EDIT),
  attendanceController.pendingRegularizations,
);

router.post(
  ROUTES.ATTENDANCE.REGULARIZATION_CREATE,
  requireAccess(MODULE.REGULARIZATION, ACTION.ADD),
  attendanceController.createRegularization,
);

router.put(
  ROUTES.ATTENDANCE.REGULARIZATION_APPROVE,
  requireAccess(MODULE.REGULARIZATION, ACTION.EDIT),
  attendanceController.approveRegularization,
);

router.put(
  ROUTES.ATTENDANCE.REGULARIZATION_REJECT,
  requireAccess(MODULE.REGULARIZATION, ACTION.EDIT),
  attendanceController.rejectRegularization,
);

// Cancelling your own is ADD, not EDIT - taking back something you raised
// is part of raising it, and must not require approver rights.
router.put(
  ROUTES.ATTENDANCE.REGULARIZATION_CANCEL,
  requireAccess(MODULE.REGULARIZATION, ACTION.ADD),
  attendanceController.cancelRegularization,
);

router.get(
  ROUTES.ATTENDANCE.REGULARIZATION_DETAIL,
  requireAnyAccess(MODULE.REGULARIZATION, [ACTION.VIEW, ACTION.EDIT]),
  attendanceController.regularizationDetail,
);

/* -------------------------------------------------------------------------
   Shift assignment - MODULE.SHIFTS

   DECLARED BEFORE /shifts/:shiftId. "/shift-assignments" would not actually
   collide with "/shifts/:shiftId", but keeping the whole shift block in one
   place and ordering it literal-first is what stops the collision being
   introduced later by somebody adding /shifts/assignments.
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.ATTENDANCE.ASSIGNMENT_LIST,
  requireAccess(MODULE.SHIFTS, ACTION.VIEW),
  attendanceController.listAssignments,
);

router.post(
  ROUTES.ATTENDANCE.ASSIGNMENT_CREATE,
  requireAccess(MODULE.SHIFTS, ACTION.ADD),
  attendanceController.assignShift,
);

router.put(
  ROUTES.ATTENDANCE.ASSIGNMENT_UPDATE,
  requireAccess(MODULE.SHIFTS, ACTION.EDIT),
  attendanceController.updateAssignment,
);

router.delete(
  ROUTES.ATTENDANCE.ASSIGNMENT_DELETE,
  requireAccess(MODULE.SHIFTS, ACTION.DELETE),
  attendanceController.removeAssignment,
);

/* --- Shifts themselves ---------------------------------------------------- */

router.get(
  ROUTES.ATTENDANCE.SHIFT_LIST,
  requireAccess(MODULE.SHIFTS, ACTION.VIEW),
  attendanceController.listShifts,
);

router.post(
  ROUTES.ATTENDANCE.SHIFT_CREATE,
  requireAccess(MODULE.SHIFTS, ACTION.ADD),
  attendanceController.createShift,
);

router.get(
  ROUTES.ATTENDANCE.SHIFT_WEEK_OFFS,
  requireAccess(MODULE.SHIFTS, ACTION.VIEW),
  attendanceController.listWeekOffs,
);

router.put(
  ROUTES.ATTENDANCE.SHIFT_WEEK_OFFS_SAVE,
  requireAccess(MODULE.SHIFTS, ACTION.EDIT),
  attendanceController.saveWeekOffs,
);

router.get(
  ROUTES.ATTENDANCE.SHIFT_DETAIL,
  requireAccess(MODULE.SHIFTS, ACTION.VIEW),
  attendanceController.shiftDetail,
);

router.put(
  ROUTES.ATTENDANCE.SHIFT_UPDATE,
  requireAccess(MODULE.SHIFTS, ACTION.EDIT),
  attendanceController.updateShift,
);

router.delete(
  ROUTES.ATTENDANCE.SHIFT_DELETE,
  requireAccess(MODULE.SHIFTS, ACTION.DELETE),
  attendanceController.deleteShift,
);

/* -------------------------------------------------------------------------
   Holidays - MODULE.HOLIDAY_CALENDAR

   READING THE CALENDAR IS GRANTED THROUGH MY_ATTENDANCE AS WELL. Every
   employee needs to know when the office is closed, and requiring the
   HOLIDAY_CALENDAR module for that would mean granting the editing screen
   to everybody to make the dashboard work.

   The restricted-holiday block is declared BEFORE /holidays/:holidayId.
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.ATTENDANCE.HOLIDAY_TYPES,
  requireAnyAccess(MODULE.HOLIDAY_CALENDAR, [ACTION.VIEW, ACTION.ADD]),
  attendanceController.holidayTypes,
);

/* --- The employee's own restricted-holiday pick -------------------------- */

router.get(
  ROUTES.ATTENDANCE.HOLIDAY_RESTRICTED_OPTIONS,
  requireAccess(MODULE.MY_ATTENDANCE, ACTION.VIEW),
  attendanceController.restrictedOptions,
);

router.get(
  ROUTES.ATTENDANCE.HOLIDAY_RESTRICTED_MINE,
  requireAccess(MODULE.MY_ATTENDANCE, ACTION.VIEW),
  attendanceController.myRestrictedHoliday,
);

router.post(
  ROUTES.ATTENDANCE.HOLIDAY_RESTRICTED_OPT_IN,
  requireAccess(MODULE.MY_ATTENDANCE, ACTION.ADD),
  attendanceController.optInRestricted,
);

router.put(
  ROUTES.ATTENDANCE.HOLIDAY_RESTRICTED_CANCEL,
  requireAccess(MODULE.MY_ATTENDANCE, ACTION.ADD),
  attendanceController.cancelRestricted,
);

router.get(
  ROUTES.ATTENDANCE.HOLIDAY_RESTRICTED_PENDING,
  requireAccess(MODULE.HOLIDAY_CALENDAR, ACTION.EDIT),
  attendanceController.pendingRestricted,
);

router.put(
  ROUTES.ATTENDANCE.HOLIDAY_RESTRICTED_DECIDE,
  requireAccess(MODULE.HOLIDAY_CALENDAR, ACTION.EDIT),
  attendanceController.decideRestricted,
);

/* --- Restricted-holiday mapping: MODULE.LEAVE_MAPPING -------------------- */

router.get(
  ROUTES.ATTENDANCE.RESTRICTED_MAPPING_LIST,
  requireAccess(MODULE.LEAVE_MAPPING, ACTION.VIEW),
  attendanceController.listRestrictedMappings,
);

router.post(
  ROUTES.ATTENDANCE.RESTRICTED_MAPPING_CREATE,
  requireAccess(MODULE.LEAVE_MAPPING, ACTION.ADD),
  attendanceController.createRestrictedMapping,
);

router.put(
  ROUTES.ATTENDANCE.RESTRICTED_MAPPING_UPDATE,
  requireAccess(MODULE.LEAVE_MAPPING, ACTION.EDIT),
  attendanceController.updateRestrictedMapping,
);

router.delete(
  ROUTES.ATTENDANCE.RESTRICTED_MAPPING_DELETE,
  requireAccess(MODULE.LEAVE_MAPPING, ACTION.DELETE),
  attendanceController.deleteRestrictedMapping,
);

/* --- The calendar itself -------------------------------------------------- */

router.get(
  ROUTES.ATTENDANCE.HOLIDAY_LIST,
  requireAnyAccess(MODULE.MY_ATTENDANCE, [ACTION.VIEW, ACTION.ADD]),
  attendanceController.listHolidays,
);

router.post(
  ROUTES.ATTENDANCE.HOLIDAY_CREATE,
  requireAccess(MODULE.HOLIDAY_CALENDAR, ACTION.ADD),
  attendanceController.createHoliday,
);

router.get(
  ROUTES.ATTENDANCE.HOLIDAY_DETAIL,
  requireAnyAccess(MODULE.MY_ATTENDANCE, [ACTION.VIEW, ACTION.ADD]),
  attendanceController.holidayDetail,
);

router.put(
  ROUTES.ATTENDANCE.HOLIDAY_UPDATE,
  requireAccess(MODULE.HOLIDAY_CALENDAR, ACTION.EDIT),
  attendanceController.updateHoliday,
);

router.delete(
  ROUTES.ATTENDANCE.HOLIDAY_DELETE,
  requireAccess(MODULE.HOLIDAY_CALENDAR, ACTION.DELETE),
  attendanceController.deleteHoliday,
);

/* -------------------------------------------------------------------------
   Exemptions - MODULE.ATTENDANCE_EXEMPTIONS
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.ATTENDANCE.EXEMPTION_LIST,
  requireAccess(MODULE.ATTENDANCE_EXEMPTIONS, ACTION.VIEW),
  attendanceController.listExemptions,
);

router.post(
  ROUTES.ATTENDANCE.EXEMPTION_CREATE,
  requireAccess(MODULE.ATTENDANCE_EXEMPTIONS, ACTION.ADD),
  attendanceController.createExemption,
);

router.put(
  ROUTES.ATTENDANCE.EXEMPTION_UPDATE,
  requireAccess(MODULE.ATTENDANCE_EXEMPTIONS, ACTION.EDIT),
  attendanceController.updateExemption,
);

router.delete(
  ROUTES.ATTENDANCE.EXEMPTION_DELETE,
  requireAccess(MODULE.ATTENDANCE_EXEMPTIONS, ACTION.DELETE),
  attendanceController.deleteExemption,
);

/* -------------------------------------------------------------------------
   Alert settings - MODULE.ATTENDANCE_ALERTS
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.ATTENDANCE.ALERT_SETTING_LIST,
  requireAccess(MODULE.ATTENDANCE_ALERTS, ACTION.VIEW),
  attendanceController.listAlertSettings,
);

router.post(
  ROUTES.ATTENDANCE.ALERT_SETTING_CREATE,
  requireAccess(MODULE.ATTENDANCE_ALERTS, ACTION.ADD),
  attendanceController.createAlertSetting,
);

router.put(
  ROUTES.ATTENDANCE.ALERT_SETTING_UPDATE,
  requireAccess(MODULE.ATTENDANCE_ALERTS, ACTION.EDIT),
  attendanceController.updateAlertSetting,
);

router.delete(
  ROUTES.ATTENDANCE.ALERT_SETTING_DELETE,
  requireAccess(MODULE.ATTENDANCE_ALERTS, ACTION.DELETE),
  attendanceController.deleteAlertSetting,
);

/* -------------------------------------------------------------------------
   Team and HR - MODULE.TEAM_ATTENDANCE

   LAST, because /employees/:employeeDetailId/... is the most parameterised
   block in the file. The controller's teamScope() decides whether the
   caller sees their own reports or everybody, from the rights they hold.
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.ATTENDANCE.TEAM_DAY,
  requireAccess(MODULE.TEAM_ATTENDANCE, ACTION.VIEW),
  attendanceController.teamDay,
);

router.get(
  ROUTES.ATTENDANCE.TEAM_EXCEPTIONS,
  requireAccess(MODULE.TEAM_ATTENDANCE, ACTION.VIEW),
  attendanceController.teamExceptions,
);

router.get(
  ROUTES.ATTENDANCE.EMPLOYEE_SHIFT,
  requireAnyAccess(MODULE.SHIFTS, [ACTION.VIEW, ACTION.EDIT]),
  attendanceController.employeeShift,
);

router.get(
  ROUTES.ATTENDANCE.EMPLOYEE_CALENDAR,
  requireAccess(MODULE.TEAM_ATTENDANCE, ACTION.VIEW),
  attendanceController.employeeCalendar,
);

router.get(
  ROUTES.ATTENDANCE.EMPLOYEE_DAY,
  requireAccess(MODULE.TEAM_ATTENDANCE, ACTION.VIEW),
  attendanceController.employeeDay,
);

export default router;

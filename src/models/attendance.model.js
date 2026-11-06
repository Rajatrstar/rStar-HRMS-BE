/**
 * The attendance tables: dbo.tblAttendanceStatus, dbo.tblAttendanceDay,
 * dbo.tblAttendancePunch, dbo.tblAttendanceExemption,
 * dbo.tblAttendanceAlertSetting and dbo.tblRegularizationRequest.
 *
 * Mirrors db/migrations/016_attendance.sql.
 *
 * dbo.tblRegularizationType is NOT here. It is ordinary master data and
 * lives in master-data.model.js with the other lookups it shares a shape
 * and a service with.
 *
 * TWO OF THESE ARE APPEND-ONLY and their models say so by what they lack:
 * tblAttendancePunch has no modifiedAt and no deletedAt, because a punch
 * that can be edited is not evidence of anything. A wrong punch is
 * corrected through a regularization request, which keeps both versions.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

/** Audit and soft-delete columns, for the tables that carry them. */
const auditColumns = () => ({
  createdBy: { column: 'CreatedBy', type: sql.BigInt, nullable: true },
  modifiedBy: { column: 'ModifiedBy', type: sql.BigInt, nullable: true },
  createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
  modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
  // NULL means live.
  deletedAt: { column: 'DeletedAt', type: sql.DateTime2, nullable: true },
});

/**
 * dbo.tblAttendanceStatus - the status catalog.
 *
 * Ids are fixed and owned by the code, like dbo.tblModule: they are seeded
 * from ATTENDANCE_STATUS_CATALOG and stored in every attendance row
 * forever. `identity: false` is not a thing defineModel expresses, so note
 * it here - the application supplies the number on insert.
 */
export const AttendanceStatus = defineModel({
  table: 'dbo.tblAttendanceStatus',
  columns: {
    attendanceStatusId: { column: 'AttendanceStatusId', type: sql.Int },
    statusCode: { column: 'StatusCode', type: sql.NVarChar(20) },
    statusName: { column: 'StatusName', type: sql.NVarChar(50) },
    description: { column: 'Description', type: sql.NVarChar(255), nullable: true },
    countsAsPresent: { column: 'CountsAsPresent', type: sql.Bit },
    colorHex: { column: 'ColorHex', type: sql.NVarChar(7), nullable: true },
    sortOrder: { column: 'SortOrder', type: sql.Int },
    isActive: { column: 'IsActive', type: sql.Bit },
    createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
    modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
  },
});

/**
 * dbo.tblAttendanceDay - the spine. One row per employee per date.
 *
 * Every other table in the module points at this one. The uniqueness of
 * (EmployeeDetailId, AttendanceDate) among live rows is what lets the punch
 * endpoint, the auto-mark job, the leave approver and the regularization
 * approver all write the same day without coordinating.
 */
export const AttendanceDay = defineModel({
  table: 'dbo.tblAttendanceDay',
  columns: {
    attendanceDayId: { column: 'AttendanceDayId', type: sql.BigInt, identity: true },

    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },
    attendanceDate: { column: 'AttendanceDate', type: sql.Date },

    // The shift AS RESOLVED on that date, so history survives a timing change.
    shiftId: { column: 'ShiftId', type: sql.BigInt, nullable: true },
    attendanceStatusId: { column: 'AttendanceStatusId', type: sql.Int },

    // Denormalised from the punches by the nightly close. The punches
    // remain the record; these are the close job's reading of them.
    firstCheckInAt: { column: 'FirstCheckInAt', type: sql.DateTime2, nullable: true },
    lastCheckOutAt: { column: 'LastCheckOutAt', type: sql.DateTime2, nullable: true },

    // Written by the close job, never by a client.
    workedMinutes: { column: 'WorkedMinutes', type: sql.Int, nullable: true },
    lateMinutes: { column: 'LateMinutes', type: sql.Int, nullable: true },
    earlyOutMinutes: { column: 'EarlyOutMinutes', type: sql.Int, nullable: true },

    // "Present" and "presumed present" stay distinguishable on the
    // exception report because of this flag.
    isDefaultPresent: { column: 'IsDefaultPresent', type: sql.Bit },
    isRegularized: { column: 'IsRegularized', type: sql.Bit },

    holidayId: { column: 'HolidayId', type: sql.BigInt, nullable: true },
    leaveRequestId: { column: 'LeaveRequestId', type: sql.BigInt, nullable: true },

    remarks: { column: 'Remarks', type: sql.NVarChar(500), nullable: true },

    ...auditColumns(),
  },
});

/**
 * dbo.tblAttendancePunch - APPEND-ONLY.
 *
 * No modifiedBy, no modifiedAt, no deletedAt. See the file header.
 */
export const AttendancePunch = defineModel({
  table: 'dbo.tblAttendancePunch',
  columns: {
    punchId: { column: 'PunchId', type: sql.BigInt, identity: true },

    attendanceDayId: { column: 'AttendanceDayId', type: sql.BigInt },

    // PUNCH_TYPE and PUNCH_SOURCE in src/enums/attendance.enum.js.
    punchType: { column: 'PunchType', type: sql.NVarChar(10) },
    punchAt: { column: 'PunchAt', type: sql.DateTime2 },
    source: { column: 'Source', type: sql.NVarChar(20) },

    ipAddress: { column: 'IpAddress', type: sql.NVarChar(45), nullable: true },
    userAgent: { column: 'UserAgent', type: sql.NVarChar(500), nullable: true },
    remarks: { column: 'Remarks', type: sql.NVarChar(500), nullable: true },

    // Names the APPROVER when an approved regularization wrote the punch,
    // which is the audit trail for a SYSTEM-sourced row.
    createdBy: { column: 'CreatedBy', type: sql.BigInt, nullable: true },
    createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
  },
});

/** dbo.tblAttendanceExemption - who is present by default, and why. */
export const AttendanceExemption = defineModel({
  table: 'dbo.tblAttendanceExemption',
  columns: {
    attendanceExemptionId: { column: 'AttendanceExemptionId', type: sql.BigInt, identity: true },

    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },

    effectiveFrom: { column: 'EffectiveFrom', type: sql.Date },
    // NULL = open-ended, the normal case for a role that never punches.
    effectiveTo: { column: 'EffectiveTo', type: sql.Date, nullable: true },

    // NOT NULL: an exemption nobody has to justify is one nobody reviews.
    reason: { column: 'Reason', type: sql.NVarChar(500) },
    grantedBy: { column: 'GrantedBy', type: sql.BigInt, nullable: true },

    ...auditColumns(),
  },
});

/** dbo.tblAttendanceAlertSetting - the "every 10 minutes for 2 hours" rule. */
export const AttendanceAlertSetting = defineModel({
  table: 'dbo.tblAttendanceAlertSetting',
  columns: {
    attendanceAlertSettingId: {
      column: 'AttendanceAlertSettingId',
      type: sql.BigInt,
      identity: true,
    },

    // NULL = the organisation default.
    locationId: { column: 'LocationId', type: sql.BigInt, nullable: true },
    // ATTENDANCE_ALERT_TYPE in src/enums/attendance.enum.js.
    alertType: { column: 'AlertType', type: sql.NVarChar(30) },

    delayMinutes: { column: 'DelayMinutes', type: sql.Int },
    intervalMinutes: { column: 'IntervalMinutes', type: sql.Int },
    windowMinutes: { column: 'WindowMinutes', type: sql.Int },
    sweepTime: { column: 'SweepTime', type: sql.Time(0), nullable: true },

    // Somebody on approved leave is not missing, and must not be chased.
    skipWhenOnLeave: { column: 'SkipWhenOnLeave', type: sql.Bit },
    skipOnHoliday: { column: 'SkipOnHoliday', type: sql.Bit },
    skipWhenExempt: { column: 'SkipWhenExempt', type: sql.Bit },

    notifyManagerAfter: { column: 'NotifyManagerAfter', type: sql.Int, nullable: true },

    isActive: { column: 'IsActive', type: sql.Bit },

    ...auditColumns(),
  },
});

/**
 * dbo.tblRegularizationRequest - a correction to a day.
 *
 * previousAttendanceStatusId is what makes an approval auditable. Without
 * it, approving overwrites the day's status and nothing is left to say what
 * it was - so a wrongly recorded absence and a quietly changed correct one
 * look identical afterwards.
 */
export const RegularizationRequest = defineModel({
  table: 'dbo.tblRegularizationRequest',
  columns: {
    regularizationRequestId: {
      column: 'RegularizationRequestId',
      type: sql.BigInt,
      identity: true,
    },

    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },
    attendanceDate: { column: 'AttendanceDate', type: sql.Date },

    // NULL when the day has no attendance row yet. Approval creates one.
    attendanceDayId: { column: 'AttendanceDayId', type: sql.BigInt, nullable: true },
    regularizationTypeId: { column: 'RegularizationTypeId', type: sql.BigInt },

    requestedCheckInAt: { column: 'RequestedCheckInAt', type: sql.DateTime2, nullable: true },
    requestedCheckOutAt: { column: 'RequestedCheckOutAt', type: sql.DateTime2, nullable: true },

    reason: { column: 'Reason', type: sql.NVarChar(1000) },

    // REGULARIZATION_STATUS in src/enums/attendance.enum.js.
    status: { column: 'Status', type: sql.NVarChar(20) },

    /*
      Captured when the request is raised, from the alert setting's window.
      Stored rather than computed on read, so changing the configured window
      cannot retrospectively expire - or un-expire - an existing request.
    */
    submissionDeadline: { column: 'SubmissionDeadline', type: sql.DateTime2, nullable: true },

    previousAttendanceStatusId: {
      column: 'PreviousAttendanceStatusId',
      type: sql.Int,
      nullable: true,
    },
    newAttendanceStatusId: { column: 'NewAttendanceStatusId', type: sql.Int, nullable: true },

    approvedBy: { column: 'ApprovedBy', type: sql.BigInt, nullable: true },
    approvedAt: { column: 'ApprovedAt', type: sql.DateTime2, nullable: true },
    approverRemarks: { column: 'ApproverRemarks', type: sql.NVarChar(1000), nullable: true },

    ...auditColumns(),
  },
});

/* -------------------------------------------------------------------------
   Public property lists. Audit columns are deliberately absent from all of
   them; modifiedAt is carried so a client can detect a stale edit.
   ------------------------------------------------------------------------- */

export const ATTENDANCE_DAY_PUBLIC_PROPS = Object.freeze([
  'attendanceDayId',
  'employeeDetailId',
  'attendanceDate',
  'shiftId',
  'attendanceStatusId',
  'firstCheckInAt',
  'lastCheckOutAt',
  'workedMinutes',
  'lateMinutes',
  'earlyOutMinutes',
  'isDefaultPresent',
  'isRegularized',
  'holidayId',
  'leaveRequestId',
  'remarks',
  'modifiedAt',
]);

export const ATTENDANCE_PUNCH_PUBLIC_PROPS = Object.freeze([
  'punchId',
  'attendanceDayId',
  'punchType',
  'punchAt',
  'source',
  'remarks',
  'createdAt',
]);

export const ATTENDANCE_EXEMPTION_PUBLIC_PROPS = Object.freeze([
  'attendanceExemptionId',
  'employeeDetailId',
  'effectiveFrom',
  'effectiveTo',
  'reason',
  'grantedBy',
  'modifiedAt',
]);

export const ATTENDANCE_ALERT_SETTING_PUBLIC_PROPS = Object.freeze([
  'attendanceAlertSettingId',
  'locationId',
  'alertType',
  'delayMinutes',
  'intervalMinutes',
  'windowMinutes',
  'sweepTime',
  'skipWhenOnLeave',
  'skipOnHoliday',
  'skipWhenExempt',
  'notifyManagerAfter',
  'isActive',
  'modifiedAt',
]);

export const REGULARIZATION_REQUEST_PUBLIC_PROPS = Object.freeze([
  'regularizationRequestId',
  'employeeDetailId',
  'attendanceDate',
  'attendanceDayId',
  'regularizationTypeId',
  'requestedCheckInAt',
  'requestedCheckOutAt',
  'reason',
  'status',
  'submissionDeadline',
  'previousAttendanceStatusId',
  'newAttendanceStatusId',
  'approvedBy',
  'approvedAt',
  'approverRemarks',
  'createdAt',
  'modifiedAt',
]);

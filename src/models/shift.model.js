/**
 * dbo.tblShift, dbo.tblShiftWeekOff and dbo.tblEmployeeShift.
 *
 * Mirrors db/migrations/015_shift.sql. One file because they are one
 * feature: a shift without its week-offs cannot say which days are working
 * days, and neither is any use without knowing who is on it.
 *
 * All three are EFFECTIVE-DATED, which is the point of the design: timings
 * are never edited in place, because last month's attendance was judged
 * against last month's timings. A change writes a new row.
 *
 * Soft delete: every read path must filter `WHERE DeletedAt IS NULL`.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

/** Audit and soft-delete columns, identical on all three tables. */
const auditColumns = () => ({
  createdBy: { column: 'CreatedBy', type: sql.BigInt, nullable: true },
  modifiedBy: { column: 'ModifiedBy', type: sql.BigInt, nullable: true },
  createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
  modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
  // NULL means live.
  deletedAt: { column: 'DeletedAt', type: sql.DateTime2, nullable: true },
});

/** The effective-dated pair. EffectiveTo NULL means "still current". */
const effectiveColumns = () => ({
  effectiveFrom: { column: 'EffectiveFrom', type: sql.Date },
  effectiveTo: { column: 'EffectiveTo', type: sql.Date, nullable: true },
});

/** dbo.tblShift - a set of timings, at a location, from a date. */
export const Shift = defineModel({
  table: 'dbo.tblShift',
  columns: {
    shiftId: { column: 'ShiftId', type: sql.BigInt, identity: true },

    shiftCode: { column: 'ShiftCode', type: sql.NVarChar(20) },
    shiftName: { column: 'ShiftName', type: sql.NVarChar(100) },

    // NULL means every location - the company-wide default shift.
    locationId: { column: 'LocationId', type: sql.BigInt, nullable: true },

    /*
      sql.Time maps to TIME(0) here. The driver hands these back as a Date
      object pinned to 1970-01-01, which is why the service formats them to
      "HH:mm" before they reach a client rather than letting a bare
      timestamp out.
    */
    startTime: { column: 'StartTime', type: sql.Time(0) },
    endTime: { column: 'EndTime', type: sql.Time(0) },

    // Kept in step with the times by CK_tblShift_CrossesMidnight, so the
    // flag can be trusted rather than re-derived.
    crossesMidnight: { column: 'CrossesMidnight', type: sql.Bit },

    breakMinutes: { column: 'BreakMinutes', type: sql.Int },
    graceInMinutes: { column: 'GraceInMinutes', type: sql.Int },
    graceOutMinutes: { column: 'GraceOutMinutes', type: sql.Int },

    // What the nightly close compares worked minutes against.
    fullDayMinutes: { column: 'FullDayMinutes', type: sql.Int },
    halfDayMinutes: { column: 'HalfDayMinutes', type: sql.Int },

    ...effectiveColumns(),

    isActive: { column: 'IsActive', type: sql.Bit },

    ...auditColumns(),
  },
});

/**
 * dbo.tblShiftWeekOff - which days are not working days.
 *
 * A table rather than seven bit columns on the shift, because alternate
 * Saturday working is two rows (weeks 2 and 4) and seven bits cannot say
 * that at all.
 */
export const ShiftWeekOff = defineModel({
  table: 'dbo.tblShiftWeekOff',
  columns: {
    shiftWeekOffId: { column: 'ShiftWeekOffId', type: sql.BigInt, identity: true },
    shiftId: { column: 'ShiftId', type: sql.BigInt },

    // 1 = Sunday ... 7 = Saturday. DAY_OF_WEEK in src/enums/attendance.enum.js.
    dayOfWeek: { column: 'DayOfWeek', type: sql.TinyInt },
    // NULL = every week. 1-5 pins it to the nth such weekday in the month.
    weekOfMonth: { column: 'WeekOfMonth', type: sql.TinyInt, nullable: true },

    ...auditColumns(),
  },
});

/** dbo.tblEmployeeShift - who works which shift, and from when. */
export const EmployeeShift = defineModel({
  table: 'dbo.tblEmployeeShift',
  columns: {
    employeeShiftId: { column: 'EmployeeShiftId', type: sql.BigInt, identity: true },

    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },
    shiftId: { column: 'ShiftId', type: sql.BigInt },

    ...effectiveColumns(),
    ...auditColumns(),
  },
});

/** Shift columns safe to hand back to a client. Audit columns are not. */
export const SHIFT_PUBLIC_PROPS = Object.freeze([
  'shiftId',
  'shiftCode',
  'shiftName',
  'locationId',
  'startTime',
  'endTime',
  'crossesMidnight',
  'breakMinutes',
  'graceInMinutes',
  'graceOutMinutes',
  'fullDayMinutes',
  'halfDayMinutes',
  'effectiveFrom',
  'effectiveTo',
  'isActive',
  'modifiedAt',
]);

export const SHIFT_WEEK_OFF_PUBLIC_PROPS = Object.freeze([
  'shiftWeekOffId',
  'shiftId',
  'dayOfWeek',
  'weekOfMonth',
]);

export const EMPLOYEE_SHIFT_PUBLIC_PROPS = Object.freeze([
  'employeeShiftId',
  'employeeDetailId',
  'shiftId',
  'effectiveFrom',
  'effectiveTo',
  'modifiedAt',
]);

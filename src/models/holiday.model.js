/**
 * The holiday tables: dbo.tblHolidayType, dbo.tblHoliday,
 * dbo.tblHolidayLocation, dbo.tblRestrictedHolidayMapping and
 * dbo.tblRestrictedHolidayOptIn.
 *
 * Mirrors db/migrations/017_holiday.sql.
 *
 * A holiday and its locations are two tables because New Year's Day is ONE
 * holiday observed in two offices. Storing LocationId on the holiday would
 * mean two rows that must be renamed and re-dated together, and that drift
 * apart the first time somebody edits one.
 *
 * tblHolidayType carries FIXED IDS owned by the code - HOLIDAY_TYPE in
 * src/enums/leave.enum.js - and is seeded by the migration itself, because
 * tblHoliday.HolidayTypeId is NOT NULL and has nothing to point at until
 * the two rows exist.
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

/** dbo.tblHolidayType - NORMAL and RESTRICTED. Fixed ids, seeded by 017. */
export const HolidayType = defineModel({
  table: 'dbo.tblHolidayType',
  columns: {
    holidayTypeId: { column: 'HolidayTypeId', type: sql.Int },
    typeCode: { column: 'TypeCode', type: sql.NVarChar(20) },
    typeName: { column: 'TypeName', type: sql.NVarChar(50) },
    description: { column: 'Description', type: sql.NVarChar(255), nullable: true },
    // 1 for RESTRICTED. Read instead of hard-coding "HolidayTypeId = 2".
    requiresOptIn: { column: 'RequiresOptIn', type: sql.Bit },
    isActive: { column: 'IsActive', type: sql.Bit },
    createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
    modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
  },
});

/** dbo.tblHoliday - a declared day, of one type, in one calendar year. */
export const Holiday = defineModel({
  table: 'dbo.tblHoliday',
  columns: {
    holidayId: { column: 'HolidayId', type: sql.BigInt, identity: true },

    holidayName: { column: 'HolidayName', type: sql.NVarChar(150) },
    holidayDate: { column: 'HolidayDate', type: sql.Date },
    holidayTypeId: { column: 'HolidayTypeId', type: sql.Int },

    /*
      Redundant with YEAR(HolidayDate) and kept anyway: every list query
      filters on it, and a filter on YEAR(HolidayDate) is not sargable - it
      would turn the calendar screen into a table scan. Kept honest by
      CK_tblHoliday_YearMatchesDate.
    */
    holidayYear: { column: 'HolidayYear', type: sql.SmallInt },

    description: { column: 'Description', type: sql.NVarChar(500), nullable: true },

    // Switched off rather than removed when a holiday is cancelled:
    // attendance rows point at it and must still resolve to a name.
    isActive: { column: 'IsActive', type: sql.Bit },

    ...auditColumns(),
  },
});

/** dbo.tblHolidayLocation - which offices observe it. */
export const HolidayLocation = defineModel({
  table: 'dbo.tblHolidayLocation',
  columns: {
    holidayLocationId: { column: 'HolidayLocationId', type: sql.BigInt, identity: true },
    holidayId: { column: 'HolidayId', type: sql.BigInt },
    locationId: { column: 'LocationId', type: sql.BigInt },
    ...auditColumns(),
  },
});

/**
 * dbo.tblRestrictedHolidayMapping - which cohort gets the restricted list,
 * and how many picks.
 *
 * "Restricted Mapping" in the requirement list means mapping the restricted
 * holidays TO EMPLOYEES. It is not a blackout or a concurrency rule.
 */
export const RestrictedHolidayMapping = defineModel({
  table: 'dbo.tblRestrictedHolidayMapping',
  columns: {
    restrictedHolidayMappingId: {
      column: 'RestrictedHolidayMappingId',
      type: sql.BigInt,
      identity: true,
    },

    // Both NULL = every employee, everywhere. The usual case.
    locationId: { column: 'LocationId', type: sql.BigInt, nullable: true },
    employmentType: { column: 'EmploymentType', type: sql.NVarChar(30), nullable: true },

    // Always a CALENDAR cycle - the floating holiday year is Jan to Dec.
    leaveCycleId: { column: 'LeaveCycleId', type: sql.BigInt },

    // 1 per the HR document. A column so two picks next year is config.
    pickQuota: { column: 'PickQuota', type: sql.TinyInt },

    isActive: { column: 'IsActive', type: sql.Bit },

    ...auditColumns(),
  },
});

/** dbo.tblRestrictedHolidayOptIn - the employee's pick, one per cycle. */
export const RestrictedHolidayOptIn = defineModel({
  table: 'dbo.tblRestrictedHolidayOptIn',
  columns: {
    restrictedHolidayOptInId: {
      column: 'RestrictedHolidayOptInId',
      type: sql.BigInt,
      identity: true,
    },

    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },
    holidayId: { column: 'HolidayId', type: sql.BigInt },
    leaveCycleId: { column: 'LeaveCycleId', type: sql.BigInt },

    // OPT_IN_STATUS in src/enums/leave.enum.js.
    status: { column: 'Status', type: sql.NVarChar(20) },
    reason: { column: 'Reason', type: sql.NVarChar(500), nullable: true },

    approvedBy: { column: 'ApprovedBy', type: sql.BigInt, nullable: true },
    approvedAt: { column: 'ApprovedAt', type: sql.DateTime2, nullable: true },
    approverRemarks: { column: 'ApproverRemarks', type: sql.NVarChar(500), nullable: true },

    ...auditColumns(),
  },
});

/* ------------------------------------------------------------------------- */

export const HOLIDAY_PUBLIC_PROPS = Object.freeze([
  'holidayId',
  'holidayName',
  'holidayDate',
  'holidayTypeId',
  'holidayYear',
  'description',
  'isActive',
  'modifiedAt',
]);

export const HOLIDAY_TYPE_PUBLIC_PROPS = Object.freeze([
  'holidayTypeId',
  'typeCode',
  'typeName',
  'description',
  'requiresOptIn',
  'isActive',
]);

export const RESTRICTED_HOLIDAY_MAPPING_PUBLIC_PROPS = Object.freeze([
  'restrictedHolidayMappingId',
  'locationId',
  'employmentType',
  'leaveCycleId',
  'pickQuota',
  'isActive',
  'modifiedAt',
]);

export const RESTRICTED_HOLIDAY_OPT_IN_PUBLIC_PROPS = Object.freeze([
  'restrictedHolidayOptInId',
  'employeeDetailId',
  'holidayId',
  'leaveCycleId',
  'status',
  'reason',
  'approvedBy',
  'approvedAt',
  'approverRemarks',
  'createdAt',
  'modifiedAt',
]);

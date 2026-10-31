/**
 * The five master-data tables: dbo.tblParentDepartment, dbo.tblDepartment,
 * dbo.tblDesignation, dbo.tblLeaveType and dbo.tblCategory.
 *
 * Mirrors db/migrations/009_master_data.sql. One file because they are one
 * feature and one shape: Name, Description, IsActive and the audit columns,
 * with nothing table-specific except tblDepartment's ParentDepartmentId.
 *
 * `masterColumns()` is a FUNCTION rather than a shared frozen object so the
 * five tables cannot accidentally share one mutable column descriptor - the
 * same reasoning as addressColumns() in organization.model.js.
 *
 * Soft delete: every read path must filter `WHERE DeletedAt IS NULL`. Nothing
 * here is ever DELETEd - tblEmployeeDetails.DepartmentId and .DesignationId
 * carry real foreign keys into two of these tables.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

/** Audit and soft-delete columns, identical on all five tables. */
const auditColumns = () => ({
  createdBy: { column: 'CreatedBy', type: sql.BigInt, nullable: true },
  modifiedBy: { column: 'ModifiedBy', type: sql.BigInt, nullable: true },
  createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
  modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
  // NULL means live.
  deletedAt: { column: 'DeletedAt', type: sql.DateTime2, nullable: true },
});

/** The three columns every master list has, plus the audit block. */
const masterColumns = () => ({
  name: { column: 'Name', type: sql.NVarChar(150) },
  description: { column: 'Description', type: sql.NVarChar(500), nullable: true },
  isActive: { column: 'IsActive', type: sql.Bit },
  ...auditColumns(),
});

/** dbo.tblParentDepartment - the top of the department tree. */
export const ParentDepartment = defineModel({
  table: 'dbo.tblParentDepartment',
  columns: {
    parentDepartmentId: { column: 'ParentDepartmentId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblDepartment. NULL ParentDepartmentId is a department with no parent. */
export const Department = defineModel({
  table: 'dbo.tblDepartment',
  columns: {
    departmentId: { column: 'DepartmentId', type: sql.BigInt, identity: true },
    parentDepartmentId: { column: 'ParentDepartmentId', type: sql.BigInt, nullable: true },
    ...masterColumns(),
  },
});

/** dbo.tblDesignation - job titles. */
export const Designation = defineModel({
  table: 'dbo.tblDesignation',
  columns: {
    designationId: { column: 'DesignationId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblLeaveType - IsActive carries the export's "enabled" flag. */
export const LeaveType = defineModel({
  table: 'dbo.tblLeaveType',
  columns: {
    leaveTypeId: { column: 'LeaveTypeId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblCategory - help-desk and announcement categories. */
export const Category = defineModel({
  table: 'dbo.tblCategory',
  columns: {
    categoryId: { column: 'CategoryId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/**
 * What a master row hands back to a client, after its own id.
 *
 * The audit columns are deliberately absent, exactly as they are for an
 * organisation. `modifiedAt` is carried so a client can detect a stale edit.
 */
export const MASTER_DATA_PUBLIC_PROPS = Object.freeze([
  'name',
  'description',
  'isActive',
  'modifiedAt',
]);

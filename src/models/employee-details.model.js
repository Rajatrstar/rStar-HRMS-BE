/**
 * dbo.tblEmployeeDetails - the HR record for a person.
 *
 * Mirrors db/migrations/001_employee_details.sql. THE employee table: every
 * role, permission and audit column in this schema keys on employeeDetailId.
 * Credentials live in dbo.EmployeeLogin, which points here - not the reverse,
 * so there is no nullable link column on this side any more.
 *
 * Soft delete: every read path must filter `WHERE DeletedAt IS NULL`. Nothing
 * in this table is ever DELETEd.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

export const EmployeeDetails = defineModel({
  table: 'dbo.tblEmployeeDetails',
  columns: {
    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt, identity: true },

    employeeCode: { column: 'EmployeeCode', type: sql.NVarChar(50) },

    firstName: { column: 'FirstName', type: sql.NVarChar(100) },
    middleName: { column: 'MiddleName', type: sql.NVarChar(100), nullable: true },
    lastName: { column: 'LastName', type: sql.NVarChar(100) },

    workEmail: { column: 'WorkEmail', type: sql.NVarChar(255) },
    personalEmail: { column: 'PersonalEmail', type: sql.NVarChar(255), nullable: true },
    phone: { column: 'Phone', type: sql.NVarChar(20), nullable: true },

    dateOfBirth: { column: 'DateOfBirth', type: sql.Date, nullable: true },
    gender: { column: 'Gender', type: sql.NVarChar(30), nullable: true },
    address: { column: 'Address', type: sql.NVarChar(sql.MAX), nullable: true },

    // No FOREIGN KEY yet - the referenced tables do not exist. See the
    // migration header.
    departmentId: { column: 'DepartmentId', type: sql.BigInt, nullable: true },
    designationId: { column: 'DesignationId', type: sql.BigInt, nullable: true },
    workLocationId: { column: 'WorkLocationId', type: sql.BigInt, nullable: true },
    workLocation: { column: 'WorkLocation', type: sql.NVarChar(150), nullable: true },

    managerId: { column: 'ManagerId', type: sql.BigInt, nullable: true },

    // Values from EMPLOYMENT_TYPE / EMPLOYMENT_STATUS in src/enums.
    employmentType: { column: 'EmploymentType', type: sql.NVarChar(30) },
    employmentStatus: { column: 'EmploymentStatus', type: sql.NVarChar(30) },

    dateOfJoining: { column: 'DateOfJoining', type: sql.Date },
    probationEndDate: { column: 'ProbationEndDate', type: sql.Date, nullable: true },
    dateOfLeaving: { column: 'DateOfLeaving', type: sql.Date, nullable: true },

    profilePhotoUrl: { column: 'ProfilePhotoUrl', type: sql.NVarChar(2048), nullable: true },

    isActive: { column: 'IsActive', type: sql.Bit },

    // EmployeeDetailIds, self-referencing.
    createdBy: { column: 'CreatedBy', type: sql.BigInt, nullable: true },
    modifiedBy: { column: 'ModifiedBy', type: sql.BigInt, nullable: true },

    createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
    modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
    // NULL means live.
    deletedAt: { column: 'DeletedAt', type: sql.DateTime2, nullable: true },
  },
});

/** Columns safe to hand back to a client. Audit columns are not among them. */
export const EMPLOYEE_DETAILS_PUBLIC_PROPS = Object.freeze([
  'employeeDetailId',
  'employeeCode',
  'firstName',
  'middleName',
  'lastName',
  'workEmail',
  'personalEmail',
  'phone',
  'dateOfBirth',
  'gender',
  'address',
  'departmentId',
  'designationId',
  'workLocationId',
  'workLocation',
  'managerId',
  'employmentType',
  'employmentStatus',
  'dateOfJoining',
  'probationEndDate',
  'dateOfLeaving',
  'profilePhotoUrl',
  'isActive',
]);

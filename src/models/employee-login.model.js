/**
 * dbo.EmployeeLogin - credentials and the in-progress second factor.
 *
 * Mirrors db/migrations/002_employee_login.sql. A satellite of
 * dbo.tblEmployeeDetails: employeeDetailId is NOT NULL, so a login always has
 * an employee behind it.
 *
 * `employeeId` is the credential's own key and the subject of NOTHING. Roles,
 * groups, overrides and every CreatedBy/ModifiedBy key on employeeDetailId,
 * and that is what the token carries.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

export const EmployeeLogin = defineModel({
  table: 'dbo.EmployeeLogin',
  columns: {
    employeeId: { column: 'EmployeeId', type: sql.Int, identity: true },

    // The person. NOT NULL - there is no such thing as a login without one.
    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },

    email: { column: 'Email', type: sql.NVarChar(256) },
    // bcrypt output is 60 characters; the column has room for a future rehash
    // to a longer format without a schema change.
    hashPassword: { column: 'HashPassword', type: sql.NVarChar(255) },

    // Both NULL whenever no login is in progress.
    otp: { column: 'Otp', type: sql.NVarChar(10), nullable: true },
    otpExpiresTime: { column: 'OtpExpiresTime', type: sql.DateTime2, nullable: true },

    lastLoginedAt: { column: 'LastLoginedAt', type: sql.DateTime2, nullable: true },

    createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
    modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
  },
});

/** The columns safe to hand back to a client: the hash and the OTP are not among them. */
export const EMPLOYEE_PUBLIC_PROPS = Object.freeze([
  'employeeId',
  'employeeDetailId',
  'email',
  'lastLoginedAt',
  'createdAt',
  'modifiedAt',
]);

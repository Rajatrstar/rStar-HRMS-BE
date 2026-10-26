/**
 * The access-control tables, all nine of them.
 *
 * Mirrors db/migrations/004_access_control.sql. They live in one file because
 * they are one feature and nothing reads a grant table without reading its
 * neighbours - splitting them into nine files would be nine imports at every
 * call site for no gain.
 *
 * Two things to know before writing SQL against these:
 *
 *   - `scopeRank` is a PERSISTED computed column. Read it, never write it;
 *     SQL Server rejects it in an INSERT column list. It is here so
 *     `npm run db:verify` does not warn about an unmapped column.
 *   - Subjects are keyed on dbo.EmployeeLogin.EmployeeId (INT). The profile
 *     table's EmployeeDetailId (BIGINT) is a different number, and row scope
 *     needs the translation - see src/helpers/access-scope.helper.js.
 *
 * Soft delete: every read path must filter `WHERE DeletedAt IS NULL`, except
 * tblAccessControlStamp, which has no such column.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

/** Audit and soft-delete columns, identical on eight of the nine tables. */
const auditColumns = () => ({
  createdBy: { column: 'CreatedBy', type: sql.Int, nullable: true },
  modifiedBy: { column: 'ModifiedBy', type: sql.Int, nullable: true },
  createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
  modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
  // NULL means live.
  deletedAt: { column: 'DeletedAt', type: sql.DateTime2, nullable: true },
});

/** A grant's reach, plus the derived rank the resolver aggregates on. */
const scopeColumns = (nullable = false) => ({
  scope: { column: 'Scope', type: sql.NVarChar(20), nullable },
  // PERSISTED computed. Never include it in an INSERT.
  scopeRank: { column: 'ScopeRank', type: sql.Int, nullable: true },
});

/** dbo.tblPermission - the catalog, written only by scripts/seed-permissions.js. */
export const Permission = defineModel({
  table: 'dbo.tblPermission',
  columns: {
    permissionId: { column: 'PermissionId', type: sql.BigInt, identity: true },

    permissionCode: { column: 'PermissionCode', type: sql.NVarChar(100) },
    module: { column: 'Module', type: sql.NVarChar(50) },
    action: { column: 'Action', type: sql.NVarChar(50) },
    description: { column: 'Description', type: sql.NVarChar(255) },

    isScoped: { column: 'IsScoped', type: sql.Bit },
    defaultScope: { column: 'DefaultScope', type: sql.NVarChar(20), nullable: true },

    ...auditColumns(),
  },
});

/** dbo.tblRole - the five master roles plus anything an admin creates. */
export const Role = defineModel({
  table: 'dbo.tblRole',
  columns: {
    roleId: { column: 'RoleId', type: sql.BigInt, identity: true },

    roleCode: { column: 'RoleCode', type: sql.NVarChar(50) },
    roleName: { column: 'RoleName', type: sql.NVarChar(100) },
    description: { column: 'Description', type: sql.NVarChar(255), nullable: true },

    // A system role cannot be renamed or deleted. Its permissions can still
    // be edited - that is the feature, not a loophole.
    isSystem: { column: 'IsSystem', type: sql.Bit },
    isActive: { column: 'IsActive', type: sql.Bit },

    ...auditColumns(),
  },
});

/** dbo.tblGroup - a bundle of permissions several people share. */
export const Group = defineModel({
  table: 'dbo.tblGroup',
  columns: {
    groupId: { column: 'GroupId', type: sql.BigInt, identity: true },

    groupCode: { column: 'GroupCode', type: sql.NVarChar(50) },
    groupName: { column: 'GroupName', type: sql.NVarChar(100) },
    description: { column: 'Description', type: sql.NVarChar(255), nullable: true },

    isActive: { column: 'IsActive', type: sql.Bit },

    ...auditColumns(),
  },
});

/** dbo.tblRolePermission - what a role may do, and how far. */
export const RolePermission = defineModel({
  table: 'dbo.tblRolePermission',
  columns: {
    rolePermissionId: { column: 'RolePermissionId', type: sql.BigInt, identity: true },

    roleId: { column: 'RoleId', type: sql.BigInt },
    permissionId: { column: 'PermissionId', type: sql.BigInt },

    ...scopeColumns(),
    ...auditColumns(),
  },
});

/** dbo.tblGroupPermission - the same, for a group. */
export const GroupPermission = defineModel({
  table: 'dbo.tblGroupPermission',
  columns: {
    groupPermissionId: { column: 'GroupPermissionId', type: sql.BigInt, identity: true },

    groupId: { column: 'GroupId', type: sql.BigInt },
    permissionId: { column: 'PermissionId', type: sql.BigInt },

    ...scopeColumns(),
    ...auditColumns(),
  },
});

/** dbo.tblEmployeeRole - which roles a login holds. */
export const EmployeeRole = defineModel({
  table: 'dbo.tblEmployeeRole',
  columns: {
    employeeRoleId: { column: 'EmployeeRoleId', type: sql.BigInt, identity: true },

    // dbo.EmployeeLogin.EmployeeId, not EmployeeDetailId.
    employeeId: { column: 'EmployeeId', type: sql.Int },
    roleId: { column: 'RoleId', type: sql.BigInt },

    ...auditColumns(),
  },
});

/** dbo.tblEmployeeGroup - which groups a login belongs to. */
export const EmployeeGroup = defineModel({
  table: 'dbo.tblEmployeeGroup',
  columns: {
    employeeGroupId: { column: 'EmployeeGroupId', type: sql.BigInt, identity: true },

    employeeId: { column: 'EmployeeId', type: sql.Int },
    groupId: { column: 'GroupId', type: sql.BigInt },

    ...auditColumns(),
  },
});

/**
 * dbo.tblEmployeePermission - the per-user exception.
 *
 * `scope` is nullable here and nowhere else: a DENY carries none, because it
 * removes the permission outright rather than narrowing it.
 */
export const EmployeePermission = defineModel({
  table: 'dbo.tblEmployeePermission',
  columns: {
    employeePermissionId: { column: 'EmployeePermissionId', type: sql.BigInt, identity: true },

    employeeId: { column: 'EmployeeId', type: sql.Int },
    permissionId: { column: 'PermissionId', type: sql.BigInt },

    effect: { column: 'Effect', type: sql.NVarChar(10) },
    ...scopeColumns(true),

    reason: { column: 'Reason', type: sql.NVarChar(255), nullable: true },
    expiresAt: { column: 'ExpiresAt', type: sql.DateTime2, nullable: true },

    ...auditColumns(),
  },
});

/**
 * dbo.tblAccessControlStamp - one row, bumped by every admin write.
 *
 * No audit or soft-delete columns: it is bookkeeping, not data.
 */
export const AccessControlStamp = defineModel({
  table: 'dbo.tblAccessControlStamp',
  columns: {
    stampId: { column: 'StampId', type: sql.BigInt, identity: true },
    stampName: { column: 'StampName', type: sql.NVarChar(50) },
    version: { column: 'Version', type: sql.BigInt },
    modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
  },
});

/** The single stamp row's name. There is only ever one. */
export const GLOBAL_STAMP = 'global';

/** Role columns safe to hand back to a client. Audit columns are not among them. */
export const ROLE_PUBLIC_PROPS = Object.freeze([
  'roleId',
  'roleCode',
  'roleName',
  'description',
  'isSystem',
  'isActive',
  'modifiedAt',
]);

/** Group columns safe to hand back to a client. */
export const GROUP_PUBLIC_PROPS = Object.freeze([
  'groupId',
  'groupCode',
  'groupName',
  'description',
  'isActive',
  'modifiedAt',
]);

/** Catalog columns the permission-matrix screen needs. */
export const PERMISSION_PUBLIC_PROPS = Object.freeze([
  'permissionId',
  'permissionCode',
  'module',
  'action',
  'description',
  'isScoped',
  'defaultScope',
]);

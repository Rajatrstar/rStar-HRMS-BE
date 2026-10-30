/**
 * The access-control tables: three of them, plus the cache stamp.
 *
 * Mirrors db/migrations/008_group_access_control.sql. The model is small
 * because the rule is small - a GROUP holds rights on a MODULE, and an
 * employee belongs to a GROUP. The nine tables this replaced are described
 * in 008's header, along with why they went.
 *
 * Soft delete: dbo.tblGroup carries DeletedAt and every read path must filter
 * `WHERE DeletedAt IS NULL`. tblModule, tblAccessRight and the stamp do not -
 * a module is retired by clearing IsActive, a right is removed by clearing
 * its flags, and the stamp is bookkeeping.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

/** Audit columns, identical on the three real tables. */
const auditColumns = () => ({
  createdBy: { column: 'CreatedBy', type: sql.BigInt, nullable: true },
  modifiedBy: { column: 'ModifiedBy', type: sql.BigInt, nullable: true },
  createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
  modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
});

/**
 * dbo.tblModule - the catalog, written only by scripts/seed-modules.js.
 *
 * ModuleId is NOT an identity: the ids come from MODULE in
 * src/enums/module.enum.js and are part of the contract. See that file.
 */
export const Module = defineModel({
  table: 'dbo.tblModule',
  columns: {
    moduleId: { column: 'ModuleId', type: sql.Int },

    moduleCode: { column: 'ModuleCode', type: sql.NVarChar(60) },
    moduleName: { column: 'ModuleName', type: sql.NVarChar(100) },
    description: { column: 'Description', type: sql.NVarChar(255), nullable: true },

    // Menu shape. A row with no routePath is a heading, not a page.
    parentModuleId: { column: 'ParentModuleId', type: sql.Int, nullable: true },
    routePath: { column: 'RoutePath', type: sql.NVarChar(150), nullable: true },
    icon: { column: 'Icon', type: sql.NVarChar(60), nullable: true },
    sortOrder: { column: 'SortOrder', type: sql.Int },

    showInMenu: { column: 'ShowInMenu', type: sql.Bit },
    isActive: { column: 'IsActive', type: sql.Bit },

    ...auditColumns(),
  },
});

/** dbo.tblGroup - what an administrator creates and names. */
export const Group = defineModel({
  table: 'dbo.tblGroup',
  columns: {
    groupId: { column: 'GroupId', type: sql.Int, identity: true },

    groupName: { column: 'GroupName', type: sql.NVarChar(100) },
    description: { column: 'Description', type: sql.NVarChar(255), nullable: true },

    // A system group cannot be renamed, stripped or deleted.
    isSystem: { column: 'IsSystem', type: sql.Bit },
    isActive: { column: 'IsActive', type: sql.Bit },

    ...auditColumns(),
    // NULL means live.
    deletedAt: { column: 'DeletedAt', type: sql.DateTime2, nullable: true },
  },
});

/** dbo.tblAccessRight - one row per group per module. The matrix. */
export const AccessRight = defineModel({
  table: 'dbo.tblAccessRight',
  columns: {
    accessId: { column: 'AccessId', type: sql.BigInt, identity: true },

    groupId: { column: 'GroupId', type: sql.Int },
    moduleId: { column: 'ModuleId', type: sql.Int },

    canView: { column: 'CanView', type: sql.Bit },
    canAdd: { column: 'CanAdd', type: sql.Bit },
    canEdit: { column: 'CanEdit', type: sql.Bit },
    canDelete: { column: 'CanDelete', type: sql.Bit },
    canPrint: { column: 'CanPrint', type: sql.Bit },
    canMail: { column: 'CanMail', type: sql.Bit },

    ...auditColumns(),
  },
});

/**
 * dbo.tblAccessControlStamp - one row, bumped by every rights write.
 *
 * Survives from 004 unchanged. No audit columns: it is bookkeeping, not data.
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

/** Module columns safe to hand back to a client. Audit columns are not among them. */
export const MODULE_PUBLIC_PROPS = Object.freeze([
  'moduleId',
  'moduleCode',
  'moduleName',
  'description',
  'parentModuleId',
  'routePath',
  'icon',
  'sortOrder',
  'showInMenu',
  'isActive',
]);

/** Group columns safe to hand back to a client. */
export const GROUP_PUBLIC_PROPS = Object.freeze([
  'groupId',
  'groupName',
  'description',
  'isSystem',
  'isActive',
  'createdAt',
  'modifiedAt',
]);

/** The six right flags, in the order the group screen shows them. */
export const RIGHT_PROPS = Object.freeze([
  'canView',
  'canAdd',
  'canEdit',
  'canDelete',
  'canPrint',
  'canMail',
]);

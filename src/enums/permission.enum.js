/**
 * The permission catalog - the single source of truth for what this API can
 * check.
 *
 * `scripts/seed-permissions.js` syncs PERMISSION_CATALOG into dbo.tblPermission;
 * nothing else writes that table, and there is no endpoint that creates a
 * permission. A permission only means something because a route passes its code
 * to requirePermission(), so one invented through an admin screen would be a
 * permission nothing checks.
 *
 * Adding a permission is three steps: add the code to PERMISSION, add its entry
 * to PERMISSION_CATALOG, and run `npm run db:seed:permissions`. Removing one is
 * the same in reverse - the seed retires the row rather than deleting it,
 * because role and group grants still point at its id.
 */

/**
 * How far a grant reaches across rows.
 *
 * Mirrored by CK_tblRolePermission_Scope and its siblings in
 * db/migrations/004_access_control.sql. Widening this list means a migration,
 * which is the point.
 */
export const PERMISSION_SCOPE = Object.freeze({
  /** The actor's own record, and nothing else. */
  OWN: 'OWN',
  /** The actor plus their direct reports. One level, not the whole tree. */
  TEAM: 'TEAM',
  /** Everybody sharing the actor's DepartmentId. */
  DEPARTMENT: 'DEPARTMENT',
  /** The whole organisation. */
  ALL: 'ALL',
});

/**
 * Scope ordering, widest last.
 *
 * Mirrors the PERSISTED computed `ScopeRank` columns in the migration. When
 * several sources grant the same permission the effective scope is the highest
 * rank, which is why the database can resolve it with a plain MAX().
 *
 * Changing a number here means changing the computed column too - deliberately.
 */
export const PERMISSION_SCOPE_RANK = Object.freeze({
  [PERMISSION_SCOPE.OWN]: 1,
  [PERMISSION_SCOPE.TEAM]: 2,
  [PERMISSION_SCOPE.DEPARTMENT]: 3,
  [PERMISSION_SCOPE.ALL]: 4,
});

/** Whether a per-user override adds a permission or takes it away. */
export const OVERRIDE_EFFECT = Object.freeze({
  GRANT: 'GRANT',
  /**
   * Absolute removal. A DENY carries no scope (CK_tblEmployeePermission_Scope
   * enforces NULL) because it does not narrow anything - it removes the
   * permission whatever a role or group granted.
   */
  DENY: 'DENY',
});

/**
 * The module half of every permission code, and the grouping the admin UI and
 * the frontend menu are built from.
 */
export const PERMISSION_MODULE = Object.freeze({
  PROFILE: 'profile',
  EMPLOYEES: 'employees',
  EMPLOYEE_DOCUMENT: 'employee-document',
  ATTENDANCE: 'attendance',
  LEAVE: 'leave',
  PAYROLL: 'payroll',
  PAYSLIP: 'payslip',
  DEPARTMENT: 'department',
  DESIGNATION: 'designation',
  ANNOUNCEMENT: 'announcement',
  REPORT: 'report',
  ORGANIZATION: 'organization',
  ORGANIZATION_LOCATION: 'organization-location',
  ROLES: 'roles',
  PERMISSIONS: 'permissions',
  GROUPS: 'groups',
  USER_ACCESS: 'user-access',
});

/**
 * Every permission code. Routes reference these constants, never the string.
 *
 * Codes are `module.action`, lowercase - CK_tblPermission_CodeShape rejects
 * anything else, because the database collation is case-insensitive while the
 * JS Map the resolver builds is not.
 */
export const PERMISSION = Object.freeze({
  PROFILE_VIEW: 'profile.view',
  PROFILE_UPDATE: 'profile.update',

  EMPLOYEES_VIEW: 'employees.view',
  EMPLOYEES_CREATE: 'employees.create',
  EMPLOYEES_UPDATE: 'employees.update',
  EMPLOYEES_DELETE: 'employees.delete',
  EMPLOYEES_EXPORT: 'employees.export',

  EMPLOYEE_DOCUMENT_VIEW: 'employee-document.view',
  EMPLOYEE_DOCUMENT_UPLOAD: 'employee-document.upload',
  EMPLOYEE_DOCUMENT_DELETE: 'employee-document.delete',

  ATTENDANCE_VIEW: 'attendance.view',
  ATTENDANCE_MARK: 'attendance.mark',
  ATTENDANCE_REGULARIZE: 'attendance.regularize',
  ATTENDANCE_APPROVE: 'attendance.approve',
  ATTENDANCE_EXPORT: 'attendance.export',

  LEAVE_VIEW: 'leave.view',
  LEAVE_APPLY: 'leave.apply',
  LEAVE_CANCEL: 'leave.cancel',
  LEAVE_APPROVE: 'leave.approve',
  LEAVE_CONFIGURE: 'leave.configure',

  PAYROLL_VIEW: 'payroll.view',
  PAYROLL_PROCESS: 'payroll.process',
  PAYROLL_CONFIGURE: 'payroll.configure',

  PAYSLIP_VIEW: 'payslip.view',
  PAYSLIP_DOWNLOAD: 'payslip.download',

  DEPARTMENT_VIEW: 'department.view',
  DEPARTMENT_CREATE: 'department.create',
  DEPARTMENT_UPDATE: 'department.update',
  DEPARTMENT_DELETE: 'department.delete',

  DESIGNATION_VIEW: 'designation.view',
  DESIGNATION_CREATE: 'designation.create',
  DESIGNATION_UPDATE: 'designation.update',
  DESIGNATION_DELETE: 'designation.delete',

  ANNOUNCEMENT_VIEW: 'announcement.view',
  ANNOUNCEMENT_CREATE: 'announcement.create',
  ANNOUNCEMENT_UPDATE: 'announcement.update',
  ANNOUNCEMENT_DELETE: 'announcement.delete',

  REPORT_HEADCOUNT: 'report.headcount',
  REPORT_ATTENDANCE: 'report.attendance',
  REPORT_PAYROLL: 'report.payroll',

  // There is deliberately no organization.delete. Deleting the organisation
  // this HRMS belongs to is not an operation, it is a decommission - and an
  // endpoint nobody should be able to reach by holding a permission.
  ORGANIZATION_VIEW: 'organization.view',
  ORGANIZATION_CREATE: 'organization.create',
  ORGANIZATION_UPDATE: 'organization.update',

  ORGANIZATION_LOCATION_VIEW: 'organization-location.view',
  ORGANIZATION_LOCATION_CREATE: 'organization-location.create',
  ORGANIZATION_LOCATION_UPDATE: 'organization-location.update',
  ORGANIZATION_LOCATION_DELETE: 'organization-location.delete',

  ROLES_VIEW: 'roles.view',
  ROLES_CREATE: 'roles.create',
  ROLES_UPDATE: 'roles.update',
  ROLES_DELETE: 'roles.delete',
  ROLES_ASSIGN_PERMISSION: 'roles.assign-permission',

  PERMISSIONS_VIEW: 'permissions.view',

  GROUPS_VIEW: 'groups.view',
  GROUPS_CREATE: 'groups.create',
  GROUPS_UPDATE: 'groups.update',
  GROUPS_DELETE: 'groups.delete',
  GROUPS_MANAGE_MEMBER: 'groups.manage-member',
  GROUPS_ASSIGN_PERMISSION: 'groups.assign-permission',

  USER_ACCESS_VIEW: 'user-access.view',
  USER_ACCESS_ASSIGN_ROLE: 'user-access.assign-role',
  USER_ACCESS_MANAGE_GROUP: 'user-access.manage-group',
  USER_ACCESS_OVERRIDE: 'user-access.override',
});

/** Display name and ordering per module, for the catalog and the client menu. */
export const PERMISSION_MODULE_META = Object.freeze({
  [PERMISSION_MODULE.PROFILE]: { name: 'My profile', sortOrder: 10 },
  [PERMISSION_MODULE.EMPLOYEES]: { name: 'Employees', sortOrder: 20 },
  [PERMISSION_MODULE.EMPLOYEE_DOCUMENT]: { name: 'Employee documents', sortOrder: 30 },
  [PERMISSION_MODULE.ATTENDANCE]: { name: 'Attendance', sortOrder: 40 },
  [PERMISSION_MODULE.LEAVE]: { name: 'Leave', sortOrder: 50 },
  [PERMISSION_MODULE.PAYROLL]: { name: 'Payroll', sortOrder: 60 },
  [PERMISSION_MODULE.PAYSLIP]: { name: 'Payslips', sortOrder: 70 },
  [PERMISSION_MODULE.DEPARTMENT]: { name: 'Departments', sortOrder: 80 },
  [PERMISSION_MODULE.DESIGNATION]: { name: 'Designations', sortOrder: 90 },
  [PERMISSION_MODULE.ANNOUNCEMENT]: { name: 'Announcements', sortOrder: 100 },
  [PERMISSION_MODULE.REPORT]: { name: 'Reports', sortOrder: 110 },
  [PERMISSION_MODULE.ORGANIZATION]: { name: 'Organization', sortOrder: 120 },
  [PERMISSION_MODULE.ORGANIZATION_LOCATION]: { name: 'Organization locations', sortOrder: 130 },
  [PERMISSION_MODULE.ROLES]: { name: 'Roles', sortOrder: 200 },
  [PERMISSION_MODULE.PERMISSIONS]: { name: 'Permissions', sortOrder: 210 },
  [PERMISSION_MODULE.GROUPS]: { name: 'Groups', sortOrder: 220 },
  [PERMISSION_MODULE.USER_ACCESS]: { name: 'User access', sortOrder: 230 },
});

/**
 * Shorthand for a catalog row. `scoped` defaults to false: a permission is
 * scoped only when it reads or writes rows that belong to somebody, which is
 * the minority. Administering roles is not scoped - there is no "my role".
 */
function entry(code, description, { scoped = false, defaultScope = PERMISSION_SCOPE.OWN } = {}) {
  const [module, action] = code.split('.');
  return Object.freeze({
    code,
    module,
    action,
    description,
    isScoped: scoped,
    // Ignored when isScoped is false; the admin UI reads it to preselect the
    // dropdown when a permission is first ticked.
    defaultScope: scoped ? defaultScope : null,
  });
}

const SCOPED = { scoped: true };

/**
 * Every permission, in catalog order. The seed reads this; the
 * GET /permissions/catalog endpoint serves it grouped by module.
 */
export const PERMISSION_CATALOG = Object.freeze([
  entry(PERMISSION.PROFILE_VIEW, 'See your own profile', SCOPED),
  entry(PERMISSION.PROFILE_UPDATE, 'Edit your own profile', SCOPED),

  entry(PERMISSION.EMPLOYEES_VIEW, 'See employee records', SCOPED),
  entry(PERMISSION.EMPLOYEES_CREATE, 'Add an employee', SCOPED),
  entry(PERMISSION.EMPLOYEES_UPDATE, 'Edit an employee record', SCOPED),
  entry(PERMISSION.EMPLOYEES_DELETE, 'Remove an employee record', SCOPED),
  entry(PERMISSION.EMPLOYEES_EXPORT, 'Export employee data', SCOPED),

  entry(PERMISSION.EMPLOYEE_DOCUMENT_VIEW, 'See employee documents', SCOPED),
  entry(PERMISSION.EMPLOYEE_DOCUMENT_UPLOAD, 'Upload an employee document', SCOPED),
  entry(PERMISSION.EMPLOYEE_DOCUMENT_DELETE, 'Delete an employee document', SCOPED),

  entry(PERMISSION.ATTENDANCE_VIEW, 'See attendance records', SCOPED),
  entry(PERMISSION.ATTENDANCE_MARK, 'Mark attendance', SCOPED),
  entry(PERMISSION.ATTENDANCE_REGULARIZE, 'Raise an attendance correction', SCOPED),
  entry(PERMISSION.ATTENDANCE_APPROVE, 'Approve an attendance correction', SCOPED),
  entry(PERMISSION.ATTENDANCE_EXPORT, 'Export attendance data', SCOPED),

  entry(PERMISSION.LEAVE_VIEW, 'See leave requests', SCOPED),
  entry(PERMISSION.LEAVE_APPLY, 'Apply for leave', SCOPED),
  entry(PERMISSION.LEAVE_CANCEL, 'Cancel a leave request', SCOPED),
  entry(PERMISSION.LEAVE_APPROVE, 'Approve or reject leave', SCOPED),
  entry(PERMISSION.LEAVE_CONFIGURE, 'Configure leave types and balances'),

  entry(PERMISSION.PAYROLL_VIEW, 'See payroll data', SCOPED),
  entry(PERMISSION.PAYROLL_PROCESS, 'Run payroll', SCOPED),
  entry(PERMISSION.PAYROLL_CONFIGURE, 'Configure salary structures'),

  entry(PERMISSION.PAYSLIP_VIEW, 'See payslips', SCOPED),
  entry(PERMISSION.PAYSLIP_DOWNLOAD, 'Download a payslip', SCOPED),

  entry(PERMISSION.DEPARTMENT_VIEW, 'See departments'),
  entry(PERMISSION.DEPARTMENT_CREATE, 'Add a department'),
  entry(PERMISSION.DEPARTMENT_UPDATE, 'Edit a department'),
  entry(PERMISSION.DEPARTMENT_DELETE, 'Remove a department'),

  entry(PERMISSION.DESIGNATION_VIEW, 'See designations'),
  entry(PERMISSION.DESIGNATION_CREATE, 'Add a designation'),
  entry(PERMISSION.DESIGNATION_UPDATE, 'Edit a designation'),
  entry(PERMISSION.DESIGNATION_DELETE, 'Remove a designation'),

  entry(PERMISSION.ANNOUNCEMENT_VIEW, 'See announcements'),
  entry(PERMISSION.ANNOUNCEMENT_CREATE, 'Post an announcement'),
  entry(PERMISSION.ANNOUNCEMENT_UPDATE, 'Edit an announcement'),
  entry(PERMISSION.ANNOUNCEMENT_DELETE, 'Remove an announcement'),

  entry(PERMISSION.REPORT_HEADCOUNT, 'View the headcount report', SCOPED),
  entry(PERMISSION.REPORT_ATTENDANCE, 'View the attendance report', SCOPED),
  entry(PERMISSION.REPORT_PAYROLL, 'View the payroll report', SCOPED),

  // Unscoped, all seven: there is no "my organisation" and no "my location"
  // the way there is a "my profile". Who may touch them is the whole question,
  // and a scope on top of that would answer nothing.
  entry(PERMISSION.ORGANIZATION_VIEW, 'See the organization profile'),
  entry(PERMISSION.ORGANIZATION_CREATE, 'Add an organization'),
  entry(PERMISSION.ORGANIZATION_UPDATE, 'Edit the organization profile'),

  entry(PERMISSION.ORGANIZATION_LOCATION_VIEW, 'See organization locations'),
  entry(PERMISSION.ORGANIZATION_LOCATION_CREATE, 'Add an organization location'),
  entry(PERMISSION.ORGANIZATION_LOCATION_UPDATE, 'Edit an organization location'),
  entry(PERMISSION.ORGANIZATION_LOCATION_DELETE, 'Remove an organization location'),

  entry(PERMISSION.ROLES_VIEW, 'See roles and their permissions'),
  entry(PERMISSION.ROLES_CREATE, 'Create a role'),
  entry(PERMISSION.ROLES_UPDATE, 'Rename or deactivate a role'),
  entry(PERMISSION.ROLES_DELETE, 'Delete a role'),
  entry(PERMISSION.ROLES_ASSIGN_PERMISSION, "Change a role's permissions"),

  entry(PERMISSION.PERMISSIONS_VIEW, 'See the permission catalog'),

  entry(PERMISSION.GROUPS_VIEW, 'See groups and their permissions'),
  entry(PERMISSION.GROUPS_CREATE, 'Create a group'),
  entry(PERMISSION.GROUPS_UPDATE, 'Rename or deactivate a group'),
  entry(PERMISSION.GROUPS_DELETE, 'Delete a group'),
  entry(PERMISSION.GROUPS_MANAGE_MEMBER, 'Add or remove group members'),
  entry(PERMISSION.GROUPS_ASSIGN_PERMISSION, "Change a group's permissions"),

  entry(PERMISSION.USER_ACCESS_VIEW, "See one person's roles, groups and overrides"),
  entry(PERMISSION.USER_ACCESS_ASSIGN_ROLE, 'Assign roles to a person'),
  entry(PERMISSION.USER_ACCESS_MANAGE_GROUP, 'Put a person in a group'),
  entry(PERMISSION.USER_ACCESS_OVERRIDE, 'Grant or deny a permission for one person'),
]);

/** Catalog rows by code, for the seed and the resolver's sanity checks. */
export const PERMISSION_BY_CODE = Object.freeze(
  Object.fromEntries(PERMISSION_CATALOG.map((row) => [row.code, row])),
);

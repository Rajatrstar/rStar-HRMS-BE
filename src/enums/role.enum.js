/**
 * The master roles and the permissions each one starts with.
 *
 * ROLE_PERMISSION_DEFAULTS is a starting point, not a running definition.
 * `scripts/seed-permissions.js` applies it only to a role it has just created;
 * re-applying it on every run would undo exactly the edits this whole feature
 * exists to allow. SUPER_ADMIN is the one exception and is always re-synced to
 * the full catalog.
 *
 * Mirrored by nothing in SQL: roles are rows, not a CHECK constraint, because
 * creating a sixth role must not need a migration.
 */
import { PERMISSION, PERMISSION_SCOPE } from './permission.enum.js';

const { OWN, TEAM, ALL } = PERMISSION_SCOPE;

/** Codes of the five roles the seed creates with IsSystem = 1. */
export const ROLE = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  HR_ADMIN: 'HR_ADMIN',
  HR_EXECUTIVE: 'HR_EXECUTIVE',
  MANAGER: 'MANAGER',
  EMPLOYEE: 'EMPLOYEE',
});

/** Display name and description per role, for the seed and the admin UI. */
export const ROLE_META = Object.freeze({
  [ROLE.SUPER_ADMIN]: {
    name: 'Super Admin',
    description: 'Full access, including role and permission administration',
  },
  [ROLE.HR_ADMIN]: {
    name: 'HR Admin',
    description: 'Full HR operations. Can assign roles but not change what a role may do',
  },
  [ROLE.HR_EXECUTIVE]: {
    name: 'HR Executive',
    description: 'Day-to-day employee record maintenance',
  },
  [ROLE.MANAGER]: {
    name: 'Manager',
    description: 'Visibility and approvals for direct reports. Held alongside Employee',
  },
  [ROLE.EMPLOYEE]: {
    name: 'Employee',
    description: 'Self-service only',
  },
});

/**
 * Starting permissions per role, as `{ permissionCode: scope }`.
 *
 * SUPER_ADMIN is deliberately absent: the seed gives it every live permission
 * at ALL, so a newly added catalog entry reaches it without an edit here.
 * There is no code path that treats Super Admin as special - it holds real
 * rows like every other role, which is what keeps the resolver on the path
 * that most manual testing exercises.
 */
export const ROLE_PERMISSION_DEFAULTS = Object.freeze({
  [ROLE.HR_ADMIN]: Object.freeze({
    [PERMISSION.PROFILE_VIEW]: OWN,
    [PERMISSION.PROFILE_UPDATE]: OWN,

    [PERMISSION.EMPLOYEES_VIEW]: ALL,
    [PERMISSION.EMPLOYEES_CREATE]: ALL,
    [PERMISSION.EMPLOYEES_UPDATE]: ALL,
    [PERMISSION.EMPLOYEES_DELETE]: ALL,
    [PERMISSION.EMPLOYEES_EXPORT]: ALL,

    [PERMISSION.EMPLOYEE_DOCUMENT_VIEW]: ALL,
    [PERMISSION.EMPLOYEE_DOCUMENT_UPLOAD]: ALL,
    [PERMISSION.EMPLOYEE_DOCUMENT_DELETE]: ALL,

    [PERMISSION.ATTENDANCE_VIEW]: ALL,
    [PERMISSION.ATTENDANCE_MARK]: OWN,
    [PERMISSION.ATTENDANCE_REGULARIZE]: ALL,
    [PERMISSION.ATTENDANCE_APPROVE]: ALL,
    [PERMISSION.ATTENDANCE_EXPORT]: ALL,

    [PERMISSION.LEAVE_VIEW]: ALL,
    [PERMISSION.LEAVE_APPLY]: OWN,
    [PERMISSION.LEAVE_CANCEL]: ALL,
    [PERMISSION.LEAVE_APPROVE]: ALL,
    [PERMISSION.LEAVE_CONFIGURE]: ALL,

    [PERMISSION.PAYROLL_VIEW]: ALL,
    [PERMISSION.PAYROLL_PROCESS]: ALL,

    [PERMISSION.PAYSLIP_VIEW]: ALL,
    [PERMISSION.PAYSLIP_DOWNLOAD]: ALL,

    [PERMISSION.DEPARTMENT_VIEW]: ALL,
    [PERMISSION.DEPARTMENT_CREATE]: ALL,
    [PERMISSION.DEPARTMENT_UPDATE]: ALL,
    [PERMISSION.DEPARTMENT_DELETE]: ALL,

    [PERMISSION.DESIGNATION_VIEW]: ALL,
    [PERMISSION.DESIGNATION_CREATE]: ALL,
    [PERMISSION.DESIGNATION_UPDATE]: ALL,
    [PERMISSION.DESIGNATION_DELETE]: ALL,

    [PERMISSION.ANNOUNCEMENT_VIEW]: ALL,
    [PERMISSION.ANNOUNCEMENT_CREATE]: ALL,
    [PERMISSION.ANNOUNCEMENT_UPDATE]: ALL,
    [PERMISSION.ANNOUNCEMENT_DELETE]: ALL,

    [PERMISSION.REPORT_HEADCOUNT]: ALL,
    [PERMISSION.REPORT_ATTENDANCE]: ALL,
    [PERMISSION.REPORT_PAYROLL]: ALL,

    // Organisation setup. HR Admin and Super Admin only, by request - every
    // other role gets nothing here, not even view. Widening it later is a
    // grant through the admin API, not a code change: that is the whole
    // reason these are permissions rather than a role check in the router.
    [PERMISSION.ORGANIZATION_VIEW]: ALL,
    [PERMISSION.ORGANIZATION_CREATE]: ALL,
    [PERMISSION.ORGANIZATION_UPDATE]: ALL,

    [PERMISSION.ORGANIZATION_LOCATION_VIEW]: ALL,
    [PERMISSION.ORGANIZATION_LOCATION_CREATE]: ALL,
    [PERMISSION.ORGANIZATION_LOCATION_UPDATE]: ALL,
    [PERMISSION.ORGANIZATION_LOCATION_DELETE]: ALL,

    // Read-only on roles, so the "assign a role" picker can list them - but
    // NOT roles.assign-permission. HR Admin can already assign roles; letting
    // them also edit what a role may do means they could add
    // payroll.configure to their own role. The two together are a wildcard
    // with extra steps, so the pair is deliberately split.
    [PERMISSION.ROLES_VIEW]: ALL,
    [PERMISSION.PERMISSIONS_VIEW]: ALL,

    [PERMISSION.GROUPS_VIEW]: ALL,
    [PERMISSION.GROUPS_CREATE]: ALL,
    [PERMISSION.GROUPS_UPDATE]: ALL,
    [PERMISSION.GROUPS_DELETE]: ALL,
    [PERMISSION.GROUPS_MANAGE_MEMBER]: ALL,
    [PERMISSION.GROUPS_ASSIGN_PERMISSION]: ALL,

    [PERMISSION.USER_ACCESS_VIEW]: ALL,
    [PERMISSION.USER_ACCESS_ASSIGN_ROLE]: ALL,
    [PERMISSION.USER_ACCESS_MANAGE_GROUP]: ALL,
    // user-access.override stays with Super Admin: an override bypasses the
    // role model entirely, so it should be rare and attributable.
  }),

  [ROLE.HR_EXECUTIVE]: Object.freeze({
    [PERMISSION.PROFILE_VIEW]: OWN,
    [PERMISSION.PROFILE_UPDATE]: OWN,

    [PERMISSION.EMPLOYEES_VIEW]: ALL,
    [PERMISSION.EMPLOYEES_CREATE]: ALL,
    [PERMISSION.EMPLOYEES_UPDATE]: ALL,

    [PERMISSION.EMPLOYEE_DOCUMENT_VIEW]: ALL,
    [PERMISSION.EMPLOYEE_DOCUMENT_UPLOAD]: ALL,

    [PERMISSION.ATTENDANCE_VIEW]: ALL,
    [PERMISSION.ATTENDANCE_MARK]: OWN,
    [PERMISSION.ATTENDANCE_REGULARIZE]: ALL,
    [PERMISSION.ATTENDANCE_EXPORT]: ALL,

    [PERMISSION.LEAVE_VIEW]: ALL,
    [PERMISSION.LEAVE_APPLY]: OWN,
    [PERMISSION.LEAVE_CANCEL]: OWN,

    [PERMISSION.DEPARTMENT_VIEW]: ALL,
    [PERMISSION.DESIGNATION_VIEW]: ALL,

    [PERMISSION.ANNOUNCEMENT_VIEW]: ALL,
    [PERMISSION.ANNOUNCEMENT_CREATE]: ALL,
    [PERMISSION.ANNOUNCEMENT_UPDATE]: ALL,

    [PERMISSION.REPORT_HEADCOUNT]: ALL,
    [PERMISSION.REPORT_ATTENDANCE]: ALL,
  }),

  /**
   * Manager is ADDITIVE and is meant to be held alongside Employee.
   *
   * It deliberately omits the self-service set (leave.apply, payslip.view and
   * so on): those come from the Employee role, and the widest-scope union then
   * produces leave.view at TEAM with leave.apply at OWN. Assigning Manager on
   * its own leaves a manager unable to book their own leave - the single most
   * likely onboarding mistake, which is why the seed asserts the pairing and
   * the admin UI warns about it.
   */
  [ROLE.MANAGER]: Object.freeze({
    [PERMISSION.EMPLOYEES_VIEW]: TEAM,
    [PERMISSION.EMPLOYEE_DOCUMENT_VIEW]: TEAM,

    [PERMISSION.ATTENDANCE_VIEW]: TEAM,
    [PERMISSION.ATTENDANCE_REGULARIZE]: TEAM,
    [PERMISSION.ATTENDANCE_APPROVE]: TEAM,
    [PERMISSION.ATTENDANCE_EXPORT]: TEAM,

    [PERMISSION.LEAVE_VIEW]: TEAM,
    [PERMISSION.LEAVE_APPROVE]: TEAM,

    [PERMISSION.REPORT_HEADCOUNT]: TEAM,
    [PERMISSION.REPORT_ATTENDANCE]: TEAM,
  }),

  [ROLE.EMPLOYEE]: Object.freeze({
    [PERMISSION.PROFILE_VIEW]: OWN,
    [PERMISSION.PROFILE_UPDATE]: OWN,

    [PERMISSION.EMPLOYEES_VIEW]: OWN,
    [PERMISSION.EMPLOYEE_DOCUMENT_VIEW]: OWN,
    [PERMISSION.EMPLOYEE_DOCUMENT_UPLOAD]: OWN,

    [PERMISSION.ATTENDANCE_VIEW]: OWN,
    [PERMISSION.ATTENDANCE_MARK]: OWN,
    [PERMISSION.ATTENDANCE_REGULARIZE]: OWN,

    [PERMISSION.LEAVE_VIEW]: OWN,
    [PERMISSION.LEAVE_APPLY]: OWN,
    [PERMISSION.LEAVE_CANCEL]: OWN,

    [PERMISSION.PAYSLIP_VIEW]: OWN,
    [PERMISSION.PAYSLIP_DOWNLOAD]: OWN,

    [PERMISSION.DEPARTMENT_VIEW]: ALL,
    [PERMISSION.DESIGNATION_VIEW]: ALL,
    [PERMISSION.ANNOUNCEMENT_VIEW]: ALL,
  }),
});

/**
 * The single authority on every path this API exposes.
 *
 * Nothing outside this file writes a route string. `app.js` mounts API_PREFIX,
 * `routes/index.js` mounts each ROUTE_GROUP, and each route file reads its own
 * endpoints out of ROUTES. Renaming an endpoint is a one-line change here.
 */

/** Mounted once, in app.js. Bump to /api/v2 when the contract breaks. */
export const API_PREFIX = '/api/v1';

/** Where each module's router mounts under the prefix. One entry per module. */
export const ROUTE_GROUP = Object.freeze({
  HEALTH: '/health',
  AUTH: '/auth',
  ORGANIZATIONS: '/organizations',
  // Access control administration. Four groups rather than one, because they
  // are four screens with four different permission families guarding them.
  PERMISSIONS: '/permissions',
  ROLES: '/roles',
  GROUPS: '/groups',
  ACCESS: '/access',
  // EMPLOYEES: '/employees',
});

/**
 * Endpoints within a group, relative to that group's mount point.
 * ROUTES.HEALTH.READINESS resolves to /api/v1/health/ready.
 */
export const ROUTES = Object.freeze({
  HEALTH: Object.freeze({
    LIVENESS: '/',
    READINESS: '/ready',
  }),
  AUTH: Object.freeze({
    LOGIN: '/login',
    VERIFY_OTP: '/verify-otp',
    RESEND_OTP: '/resend-otp',
    FORGOT_PASSWORD: '/forgot-password',
    RESET_PASSWORD: '/reset-password',
    REFRESH: '/refresh',
    ME: '/me',
  }),
  /**
   * Locations are nested under their organisation rather than mounted as a
   * group of their own, because a location only means anything as part of
   * one: the id in the path is what makes "rename this location" unambiguous
   * when two organisations both have a "Head Office".
   */
  ORGANIZATIONS: Object.freeze({
    LIST: '/',
    CREATE: '/',
    TYPES: '/types',
    DETAIL: '/:organizationId',
    UPDATE: '/:organizationId',

    LOCATION_LIST: '/:organizationId/locations',
    LOCATION_CREATE: '/:organizationId/locations',
    LOCATION_DETAIL: '/:organizationId/locations/:locationId',
    LOCATION_UPDATE: '/:organizationId/locations/:locationId',
    LOCATION_DELETE: '/:organizationId/locations/:locationId',
  }),
  /** Read-only. Permissions are code artefacts; there is no create. */
  PERMISSIONS: Object.freeze({
    CATALOG: '/catalog',
  }),
  ROLES: Object.freeze({
    LIST: '/',
    CREATE: '/',
    DETAIL: '/:roleId',
    UPDATE: '/:roleId',
    DELETE: '/:roleId',
    PERMISSIONS: '/:roleId/permissions',
    PERMISSIONS_REPLACE: '/:roleId/permissions',
  }),
  /**
   * Membership is add/remove, not a full replace like a role's permissions:
   * a group can hold hundreds of people and the screen is a picker, not a grid.
   */
  GROUPS: Object.freeze({
    LIST: '/',
    CREATE: '/',
    DETAIL: '/:groupId',
    UPDATE: '/:groupId',
    DELETE: '/:groupId',
    PERMISSIONS: '/:groupId/permissions',
    PERMISSIONS_REPLACE: '/:groupId/permissions',
    MEMBERS: '/:groupId/members',
    MEMBERS_ADD: '/:groupId/members',
    MEMBER_REMOVE: '/:groupId/members/:employeeDetailId',
  }),
  /**
   * One person's access. The id in the path is an EmployeeDetailId - the
   * subject every grant keys on - never a login id.
   */
  ACCESS: Object.freeze({
    MY_PERMISSIONS: '/my-permissions',
    USER: '/users/:employeeDetailId',
    USER_ROLES: '/users/:employeeDetailId/roles',
    USER_ROLES_REPLACE: '/users/:employeeDetailId/roles',
    USER_GROUPS: '/users/:employeeDetailId/groups',
    USER_GROUPS_REPLACE: '/users/:employeeDetailId/groups',
    USER_OVERRIDES: '/users/:employeeDetailId/overrides',
    USER_OVERRIDE_CREATE: '/users/:employeeDetailId/overrides',
    USER_OVERRIDE_UPDATE: '/users/:employeeDetailId/overrides/:overrideId',
    USER_OVERRIDE_DELETE: '/users/:employeeDetailId/overrides/:overrideId',
    USER_EFFECTIVE: '/users/:employeeDetailId/effective-permissions',
  }),
  // EMPLOYEES: Object.freeze({
  //   LIST: '/',
  //   CREATE: '/',
  //   DETAIL: '/:id',
  //   UPDATE: '/:id',
  //   DELETE: '/:id',
  // }),
});

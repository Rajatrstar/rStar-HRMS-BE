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
  EMPLOYEES: '/employees',
  ACCESS: '/access',
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
    LOGOUT: '/logout',
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

    /**
     * Master data: the five lookup lists the organisation screens choose
     * from, as sub-paths of this group - a department and a designation
     * belong to the company, not to one organisation row, so they sit beside
     * /organizations rather than under /organizations/:organizationId.
     *
     * RESOURCE holds where each list sits; COLLECTION and ITEM are the two
     * suffixes appended to one of those, so `/organizations/departments/:id`
     * is RESOURCE.DEPARTMENTS + ITEM. That is what lets the master-data
     * routes be wired from one loop without writing a path string.
     *
     * THESE MUST BE DECLARED BEFORE DETAIL below. Express matches in
     * declaration order, so with `/:organizationId` first, a GET of
     * /organizations/departments is read as organisation id "departments"
     * and dies in the validator with "must be a whole number" - the same
     * trap TYPES carries a note about.
     *
     * The id parameter is `:id` on all five, not `:departmentId`: the
     * handlers are shared, so a per-resource parameter name would have to be
     * read out of the registry by every one of them to find the same number.
     */
    MASTER_DATA: Object.freeze({
      RESOURCE: Object.freeze({
        PARENT_DEPARTMENTS: '/parent-departments',
        DEPARTMENTS: '/departments',
        DESIGNATIONS: '/designations',
        LEAVE_TYPES: '/leave-types',
        CATEGORIES: '/categories',
      }),

      /** The list itself: GET and POST. Empty, so the path is the resource. */
      COLLECTION: '',
      /** One row: GET, PUT and DELETE. */
      ITEM: '/:id',
    }),

    LOCATION_LIST: '/:organizationId/locations',
    LOCATION_CREATE: '/:organizationId/locations',
    LOCATION_DETAIL: '/:organizationId/locations/:locationId',
    LOCATION_UPDATE: '/:organizationId/locations/:locationId',
    LOCATION_DELETE: '/:organizationId/locations/:locationId',
  }),
  /**
   * Onboarding and the employee record.
   *
   * DEACTIVATE is its own endpoint rather than `isActive: false` on UPDATE.
   * Exiting somebody demands facts an edit does not - a leaving date and a
   * status - and refuses for reasons an edit never would, such as still
   * having direct reports. Folding it into UPDATE would mean one handler
   * whose required fields change depending on a flag in the body, which is
   * the shape that quietly lets an exit through with no date on it.
   */
  EMPLOYEES: Object.freeze({
    LIST: '/',
    CREATE: '/',
    DETAIL: '/:employeeDetailId',
    UPDATE: '/:employeeDetailId',
    DEACTIVATE: '/:employeeDetailId/deactivate',
    DELETE: '/:employeeDetailId',
  }),

  /**
   * Access control: the module catalog, groups and their rights, and who
   * is in which group.
   *
   * ME, MENU and PAGE are what the frontend calls on every login and every
   * navigation. They are deliberately NOT behind a module right - a user
   * who may see nothing still has to be told that, and a login that cannot
   * ask what it may do has nothing to render at all.
   */
  ACCESS: Object.freeze({
    ME: '/me',
    MENU: '/menu',
    PAGE: '/page',

    MODULES: '/modules',

    GROUP_LIST: '/groups',
    GROUP_CREATE: '/groups',
    GROUP_DETAIL: '/groups/:groupId',
    GROUP_UPDATE: '/groups/:groupId',
    GROUP_DELETE: '/groups/:groupId',
    GROUP_RIGHTS: '/groups/:groupId/rights',

    GROUP_MEMBERS: '/groups/:groupId/members',
    GROUP_MEMBERS_ASSIGN: '/groups/:groupId/members',
    EMPLOYEE_GROUP: '/employees/:employeeDetailId/group',
  }),
});
/**
 * The single authority on every path this API exposes.
 *
 * Nothing outside this file writes a route string. `app.js` mounts API_PREFIX,
 * `routes/index.js` mounts each ROUTE_GROUP, and each route file reads its own
 * endpoints out of ROUTES. Renaming an endpoint is a one-line change here.
 */

/** Mounted once, in app.js. Bump to /api/v2 when the contract breaks. */
export const API_PREFIX = '/api/v1';

/**
 * Where uploaded files are served from, under API_PREFIX. Also the start of
 * every FileUrl stored in the database, so a stored path is always a path
 * this API answers. Mounted in app.js behind a token and a module right -
 * these are government ID scans, never a public static folder.
 */
export const UPLOADS_PATH = Object.freeze({
  EMPLOYEES: '/uploads/employees',
});

/** Where each module's router mounts under the prefix. One entry per module. */
export const ROUTE_GROUP = Object.freeze({
  HEALTH: '/health',
  AUTH: '/auth',
  ORGANIZATIONS: '/organizations',
  EMPLOYEES: '/employees',
  ACCESS: '/access',
  ERROR_LOGS: '/error-logs',
  ATTENDANCE: '/attendance',
  LEAVE: '/leave',
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

        /* The employee-form dropdown lists - db/migrations/010. */
        GENDERS: '/genders',
        MARITAL_STATUSES: '/marital-statuses',
        RELATIONSHIPS: '/relationships',
        SKILLS: '/skills',
        EMPLOYMENT_TYPES: '/employment-types',
        JOB_ROLES: '/job-roles',
        EMPLOYEE_BANDS: '/employee-bands',
        WORK_LOCATION_COUNTRIES: '/work-location-countries',
        WORK_MODES: '/work-modes',
        BILLABILITY_TYPES: '/billability-types',
        PROJECT_CLIENTS: '/project-clients',
        COST_CENTERS: '/cost-centers',
        SOURCES_OF_HIRE: '/sources-of-hire',
        ONBOARDING_STATUSES: '/onboarding-statuses',
        BACKGROUND_VERIFICATION_STATUSES: '/background-verification-statuses',
        TAX_REGIMES: '/tax-regimes',
        GOVERNMENT_ID_TYPES: '/government-id-types',
        DOCUMENT_TYPES: '/document-types',
        DOCUMENT_VERIFICATION_STATUSES: '/document-verification-statuses',
        ASSET_TYPES: '/asset-types',
        ASSET_MODELS: '/asset-models',
        QUALIFICATIONS: '/qualifications',
        SPECIALIZATIONS: '/specializations',

        /* The attendance correction reasons - db/migrations/016. */
        REGULARIZATION_TYPES: '/regularization-types',
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
    // The manager dropdown. MUST be declared before DETAIL: Express would
    // otherwise read "managers" as an employee id.
    MANAGER_OPTIONS: '/managers',
    DETAIL: '/:employeeDetailId',
    UPDATE: '/:employeeDetailId',
    DEACTIVATE: '/:employeeDetailId/deactivate',
    DELETE: '/:employeeDetailId',

    /**
     * The repeating profile sections. Each is read as a list and saved as a
     * list - see src/services/employee-section.service.js. The suffixes live
     * in EMPLOYEE_SECTION below so the routes can be wired from one loop.
     */
    SECTION: '/:employeeDetailId',

    DOCUMENT_LIST: '/:employeeDetailId/documents',
    DOCUMENT_UPLOAD: '/:employeeDetailId/documents/:documentType',
    DOCUMENT_DELETE: '/:employeeDetailId/documents/:documentType',
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

  /**
   * The error log dashboard - dbo.tblErrorLog.
   *
   * REPORT is the frontend posting its own failures, and is open to any
   * signed-in user: a screen that crashed for somebody without admin rights
   * is exactly the one worth hearing about. Everything else is the
   * ERROR_LOGS module. SUMMARY must be declared before DETAIL, or
   * "summary" is read as an id.
   */
  ERROR_LOGS: Object.freeze({
    LIST: '/',
    SUMMARY: '/summary',
    REPORT: '/',
    DETAIL: '/:errorLogId',
    UPDATE: '/:errorLogId',
    DELETE: '/:errorLogId',
  }),

  /**
   * Attendance - db/migrations/015 and 016.
   *
   * THE ORDER OF THE KEYS IN THIS OBJECT IS NOT THE ORDER THE ROUTES ARE
   * DECLARED IN, but the route file follows it, and the literal paths must
   * come before the parameterised ones there. /attendance/me would
   * otherwise be read as a punch for employee id "me" - the same trap
   * ORGANIZATIONS.TYPES carries a note about.
   *
   * SELF-SERVICE IS A SEPARATE PATH, not the same endpoint with an optional
   * id. /attendance/me can never be made to answer for somebody else, which
   * is a property of the URL rather than of a check inside the handler -
   * and the two are guarded by different modules, MY_ATTENDANCE and
   * TEAM_ATTENDANCE, so the rights matrix can tell them apart too.
   */
  ATTENDANCE: Object.freeze({
    /* --- Self service: MODULE.MY_ATTENDANCE ---------------------------- */
    /** Today's row: am I checked in, since when, what is my shift. */
    ME_TODAY: '/me/today',
    /** My calendar for a month: ?from=&to=. */
    ME_CALENDAR: '/me/calendar',
    ME_SUMMARY: '/me/summary',
    CHECK_IN: '/me/check-in',
    CHECK_OUT: '/me/check-out',
    /** The punches behind one of my days, for the detail drawer. */
    ME_DAY: '/me/day/:attendanceDate',

    /* --- Manager and HR: MODULE.TEAM_ATTENDANCE ------------------------ */
    /** The daily grid: ?date=&locationId=&status=. */
    TEAM_DAY: '/team/day',
    TEAM_CALENDAR: '/team/calendar',
    /** Absent, late, missing a punch - the morning list. */
    TEAM_EXCEPTIONS: '/team/exceptions',
    EMPLOYEE_CALENDAR: '/employees/:employeeDetailId/calendar',
    EMPLOYEE_DAY: '/employees/:employeeDetailId/day/:attendanceDate',

    /* --- Regularization: MODULE.REGULARIZATION ------------------------- */
    REGULARIZATION_MINE: '/regularizations/me',
    REGULARIZATION_CREATE: '/regularizations',
    REGULARIZATION_PENDING: '/regularizations/pending',
    REGULARIZATION_DETAIL: '/regularizations/:regularizationRequestId',
    REGULARIZATION_APPROVE: '/regularizations/:regularizationRequestId/approve',
    REGULARIZATION_REJECT: '/regularizations/:regularizationRequestId/reject',
    REGULARIZATION_CANCEL: '/regularizations/:regularizationRequestId/cancel',

    /* --- Shifts: MODULE.SHIFTS ----------------------------------------- */
    SHIFT_LIST: '/shifts',
    SHIFT_CREATE: '/shifts',
    SHIFT_DETAIL: '/shifts/:shiftId',
    SHIFT_UPDATE: '/shifts/:shiftId',
    SHIFT_DELETE: '/shifts/:shiftId',
    /** The week-off pattern is replaced as a whole list, never row by row. */
    SHIFT_WEEK_OFFS: '/shifts/:shiftId/week-offs',
    SHIFT_WEEK_OFFS_SAVE: '/shifts/:shiftId/week-offs',

    ASSIGNMENT_LIST: '/shift-assignments',
    ASSIGNMENT_CREATE: '/shift-assignments',
    ASSIGNMENT_UPDATE: '/shift-assignments/:employeeShiftId',
    ASSIGNMENT_DELETE: '/shift-assignments/:employeeShiftId',
    EMPLOYEE_SHIFT: '/employees/:employeeDetailId/shift',

    /* --- Holidays: MODULE.HOLIDAY_CALENDAR ----------------------------- */
    /** ?year=&locationId=&holidayTypeId=. Readable by everybody. */
    HOLIDAY_LIST: '/holidays',
    HOLIDAY_CREATE: '/holidays',
    HOLIDAY_TYPES: '/holidays/types',
    /** The restricted list this employee may choose from, and their pick. */
    HOLIDAY_RESTRICTED_OPTIONS: '/holidays/restricted/options',
    HOLIDAY_RESTRICTED_MINE: '/holidays/restricted/me',
    HOLIDAY_RESTRICTED_OPT_IN: '/holidays/restricted/opt-in',
    HOLIDAY_RESTRICTED_PENDING: '/holidays/restricted/pending',
    HOLIDAY_RESTRICTED_DECIDE: '/holidays/restricted/:restrictedHolidayOptInId/decide',
    HOLIDAY_RESTRICTED_CANCEL: '/holidays/restricted/:restrictedHolidayOptInId/cancel',
    /** Which cohort gets the restricted list, and how many picks. */
    RESTRICTED_MAPPING_LIST: '/holidays/restricted-mappings',
    RESTRICTED_MAPPING_CREATE: '/holidays/restricted-mappings',
    RESTRICTED_MAPPING_UPDATE: '/holidays/restricted-mappings/:restrictedHolidayMappingId',
    RESTRICTED_MAPPING_DELETE: '/holidays/restricted-mappings/:restrictedHolidayMappingId',
    HOLIDAY_DETAIL: '/holidays/:holidayId',
    HOLIDAY_UPDATE: '/holidays/:holidayId',
    HOLIDAY_DELETE: '/holidays/:holidayId',

    /* --- Exemptions: MODULE.ATTENDANCE_EXEMPTIONS ---------------------- */
    EXEMPTION_LIST: '/exemptions',
    EXEMPTION_CREATE: '/exemptions',
    EXEMPTION_UPDATE: '/exemptions/:attendanceExemptionId',
    EXEMPTION_DELETE: '/exemptions/:attendanceExemptionId',

    /* --- Alerts: MODULE.ATTENDANCE_ALERTS ------------------------------ */
    ALERT_SETTING_LIST: '/alert-settings',
    ALERT_SETTING_CREATE: '/alert-settings',
    ALERT_SETTING_UPDATE: '/alert-settings/:attendanceAlertSettingId',
    ALERT_SETTING_DELETE: '/alert-settings/:attendanceAlertSettingId',
  }),

  /**
   * Leave - db/migrations/017 to 020.
   *
   * Same self / team / admin split as ATTENDANCE above, and the same
   * declaration-order trap: /leave/me must be declared before any
   * /leave/:something.
   */
  LEAVE: Object.freeze({
    /* --- Self service: MODULE.MY_LEAVE --------------------------------- */
    /** The dashboard of section 10: one tile per category, per cycle. */
    ME_DASHBOARD: '/me/dashboard',
    /** What I may apply for right now, with the rules attached. */
    ME_TYPES: '/me/types',
    /** The charge preview: how many days, how many sandwich, how many LWP. */
    ME_PREVIEW: '/me/preview',
    ME_REQUESTS: '/me/requests',
    ME_LEDGER: '/me/ledger',
    ME_BALANCE: '/me/balance',

    REQUEST_CREATE: '/requests',
    REQUEST_DETAIL: '/requests/:leaveRequestId',
    REQUEST_CANCEL: '/requests/:leaveRequestId/cancel',
    REQUEST_WITHDRAW: '/requests/:leaveRequestId/withdraw',

    /* --- Approvals: MODULE.TEAM_LEAVE ---------------------------------- */
    PENDING: '/requests/pending',
    REQUEST_APPROVE: '/requests/:leaveRequestId/approve',
    REQUEST_REJECT: '/requests/:leaveRequestId/reject',
    TEAM_CALENDAR: '/team/calendar',
    TEAM_REQUESTS: '/team/requests',

    /* --- Cycles and policy: MODULE.LEAVE_POLICY ------------------------ */
    CYCLE_LIST: '/cycles',
    CYCLE_CREATE: '/cycles',
    CYCLE_UPDATE: '/cycles/:leaveCycleId',
    CYCLE_CLOSE: '/cycles/:leaveCycleId/close',

    POLICY_LIST: '/policies',
    POLICY_CREATE: '/policies',
    POLICY_DETAIL: '/policies/:leavePolicyId',
    POLICY_UPDATE: '/policies/:leavePolicyId',
    POLICY_DELETE: '/policies/:leavePolicyId',

    SANDWICH_RULE_LIST: '/sandwich-rules',
    SANDWICH_RULE_CREATE: '/sandwich-rules',
    SANDWICH_RULE_UPDATE: '/sandwich-rules/:sandwichRuleId',
    SANDWICH_RULE_DELETE: '/sandwich-rules/:sandwichRuleId',

    /** Per-employee overrides - "customize leave policy for certain employees". */
    OVERRIDE_LIST: '/overrides',
    OVERRIDE_CREATE: '/overrides',
    OVERRIDE_UPDATE: '/overrides/:employeeLeavePolicyId',
    OVERRIDE_DELETE: '/overrides/:employeeLeavePolicyId',

    /* --- Mapping: MODULE.LEAVE_MAPPING --------------------------------- */
    MAPPING_LIST: '/mappings',
    MAPPING_CREATE: '/mappings',
    MAPPING_UPDATE: '/mappings/:leaveMappingId',
    MAPPING_DELETE: '/mappings/:leaveMappingId',

    /* --- Balances: MODULE.LEAVE_BALANCE -------------------------------- */
    /** The manage-balance grid: every employee, every category, one cycle. */
    BALANCE_LIST: '/balances',
    EMPLOYEE_BALANCE: '/balances/:employeeDetailId',
    EMPLOYEE_LEDGER: '/balances/:employeeDetailId/ledger',
    /** A hand correction. Writes an ADJUSTMENT row; remarks are mandatory. */
    BALANCE_ADJUST: '/balances/:employeeDetailId/adjust',
    /** Granting days in bulk - the "add leaves" screen. */
    BALANCE_GRANT: '/balances/grant',

    /* --- Comp-off: MODULE.COMP_OFF ------------------------------------- */
    COMP_OFF_MINE: '/comp-off/me',
    COMP_OFF_CREATE: '/comp-off',
    COMP_OFF_PENDING: '/comp-off/pending',
    /** HR's outstanding list: approved by the manager, not yet credited. */
    COMP_OFF_AWAITING_CREDIT: '/comp-off/awaiting-credit',
    COMP_OFF_APPROVE: '/comp-off/:compOffRequestId/approve',
    COMP_OFF_REJECT: '/comp-off/:compOffRequestId/reject',
    COMP_OFF_CANCEL: '/comp-off/:compOffRequestId/cancel',
    /** The HR act that actually grants the day. Never a job. */
    COMP_OFF_CREDIT: '/comp-off/:compOffRequestId/credit',
    COMP_OFF_CREDITS: '/comp-off/credits',

    /* --- Confirmation: MODULE.EMPLOYMENT_STATUS ------------------------ */
    CONFIRMATION_DUE: '/confirmation/due',
    CONFIRMATION_HISTORY: '/confirmation/:employeeDetailId/history',
    CONFIRMATION_CONFIRM: '/confirmation/:employeeDetailId/confirm',
    CONFIRMATION_EXTEND: '/confirmation/:employeeDetailId/extend',

    /* --- Payroll: MODULE.LWP_REPORT ------------------------------------ */
    LWP_REPORT: '/reports/lwp',
  }),
});
/**
 * Stable machine-readable failure codes, carried in the `details.code` field of
 * the error envelope.
 *
 * The envelope has no top-level code field and does not need one: `details` is
 * already the place for diagnostics, and putting the code there adds a branch
 * point for clients without changing the contract every endpoint shares.
 *
 * These are for code to branch on; the human-facing wording stays in MESSAGES.
 * A client that matches on message text breaks the first time somebody
 * rewords a sentence, which is exactly why both exist.
 */
export const ERROR_CODE = Object.freeze({
  /** A field failed validation. `details` names the field and says why. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** The employee named in the path does not exist, or has been deleted. */
  EMPLOYEE_NOT_FOUND: 'EMPLOYEE_NOT_FOUND',

  /** Signed in and in a group, but that group lacks the action on the module. */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** The employee profile exists but is inactive or soft-deleted. */
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  /**
   * The password is still the temporary one an invite issued. The client
   * sends the user to /auth/set-password instead of /auth/verify-otp.
   */
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  /** Inviting somebody who already has a login with their own password. */
  LOGIN_ALREADY_EXISTS: 'LOGIN_ALREADY_EXISTS',

  /** Optimistic concurrency: the row moved between load and save. */
  MODIFIED_ELSEWHERE: 'MODIFIED_ELSEWHERE',

  CODE_ALREADY_EXISTS: 'CODE_ALREADY_EXISTS',
  /** A unique name is taken - an organisation's, or a location's within one. */
  NAME_ALREADY_EXISTS: 'NAME_ALREADY_EXISTS',
  /** Deleting a location that employees are still assigned to. */
  LOCATION_IN_USE: 'LOCATION_IN_USE',

  /** A work email or employee code already belongs to another live employee. */
  EMAIL_ALREADY_EXISTS: 'EMAIL_ALREADY_EXISTS',
  /** Exiting somebody who has already been exited. */
  EMPLOYEE_ALREADY_INACTIVE: 'EMPLOYEE_ALREADY_INACTIVE',
  /**
   * Exiting or deleting somebody who still has direct reports. Their team
   * would be left pointing at a manager no screen lists, and nothing would
   * complain until a reporting line turned up empty.
   */
  EMPLOYEE_HAS_REPORTS: 'EMPLOYEE_HAS_REPORTS',
  /** Exiting or deleting your own record. */
  SELF_ACTION_BLOCKED: 'SELF_ACTION_BLOCKED',
  /** A leaving date that falls before the joining date. */
  INVALID_EXIT_DATE: 'INVALID_EXIT_DATE',
  /** The manager named on an employee does not exist, or is not active. */
  MANAGER_NOT_FOUND: 'MANAGER_NOT_FOUND',
  /**
   * An employment status on the wrong side of IsActive: an exit status on a
   * live record, or a live status on an exited one. Exits go through deactivate.
   */
  INVALID_EMPLOYMENT_STATUS: 'INVALID_EMPLOYMENT_STATUS',

  /* --- Employee profile sections and documents (011) ------------------- */

  /** A saved row's id is not a live row of this employee's section. */
  SECTION_ROW_NOT_FOUND: 'SECTION_ROW_NOT_FOUND',
  /** No live document of that type for this employee. */
  DOCUMENT_NOT_FOUND: 'DOCUMENT_NOT_FOUND',
  /** An upload with no file, or one too large, or of a type not accepted. */
  INVALID_FILE: 'INVALID_FILE',
  /** The error-log row named in the path does not exist, or was purged. */
  ERROR_LOG_NOT_FOUND: 'ERROR_LOG_NOT_FOUND',

  /* --- Group-based access control (008) ------------------------------- */

  /** The group named in the path does not exist, or has been deleted. */
  GROUP_NOT_FOUND: 'GROUP_NOT_FOUND',
  /** Editing or deleting the Administrator group, which is immutable. */
  GROUP_IS_SYSTEM: 'GROUP_IS_SYSTEM',
  /** Deleting a group that still has employees in it. */
  GROUP_HAS_MEMBERS: 'GROUP_HAS_MEMBERS',
  /** Assigning somebody to a group that has been switched off. */
  GROUP_INACTIVE: 'GROUP_INACTIVE',
  /** A rights payload naming a module id that is not in the catalog. */
  UNKNOWN_MODULE: 'UNKNOWN_MODULE',
  /** The same module appearing twice in one rights payload. */
  DUPLICATE_MODULE_RIGHT: 'DUPLICATE_MODULE_RIGHT',
  /**
   * Signed in, but in no group at all - so no module is reachable. A
   * different fix from PERMISSION_DENIED: assign a group, rather than hunt
   * for a missing checkbox on a group the person is not in.
   */
  NO_GROUP_ASSIGNED: 'NO_GROUP_ASSIGNED',

  /* --- Master data (009) ----------------------------------------------- */

  /** A master-data row named in the path does not exist, or was deleted. */
  MASTER_DATA_NOT_FOUND: 'MASTER_DATA_NOT_FOUND',
  /** Deleting a parent department that still has departments under it. */
  PARENT_DEPARTMENT_IN_USE: 'PARENT_DEPARTMENT_IN_USE',
  /** Deleting a department employees are still assigned to. */
  DEPARTMENT_IN_USE: 'DEPARTMENT_IN_USE',
  /** Deleting a designation employees still hold. */
  DESIGNATION_IN_USE: 'DESIGNATION_IN_USE',

  /* --- Shifts (015) ----------------------------------------------------- */

  SHIFT_NOT_FOUND: 'SHIFT_NOT_FOUND',
  /** Deleting a shift employees are still assigned to. */
  SHIFT_IN_USE: 'SHIFT_IN_USE',
  SHIFT_ASSIGNMENT_NOT_FOUND: 'SHIFT_ASSIGNMENT_NOT_FOUND',
  /**
   * Two live assignments whose date ranges overlap. Checked in the service
   * rather than by a constraint - SQL Server cannot express "no overlapping
   * ranges" without a trigger, and a 409 naming the clashing row is more
   * use than a silent rejection.
   */
  SHIFT_ASSIGNMENT_OVERLAP: 'SHIFT_ASSIGNMENT_OVERLAP',
  /** Nothing to judge the day against: no shift covers that date. */
  NO_SHIFT_ASSIGNED: 'NO_SHIFT_ASSIGNED',

  /* --- Attendance (016) -------------------------------------------------- */

  ATTENDANCE_DAY_NOT_FOUND: 'ATTENDANCE_DAY_NOT_FOUND',
  /** Checking in twice without a check-out between. */
  ALREADY_CHECKED_IN: 'ALREADY_CHECKED_IN',
  /** Checking out with no open check-in. */
  NOT_CHECKED_IN: 'NOT_CHECKED_IN',
  /** A date range that runs backwards, or one too wide to serve. */
  INVALID_DATE_RANGE: 'INVALID_DATE_RANGE',
  DATE_RANGE_TOO_WIDE: 'DATE_RANGE_TOO_WIDE',
  PUNCH_IN_FUTURE: 'PUNCH_IN_FUTURE',

  /* --- Regularization (016) ---------------------------------------------- */

  REGULARIZATION_NOT_FOUND: 'REGULARIZATION_NOT_FOUND',
  /** Raised after the configured window - 24 hours by default - had passed. */
  REGULARIZATION_WINDOW_CLOSED: 'REGULARIZATION_WINDOW_CLOSED',
  /** A pending or approved request already covers that day. */
  REGULARIZATION_ALREADY_OPEN: 'REGULARIZATION_ALREADY_OPEN',
  REGULARIZATION_NOT_PENDING: 'REGULARIZATION_NOT_PENDING',

  /* --- Holidays (017) ----------------------------------------------------- */

  HOLIDAY_NOT_FOUND: 'HOLIDAY_NOT_FOUND',
  HOLIDAY_EXISTS: 'HOLIDAY_EXISTS',
  HOLIDAY_NEEDS_LOCATION: 'HOLIDAY_NEEDS_LOCATION',
  RESTRICTED_OPT_IN_NOT_FOUND: 'RESTRICTED_OPT_IN_NOT_FOUND',
  /** The one-per-calendar-year rule from section 07. */
  RESTRICTED_QUOTA_USED: 'RESTRICTED_QUOTA_USED',
  /** No restricted-holiday mapping covers this employee's cohort. */
  RESTRICTED_NOT_ELIGIBLE: 'RESTRICTED_NOT_ELIGIBLE',
  /** Opting in to a holiday that is NORMAL rather than RESTRICTED. */
  RESTRICTED_WRONG_TYPE: 'RESTRICTED_WRONG_TYPE',
  RESTRICTED_MAPPING_NOT_FOUND: 'RESTRICTED_MAPPING_NOT_FOUND',

  /* --- Exemptions and alerts (016) ---------------------------------------- */

  EXEMPTION_NOT_FOUND: 'EXEMPTION_NOT_FOUND',
  ALERT_SETTING_NOT_FOUND: 'ALERT_SETTING_NOT_FOUND',
  ALERT_SETTING_EXISTS: 'ALERT_SETTING_EXISTS',

  /* --- Leave cycles and policy (018) -------------------------------------- */

  LEAVE_CYCLE_NOT_FOUND: 'LEAVE_CYCLE_NOT_FOUND',
  LEAVE_CYCLE_EXISTS: 'LEAVE_CYCLE_EXISTS',
  /** Writing into a cycle somebody has settled. */
  LEAVE_CYCLE_IS_CLOSED: 'LEAVE_CYCLE_IS_CLOSED',
  /** No cycle of the policy's type covers the date applied for. */
  LEAVE_CYCLE_MISSING: 'LEAVE_CYCLE_MISSING',

  LEAVE_POLICY_NOT_FOUND: 'LEAVE_POLICY_NOT_FOUND',
  LEAVE_POLICY_EXISTS: 'LEAVE_POLICY_EXISTS',
  /** No policy row applies to this employee for this category. */
  LEAVE_POLICY_MISSING: 'LEAVE_POLICY_MISSING',

  SANDWICH_RULE_NOT_FOUND: 'SANDWICH_RULE_NOT_FOUND',
  SANDWICH_RULE_IN_USE: 'SANDWICH_RULE_IN_USE',
  LEAVE_OVERRIDE_NOT_FOUND: 'LEAVE_OVERRIDE_NOT_FOUND',
  LEAVE_MAPPING_NOT_FOUND: 'LEAVE_MAPPING_NOT_FOUND',
  LEAVE_MAPPING_EXISTS: 'LEAVE_MAPPING_EXISTS',

  /* --- Leave requests (019) ------------------------------------------------ */

  LEAVE_REQUEST_NOT_FOUND: 'LEAVE_REQUEST_NOT_FOUND',
  LEAVE_REQUEST_NOT_PENDING: 'LEAVE_REQUEST_NOT_PENDING',
  /** Applied-for dates collide with an existing request. */
  LEAVE_REQUEST_OVERLAP: 'LEAVE_REQUEST_OVERLAP',
  LEAVE_INSUFFICIENT_BALANCE: 'LEAVE_INSUFFICIENT_BALANCE',
  LEAVE_NOT_AVAILABLE_ON_PROBATION: 'LEAVE_NOT_AVAILABLE_ON_PROBATION',
  /** No tblLeaveMapping row offers this category to this employee. */
  LEAVE_NOT_MAPPED: 'LEAVE_NOT_MAPPED',
  LEAVE_HALF_DAY_NOT_ALLOWED: 'LEAVE_HALF_DAY_NOT_ALLOWED',
  /** The whole range is week-offs and holidays, so there is nothing to charge. */
  LEAVE_NO_WORKING_DAYS: 'LEAVE_NO_WORKING_DAYS',
  LEAVE_BACKDATED_NOT_ALLOWED: 'LEAVE_BACKDATED_NOT_ALLOWED',
  LEAVE_NOTICE_REQUIRED: 'LEAVE_NOTICE_REQUIRED',

  /**
   * Approving or rejecting your own request.
   *
   * Separate from SELF_ACTION_BLOCKED, which is about an employee record. A
   * manager who is also somebody's report can legitimately act on their
   * team's leave and never on their own, and the two refusals need
   * different wording.
   */
  LEAVE_SELF_APPROVAL: 'LEAVE_SELF_APPROVAL',
  /**
   * Row-level authorisation, and the reason the module right alone is not
   * enough: holding TEAM_LEAVE:EDIT says you may approve leave, not whose.
   */
  NOT_AN_APPROVER: 'NOT_AN_APPROVER',

  /* --- Balances (019) ------------------------------------------------------ */

  /** An ADJUSTMENT with no reason. The one ledger entry that demands one. */
  LEAVE_ADJUSTMENT_NEEDS_REMARKS: 'LEAVE_ADJUSTMENT_NEEDS_REMARKS',
  LEAVE_ADJUSTMENT_WOULD_GO_NEGATIVE: 'LEAVE_ADJUSTMENT_WOULD_GO_NEGATIVE',

  /* --- Comp-off (020) ------------------------------------------------------ */

  COMP_OFF_NOT_FOUND: 'COMP_OFF_NOT_FOUND',
  COMP_OFF_ALREADY_REQUESTED: 'COMP_OFF_ALREADY_REQUESTED',
  COMP_OFF_NOT_PENDING: 'COMP_OFF_NOT_PENDING',
  /** Crediting a request the manager has not approved. */
  COMP_OFF_NOT_APPROVED: 'COMP_OFF_NOT_APPROVED',
  COMP_OFF_ALREADY_CREDITED: 'COMP_OFF_ALREADY_CREDITED',
  COMP_OFF_FUTURE_DATE: 'COMP_OFF_FUTURE_DATE',
  /** Claiming a comp-off for an ordinary working day. */
  COMP_OFF_WORKING_DAY: 'COMP_OFF_WORKING_DAY',

  /* --- Probation and confirmation (014) ------------------------------------ */

  ALREADY_CONFIRMED: 'ALREADY_CONFIRMED',
  PROBATION_END_BEFORE_JOINING: 'PROBATION_END_BEFORE_JOINING',
});

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
});

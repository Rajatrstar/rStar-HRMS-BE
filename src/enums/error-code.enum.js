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
  /** Authenticated, but the effective permission set does not contain the code. */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** Holds the permission, but not at a wide enough scope for this row. */
  SCOPE_DENIED: 'SCOPE_DENIED',
  /**
   * The scope cannot be evaluated: a TEAM or DEPARTMENT grant on a login whose
   * employee profile is missing, so there is no ManagerId or DepartmentId to
   * filter against. Raised rather than returning an empty list, which reads as
   * a data problem and gets debugged as one.
   */
  SCOPE_UNRESOLVED: 'SCOPE_UNRESOLVED',
  /** The employee profile exists but is inactive or soft-deleted. */
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',

  /** A system role cannot be renamed, deleted, or stripped of permissions. */
  ROLE_IS_PROTECTED: 'ROLE_IS_PROTECTED',
  /** Deleting a role or group that still has holders or members. */
  ROLE_IN_USE: 'ROLE_IN_USE',
  GROUP_IN_USE: 'GROUP_IN_USE',
  /** Granting access the actor does not hold themselves. */
  ESCALATION_BLOCKED: 'ESCALATION_BLOCKED',
  /** The change would strip the caller's own administrative access. */
  SELF_LOCKOUT_BLOCKED: 'SELF_LOCKOUT_BLOCKED',
  /** Removing the last person who holds SUPER_ADMIN. */
  LAST_SUPER_ADMIN: 'LAST_SUPER_ADMIN',
  /** Optimistic concurrency: the row moved between load and save. */
  MODIFIED_ELSEWHERE: 'MODIFIED_ELSEWHERE',

  CODE_ALREADY_EXISTS: 'CODE_ALREADY_EXISTS',
  /** A unique name is taken - an organisation's, or a location's within one. */
  NAME_ALREADY_EXISTS: 'NAME_ALREADY_EXISTS',
  /** Deleting a location that employees are still assigned to. */
  LOCATION_IN_USE: 'LOCATION_IN_USE',
  UNKNOWN_PERMISSION_IDS: 'UNKNOWN_PERMISSION_IDS',
  UNKNOWN_ROLE_IDS: 'UNKNOWN_ROLE_IDS',
  UNKNOWN_GROUP_IDS: 'UNKNOWN_GROUP_IDS',
  UNKNOWN_EMPLOYEE_IDS: 'UNKNOWN_EMPLOYEE_IDS',
  DUPLICATE_PERMISSION_IDS: 'DUPLICATE_PERMISSION_IDS',
  /** One live override per (employee, permission) - edit it instead. */
  OVERRIDE_ALREADY_EXISTS: 'OVERRIDE_ALREADY_EXISTS',
  SCOPE_REQUIRED: 'SCOPE_REQUIRED',
  SCOPE_NOT_SUPPORTED: 'SCOPE_NOT_SUPPORTED',
  /** An override expiry that has already passed. */
  EXPIRY_IN_PAST: 'EXPIRY_IN_PAST',
});

/** Every string the API sends back to a client. Keeps wording consistent. */
export const MESSAGES = Object.freeze({
  // Fallback for a success that has nothing more specific to say. Prefer a
  // named message over relying on this one.
  SUCCESS: 'Success',

  SERVICE_HEALTHY: 'Service is healthy',
  SERVICE_READY: 'Service is ready',
  SERVICE_DEGRADED: 'Service is degraded',
  ROUTE_NOT_FOUND: 'Requested endpoint does not exist',
  INTERNAL_ERROR: 'Something went wrong on our end',
  MALFORMED_JSON: 'Request body is not valid JSON',
  TOO_MANY_REQUESTS: 'Too many requests. Please wait and try again',
  TOO_MANY_ATTEMPTS: 'Too many attempts for this account. Please wait and try again',
  TOO_MANY_OTP_REQUESTS: 'An OTP was requested too recently. Please wait before asking for another',
  DB_CONNECTION_FAILED: 'Could not connect to the database',

  // Auth. INVALID_CREDENTIALS is deliberately vague and is used for both an
  // unknown email and a wrong password, so the API cannot be used to discover
  // which addresses have accounts.
  INVALID_CREDENTIALS: 'Invalid email or password',
  OTP_SENT: 'Password verified. An OTP has been sent to your email',
  OTP_INVALID: 'The OTP is incorrect',
  OTP_EXPIRED: 'The OTP has expired. Please log in again',
  OTP_NOT_REQUESTED: 'No OTP is pending for this account. Please log in first',
  LOGIN_SUCCESS: 'Login successful',
  TOKEN_REFRESHED: 'Token refreshed',
  LOGOUT_SUCCESS: 'Logged out. This access token and its refresh token are no longer valid.',
  TOKEN_MISSING: 'Authentication token is required',
  TOKEN_INVALID: 'Authentication token is invalid or has expired',
  PROFILE_FETCHED: 'Profile fetched',

  // Forgot-password flow. Step 1 proves who you are with a detail only the
  // employee knows; step 2 exchanges the emailed code for a new password.
  USER_VERIFIED_OTP_SENT: 'User verified. An OTP has been sent to your email',
  EMPLOYEE_NOT_VERIFIED: 'No active employee matches that email and date of birth',
  EMPLOYEE_HAS_NO_LOGIN: 'This employee has no login account',
  PASSWORD_RESET_SUCCESS: 'Password updated. Please log in with your new password',
  VALIDATION_FAILED: 'The submitted data is invalid',

  // Access control. The denial wording is deliberately generic about WHAT was
  // being reached for - the module and the action go in `details`, where a
  // help-desk ticket can quote them, not into prose that ends up in a toast.
  PERMISSION_DENIED: 'You do not have permission to perform this action',
  ACCOUNT_INACTIVE: 'This account is no longer active',
  MODIFIED_ELSEWHERE: 'This record was changed by someone else. Reload and try again',
  CODE_ALREADY_EXISTS: 'That code is already in use',
  RESOURCE_NOT_FOUND: 'The requested record does not exist',

  // Employees.
  EMPLOYEES_FETCHED: 'Employees fetched',
  EMPLOYEE_FETCHED: 'Employee fetched',
  EMPLOYEE_CREATED: 'Employee created',
  EMPLOYEE_UPDATED: 'Employee updated',
  EMPLOYEE_DEACTIVATED: 'Employee exited. Their access has been withdrawn',
  EMPLOYEE_DELETED: 'Employee deleted',
  EMPLOYEE_NOT_FOUND: 'That employee does not exist',
  EMPLOYEE_CODE_EXISTS: 'That employee code is already in use',
  EMPLOYEE_EMAIL_EXISTS: 'That work email is already in use',
  EMPLOYEE_ALREADY_INACTIVE: 'This employee has already been exited',
  EMPLOYEE_HAS_REPORTS: 'This employee still has direct reports. Reassign them first',
  CANNOT_DEACTIVATE_SELF: 'You cannot exit your own employee record',
  CANNOT_DELETE_SELF: 'You cannot delete your own employee record',
  INVALID_EXIT_DATE: 'The leaving date cannot be before the joining date',
  MANAGER_NOT_FOUND: 'The chosen manager is not an active employee',
  MANAGER_IS_SELF: 'An employee cannot be their own manager',

  // Access control, success side.
  ACCOUNT_NOT_FOUND: 'Account no longer exists',

  // Organisation setup.
  ORGANIZATIONS_FETCHED: 'Organizations fetched',
  ORGANIZATION_FETCHED: 'Organization fetched',
  ORGANIZATION_CREATED: 'Organization created',
  ORGANIZATION_UPDATED: 'Organization updated',
  ORGANIZATION_NOT_FOUND: 'That organization does not exist',
  ORGANIZATION_NAME_EXISTS: 'An organization with that name already exists',
  ORGANIZATION_TYPES_FETCHED: 'Organization types fetched',

  LOCATIONS_FETCHED: 'Locations fetched',
  LOCATION_FETCHED: 'Location fetched',
  LOCATION_CREATED: 'Location created',
  LOCATION_UPDATED: 'Location updated',
  LOCATION_DELETED: 'Location deleted',
  LOCATION_NOT_FOUND: 'That location does not exist',
  LOCATION_NAME_EXISTS: 'A location with that name already exists in this organization',
  LOCATION_CODE_EXISTS: 'A location with that code already exists in this organization',
  // Said plainly, because the fix is specific: move the employees first.
  LOCATION_IN_USE: 'Employees are still assigned to this location',

  /* --- Group-based access control -------------------------------------- */

  MODULES_FETCHED: 'Modules fetched',
  MENU_FETCHED: 'Menu fetched',
  PAGE_ACCESS_FETCHED: 'Page access fetched',
  MY_ACCESS_FETCHED: 'Access fetched',

  GROUPS_FETCHED: 'Groups fetched',
  GROUP_FETCHED: 'Group fetched',
  GROUP_CREATED: 'Group created',
  GROUP_UPDATED: 'Group updated',
  GROUP_DELETED: 'Group deleted',
  GROUP_RIGHTS_UPDATED: 'Group rights updated',
  GROUP_NOT_FOUND: 'That group does not exist',
  GROUP_NAME_EXISTS: 'A group with that name already exists',
  // Named for what it protects, so the refusal reads as a design decision
  // rather than a bug: this is the group that guarantees somebody can
  // always get back into the rights screen.
  GROUP_IS_SYSTEM: 'The Administrator group cannot be changed or deleted',
  GROUP_HAS_MEMBERS: 'Employees are still in this group',
  GROUP_INACTIVE: 'That group is not active',

  GROUP_MEMBERS_FETCHED: 'Group members fetched',
  GROUP_ASSIGNED: 'Group assigned',
  GROUP_REMOVED: 'Group removed',
  MEMBERS_ASSIGNED: 'Employees assigned to the group',

  UNKNOWN_MODULE: 'That module does not exist',
  DUPLICATE_MODULE_RIGHT: 'The same module appears more than once in the rights list',
  PAGE_NOT_MAPPED: 'No module is mapped to that page',
});

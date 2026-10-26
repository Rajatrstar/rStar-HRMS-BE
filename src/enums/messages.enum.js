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
  // being reached for - the permission code goes in `details`, where a
  // help-desk ticket can quote it, not into prose that ends up in a toast.
  PERMISSION_DENIED: 'You do not have permission to perform this action',
  SCOPE_DENIED: 'You do not have permission to perform this action on this record',
  SCOPE_UNRESOLVED: 'Your access depends on an employee profile that is missing',
  ACCOUNT_INACTIVE: 'This account is no longer active',
  ESCALATION_BLOCKED: 'You cannot grant access you do not hold yourself',
  SELF_LOCKOUT_BLOCKED: 'This change would remove your own administrative access',
  LAST_SUPER_ADMIN: 'The last Super Admin cannot be removed',
  ROLE_IS_PROTECTED: 'This is a system role and cannot be changed',
  ROLE_IN_USE: 'This role is still assigned to employees',
  GROUP_IN_USE: 'This group still has members',
  MODIFIED_ELSEWHERE: 'This record was changed by someone else. Reload and try again',
  CODE_ALREADY_EXISTS: 'That code is already in use',
  UNKNOWN_PERMISSION_IDS: 'One or more permissions do not exist',
  SCOPE_REQUIRED: 'A scope is required for this permission',
  SCOPE_NOT_SUPPORTED: 'This permission does not take a scope',
  RESOURCE_NOT_FOUND: 'The requested record does not exist',

  // Access control, success side.
  PERMISSIONS_FETCHED: 'Permissions fetched',
  MY_PERMISSIONS_FETCHED: 'Permissions fetched',
  ROLES_FETCHED: 'Roles fetched',
  ROLE_FETCHED: 'Role fetched',
  ROLE_CREATED: 'Role created',
  ROLE_UPDATED: 'Role updated',
  ROLE_DELETED: 'Role deleted',
  ROLE_PERMISSIONS_UPDATED: 'Role permissions updated',
  GROUPS_FETCHED: 'Groups fetched',
  GROUP_FETCHED: 'Group fetched',
  GROUP_CREATED: 'Group created',
  GROUP_UPDATED: 'Group updated',
  GROUP_DELETED: 'Group deleted',
  GROUP_PERMISSIONS_UPDATED: 'Group permissions updated',
  GROUP_MEMBERS_UPDATED: 'Group members updated',
  USER_ACCESS_FETCHED: 'User access fetched',
  USER_ROLES_UPDATED: 'User roles updated',
  USER_GROUPS_UPDATED: 'User groups updated',
  OVERRIDE_CREATED: 'Permission override created',
  OVERRIDE_UPDATED: 'Permission override updated',
  OVERRIDE_REMOVED: 'Permission override removed',
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
});

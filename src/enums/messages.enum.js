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
  ACCOUNT_NOT_FOUND: 'Account no longer exists',
});

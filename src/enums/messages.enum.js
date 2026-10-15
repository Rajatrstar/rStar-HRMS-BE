/** Every string the API sends back to a client. Keeps wording consistent. */
export const MESSAGES = Object.freeze({
  SERVICE_HEALTHY: 'Service is healthy',
  SERVICE_READY: 'Service is ready',
  SERVICE_DEGRADED: 'Service is degraded',
  ROUTE_NOT_FOUND: 'Requested endpoint does not exist',
  INTERNAL_ERROR: 'Something went wrong on our end',
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
  VALIDATION_FAILED: 'The submitted data is invalid',
});

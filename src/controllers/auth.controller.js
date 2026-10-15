/**
 * Auth controller: validate input, call the service, shape the reply.
 * No SQL and no business rules live here.
 */
import * as authService from '../services/auth.service.js';
import { sendSuccess } from '../helpers/response.helper.js';
import { validateBody } from '../helpers/validation.helper.js';
import { HTTP_STATUS, MESSAGES } from '../enums/index.js';
import { env } from '../config/env.js';

/** POST /api/v1/auth/login */
export async function login(req, res) {
  const { email, password } = validateBody(req.body, {
    email: { required: true, email: true, lowercase: true, maxLength: 256 },
    // bcrypt only reads the first 72 bytes, so anything longer is capped here
    // rather than being silently truncated during hashing.
    password: { required: true, trim: false, maxLength: 72 },
  });

  const data = await authService.login(email, password);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.OTP_SENT, data });
}

/** POST /api/v1/auth/verify-otp */
export async function verifyOtp(req, res) {
  const { email, otp } = validateBody(req.body, {
    email: { required: true, email: true, lowercase: true, maxLength: 256 },
    otp: { required: true, digits: true, minLength: env.OTP_LENGTH, maxLength: env.OTP_LENGTH },
  });

  const data = await authService.verifyOtp(email, otp);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.LOGIN_SUCCESS, data });
}

/** POST /api/v1/auth/resend-otp */
export async function resendOtp(req, res) {
  const { email } = validateBody(req.body, {
    email: { required: true, email: true, lowercase: true, maxLength: 256 },
  });

  const data = await authService.resendOtp(email);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.OTP_SENT, data });
}

/** POST /api/v1/auth/refresh */
export async function refresh(req, res) {
  const { refreshToken } = validateBody(req.body, {
    refreshToken: { required: true, maxLength: 1024 },
  });

  const data = await authService.refresh(refreshToken);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.TOKEN_REFRESHED, data });
}

/** GET /api/v1/auth/me — requires a valid access token. */
export async function me(req, res) {
  // req.employee is attached by authenticate().
  const data = await authService.getProfile(req.employee.employeeId);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.PROFILE_FETCHED, data });
}

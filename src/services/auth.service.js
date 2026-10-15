/**
 * Authentication logic.
 *
 * Login is two steps:
 *   1. login(email, password)   -> password checked, OTP stored and "sent"
 *   2. verifyOtp(email, otp)    -> OTP checked, access + refresh tokens issued
 *
 * Nothing here touches req or res, so each function is equally callable from a
 * controller, a script, or a future scheduled job.
 */
import { query, queryOne, mutate, sql } from '../helpers/query.helper.js';
import { verifyPassword, fakeVerifyPassword } from '../utils/password.js';
import { generateOtp, otpExpiryDate, otpMatches } from '../utils/otp.js';
import { issueTokens, verifyToken, TOKEN_TYPE } from '../utils/jwt.js';
import { ApiError } from '../utils/api-error.js';
import { logger } from '../utils/logger.js';
import { MESSAGES } from '../enums/index.js';
import { env, exposeOtpInResponse } from '../config/env.js';

/** The columns safe to return to a client. HashPassword and Otp never leave here. */
const PUBLIC_COLUMNS = `
  EmployeeId AS employeeId,
  Email      AS email,
  LastLoginedAt AS lastLoginedAt,
  CreatedAt  AS createdAt,
  ModifiedAt AS modifiedAt
`;

function findByEmail(email) {
  return queryOne(
    `SELECT EmployeeId, Email, HashPassword, Otp, OtpExpiresTime
       FROM dbo.EmployeeLogin
      WHERE Email = @email`,
    { email: { type: sql.NVarChar(256), value: email } },
  );
}

/**
 * Step 1. Verifies the password, then stores a fresh OTP against the account.
 *
 * An unknown email and a wrong password produce the identical error, and both
 * spend the same time hashing, so the endpoint cannot be used to find out
 * which addresses have accounts.
 */
export async function login(email, password) {
  const account = await findByEmail(email);

  if (!account) {
    await fakeVerifyPassword(password);
    throw ApiError.unauthorized(MESSAGES.INVALID_CREDENTIALS);
  }

  const passwordOk = await verifyPassword(password, account.HashPassword);
  if (!passwordOk) {
    throw ApiError.unauthorized(MESSAGES.INVALID_CREDENTIALS);
  }

  const otp = generateOtp();
  const expiresAt = otpExpiryDate();

  // Issuing a new OTP replaces any previous one, so an old code stops working
  // the moment a new login starts.
  await mutate(
    `UPDATE dbo.EmployeeLogin
        SET Otp = @otp,
            OtpExpiresTime = @expiresAt,
            ModifiedAt = SYSUTCDATETIME()
      WHERE EmployeeId = @employeeId`,
    {
      otp: { type: sql.NVarChar(10), value: otp },
      expiresAt: { type: sql.DateTime2, value: expiresAt },
      employeeId: { type: sql.Int, value: account.EmployeeId },
    },
  );

  // No mail provider is wired up yet, so the OTP goes to the server log.
  // Replace this call with the mailer and the rest of the flow is unchanged.
  logger.info(`OTP for ${account.Email}: ${otp} (valid ${env.OTP_EXPIRY_MINUTES} min)`);

  return otpResponse(account.Email, expiresAt, otp);
}

/**
 * Step 2. Checks the stored OTP and, on success, issues the token pair.
 *
 * The OTP is cleared whatever the outcome of a successful match, so a code can
 * be used exactly once.
 */
export async function verifyOtp(email, otp) {
  const account = await findByEmail(email);

  // Same vague error as a bad OTP: a valid email with no login in progress
  // should not be distinguishable from an invalid one.
  if (!account || !account.Otp || !account.OtpExpiresTime) {
    throw ApiError.unauthorized(MESSAGES.OTP_NOT_REQUESTED);
  }

  if (new Date(account.OtpExpiresTime).getTime() < Date.now()) {
    await clearOtp(account.EmployeeId);
    throw ApiError.unauthorized(MESSAGES.OTP_EXPIRED);
  }

  if (!otpMatches(otp, account.Otp)) {
    throw ApiError.unauthorized(MESSAGES.OTP_INVALID);
  }

  // One shot: clear the code and stamp the login in the same statement.
  await mutate(
    `UPDATE dbo.EmployeeLogin
        SET Otp = NULL,
            OtpExpiresTime = NULL,
            LastLoginedAt = SYSUTCDATETIME(),
            ModifiedAt = SYSUTCDATETIME()
      WHERE EmployeeId = @employeeId`,
    { employeeId: { type: sql.Int, value: account.EmployeeId } },
  );

  const tokens = issueTokens({ employeeId: account.EmployeeId, email: account.Email });

  return {
    ...tokens,
    employee: { employeeId: account.EmployeeId, email: account.Email },
  };
}

/**
 * Shape of both OTP-issuing endpoints.
 *
 * `otp` is present only when OTP_IN_RESPONSE is on and this is not production;
 * it lets Postman and the curl script finish a login unattended. Everywhere
 * else the field is absent and the code is log-only.
 */
function otpResponse(email, expiresAt, otp) {
  return {
    email,
    otpRequired: true,
    otpExpiresTime: expiresAt.toISOString(),
    expiresInSeconds: env.OTP_EXPIRY_MINUTES * 60,
    ...(exposeOtpInResponse ? { otp, otpDebug: 'OTP_IN_RESPONSE is on - development only' } : {}),
  };
}

/** Issues a new OTP for an account that already passed the password step. */
export async function resendOtp(email) {
  const account = await findByEmail(email);
  if (!account || !account.Otp) {
    throw ApiError.unauthorized(MESSAGES.OTP_NOT_REQUESTED);
  }

  const otp = generateOtp();
  const expiresAt = otpExpiryDate();

  await mutate(
    `UPDATE dbo.EmployeeLogin
        SET Otp = @otp, OtpExpiresTime = @expiresAt, ModifiedAt = SYSUTCDATETIME()
      WHERE EmployeeId = @employeeId`,
    {
      otp: { type: sql.NVarChar(10), value: otp },
      expiresAt: { type: sql.DateTime2, value: expiresAt },
      employeeId: { type: sql.Int, value: account.EmployeeId },
    },
  );

  logger.info(`OTP for ${account.Email}: ${otp} (resent, valid ${env.OTP_EXPIRY_MINUTES} min)`);

  return otpResponse(account.Email, expiresAt, otp);
}

function clearOtp(employeeId) {
  return mutate(
    `UPDATE dbo.EmployeeLogin
        SET Otp = NULL, OtpExpiresTime = NULL, ModifiedAt = SYSUTCDATETIME()
      WHERE EmployeeId = @employeeId`,
    { employeeId: { type: sql.Int, value: employeeId } },
  );
}

/**
 * Exchanges a valid refresh token for a new token pair.
 *
 * The account is re-read rather than trusted from the token, so a deleted
 * account cannot keep refreshing its way into the system.
 */
export async function refresh(refreshToken) {
  const { employeeId } = verifyToken(refreshToken, TOKEN_TYPE.REFRESH);

  const account = await queryOne(
    `SELECT EmployeeId, Email FROM dbo.EmployeeLogin WHERE EmployeeId = @employeeId`,
    { employeeId: { type: sql.Int, value: employeeId } },
  );

  if (!account) {
    throw ApiError.unauthorized(MESSAGES.TOKEN_INVALID);
  }

  return {
    ...issueTokens({ employeeId: account.EmployeeId, email: account.Email }),
    employee: { employeeId: account.EmployeeId, email: account.Email },
  };
}

/** The signed-in account, for GET /auth/me. */
export async function getProfile(employeeId) {
  const account = await queryOne(
    `SELECT ${PUBLIC_COLUMNS} FROM dbo.EmployeeLogin WHERE EmployeeId = @employeeId`,
    { employeeId: { type: sql.Int, value: employeeId } },
  );

  if (!account) {
    throw ApiError.notFound('Account no longer exists');
  }

  return account;
}

/** Used by the seed script and, later, by employee onboarding. */
export async function emailExists(email) {
  const rows = await query('SELECT 1 AS hit FROM dbo.EmployeeLogin WHERE Email = @email', {
    email: { type: sql.NVarChar(256), value: email },
  });
  return rows.length > 0;
}

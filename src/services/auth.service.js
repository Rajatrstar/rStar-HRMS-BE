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
import { query, queryOne, mutate, withTransaction } from '../helpers/query.helper.js';
import { queueTemplatedMail } from './email.service.js';
import { verifyPassword, fakeVerifyPassword, hashPassword } from '../utils/password.js';
import { generateOtp, otpExpiryDate, otpMatches } from '../utils/otp.js';
import { issueTokens, verifyToken, TOKEN_TYPE } from '../utils/jwt.js';
import { ApiError } from '../utils/api-error.js';
import { logger } from '../utils/logger.js';
import { MESSAGES, EMAIL_TEMPLATE } from '../enums/index.js';
import { env, exposeOtpInResponse } from '../config/env.js';
import { EmployeeLogin, EmployeeDetails, EMPLOYEE_PUBLIC_PROPS } from '../models/index.js';

/** The columns safe to return to a client. HashPassword and Otp are not among them. */
const PUBLIC_COLUMNS = EmployeeLogin.select(EMPLOYEE_PUBLIC_PROPS);

function findByEmail(email) {
  return queryOne(
    `SELECT ${EmployeeLogin.select(['employeeId', 'email', 'hashPassword', 'otp', 'otpExpiresTime'])}
       FROM ${EmployeeLogin.table}
      WHERE Email = @email`,
    EmployeeLogin.params({ email }),
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

  const passwordOk = await verifyPassword(password, account.hashPassword);
  if (!passwordOk) {
    throw ApiError.unauthorized(MESSAGES.INVALID_CREDENTIALS);
  }

  // Issuing a new OTP replaces any previous one, so an old code stops working
  // the moment a new login starts.
  const { otp, expiresAt } = await issueOtpFor(account);

  return otpResponse(account.email, expiresAt, otp);
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
  if (!account || !account.otp || !account.otpExpiresTime) {
    throw ApiError.unauthorized(MESSAGES.OTP_NOT_REQUESTED);
  }

  if (new Date(account.otpExpiresTime).getTime() < Date.now()) {
    await clearOtp(account.employeeId);
    throw ApiError.unauthorized(MESSAGES.OTP_EXPIRED);
  }

  if (!otpMatches(otp, account.otp)) {
    throw ApiError.unauthorized(MESSAGES.OTP_INVALID);
  }

  // One shot: clear the code and stamp the login in the same statement.
  await mutate(
    `UPDATE ${EmployeeLogin.table}
        SET Otp = NULL,
            OtpExpiresTime = NULL,
            LastLoginedAt = SYSUTCDATETIME(),
            ModifiedAt = SYSUTCDATETIME()
      WHERE EmployeeId = @employeeId`,
    EmployeeLogin.params({ employeeId: account.employeeId }),
  );

  const tokens = issueTokens({ employeeId: account.employeeId, email: account.email });

  return {
    ...tokens,
    employee: { employeeId: account.employeeId, email: account.email },
  };
}

/**
 * Stores a fresh OTP and queues the email carrying it, in one transaction.
 *
 * Both halves commit together or neither does: an account left holding a code
 * whose email was never queued would lock the person out until the code
 * expired, with nothing in the logs to explain it.
 *
 * Queueing is a single INSERT - the SMTP conversation happens later on the
 * outbox worker - so login latency does not depend on the mail server.
 */
async function issueOtpFor(account, options = {}) {
  const {
    resent = false,
    template = EMAIL_TEMPLATE.OTP_LOGIN,
    // Where the code goes, and who it greets. The login flow has only the
    // address to work with; the forgot-password flow has a profile and uses
    // the employee's real name and work email.
    to = account.email,
    name = account.email.split('@')[0],
  } = options;

  const otp = generateOtp();
  const expiresAt = otpExpiryDate();

  await withTransaction(async (run) => {
    await run(
      `UPDATE ${EmployeeLogin.table}
          SET Otp = @otp,
              OtpExpiresTime = @expiresAt,
              ModifiedAt = SYSUTCDATETIME()
        WHERE EmployeeId = @employeeId`,
      {
        ...EmployeeLogin.params({ otp, employeeId: account.employeeId }),
        expiresAt: EmployeeLogin.param('otpExpiresTime', expiresAt),
      },
    );

    await queueTemplatedMail(
      {
        to,
        template,
        data: { name, otp, minutes: env.OTP_EXPIRY_MINUTES },
      },
      run,
    );
  });

  // Kept for the development flow that reads the code off the console; the
  // same gate that may echo the OTP in the response governs it.
  if (exposeOtpInResponse) {
    logger.info(
      `OTP for ${account.email}: ${otp}${resent ? ' (resent)' : ''} ` +
        `(valid ${env.OTP_EXPIRY_MINUTES} min)`,
    );
  }

  return { otp, expiresAt };
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
  if (!account || !account.otp) {
    throw ApiError.unauthorized(MESSAGES.OTP_NOT_REQUESTED);
  }

  const { otp, expiresAt } = await issueOtpFor(account, { resent: true });

  return otpResponse(account.email, expiresAt, otp);
}

/**
 * Finds the live employee whose work email and date of birth both match.
 *
 * The date of birth is the second factor of this step: an address alone is
 * public, so without it anyone could post a colleague's email and have a
 * reset code sent. Both are compared in SQL, so no profile is read into
 * memory on a failed attempt.
 *
 * Soft-deleted and inactive employees are excluded - an exited employee must
 * not be able to let themselves back in.
 */
function findVerifiedEmployee(workEmail, dateOfBirth) {
  return queryOne(
    `SELECT ${EmployeeDetails.select(['employeeDetailId', 'employeeId', 'firstName', 'workEmail'])}
       FROM ${EmployeeDetails.table}
      WHERE WorkEmail = @workEmail
        AND DateOfBirth = @dateOfBirth
        AND IsActive = 1
        AND DeletedAt IS NULL`,
    EmployeeDetails.params({ workEmail, dateOfBirth }),
  );
}

/**
 * Forgot password, step 1. Proves identity from the employee record, then
 * sends a reset code to the work address on file.
 *
 * The code is deliberately sent to the stored work email rather than to
 * whatever address was posted - they are the same string here, but reading it
 * back from the row is what keeps that true if the lookup ever widens.
 *
 * Note: a wrong email or date of birth is reported as such. That tells an
 * attacker who posts a real address that it belongs to an employee, which the
 * login endpoint deliberately avoids revealing. It is the behaviour asked for;
 * returning the same success either way is the stricter alternative.
 */
export async function forgotPassword(email, dateOfBirth) {
  const employee = await findVerifiedEmployee(email, dateOfBirth);

  if (!employee) {
    throw ApiError.unauthorized(MESSAGES.EMPLOYEE_NOT_VERIFIED);
  }

  // A profile with no login has no password to reset.
  if (!employee.employeeId) {
    throw ApiError.badRequest(MESSAGES.EMPLOYEE_HAS_NO_LOGIN);
  }

  const account = await queryOne(
    `SELECT ${EmployeeLogin.select(['employeeId', 'email'])}
       FROM ${EmployeeLogin.table} WHERE EmployeeId = @employeeId`,
    EmployeeLogin.params({ employeeId: employee.employeeId }),
  );

  if (!account) {
    throw ApiError.badRequest(MESSAGES.EMPLOYEE_HAS_NO_LOGIN);
  }

  // Replaces any code already outstanding, so an older one stops working.
  const { otp, expiresAt } = await issueOtpFor(account, {
    template: EMAIL_TEMPLATE.PASSWORD_RESET,
    to: employee.workEmail,
    name: employee.firstName,
  });

  return otpResponse(employee.workEmail, expiresAt, otp);
}

/**
 * Forgot password, step 2. Checks the emailed code and writes the new password.
 *
 * The account is reached through the employee profile, exactly as step 1 did,
 * so the same address works across both calls even where a login email and a
 * work email differ.
 *
 * The update is one statement: the hash lands and the code is cleared
 * together, so a code can never survive the password it authorised.
 */
export async function resetPassword(email, otp, newPassword) {
  const account = await queryOne(
    `SELECT ${EmployeeLogin.select(['employeeId', 'email', 'otp', 'otpExpiresTime'])}
       FROM ${EmployeeLogin.table} AS l
      WHERE EXISTS (
              SELECT 1 FROM ${EmployeeDetails.table} AS d
               WHERE d.EmployeeId = l.EmployeeId
                 AND d.WorkEmail = @workEmail
                 AND d.IsActive = 1
                 AND d.DeletedAt IS NULL
            )`,
    EmployeeDetails.params({ workEmail: email }),
  );

  // No account, or no reset in progress. Same error either way: which of the
  // two it is would tell an attacker whether the address exists.
  if (!account?.otp || !account.otpExpiresTime) {
    throw ApiError.unauthorized(MESSAGES.OTP_NOT_REQUESTED);
  }

  if (new Date(account.otpExpiresTime).getTime() < Date.now()) {
    await clearOtp(account.employeeId);
    throw ApiError.unauthorized(MESSAGES.OTP_EXPIRED);
  }

  if (!otpMatches(otp, account.otp)) {
    throw ApiError.unauthorized(MESSAGES.OTP_INVALID);
  }

  const hash = await hashPassword(newPassword);

  await mutate(
    `UPDATE ${EmployeeLogin.table}
        SET HashPassword = @hash,
            Otp = NULL,
            OtpExpiresTime = NULL,
            ModifiedAt = SYSUTCDATETIME()
      WHERE EmployeeId = @employeeId`,
    {
      hash: EmployeeLogin.param('hashPassword', hash),
      ...EmployeeLogin.params({ employeeId: account.employeeId }),
    },
  );

  logger.info(`Password reset completed for ${account.email} (EmployeeId ${account.employeeId})`);

  return { email: account.email, passwordUpdated: true };
}

function clearOtp(employeeId) {
  return mutate(
    `UPDATE ${EmployeeLogin.table}
        SET Otp = NULL, OtpExpiresTime = NULL, ModifiedAt = SYSUTCDATETIME()
      WHERE EmployeeId = @employeeId`,
    EmployeeLogin.params({ employeeId }),
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
    `SELECT ${EmployeeLogin.select(['employeeId', 'email'])}
       FROM ${EmployeeLogin.table} WHERE EmployeeId = @employeeId`,
    EmployeeLogin.params({ employeeId }),
  );

  if (!account) {
    throw ApiError.unauthorized(MESSAGES.TOKEN_INVALID);
  }

  return {
    ...issueTokens({ employeeId: account.employeeId, email: account.email }),
    employee: { employeeId: account.employeeId, email: account.email },
  };
}

/** The signed-in account, for GET /auth/me. */
export async function getProfile(employeeId) {
  const account = await queryOne(
    `SELECT ${PUBLIC_COLUMNS} FROM ${EmployeeLogin.table} WHERE EmployeeId = @employeeId`,
    EmployeeLogin.params({ employeeId }),
  );

  if (!account) {
    throw ApiError.notFound(MESSAGES.ACCOUNT_NOT_FOUND);
  }

  return account;
}

/** Used by the seed script and, later, by employee onboarding. */
export async function emailExists(email) {
  const rows = await query(
    `SELECT 1 AS hit FROM ${EmployeeLogin.table} WHERE Email = @email`,
    EmployeeLogin.params({ email }),
  );
  return rows.length > 0;
}

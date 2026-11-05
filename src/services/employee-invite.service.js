/**
 * Inviting an employee: creating their login with a temporary password.
 *
 * The Add Employee wizard's "Send invite" creates the employee record, then
 * calls this. The login is created with a random password and
 * MustChangePassword = 1, and the login email and that password are mailed
 * to HR (env.INVITE_NOTIFY_EMAIL), who hand them over. On first sign-in the
 * employee proves the address with the usual OTP and must choose their own
 * password - see setInitialPassword in auth.service.js.
 *
 * Calling it again before the employee has signed in issues a fresh
 * temporary password and resends the mail, so a lost email is fixed by
 * pressing the button again. Once they have set their own password the login
 * is theirs and an invite is refused.
 */
import { queryOne, withTransaction } from '../helpers/query.helper.js';
import { queueTemplatedMail } from './email.service.js';
import { EmployeeDetails, EmployeeLogin } from '../models/index.js';
import { generateTemporaryPassword, hashPassword } from '../utils/password.js';
import { ApiError } from '../utils/api-error.js';
import { logger } from '../utils/logger.js';
import { MESSAGES, ERROR_CODE, EMAIL_TEMPLATE } from '../enums/index.js';
import { env, exposeOtpInResponse } from '../config/env.js';

function uniqueViolation(error) {
  return error?.number === 2601 || error?.number === 2627;
}

/**
 * Creates (or re-issues) the employee's login and mails the details to HR.
 *
 * The login row and the queued email commit together, so HR never receives a
 * password that was not saved, and a saved password always has its email.
 */
export async function inviteEmployee(actorId, employeeDetailId) {
  const employee = await queryOne(
    `SELECT ${EmployeeDetails.select([
      'employeeDetailId',
      'employeeCode',
      'firstName',
      'lastName',
      'workEmail',
      'isActive',
    ])}
       FROM ${EmployeeDetails.table}
      WHERE EmployeeDetailId = @employeeDetailId
        AND DeletedAt IS NULL`,
    EmployeeDetails.params({ employeeDetailId }),
  );

  if (!employee) {
    throw ApiError.notFound(MESSAGES.EMPLOYEE_NOT_FOUND, { code: ERROR_CODE.EMPLOYEE_NOT_FOUND });
  }
  if (!employee.isActive) {
    throw ApiError.badRequest(MESSAGES.EMPLOYEE_INVITE_INACTIVE, {
      code: ERROR_CODE.ACCOUNT_INACTIVE,
    });
  }

  const existing = await queryOne(
    `SELECT ${EmployeeLogin.select(['employeeId', 'mustChangePassword'])}
       FROM ${EmployeeLogin.table}
      WHERE EmployeeDetailId = @employeeDetailId`,
    EmployeeLogin.params({ employeeDetailId }),
  );

  if (existing && !existing.mustChangePassword) {
    throw ApiError.conflict(MESSAGES.EMPLOYEE_ALREADY_HAS_LOGIN, {
      code: ERROR_CODE.LOGIN_ALREADY_EXISTS,
    });
  }

  const loginEmail = employee.workEmail.toLowerCase();
  const temporaryPassword = generateTemporaryPassword();
  const hash = await hashPassword(temporaryPassword);
  const employeeName = `${employee.firstName} ${employee.lastName}`.trim();

  try {
    await withTransaction(async (run) => {
      if (existing) {
        // A re-invite. The email follows the work email in case HR corrected
        // it, and any OTP from a half-finished sign-in is dropped: it was
        // issued against the old password.
        await run(
          `UPDATE ${EmployeeLogin.table}
              SET Email = @email,
                  HashPassword = @hash,
                  MustChangePassword = 1,
                  Otp = NULL,
                  OtpExpiresTime = NULL,
                  ModifiedAt = SYSUTCDATETIME()
            WHERE EmployeeId = @employeeId`,
          {
            ...EmployeeLogin.params({ email: loginEmail, employeeId: existing.employeeId }),
            hash: EmployeeLogin.param('hashPassword', hash),
          },
        );
      } else {
        await run(
          `INSERT INTO ${EmployeeLogin.table}
             (EmployeeDetailId, Email, HashPassword, MustChangePassword)
           VALUES (@employeeDetailId, @email, @hash, 1)`,
          {
            ...EmployeeLogin.params({ employeeDetailId, email: loginEmail }),
            hash: EmployeeLogin.param('hashPassword', hash),
          },
        );
      }

      await queueTemplatedMail(
        {
          to: env.INVITE_NOTIFY_EMAIL,
          template: EMAIL_TEMPLATE.EMPLOYEE_INVITE,
          data: {
            employeeName,
            employeeCode: employee.employeeCode,
            loginEmail,
            temporaryPassword,
            loginUrl: env.APP_LOGIN_URL,
          },
        },
        run,
      );
    });
  } catch (error) {
    // UQ_EmployeeLogin_Email: another employee's login already has this
    // address. Two live employees cannot share a work email, so this is a
    // login left behind by a deleted record.
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.LOGIN_EMAIL_EXISTS, {
        code: ERROR_CODE.EMAIL_ALREADY_EXISTS,
      });
    }
    throw error;
  }

  logger.info(
    `Invite ${existing ? 're-issued' : 'created'} for ${loginEmail} ` +
      `(EmployeeDetailId ${employeeDetailId}) by ${actorId}; details sent to ${env.INVITE_NOTIFY_EMAIL}`,
  );

  return {
    employeeDetailId: Number(employee.employeeDetailId),
    loginEmail,
    sentTo: env.INVITE_NOTIFY_EMAIL,
    resent: Boolean(existing),
    mustChangePassword: true,
    // Same development-only gate as the OTP echo, so Postman can finish a
    // first sign-in unattended. Never present in production.
    ...(exposeOtpInResponse ? { temporaryPassword } : {}),
  };
}

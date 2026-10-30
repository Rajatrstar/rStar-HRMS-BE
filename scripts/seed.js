/**
 * Seeds the first sign-in account so the API can be exercised immediately.
 *
 *   npm run db:seed                       -> admin@rstartec.com / admin
 *   npm run db:seed -- user@x.com secret  -> that account instead
 *
 * A login cannot exist on its own any more: dbo.EmployeeLogin.EmployeeDetailId
 * is NOT NULL, because the employee is the root of this schema and credentials
 * are a satellite. So this creates the PERSON first and then their login, in
 * one transaction.
 *
 * It deliberately assigns NO GROUP, which means the account can sign in and
 * will then be refused by every guarded endpoint. That is not a bug, it is the
 * honest result of seeding credentials and nothing else - use
 * `npm run db:create:admin` when you want an account that can actually do
 * something.
 *
 * Idempotent: an existing email has its password reset rather than being
 * inserted twice.
 */
import { getPool, closePool } from '../src/config/db.js';
import { withTransaction } from '../src/helpers/query.helper.js';
import { EmployeeLogin, EmployeeDetails } from '../src/models/index.js';
import { EMPLOYMENT_TYPE, EMPLOYMENT_STATUS } from '../src/enums/index.js';
import { hashPassword } from '../src/utils/password.js';
import { logger } from '../src/utils/logger.js';

const [emailArg, passwordArg] = process.argv.slice(2);
const email = (emailArg ?? 'admin@rstartec.com').trim().toLowerCase();
const password = passwordArg ?? 'admin';

/** EMP001, EMP002, ... - the next one no live employee is using. */
async function nextEmployeeCode(run) {
  const rows = await run(
    `SELECT ${EmployeeDetails.select(['employeeCode'])}
       FROM ${EmployeeDetails.table}
      WHERE EmployeeCode LIKE 'EMP%' AND DeletedAt IS NULL`,
  );

  const highest = rows.reduce((max, row) => {
    const digits = Number(String(row.employeeCode).slice(3));
    return Number.isInteger(digits) && digits > max ? digits : max;
  }, 0);

  return `EMP${String(highest + 1).padStart(3, '0')}`;
}

async function run_() {
  await getPool();

  const hash = await hashPassword(password);

  const outcome = await withTransaction(async (run) => {
    const [existing] = await run(
      `SELECT ${EmployeeLogin.select(['employeeId', 'employeeDetailId'])}
         FROM ${EmployeeLogin.table} WHERE Email = @email`,
      EmployeeLogin.params({ email }),
    );

    if (existing) {
      await run(
        `UPDATE ${EmployeeLogin.table}
            SET HashPassword = @hashPassword,
                Otp = NULL,
                OtpExpiresTime = NULL,
                ModifiedAt = SYSUTCDATETIME()
          WHERE EmployeeId = @employeeId`,
        EmployeeLogin.params({ employeeId: existing.employeeId, hashPassword: hash }),
      );
      return { ...existing, action: 'password reset' };
    }

    // The person first - the login has nothing to point at otherwise.
    const employeeCode = await nextEmployeeCode(run);
    const [person] = await run(
      `INSERT INTO ${EmployeeDetails.table} (
            EmployeeCode, FirstName, LastName, WorkEmail,
            EmploymentType, EmploymentStatus, DateOfJoining
       )
       OUTPUT inserted.EmployeeDetailId AS employeeDetailId
       VALUES (
            @employeeCode, @firstName, @lastName, @workEmail,
            @employmentType, @employmentStatus, @dateOfJoining
       )`,
      EmployeeDetails.params({
        employeeCode,
        // Derived from the address, because this script is handed nothing
        // else. Edit the row afterwards, or use db:create:admin, which takes
        // a real name.
        firstName: email.split('@')[0],
        lastName: 'Account',
        workEmail: email,
        employmentType: EMPLOYMENT_TYPE.FULL_TIME,
        employmentStatus: EMPLOYMENT_STATUS.ACTIVE,
        dateOfJoining: new Date().toISOString().slice(0, 10),
      }),
    );

    const [login] = await run(
      `INSERT INTO ${EmployeeLogin.table} (EmployeeDetailId, Email, HashPassword)
       OUTPUT inserted.EmployeeId AS employeeId
       VALUES (@employeeDetailId, @email, @hashPassword)`,
      EmployeeLogin.params({
        employeeDetailId: person.employeeDetailId,
        email,
        hashPassword: hash,
      }),
    );

    return {
      employeeId: login.employeeId,
      employeeDetailId: person.employeeDetailId,
      employeeCode,
      action: 'created',
    };
  });

  logger.info(
    `${outcome.action}: ${email} ` +
      `(EmployeeId ${outcome.employeeId}, EmployeeDetailId ${outcome.employeeDetailId})`,
  );
  logger.warn('No group assigned - this account will be refused by every guarded endpoint.');
  logger.warn(`Run: EMAIL=${email} npm run db:create:admin`);

  await closePool();
}

run_().catch(async (error) => {
  logger.error('Seed failed', error);
  await closePool();
  process.exit(1);
});

/**
 * Seeds the first login account so the API can be exercised immediately.
 *
 *   npm run db:seed                       -> admin@rstartec.com / admin
 *   npm run db:seed -- user@x.com secret  -> that account instead
 *
 * Idempotent: an existing email has its password reset rather than being
 * inserted twice.
 */
import { getPool, closePool } from '../src/config/db.js';
import { queryOne, mutate } from '../src/helpers/query.helper.js';
import { EmployeeLogin } from '../src/models/index.js';
import { hashPassword } from '../src/utils/password.js';
import { logger } from '../src/utils/logger.js';

const [emailArg, passwordArg] = process.argv.slice(2);
const email = (emailArg ?? 'admin@rstartec.com').trim().toLowerCase();
const password = passwordArg ?? 'admin';

async function run() {
  await getPool();

  const hash = await hashPassword(password);
  const existing = await queryOne(
    `SELECT ${EmployeeLogin.select(['employeeId'])}
       FROM ${EmployeeLogin.table} WHERE Email = @email`,
    EmployeeLogin.params({ email }),
  );

  if (existing) {
    await mutate(
      `UPDATE ${EmployeeLogin.table}
          SET HashPassword = @hash, Otp = NULL, OtpExpiresTime = NULL, ModifiedAt = SYSUTCDATETIME()
        WHERE EmployeeId = @employeeId`,
      {
        hash: EmployeeLogin.param('hashPassword', hash),
        ...EmployeeLogin.params({ employeeId: existing.employeeId }),
      },
    );
    logger.info(`Password reset for existing account ${email} (EmployeeId ${existing.employeeId})`);
  } else {
    const inserted = await queryOne(
      `INSERT INTO ${EmployeeLogin.table} (Email, HashPassword)
       OUTPUT INSERTED.EmployeeId AS employeeId
       VALUES (@email, @hash)`,
      {
        ...EmployeeLogin.params({ email }),
        hash: EmployeeLogin.param('hashPassword', hash),
      },
    );
    logger.info(`Created account ${email} (EmployeeId ${inserted.employeeId})`);
  }

  await closePool();
}

run().catch(async (error) => {
  logger.error('Seed failed', error);
  await closePool();
  process.exit(1);
});

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
import { queryOne, mutate, sql } from '../src/helpers/query.helper.js';
import { hashPassword } from '../src/utils/password.js';
import { logger } from '../src/utils/logger.js';

const [emailArg, passwordArg] = process.argv.slice(2);
const email = (emailArg ?? 'admin@rstartec.com').trim().toLowerCase();
const password = passwordArg ?? 'admin';

async function run() {
  await getPool();

  const hash = await hashPassword(password);
  const existing = await queryOne('SELECT EmployeeId FROM dbo.EmployeeLogin WHERE Email = @email', {
    email: { type: sql.NVarChar(256), value: email },
  });

  if (existing) {
    await mutate(
      `UPDATE dbo.EmployeeLogin
          SET HashPassword = @hash, Otp = NULL, OtpExpiresTime = NULL, ModifiedAt = SYSUTCDATETIME()
        WHERE EmployeeId = @employeeId`,
      {
        hash: { type: sql.NVarChar(255), value: hash },
        employeeId: { type: sql.Int, value: existing.EmployeeId },
      },
    );
    logger.info(`Password reset for existing account ${email} (EmployeeId ${existing.EmployeeId})`);
  } else {
    const inserted = await queryOne(
      `INSERT INTO dbo.EmployeeLogin (Email, HashPassword)
       OUTPUT INSERTED.EmployeeId AS employeeId
       VALUES (@email, @hash)`,
      {
        email: { type: sql.NVarChar(256), value: email },
        hash: { type: sql.NVarChar(255), value: hash },
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

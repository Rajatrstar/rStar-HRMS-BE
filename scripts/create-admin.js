/**
 * Creates an employee who can actually administer the system.
 *
 *   EMAIL=rajat.kushwaha@rstartec.com FIRST_NAME=Super LAST_NAME=Admin \
 *     npm run db:create:admin
 *
 * This exists because an administrator is THREE rows, not one, and missing the
 * third is silent:
 *
 *   1. dbo.EmployeeLogin          credentials - what you log in with
 *   2. dbo.tblEmployeeDetails     the HR profile - what the app shows, and
 *                                 what TEAM and DEPARTMENT scopes resolve
 *                                 against. The permission guard also rejects a
 *                                 profile that is inactive or soft-deleted.
 *   3. dbo.tblEmployeeRole        the role. WITHOUT IT THE ACCOUNT CAN LOG IN
 *                                 AND HOLDS ZERO PERMISSIONS - every endpoint
 *                                 answers 403 and nothing explains why.
 *
 * scripts/seed-employees.js writes only the second, which is why every account
 * on a freshly seeded database is locked out of everything.
 *
 * Idempotent. Re-running against an existing email adds whatever is missing and
 * leaves the rest alone - including the password, which is only ever written
 * when the login is created, or when RESET_PASSWORD=1 says so explicitly:
 *
 *   EMAIL=someone@rstartec.com PASSWORD='NewPass@123' RESET_PASSWORD=1 \
 *     npm run db:create:admin
 *
 * Any role code from dbo.tblRole works, so it is equally the way to make an
 * HR Admin until the admin API exists:
 *
 *   EMAIL=hr@rstartec.com ROLE=HR_ADMIN npm run db:create:admin
 */
import { randomBytes } from 'node:crypto';
import { getPool, closePool } from '../src/config/db.js';
import { withTransaction } from '../src/helpers/query.helper.js';
import {
  EmployeeLogin,
  EmployeeDetails,
  Role,
  EmployeeRole,
  AccessControlStamp,
  GLOBAL_STAMP,
} from '../src/models/index.js';
import { ROLE, EMPLOYMENT_TYPE, EMPLOYMENT_STATUS } from '../src/enums/index.js';
import { hashPassword } from '../src/utils/password.js';
import { logger } from '../src/utils/logger.js';

const EMAIL = (process.env.EMAIL ?? '').trim().toLowerCase();
const FIRST_NAME = process.env.FIRST_NAME ?? 'Super';
const LAST_NAME = process.env.LAST_NAME ?? 'Admin';
const ROLE_CODE = process.env.ROLE ?? ROLE.SUPER_ADMIN;
const RESET_PASSWORD = process.env.RESET_PASSWORD === '1';

/**
 * A generated password is printed once and never stored anywhere else, which
 * is better than a default baked into a script that lands in git. 12 bytes of
 * base64url, plus the punctuation most policies insist on.
 */
const GENERATED = `${randomBytes(9).toString('base64url')}@1`;
const PASSWORD = process.env.PASSWORD ?? GENERATED;

if (!EMAIL) {
  logger.error('EMAIL is required.  EMAIL=someone@rstartec.com npm run db:create:admin');
  process.exit(1);
}

/** EMP001, EMP002, ... - the next one no live profile is using. */
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

  const outcome = await withTransaction(async (run) => {
    const steps = [];

    /* 1 - the login ------------------------------------------------------- */
    let [login] = await run(
      `SELECT ${EmployeeLogin.select(['employeeId', 'email'])}
         FROM ${EmployeeLogin.table} WHERE Email = @email`,
      EmployeeLogin.params({ email: EMAIL }),
    );

    // Whether PASSWORD was actually written. A generated one must only ever be
    // printed when it is the real password now - printing one that was not
    // applied hands somebody a credential that cannot work.
    let passwordApplied = false;

    if (!login) {
      const inserted = await run(
        `INSERT INTO ${EmployeeLogin.table} (Email, HashPassword)
         OUTPUT inserted.EmployeeId AS employeeId
         VALUES (@email, @hashPassword)`,
        EmployeeLogin.params({ email: EMAIL, hashPassword: await hashPassword(PASSWORD) }),
      );
      login = { employeeId: inserted[0].employeeId };
      passwordApplied = true;
      steps.push(`login created (EmployeeId ${login.employeeId})`);
    } else if (RESET_PASSWORD) {
      await run(
        `UPDATE ${EmployeeLogin.table}
            SET HashPassword = @hashPassword, ModifiedAt = SYSUTCDATETIME()
          WHERE EmployeeId = @employeeId`,
        EmployeeLogin.params({
          employeeId: login.employeeId,
          hashPassword: await hashPassword(PASSWORD),
        }),
      );
      passwordApplied = true;
      steps.push(`login already existed (EmployeeId ${login.employeeId}) - password reset`);
    } else {
      steps.push(`login already existed (EmployeeId ${login.employeeId}) - password untouched`);
    }

    /* 2 - the HR profile -------------------------------------------------- */
    const [profile] = await run(
      `SELECT ${EmployeeDetails.select(['employeeDetailId', 'employeeCode'])}
         FROM ${EmployeeDetails.table}
        WHERE EmployeeId = @employeeId AND DeletedAt IS NULL`,
      EmployeeDetails.params({ employeeId: login.employeeId }),
    );

    let employeeDetailId;
    let employeeCode;

    if (profile) {
      employeeDetailId = profile.employeeDetailId;
      employeeCode = profile.employeeCode;
      steps.push(`profile already existed (${employeeCode}, EmployeeDetailId ${employeeDetailId})`);
    } else {
      employeeCode = await nextEmployeeCode(run);
      const inserted = await run(
        `INSERT INTO ${EmployeeDetails.table} (
              EmployeeId, EmployeeCode, FirstName, LastName, WorkEmail,
              EmploymentType, EmploymentStatus, DateOfJoining, CreatedBy, ModifiedBy
         )
         OUTPUT inserted.EmployeeDetailId AS employeeDetailId
         VALUES (
              @employeeId, @employeeCode, @firstName, @lastName, @workEmail,
              @employmentType, @employmentStatus, @dateOfJoining, @employeeId, @employeeId
         )`,
        EmployeeDetails.params({
          employeeId: login.employeeId,
          employeeCode,
          firstName: FIRST_NAME,
          lastName: LAST_NAME,
          // The login address doubles as the work address: this is the account
          // HR and every integration identifies the person by.
          workEmail: EMAIL,
          employmentType: EMPLOYMENT_TYPE.FULL_TIME,
          employmentStatus: EMPLOYMENT_STATUS.ACTIVE,
          dateOfJoining: new Date().toISOString().slice(0, 10),
        }),
      );
      employeeDetailId = inserted[0].employeeDetailId;
      steps.push(`profile created (${employeeCode}, EmployeeDetailId ${employeeDetailId})`);
    }

    /* 3 - the role -------------------------------------------------------- */
    const [role] = await run(
      `SELECT ${Role.select(['roleId', 'roleCode'])}
         FROM ${Role.table} WHERE RoleCode = @roleCode AND DeletedAt IS NULL`,
      Role.params({ roleCode: ROLE_CODE }),
    );

    if (!role) {
      // Thrown inside the transaction, so the login and profile roll back too.
      // Half an administrator is worse than none: it logs in and 403s.
      throw new Error(
        `No live role with code "${ROLE_CODE}". Run npm run db:seed:permissions first.`,
      );
    }

    const assigned = await run(
      `INSERT INTO ${EmployeeRole.table} (EmployeeId, RoleId, CreatedBy, ModifiedBy)
       OUTPUT inserted.EmployeeRoleId AS employeeRoleId
       SELECT @employeeId, @roleId, @employeeId, @employeeId
        WHERE NOT EXISTS (
              SELECT 1 FROM ${EmployeeRole.table}
               WHERE EmployeeId = @employeeId AND RoleId = @roleId AND DeletedAt IS NULL
        )`,
      EmployeeRole.params({ employeeId: login.employeeId, roleId: role.roleId }),
    );

    steps.push(
      assigned.length > 0
        ? `role ${ROLE_CODE} assigned`
        : `role ${ROLE_CODE} already held - left alone`,
    );

    /* Tell every instance its cached permission sets are stale. ----------- */
    await run(
      `UPDATE ${AccessControlStamp.table}
          SET Version = Version + 1, ModifiedAt = SYSUTCDATETIME()
        WHERE StampName = @stampName`,
      AccessControlStamp.params({ stampName: GLOBAL_STAMP }),
    );

    const [{ permissionCount }] = await run(
      `SELECT COUNT(DISTINCT rp.PermissionId) AS permissionCount
         FROM ${EmployeeRole.table} AS er
         JOIN dbo.tblRolePermission AS rp ON rp.RoleId = er.RoleId AND rp.DeletedAt IS NULL
        WHERE er.EmployeeId = @employeeId AND er.DeletedAt IS NULL`,
      EmployeeRole.params({ employeeId: login.employeeId }),
    );

    return { ...login, employeeDetailId, employeeCode, steps, permissionCount, passwordApplied };
  });

  for (const step of outcome.steps) logger.info(`  ${step}`);

  logger.info('');
  logger.info(`${FIRST_NAME} ${LAST_NAME} <${EMAIL}>`);
  logger.info(`  EmployeeId (login)   ${outcome.employeeId}`);
  logger.info(`  EmployeeDetailId     ${outcome.employeeDetailId}`);
  logger.info(`  EmployeeCode         ${outcome.employeeCode}`);
  logger.info(`  Role                 ${ROLE_CODE}`);
  logger.info(`  Effective permissions ${outcome.permissionCount}`);

  if (outcome.passwordApplied && !process.env.PASSWORD) {
    logger.warn('');
    logger.warn(`  PASSWORD: ${PASSWORD}`);
    logger.warn('  Generated, shown once, stored only as a bcrypt hash. Write it down.');
  } else if (!outcome.passwordApplied) {
    logger.info('  Password unchanged. Re-run with PASSWORD=... RESET_PASSWORD=1 to set a new one.');
  }

  await closePool();
}

run_().catch(async (error) => {
  logger.error('Could not create the administrator', error);
  await closePool();
  process.exit(1);
});

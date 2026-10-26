/**
 * Creates an employee who can actually administer the system.
 *
 *   EMAIL=rajat.kushwaha@rstartec.com FIRST_NAME=Super LAST_NAME=Admin \
 *     npm run db:create:admin
 *
 * This exists because an administrator is THREE rows, not one, and missing the
 * third is silent:
 *
 *   1. dbo.tblEmployeeDetails   the person. Created FIRST - the login points
 *                               at it, and TEAM and DEPARTMENT scopes resolve
 *                               against it. The permission guard rejects one
 *                               that is inactive or soft-deleted.
 *   2. dbo.EmployeeLogin        credentials. Carries a NOT NULL
 *                               EmployeeDetailId, so it physically cannot be
 *                               written before step 1.
 *   3. dbo.tblEmployeeRole      the role. WITHOUT IT THE ACCOUNT CAN SIGN IN
 *                               AND HOLDS ZERO PERMISSIONS - every endpoint
 *                               answers 403 and nothing explains why.
 *
 * scripts/seed-employees.js writes only the first, and scripts/seed.js only
 * the first two. This is the one path that produces a usable administrator.
 *
 * Idempotent. Re-running against an existing work email adds whatever is
 * missing and leaves the rest alone - including the password, which is only
 * written when the login is created, or when RESET_PASSWORD=1 says so:
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
  RolePermission,
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

  const outcome = await withTransaction(async (run) => {
    const steps = [];

    // Whether PASSWORD was actually written. A generated one must only ever be
    // printed when it is the real password now - printing one that was not
    // applied hands somebody a credential that cannot work.
    let passwordApplied = false;

    /* 1 - the person ------------------------------------------------------ */
    // Matched on work email: that is the employee's identity. The sign-in
    // address may differ in general; this script sets both the same.
    let [person] = await run(
      `SELECT ${EmployeeDetails.select(['employeeDetailId', 'employeeCode'])}
         FROM ${EmployeeDetails.table}
        WHERE WorkEmail = @workEmail AND DeletedAt IS NULL`,
      EmployeeDetails.params({ workEmail: EMAIL }),
    );

    if (person) {
      steps.push(
        `employee already existed (${person.employeeCode}, ` +
          `EmployeeDetailId ${person.employeeDetailId})`,
      );
    } else {
      const employeeCode = await nextEmployeeCode(run);
      const inserted = await run(
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
          firstName: FIRST_NAME,
          lastName: LAST_NAME,
          workEmail: EMAIL,
          employmentType: EMPLOYMENT_TYPE.FULL_TIME,
          employmentStatus: EMPLOYMENT_STATUS.ACTIVE,
          dateOfJoining: new Date().toISOString().slice(0, 10),
        }),
      );
      person = { employeeDetailId: inserted[0].employeeDetailId, employeeCode };
      steps.push(`employee created (${employeeCode}, EmployeeDetailId ${person.employeeDetailId})`);
    }

    const { employeeDetailId, employeeCode } = person;

    /* 2 - the login ------------------------------------------------------- */
    // One login per employee, enforced by UQ_EmployeeLogin_EmployeeDetailId.
    let [login] = await run(
      `SELECT ${EmployeeLogin.select(['employeeId', 'email'])}
         FROM ${EmployeeLogin.table} WHERE EmployeeDetailId = @employeeDetailId`,
      EmployeeLogin.params({ employeeDetailId }),
    );

    if (!login) {
      const inserted = await run(
        `INSERT INTO ${EmployeeLogin.table} (EmployeeDetailId, Email, HashPassword)
         OUTPUT inserted.EmployeeId AS employeeId
         VALUES (@employeeDetailId, @email, @hashPassword)`,
        EmployeeLogin.params({
          employeeDetailId,
          email: EMAIL,
          hashPassword: await hashPassword(PASSWORD),
        }),
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

    /* 3 - the role -------------------------------------------------------- */
    const [role] = await run(
      `SELECT ${Role.select(['roleId', 'roleCode'])}
         FROM ${Role.table} WHERE RoleCode = @roleCode AND DeletedAt IS NULL`,
      Role.params({ roleCode: ROLE_CODE }),
    );

    if (!role) {
      // Thrown inside the transaction, so the employee and login roll back
      // too. Half an administrator is worse than none: it signs in and 403s.
      throw new Error(
        `No live role with code "${ROLE_CODE}". Run npm run db:seed:permissions first.`,
      );
    }

    const assigned = await run(
      `INSERT INTO ${EmployeeRole.table} (EmployeeDetailId, RoleId, CreatedBy, ModifiedBy)
       OUTPUT inserted.EmployeeRoleId AS employeeRoleId
       SELECT @employeeDetailId, @roleId, @employeeDetailId, @employeeDetailId
        WHERE NOT EXISTS (
              SELECT 1 FROM ${EmployeeRole.table}
               WHERE EmployeeDetailId = @employeeDetailId
                 AND RoleId = @roleId
                 AND DeletedAt IS NULL
        )`,
      EmployeeRole.params({ employeeDetailId, roleId: role.roleId }),
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
         FROM ${EmployeeRole.table}  AS er
         JOIN ${RolePermission.table} AS rp ON rp.RoleId = er.RoleId AND rp.DeletedAt IS NULL
        WHERE er.EmployeeDetailId = @employeeDetailId AND er.DeletedAt IS NULL`,
      EmployeeRole.params({ employeeDetailId }),
    );

    return {
      employeeId: login.employeeId,
      employeeDetailId,
      employeeCode,
      steps,
      permissionCount,
      passwordApplied,
    };
  });

  for (const step of outcome.steps) logger.info(`  ${step}`);

  logger.info('');
  logger.info(`${FIRST_NAME} ${LAST_NAME} <${EMAIL}>`);
  logger.info(`  EmployeeDetailId      ${outcome.employeeDetailId}   <- the subject of everything`);
  logger.info(`  EmployeeId (login)    ${outcome.employeeId}`);
  logger.info(`  EmployeeCode          ${outcome.employeeCode}`);
  logger.info(`  Role                  ${ROLE_CODE}`);
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

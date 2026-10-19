/**
 * Seeds one employee profile per existing login account.
 *
 *   npm run db:seed:employees
 *
 * Idempotent: a login that already has a profile is left alone, so re-running
 * after adding an account fills in only the gap. Nothing is overwritten -
 * these rows are meant to be edited by hand once they exist.
 *
 * The first account seeded becomes the manager of the rest, purely so the
 * ManagerId join has something to return during development.
 */
import { getPool, closePool } from '../src/config/db.js';
import { query, queryOne } from '../src/helpers/query.helper.js';
import { EmployeeLogin, EmployeeDetails } from '../src/models/index.js';
import { EMPLOYMENT_TYPE, EMPLOYMENT_STATUS, GENDER } from '../src/enums/index.js';
import { logger } from '../src/utils/logger.js';

/**
 * Profile details per login email. An account with no entry here still gets a
 * row, built from its email address - see fallbackProfile().
 */
const PROFILES = {
  'anmol.ghai@rstartec.com': {
    employeeCode: 'EMP001',
    firstName: 'Anmol',
    lastName: 'Ghai',
    phone: '+91-98765-43210',
    dateOfBirth: '1995-06-12',
    gender: GENDER.MALE,
    employmentType: EMPLOYMENT_TYPE.FULL_TIME,
    dateOfJoining: '2024-01-15',
    workLocation: 'Mohali',
  },
  'akshay.singh@rstartec.com': {
    employeeCode: 'EMP002',
    firstName: 'Akshay',
    lastName: 'Singh',
    phone: '+91-98765-43211',
    dateOfBirth: '1993-11-23',
    gender: GENDER.MALE,
    employmentType: EMPLOYMENT_TYPE.FULL_TIME,
    dateOfJoining: '2024-03-01',
    workLocation: 'Mohali',
  },
};

/**
 * For a login with no entry above: enough of a profile to be a valid row.
 *
 * The code comes from nextFreeCode() rather than the loop index, because the
 * codes in PROFILES are fixed - numbering by position hands EMP001 to whoever
 * happens to sort first and collides with the real EMP001.
 */
function fallbackProfile(email, usedCodes) {
  const local = email.split('@')[0];
  const [first, ...rest] = local.split(/[._-]/);
  const capitalise = (word) => word.charAt(0).toUpperCase() + word.slice(1);

  return {
    employeeCode: nextFreeCode(usedCodes),
    firstName: capitalise(first),
    lastName: rest.length ? capitalise(rest.join(' ')) : 'Unknown',
    employmentType: EMPLOYMENT_TYPE.FULL_TIME,
    dateOfJoining: new Date().toISOString().slice(0, 10),
    workLocation: 'Mohali',
  };
}

/** Lowest EMPnnn not already spoken for. Mutates `usedCodes` to claim it. */
function nextFreeCode(usedCodes) {
  for (let n = 1; ; n += 1) {
    const code = `EMP${String(n).padStart(3, '0')}`;
    if (!usedCodes.has(code)) {
      usedCodes.add(code);
      return code;
    }
  }
}

async function run() {
  await getPool();

  const logins = await query(
    `SELECT ${EmployeeLogin.select(['employeeId', 'email'])}
       FROM ${EmployeeLogin.table} ORDER BY EmployeeId`,
  );

  if (logins.length === 0) {
    logger.warn('No rows in dbo.EmployeeLogin - run npm run db:seed first.');
    await closePool();
    return;
  }

  // Every code that is already claimed - by a row in the table, or by an entry
  // in PROFILES that this run is about to insert.
  const taken = await query(
    `SELECT ${EmployeeDetails.select(['employeeCode'])} FROM ${EmployeeDetails.table}`,
  );
  const usedCodes = new Set([
    ...taken.map((row) => row.employeeCode),
    ...Object.values(PROFILES).map((profile) => profile.employeeCode),
  ]);

  let managerDetailId = null;
  let created = 0;

  for (const login of logins) {
    const existing = await queryOne(
      `SELECT ${EmployeeDetails.select(['employeeDetailId'])}
         FROM ${EmployeeDetails.table}
        WHERE EmployeeId = @employeeId AND DeletedAt IS NULL`,
      EmployeeDetails.params({ employeeId: login.employeeId }),
    );

    if (existing) {
      logger.info(`skip ${login.email} - profile already exists (${existing.employeeDetailId})`);
      managerDetailId ??= existing.employeeDetailId;
      continue;
    }

    const profile = PROFILES[login.email] ?? fallbackProfile(login.email, usedCodes);

    const inserted = await queryOne(
      `INSERT INTO ${EmployeeDetails.table} (
         EmployeeId, EmployeeCode, FirstName, LastName, WorkEmail, Phone, Gender,
         DateOfBirth, ManagerId, EmploymentType, EmploymentStatus, DateOfJoining,
         WorkLocation, IsActive, CreatedBy, ModifiedBy
       )
       OUTPUT INSERTED.EmployeeDetailId AS employeeDetailId
       VALUES (
         @employeeId, @employeeCode, @firstName, @lastName, @workEmail, @phone, @gender,
         @dateOfBirth, @managerId, @employmentType, @employmentStatus, @dateOfJoining,
         @workLocation, @isActive, @createdBy, @modifiedBy
       )`,
      EmployeeDetails.params({
        employeeId: login.employeeId,
        employeeCode: profile.employeeCode,
        firstName: profile.firstName,
        lastName: profile.lastName,
        // The login address is the official one by definition.
        workEmail: login.email,
        phone: profile.phone ?? null,
        gender: profile.gender ?? null,
        dateOfBirth: profile.dateOfBirth ?? null,
        // The first profile seeded has nobody above it.
        managerId: managerDetailId,
        employmentType: profile.employmentType,
        employmentStatus: EMPLOYMENT_STATUS.ACTIVE,
        dateOfJoining: profile.dateOfJoining,
        workLocation: profile.workLocation,
        isActive: true,
        // A seed has no human behind it; the audit columns stay NULL.
        createdBy: null,
        modifiedBy: null,
      }),
    );

    managerDetailId ??= inserted.employeeDetailId;
    created += 1;
    logger.info(
      `created ${profile.employeeCode} ${profile.firstName} ${profile.lastName} ` +
        `<${login.email}> (EmployeeDetailId ${inserted.employeeDetailId})`,
    );
  }

  logger.info(`Done. ${created} profile(s) created, ${logins.length - created} already present.`);
  await closePool();
}

run().catch(async (error) => {
  logger.error('Employee seed failed', error);
  await closePool();
  process.exit(1);
});

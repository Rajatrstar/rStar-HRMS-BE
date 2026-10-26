/**
 * Seeds a handful of employee records to develop against.
 *
 *   npm run db:seed:employees
 *
 * These are PEOPLE, not accounts. dbo.tblEmployeeDetails is the root of this
 * schema and a row here stands on its own - plenty of employees never sign in.
 * Giving one of them a login is a separate step, and the only thing that can
 * do it today is scripts/create-admin.js.
 *
 * This script used to run the other way round: it walked dbo.EmployeeLogin and
 * invented a profile for each account. That inverted with the schema. A login
 * now REQUIRES an employee, so there can no longer be an account missing one.
 *
 * Idempotent: an employee whose work email is already on file is left alone,
 * so re-running fills gaps and overwrites nothing. These rows are meant to be
 * edited by hand once they exist.
 *
 * The first entry becomes the manager of the rest, purely so the ManagerId
 * join and the TEAM scope have something to return during development.
 */
import { getPool, closePool } from '../src/config/db.js';
import { queryOne } from '../src/helpers/query.helper.js';
import { EmployeeDetails } from '../src/models/index.js';
import { EMPLOYMENT_TYPE, EMPLOYMENT_STATUS, GENDER } from '../src/enums/index.js';
import { logger } from '../src/utils/logger.js';

/** In order. The first is made everybody else's manager. */
const EMPLOYEES = [
  {
    employeeCode: 'EMP001',
    firstName: 'Anmol',
    lastName: 'Ghai',
    workEmail: 'anmol.ghai@rstartec.com',
    phone: '+91-98765-43210',
    dateOfBirth: '1995-06-12',
    gender: GENDER.MALE,
    employmentType: EMPLOYMENT_TYPE.FULL_TIME,
    dateOfJoining: '2024-01-15',
    workLocation: 'Mohali',
  },
  {
    employeeCode: 'EMP002',
    firstName: 'Akshay',
    lastName: 'Singh',
    workEmail: 'akshay.singh@rstartec.com',
    phone: '+91-98765-43211',
    dateOfBirth: '1993-11-23',
    gender: GENDER.MALE,
    employmentType: EMPLOYMENT_TYPE.FULL_TIME,
    dateOfJoining: '2024-03-01',
    workLocation: 'Mohali',
  },
];

/** The live employee with this work email, or null. */
function findByWorkEmail(workEmail) {
  return queryOne(
    `SELECT ${EmployeeDetails.select(['employeeDetailId', 'employeeCode'])}
       FROM ${EmployeeDetails.table}
      WHERE WorkEmail = @workEmail AND DeletedAt IS NULL`,
    EmployeeDetails.params({ workEmail }),
  );
}

async function insertEmployee(employee, managerId) {
  const row = await queryOne(
    `INSERT INTO ${EmployeeDetails.table} (
          EmployeeCode, FirstName, LastName, WorkEmail, Phone, DateOfBirth,
          Gender, EmploymentType, EmploymentStatus, DateOfJoining,
          WorkLocation, ManagerId
     )
     OUTPUT inserted.EmployeeDetailId AS employeeDetailId
     VALUES (
          @employeeCode, @firstName, @lastName, @workEmail, @phone, @dateOfBirth,
          @gender, @employmentType, @employmentStatus, @dateOfJoining,
          @workLocation, @managerId
     )`,
    EmployeeDetails.params({
      employeeCode: employee.employeeCode,
      firstName: employee.firstName,
      lastName: employee.lastName,
      workEmail: employee.workEmail,
      phone: employee.phone ?? null,
      dateOfBirth: employee.dateOfBirth ?? null,
      gender: employee.gender ?? null,
      employmentType: employee.employmentType,
      employmentStatus: EMPLOYMENT_STATUS.ACTIVE,
      dateOfJoining: employee.dateOfJoining,
      workLocation: employee.workLocation ?? null,
      managerId,
    }),
  );

  return row.employeeDetailId;
}

async function run() {
  await getPool();

  let managerId = null;
  let created = 0;

  for (const employee of EMPLOYEES) {
    const existing = await findByWorkEmail(employee.workEmail);

    if (existing) {
      logger.info(`${employee.workEmail} already on file (${existing.employeeCode})`);
      managerId ??= existing.employeeDetailId;
      continue;
    }

    // managerId is null for the first one - nobody to report to yet, and a
    // self-reference is rejected by CK_tblEmployeeDetails_NotOwnManager.
    const employeeDetailId = await insertEmployee(employee, managerId);
    created += 1;
    logger.info(
      `created ${employee.employeeCode} ${employee.firstName} ${employee.lastName} ` +
        `(EmployeeDetailId ${employeeDetailId})` +
        (managerId === null ? ' - manager for the rest' : ` reporting to ${managerId}`),
    );

    managerId ??= employeeDetailId;
  }

  logger.info(
    created === 0
      ? 'Nothing to do - every seeded employee already exists'
      : `Created ${created} employee(s)`,
  );
  logger.info('None of them can sign in. Use npm run db:create:admin to add a login.');

  await closePool();
}

run().catch(async (error) => {
  logger.error('Employee seed failed', error);
  await closePool();
  process.exit(1);
});

/**
 * The four demonstration groups and one user in each.
 *
 *   npm run db:seed:users              adds what is missing, deletes nothing
 *   RESET=1 npm run db:seed:users      DELETES EVERY EMPLOYEE AND LOGIN first
 *
 * This is the fastest way to get a database you can actually test access
 * control against: four logins that see four different applications.
 *
 *   Super Admin   every module, every action        (the system group)
 *   HR Admin      people and places, no rights screen
 *   Manager       read the directory, edit records, no admin
 *   Employee      their dashboard, nothing else
 *
 * RESET=1 IS DESTRUCTIVE and refuses to run with NODE_ENV=production. It
 * removes every row from tblEmployeeDetails, EmployeeLogin and
 * tblRevokedSession, and clears the CreatedBy/ModifiedBy stamps that point at
 * them - organisations and locations survive, with their audit trail blanked.
 * Everything it is about to delete is written to a JSON file first, named in
 * the output.
 *
 * The password is the same for all four so a tester can switch between them.
 * Override it with PASSWORD=..., and never run this anywhere real.
 */
import { writeFileSync } from 'node:fs';
import { getPool, closePool, sql } from '../src/config/db.js';
import { withTransaction } from '../src/helpers/query.helper.js';
import { MODULE } from '../src/enums/module.enum.js';
import { EMPLOYMENT_TYPE, EMPLOYMENT_STATUS } from '../src/enums/index.js';
import { hashPassword } from '../src/utils/password.js';
import { logger } from '../src/utils/logger.js';

const RESET = process.env.RESET === '1';
const PASSWORD = process.env.PASSWORD ?? 'Welcome@123';
const BACKUP_PATH = process.env.BACKUP_PATH ?? 'users-backup.json';

/** A right, written the short way: only the flags that are on. */
const view = { canView: true };
const viewPrint = { canView: true, canPrint: true };

/**
 * The three ordinary groups. Super Admin is not here: it is the system group,
 * its rights are not stored as rows, and seed-access.js creates it.
 *
 * These are a STARTING POINT, not policy. Every one of them is six checkboxes
 * on the group screen afterwards.
 */
const GROUPS = [
  {
    groupName: 'HR Admin',
    description: 'Runs the employee lifecycle and the organisation master data',
    rights: {
      [MODULE.DASHBOARD]: view,
      [MODULE.EMPLOYEE_MANAGEMENT]: view,
      // The whole lifecycle: onboard, update, exit, delete, export, email.
      [MODULE.EMPLOYEES]: {
        canView: true,
        canAdd: true,
        canEdit: true,
        canDelete: true,
        canPrint: true,
        canMail: true,
      },
      [MODULE.ORGANIZATION_SETUP]: view,
      // No Add on Organizations: creating a legal entity is not an HR task.
      [MODULE.ORGANIZATIONS]: { canView: true, canEdit: true, canPrint: true },
      [MODULE.LOCATIONS]: {
        canView: true,
        canAdd: true,
        canEdit: true,
        canDelete: true,
        canPrint: true,
      },
      [MODULE.ADMINISTRATION]: view,
      // Read-only on the rights screen: they can SEE what a group holds when
      // somebody asks why they cannot do something, without being able to
      // change it.
      [MODULE.GROUPS]: view,
      // But they CAN put a new joiner into a group, which is an HR task.
      // See the warning this script prints: it is also how they could put
      // themselves into Super Admin.
      [MODULE.USER_ACCESS]: { canView: true, canEdit: true },
    },
  },
  {
    groupName: 'Manager',
    description: 'Reads the employee directory and maintains their team records',
    rights: {
      [MODULE.DASHBOARD]: view,
      [MODULE.EMPLOYEE_MANAGEMENT]: view,
      // Edit but not Add or Delete: a manager corrects a record, they do not
      // onboard or remove people.
      [MODULE.EMPLOYEES]: { canView: true, canEdit: true, canPrint: true },
      [MODULE.ORGANIZATION_SETUP]: view,
      [MODULE.ORGANIZATIONS]: view,
      [MODULE.LOCATIONS]: viewPrint,
    },
  },
  {
    groupName: 'Employee',
    description: 'Self-service only',
    rights: {
      /*
        Dashboard and nothing else, which deserves an explanation.

        There is no row scope in this model: holding View on Employees means
        seeing EVERY employee's record - date of birth, personal email,
        emergency contact, tax regime. "Let staff look each other up" is
        therefore not a small grant, it is the whole HR database.

        An employee's own record is already reachable through /auth/me, which
        needs no module right at all. If a staff directory is wanted, the
        right answer is a Directory module exposing a handful of columns, not
        View on Employees.
      */
      [MODULE.DASHBOARD]: view,
    },
  },
];

/** One user per group. The Super Admin keeps the email Postman already uses. */
const USERS = [
  {
    employeeCode: 'EMP001',
    firstName: 'Super',
    lastName: 'Admin',
    email: 'rajat.kushwaha@rstartec.com',
    groupName: 'Super Admin',
    designation: 'System Administrator',
  },
  {
    employeeCode: 'EMP002',
    firstName: 'HR',
    lastName: 'Admin',
    email: 'hr.admin@rstartec.com',
    groupName: 'HR Admin',
    designation: 'HR Manager',
  },
  {
    employeeCode: 'EMP003',
    firstName: 'Team',
    lastName: 'Manager',
    email: 'manager@rstartec.com',
    groupName: 'Manager',
    designation: 'Engineering Manager',
  },
  {
    employeeCode: 'EMP004',
    firstName: 'Regular',
    lastName: 'Employee',
    email: 'employee@rstartec.com',
    groupName: 'Employee',
    designation: 'Software Engineer',
  },
];

const RIGHT_COLUMNS = ['CanView', 'CanAdd', 'CanEdit', 'CanDelete', 'CanPrint', 'CanMail'];

async function run() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run against NODE_ENV=production.');
  }

  const pool = await getPool();
  const steps = [];

  /* ---------------------------------------------------------------- backup */
  if (RESET) {
    const existing = await pool.request().query(`
      SELECT employees = (SELECT * FROM dbo.tblEmployeeDetails FOR JSON PATH),
             logins    = (SELECT * FROM dbo.EmployeeLogin      FOR JSON PATH),
             sessions  = (SELECT * FROM dbo.tblRevokedSession  FOR JSON PATH)`);
    const row = existing.recordset[0];
    writeFileSync(
      BACKUP_PATH,
      JSON.stringify(
        {
          takenAt: new Date().toISOString(),
          employees: JSON.parse(row.employees ?? '[]'),
          logins: JSON.parse(row.logins ?? '[]'),
          revokedSessions: JSON.parse(row.sessions ?? '[]'),
        },
        null,
        2,
      ),
    );
    steps.push(`backed up to ${BACKUP_PATH} (password hashes included - delete it when done)`);
  }

  await withTransaction(async (exec) => {
    /* --------------------------------------------------------------- wipe */
    if (RESET) {
      // Order matters: the children of tblEmployeeDetails go first, then the
      // audit stamps that point at it are blanked, then the rows themselves.
      // Self-references (ManagerId, CreatedBy) have to be cleared in a
      // separate UPDATE or the DELETE trips over its own table.
      await exec('DELETE FROM dbo.tblRevokedSession;');
      await exec('DELETE FROM dbo.EmployeeLogin;');
      await exec(`
        UPDATE dbo.tblOrganization         SET CreatedBy = NULL, ModifiedBy = NULL;
        UPDATE dbo.tblOrganizationLocation SET CreatedBy = NULL, ModifiedBy = NULL;
        UPDATE dbo.tblModule               SET CreatedBy = NULL, ModifiedBy = NULL;
        UPDATE dbo.tblGroup                SET CreatedBy = NULL, ModifiedBy = NULL;
        UPDATE dbo.tblAccessRight          SET CreatedBy = NULL, ModifiedBy = NULL;
        UPDATE dbo.tblEmployeeDetails
           SET ManagerId = NULL, SecondaryManagerId = NULL, AdditionalManagerId = NULL,
               CreatedBy = NULL, ModifiedBy = NULL;`);
      const removed = await exec(
        'DELETE FROM dbo.tblEmployeeDetails OUTPUT deleted.EmployeeDetailId AS id;',
      );
      steps.push(`deleted ${removed.length} employee(s) and every login`);

      // Every group except the system one goes too, so a re-run does not
      // leave last run's groups beside this run's. Hard delete, not the soft
      // delete the API uses: these are demonstration rows, and a soft-deleted
      // group keeps its name reserved against nothing.
      const droppedGroups = await exec(
        `DELETE FROM dbo.tblGroup
          OUTPUT deleted.GroupName AS name
          WHERE IsSystem = 0;`,
      );
      if (droppedGroups.length > 0) {
        steps.push(`deleted ${droppedGroups.length} non-system group(s)`);
      }

      // The identities restart so the four below are 1-4 and the seeded
      // EmployeeCodes line up with their ids. Only safe because the tables
      // are now empty - tblGroup reseeds to the system group's id, so the
      // next group is 2 rather than colliding with it.
      await exec("DBCC CHECKIDENT ('dbo.tblEmployeeDetails', RESEED, 0) WITH NO_INFOMSGS;");
      await exec("DBCC CHECKIDENT ('dbo.EmployeeLogin', RESEED, 0) WITH NO_INFOMSGS;");
      const [maxGroup] = await exec(
        'SELECT seed = ISNULL(MAX(GroupId), 0) FROM dbo.tblGroup;',
      );
      await exec(`DBCC CHECKIDENT ('dbo.tblGroup', RESEED, ${Number(maxGroup.seed)}) WITH NO_INFOMSGS;`);
    }

    /* ------------------------------------------------------------- groups */
    // Super Admin is the system group, created by seed-access.js. Renamed
    // here if it is still called Administrator, so the four group names
    // match what the team asked for.
    await exec(`
      UPDATE dbo.tblGroup
         SET GroupName = 'Super Admin', ModifiedAt = SYSUTCDATETIME()
       WHERE IsSystem = 1 AND DeletedAt IS NULL AND GroupName <> 'Super Admin';`);

    const [systemGroup] = await exec(
      'SELECT GroupId FROM dbo.tblGroup WHERE IsSystem = 1 AND DeletedAt IS NULL;',
    );
    if (!systemGroup) {
      throw new Error('No system group found. Run npm run db:seed:access first.');
    }

    const groupIds = new Map([['Super Admin', Number(systemGroup.GroupId)]]);

    for (const group of GROUPS) {
      const [row] = await exec(
        `MERGE dbo.tblGroup WITH (HOLDLOCK) AS target
         USING (SELECT @groupName AS GroupName) AS source
            ON target.GroupName = source.GroupName AND target.DeletedAt IS NULL
          WHEN MATCHED THEN UPDATE SET
               Description = @description, IsActive = 1, ModifiedAt = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN INSERT (GroupName, Description, IsActive)
          VALUES (@groupName, @description, 1)
          OUTPUT $action AS action, INSERTED.GroupId AS groupId;`,
        {
          groupName: { type: sql.NVarChar(100), value: group.groupName },
          description: { type: sql.NVarChar(255), value: group.description },
        },
      );

      const groupId = Number(row.groupId);
      groupIds.set(group.groupName, groupId);

      // Rewritten from scratch each run, so re-running after editing the
      // table above actually changes the group rather than merging into
      // whatever was there before.
      await exec('DELETE FROM dbo.tblAccessRight WHERE GroupId = @groupId;', {
        groupId: { type: sql.Int, value: groupId },
      });

      for (const [moduleId, flags] of Object.entries(group.rights)) {
        await exec(
          `INSERT INTO dbo.tblAccessRight (GroupId, ModuleId, ${RIGHT_COLUMNS.join(', ')})
           VALUES (@groupId, @moduleId, ${RIGHT_COLUMNS.map((c) => '@' + c).join(', ')});`,
          {
            groupId: { type: sql.Int, value: groupId },
            moduleId: { type: sql.Int, value: Number(moduleId) },
            ...Object.fromEntries(
              RIGHT_COLUMNS.map((column) => [
                column,
                { type: sql.Bit, value: Boolean(flags[column[0].toLowerCase() + column.slice(1)]) },
              ]),
            ),
          },
        );
      }

      steps.push(
        `${row.action === 'INSERT' ? 'created' : 'refreshed'} group "${group.groupName}" ` +
          `(GroupId ${groupId}, ${Object.keys(group.rights).length} modules)`,
      );
    }

    /* -------------------------------------------------------------- users */
    const passwordHash = await hashPassword(PASSWORD);

    for (const user of USERS) {
      const groupId = groupIds.get(user.groupName);
      if (groupId === undefined) throw new Error(`No group "${user.groupName}".`);

      const [employee] = await exec(
        `MERGE dbo.tblEmployeeDetails WITH (HOLDLOCK) AS target
         USING (SELECT @workEmail AS WorkEmail) AS source
            ON target.WorkEmail = source.WorkEmail AND target.DeletedAt IS NULL
          WHEN MATCHED THEN UPDATE SET
               GroupId = @groupId, FirstName = @firstName, LastName = @lastName,
               IsActive = 1, ModifiedAt = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN INSERT
               (EmployeeCode, FirstName, LastName, WorkEmail, Designation,
                EmploymentType, EmploymentStatus, DateOfJoining, IsActive, GroupId)
          VALUES
               (@employeeCode, @firstName, @lastName, @workEmail, @designation,
                @employmentType, @employmentStatus, SYSUTCDATETIME(), 1, @groupId)
          OUTPUT $action AS action, INSERTED.EmployeeDetailId AS employeeDetailId;`,
        {
          employeeCode: { type: sql.NVarChar(50), value: user.employeeCode },
          firstName: { type: sql.NVarChar(100), value: user.firstName },
          lastName: { type: sql.NVarChar(100), value: user.lastName },
          workEmail: { type: sql.NVarChar(255), value: user.email },
          designation: { type: sql.NVarChar(150), value: user.designation },
          employmentType: { type: sql.NVarChar(30), value: EMPLOYMENT_TYPE.FULL_TIME },
          employmentStatus: { type: sql.NVarChar(30), value: EMPLOYMENT_STATUS.ACTIVE },
          groupId: { type: sql.Int, value: groupId },
        },
      );

      const employeeDetailId = Number(employee.employeeDetailId);

      // The column is HashPassword, not PasswordHash - see the model. There is
      // no verified flag on a login: verification is the OTP step at sign-in.
      await exec(
        `MERGE dbo.EmployeeLogin WITH (HOLDLOCK) AS target
         USING (SELECT @email AS Email) AS source
            ON target.Email = source.Email
          WHEN MATCHED THEN UPDATE SET
               HashPassword = @hash, EmployeeDetailId = @employeeDetailId,
               ModifiedAt = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN INSERT (EmployeeDetailId, Email, HashPassword)
          VALUES (@employeeDetailId, @email, @hash);`,
        {
          email: { type: sql.NVarChar(255), value: user.email },
          hash: { type: sql.NVarChar(255), value: passwordHash },
          employeeDetailId: { type: sql.BigInt, value: employeeDetailId },
        },
      );

      steps.push(
        `${employee.action === 'INSERT' ? 'created' : 'updated'} ${user.email} ` +
          `-> ${user.groupName} (EmployeeDetailId ${employeeDetailId})`,
      );
    }

    /* Every cached permission set is now wrong. */
    await exec(
      `UPDATE dbo.tblAccessControlStamp
          SET Version = Version + 1, ModifiedAt = SYSUTCDATETIME()
        WHERE StampName = 'global';`,
    );
  });

  for (const step of steps) logger.info(`  ${step}`);

  logger.info('');
  logger.info(`  password for all four: ${PASSWORD}`);
  logger.info('');
  logger.warn('  HR Admin can edit User Access, so it can move anybody - including');
  logger.warn('  itself - into Super Admin. That is the honest consequence of letting');
  logger.warn('  HR assign groups; untick Edit on User Access for that group if you');
  logger.warn('  would rather only Super Admin could.');

  await closePool();
}

run().catch(async (error) => {
  logger.error('Seeding users failed', error);
  await closePool();
  process.exit(1);
});

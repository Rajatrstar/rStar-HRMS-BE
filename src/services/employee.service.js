/**
 * Employee onboarding and the employee record.
 *
 * ACCESS is settled before the request arrives, by requireAccess in the
 * route file: a group either holds the right on MODULE.EMPLOYEES or it does
 * not. There is no row scope - holding View on Employees means seeing every
 * employee, which is how the group model works and what it was chosen for.
 *
 * (Until 008 each right carried a scope - OWN / TEAM / DEPARTMENT / ALL -
 * and these functions narrowed their own WHERE clause to match. If per-team
 * visibility is wanted again it belongs as a column on tblAccessRight, read
 * here in one place, not as a second grant channel.)
 *
 * Nothing is ever hard-deleted: EmployeeLogin and every CreatedBy in the
 * schema point at these ids. Delete stamps DeletedAt.
 */
import { query, queryOne } from '../helpers/query.helper.js';
import { EmployeeDetails, EmployeeLogin, EMPLOYEE_DETAILS_PUBLIC_PROPS } from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { MESSAGES, ERROR_CODE, EMPLOYMENT_STATUS } from '../enums/index.js';

const EMPLOYEE_COLUMNS = EMPLOYEE_DETAILS_PUBLIC_PROPS.map(
  (prop) => `d.${EmployeeDetails.col(prop)} AS ${prop}`,
).join(', ');

const OUTPUT_COLUMNS = EMPLOYEE_DETAILS_PUBLIC_PROPS.map(
  (prop) => `inserted.${EmployeeDetails.col(prop)} AS ${prop}`,
).join(', ');

/**
 * The statuses that mean "no longer working here".
 *
 * Deactivation requires one of these rather than accepting any status: a row
 * with IsActive = 0 and EmploymentStatus = 'Active' is a contradiction that
 * every report afterwards has to decide how to read.
 */
export const EXIT_STATUSES = Object.freeze([
  EMPLOYMENT_STATUS.EXITED,
  EMPLOYMENT_STATUS.RESIGNED,
  EMPLOYMENT_STATUS.TERMINATED,
  EMPLOYMENT_STATUS.INACTIVE,
]);

/**
 * BIGINT arrives from the driver as a STRING - it cannot know the value fits,
 * so it never narrows. Ids go out as JSON numbers because
 * `data.employeeDetailId === 3` silently being false is a worse bug than a
 * ceiling this table will not reach, and the validator already refuses a path
 * id above Number.MAX_SAFE_INTEGER.
 */
const ID_PROPS = Object.freeze([
  'employeeDetailId',
  'departmentId',
  'designationId',
  'workLocationId',
  'managerId',
  'secondaryManagerId',
  'additionalManagerId',
]);

function withNumericIds(row) {
  if (!row) return row;

  const copy = { ...row };
  for (const prop of ID_PROPS) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  return copy;
}

const allWithNumericIds = (rows) => rows.map(withNumericIds);

/** 2627 is a UNIQUE/PK constraint, 2601 a unique index. Both reach here. */
function uniqueViolation(error) {
  return error?.number === 2601 || error?.number === 2627;
}

/**
 * Turns a unique-index violation into the right 409.
 *
 * Caught rather than pre-checked: a SELECT first is a second round trip that
 * is still wrong under concurrency, because the row can land between the
 * check and the write. The index is the only authority. Which rule broke is
 * read from the index NAME, which is stable because the migration declares it.
 */
function conflictFor(error) {
  if (!uniqueViolation(error)) return error;

  if (/_WorkEmail\b/i.test(error.message)) {
    return ApiError.conflict(MESSAGES.EMPLOYEE_EMAIL_EXISTS, {
      code: ERROR_CODE.EMAIL_ALREADY_EXISTS,
    });
  }
  return ApiError.conflict(MESSAGES.EMPLOYEE_CODE_EXISTS, {
    code: ERROR_CODE.CODE_ALREADY_EXISTS,
  });
}

/**
 * The few columns a write path needs before it decides anything.
 *
 * Its own narrow SELECT rather than a call to getEmployee(): a write needs to
 * know the joining date and the current status to validate against, not the
 * seventy-column record, and this runs on every update.
 */
async function loadForWrite(employeeDetailId) {
  const row = await queryOne(
    `SELECT TOP (1)
            EmployeeDetailId AS employeeDetailId,
            ManagerId        AS managerId,
            DepartmentId     AS departmentId,
            EmployeeCode     AS employeeCode,
            FirstName        AS firstName,
            LastName         AS lastName,
            IsActive         AS isActive,
            EmploymentStatus AS employmentStatus,
            DateOfJoining    AS dateOfJoining,
            DateOfLeaving    AS dateOfLeaving
       FROM ${EmployeeDetails.table}
      WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL`,
    EmployeeDetails.params({ employeeDetailId }),
  );

  if (!row) throw ApiError.notFound(MESSAGES.EMPLOYEE_NOT_FOUND);

  return row;
}

/**
 * Loads the row and confirms the caller may write to it, or 404s.
 *
 * The same 404 for "no such employee" and "not yours" - see the module
 * header. Returns the row, because every caller needs it next anyway.
 */
async function loadWritable(employeeDetailId) {
  const row = await loadForWrite(employeeDetailId);
  if (!row) throw ApiError.notFound(MESSAGES.EMPLOYEE_NOT_FOUND);
  return row;
}

/**
 * How many live employees report to this person.
 *
 * Exiting or deleting a manager without this check leaves their team pointing
 * at somebody no screen lists. A FOREIGN KEY cannot catch it: the rows stay
 * valid, because both operations are an UPDATE.
 */
async function directReportCount(employeeDetailId) {
  const row = await queryOne(
    `SELECT COUNT(*) AS reports
       FROM ${EmployeeDetails.table}
      WHERE ManagerId = @employeeDetailId AND DeletedAt IS NULL`,
    { employeeDetailId: EmployeeDetails.param('managerId', employeeDetailId) },
  );

  return row?.reports ?? 0;
}

async function assertNoDirectReports(employeeDetailId) {
  const reports = await directReportCount(employeeDetailId);

  if (reports > 0) {
    throw ApiError.conflict(MESSAGES.EMPLOYEE_HAS_REPORTS, {
      code: ERROR_CODE.EMPLOYEE_HAS_REPORTS,
      directReports: reports,
    });
  }
}

/**
 * A manager must exist, be live and be active.
 *
 * The FOREIGN KEY only proves the row exists - it is happy to point at
 * somebody who left last year, and a reporting line into an exited employee
 * is how a leave request ends up with nobody to approve it.
 */
async function assertManagerUsable(managerId, employeeDetailId = null) {
  if (managerId === null || managerId === undefined) return;

  if (employeeDetailId !== null && Number(managerId) === Number(employeeDetailId)) {
    throw ApiError.badRequest(MESSAGES.MANAGER_IS_SELF, { code: ERROR_CODE.MANAGER_NOT_FOUND });
  }

  const row = await queryOne(
    `SELECT TOP (1) EmployeeDetailId AS employeeDetailId
       FROM ${EmployeeDetails.table}
      WHERE EmployeeDetailId = @managerId AND DeletedAt IS NULL AND IsActive = 1`,
    { managerId: EmployeeDetails.param('managerId', managerId) },
  );

  if (!row) {
    throw ApiError.badRequest(MESSAGES.MANAGER_NOT_FOUND, { code: ERROR_CODE.MANAGER_NOT_FOUND });
  }
}

/** YYYY-MM-DD from either a Date out of the driver or a validated string. */
function asDateOnly(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A page of employees the caller may see.
 *
 * Paged rather than returning everything: this table is the one that grows
 * with the company, and an unbounded list is a slow endpoint waiting for the
 * headcount that makes it one. COUNT(*) OVER() rides along with the page, so
 * the total costs no second round trip.
 */
export async function listEmployees(access, filters) {
  const where = ['d.DeletedAt IS NULL'];
  const bound = {};

  if (filters.search) {
    // One box, four columns - what a user means by typing into "Search".
    where.push(`(d.FirstName LIKE @search OR d.LastName LIKE @search
                 OR d.EmployeeCode LIKE @search OR d.WorkEmail LIKE @search)`);
    bound.search = EmployeeDetails.param('firstName', `%${filters.search}%`);
  }

  if (filters.employmentStatus) {
    where.push('d.EmploymentStatus = @employmentStatus');
    bound.employmentStatus = EmployeeDetails.param('employmentStatus', filters.employmentStatus);
  }

  if (filters.isActive !== undefined) {
    where.push('d.IsActive = @isActive');
    bound.isActive = EmployeeDetails.param('isActive', filters.isActive);
  }

  if (filters.departmentId !== undefined) {
    where.push('d.DepartmentId = @departmentId');
    bound.departmentId = EmployeeDetails.param('departmentId', filters.departmentId);
  }

  if (filters.managerId !== undefined) {
    where.push('d.ManagerId = @managerId');
    bound.managerId = EmployeeDetails.param('managerId', filters.managerId);
  }

  const offset = (filters.page - 1) * filters.pageSize;

  const rows = await query(
    `SELECT ${EMPLOYEE_COLUMNS}, COUNT(*) OVER() AS totalCount
       FROM ${EmployeeDetails.table} AS d
      WHERE ${where.join(' AND ')}
      ORDER BY d.FirstName, d.LastName, d.EmployeeDetailId
     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    {
      ...bound,
      offset: EmployeeDetails.param('employeeSerialNo', offset),
      pageSize: EmployeeDetails.param('employeeSerialNo', filters.pageSize),
    },
  );

  // COUNT(*) OVER() is on every row and belongs on none of them.
  const total = rows.length > 0 ? rows[0].totalCount : 0;
  const employees = allWithNumericIds(rows.map(({ totalCount, ...rest }) => rest));

  return {
    employees,
    meta: {
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      totalPages: Math.ceil(total / filters.pageSize),
    },
  };
}

/**
 * One employee, or a 404.
 *
 * A 404 and not a 403: the caller already holds View on the module, so the
 * only reason to be here without a row is that there is no row.
 */
export async function getEmployee(access, employeeDetailId) {
  const row = await queryOne(
    `SELECT ${EMPLOYEE_COLUMNS},
            (SELECT COUNT(*) FROM ${EmployeeDetails.table} AS r
              WHERE r.ManagerId = d.EmployeeDetailId AND r.DeletedAt IS NULL) AS directReports,
            (SELECT COUNT(*) FROM ${EmployeeLogin.table} AS l
              WHERE l.EmployeeDetailId = d.EmployeeDetailId) AS hasLogin
       FROM ${EmployeeDetails.table} AS d
      WHERE d.EmployeeDetailId = @employeeDetailId
        AND d.DeletedAt IS NULL`,
    EmployeeDetails.params({ employeeDetailId }),
  );

  if (!row) throw ApiError.notFound(MESSAGES.EMPLOYEE_NOT_FOUND);

  return { ...withNumericIds(row), hasLogin: row.hasLogin > 0 };
}

/* -------------------------------------------------------------------------- */
/* Write                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The columns create and update both write.
 *
 * One list, used to build the INSERT, the UPDATE and their parameters, so the
 * three cannot drift apart - a column added to one and forgotten in another
 * is the classic way an edit screen silently stops saving a field.
 *
 * EmployeeSerialNo is absent on purpose: the sequence default fills it, and
 * naming it here would let a caller choose their own serial number.
 */
const WRITABLE_PROPS = Object.freeze([
  'employeeCode',
  'zohoUserId',
  'zohoRecordId',
  'internalEmployeeId',
  'firstName',
  'middleName',
  'lastName',
  'nickName',
  'workEmail',
  'personalEmail',
  'phone',
  'workPhone',
  'workPhoneExtension',
  'emergencyContactNumber',
  'emergencyContactRelation',
  'dateOfBirth',
  'gender',
  'maritalStatus',
  'address',
  'presentAddressLine1',
  'presentAddressLine2',
  'presentCity',
  'presentState',
  'presentCountry',
  'presentPostalCode',
  'permanentAddress',
  'permanentAddressLine1',
  'permanentAddressLine2',
  'permanentCity',
  'permanentState',
  'permanentCountry',
  'permanentPostalCode',
  'panNumber',
  'aadharNumber',
  'departmentId',
  'designationId',
  'workLocationId',
  'workLocation',
  'designation',
  'department',
  'jobRole',
  'employeeBand',
  'userType',
  'sourceOfHire',
  'seatingLocation',
  'managerId',
  'secondaryManagerId',
  'additionalManagerId',
  'employmentType',
  'employmentStatus',
  'dateOfJoining',
  'probationEndDate',
  'contractorEndDate',
  'totalExperience',
  'currentExperience',
  'onboardingStatus',
  'approvalStatus',
  'backgroundVerificationStatus',
  'workFromOffice',
  'billableStatus',
  'projectName',
  'taxRegime',
  'systemConfiguration',
  'additionalAccessories',
  'aboutMe',
  'expertise',
  'tags',
  'profilePhotoUrl',
]);

/**
 * dateOfLeaving is NOT in WRITABLE_PROPS. It is set by deactivate() and
 * nowhere else - letting an ordinary edit write a leaving date would mean an
 * employee could be given one while still IsActive = 1, which is the exact
 * contradiction the deactivate endpoint exists to prevent.
 *
 * EmploymentStatus is the one column here that is NOT NULL *and* carries a
 * database default. Naming a column in an INSERT overrides its default, so an
 * omitted one does not quietly fall back to 'Active' - it arrives as NULL and
 * fails the NOT NULL constraint with a 500. The two callers handle that
 * differently, and both are deliberate: create substitutes the default,
 * update keeps whatever is already there.
 */
function writableParams(input) {
  return EmployeeDetails.params(
    Object.fromEntries(WRITABLE_PROPS.map((prop) => [prop, input[prop] ?? null])),
  );
}

/**
 * Onboards an employee.
 *
 * No login is created here. Plenty of staff never sign in, and an account is
 * a separate decision with its own permission - see scripts/create-admin.js
 * for the shape of creating both together.
 */
export async function createEmployee(actorId, input) {
  await assertManagerUsable(input.managerId);
  await assertManagerUsable(input.secondaryManagerId);
  await assertManagerUsable(input.additionalManagerId);

  const columns = WRITABLE_PROPS.map((prop) => EmployeeDetails.col(prop)).join(', ');
  const values = WRITABLE_PROPS.map((prop) => `@${prop}`).join(', ');

  try {
    const row = await queryOne(
      `INSERT INTO ${EmployeeDetails.table} (${columns}, IsActive, CreatedBy, ModifiedBy)
       OUTPUT ${OUTPUT_COLUMNS}
       VALUES (${values}, 1, @actorId, @actorId)`,
      {
        // A new employee is Active unless the caller says otherwise. This
        // mirrors DF_tblEmployeeDetails_EmploymentStatus rather than relying
        // on it - see writableParams above for why the default cannot fire.
        ...writableParams({
          ...input,
          employmentStatus: input.employmentStatus ?? EMPLOYMENT_STATUS.ACTIVE,
        }),
        actorId: EmployeeDetails.param('createdBy', actorId),
      },
    );

    return withNumericIds(row);
  } catch (error) {
    throw conflictFor(error);
  }
}

/**
 * Full replace, PUT semantics: a field the client leaves out becomes NULL.
 *
 * The same choice the organisation module made, for the same reason - the
 * edit screen posts the whole form back, and a PATCH that keeps an old value
 * is how a field the user cleared reappears after a reload.
 *
 * IsActive is not writable here either. Activating somebody is not the
 * mirror image of exiting them, and pretending it is would let an edit undo
 * an exit without recording who did it or when.
 */
export async function updateEmployee(access, actorId, employeeDetailId, input) {
  await loadWritable(employeeDetailId);

  await assertManagerUsable(input.managerId, employeeDetailId);
  await assertManagerUsable(input.secondaryManagerId, employeeDetailId);
  await assertManagerUsable(input.additionalManagerId, employeeDetailId);

  /*
    Every column is overwritten, PUT-style - except EmploymentStatus, which is
    NOT NULL and so has no NULL to be set to. COALESCE keeps the current value
    when the client omits it.

    Defaulting it to 'Active' here instead, the way create does, would let an
    ordinary edit of an exited employee flip their status back to Active while
    IsActive stayed 0 - the exact contradiction the deactivate endpoint
    exists to prevent, arriving through the back door.
  */
  const assignments = WRITABLE_PROPS.map((prop) =>
    prop === 'employmentStatus'
      ? 'EmploymentStatus = COALESCE(@employmentStatus, EmploymentStatus)'
      : `${EmployeeDetails.col(prop)} = @${prop}`,
  ).join(',\n              ');

  let row;
  try {
    row = await queryOne(
      `UPDATE ${EmployeeDetails.table}
          SET ${assignments},
              ModifiedBy = @actorId,
              ModifiedAt = SYSUTCDATETIME()
        OUTPUT ${OUTPUT_COLUMNS}
        WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL`,
      {
        ...writableParams(input),
        ...EmployeeDetails.params({ employeeDetailId }),
        actorId: EmployeeDetails.param('modifiedBy', actorId),
      },
    );
  } catch (error) {
    throw conflictFor(error);
  }

  // OUTPUT returns nothing when the WHERE matched nothing. loadWritable
  // already proved the row was there, so this only fires on a race.
  if (!row) throw ApiError.notFound(MESSAGES.EMPLOYEE_NOT_FOUND);

  return withNumericIds(row);
}

/**
 * Exits an employee: IsActive = 0, plus the facts that make the exit real.
 *
 * MANDATORY, and the reason each one is:
 *
 *   dateOfLeaving     - the exit date. Without it "when did they leave?" has
 *                       no answer, and final pay, leave encashment and every
 *                       headcount-as-at report are computed from it.
 *   employmentStatus  - one of EXIT_STATUSES. IsActive = 0 says they are gone;
 *                       this says HOW, which is a different question and the
 *                       one notice pay and rehire eligibility turn on.
 *
 * Optional: contractorEndDate, for a contract that ends on its own date.
 *
 * REFUSED, each for a concrete reason rather than tidiness:
 *
 *   - exiting yourself. You would withdraw your own access mid-request, and
 *     the next call would 403 with no way back in.
 *   - exiting somebody who still has direct reports. Their team would point
 *     at a manager no screen lists.
 *   - a leaving date before the joining date. The database would refuse it
 *     anyway (CK_tblEmployeeDetails_LeavingAfterJoining); catching it here
 *     makes it a 400 naming the field instead of a 500 naming a constraint.
 *   - exiting somebody already exited, which is almost always a double-submit.
 *
 * Their access goes with it: the resolver reads IsActive, so every guarded
 * endpoint starts refusing them within the access cache's 60-second TTL, and
 * login refuses outright from the next attempt.
 */
export async function deactivateEmployee(access, actorId, employeeDetailId, input) {
  const current = await loadWritable(employeeDetailId);

  if (Number(employeeDetailId) === Number(actorId)) {
    throw ApiError.conflict(MESSAGES.CANNOT_DEACTIVATE_SELF, {
      code: ERROR_CODE.SELF_ACTION_BLOCKED,
    });
  }

  if (!current.isActive) {
    throw ApiError.conflict(MESSAGES.EMPLOYEE_ALREADY_INACTIVE, {
      code: ERROR_CODE.EMPLOYEE_ALREADY_INACTIVE,
      employmentStatus: current.employmentStatus,
      dateOfLeaving: asDateOnly(current.dateOfLeaving),
    });
  }

  const joining = asDateOnly(current.dateOfJoining);
  if (joining && input.dateOfLeaving < joining) {
    throw ApiError.badRequest(MESSAGES.INVALID_EXIT_DATE, {
      code: ERROR_CODE.INVALID_EXIT_DATE,
      dateOfJoining: joining,
      dateOfLeaving: input.dateOfLeaving,
    });
  }

  await assertNoDirectReports(employeeDetailId);

  const row = await queryOne(
    `UPDATE ${EmployeeDetails.table}
        SET IsActive          = 0,
            EmploymentStatus  = @employmentStatus,
            DateOfLeaving     = @dateOfLeaving,
            ContractorEndDate = COALESCE(@contractorEndDate, ContractorEndDate),
            ModifiedBy        = @actorId,
            ModifiedAt        = SYSUTCDATETIME()
      OUTPUT ${OUTPUT_COLUMNS}
      WHERE EmployeeDetailId = @employeeDetailId
        AND DeletedAt IS NULL
        AND IsActive = 1`,
    {
      ...EmployeeDetails.params({
        employeeDetailId,
        employmentStatus: input.employmentStatus,
        dateOfLeaving: input.dateOfLeaving,
        contractorEndDate: input.contractorEndDate ?? null,
      }),
      actorId: EmployeeDetails.param('modifiedBy', actorId),
    },
  );

  // `AND IsActive = 1` in the WHERE makes this the concurrency case: two
  // exits raced and the other one won.
  if (!row) {
    throw ApiError.conflict(MESSAGES.EMPLOYEE_ALREADY_INACTIVE, {
      code: ERROR_CODE.EMPLOYEE_ALREADY_INACTIVE,
    });
  }

  return withNumericIds(row);
}

/**
 * Soft-deletes the record.
 *
 * Distinct from deactivation: an exited employee is still part of the
 * company's history and appears in last year's payroll. A deleted record is
 * one that should not have existed - a duplicate, a candidate who never
 * joined, a typo. That is why delete asks for no exit details: there is no
 * exit to describe.
 *
 * Any login stays behind. EmployeeLogin.EmployeeDetailId is NOT NULL, so the
 * row cannot be orphaned, and the account stops working anyway: the resolver
 * treats a soft-deleted employee as inactive and login refuses outright.
 */
export async function deleteEmployee(access, actorId, employeeDetailId) {
  await loadWritable(employeeDetailId);

  if (Number(employeeDetailId) === Number(actorId)) {
    throw ApiError.conflict(MESSAGES.CANNOT_DELETE_SELF, {
      code: ERROR_CODE.SELF_ACTION_BLOCKED,
    });
  }

  await assertNoDirectReports(employeeDetailId);

  const row = await queryOne(
    `UPDATE ${EmployeeDetails.table}
        SET DeletedAt  = SYSUTCDATETIME(),
            IsActive   = 0,
            ModifiedBy = @actorId,
            ModifiedAt = SYSUTCDATETIME()
      OUTPUT deleted.EmployeeDetailId AS employeeDetailId,
             deleted.EmployeeCode     AS employeeCode,
             deleted.FirstName        AS firstName,
             deleted.LastName         AS lastName
      WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL`,
    {
      ...EmployeeDetails.params({ employeeDetailId }),
      actorId: EmployeeDetails.param('modifiedBy', actorId),
    },
  );

  if (!row) throw ApiError.notFound(MESSAGES.EMPLOYEE_NOT_FOUND);

  return withNumericIds(row);
}

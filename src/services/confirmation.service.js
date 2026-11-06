/**
 * Probation and confirmation.
 *
 * Section 01 and 03 of docs/ATTENDANCE-LEAVE.html. The HR document makes
 * probation a STATE rather than a date that has passed, because three
 * different things depend on it: CL/SL accrues at one day a month, EL does
 * not accrue at all, and the leave dashboard shows a different set of tiles.
 *
 * TWO WAYS IN, AND BOTH ARE REQUIRED. The nightly job confirms whoever has
 * reached their probation end date; HR can confirm early, extend, or shorten.
 * A purely computed status could express the first and not the second, which
 * is why the column is stored.
 *
 * EVERY CHANGE WRITES A HISTORY ROW, including the automatic ones, and the
 * reason is mandatory on all of them. "Why is this person still on probation
 * in month seven" is the question the table exists to answer, and an empty
 * reason column answers "when" but never "why".
 */
import { query, queryOne, withTransaction } from '../helpers/query.helper.js';
import {
  EmployeeDetails,
  EmploymentStatusHistory,
  EMPLOYMENT_STATUS_HISTORY_PUBLIC_PROPS,
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import {
  MESSAGES,
  ERROR_CODE,
  CONFIRMATION_STATUS,
  CONFIRMATION_CHANGE_TYPE,
  DEFAULT_PROBATION_MONTHS,
} from '../enums/index.js';
import { today, addMonths, dateOf } from '../helpers/date.helper.js';

const EMPLOYEE_FIELDS = `
  EmployeeDetailId   AS employeeDetailId,
  EmployeeCode       AS employeeCode,
  FirstName          AS firstName,
  LastName           AS lastName,
  WorkEmail          AS workEmail,
  DateOfJoining      AS dateOfJoining,
  ProbationEndDate   AS probationEndDate,
  ProbationMonths    AS probationMonths,
  ConfirmationStatus AS confirmationStatus,
  ConfirmedOn        AS confirmedOn,
  ManagerId          AS managerId
`;

function shape(row) {
  if (!row) return row;

  const copy = { ...row };
  for (const prop of ['employeeDetailId', 'managerId', 'changedBy', 'employmentStatusHistoryId']) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  for (const prop of [
    'dateOfJoining',
    'probationEndDate',
    'confirmedOn',
    'oldProbationEndDate',
    'newProbationEndDate',
  ]) {
    if (copy[prop]) copy[prop] = dateOf(copy[prop]);
  }
  return copy;
}

const shapeAll = (rows) => rows.map(shape);

/**
 * The probation end date for a joining date and a length.
 *
 * Exported because the employee-creation path should use it too: a new
 * joiner whose ProbationEndDate is computed here and nowhere else cannot
 * end up with a date that disagrees with their ProbationMonths.
 *
 * addMonths clamps to the end of the month, so somebody who joins on 31
 * January finishes probation on 30 April rather than 1 May.
 */
export function probationEndFor(dateOfJoining, probationMonths = DEFAULT_PROBATION_MONTHS) {
  if (!dateOfJoining) return null;
  return addMonths(dateOfJoining, Number(probationMonths));
}

async function loadEmployee(employeeDetailId) {
  const row = shape(
    await queryOne(
      `SELECT ${EMPLOYEE_FIELDS} FROM ${EmployeeDetails.table}
        WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL`,
      EmployeeDetails.params({ employeeDetailId }),
    ),
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.EMPLOYEE_NOT_FOUND, { code: ERROR_CODE.EMPLOYEE_NOT_FOUND });
  }
  return row;
}

/* -------------------------------------------------------------------------
   Reading
   ------------------------------------------------------------------------- */

/**
 * Who is on probation, and who is due.
 *
 * `dueWithinDays` is what makes this a work queue rather than a list: HR
 * wants the people whose probation ends in the next fortnight, so the
 * conversation happens before the date rather than after it. Anybody
 * already past their date is included whatever the window, because they
 * are overdue and that is more urgent, not less.
 */
export async function listDueForConfirmation({ dueWithinDays = 30, includeOverdue = true } = {}) {
  const horizon = addMonths(today(), 0);
  const cutoff = dueWithinDays
    ? new Date(new Date(`${horizon}T00:00:00Z`).getTime() + dueWithinDays * 86_400_000)
        .toISOString()
        .slice(0, 10)
    : horizon;

  return shapeAll(
    await query(
      `SELECT ${EMPLOYEE_FIELDS},
              CASE WHEN ProbationEndDate < @today THEN 1 ELSE 0 END AS isOverdue
         FROM ${EmployeeDetails.table}
        WHERE DeletedAt IS NULL AND IsActive = 1
          AND ConfirmationStatus = @probation
          AND ProbationEndDate IS NOT NULL
          AND (ProbationEndDate <= @cutoff OR (@includeOverdue = 1 AND ProbationEndDate < @today))
        ORDER BY ProbationEndDate`,
      {
        probation: EmployeeDetails.param('confirmationStatus', CONFIRMATION_STATUS.PROBATION),
        today: EmployeeDetails.param('probationEndDate', today()),
        cutoff: EmployeeDetails.param('probationEndDate', cutoff),
        includeOverdue: EmployeeDetails.param('isActive', includeOverdue ? 1 : 0),
      },
    ),
  );
}

export async function historyFor(employeeDetailId) {
  return shapeAll(
    await query(
      `SELECT ${EmploymentStatusHistory.select(EMPLOYMENT_STATUS_HISTORY_PUBLIC_PROPS)}
         FROM ${EmploymentStatusHistory.table}
        WHERE EmployeeDetailId = @employeeDetailId
        ORDER BY ChangedAt DESC`,
      EmploymentStatusHistory.params({ employeeDetailId }),
    ),
  );
}

/* -------------------------------------------------------------------------
   Changing
   ------------------------------------------------------------------------- */

/**
 * The shared write: update the employee, append the history row, in one
 * transaction.
 *
 * Neither half means anything alone - a status change with no history is
 * the thing this module exists to prevent, and a history row with no change
 * is a lie - so they are never committed separately.
 */
async function applyChange({
  employee,
  toStatus,
  changeType,
  reason,
  actorId,
  newProbationEndDate = null,
  confirmedOn = null,
}) {
  await withTransaction(async (run) => {
    await run(
      `UPDATE ${EmployeeDetails.table}
          SET ConfirmationStatus = @toStatus,
              ProbationEndDate   = COALESCE(@newProbationEndDate, ProbationEndDate),
              ConfirmedOn        = @confirmedOn,
              ModifiedBy         = @actorId,
              ModifiedAt         = SYSUTCDATETIME()
        WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL`,
      {
        ...EmployeeDetails.params({
          employeeDetailId: employee.employeeDetailId,
          confirmationStatus: toStatus,
          probationEndDate: newProbationEndDate,
          confirmedOn,
        }),
        toStatus: EmployeeDetails.param('confirmationStatus', toStatus),
        newProbationEndDate: EmployeeDetails.param('probationEndDate', newProbationEndDate),
        confirmedOn: EmployeeDetails.param('confirmedOn', confirmedOn),
        actorId: EmployeeDetails.param('modifiedBy', actorId),
      },
    );

    await run(
      `INSERT INTO ${EmploymentStatusHistory.table}
              (EmployeeDetailId, FromStatus, ToStatus, OldProbationEndDate, NewProbationEndDate,
               ChangeType, Reason, ChangedBy)
       VALUES (@employeeDetailId, @fromStatus, @toStatus, @oldProbationEndDate,
               @newProbationEndDate, @changeType, @reason, @changedBy)`,
      EmploymentStatusHistory.params({
        employeeDetailId: employee.employeeDetailId,
        fromStatus: employee.confirmationStatus,
        toStatus,
        oldProbationEndDate: employee.probationEndDate,
        newProbationEndDate,
        changeType,
        reason,
        changedBy: actorId,
      }),
    );
  });

  return loadEmployee(employee.employeeDetailId);
}

/**
 * Confirm somebody.
 *
 * `confirmedOn` defaults to today and may be backdated - HR signing off in
 * April for a probation that ended in March should record March, because EL
 * accrual starts from that date and backdating it is the difference between
 * the employee getting the month or not.
 *
 * DOES NOT GRANT EL ITSELF. The accrual job reads ConfirmationStatus and
 * ConfirmedOn and credits from there, so confirmation has exactly one
 * effect - the status - and the balance arithmetic stays in one place.
 */
export async function confirm(actorId, employeeDetailId, { reason, confirmedOn = null, changeType = null } = {}) {
  const employee = await loadEmployee(employeeDetailId);

  if (employee.confirmationStatus === CONFIRMATION_STATUS.CONFIRMED) {
    throw ApiError.conflict(MESSAGES.ALREADY_CONFIRMED, { code: ERROR_CODE.ALREADY_CONFIRMED });
  }
  if (!reason?.trim()) {
    throw ApiError.badRequest(MESSAGES.VALIDATION_FAILED, { reason: 'Reason is required' });
  }

  return applyChange({
    employee,
    toStatus: CONFIRMATION_STATUS.CONFIRMED,
    changeType: changeType ?? CONFIRMATION_CHANGE_TYPE.MANUAL_CONFIRM,
    reason: reason.trim(),
    actorId,
    confirmedOn: confirmedOn ?? today(),
  });
}

/**
 * Extend or shorten probation.
 *
 * ONE FUNCTION FOR BOTH, because the only difference is which direction the
 * date moved and that is derivable - two endpoints would mean two places to
 * get the history row wrong. The ChangeType recorded is EXTEND or SHORTEN
 * accordingly, so the trail still reads correctly.
 */
export async function changeProbationEnd(actorId, employeeDetailId, { newProbationEndDate, reason }) {
  const employee = await loadEmployee(employeeDetailId);

  if (employee.confirmationStatus === CONFIRMATION_STATUS.CONFIRMED) {
    throw ApiError.conflict(MESSAGES.ALREADY_CONFIRMED, { code: ERROR_CODE.ALREADY_CONFIRMED });
  }
  if (!reason?.trim()) {
    throw ApiError.badRequest(MESSAGES.VALIDATION_FAILED, { reason: 'Reason is required' });
  }
  if (employee.dateOfJoining && newProbationEndDate < employee.dateOfJoining) {
    throw ApiError.badRequest(MESSAGES.PROBATION_END_BEFORE_JOINING, {
      code: ERROR_CODE.PROBATION_END_BEFORE_JOINING,
    });
  }

  const isExtension =
    employee.probationEndDate === null || newProbationEndDate > employee.probationEndDate;

  return applyChange({
    employee,
    // Still on probation - moving the date is not a confirmation.
    toStatus: CONFIRMATION_STATUS.PROBATION,
    changeType: isExtension
      ? CONFIRMATION_CHANGE_TYPE.EXTEND
      : CONFIRMATION_CHANGE_TYPE.SHORTEN,
    reason: reason.trim(),
    actorId,
    newProbationEndDate,
    confirmedOn: null,
  });
}

/**
 * The nightly job: confirm everybody whose probation end date has passed.
 *
 * IDEMPOTENT. It selects only rows still on PROBATION, so a second run the
 * same night finds nothing and a run after a missed night catches up
 * without anybody writing a backfill.
 *
 * One employee's failure does not stop the rest: a single bad row - a
 * NULL joining date, a constraint nobody anticipated - must not leave
 * everybody after it in the list unconfirmed and silently un-accruing.
 */
export async function confirmDueEmployees(actorId = null, { onDate = today() } = {}) {
  const due = shapeAll(
    await query(
      `SELECT ${EMPLOYEE_FIELDS} FROM ${EmployeeDetails.table}
        WHERE DeletedAt IS NULL AND IsActive = 1
          AND ConfirmationStatus = @probation
          AND ProbationEndDate IS NOT NULL
          AND ProbationEndDate <= @onDate`,
      {
        probation: EmployeeDetails.param('confirmationStatus', CONFIRMATION_STATUS.PROBATION),
        onDate: EmployeeDetails.param('probationEndDate', onDate),
      },
    ),
  );

  const confirmed = [];
  const failed = [];

  for (const employee of due) {
    try {
      await applyChange({
        employee,
        toStatus: CONFIRMATION_STATUS.CONFIRMED,
        changeType: CONFIRMATION_CHANGE_TYPE.AUTO_CONFIRM,
        reason: `Probation period completed on ${employee.probationEndDate}`,
        actorId,
        // The scheduled date, not today: a job that runs late must not
        // record a confirmation date later than the one that was earned.
        confirmedOn: employee.probationEndDate,
      });
      confirmed.push(employee.employeeDetailId);
    } catch (error) {
      failed.push({ employeeDetailId: employee.employeeDetailId, message: error.message });
    }
  }

  return { due: due.length, confirmed, failed };
}

/**
 * Backfill a probation end date for somebody who has none.
 *
 * Rows that predate migration 014 may have a joining date and no probation
 * end date, which would make them invisible to the confirmation job
 * forever - they are never "due", so they stay on probation and never
 * accrue EL. Run once from the seed, or whenever an import leaves gaps.
 */
export async function backfillProbationEndDates(actorId = null) {
  const rows = shapeAll(
    await query(
      `SELECT ${EMPLOYEE_FIELDS} FROM ${EmployeeDetails.table}
        WHERE DeletedAt IS NULL AND IsActive = 1
          AND ProbationEndDate IS NULL
          AND DateOfJoining IS NOT NULL
          AND ConfirmationStatus = @probation`,
      { probation: EmployeeDetails.param('confirmationStatus', CONFIRMATION_STATUS.PROBATION) },
    ),
  );

  for (const employee of rows) {
    const probationEndDate = probationEndFor(
      employee.dateOfJoining,
      employee.probationMonths ?? DEFAULT_PROBATION_MONTHS,
    );

    await queryOne(
      `UPDATE ${EmployeeDetails.table}
          SET ProbationEndDate = @probationEndDate, ModifiedBy = @actorId,
              ModifiedAt = SYSUTCDATETIME()
        OUTPUT inserted.EmployeeDetailId AS employeeDetailId
        WHERE EmployeeDetailId = @employeeDetailId`,
      {
        ...EmployeeDetails.params({
          employeeDetailId: employee.employeeDetailId,
          probationEndDate,
        }),
        actorId: EmployeeDetails.param('modifiedBy', actorId),
      },
    );
  }

  return rows.length;
}

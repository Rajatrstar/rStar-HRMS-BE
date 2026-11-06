/**
 * Compensatory off: the manager agrees the work happened, HR grants the day.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE, from the HR document: a comp-off is
 * NEVER credited merely because attendance exists on a weekend. approve()
 * writes no ledger entry at all - it moves the request to
 * APPROVED_AWAITING_CREDIT and stops. credit() is a separate call, made by
 * HR, and it is the only thing in this file that touches a balance.
 *
 * That separation is the reason for two tables, and the reason approve()
 * looks like it is missing something. It is not.
 */
import { query, queryOne, withTransaction } from '../helpers/query.helper.js';
import {
  CompOffRequest,
  CompOffCredit,
  AttendanceDay,
  EmployeeDetails,
  LeaveType,
  COMP_OFF_REQUEST_PUBLIC_PROPS,
  COMP_OFF_CREDIT_PUBLIC_PROPS,
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import {
  MESSAGES,
  ERROR_CODE,
  COMP_OFF_REQUEST_STATUS,
  COMP_OFF_CREDIT_STATUS,
  COMP_OFF_DAYS_PER_REQUEST,
  LEDGER_ENTRY_TYPE,
  LEDGER_SOURCE_TYPE,
  CYCLE_TYPE,
} from '../enums/index.js';
import { today, dateOf, addDays } from '../helpers/date.helper.js';
import { resolveShift, isWeekOff } from './shift.service.js';
import { holidayMapFor } from './holiday.service.js';
import { requireCycleFor } from './leave-cycle.service.js';
import { loadEmployeeForLeave, resolveForEmployee } from './leave-policy.service.js';
import { writeLedger } from './leave.service.js';

const REQUEST_COLUMNS = CompOffRequest.select(COMP_OFF_REQUEST_PUBLIC_PROPS);
const OUTPUT_REQUEST = COMP_OFF_REQUEST_PUBLIC_PROPS.map(
  (p) => `inserted.${CompOffRequest.col(p)} AS ${p}`,
).join(', ');

const ID_PROPS = Object.freeze([
  'compOffRequestId',
  'compOffCreditId',
  'employeeDetailId',
  'attendanceDayId',
  'approvedBy',
  'creditedBy',
]);

function shape(row) {
  if (!row) return row;

  const copy = { ...row };
  for (const prop of ID_PROPS) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  for (const prop of ['days', 'remainingDays']) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  for (const prop of ['workedOnDate', 'expiresOn']) {
    if (copy[prop]) copy[prop] = dateOf(copy[prop]);
  }
  return copy;
}

const shapeAll = (rows) => rows.map(shape);

/**
 * The comp-off leave category this employee is mapped to.
 *
 * Found through the mapping rather than by name, because "Comp Off- IN" and
 * "CompOff - US" are two rows in tblLeaveType and matching on a string
 * would quietly credit the wrong one - or nothing at all - for half the
 * company.
 */
async function compOffTypeFor(employeeDetailId) {
  const resolved = await resolveForEmployee(employeeDetailId);

  // A comp-off category is one whose policy grants no accrual and keeps a
  // balance: days arrive only by credit. That is what distinguishes it from
  // CL/SL without depending on what somebody named the row.
  const candidate = resolved.find(
    (entry) =>
      entry.policy &&
      entry.policy.tracksBalance &&
      entry.policy.accrualFrequency === 'NONE' &&
      /comp\s*-?\s*off/i.test(entry.leaveTypeName),
  );

  if (!candidate) {
    throw ApiError.badRequest(MESSAGES.LEAVE_POLICY_MISSING, {
      code: ERROR_CODE.LEAVE_POLICY_MISSING,
      hint: 'No compensatory-off leave type is mapped to this employee',
    });
  }
  return candidate;
}

/* -------------------------------------------------------------------------
   Raising a request
   ------------------------------------------------------------------------- */

/**
 * Claim a comp-off for a day that was worked.
 *
 * THE DAY MUST ACTUALLY HAVE BEEN A NON-WORKING DAY. Claiming a comp-off
 * for an ordinary Tuesday is refused: working a Tuesday is the job. The
 * check is against the employee's own shift pattern and their location's
 * holidays, so a Sunday-working shift behaves correctly rather than
 * granting somebody a comp-off every week.
 */
export async function createRequest(actorId, employeeDetailId, input) {
  const workedOnDate = input.workedOnDate;

  if (workedOnDate > today()) {
    throw ApiError.badRequest(MESSAGES.COMP_OFF_FUTURE_DATE, {
      code: ERROR_CODE.COMP_OFF_FUTURE_DATE,
    });
  }

  const employee = await loadEmployeeForLeave(employeeDetailId);

  const [shift, holidays] = await Promise.all([
    resolveShift(employeeDetailId, workedOnDate, { workLocationId: employee.workLocationId }),
    holidayMapFor(employee.workLocationId, workedOnDate, workedOnDate),
  ]);

  const wasNonWorking = isWeekOff(shift, workedOnDate) || holidays.has(workedOnDate);
  if (!wasNonWorking) {
    throw ApiError.badRequest(MESSAGES.COMP_OFF_WORKING_DAY, {
      code: ERROR_CODE.COMP_OFF_WORKING_DAY,
      workedOnDate,
    });
  }

  // The attendance row, when there is one. Not required: the US team and
  // anyone exempt from punching have none, and the HR document asks for the
  // manager's agreement rather than for a punch.
  const day = await queryOne(
    `SELECT AttendanceDayId AS attendanceDayId, WorkedMinutes AS workedMinutes
       FROM ${AttendanceDay.table}
      WHERE EmployeeDetailId = @employeeDetailId AND AttendanceDate = @attendanceDate
        AND DeletedAt IS NULL`,
    AttendanceDay.params({ employeeDetailId, attendanceDate: workedOnDate }),
  );

  try {
    const row = await queryOne(
      `INSERT INTO ${CompOffRequest.table}
              (EmployeeDetailId, WorkedOnDate, AttendanceDayId, WorkedMinutes, Reason,
               Status, CreatedBy, ModifiedBy)
       OUTPUT ${OUTPUT_REQUEST}
       VALUES (@employeeDetailId, @workedOnDate, @attendanceDayId, @workedMinutes, @reason,
               @status, @actorId, @actorId)`,
      {
        ...CompOffRequest.params({
          employeeDetailId,
          workedOnDate,
          attendanceDayId: day ? Number(day.attendanceDayId) : null,
          workedMinutes: day?.workedMinutes ?? null,
          reason: input.reason,
          status: COMP_OFF_REQUEST_STATUS.PENDING_MANAGER,
        }),
        actorId: CompOffRequest.param('createdBy', actorId),
      },
    );
    return shape(row);
  } catch (error) {
    if (error?.number === 2601 || error?.number === 2627) {
      throw ApiError.conflict(MESSAGES.COMP_OFF_ALREADY_REQUESTED, {
        code: ERROR_CODE.COMP_OFF_ALREADY_REQUESTED,
      });
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------
   Reading
   ------------------------------------------------------------------------- */

export async function listForEmployee(employeeDetailId, { status = null } = {}) {
  return shapeAll(
    await query(
      `SELECT ${REQUEST_COLUMNS} FROM ${CompOffRequest.table}
        WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL
          AND (@status IS NULL OR Status = @status)
        ORDER BY WorkedOnDate DESC`,
      CompOffRequest.params({ employeeDetailId, status }),
    ),
  );
}

export async function getRequest(compOffRequestId) {
  const row = shape(
    await queryOne(
      `SELECT ${REQUEST_COLUMNS} FROM ${CompOffRequest.table}
        WHERE CompOffRequestId = @compOffRequestId AND DeletedAt IS NULL`,
      CompOffRequest.params({ compOffRequestId }),
    ),
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.COMP_OFF_NOT_FOUND, { code: ERROR_CODE.COMP_OFF_NOT_FOUND });
  }
  return row;
}

/**
 * A queue, by status.
 *
 * Used for both the manager's list (PENDING_MANAGER, narrowed to their
 * reports) and HR's outstanding list (APPROVED_AWAITING_CREDIT, company
 * wide). One function because they are the same query with different
 * arguments, and HR's queue is the one that would otherwise be invisible.
 */
export async function listByStatus(status, { managerId = null } = {}) {
  return shapeAll(
    await query(
      `SELECT ${COMP_OFF_REQUEST_PUBLIC_PROPS.map((p) => `r.${CompOffRequest.col(p)} AS ${p}`).join(', ')},
              e.FirstName    AS firstName,
              e.LastName     AS lastName,
              e.EmployeeCode AS employeeCode
         FROM ${CompOffRequest.table}  AS r
         JOIN ${EmployeeDetails.table} AS e ON e.EmployeeDetailId = r.EmployeeDetailId
        WHERE r.Status = @status AND r.DeletedAt IS NULL AND e.DeletedAt IS NULL
          AND (@managerId IS NULL OR e.ManagerId = @managerId)
        ORDER BY r.CreatedAt`,
      {
        ...CompOffRequest.params({ status }),
        managerId: EmployeeDetails.param('managerId', managerId),
      },
    ),
  );
}

export async function listCredits({ employeeDetailId = null, status = null } = {}) {
  return shapeAll(
    await query(
      `SELECT ${CompOffCredit.select(COMP_OFF_CREDIT_PUBLIC_PROPS)} FROM ${CompOffCredit.table}
        WHERE DeletedAt IS NULL
          AND (@employeeDetailId IS NULL OR EmployeeDetailId = @employeeDetailId)
          AND (@status IS NULL OR Status = @status)
        ORDER BY CreditedAt DESC`,
      CompOffCredit.params({ employeeDetailId, status }),
    ),
  );
}

/* -------------------------------------------------------------------------
   Deciding
   ------------------------------------------------------------------------- */

/**
 * The manager agrees the work happened.
 *
 * WRITES NO LEDGER ENTRY. This is the whole point - see the file header.
 * The request moves to APPROVED_AWAITING_CREDIT, which puts it on HR's
 * queue, and the employee's balance does not move until HR acts.
 */
export async function approve(actorId, compOffRequestId, { remarks = null } = {}) {
  const request = await getRequest(compOffRequestId);

  if (request.status !== COMP_OFF_REQUEST_STATUS.PENDING_MANAGER) {
    throw ApiError.conflict(MESSAGES.COMP_OFF_NOT_PENDING, {
      code: ERROR_CODE.COMP_OFF_NOT_PENDING,
      status: request.status,
    });
  }
  if (Number(request.employeeDetailId) === Number(actorId)) {
    throw ApiError.forbidden(MESSAGES.LEAVE_SELF_APPROVAL, {
      code: ERROR_CODE.LEAVE_SELF_APPROVAL,
    });
  }

  const row = await queryOne(
    `UPDATE ${CompOffRequest.table}
        SET Status          = @status,
            ApprovedBy      = @actorId,
            ApprovedAt      = SYSUTCDATETIME(),
            ApproverRemarks = @remarks,
            ModifiedBy      = @actorId,
            ModifiedAt      = SYSUTCDATETIME()
      OUTPUT ${OUTPUT_REQUEST}
      WHERE CompOffRequestId = @compOffRequestId AND Status = @pending`,
    {
      ...CompOffRequest.params({
        compOffRequestId,
        status: COMP_OFF_REQUEST_STATUS.APPROVED_AWAITING_CREDIT,
        approverRemarks: remarks,
      }),
      pending: CompOffRequest.param('status', COMP_OFF_REQUEST_STATUS.PENDING_MANAGER),
      remarks: CompOffRequest.param('approverRemarks', remarks),
      actorId: CompOffRequest.param('approvedBy', actorId),
    },
  );
  return shape(row);
}

export async function reject(actorId, compOffRequestId, { remarks = null } = {}) {
  const request = await getRequest(compOffRequestId);

  if (request.status !== COMP_OFF_REQUEST_STATUS.PENDING_MANAGER) {
    throw ApiError.conflict(MESSAGES.COMP_OFF_NOT_PENDING, {
      code: ERROR_CODE.COMP_OFF_NOT_PENDING,
      status: request.status,
    });
  }

  const row = await queryOne(
    `UPDATE ${CompOffRequest.table}
        SET Status = @status, ApprovedBy = @actorId, ApprovedAt = SYSUTCDATETIME(),
            ApproverRemarks = @remarks, ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
      OUTPUT ${OUTPUT_REQUEST}
      WHERE CompOffRequestId = @compOffRequestId AND Status = @pending`,
    {
      ...CompOffRequest.params({
        compOffRequestId,
        status: COMP_OFF_REQUEST_STATUS.REJECTED,
        approverRemarks: remarks,
      }),
      pending: CompOffRequest.param('status', COMP_OFF_REQUEST_STATUS.PENDING_MANAGER),
      remarks: CompOffRequest.param('approverRemarks', remarks),
      actorId: CompOffRequest.param('approvedBy', actorId),
    },
  );
  return shape(row);
}

export async function cancel(actorId, employeeDetailId, compOffRequestId) {
  const row = await queryOne(
    `UPDATE ${CompOffRequest.table}
        SET Status = @cancelled, ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
      OUTPUT ${OUTPUT_REQUEST}
      WHERE CompOffRequestId = @compOffRequestId
        AND EmployeeDetailId = @employeeDetailId
        AND Status = @pending AND DeletedAt IS NULL`,
    {
      ...CompOffRequest.params({
        compOffRequestId,
        employeeDetailId,
        status: COMP_OFF_REQUEST_STATUS.CANCELLED,
      }),
      cancelled: CompOffRequest.param('status', COMP_OFF_REQUEST_STATUS.CANCELLED),
      pending: CompOffRequest.param('status', COMP_OFF_REQUEST_STATUS.PENDING_MANAGER),
      actorId: CompOffRequest.param('modifiedBy', actorId),
    },
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.COMP_OFF_NOT_FOUND, { code: ERROR_CODE.COMP_OFF_NOT_FOUND });
  }
  return shape(row);
}

/* -------------------------------------------------------------------------
   The credit - HR's act, and the only one that moves a balance
   ------------------------------------------------------------------------- */

/**
 * HR grants the day.
 *
 * ONLY FROM APPROVED_AWAITING_CREDIT. Crediting a request the manager has
 * not approved would make the manager's approval decorative, which is
 * exactly the shortcut the HR document rules out.
 *
 * ONE TRANSACTION: the credit row, the ledger entry, and the request's move
 * to CREDITED. UQ_tblCompOffCredit_Request makes a double-credit fail at
 * the database rather than depending on the status check above winning a
 * race between two HR users.
 *
 * ExpiresOn comes from the policy's ValidityDays, which is NULL until HR
 * confirms a validity period - one of the open questions in section 28. A
 * NULL expiry means the credit does not lapse, which is the safe reading of
 * silence: the opposite default would quietly destroy days nobody agreed to
 * destroy.
 */
export async function credit(actorId, compOffRequestId, { days = null, remarks = null } = {}) {
  const request = await getRequest(compOffRequestId);

  if (request.status === COMP_OFF_REQUEST_STATUS.CREDITED) {
    throw ApiError.conflict(MESSAGES.COMP_OFF_ALREADY_CREDITED, {
      code: ERROR_CODE.COMP_OFF_ALREADY_CREDITED,
    });
  }
  if (request.status !== COMP_OFF_REQUEST_STATUS.APPROVED_AWAITING_CREDIT) {
    throw ApiError.conflict(MESSAGES.COMP_OFF_NOT_APPROVED, {
      code: ERROR_CODE.COMP_OFF_NOT_APPROVED,
      status: request.status,
    });
  }

  const entry = await compOffTypeFor(request.employeeDetailId);
  const cycle = await requireCycleFor(CYCLE_TYPE.FINANCIAL, request.workedOnDate);

  const creditDays = Number(days ?? COMP_OFF_DAYS_PER_REQUEST);
  const validityDays = entry.policy.validityDays ?? null;
  const expiresOn = validityDays ? addDays(today(), validityDays) : null;

  try {
    return await withTransaction(async (run) => {
      const [credited] = await run(
        `INSERT INTO ${CompOffCredit.table}
                (CompOffRequestId, EmployeeDetailId, Days, CreditedBy, ExpiresOn,
                 RemainingDays, Status, Remarks, CreatedBy, ModifiedBy)
         OUTPUT ${COMP_OFF_CREDIT_PUBLIC_PROPS.map((p) => `inserted.${CompOffCredit.col(p)} AS ${p}`).join(', ')}
         VALUES (@compOffRequestId, @employeeDetailId, @days, @actorId, @expiresOn,
                 @remainingDays, @status, @remarks, @actorId, @actorId)`,
        {
          ...CompOffCredit.params({
            compOffRequestId,
            employeeDetailId: request.employeeDetailId,
            days: creditDays,
            expiresOn,
            remainingDays: creditDays,
            status: COMP_OFF_CREDIT_STATUS.AVAILABLE,
            remarks,
          }),
          actorId: CompOffCredit.param('creditedBy', actorId),
        },
      );

      await writeLedger(run, {
        employeeDetailId: request.employeeDetailId,
        leaveTypeId: entry.leaveTypeId,
        leaveCycleId: cycle.leaveCycleId,
        entryType: LEDGER_ENTRY_TYPE.COMP_OFF_CREDIT,
        days: creditDays,
        sourceType: LEDGER_SOURCE_TYPE.COMP_OFF,
        sourceId: Number(credited.compOffCreditId),
        effectiveDate: today(),
        remarks: `Comp-off for ${request.workedOnDate}`,
        createdBy: actorId,
      });

      await run(
        `UPDATE ${CompOffRequest.table}
            SET Status = @status, ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
          WHERE CompOffRequestId = @compOffRequestId`,
        {
          ...CompOffRequest.params({
            compOffRequestId,
            status: COMP_OFF_REQUEST_STATUS.CREDITED,
          }),
          actorId: CompOffRequest.param('modifiedBy', actorId),
        },
      );

      return shape(credited);
    });
  } catch (error) {
    if (error?.number === 2601 || error?.number === 2627) {
      throw ApiError.conflict(MESSAGES.COMP_OFF_ALREADY_CREDITED, {
        code: ERROR_CODE.COMP_OFF_ALREADY_CREDITED,
      });
    }
    throw error;
  }
}

/**
 * Lapse credits whose expiry has passed. Run from the nightly job.
 *
 * Writes a LAPSE ledger entry for the REMAINING days, not the full credit -
 * a comp-off half spent should only lose the half that is left. Does
 * nothing at all while ValidityDays is NULL, because no credit then has an
 * expiry date to be past.
 */
export async function lapseExpiredCredits(actorId = null) {
  const expired = shapeAll(
    await query(
      `SELECT ${CompOffCredit.select(COMP_OFF_CREDIT_PUBLIC_PROPS)} FROM ${CompOffCredit.table}
        WHERE DeletedAt IS NULL AND Status = @available
          AND ExpiresOn IS NOT NULL AND ExpiresOn < @today`,
      {
        available: CompOffCredit.param('status', COMP_OFF_CREDIT_STATUS.AVAILABLE),
        today: CompOffCredit.param('expiresOn', today()),
      },
    ),
  );

  let lapsed = 0;

  for (const creditRow of expired) {
    if (creditRow.remainingDays <= 0) continue;

    const entry = await compOffTypeFor(creditRow.employeeDetailId).catch(() => null);
    if (!entry) continue;

    const cycle = await requireCycleFor(CYCLE_TYPE.FINANCIAL, today(), { allowClosed: true })
      .catch(() => null);
    if (!cycle) continue;

    await withTransaction(async (run) => {
      await writeLedger(run, {
        employeeDetailId: creditRow.employeeDetailId,
        leaveTypeId: entry.leaveTypeId,
        leaveCycleId: cycle.leaveCycleId,
        entryType: LEDGER_ENTRY_TYPE.LAPSE,
        days: -creditRow.remainingDays,
        sourceType: LEDGER_SOURCE_TYPE.COMP_OFF,
        sourceId: creditRow.compOffCreditId,
        effectiveDate: today(),
        remarks: `Comp-off expired on ${creditRow.expiresOn}`,
        createdBy: actorId,
      });

      await run(
        `UPDATE ${CompOffCredit.table}
            SET Status = @lapsed, RemainingDays = 0, ModifiedAt = SYSUTCDATETIME()
          WHERE CompOffCreditId = @compOffCreditId`,
        CompOffCredit.params({
          compOffCreditId: creditRow.compOffCreditId,
          status: COMP_OFF_CREDIT_STATUS.LAPSED,
        }),
      );
    });

    lapsed += 1;
  }

  return lapsed;
}

export { LeaveType };

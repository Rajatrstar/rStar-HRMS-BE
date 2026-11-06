/**
 * Leave cycles: the years a balance belongs to.
 *
 * Small, and depended on by everything else in the leave module, which is
 * why it is its own file rather than a corner of leave-policy.service.js.
 *
 * TWO CYCLES RUN AT ONCE and that is the whole reason this table exists -
 * CL/SL and EL on the financial year, the floating holiday on the calendar
 * year. Resolving "which cycle" therefore needs TWO facts, a date and a
 * cycle type, and every caller supplies both. A function that took only a
 * date would have to guess, and would guess wrong for exactly the category
 * the HR document singles out.
 *
 * CYCLES ARE RESOLVED FROM THE TABLE, never computed. financialYearBounds()
 * in the date helper generates a cycle's dates when one is being created;
 * it is not used to answer "which cycle is this date in". The ledger points
 * at a row, so the row is the authority - and a cycle whose dates HR
 * adjusted by hand must keep working.
 */
import { query, queryOne } from '../helpers/query.helper.js';
import { LeaveCycle, LEAVE_CYCLE_PUBLIC_PROPS } from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { MESSAGES, ERROR_CODE, CYCLE_TYPE } from '../enums/index.js';
import { financialYearBounds, calendarYearBounds, dateOf, today } from '../helpers/date.helper.js';

const CYCLE_COLUMNS = LeaveCycle.select(LEAVE_CYCLE_PUBLIC_PROPS);

/**
 * BIGINT arrives from the driver as a STRING - see the note in
 * organization.service.js. Ids go out as JSON numbers so that
 * `data.leaveCycleId === 1` is not silently false.
 */
function withNumericIds(row) {
  if (!row) return row;

  const copy = { ...row };
  if (copy.leaveCycleId !== undefined && copy.leaveCycleId !== null) {
    copy.leaveCycleId = Number(copy.leaveCycleId);
  }

  /*
    A cycle boundary is a calendar date, not an instant. The driver returns
    a DATE as a Date, which JSON.stringify writes as
    "2026-04-01T00:00:00.000Z" - and a browser west of UTC renders that as
    31 March, showing the financial year starting in the wrong month.

    Every other service in this module normalises its dates for the same
    reason; this one serves the dashboard's cycle labels, so it matters
    more than most.
  */
  for (const prop of ['startDate', 'endDate']) {
    if (copy[prop]) copy[prop] = dateOf(copy[prop]);
  }

  return copy;
}

/** Every cycle, newest first. The dropdown on every leave admin screen. */
export async function listCycles({ cycleType } = {}) {
  const rows = await query(
    `SELECT ${CYCLE_COLUMNS}
       FROM ${LeaveCycle.table}
      WHERE DeletedAt IS NULL
        AND (@cycleType IS NULL OR CycleType = @cycleType)
      ORDER BY StartDate DESC, CycleType`,
    LeaveCycle.params({ cycleType: cycleType ?? null }),
  );
  return rows.map(withNumericIds);
}

/** One cycle, or a 404. */
export async function getCycle(leaveCycleId) {
  const row = await queryOne(
    `SELECT ${CYCLE_COLUMNS}
       FROM ${LeaveCycle.table}
      WHERE LeaveCycleId = @leaveCycleId AND DeletedAt IS NULL`,
    LeaveCycle.params({ leaveCycleId }),
  );

  if (!row) {
    throw ApiError.notFound(MESSAGES.LEAVE_CYCLE_NOT_FOUND, {
      code: ERROR_CODE.LEAVE_CYCLE_NOT_FOUND,
    });
  }
  return withNumericIds(row);
}

/**
 * The cycle of a given type that contains a date.
 *
 * THE MOST FREQUENT QUERY IN THE LEAVE MODULE - every apply, every accrual
 * and every balance read starts here.
 *
 * Returns null rather than throwing, because two callers want different
 * things from a miss: the apply path wants a 400 telling the employee to
 * ask HR to open the year, and the accrual job wants to skip the employee
 * and carry on rather than die half way through a nightly run.
 */
export async function findCycleFor(cycleType, date) {
  const row = await queryOne(
    `SELECT ${CYCLE_COLUMNS}
       FROM ${LeaveCycle.table}
      WHERE CycleType = @cycleType
        AND @date BETWEEN StartDate AND EndDate
        AND DeletedAt IS NULL`,
    {
      ...LeaveCycle.params({ cycleType }),
      date: LeaveCycle.param('startDate', date),
    },
  );
  return withNumericIds(row);
}

/**
 * The same, but insisting.
 *
 * `allowClosed` exists for the read paths: a settled year's balances are
 * still viewable, it is only writing into one that is refused.
 */
export async function requireCycleFor(cycleType, date, { allowClosed = false } = {}) {
  const cycle = await findCycleFor(cycleType, date);

  if (!cycle) {
    throw ApiError.badRequest(MESSAGES.LEAVE_CYCLE_MISSING, {
      code: ERROR_CODE.LEAVE_CYCLE_MISSING,
      cycleType,
      date,
    });
  }
  if (cycle.isClosed && !allowClosed) {
    throw ApiError.conflict(MESSAGES.LEAVE_CYCLE_IS_CLOSED, {
      code: ERROR_CODE.LEAVE_CYCLE_IS_CLOSED,
      cycleLabel: cycle.cycleLabel,
    });
  }
  return cycle;
}

/** The current cycle of each type. What the dashboard tiles are grouped by. */
export async function currentCycles(onDate = today()) {
  const [financial, calendar] = await Promise.all([
    findCycleFor(CYCLE_TYPE.FINANCIAL, onDate),
    findCycleFor(CYCLE_TYPE.CALENDAR, onDate),
  ]);
  return { financial, calendar };
}

/**
 * Suggested dates for a new cycle, so the create form arrives filled in.
 *
 * Served rather than computed in the client: the financial year's start
 * month is a backend decision, and a client that hard-coded April would
 * silently disagree the day a different entity is onboarded.
 */
export function suggestCycle(cycleType, forDate = today()) {
  return cycleType === CYCLE_TYPE.CALENDAR
    ? calendarYearBounds(forDate)
    : financialYearBounds(forDate);
}

/** SQL Server's two unique-index violations. */
const uniqueViolation = (error) => error?.number === 2601 || error?.number === 2627;

/** @param {number} actorId  EmployeeDetailId of the caller */
export async function createCycle(actorId, input) {
  try {
    const row = await queryOne(
      `INSERT INTO ${LeaveCycle.table}
              (CycleType, CycleLabel, StartDate, EndDate, CreatedBy, ModifiedBy)
       OUTPUT ${LEAVE_CYCLE_PUBLIC_PROPS.map((p) => `inserted.${LeaveCycle.col(p)} AS ${p}`).join(', ')}
       VALUES (@cycleType, @cycleLabel, @startDate, @endDate, @actorId, @actorId)`,
      {
        ...LeaveCycle.params({
          cycleType: input.cycleType,
          cycleLabel: input.cycleLabel,
          startDate: input.startDate,
          endDate: input.endDate,
        }),
        actorId: LeaveCycle.param('createdBy', actorId),
      },
    );
    return withNumericIds(row);
  } catch (error) {
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.LEAVE_CYCLE_EXISTS, {
        code: ERROR_CODE.LEAVE_CYCLE_EXISTS,
      });
    }
    throw error;
  }
}

/**
 * Rename a cycle or move its boundaries.
 *
 * A CLOSED CYCLE IS NOT EDITABLE. Closing is the act that says payroll has
 * settled the year; moving its dates afterwards would silently change which
 * cycle historic ledger rows belong to.
 */
export async function updateCycle(actorId, leaveCycleId, input) {
  const existing = await getCycle(leaveCycleId);

  if (existing.isClosed) {
    throw ApiError.conflict(MESSAGES.LEAVE_CYCLE_IS_CLOSED, {
      code: ERROR_CODE.LEAVE_CYCLE_IS_CLOSED,
    });
  }

  try {
    const row = await queryOne(
      `UPDATE ${LeaveCycle.table}
          SET CycleLabel = @cycleLabel,
              StartDate  = @startDate,
              EndDate    = @endDate,
              ModifiedBy = @actorId,
              ModifiedAt = SYSUTCDATETIME()
        OUTPUT ${LEAVE_CYCLE_PUBLIC_PROPS.map((p) => `inserted.${LeaveCycle.col(p)} AS ${p}`).join(', ')}
        WHERE LeaveCycleId = @leaveCycleId AND DeletedAt IS NULL`,
      {
        ...LeaveCycle.params({
          leaveCycleId,
          cycleLabel: input.cycleLabel ?? existing.cycleLabel,
          startDate: input.startDate ?? existing.startDate,
          endDate: input.endDate ?? existing.endDate,
        }),
        actorId: LeaveCycle.param('modifiedBy', actorId),
      },
    );
    return withNumericIds(row);
  } catch (error) {
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.LEAVE_CYCLE_EXISTS, {
        code: ERROR_CODE.LEAVE_CYCLE_EXISTS,
      });
    }
    throw error;
  }
}

/**
 * Close a cycle.
 *
 * ONE-WAY, and deliberately so: after this, a backdated application cannot
 * land in a year payroll has paid out. A correction then goes through an
 * ADJUSTMENT entry in the CURRENT cycle, which is visible on the ledger,
 * rather than by quietly moving a day into a settled one.
 *
 * It does NOT lapse unused balance. Carry-forward is a policy question -
 * MaxCarryForward - and belongs to the cycle-rollover job, which can be run
 * and re-run; folding it into an irreversible close would make a mistake in
 * the carry-forward rules unrecoverable.
 */
export async function closeCycle(actorId, leaveCycleId) {
  const existing = await getCycle(leaveCycleId);
  if (existing.isClosed) return existing;

  const row = await queryOne(
    `UPDATE ${LeaveCycle.table}
        SET IsClosed   = 1,
            ClosedBy   = @actorId,
            ClosedAt   = SYSUTCDATETIME(),
            ModifiedBy = @actorId,
            ModifiedAt = SYSUTCDATETIME()
      OUTPUT ${LEAVE_CYCLE_PUBLIC_PROPS.map((p) => `inserted.${LeaveCycle.col(p)} AS ${p}`).join(', ')}
      WHERE LeaveCycleId = @leaveCycleId AND DeletedAt IS NULL`,
    {
      ...LeaveCycle.params({ leaveCycleId }),
      actorId: LeaveCycle.param('closedBy', actorId),
    },
  );
  return withNumericIds(row);
}

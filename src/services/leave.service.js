/**
 * Applying for leave, approving it, and the ledger behind every balance.
 *
 * THE BALANCE IS THE LEDGER. There is no stored number anywhere; every
 * figure comes from dbo.vwLeaveBalance, which sums dbo.tblLeaveLedger. See
 * the header of db/migrations/019_leave_request.sql for why.
 *
 * THE LIFECYCLE, and the ledger row each step writes:
 *
 *   apply      HOLD      +n, IsHold = 1   reserved, not yet spent
 *   approve    REVERSAL  -n (clears hold) and DEBIT -n, LWP_DEBIT -m
 *   reject     REVERSAL  -n (clears hold) and nothing else
 *   cancel     REVERSAL  -n (clears hold) and nothing else
 *   withdraw   REVERSAL  +n (gives the debit back)
 *
 * A hold is a FLAG rather than a sign, so the sum of Days is the real
 * balance and "available" is that minus the holds. A negative held number
 * would be subtracted twice the first time somebody summed the column
 * without reading the comment.
 *
 * EVERY WRITE PATH IS ONE TRANSACTION. A request without its hold is a day
 * somebody can spend twice; a debit without its reversal is a day charged
 * twice. Neither half is meaningful alone, so neither is committed alone.
 */
import { query, queryOne, withTransaction } from '../helpers/query.helper.js';
import {
  LeaveRequest,
  LeaveRequestDay,
  LeaveApproval,
  LeaveLedger,
  LeaveBalance,
  LeaveType,
  LeaveCycle,
  EmployeeDetails,
  LEAVE_REQUEST_PUBLIC_PROPS,
  LEAVE_REQUEST_DAY_PUBLIC_PROPS,
  LEAVE_APPROVAL_PUBLIC_PROPS,
  LEAVE_LEDGER_PUBLIC_PROPS,
  LEAVE_BALANCE_PUBLIC_PROPS,
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import {
  MESSAGES,
  ERROR_CODE,
  LEAVE_REQUEST_STATUS,
  LEAVE_PENDING_STATUSES,
  LEAVE_DAY_TYPE,
  DAY_PART,
  DAY_PART_CHARGE,
  LEDGER_ENTRY_TYPE,
  LEDGER_SOURCE_TYPE,
  APPROVAL_ACTION,
  APPROVAL_LEVEL,
  APPROVER_ROLE,
  SANDWICH_MODE,
  CYCLE_TYPE,
  POLICY_CYCLE_TYPE,
} from '../enums/index.js';
import { today, eachDate, dateOf, daysBetween } from '../helpers/date.helper.js';
import { resolveShift, isWeekOff } from './shift.service.js';
import { holidayMapFor } from './holiday.service.js';
import { requireCycleFor, findCycleFor } from './leave-cycle.service.js';
import {
  loadEmployeeForLeave,
  resolveForEmployee,
  requirePolicyFor,
  sandwichRuleFor,
} from './leave-policy.service.js';
import { markLeaveDays, unmarkLeaveDays } from './attendance.service.js';

const REQUEST_COLUMNS = LeaveRequest.select(LEAVE_REQUEST_PUBLIC_PROPS);
const OUTPUT_REQUEST = LEAVE_REQUEST_PUBLIC_PROPS.map(
  (p) => `inserted.${LeaveRequest.col(p)} AS ${p}`,
).join(', ');

const ID_PROPS = Object.freeze([
  'leaveRequestId',
  'employeeDetailId',
  'leaveTypeId',
  'leaveCycleId',
  'currentApproverId',
  'leaveRequestDayId',
  'leaveApprovalId',
  'approverId',
  'leaveLedgerId',
  'sourceId',
]);

const DECIMAL_PROPS = Object.freeze([
  'totalDays',
  'sandwichDays',
  'paidDays',
  'lwpDays',
  'chargedDays',
  'days',
  'accruedDays',
  'consumedDays',
  'lwpDaysConsumed',
  'heldDays',
  'balanceDays',
  'availableDays',
]);

const DATE_PROPS = Object.freeze(['fromDate', 'toDate', 'leaveDate', 'effectiveDate']);

function shape(row) {
  if (!row) return row;

  const copy = { ...row };
  for (const prop of ID_PROPS) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  // DECIMAL can arrive as a string. "1" + 0.5 is "10.5", and that would be
  // a balance bug nobody would ever guess at from the symptom.
  for (const prop of DECIMAL_PROPS) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  for (const prop of DATE_PROPS) {
    if (copy[prop]) copy[prop] = dateOf(copy[prop]);
  }
  return copy;
}

const shapeAll = (rows) => rows.map(shape);

/** Days are stored to two places; floating-point sums drift without this. */
const round2 = (value) => Math.round(value * 100) / 100;

/* -------------------------------------------------------------------------
   The charge calculation
   ------------------------------------------------------------------------- */

/**
 * Which dates a request actually charges, and why.
 *
 * THE SANDWICH RULE LIVES HERE, and all three modes from section 12 are
 * implemented because all three were specified:
 *
 *   IGNORE_WEEKOFF          only working days are charged. Friday and
 *                           Monday off is 2 days.
 *   COUNT_WHEN_BOTH_FLANKS  a non-working day is charged when the employee
 *                           is also absent on a working day BEFORE it and
 *                           AFTER it, within this request. Friday and
 *                           Monday is 4; Friday alone is still 1.
 *   COUNT_ALWAYS            every day in the range is charged.
 *
 * The flanking test is the one with real content. It looks for a charged
 * working day on each side of the gap WITHIN THE REQUESTED RANGE - not in
 * the calendar at large - because the rule is about a continuous absence
 * the employee asked for, not about two unrelated applications that happen
 * to sit either side of a weekend.
 *
 * Returns the day list, never writes anything. The preview endpoint and the
 * apply endpoint both call it, so what the employee was shown is what they
 * are charged.
 */
export async function computeCharge({
  employee,
  policy,
  fromDate,
  toDate,
  dayPart = DAY_PART.FULL,
}) {
  const [shift, holidays, sandwichRule] = await Promise.all([
    resolveShift(employee.employeeDetailId, fromDate, {
      workLocationId: employee.workLocationId,
    }),
    holidayMapFor(employee.workLocationId, fromDate, toDate),
    sandwichRuleFor(policy),
  ]);

  const mode = sandwichRule?.mode ?? SANDWICH_MODE.IGNORE_WEEKOFF;
  const includeHolidays = Boolean(sandwichRule?.includeHolidays);

  // Pass one: classify every date in the range.
  const dates = eachDate(fromDate, toDate).map((date) => {
    const holiday = holidays.get(date) ?? null;
    const weekOff = isWeekOff(shift, date);

    return {
      date,
      isWeekOff: weekOff,
      isHoliday: holiday !== null,
      holidayName: holiday?.holidayName ?? null,
      isWorkingDay: !weekOff && holiday === null,
    };
  });

  // Pass two: decide which non-working days the sandwich rule charges.
  const chargedFlags = dates.map((day) => {
    if (day.isWorkingDay) return true;
    if (mode === SANDWICH_MODE.COUNT_ALWAYS) {
      // A holiday is only swept up when the rule says so - a declared
      // holiday inside a long leave is not automatically the employee's
      // problem.
      return day.isHoliday ? includeHolidays : true;
    }
    if (mode !== SANDWICH_MODE.COUNT_WHEN_BOTH_FLANKS) return false;
    if (day.isHoliday && !includeHolidays) return false;
    return false; // decided in pass three, which needs the whole array
  });

  if (mode === SANDWICH_MODE.COUNT_WHEN_BOTH_FLANKS) {
    for (let index = 0; index < dates.length; index += 1) {
      if (dates[index].isWorkingDay) continue;
      if (dates[index].isHoliday && !includeHolidays) continue;

      // A working day somewhere before, and a working day somewhere after,
      // both inside this request.
      const before = dates.slice(0, index).some((day) => day.isWorkingDay);
      const after = dates.slice(index + 1).some((day) => day.isWorkingDay);
      chargedFlags[index] = before && after;
    }
  }

  const charge = DAY_PART_CHARGE[dayPart] ?? 1;

  const days = dates
    .map((day, index) => ({
      ...day,
      charged: chargedFlags[index],
      dayType: day.isWorkingDay ? LEAVE_DAY_TYPE.WORKING : LEAVE_DAY_TYPE.SANDWICH,
      // A half day only ever applies to a single-date request, which
      // CK_tblLeaveRequest_HalfDayIsOneDay enforces - so applying the
      // fraction to every charged day here cannot over-apply it.
      chargedDays: chargedFlags[index] ? charge : 0,
    }))
    .filter((day) => day.charged);

  const totalDays = round2(days.reduce((sum, day) => sum + day.chargedDays, 0));
  const sandwichDays = round2(
    days
      .filter((day) => day.dayType === LEAVE_DAY_TYPE.SANDWICH)
      .reduce((sum, day) => sum + day.chargedDays, 0),
  );

  return {
    days,
    totalDays,
    sandwichDays,
    workingDays: round2(totalDays - sandwichDays),
    sandwichMode: mode,
    sandwichRuleName: sandwichRule?.ruleName ?? null,
    calendarDays: dates,
  };
}

/* -------------------------------------------------------------------------
   Balances
   ------------------------------------------------------------------------- */

/** One employee's balance for one category in one cycle. Zeroes, not null. */
export async function balanceFor(employeeDetailId, leaveTypeId, leaveCycleId) {
  const row = shape(
    await queryOne(
      `SELECT ${LeaveBalance.select(LEAVE_BALANCE_PUBLIC_PROPS)} FROM ${LeaveBalance.table}
        WHERE EmployeeDetailId = @employeeDetailId
          AND LeaveTypeId = @leaveTypeId
          AND LeaveCycleId = @leaveCycleId`,
      LeaveBalance.params({ employeeDetailId, leaveTypeId, leaveCycleId }),
    ),
  );

  // A category nobody has accrued into yet has no ledger rows and so no
  // view row. Zeroes rather than null, so every caller can do arithmetic
  // without a guard and a brand-new employee's dashboard renders.
  return (
    row ?? {
      employeeDetailId: Number(employeeDetailId),
      leaveTypeId: Number(leaveTypeId),
      leaveCycleId: Number(leaveCycleId),
      accruedDays: 0,
      consumedDays: 0,
      lwpDaysConsumed: 0,
      heldDays: 0,
      balanceDays: 0,
      availableDays: 0,
    }
  );
}

/**
 * THE DASHBOARD of section 10: one tile per category, for the cycles in
 * force today.
 *
 * Built from resolveForEmployee() so the tiles and the apply screen cannot
 * disagree about what somebody is entitled to. A category that is visible
 * but not available - EL during probation - comes back with a zero balance
 * and a reason, which is what the HR document's probation dashboard shows.
 */
export async function dashboardFor(employeeDetailId, { onDate = today() } = {}) {
  const employee = await loadEmployeeForLeave(employeeDetailId);
  const resolved = await resolveForEmployee(employeeDetailId, { onDate, employee });

  const [financial, calendar] = await Promise.all([
    findCycleFor(CYCLE_TYPE.FINANCIAL, onDate),
    findCycleFor(CYCLE_TYPE.CALENDAR, onDate),
  ]);

  const tiles = [];

  for (const entry of resolved) {
    if (!entry.isVisible) continue;

    // The policy's cycle type decides which of the two years this category
    // is measured in. NONE - LWP, comp-off - belongs to neither.
    const cycle =
      entry.policy?.cycleType === POLICY_CYCLE_TYPE.CALENDAR
        ? calendar
        : entry.policy?.cycleType === POLICY_CYCLE_TYPE.FINANCIAL
          ? financial
          : null;

    const balance = cycle
      ? await balanceFor(employeeDetailId, entry.leaveTypeId, cycle.leaveCycleId)
      : null;

    tiles.push({
      leaveTypeId: entry.leaveTypeId,
      leaveTypeName: entry.leaveTypeName,
      cycle,
      cycleType: entry.policy?.cycleType ?? POLICY_CYCLE_TYPE.NONE,
      isAvailable: entry.isAvailable,
      unavailableReason: entry.unavailableReason,
      // LWP has no balance to show - TracksBalance = 0 - and showing a zero
      // would read as "you have none left", which is the opposite of true.
      tracksBalance: entry.policy ? Boolean(entry.policy.tracksBalance) : false,
      isPaid: entry.policy ? Boolean(entry.policy.isPaid) : true,
      allowHalfDay: entry.policy ? Boolean(entry.policy.allowHalfDay) : false,
      annualQuota: entry.policy?.annualQuota ?? null,
      accrualDays: entry.policy?.accrualDays ?? 0,
      accrualFrequency: entry.policy?.accrualFrequency ?? null,
      balance,
    });
  }

  return {
    employeeDetailId: Number(employeeDetailId),
    asOf: onDate,
    confirmationStatus: employee.confirmationStatus,
    probationEndDate: employee.probationEndDate,
    cycles: { financial, calendar },
    tiles,
  };
}

/** The statement screen: one person's ledger entries, newest first. */
export async function ledgerFor(employeeDetailId, { leaveTypeId = null, leaveCycleId = null } = {}) {
  return shapeAll(
    await query(
      `SELECT ${LEAVE_LEDGER_PUBLIC_PROPS.map((p) => `l.${LeaveLedger.col(p)} AS ${p}`).join(', ')},
              lt.Name AS leaveTypeName
         FROM ${LeaveLedger.table} AS l
         JOIN ${LeaveType.table}   AS lt ON lt.LeaveTypeId = l.LeaveTypeId
        WHERE l.EmployeeDetailId = @employeeDetailId
          AND (@leaveTypeId  IS NULL OR l.LeaveTypeId  = @leaveTypeId)
          AND (@leaveCycleId IS NULL OR l.LeaveCycleId = @leaveCycleId)
        ORDER BY l.EffectiveDate DESC, l.LeaveLedgerId DESC`,
      LeaveLedger.params({ employeeDetailId, leaveTypeId, leaveCycleId }),
    ),
  );
}

/**
 * The manage-balance grid: every employee, every category, one cycle.
 *
 * Driven from the ledger rather than from the employee list, because a
 * balance only exists where there are entries - and a grid of every
 * employee crossed with every category would be mostly empty rows.
 */
export async function balanceGrid({ leaveCycleId, leaveTypeId = null, employeeDetailId = null }) {
  return shapeAll(
    await query(
      `SELECT ${LEAVE_BALANCE_PUBLIC_PROPS.map((p) => `b.${LeaveBalance.col(p)} AS ${p}`).join(', ')},
              e.EmployeeCode AS employeeCode,
              e.FirstName    AS firstName,
              e.LastName     AS lastName,
              lt.Name        AS leaveTypeName
         FROM ${LeaveBalance.table}    AS b
         JOIN ${EmployeeDetails.table} AS e  ON e.EmployeeDetailId = b.EmployeeDetailId
         JOIN ${LeaveType.table}       AS lt ON lt.LeaveTypeId     = b.LeaveTypeId
        WHERE b.LeaveCycleId = @leaveCycleId
          AND e.DeletedAt IS NULL AND e.IsActive = 1
          AND (@leaveTypeId      IS NULL OR b.LeaveTypeId      = @leaveTypeId)
          AND (@employeeDetailId IS NULL OR b.EmployeeDetailId = @employeeDetailId)
        ORDER BY e.FirstName, e.LastName, lt.Name`,
      LeaveBalance.params({ leaveCycleId, leaveTypeId, employeeDetailId }),
    ),
  );
}

/**
 * Write one ledger row.
 *
 * `run` is the transaction's executor, because a ledger entry is never
 * meaningful on its own - it is always half of something, and committing it
 * alone is how a balance comes to disagree with the request that caused it.
 */
async function writeLedger(run, entry) {
  await run(
    `INSERT INTO ${LeaveLedger.table}
            (EmployeeDetailId, LeaveTypeId, LeaveCycleId, EntryType, Days, IsHold,
             SourceType, SourceId, EffectiveDate, Remarks, CreatedBy)
     VALUES (@employeeDetailId, @leaveTypeId, @leaveCycleId, @entryType, @days, @isHold,
             @sourceType, @sourceId, @effectiveDate, @remarks, @createdBy)`,
    LeaveLedger.params({
      employeeDetailId: entry.employeeDetailId,
      leaveTypeId: entry.leaveTypeId,
      leaveCycleId: entry.leaveCycleId,
      entryType: entry.entryType,
      days: entry.days,
      isHold: entry.isHold ?? false,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId ?? null,
      effectiveDate: entry.effectiveDate,
      remarks: entry.remarks ?? null,
      createdBy: entry.createdBy ?? null,
    }),
  );
}

/* -------------------------------------------------------------------------
   Applying
   ------------------------------------------------------------------------- */

/**
 * The preview the apply screen shows before anybody commits: how many days,
 * how many of them sandwich days, how many would fall through to LWP.
 *
 * Exactly the same calculation the apply path runs, so the number on the
 * confirmation dialog is the number that gets charged.
 */
export async function previewRequest(employeeDetailId, input) {
  const employee = await loadEmployeeForLeave(employeeDetailId);
  const entry = await requirePolicyFor(employeeDetailId, input.leaveTypeId, {
    onDate: input.fromDate,
    employee,
  });

  const charge = await computeCharge({
    employee,
    policy: entry.policy,
    fromDate: input.fromDate,
    toDate: input.toDate,
    dayPart: input.dayPart ?? DAY_PART.FULL,
  });

  const cycle = entry.policy.cycleType === POLICY_CYCLE_TYPE.NONE
    ? null
    : await findCycleFor(entry.policy.cycleType, input.fromDate);

  const balance = cycle
    ? await balanceFor(employeeDetailId, input.leaveTypeId, cycle.leaveCycleId)
    : null;

  const split = splitPaidAndLWP(charge, entry.policy, balance);

  return {
    leaveTypeId: Number(input.leaveTypeId),
    leaveTypeName: entry.leaveTypeName,
    cycle,
    ...charge,
    ...split,
    balanceBefore: balance,
  };
}

/**
 * How much of a request is paid, and how much falls through to LWP.
 *
 * SECTION 08, AND THE RULE THAT MAKES IT WORK: LWP is never deducted from a
 * paid balance. A category that tracks no balance is wholly LWP; a category
 * that does is paid up to whatever is available and unpaid beyond it.
 *
 * Which specific DATES fall through matters, not just how many - payroll
 * deducts for particular days - so the split is applied day by day in
 * order, earliest first. An employee with one day left who applies for
 * Monday to Wednesday is paid for Monday and unpaid for the other two,
 * which is both what they would expect and what the payslip has to say.
 */
function splitPaidAndLWP(charge, policy, balance) {
  if (!policy.tracksBalance) {
    // LWP itself, and anything else that keeps no balance.
    return {
      paidDays: 0,
      lwpDays: charge.totalDays,
      days: charge.days.map((day) => ({ ...day, isLWP: true })),
    };
  }

  let remaining = balance ? Number(balance.availableDays) : 0;
  let paidDays = 0;
  let lwpDays = 0;

  const days = charge.days.map((day) => {
    if (remaining >= day.chargedDays) {
      remaining = round2(remaining - day.chargedDays);
      paidDays = round2(paidDays + day.chargedDays);
      return { ...day, isLWP: false };
    }
    lwpDays = round2(lwpDays + day.chargedDays);
    return { ...day, isLWP: true };
  });

  return { paidDays, lwpDays, days };
}

/**
 * Submit an application.
 *
 * ONE TRANSACTION: the request, its day rows, the HOLD and the SUBMITTED
 * trail entry. A request without its hold is a day the employee can spend
 * twice, so neither is committed without the other.
 *
 * THE HOLD IS ONLY FOR THE PAID PORTION. LWP days have no balance to
 * reserve - reserving against a category that tracks none would make the
 * view's AvailableDays go negative for a category that never had a positive
 * one.
 */
export async function applyForLeave(actorId, employeeDetailId, input) {
  const employee = await loadEmployeeForLeave(employeeDetailId);
  const entry = await requirePolicyFor(employeeDetailId, input.leaveTypeId, {
    onDate: input.fromDate,
    employee,
  });
  const policy = entry.policy;

  const dayPart = input.dayPart ?? DAY_PART.FULL;

  if (dayPart !== DAY_PART.FULL && !policy.allowHalfDay) {
    throw ApiError.badRequest(MESSAGES.LEAVE_HALF_DAY_NOT_ALLOWED, {
      code: ERROR_CODE.LEAVE_HALF_DAY_NOT_ALLOWED,
    });
  }
  if (!policy.allowBackdated && input.fromDate < today()) {
    throw ApiError.badRequest(MESSAGES.LEAVE_BACKDATED_NOT_ALLOWED, {
      code: ERROR_CODE.LEAVE_BACKDATED_NOT_ALLOWED,
    });
  }
  if (policy.minNoticeDays > 0 && daysBetween(today(), input.fromDate) < policy.minNoticeDays) {
    throw ApiError.badRequest(MESSAGES.LEAVE_NOTICE_REQUIRED, {
      code: ERROR_CODE.LEAVE_NOTICE_REQUIRED,
      minNoticeDays: policy.minNoticeDays,
    });
  }

  await assertNoOverlap(employeeDetailId, input.fromDate, input.toDate);

  const charge = await computeCharge({
    employee,
    policy,
    fromDate: input.fromDate,
    toDate: input.toDate,
    dayPart,
  });

  if (charge.totalDays <= 0) {
    // The whole range was week-offs and holidays that the sandwich rule
    // does not charge. Refused rather than stored as a zero-day request:
    // CK_tblLeaveRequest_Days would reject it anyway, and the employee
    // needs to be told their dates cost nothing rather than shown an error
    // about a constraint.
    throw ApiError.badRequest(MESSAGES.LEAVE_NO_WORKING_DAYS, {
      code: ERROR_CODE.LEAVE_NO_WORKING_DAYS,
    });
  }

  /*
    A category with no cycle - LWP, comp-off - still needs a LeaveCycleId
    because the column is NOT NULL and the ledger is grouped by it. It gets
    the financial cycle, which is the company's main year. The policy's
    CycleType remains the authority on what the category MEANS; this is
    just where its rows are filed.
  */
  const cycle = await requireCycleFor(
    policy.cycleType === POLICY_CYCLE_TYPE.NONE ? CYCLE_TYPE.FINANCIAL : policy.cycleType,
    input.fromDate,
  );

  const balance = await balanceFor(employeeDetailId, input.leaveTypeId, cycle.leaveCycleId);
  const split = splitPaidAndLWP(charge, policy, balance);

  /*
    A paid category that would produce LWP is allowed through rather than
    refused - the HR document describes exactly that fallthrough for
    probation CL/SL. What is NOT allowed is a category whose policy says it
    is paid and whose employee expects it to be: the client gets the split
    back in the response and the preview showed it beforehand.
  */
  /*
    Every request starts with the reporting manager, including the ones
    that will also need HR. Going straight to HR for maternity leave would
    mean the manager learns their report is off for six months from the
    team calendar, which is not how that conversation should happen. The
    second level is added on approval - see approve().
  */
  const requiresHr = Boolean(policy.requiresSecondApproval);
  const status = LEAVE_REQUEST_STATUS.PENDING_MANAGER;

  return withTransaction(async (run) => {
    const [request] = await run(
      `INSERT INTO ${LeaveRequest.table}
              (EmployeeDetailId, LeaveTypeId, LeaveCycleId, FromDate, ToDate, DayPart,
               TotalDays, SandwichDays, PaidDays, LWPDays, Reason, ContactDuringLeave,
               DocumentUrl, Status, CurrentApproverId, CreatedBy, ModifiedBy)
       OUTPUT ${OUTPUT_REQUEST}
       VALUES (@employeeDetailId, @leaveTypeId, @leaveCycleId, @fromDate, @toDate, @dayPart,
               @totalDays, @sandwichDays, @paidDays, @lwpDays, @reason, @contactDuringLeave,
               @documentUrl, @status, @currentApproverId, @actorId, @actorId)`,
      {
        ...LeaveRequest.params({
          employeeDetailId,
          leaveTypeId: input.leaveTypeId,
          leaveCycleId: cycle.leaveCycleId,
          fromDate: input.fromDate,
          toDate: input.toDate,
          dayPart,
          totalDays: charge.totalDays,
          sandwichDays: charge.sandwichDays,
          paidDays: split.paidDays,
          lwpDays: split.lwpDays,
          reason: input.reason,
          contactDuringLeave: input.contactDuringLeave ?? null,
          documentUrl: input.documentUrl ?? null,
          status,
          currentApproverId: employee.managerId ?? null,
        }),
        actorId: LeaveRequest.param('createdBy', actorId),
      },
    );

    for (const day of split.days) {
      await run(
        `INSERT INTO ${LeaveRequestDay.table}
                (LeaveRequestId, LeaveDate, DayType, DayPart, IsLWP, ChargedDays, CreatedBy)
         VALUES (@leaveRequestId, @leaveDate, @dayType, @dayPart, @isLWP, @chargedDays, @actorId)`,
        {
          ...LeaveRequestDay.params({
            leaveRequestId: request.leaveRequestId,
            leaveDate: day.date,
            dayType: day.dayType,
            dayPart,
            isLWP: day.isLWP,
            chargedDays: day.chargedDays,
          }),
          actorId: LeaveRequestDay.param('createdBy', actorId),
        },
      );
    }

    // The hold - paid days only. See the header.
    if (split.paidDays > 0) {
      await writeLedger(run, {
        employeeDetailId,
        leaveTypeId: input.leaveTypeId,
        leaveCycleId: cycle.leaveCycleId,
        entryType: LEDGER_ENTRY_TYPE.HOLD,
        days: split.paidDays,
        isHold: true,
        sourceType: LEDGER_SOURCE_TYPE.LEAVE_REQUEST,
        sourceId: request.leaveRequestId,
        effectiveDate: input.fromDate,
        remarks: `Applied ${input.fromDate} to ${input.toDate}`,
        createdBy: actorId,
      });
    }

    await run(
      `INSERT INTO ${LeaveApproval.table}
              (LeaveRequestId, ApprovalLevel, ApproverId, ApproverRole, Action, Remarks)
       VALUES (@leaveRequestId, @approvalLevel, @approverId, @approverRole, @action, @remarks)`,
      LeaveApproval.params({
        leaveRequestId: request.leaveRequestId,
        approvalLevel: APPROVAL_LEVEL.MANAGER,
        approverId: actorId,
        approverRole: APPROVER_ROLE.EMPLOYEE,
        action: APPROVAL_ACTION.SUBMITTED,
        remarks: input.reason,
      }),
    );

    return {
      ...shape(request),
      days: split.days,
      sandwichMode: charge.sandwichMode,
      requiresHrApproval: requiresHr,
    };
  });
}

/**
 * Refuses a second application covering dates already applied for.
 *
 * Only PENDING and APPROVED count - a rejected or cancelled request leaves
 * its dates free, which is the whole point of rejecting one.
 */
async function assertNoOverlap(employeeDetailId, fromDate, toDate, exceptId = null) {
  const live = [...LEAVE_PENDING_STATUSES, LEAVE_REQUEST_STATUS.APPROVED];

  const clash = await queryOne(
    `SELECT TOP (1) LeaveRequestId AS leaveRequestId, FromDate AS fromDate, ToDate AS toDate
       FROM ${LeaveRequest.table}
      WHERE EmployeeDetailId = @employeeDetailId
        AND DeletedAt IS NULL
        AND Status IN ('${live.join("','")}')
        AND FromDate <= @toDate AND ToDate >= @fromDate
        AND (@exceptId IS NULL OR LeaveRequestId <> @exceptId)`,
    {
      ...LeaveRequest.params({ employeeDetailId }),
      fromDate: LeaveRequest.param('fromDate', fromDate),
      toDate: LeaveRequest.param('toDate', toDate),
      exceptId: LeaveRequest.param('leaveRequestId', exceptId),
    },
  );

  if (clash) {
    throw ApiError.conflict(MESSAGES.LEAVE_REQUEST_OVERLAP, {
      code: ERROR_CODE.LEAVE_REQUEST_OVERLAP,
      conflictsWith: shape(clash),
    });
  }
}

/* -------------------------------------------------------------------------
   Reading requests
   ------------------------------------------------------------------------- */

export async function getRequest(leaveRequestId) {
  const row = shape(
    await queryOne(
      `SELECT ${REQUEST_COLUMNS} FROM ${LeaveRequest.table}
        WHERE LeaveRequestId = @leaveRequestId AND DeletedAt IS NULL`,
      LeaveRequest.params({ leaveRequestId }),
    ),
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.LEAVE_REQUEST_NOT_FOUND, {
      code: ERROR_CODE.LEAVE_REQUEST_NOT_FOUND,
    });
  }
  return row;
}

/** A request with its days and its approval trail - the detail screen. */
export async function requestDetail(leaveRequestId) {
  const request = await getRequest(leaveRequestId);

  const [days, trail] = await Promise.all([
    query(
      `SELECT ${LeaveRequestDay.select(LEAVE_REQUEST_DAY_PUBLIC_PROPS)}
         FROM ${LeaveRequestDay.table} WHERE LeaveRequestId = @leaveRequestId
        ORDER BY LeaveDate`,
      LeaveRequestDay.params({ leaveRequestId }),
    ),
    query(
      `SELECT ${LEAVE_APPROVAL_PUBLIC_PROPS.map((p) => `a.${LeaveApproval.col(p)} AS ${p}`).join(', ')},
              e.FirstName AS approverFirstName,
              e.LastName  AS approverLastName
         FROM ${LeaveApproval.table}   AS a
         JOIN ${EmployeeDetails.table} AS e ON e.EmployeeDetailId = a.ApproverId
        WHERE a.LeaveRequestId = @leaveRequestId
        ORDER BY a.ActedAt`,
      LeaveApproval.params({ leaveRequestId }),
    ),
  ]);

  return { ...request, days: shapeAll(days), approvals: shapeAll(trail) };
}

export async function listForEmployee(employeeDetailId, { status = null, fromDate = null, toDate = null } = {}) {
  return shapeAll(
    await query(
      `SELECT ${LEAVE_REQUEST_PUBLIC_PROPS.map((p) => `r.${LeaveRequest.col(p)} AS ${p}`).join(', ')},
              lt.Name       AS leaveTypeName,
              c.CycleLabel  AS cycleLabel
         FROM ${LeaveRequest.table} AS r
         JOIN ${LeaveType.table}    AS lt ON lt.LeaveTypeId  = r.LeaveTypeId
         JOIN ${LeaveCycle.table}   AS c  ON c.LeaveCycleId  = r.LeaveCycleId
        WHERE r.EmployeeDetailId = @employeeDetailId AND r.DeletedAt IS NULL
          AND (@status   IS NULL OR r.Status = @status)
          AND (@fromDate IS NULL OR r.ToDate   >= @fromDate)
          AND (@toDate   IS NULL OR r.FromDate <= @toDate)
        ORDER BY r.FromDate DESC`,
      {
        ...LeaveRequest.params({ employeeDetailId, status }),
        fromDate: LeaveRequest.param('fromDate', fromDate),
        toDate: LeaveRequest.param('toDate', toDate),
      },
    ),
  );
}

/**
 * The approver's queue.
 *
 * `managerId` narrows to one manager's reports; omitting it is the HR view.
 * Which a caller gets is decided in the controller from the rights they
 * hold - see the route file.
 */
export async function listPending({ managerId = null } = {}) {
  return shapeAll(
    await query(
      `SELECT ${LEAVE_REQUEST_PUBLIC_PROPS.map((p) => `r.${LeaveRequest.col(p)} AS ${p}`).join(', ')},
              lt.Name        AS leaveTypeName,
              e.FirstName    AS firstName,
              e.LastName     AS lastName,
              e.EmployeeCode AS employeeCode
         FROM ${LeaveRequest.table}    AS r
         JOIN ${LeaveType.table}       AS lt ON lt.LeaveTypeId = r.LeaveTypeId
         JOIN ${EmployeeDetails.table} AS e  ON e.EmployeeDetailId = r.EmployeeDetailId
        WHERE r.Status IN ('${LEAVE_PENDING_STATUSES.join("','")}')
          AND r.DeletedAt IS NULL AND e.DeletedAt IS NULL
          AND (@managerId IS NULL OR e.ManagerId = @managerId)
        ORDER BY r.CreatedAt`,
      { managerId: EmployeeDetails.param('managerId', managerId) },
    ),
  );
}

/** Who is off, and when - the team calendar. */
export async function teamCalendar({ fromDate, toDate, managerId = null, locationId = null }) {
  return shapeAll(
    await query(
      `SELECT r.LeaveRequestId   AS leaveRequestId,
              r.EmployeeDetailId AS employeeDetailId,
              e.FirstName        AS firstName,
              e.LastName         AS lastName,
              lt.Name            AS leaveTypeName,
              rd.LeaveDate       AS leaveDate,
              rd.DayPart         AS dayPart,
              rd.ChargedDays     AS chargedDays,
              r.Status           AS status
         FROM ${LeaveRequestDay.table} AS rd
         JOIN ${LeaveRequest.table}    AS r  ON r.LeaveRequestId = rd.LeaveRequestId
         JOIN ${EmployeeDetails.table} AS e  ON e.EmployeeDetailId = r.EmployeeDetailId
         JOIN ${LeaveType.table}       AS lt ON lt.LeaveTypeId = r.LeaveTypeId
        WHERE rd.LeaveDate BETWEEN @fromDate AND @toDate
          AND r.DeletedAt IS NULL AND e.DeletedAt IS NULL AND e.IsActive = 1
          AND r.Status IN ('${[...LEAVE_PENDING_STATUSES, LEAVE_REQUEST_STATUS.APPROVED].join("','")}')
          AND (@managerId  IS NULL OR e.ManagerId      = @managerId)
          AND (@locationId IS NULL OR e.WorkLocationId = @locationId)
        ORDER BY rd.LeaveDate, e.FirstName`,
      {
        fromDate: LeaveRequestDay.param('leaveDate', fromDate),
        toDate: LeaveRequestDay.param('leaveDate', toDate),
        managerId: EmployeeDetails.param('managerId', managerId),
        locationId: EmployeeDetails.param('workLocationId', locationId),
      },
    ),
  );
}

/* -------------------------------------------------------------------------
   Deciding
   ------------------------------------------------------------------------- */

/** The days of a request, for the ledger and the attendance marking. */
async function daysOf(leaveRequestId) {
  return shapeAll(
    await query(
      `SELECT ${LeaveRequestDay.select(LEAVE_REQUEST_DAY_PUBLIC_PROPS)}
         FROM ${LeaveRequestDay.table} WHERE LeaveRequestId = @leaveRequestId ORDER BY LeaveDate`,
      LeaveRequestDay.params({ leaveRequestId }),
    ),
  );
}

/**
 * Approve.
 *
 * ONE TRANSACTION, four writes: reverse the hold, write the DEBIT, write
 * the LWP_DEBIT, record the decision. Then - OUTSIDE the transaction - mark
 * the attendance days.
 *
 * The attendance marking is deliberately outside: it writes to a different
 * module's tables through its own service, and holding a transaction open
 * across that call would make a slow attendance write able to block the
 * leave ledger. If it fails, the leave is still correctly approved and the
 * nightly close will mark the days from the approved request anyway - which
 * is the right way round for the two to fail.
 *
 * A SECOND APPROVAL - maternity, paternity - moves the request to
 * PENDING_HR instead and writes nothing to the ledger yet. The hold stays
 * exactly where it is, which is what makes a part-approved request still
 * unspendable.
 */
export async function approve(actorId, leaveRequestId, { remarks = null, approverRole = APPROVER_ROLE.MANAGER } = {}) {
  const request = await getRequest(leaveRequestId);

  if (!LEAVE_PENDING_STATUSES.includes(request.status)) {
    throw ApiError.conflict(MESSAGES.LEAVE_REQUEST_NOT_PENDING, {
      code: ERROR_CODE.LEAVE_REQUEST_NOT_PENDING,
      status: request.status,
    });
  }
  if (Number(request.employeeDetailId) === Number(actorId)) {
    throw ApiError.forbidden(MESSAGES.LEAVE_SELF_APPROVAL, {
      code: ERROR_CODE.LEAVE_SELF_APPROVAL,
    });
  }

  const entry = await requirePolicyFor(request.employeeDetailId, request.leaveTypeId, {
    onDate: request.fromDate,
  });

  // Manager approved, HR still to go.
  if (
    request.status === LEAVE_REQUEST_STATUS.PENDING_MANAGER &&
    entry.policy.requiresSecondApproval
  ) {
    await withTransaction(async (run) => {
      await run(
        `UPDATE ${LeaveRequest.table}
            SET Status = @status, ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
          WHERE LeaveRequestId = @leaveRequestId`,
        {
          ...LeaveRequest.params({ leaveRequestId, status: LEAVE_REQUEST_STATUS.PENDING_HR }),
          actorId: LeaveRequest.param('modifiedBy', actorId),
        },
      );
      await run(
        `INSERT INTO ${LeaveApproval.table}
                (LeaveRequestId, ApprovalLevel, ApproverId, ApproverRole, Action, Remarks)
         VALUES (@leaveRequestId, @approvalLevel, @approverId, @approverRole, @action, @remarks)`,
        LeaveApproval.params({
          leaveRequestId,
          approvalLevel: APPROVAL_LEVEL.MANAGER,
          approverId: actorId,
          approverRole,
          action: APPROVAL_ACTION.FORWARDED,
          remarks,
        }),
      );
    });
    return getRequest(leaveRequestId);
  }

  const days = await daysOf(leaveRequestId);

  await withTransaction(async (run) => {
    await run(
      `UPDATE ${LeaveRequest.table}
          SET Status = @status, DecidedAt = SYSUTCDATETIME(),
              ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE LeaveRequestId = @leaveRequestId`,
      {
        ...LeaveRequest.params({ leaveRequestId, status: LEAVE_REQUEST_STATUS.APPROVED }),
        actorId: LeaveRequest.param('modifiedBy', actorId),
      },
    );

    const common = {
      employeeDetailId: request.employeeDetailId,
      leaveTypeId: request.leaveTypeId,
      leaveCycleId: request.leaveCycleId,
      sourceType: LEDGER_SOURCE_TYPE.LEAVE_REQUEST,
      sourceId: leaveRequestId,
      effectiveDate: request.fromDate,
      createdBy: actorId,
    };

    // Clear the hold, then charge. Two rows rather than one net entry so
    // the statement reads as what actually happened.
    if (request.paidDays > 0) {
      await writeLedger(run, {
        ...common,
        entryType: LEDGER_ENTRY_TYPE.REVERSAL,
        days: -request.paidDays,
        isHold: true,
        remarks: 'Hold released on approval',
      });
      await writeLedger(run, {
        ...common,
        entryType: LEDGER_ENTRY_TYPE.DEBIT,
        days: -request.paidDays,
        remarks: `Approved ${request.fromDate} to ${request.toDate}`,
      });
    }

    /*
      LWP is recorded against the SAME category, as an LWP_DEBIT. The view
      counts those separately and never offsets them against the paid
      balance - which is the HR document's prohibition, kept true by where
      the row is written rather than by a rule somewhere downstream.
    */
    if (request.lwpDays > 0) {
      await writeLedger(run, {
        ...common,
        entryType: LEDGER_ENTRY_TYPE.LWP_DEBIT,
        days: -request.lwpDays,
        remarks: `${request.lwpDays} day(s) without pay - balance exhausted`,
      });
    }

    await run(
      `INSERT INTO ${LeaveApproval.table}
              (LeaveRequestId, ApprovalLevel, ApproverId, ApproverRole, Action, Remarks)
       VALUES (@leaveRequestId, @approvalLevel, @approverId, @approverRole, @action, @remarks)`,
      LeaveApproval.params({
        leaveRequestId,
        approvalLevel:
          request.status === LEAVE_REQUEST_STATUS.PENDING_HR
            ? APPROVAL_LEVEL.HR
            : APPROVAL_LEVEL.MANAGER,
        approverId: actorId,
        approverRole,
        action: APPROVAL_ACTION.APPROVED,
        remarks,
      }),
    );
  });

  // Outside the transaction - see the note above.
  await markLeaveDays(request.employeeDetailId, leaveRequestId, days, actorId);

  return requestDetail(leaveRequestId);
}

/** Reject: release the hold, charge nothing. */
export async function reject(actorId, leaveRequestId, { remarks = null, approverRole = APPROVER_ROLE.MANAGER } = {}) {
  const request = await getRequest(leaveRequestId);

  if (!LEAVE_PENDING_STATUSES.includes(request.status)) {
    throw ApiError.conflict(MESSAGES.LEAVE_REQUEST_NOT_PENDING, {
      code: ERROR_CODE.LEAVE_REQUEST_NOT_PENDING,
      status: request.status,
    });
  }
  if (Number(request.employeeDetailId) === Number(actorId)) {
    throw ApiError.forbidden(MESSAGES.LEAVE_SELF_APPROVAL, {
      code: ERROR_CODE.LEAVE_SELF_APPROVAL,
    });
  }

  await withTransaction(async (run) => {
    await run(
      `UPDATE ${LeaveRequest.table}
          SET Status = @status, DecidedAt = SYSUTCDATETIME(),
              ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE LeaveRequestId = @leaveRequestId`,
      {
        ...LeaveRequest.params({ leaveRequestId, status: LEAVE_REQUEST_STATUS.REJECTED }),
        actorId: LeaveRequest.param('modifiedBy', actorId),
      },
    );

    if (request.paidDays > 0) {
      await writeLedger(run, {
        employeeDetailId: request.employeeDetailId,
        leaveTypeId: request.leaveTypeId,
        leaveCycleId: request.leaveCycleId,
        entryType: LEDGER_ENTRY_TYPE.REVERSAL,
        days: -request.paidDays,
        isHold: true,
        sourceType: LEDGER_SOURCE_TYPE.LEAVE_REQUEST,
        sourceId: leaveRequestId,
        effectiveDate: request.fromDate,
        remarks: 'Hold released on rejection',
        createdBy: actorId,
      });
    }

    await run(
      `INSERT INTO ${LeaveApproval.table}
              (LeaveRequestId, ApprovalLevel, ApproverId, ApproverRole, Action, Remarks)
       VALUES (@leaveRequestId, @approvalLevel, @approverId, @approverRole, @action, @remarks)`,
      LeaveApproval.params({
        leaveRequestId,
        approvalLevel:
          request.status === LEAVE_REQUEST_STATUS.PENDING_HR
            ? APPROVAL_LEVEL.HR
            : APPROVAL_LEVEL.MANAGER,
        approverId: actorId,
        approverRole,
        action: APPROVAL_ACTION.REJECTED,
        remarks,
      }),
    );
  });

  return getRequest(leaveRequestId);
}

/** The employee taking back a request nobody has decided yet. */
export async function cancel(actorId, employeeDetailId, leaveRequestId, { reason = null } = {}) {
  const request = await getRequest(leaveRequestId);

  if (Number(request.employeeDetailId) !== Number(employeeDetailId)) {
    // A 404 rather than a 403: the caller has no business knowing that
    // somebody else's request exists.
    throw ApiError.notFound(MESSAGES.LEAVE_REQUEST_NOT_FOUND, {
      code: ERROR_CODE.LEAVE_REQUEST_NOT_FOUND,
    });
  }
  if (!LEAVE_PENDING_STATUSES.includes(request.status)) {
    throw ApiError.conflict(MESSAGES.LEAVE_REQUEST_NOT_PENDING, {
      code: ERROR_CODE.LEAVE_REQUEST_NOT_PENDING,
      status: request.status,
    });
  }

  await withTransaction(async (run) => {
    await run(
      `UPDATE ${LeaveRequest.table}
          SET Status = @status, CancelledAt = SYSUTCDATETIME(), CancelReason = @reason,
              ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE LeaveRequestId = @leaveRequestId`,
      {
        ...LeaveRequest.params({
          leaveRequestId,
          status: LEAVE_REQUEST_STATUS.CANCELLED,
          cancelReason: reason,
        }),
        reason: LeaveRequest.param('cancelReason', reason),
        actorId: LeaveRequest.param('modifiedBy', actorId),
      },
    );

    if (request.paidDays > 0) {
      await writeLedger(run, {
        employeeDetailId: request.employeeDetailId,
        leaveTypeId: request.leaveTypeId,
        leaveCycleId: request.leaveCycleId,
        entryType: LEDGER_ENTRY_TYPE.REVERSAL,
        days: -request.paidDays,
        isHold: true,
        sourceType: LEDGER_SOURCE_TYPE.LEAVE_REQUEST,
        sourceId: leaveRequestId,
        effectiveDate: request.fromDate,
        remarks: 'Hold released on cancellation',
        createdBy: actorId,
      });
    }

    await run(
      `INSERT INTO ${LeaveApproval.table}
              (LeaveRequestId, ApprovalLevel, ApproverId, ApproverRole, Action, Remarks)
       VALUES (@leaveRequestId, @approvalLevel, @approverId, @approverRole, @action, @remarks)`,
      LeaveApproval.params({
        leaveRequestId,
        approvalLevel: APPROVAL_LEVEL.MANAGER,
        approverId: actorId,
        approverRole: APPROVER_ROLE.EMPLOYEE,
        action: APPROVAL_ACTION.CANCELLED,
        remarks: reason,
      }),
    );
  });

  return getRequest(leaveRequestId);
}

/**
 * Withdraw an APPROVED request - the plans changed after it was signed off.
 *
 * Gives the days back with a positive REVERSAL rather than deleting the
 * DEBIT, because the ledger is append-only and "I took it and then gave it
 * back" is a different story from "it never happened" - and only the first
 * one is true.
 *
 * The LWP entry is reversed too: unpaid days nobody took must not reach
 * payroll.
 */
export async function withdraw(actorId, employeeDetailId, leaveRequestId, { reason = null } = {}) {
  const request = await getRequest(leaveRequestId);

  if (Number(request.employeeDetailId) !== Number(employeeDetailId)) {
    throw ApiError.notFound(MESSAGES.LEAVE_REQUEST_NOT_FOUND, {
      code: ERROR_CODE.LEAVE_REQUEST_NOT_FOUND,
    });
  }
  if (request.status !== LEAVE_REQUEST_STATUS.APPROVED) {
    throw ApiError.conflict(MESSAGES.LEAVE_REQUEST_NOT_PENDING, {
      code: ERROR_CODE.LEAVE_REQUEST_NOT_PENDING,
      status: request.status,
    });
  }

  await withTransaction(async (run) => {
    await run(
      `UPDATE ${LeaveRequest.table}
          SET Status = @status, CancelledAt = SYSUTCDATETIME(), CancelReason = @reason,
              ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE LeaveRequestId = @leaveRequestId`,
      {
        ...LeaveRequest.params({
          leaveRequestId,
          status: LEAVE_REQUEST_STATUS.WITHDRAWN,
          cancelReason: reason,
        }),
        reason: LeaveRequest.param('cancelReason', reason),
        actorId: LeaveRequest.param('modifiedBy', actorId),
      },
    );

    const common = {
      employeeDetailId: request.employeeDetailId,
      leaveTypeId: request.leaveTypeId,
      leaveCycleId: request.leaveCycleId,
      sourceType: LEDGER_SOURCE_TYPE.LEAVE_REQUEST,
      sourceId: leaveRequestId,
      effectiveDate: request.fromDate,
      createdBy: actorId,
    };

    if (request.paidDays > 0) {
      await writeLedger(run, {
        ...common,
        entryType: LEDGER_ENTRY_TYPE.REVERSAL,
        days: request.paidDays,
        remarks: 'Withdrawn after approval - days returned',
      });
    }

    /*
      THE LWP REVERSAL IS AN LWP_DEBIT, NOT A REVERSAL, and the entry type
      is doing real work here.

      The view keeps unpaid days in their own bucket, outside the paid
      balance - that is the HR document's prohibition made structural. A
      plain REVERSAL is not in that bucket, so reversing two unpaid days
      with one would have handed the employee two PAID days they never had,
      and left payroll still deducting for the two unpaid ones.

      A positive LWP_DEBIT cancels the negative one in the same bucket and
      touches nothing else.
    */
    if (request.lwpDays > 0) {
      await writeLedger(run, {
        ...common,
        entryType: LEDGER_ENTRY_TYPE.LWP_DEBIT,
        days: request.lwpDays,
        remarks: 'Withdrawn after approval - unpaid days reversed',
      });
    }

    await run(
      `INSERT INTO ${LeaveApproval.table}
              (LeaveRequestId, ApprovalLevel, ApproverId, ApproverRole, Action, Remarks)
       VALUES (@leaveRequestId, @approvalLevel, @approverId, @approverRole, @action, @remarks)`,
      LeaveApproval.params({
        leaveRequestId,
        approvalLevel: APPROVAL_LEVEL.MANAGER,
        approverId: actorId,
        approverRole: APPROVER_ROLE.EMPLOYEE,
        action: APPROVAL_ACTION.WITHDRAWN,
        remarks: reason,
      }),
    );
  });

  await unmarkLeaveDays(leaveRequestId, actorId);
  return getRequest(leaveRequestId);
}

/* -------------------------------------------------------------------------
   Manual corrections - the "manage balance" screen
   ------------------------------------------------------------------------- */

/**
 * HR adjusting a balance by hand, up or down.
 *
 * REMARKS ARE MANDATORY, and this is the one entry type where that is
 * true. Every other row in the ledger points at something that explains it
 * - a request, a comp-off credit, an accrual run. An adjustment points at
 * nothing, so without a reason the statement line reads "+3 days" with no
 * way for anybody, ever, to find out why.
 *
 * A NEGATIVE ADJUSTMENT MAY NOT TAKE A BALANCE BELOW ZERO. Days somebody
 * has already taken cannot be un-taken by arithmetic - that situation is
 * unpaid leave, and it has its own entry type which payroll reads.
 */
export async function adjustBalance(actorId, employeeDetailId, input) {
  if (!input.remarks?.trim()) {
    throw ApiError.badRequest(MESSAGES.LEAVE_ADJUSTMENT_NEEDS_REMARKS, {
      code: ERROR_CODE.LEAVE_ADJUSTMENT_NEEDS_REMARKS,
    });
  }

  const days = Number(input.days);
  if (!Number.isFinite(days) || days === 0) {
    throw ApiError.badRequest(MESSAGES.VALIDATION_FAILED, { days: 'Days must be a non-zero number' });
  }

  const balance = await balanceFor(employeeDetailId, input.leaveTypeId, input.leaveCycleId);

  if (days < 0 && Number(balance.balanceDays) + days < 0) {
    throw ApiError.badRequest(MESSAGES.LEAVE_ADJUSTMENT_WOULD_GO_NEGATIVE, {
      code: ERROR_CODE.LEAVE_ADJUSTMENT_WOULD_GO_NEGATIVE,
      balanceDays: Number(balance.balanceDays),
      requested: days,
    });
  }

  await withTransaction(async (run) => {
    await writeLedger(run, {
      employeeDetailId,
      leaveTypeId: input.leaveTypeId,
      leaveCycleId: input.leaveCycleId,
      entryType: LEDGER_ENTRY_TYPE.ADJUSTMENT,
      days,
      sourceType: LEDGER_SOURCE_TYPE.ADJUSTMENT,
      sourceId: null,
      effectiveDate: input.effectiveDate ?? today(),
      remarks: input.remarks.trim(),
      createdBy: actorId,
    });
  });

  return balanceFor(employeeDetailId, input.leaveTypeId, input.leaveCycleId);
}

/**
 * Granting days to several employees at once - the "add leaves" screen.
 *
 * Written as ADJUSTMENT rows, not ACCRUAL: an accrual is something the
 * policy produced and the accrual job owns, and labelling a hand grant as
 * one would make the job's idempotence check see work it did not do.
 */
export async function grantBalance(actorId, input) {
  if (!input.remarks?.trim()) {
    throw ApiError.badRequest(MESSAGES.LEAVE_ADJUSTMENT_NEEDS_REMARKS, {
      code: ERROR_CODE.LEAVE_ADJUSTMENT_NEEDS_REMARKS,
    });
  }

  const effectiveDate = input.effectiveDate ?? today();
  const granted = [];

  await withTransaction(async (run) => {
    for (const employeeDetailId of input.employeeDetailIds) {
      await writeLedger(run, {
        employeeDetailId,
        leaveTypeId: input.leaveTypeId,
        leaveCycleId: input.leaveCycleId,
        entryType: LEDGER_ENTRY_TYPE.ADJUSTMENT,
        days: Number(input.days),
        sourceType: LEDGER_SOURCE_TYPE.ADJUSTMENT,
        sourceId: null,
        effectiveDate,
        remarks: input.remarks.trim(),
        createdBy: actorId,
      });
      granted.push(Number(employeeDetailId));
    }
  });

  return { granted, days: Number(input.days), effectiveDate };
}

/* -------------------------------------------------------------------------
   Payroll
   ------------------------------------------------------------------------- */

/**
 * Employee-wise leave without pay for a period - what payroll deducts on.
 *
 * Read from tblLeaveRequestDay rather than from the ledger, because payroll
 * needs the DATES and not just a total: a month boundary cuts through a
 * request, and the ledger entry is filed against the request's start date.
 */
export async function lwpReport({ fromDate, toDate, locationId = null }) {
  return shapeAll(
    await query(
      `SELECT r.EmployeeDetailId AS employeeDetailId,
              e.EmployeeCode     AS employeeCode,
              e.FirstName        AS firstName,
              e.LastName         AS lastName,
              e.WorkLocationId   AS workLocationId,
              SUM(rd.ChargedDays) AS lwpDays,
              COUNT(*)            AS lwpDayCount,
              MIN(rd.LeaveDate)   AS firstDate,
              MAX(rd.LeaveDate)   AS lastDate
         FROM ${LeaveRequestDay.table} AS rd
         JOIN ${LeaveRequest.table}    AS r ON r.LeaveRequestId = rd.LeaveRequestId
         JOIN ${EmployeeDetails.table} AS e ON e.EmployeeDetailId = r.EmployeeDetailId
        WHERE rd.IsLWP = 1
          AND rd.LeaveDate BETWEEN @fromDate AND @toDate
          AND r.Status = @approved
          AND r.DeletedAt IS NULL AND e.DeletedAt IS NULL
          AND (@locationId IS NULL OR e.WorkLocationId = @locationId)
        GROUP BY r.EmployeeDetailId, e.EmployeeCode, e.FirstName, e.LastName, e.WorkLocationId
        ORDER BY e.FirstName, e.LastName`,
      {
        fromDate: LeaveRequestDay.param('leaveDate', fromDate),
        toDate: LeaveRequestDay.param('leaveDate', toDate),
        approved: LeaveRequest.param('status', LEAVE_REQUEST_STATUS.APPROVED),
        locationId: EmployeeDetails.param('workLocationId', locationId),
      },
    ),
  );
}

export { writeLedger, daysOf, round2 };

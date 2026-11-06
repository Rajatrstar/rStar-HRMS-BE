/**
 * The monthly accrual: granting the days a policy says somebody earns.
 *
 * IDEMPOTENT BY CONSTRUCTION. Before writing an ACCRUAL entry it looks for
 * one already written for the same employee, category, cycle and month -
 * so running the job twice grants nothing twice, and a run that catches up
 * after a missed night is safe. That is what makes this schedulable at all:
 * a job that must run exactly once is a job that eventually does not.
 *
 * ACCRUAL_ANCHOR IS WHY THIS FILE IS NOT SIMPLER. The two source documents
 * disagree about when EL starts accruing - the original requirement list
 * says the 1st of every month, the HR document says from the probation end
 * date, and HR's own question asks whether it is that exact date or the
 * month after. Section 28 records it as unresolved.
 *
 * Rather than pick one and bury it here, all four anchors are implemented
 * and tblLeavePolicy.AccrualAnchor chooses. Whichever answer HR gives is
 * then a configuration change, not a rewrite of this job.
 */
import { query } from '../helpers/query.helper.js';
import { withTransaction } from '../helpers/query.helper.js';
import { LeaveLedger, EmployeeDetails } from '../models/index.js';
import {
  ACCRUAL_FREQUENCY,
  ACCRUAL_ANCHOR,
  LEDGER_ENTRY_TYPE,
  LEDGER_SOURCE_TYPE,
  POLICY_CYCLE_TYPE,
  CYCLE_TYPE,
  CONFIRMATION_STATUS,
} from '../enums/index.js';
import { today, monthBounds, dateOf, addMonths } from '../helpers/date.helper.js';
import { findCycleFor } from './leave-cycle.service.js';
import { loadEmployeeForLeave, resolveForEmployee } from './leave-policy.service.js';
import { balanceFor, writeLedger, round2 } from './leave.service.js';

/**
 * Is an accrual due for this policy, for this employee, in this month?
 *
 * The four anchors, and what each means:
 *
 *   MONTH_START    the 1st of every month. Everybody accrues together,
 *                  which is the original requirement list's reading.
 *   CYCLE_START    once, on the cycle's own start date. For an ANNUAL grant.
 *   PROBATION_END  the confirmation anniversary - the HR document. Somebody
 *                  confirmed on the 18th accrues on the 18th.
 *   JOINING_DATE   the joining anniversary, same shape as above.
 *
 * Returns the DATE the accrual is for, or null when none is due. A date
 * rather than a boolean because the ledger entry's EffectiveDate must be
 * the day it was earned, not the day the job happened to run.
 */
function accrualDateFor(policy, employee, onDate) {
  const { start } = monthBounds(onDate);

  if (policy.accrualFrequency === ACCRUAL_FREQUENCY.NONE) return null;

  if (policy.accrualFrequency === ACCRUAL_FREQUENCY.ANNUAL) {
    // An annual grant lands once, at the start of the cycle. Anchors other
    // than CYCLE_START are meaningless for it and are read the same way.
    return start;
  }

  switch (policy.accrualAnchor) {
    case ACCRUAL_ANCHOR.MONTH_START:
      return start;

    case ACCRUAL_ANCHOR.CYCLE_START:
      return start;

    case ACCRUAL_ANCHOR.PROBATION_END: {
      /*
        The HR document's reading: EL begins at confirmation. Nothing
        accrues before that date at all, and the first accrual falls on the
        anniversary day of the confirmation within each later month.
      */
      const from = employee.confirmedOn ?? employee.probationEndDate;
      if (!from || from > onDate) return null;

      const dayOfMonth = Number(from.slice(8, 10));
      const anniversary = `${start.slice(0, 7)}-${String(dayOfMonth).padStart(2, '0')}`;

      // A 31st anniversary in a 30-day month lands on the last day instead.
      const { end } = monthBounds(onDate);
      return anniversary > end ? end : anniversary;
    }

    case ACCRUAL_ANCHOR.JOINING_DATE: {
      const from = employee.dateOfJoining;
      if (!from || from > onDate) return null;

      const dayOfMonth = Number(from.slice(8, 10));
      const anniversary = `${start.slice(0, 7)}-${String(dayOfMonth).padStart(2, '0')}`;
      const { end } = monthBounds(onDate);
      return anniversary > end ? end : anniversary;
    }

    default:
      return start;
  }
}

/**
 * Has this accrual already been written?
 *
 * The idempotence check. Matched on the MONTH rather than the exact date,
 * because a policy whose anchor moved - or a catch-up run landing on a
 * different day from the original - must not produce a second grant for
 * the same month.
 */
async function alreadyAccrued({ employeeDetailId, leaveTypeId, leaveCycleId, forDate }) {
  const { start, end } = monthBounds(forDate);

  const rows = await query(
    `SELECT TOP (1) LeaveLedgerId AS leaveLedgerId
       FROM ${LeaveLedger.table}
      WHERE EmployeeDetailId = @employeeDetailId
        AND LeaveTypeId      = @leaveTypeId
        AND LeaveCycleId     = @leaveCycleId
        AND EntryType        = @accrual
        AND EffectiveDate BETWEEN @start AND @end`,
    {
      ...LeaveLedger.params({ employeeDetailId, leaveTypeId, leaveCycleId }),
      accrual: LeaveLedger.param('entryType', LEDGER_ENTRY_TYPE.ACCRUAL),
      start: LeaveLedger.param('effectiveDate', start),
      end: LeaveLedger.param('effectiveDate', end),
    },
  );
  return rows.length > 0;
}

/**
 * Run the accrual for one employee.
 *
 * Returns what it granted and what it skipped, with a reason for each skip.
 * The reasons are what make a nightly job debuggable: "nobody got EL last
 * month" is answerable from the run's own output rather than by rerunning
 * it with logging added.
 */
export async function accrueForEmployee(employeeDetailId, { onDate = today(), actorId = null } = {}) {
  const employee = await loadEmployeeForLeave(employeeDetailId);
  const resolved = await resolveForEmployee(employeeDetailId, { onDate, employee });

  const granted = [];
  const skipped = [];

  for (const entry of resolved) {
    const policy = entry.policy;

    if (!policy) {
      skipped.push({ leaveTypeId: entry.leaveTypeId, reason: 'no policy' });
      continue;
    }
    if (!policy.tracksBalance || policy.accrualFrequency === ACCRUAL_FREQUENCY.NONE) {
      // LWP and comp-off: nothing accrues, by design.
      continue;
    }

    /*
      Probation. The policy's own flag decides - CL/SL accrues at one day a
      month during probation, EL does not accrue at all. Both are expressed
      as AvailableDuringProbation, so this is one check rather than a
      special case per category.
    */
    if (
      employee.confirmationStatus === CONFIRMATION_STATUS.PROBATION &&
      !policy.availableDuringProbation
    ) {
      skipped.push({ leaveTypeId: entry.leaveTypeId, reason: 'on probation' });
      continue;
    }

    const forDate = accrualDateFor(policy, employee, onDate);
    if (!forDate || forDate > onDate) {
      skipped.push({ leaveTypeId: entry.leaveTypeId, reason: 'not due yet' });
      continue;
    }

    const cycleType =
      policy.cycleType === POLICY_CYCLE_TYPE.NONE ? CYCLE_TYPE.FINANCIAL : policy.cycleType;
    const cycle = await findCycleFor(cycleType, forDate);

    if (!cycle) {
      skipped.push({ leaveTypeId: entry.leaveTypeId, reason: 'no leave cycle covers that date' });
      continue;
    }
    if (cycle.isClosed) {
      skipped.push({ leaveTypeId: entry.leaveTypeId, reason: 'cycle closed' });
      continue;
    }

    // Nothing accrues for a month before the employee joined.
    if (employee.dateOfJoining && forDate < employee.dateOfJoining) {
      skipped.push({ leaveTypeId: entry.leaveTypeId, reason: 'before joining' });
      continue;
    }

    if (
      await alreadyAccrued({
        employeeDetailId,
        leaveTypeId: entry.leaveTypeId,
        leaveCycleId: cycle.leaveCycleId,
        forDate,
      })
    ) {
      continue;
    }

    let days = Number(policy.accrualDays);

    /*
      The annual quota is a CEILING on what the cycle may grant, so the last
      accrual of a year is trimmed rather than refused. Somebody on 11.5 of
      a 12-day quota gets half a day, not a whole one and not nothing.
    */
    if (policy.annualQuota !== null && policy.annualQuota !== undefined) {
      const balance = await balanceFor(employeeDetailId, entry.leaveTypeId, cycle.leaveCycleId);
      const headroom = round2(Number(policy.annualQuota) - Number(balance.accruedDays));

      if (headroom <= 0) {
        skipped.push({ leaveTypeId: entry.leaveTypeId, reason: 'annual quota reached' });
        continue;
      }
      days = Math.min(days, headroom);
    }

    if (days <= 0) continue;

    await withTransaction(async (run) => {
      await writeLedger(run, {
        employeeDetailId,
        leaveTypeId: entry.leaveTypeId,
        leaveCycleId: cycle.leaveCycleId,
        entryType: LEDGER_ENTRY_TYPE.ACCRUAL,
        days: round2(days),
        sourceType: LEDGER_SOURCE_TYPE.ACCRUAL,
        sourceId: policy.leavePolicyId,
        effectiveDate: forDate,
        remarks: `${policy.accrualFrequency} accrual (${policy.accrualAnchor})`,
        createdBy: actorId,
      });
    });

    granted.push({
      leaveTypeId: entry.leaveTypeId,
      leaveTypeName: entry.leaveTypeName,
      days: round2(days),
      effectiveDate: forDate,
      cycleLabel: cycle.cycleLabel,
    });
  }

  return { employeeDetailId: Number(employeeDetailId), granted, skipped };
}

/**
 * Run the accrual for everybody.
 *
 * ONE EMPLOYEE'S FAILURE DOES NOT STOP THE REST. A single bad row - a
 * missing joining date, a cycle nobody opened - must not leave the rest of
 * the company un-accrued, and the failure list is what gets looked at in
 * the morning.
 *
 * Sequential rather than parallel on purpose: this runs once a night
 * against a shared database, and thirty concurrent transactions would buy
 * seconds at the cost of lock contention with whatever else is awake.
 */
export async function runAccrual({ onDate = today(), actorId = null } = {}) {
  const employees = await query(
    `SELECT EmployeeDetailId AS employeeDetailId
       FROM ${EmployeeDetails.table}
      WHERE DeletedAt IS NULL AND IsActive = 1 AND DateOfJoining IS NOT NULL
      ORDER BY EmployeeDetailId`,
  );

  const summary = { onDate, employees: employees.length, granted: 0, days: 0, failed: [] };

  for (const row of employees) {
    try {
      const result = await accrueForEmployee(Number(row.employeeDetailId), { onDate, actorId });
      summary.granted += result.granted.length;
      summary.days = round2(summary.days + result.granted.reduce((sum, g) => sum + g.days, 0));
    } catch (error) {
      summary.failed.push({
        employeeDetailId: Number(row.employeeDetailId),
        message: error.message,
      });
    }
  }

  return summary;
}

export { accrualDateFor };

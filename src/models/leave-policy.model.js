/**
 * The leave rulebook: dbo.tblLeaveCycle, dbo.tblSandwichRule,
 * dbo.tblLeavePolicy, dbo.tblEmployeeLeavePolicy and dbo.tblLeaveMapping.
 *
 * Mirrors db/migrations/018_leave_policy.sql.
 *
 * dbo.tblLeaveType is NOT here - it is master data from 009 and lives in
 * master-data.model.js. The distinction matters: a LEAVE TYPE is the name
 * on the dropdown, a LEAVE POLICY is the rules behind that name for a given
 * cohort over a given date range. One type, many policies over time.
 *
 * TWO CYCLES RUN AT ONCE - financial for CL/SL and EL, calendar for the
 * floating holiday - which is why a cycle is a row with a type rather than
 * a year integer. See the migration header.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

const auditColumns = () => ({
  createdBy: { column: 'CreatedBy', type: sql.BigInt, nullable: true },
  modifiedBy: { column: 'ModifiedBy', type: sql.BigInt, nullable: true },
  createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
  modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
  // NULL means live.
  deletedAt: { column: 'DeletedAt', type: sql.DateTime2, nullable: true },
});

const effectiveColumns = () => ({
  effectiveFrom: { column: 'EffectiveFrom', type: sql.Date },
  effectiveTo: { column: 'EffectiveTo', type: sql.Date, nullable: true },
});

/** dbo.tblLeaveCycle - the year a balance belongs to, and of which kind. */
export const LeaveCycle = defineModel({
  table: 'dbo.tblLeaveCycle',
  columns: {
    leaveCycleId: { column: 'LeaveCycleId', type: sql.BigInt, identity: true },

    // CYCLE_TYPE in src/enums/leave.enum.js: FINANCIAL or CALENDAR.
    cycleType: { column: 'CycleType', type: sql.NVarChar(12) },
    // "FY 2026-27", "CY 2027".
    cycleLabel: { column: 'CycleLabel', type: sql.NVarChar(20) },

    startDate: { column: 'StartDate', type: sql.Date },
    endDate: { column: 'EndDate', type: sql.Date },

    // Stops a backdated application landing in a settled cycle.
    isClosed: { column: 'IsClosed', type: sql.Bit },
    closedBy: { column: 'ClosedBy', type: sql.BigInt, nullable: true },
    closedAt: { column: 'ClosedAt', type: sql.DateTime2, nullable: true },

    ...auditColumns(),
  },
});

/** dbo.tblSandwichRule - whether the weekend inside a leave is charged. */
export const SandwichRule = defineModel({
  table: 'dbo.tblSandwichRule',
  columns: {
    sandwichRuleId: { column: 'SandwichRuleId', type: sql.BigInt, identity: true },

    ruleName: { column: 'RuleName', type: sql.NVarChar(100) },
    // SANDWICH_MODE in src/enums/leave.enum.js. All three were specified.
    mode: { column: 'Mode', type: sql.NVarChar(30) },

    locationId: { column: 'LocationId', type: sql.BigInt, nullable: true },
    // Whether declared holidays inside the range are charged too, not just
    // week-offs. A genuinely independent question from the mode.
    includeHolidays: { column: 'IncludeHolidays', type: sql.Bit },

    description: { column: 'Description', type: sql.NVarChar(500), nullable: true },
    isActive: { column: 'IsActive', type: sql.Bit },

    ...auditColumns(),
  },
});

/**
 * dbo.tblLeavePolicy - how one category behaves, for one cohort, from one
 * date.
 *
 * EFFECTIVE-DATED, and never edited in place: last year's approved leave
 * was charged under last year's rules, and a balance that recomputes when
 * somebody edits the policy is a balance nobody can defend in a payroll
 * dispute. A revised policy is a new row.
 */
export const LeavePolicy = defineModel({
  table: 'dbo.tblLeavePolicy',
  columns: {
    leavePolicyId: { column: 'LeavePolicyId', type: sql.BigInt, identity: true },

    // CL/SL is ONE type and one policy row - the HR document treats them
    // as a single balance.
    leaveTypeId: { column: 'LeaveTypeId', type: sql.BigInt },

    // The cohort. Both NULL = everybody.
    locationId: { column: 'LocationId', type: sql.BigInt, nullable: true },
    employmentType: { column: 'EmploymentType', type: sql.NVarChar(30), nullable: true },

    // POLICY_CYCLE_TYPE: FINANCIAL, CALENDAR, or NONE for LWP and comp-off.
    cycleType: { column: 'CycleType', type: sql.NVarChar(12) },

    /*
      Two separate questions, deliberately two columns. Available = may it
      be applied for. Visible = does it appear on the dashboard at all. EL
      on a probation dashboard is visible at zero with a note, which is
      information rather than an offer - collapsing these loses exactly that.
    */
    availableDuringProbation: { column: 'AvailableDuringProbation', type: sql.Bit },
    visibleDuringProbation: { column: 'VisibleDuringProbation', type: sql.Bit },

    // 0 for LWP. Read by payroll.
    isPaid: { column: 'IsPaid', type: sql.Bit },
    /*
      0 for LWP, and the column that keeps the HR document's prohibition
      true: a category that tracks no balance can have nothing deducted
      from it. Enforced further by CK_tblLeavePolicy_NoBalanceNoAccrual.
    */
    tracksBalance: { column: 'TracksBalance', type: sql.Bit },

    // ACCRUAL_FREQUENCY in src/enums/leave.enum.js.
    accrualFrequency: { column: 'AccrualFrequency', type: sql.NVarChar(20) },
    accrualDays: { column: 'AccrualDays', type: sql.Decimal(5, 2) },
    /*
      ACCRUAL_ANCHOR - where the monthly clock starts. This column exists
      because the two source documents disagree and HR's own question asks
      a third version; section 28 records it as open. All four are
      implemented so the answer is configuration, not a rewrite.
    */
    accrualAnchor: { column: 'AccrualAnchor', type: sql.NVarChar(30) },
    proRateOnJoining: { column: 'ProRateOnJoining', type: sql.Bit },

    annualQuota: { column: 'AnnualQuota', type: sql.Decimal(5, 2), nullable: true },
    maxCarryForward: { column: 'MaxCarryForward', type: sql.Decimal(5, 2), nullable: true },

    allowHalfDay: { column: 'AllowHalfDay', type: sql.Bit },
    allowBackdated: { column: 'AllowBackdated', type: sql.Bit },
    minNoticeDays: { column: 'MinNoticeDays', type: sql.Int },
    requiresDocumentAfterDays: {
      column: 'RequiresDocumentAfterDays',
      type: sql.Int,
      nullable: true,
    },

    // NULL = this category has no sandwich behaviour at all.
    sandwichRuleId: { column: 'SandwichRuleId', type: sql.BigInt, nullable: true },

    // Comp-off expiry, in days. NULL until HR confirms one - section 28.
    validityDays: { column: 'ValidityDays', type: sql.Int, nullable: true },

    // Maternity and paternity go to HR as well as the manager.
    requiresSecondApproval: { column: 'RequiresSecondApproval', type: sql.Bit },

    ...effectiveColumns(),

    isActive: { column: 'IsActive', type: sql.Bit },

    ...auditColumns(),
  },
});

/**
 * dbo.tblEmployeeLeavePolicy - one person's exception to a policy.
 *
 * Not a second policy: it borrows the whole rulebook and replaces one or
 * two numbers, so a later change to the policy still reaches the people who
 * have an exception. `reason` is NOT NULL.
 */
export const EmployeeLeavePolicy = defineModel({
  table: 'dbo.tblEmployeeLeavePolicy',
  columns: {
    employeeLeavePolicyId: { column: 'EmployeeLeavePolicyId', type: sql.BigInt, identity: true },

    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },
    leavePolicyId: { column: 'LeavePolicyId', type: sql.BigInt },

    // NULL means "do not override this one".
    overrideAnnualQuota: { column: 'OverrideAnnualQuota', type: sql.Decimal(5, 2), nullable: true },
    overrideAccrualDays: { column: 'OverrideAccrualDays', type: sql.Decimal(5, 2), nullable: true },

    ...effectiveColumns(),

    reason: { column: 'Reason', type: sql.NVarChar(500) },
    isActive: { column: 'IsActive', type: sql.Bit },

    ...auditColumns(),
  },
});

/**
 * dbo.tblLeaveMapping - which categories a cohort is offered at all.
 *
 * A row is a GRANT. Distinct from tblLeavePolicy, which says how a category
 * behaves: mapping says whether it is on offer. Keeping them apart lets one
 * policy serve several mapped cohorts without copying its rules.
 */
export const LeaveMapping = defineModel({
  table: 'dbo.tblLeaveMapping',
  columns: {
    leaveMappingId: { column: 'LeaveMappingId', type: sql.BigInt, identity: true },

    leaveTypeId: { column: 'LeaveTypeId', type: sql.BigInt },

    // Every criterion NULLable; NULL means "do not filter on this".
    locationId: { column: 'LocationId', type: sql.BigInt, nullable: true },
    employmentType: { column: 'EmploymentType', type: sql.NVarChar(30), nullable: true },
    // Maternity and paternity are why this column exists.
    gender: { column: 'Gender', type: sql.NVarChar(30), nullable: true },
    minTenureMonths: { column: 'MinTenureMonths', type: sql.Int, nullable: true },

    availableDuringProbation: { column: 'AvailableDuringProbation', type: sql.Bit },
    isActive: { column: 'IsActive', type: sql.Bit },

    ...auditColumns(),
  },
});

/* ------------------------------------------------------------------------- */

export const LEAVE_CYCLE_PUBLIC_PROPS = Object.freeze([
  'leaveCycleId',
  'cycleType',
  'cycleLabel',
  'startDate',
  'endDate',
  'isClosed',
  'closedAt',
  'modifiedAt',
]);

export const SANDWICH_RULE_PUBLIC_PROPS = Object.freeze([
  'sandwichRuleId',
  'ruleName',
  'mode',
  'locationId',
  'includeHolidays',
  'description',
  'isActive',
  'modifiedAt',
]);

export const LEAVE_POLICY_PUBLIC_PROPS = Object.freeze([
  'leavePolicyId',
  'leaveTypeId',
  'locationId',
  'employmentType',
  'cycleType',
  'availableDuringProbation',
  'visibleDuringProbation',
  'isPaid',
  'tracksBalance',
  'accrualFrequency',
  'accrualDays',
  'accrualAnchor',
  'proRateOnJoining',
  'annualQuota',
  'maxCarryForward',
  'allowHalfDay',
  'allowBackdated',
  'minNoticeDays',
  'requiresDocumentAfterDays',
  'sandwichRuleId',
  'validityDays',
  'requiresSecondApproval',
  'effectiveFrom',
  'effectiveTo',
  'isActive',
  'modifiedAt',
]);

export const EMPLOYEE_LEAVE_POLICY_PUBLIC_PROPS = Object.freeze([
  'employeeLeavePolicyId',
  'employeeDetailId',
  'leavePolicyId',
  'overrideAnnualQuota',
  'overrideAccrualDays',
  'effectiveFrom',
  'effectiveTo',
  'reason',
  'isActive',
  'modifiedAt',
]);

export const LEAVE_MAPPING_PUBLIC_PROPS = Object.freeze([
  'leaveMappingId',
  'leaveTypeId',
  'locationId',
  'employmentType',
  'gender',
  'minTenureMonths',
  'availableDuringProbation',
  'isActive',
  'modifiedAt',
]);

/**
 * Seeds the configuration the attendance and leave module cannot run without.
 *
 *   npm run db:seed:attendance
 *
 * WHAT IS SEEDED HERE AND WHAT IS NOT.
 *
 * The migrations already created the rows that are part of the SCHEMA -
 * the nine attendance statuses, the two holiday types, four regularization
 * reasons - because foreign keys point at them and the tables are unusable
 * without them.
 *
 * This script creates the rows that are a CONFIGURATION: the two shifts
 * from the requirement list, this year's leave cycles, the three sandwich
 * rules, and a leave policy and mapping for each category in the HR
 * document. They are a starting point for HR to edit on the screens, not a
 * contract - which is exactly why they are here rather than in a migration.
 *
 * IDEMPOTENT. Every insert checks for an existing row first, so re-running
 * fills gaps and overwrites nothing. Once HR has edited a policy, running
 * this again leaves their edit alone.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *   - Grant any group a right. Rights are the administrator's to set on
 *     the Add/Edit Group screen, and a seeder that guessed them would
 *     quietly widen somebody's access on every deploy. The new modules are
 *     seeded into dbo.tblModule by the access seeder at startup; granting
 *     them is a decision.
 *   - Assign anybody to a shift. The location-wide fallback in
 *     shift.service.js means every employee resolves to the right shift
 *     from the moment it exists, and per-employee assignment stays the
 *     exception it should be.
 *   - Create holidays. The calendar is HR's, differs per country, and
 *     changes every year.
 *
 * THE LEAVE POLICIES BELOW ENCODE THE HR DOCUMENT. Where the document is
 * silent or the two source documents disagree - the EL accrual anchor,
 * comp-off validity - the value chosen here is the one that is safe to be
 * wrong about, and it is flagged in a comment. Section 28 of
 * docs/ATTENDANCE-LEAVE.html lists all of them.
 */
import { getPool, closePool } from '../src/config/db.js';
import { query, queryOne } from '../src/helpers/query.helper.js';
import {
  Shift,
  ShiftWeekOff,
  LeaveCycle,
  SandwichRule,
  LeavePolicy,
  LeaveMapping,
  LeaveType,
  AttendanceAlertSetting,
  RestrictedHolidayMapping,
} from '../src/models/index.js';
import {
  CYCLE_TYPE,
  POLICY_CYCLE_TYPE,
  ACCRUAL_FREQUENCY,
  ACCRUAL_ANCHOR,
  SANDWICH_MODE,
  DAY_OF_WEEK,
  ATTENDANCE_ALERT_TYPE,
} from '../src/enums/index.js';
import {
  today,
  toSqlTime,
  financialYearBounds,
  calendarYearBounds,
} from '../src/helpers/date.helper.js';
import { logger } from '../src/utils/logger.js';

/* -------------------------------------------------------------------------
   Shifts - the two from the requirement list
   ------------------------------------------------------------------------- */

const SHIFTS = [
  {
    shiftCode: 'GEN',
    shiftName: 'General (09:00 - 18:00)',
    startTime: '09:00:00',
    endTime: '18:00:00',
    breakMinutes: 60,
    fullDayMinutes: 480,
    halfDayMinutes: 240,
    // Saturday and Sunday off, every week. An organisation that works
    // alternate Saturdays edits this to two rows for weeks 2 and 4 - which
    // is what WeekOfMonth is for.
    weekOffs: [
      { dayOfWeek: DAY_OF_WEEK.SATURDAY, weekOfMonth: null },
      { dayOfWeek: DAY_OF_WEEK.SUNDAY, weekOfMonth: null },
    ],
  },
  {
    shiftCode: 'EVE',
    shiftName: 'Evening (15:00 - 00:00)',
    startTime: '15:00:00',
    // Ends at midnight: CrossesMidnight is derived from this, not supplied,
    // and the punch attaching rule in date.helper.js depends on it.
    endTime: '00:00:00',
    breakMinutes: 60,
    fullDayMinutes: 480,
    halfDayMinutes: 240,
    weekOffs: [
      { dayOfWeek: DAY_OF_WEEK.SATURDAY, weekOfMonth: null },
      { dayOfWeek: DAY_OF_WEEK.SUNDAY, weekOfMonth: null },
    ],
  },
];

async function seedShifts() {
  let created = 0;

  for (const shift of SHIFTS) {
    const existing = await queryOne(
      `SELECT TOP (1) ShiftId AS shiftId FROM ${Shift.table}
        WHERE ShiftCode = @shiftCode AND DeletedAt IS NULL`,
      Shift.params({ shiftCode: shift.shiftCode }),
    );
    if (existing) continue;

    const row = await queryOne(
      `INSERT INTO ${Shift.table}
              (ShiftCode, ShiftName, LocationId, StartTime, EndTime, CrossesMidnight,
               BreakMinutes, FullDayMinutes, HalfDayMinutes, EffectiveFrom)
       OUTPUT inserted.ShiftId AS shiftId
       VALUES (@shiftCode, @shiftName, NULL, @startTime, @endTime, @crossesMidnight,
               @breakMinutes, @fullDayMinutes, @halfDayMinutes, @effectiveFrom)`,
      Shift.params({
        shiftCode: shift.shiftCode,
        shiftName: shift.shiftName,
        // The driver wants a Date for a TIME column; the flag is derived
        // from the strings, which compare correctly as "HH:mm:ss".
        startTime: toSqlTime(shift.startTime),
        endTime: toSqlTime(shift.endTime),
        crossesMidnight: shift.endTime <= shift.startTime,
        breakMinutes: shift.breakMinutes,
        fullDayMinutes: shift.fullDayMinutes,
        halfDayMinutes: shift.halfDayMinutes,
        // Dated from the start of the current financial year rather than
        // today, so attendance can be closed for days already past.
        effectiveFrom: financialYearBounds(today()).startDate,
      }),
    );

    for (const weekOff of shift.weekOffs) {
      await queryOne(
        `INSERT INTO ${ShiftWeekOff.table} (ShiftId, DayOfWeek, WeekOfMonth)
         OUTPUT inserted.ShiftWeekOffId AS id
         VALUES (@shiftId, @dayOfWeek, @weekOfMonth)`,
        ShiftWeekOff.params({
          shiftId: row.shiftId,
          dayOfWeek: weekOff.dayOfWeek,
          weekOfMonth: weekOff.weekOfMonth,
        }),
      );
    }

    created += 1;
  }

  logger.info(`  shifts: ${created} created, ${SHIFTS.length - created} already on file`);
}

/* -------------------------------------------------------------------------
   Leave cycles - this year and next, of both kinds
   ------------------------------------------------------------------------- */

async function seedCycles() {
  const wanted = [];

  // This financial year and the next, so an application in March for April
  // has a cycle to land in rather than failing with LEAVE_CYCLE_MISSING.
  const fyNow = financialYearBounds(today());
  const fyNext = financialYearBounds(`${Number(fyNow.startDate.slice(0, 4)) + 1}-04-01`);
  wanted.push({ cycleType: CYCLE_TYPE.FINANCIAL, ...fyNow });
  wanted.push({ cycleType: CYCLE_TYPE.FINANCIAL, ...fyNext });

  // The same for the calendar year, which the floating holiday runs on.
  const cyNow = calendarYearBounds(today());
  const cyNext = calendarYearBounds(`${Number(cyNow.startDate.slice(0, 4)) + 1}-01-01`);
  wanted.push({ cycleType: CYCLE_TYPE.CALENDAR, ...cyNow });
  wanted.push({ cycleType: CYCLE_TYPE.CALENDAR, ...cyNext });

  let created = 0;

  for (const cycle of wanted) {
    const existing = await queryOne(
      `SELECT TOP (1) LeaveCycleId AS leaveCycleId FROM ${LeaveCycle.table}
        WHERE CycleType = @cycleType AND StartDate = @startDate AND DeletedAt IS NULL`,
      LeaveCycle.params({ cycleType: cycle.cycleType, startDate: cycle.startDate }),
    );
    if (existing) continue;

    await queryOne(
      `INSERT INTO ${LeaveCycle.table} (CycleType, CycleLabel, StartDate, EndDate)
       OUTPUT inserted.LeaveCycleId AS id
       VALUES (@cycleType, @cycleLabel, @startDate, @endDate)`,
      LeaveCycle.params({
        cycleType: cycle.cycleType,
        cycleLabel: cycle.label,
        startDate: cycle.startDate,
        endDate: cycle.endDate,
      }),
    );
    created += 1;
  }

  logger.info(`  leave cycles: ${created} created, ${wanted.length - created} already on file`);
}

/* -------------------------------------------------------------------------
   Sandwich rules - all three modes, so HR can choose on the policy screen
   ------------------------------------------------------------------------- */

const SANDWICH_RULES = [
  {
    ruleName: 'Weekend not charged',
    mode: SANDWICH_MODE.IGNORE_WEEKOFF,
    description:
      'Only working days are charged. Friday and Monday off costs 2 days.',
  },
  {
    ruleName: 'Charged when absent both sides',
    mode: SANDWICH_MODE.COUNT_WHEN_BOTH_FLANKS,
    description:
      'A week off is charged when the employee is also absent before and after it. ' +
      'Friday and Monday off costs 4 days; Friday alone still costs 1.',
  },
  {
    ruleName: 'Every day charged',
    mode: SANDWICH_MODE.COUNT_ALWAYS,
    description: 'Every day inside the range is charged, whichever side it falls.',
  },
];

async function seedSandwichRules() {
  let created = 0;

  for (const rule of SANDWICH_RULES) {
    const existing = await queryOne(
      `SELECT TOP (1) SandwichRuleId AS id FROM ${SandwichRule.table}
        WHERE RuleName = @ruleName AND DeletedAt IS NULL`,
      SandwichRule.params({ ruleName: rule.ruleName }),
    );
    if (existing) continue;

    await queryOne(
      `INSERT INTO ${SandwichRule.table} (RuleName, Mode, Description)
       OUTPUT inserted.SandwichRuleId AS id
       VALUES (@ruleName, @mode, @description)`,
      SandwichRule.params({
        ruleName: rule.ruleName,
        mode: rule.mode,
        description: rule.description,
      }),
    );
    created += 1;
  }

  logger.info(
    `  sandwich rules: ${created} created, ${SANDWICH_RULES.length - created} already on file`,
  );
}

/* -------------------------------------------------------------------------
   Leave policies and mappings
   ------------------------------------------------------------------------- */

/**
 * The categories from the HR document, matched to the leave types already
 * seeded by db:seed:masterdata.
 *
 * `leaveTypeName` must match a row in tblLeaveType exactly. A category
 * whose type is not on file is SKIPPED with a warning rather than created:
 * tblLeaveType is master data that HR maintains, and a seeder that invented
 * rows in it would put a name nobody chose on the apply screen.
 */
const POLICIES = [
  {
    leaveTypeName: 'Casual & Sick Leave',
    note: 'CL and SL are ONE balance - the HR document treats them as a single category.',
    cycleType: POLICY_CYCLE_TYPE.FINANCIAL,
    // The HR document: 1 day a month during probation, and it continues
    // after confirmation. Available and visible throughout.
    availableDuringProbation: true,
    visibleDuringProbation: true,
    isPaid: true,
    tracksBalance: true,
    accrualFrequency: ACCRUAL_FREQUENCY.MONTHLY,
    accrualDays: 1,
    accrualAnchor: ACCRUAL_ANCHOR.MONTH_START,
    annualQuota: 12,
    allowHalfDay: true,
    sandwichRuleName: 'Weekend not charged',
    mapping: { availableDuringProbation: true },
  },
  {
    leaveTypeName: 'Earned Leave',
    note: 'Does not accrue during probation - the HR document is explicit.',
    cycleType: POLICY_CYCLE_TYPE.FINANCIAL,
    availableDuringProbation: false,
    // Visible at zero with a reason, which is what the HR document's
    // probation dashboard shows. Not the same question as availability.
    visibleDuringProbation: true,
    isPaid: true,
    tracksBalance: true,
    accrualFrequency: ACCRUAL_FREQUENCY.MONTHLY,
    accrualDays: 1,
    /*
      THE OPEN QUESTION OF SECTION 28. The original requirement list says
      the 1st of the month; the HR document says from the probation end
      date; HR's own question asks whether it is that date or the month
      after. PROBATION_END is seeded because it is the HR document's
      reading and the HR document is the newer source - and because it is
      one UPDATE to change once HR answers.
    */
    accrualAnchor: ACCRUAL_ANCHOR.PROBATION_END,
    annualQuota: 12,
    allowHalfDay: true,
    sandwichRuleName: 'Charged when absent both sides',
    mapping: { availableDuringProbation: false },
  },
  {
    leaveTypeName: 'Leave Without Pay',
    note: 'No balance, never deducted from paid leave. The two flags below are the rule.',
    cycleType: POLICY_CYCLE_TYPE.NONE,
    availableDuringProbation: true,
    visibleDuringProbation: true,
    isPaid: false,
    // The HR document's prohibition, as data: a category that tracks no
    // balance can have nothing deducted from it.
    tracksBalance: false,
    accrualFrequency: ACCRUAL_FREQUENCY.NONE,
    accrualDays: 0,
    accrualAnchor: ACCRUAL_ANCHOR.MONTH_START,
    annualQuota: null,
    allowHalfDay: true,
    sandwichRuleName: null,
    mapping: { availableDuringProbation: true },
  },
  {
    leaveTypeName: 'Comp Off- IN',
    note: 'Days arrive only by an HR credit - never accrued, never automatic.',
    cycleType: POLICY_CYCLE_TYPE.NONE,
    availableDuringProbation: true,
    visibleDuringProbation: true,
    isPaid: true,
    tracksBalance: true,
    accrualFrequency: ACCRUAL_FREQUENCY.NONE,
    accrualDays: 0,
    accrualAnchor: ACCRUAL_ANCHOR.MONTH_START,
    annualQuota: null,
    allowHalfDay: true,
    /*
      ValidityDays is left NULL on purpose - one of the open questions in
      section 28. NULL means the credit does not lapse, which is the safe
      reading of silence: the opposite default would start quietly
      destroying days nobody agreed to destroy.
    */
    validityDays: null,
    sandwichRuleName: null,
    mapping: { availableDuringProbation: true },
  },
  {
    leaveTypeName: 'Sabbatical Leave',
    note:
      'ABSENT FROM THE HR DOCUMENT. Carried forward from the earlier requirement list ' +
      'and flagged in section 28 - it accrues nothing and is granted by hand.',
    cycleType: POLICY_CYCLE_TYPE.FINANCIAL,
    availableDuringProbation: false,
    visibleDuringProbation: false,
    isPaid: true,
    tracksBalance: true,
    accrualFrequency: ACCRUAL_FREQUENCY.NONE,
    accrualDays: 0,
    accrualAnchor: ACCRUAL_ANCHOR.MONTH_START,
    annualQuota: null,
    allowHalfDay: false,
    requiresSecondApproval: true,
    sandwichRuleName: 'Every day charged',
    mapping: { availableDuringProbation: false, minTenureMonths: 36 },
  },
  {
    leaveTypeName: 'Paternity Leave - India',
    note: 'Needs HR as well as the manager, and a tenure floor on the mapping.',
    cycleType: POLICY_CYCLE_TYPE.FINANCIAL,
    availableDuringProbation: false,
    visibleDuringProbation: false,
    isPaid: true,
    tracksBalance: true,
    accrualFrequency: ACCRUAL_FREQUENCY.NONE,
    accrualDays: 0,
    accrualAnchor: ACCRUAL_ANCHOR.MONTH_START,
    annualQuota: null,
    allowHalfDay: false,
    requiresSecondApproval: true,
    sandwichRuleName: 'Every day charged',
    mapping: { availableDuringProbation: false, gender: 'Male', minTenureMonths: 12 },
  },
];

async function seedPolicies() {
  const effectiveFrom = financialYearBounds(today()).startDate;

  const sandwichRules = await query(
    `SELECT SandwichRuleId AS sandwichRuleId, RuleName AS ruleName
       FROM ${SandwichRule.table} WHERE DeletedAt IS NULL`,
  );
  const ruleIdByName = new Map(sandwichRules.map((r) => [r.ruleName, Number(r.sandwichRuleId)]));

  let created = 0;
  let skipped = 0;
  let mapped = 0;

  for (const policy of POLICIES) {
    const leaveType = await queryOne(
      `SELECT TOP (1) LeaveTypeId AS leaveTypeId FROM ${LeaveType.table}
        WHERE Name = @name AND DeletedAt IS NULL`,
      LeaveType.params({ name: policy.leaveTypeName }),
    );

    if (!leaveType) {
      // See the note above POLICIES: tblLeaveType is HR's, not this script's.
      logger.warn(
        `  ! leave type "${policy.leaveTypeName}" is not on file - ` +
          'run npm run db:seed:masterdata first, or create it on the Leave Types screen',
      );
      skipped += 1;
      continue;
    }

    const leaveTypeId = Number(leaveType.leaveTypeId);

    const existing = await queryOne(
      `SELECT TOP (1) LeavePolicyId AS id FROM ${LeavePolicy.table}
        WHERE LeaveTypeId = @leaveTypeId AND LocationId IS NULL
          AND EmploymentType IS NULL AND DeletedAt IS NULL`,
      LeavePolicy.params({ leaveTypeId }),
    );

    if (!existing) {
      await queryOne(
        `INSERT INTO ${LeavePolicy.table}
                (LeaveTypeId, CycleType, AvailableDuringProbation, VisibleDuringProbation,
                 IsPaid, TracksBalance, AccrualFrequency, AccrualDays, AccrualAnchor,
                 AnnualQuota, AllowHalfDay, SandwichRuleId, ValidityDays,
                 RequiresSecondApproval, EffectiveFrom)
         OUTPUT inserted.LeavePolicyId AS id
         VALUES (@leaveTypeId, @cycleType, @availableDuringProbation, @visibleDuringProbation,
                 @isPaid, @tracksBalance, @accrualFrequency, @accrualDays, @accrualAnchor,
                 @annualQuota, @allowHalfDay, @sandwichRuleId, @validityDays,
                 @requiresSecondApproval, @effectiveFrom)`,
        LeavePolicy.params({
          leaveTypeId,
          cycleType: policy.cycleType,
          availableDuringProbation: policy.availableDuringProbation,
          visibleDuringProbation: policy.visibleDuringProbation,
          isPaid: policy.isPaid,
          tracksBalance: policy.tracksBalance,
          accrualFrequency: policy.accrualFrequency,
          accrualDays: policy.accrualDays,
          accrualAnchor: policy.accrualAnchor,
          annualQuota: policy.annualQuota ?? null,
          allowHalfDay: policy.allowHalfDay,
          sandwichRuleId: policy.sandwichRuleName
            ? (ruleIdByName.get(policy.sandwichRuleName) ?? null)
            : null,
          validityDays: policy.validityDays ?? null,
          requiresSecondApproval: policy.requiresSecondApproval ?? false,
          effectiveFrom,
        }),
      );
      created += 1;
    }

    /*
      The mapping - which cohort is offered this category at all. Both NULL
      on location and employment type means everybody; gender and tenure
      are set only where the category genuinely needs them.
    */
    const existingMapping = await queryOne(
      `SELECT TOP (1) LeaveMappingId AS id FROM ${LeaveMapping.table}
        WHERE LeaveTypeId = @leaveTypeId AND LocationId IS NULL
          AND EmploymentType IS NULL AND DeletedAt IS NULL
          AND (Gender = @gender OR (Gender IS NULL AND @gender IS NULL))`,
      {
        ...LeaveMapping.params({ leaveTypeId }),
        gender: LeaveMapping.param('gender', policy.mapping.gender ?? null),
      },
    );

    if (!existingMapping) {
      await queryOne(
        `INSERT INTO ${LeaveMapping.table}
                (LeaveTypeId, Gender, MinTenureMonths, AvailableDuringProbation)
         OUTPUT inserted.LeaveMappingId AS id
         VALUES (@leaveTypeId, @gender, @minTenureMonths, @availableDuringProbation)`,
        LeaveMapping.params({
          leaveTypeId,
          gender: policy.mapping.gender ?? null,
          minTenureMonths: policy.mapping.minTenureMonths ?? null,
          availableDuringProbation: policy.mapping.availableDuringProbation,
        }),
      );
      mapped += 1;
    }
  }

  logger.info(
    `  leave policies: ${created} created, ${mapped} mapping(s) created` +
      (skipped > 0 ? `, ${skipped} skipped (leave type missing)` : ''),
  );
}

/* -------------------------------------------------------------------------
   Restricted-holiday mapping - one pick per employee per calendar year
   ------------------------------------------------------------------------- */

async function seedRestrictedMapping() {
  const cycle = await queryOne(
    `SELECT TOP (1) LeaveCycleId AS leaveCycleId FROM ${LeaveCycle.table}
      WHERE CycleType = @cycleType AND @today BETWEEN StartDate AND EndDate
        AND DeletedAt IS NULL`,
    {
      ...LeaveCycle.params({ cycleType: CYCLE_TYPE.CALENDAR }),
      today: LeaveCycle.param('startDate', today()),
    },
  );

  if (!cycle) {
    logger.warn('  ! no calendar cycle covers today - restricted-holiday mapping skipped');
    return;
  }

  const existing = await queryOne(
    `SELECT TOP (1) RestrictedHolidayMappingId AS id FROM ${RestrictedHolidayMapping.table}
      WHERE LeaveCycleId = @leaveCycleId AND LocationId IS NULL
        AND EmploymentType IS NULL AND DeletedAt IS NULL`,
    RestrictedHolidayMapping.params({ leaveCycleId: cycle.leaveCycleId }),
  );

  if (existing) {
    logger.info('  restricted-holiday mapping: already on file');
    return;
  }

  await queryOne(
    `INSERT INTO ${RestrictedHolidayMapping.table} (LeaveCycleId, PickQuota)
     OUTPUT inserted.RestrictedHolidayMappingId AS id
     VALUES (@leaveCycleId, @pickQuota)`,
    RestrictedHolidayMapping.params({ leaveCycleId: cycle.leaveCycleId, pickQuota: 1 }),
  );

  logger.info('  restricted-holiday mapping: created (1 pick per employee per calendar year)');
}

/* -------------------------------------------------------------------------
   Alert settings - the "every 10 minutes for 2 hours" rule
   ------------------------------------------------------------------------- */

async function seedAlertSettings() {
  const existing = await queryOne(
    `SELECT TOP (1) AttendanceAlertSettingId AS id FROM ${AttendanceAlertSetting.table}
      WHERE LocationId IS NULL AND AlertType = @alertType AND DeletedAt IS NULL`,
    AttendanceAlertSetting.params({ alertType: ATTENDANCE_ALERT_TYPE.MISSED_CHECK_IN }),
  );

  if (existing) {
    logger.info('  alert settings: already on file');
    return;
  }

  await queryOne(
    `INSERT INTO ${AttendanceAlertSetting.table}
            (LocationId, AlertType, DelayMinutes, IntervalMinutes, WindowMinutes,
             SkipWhenOnLeave, SkipOnHoliday, SkipWhenExempt, NotifyManagerAfter)
     OUTPUT inserted.AttendanceAlertSettingId AS id
     VALUES (NULL, @alertType, @delayMinutes, @intervalMinutes, @windowMinutes,
             1, 1, 1, @notifyManagerAfter)`,
    AttendanceAlertSetting.params({
      alertType: ATTENDANCE_ALERT_TYPE.MISSED_CHECK_IN,
      // The requirement exactly: 9 minutes after the shift starts, then
      // every 10 minutes for 2 hours.
      delayMinutes: 9,
      intervalMinutes: 10,
      windowMinutes: 120,
      // Copy the manager after six unanswered reminders - an hour in.
      notifyManagerAfter: 6,
    }),
  );

  logger.info('  alert settings: created (9 min delay, every 10 min, 2 hour window)');
}

/* ------------------------------------------------------------------------- */

async function run() {
  await getPool();

  logger.info('Seeding attendance and leave configuration');
  await seedShifts();
  await seedCycles();
  await seedSandwichRules();
  await seedPolicies();
  await seedRestrictedMapping();
  await seedAlertSettings();

  logger.info('');
  logger.info('Done. Next steps, which this script deliberately does not do:');
  logger.info('  1. Grant the new modules to groups on /administration/groups');
  logger.info('  2. Add this year’s holidays per location on /attendance/holidays');
  logger.info('  3. Review the leave policies on /leave/policy - the EL accrual anchor');
  logger.info('     and the comp-off validity period are the two open questions');

  await closePool();
}

run().catch(async (error) => {
  logger.error('Seeding attendance and leave failed', error);
  await closePool();
  process.exit(1);
});

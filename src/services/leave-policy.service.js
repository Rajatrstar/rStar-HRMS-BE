/**
 * The leave rulebook: policies, sandwich rules, per-employee overrides and
 * mapping.
 *
 * TWO QUESTIONS, AND KEEPING THEM APART IS THE WHOLE DESIGN:
 *
 *   MAPPING  - is this category offered to this person at all?
 *              (tblLeaveMapping: location, employment type, gender, tenure)
 *   POLICY   - if it is, how does it behave?
 *              (tblLeavePolicy: accrual, quota, half days, sandwich, approvals)
 *
 * Maternity leave mapped to female employees in India with twelve months'
 * tenure is a MAPPING. That it accrues nothing, allows no half day and needs
 * HR's signature as well as the manager's is a POLICY. One policy can serve
 * several mapped cohorts, which is why they are not one table.
 *
 * resolveForEmployee() is what every other caller actually wants: it answers
 * both questions at once and applies any per-employee override, returning
 * the EFFECTIVE rules for one person on one date. The dashboard, the apply
 * screen, the charge calculation and the accrual job all start there, so
 * there is one place where "what applies to this person" is decided.
 */
import { query, queryOne, mutate } from '../helpers/query.helper.js';
import {
  LeavePolicy,
  LeaveMapping,
  SandwichRule,
  EmployeeLeavePolicy,
  LeaveType,
  EmployeeDetails,
  LEAVE_POLICY_PUBLIC_PROPS,
  LEAVE_MAPPING_PUBLIC_PROPS,
  SANDWICH_RULE_PUBLIC_PROPS,
  EMPLOYEE_LEAVE_POLICY_PUBLIC_PROPS,
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { MESSAGES, ERROR_CODE, CONFIRMATION_STATUS } from '../enums/index.js';
import { today, monthsBetween, dateOf } from '../helpers/date.helper.js';

const POLICY_COLUMNS = LeavePolicy.select(LEAVE_POLICY_PUBLIC_PROPS);
const OUTPUT_POLICY = LEAVE_POLICY_PUBLIC_PROPS.map(
  (p) => `inserted.${LeavePolicy.col(p)} AS ${p}`,
).join(', ');

const ID_PROPS = Object.freeze([
  'leavePolicyId',
  'leaveTypeId',
  'locationId',
  'sandwichRuleId',
  'leaveMappingId',
  'employeeLeavePolicyId',
  'employeeDetailId',
]);

function shape(row) {
  if (!row) return row;

  const copy = { ...row };
  for (const prop of ID_PROPS) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  /*
    DECIMAL comes back from the driver as a NUMBER for the precisions used
    here, but a string on some driver versions. Normalised so arithmetic in
    the charge calculation cannot silently concatenate: "1" + 0.5 is "10.5",
    which would be a balance bug nobody would ever guess at.
  */
  for (const prop of ['accrualDays', 'annualQuota', 'maxCarryForward']) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  for (const prop of ['effectiveFrom', 'effectiveTo']) {
    if (copy[prop]) copy[prop] = dateOf(copy[prop]);
  }
  return copy;
}

const shapeAll = (rows) => rows.map(shape);
const uniqueViolation = (error) => error?.number === 2601 || error?.number === 2627;

/* -------------------------------------------------------------------------
   Sandwich rules
   ------------------------------------------------------------------------- */

export async function listSandwichRules() {
  return shapeAll(
    await query(
      `SELECT ${SandwichRule.select(SANDWICH_RULE_PUBLIC_PROPS)} FROM ${SandwichRule.table}
        WHERE DeletedAt IS NULL ORDER BY RuleName`,
    ),
  );
}

export async function createSandwichRule(actorId, input) {
  try {
    const row = await queryOne(
      `INSERT INTO ${SandwichRule.table}
              (RuleName, Mode, LocationId, IncludeHolidays, Description, CreatedBy, ModifiedBy)
       OUTPUT ${SANDWICH_RULE_PUBLIC_PROPS.map((p) => `inserted.${SandwichRule.col(p)} AS ${p}`).join(', ')}
       VALUES (@ruleName, @mode, @locationId, @includeHolidays, @description, @actorId, @actorId)`,
      {
        ...SandwichRule.params({
          ruleName: input.ruleName,
          mode: input.mode,
          locationId: input.locationId ?? null,
          includeHolidays: input.includeHolidays ?? false,
          description: input.description ?? null,
        }),
        actorId: SandwichRule.param('createdBy', actorId),
      },
    );
    return shape(row);
  } catch (error) {
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.SANDWICH_RULE_NAME_EXISTS, {
        code: ERROR_CODE.NAME_ALREADY_EXISTS,
      });
    }
    throw error;
  }
}

export async function updateSandwichRule(actorId, sandwichRuleId, input) {
  const row = await queryOne(
    `UPDATE ${SandwichRule.table}
        SET RuleName        = COALESCE(@ruleName, RuleName),
            Mode            = COALESCE(@mode, Mode),
            IncludeHolidays = COALESCE(@includeHolidays, IncludeHolidays),
            Description     = @description,
            IsActive        = COALESCE(@isActive, IsActive),
            ModifiedBy      = @actorId,
            ModifiedAt      = SYSUTCDATETIME()
      OUTPUT ${SANDWICH_RULE_PUBLIC_PROPS.map((p) => `inserted.${SandwichRule.col(p)} AS ${p}`).join(', ')}
      WHERE SandwichRuleId = @sandwichRuleId AND DeletedAt IS NULL`,
    {
      ...SandwichRule.params({
        sandwichRuleId,
        ruleName: input.ruleName ?? null,
        mode: input.mode ?? null,
        includeHolidays: input.includeHolidays ?? null,
        description: input.description ?? null,
        isActive: input.isActive ?? null,
      }),
      actorId: SandwichRule.param('modifiedBy', actorId),
    },
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.SANDWICH_RULE_NOT_FOUND, {
      code: ERROR_CODE.SANDWICH_RULE_NOT_FOUND,
    });
  }
  return shape(row);
}

/** Refused while a policy still points at it - the FK would refuse anyway. */
export async function deleteSandwichRule(actorId, sandwichRuleId) {
  const inUse = await queryOne(
    `SELECT TOP (1) LeavePolicyId AS leavePolicyId FROM ${LeavePolicy.table}
      WHERE SandwichRuleId = @sandwichRuleId AND DeletedAt IS NULL`,
    LeavePolicy.params({ sandwichRuleId }),
  );
  if (inUse) {
    throw ApiError.conflict(MESSAGES.SANDWICH_RULE_IN_USE, {
      code: ERROR_CODE.SANDWICH_RULE_IN_USE,
    });
  }

  const rows = await mutate(
    `UPDATE ${SandwichRule.table}
        SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
      WHERE SandwichRuleId = @sandwichRuleId AND DeletedAt IS NULL`,
    {
      ...SandwichRule.params({ sandwichRuleId }),
      actorId: SandwichRule.param('modifiedBy', actorId),
    },
  );
  if (rows === 0) {
    throw ApiError.notFound(MESSAGES.SANDWICH_RULE_NOT_FOUND, {
      code: ERROR_CODE.SANDWICH_RULE_NOT_FOUND,
    });
  }
  return { sandwichRuleId: Number(sandwichRuleId) };
}

/* -------------------------------------------------------------------------
   Policies
   ------------------------------------------------------------------------- */

export async function listPolicies({ leaveTypeId = null, onDate = null } = {}) {
  return shapeAll(
    await query(
      `SELECT ${LEAVE_POLICY_PUBLIC_PROPS.map((p) => `p.${LeavePolicy.col(p)} AS ${p}`).join(', ')},
              lt.Name AS leaveTypeName
         FROM ${LeavePolicy.table} AS p
         JOIN ${LeaveType.table}   AS lt ON lt.LeaveTypeId = p.LeaveTypeId
        WHERE p.DeletedAt IS NULL
          AND (@leaveTypeId IS NULL OR p.LeaveTypeId = @leaveTypeId)
          AND (@onDate IS NULL
               OR (p.EffectiveFrom <= @onDate AND (p.EffectiveTo IS NULL OR p.EffectiveTo >= @onDate)))
        ORDER BY lt.Name, p.EffectiveFrom DESC`,
      {
        ...LeavePolicy.params({ leaveTypeId }),
        onDate: LeavePolicy.param('effectiveFrom', onDate),
      },
    ),
  );
}

export async function getPolicy(leavePolicyId) {
  const row = shape(
    await queryOne(
      `SELECT ${POLICY_COLUMNS} FROM ${LeavePolicy.table}
        WHERE LeavePolicyId = @leavePolicyId AND DeletedAt IS NULL`,
      LeavePolicy.params({ leavePolicyId }),
    ),
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.LEAVE_POLICY_NOT_FOUND, {
      code: ERROR_CODE.LEAVE_POLICY_NOT_FOUND,
    });
  }
  return row;
}

/** The full column list, shared by create and update. */
const POLICY_FIELDS = Object.freeze([
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
]);

export async function createPolicy(actorId, input) {
  /*
    ONLY THE COLUMNS THE CALLER ACTUALLY SUPPLIED.

    Listing every field and passing NULL for the omitted ones would be
    wrong, not merely wasteful: an explicit NULL OVERRIDES a column's
    DEFAULT, so the NOT NULL columns that carry one - ProRateOnJoining,
    AllowBackdated, IsPaid, TracksBalance and the rest - would reject the
    insert outright rather than taking the default the migration gave them.

    The nullable columns are unaffected either way, so omitting them here
    and letting the database fill the rest is both correct and the only
    thing that makes a minimal create body work.
  */
  const supplied = POLICY_FIELDS.filter((field) => input[field] !== undefined && input[field] !== null);

  // The one field that is always written: a policy with no start date has
  // no point in time at which it applies.
  const values = Object.fromEntries(supplied.map((field) => [field, input[field]]));
  values.effectiveFrom = input.effectiveFrom ?? today();

  const columns = [...new Set([...supplied, 'effectiveFrom'])];

  try {
    const row = await queryOne(
      `INSERT INTO ${LeavePolicy.table}
              (${columns.map((f) => LeavePolicy.col(f)).join(', ')}, CreatedBy, ModifiedBy)
       OUTPUT ${OUTPUT_POLICY}
       VALUES (${columns.map((f) => `@${f}`).join(', ')}, @actorId, @actorId)`,
      {
        ...LeavePolicy.params(values),
        actorId: LeavePolicy.param('createdBy', actorId),
      },
    );
    return shape(row);
  } catch (error) {
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.LEAVE_POLICY_EXISTS, {
        code: ERROR_CODE.LEAVE_POLICY_EXISTS,
      });
    }
    throw error;
  }
}

/**
 * Edit a policy.
 *
 * As with shifts: correcting a mistake is an edit, CHANGING THE RULES is a
 * new effective-dated row. Nothing here enforces that - a policy created
 * this morning with the wrong accrual must still be fixable - but the
 * create form defaults EffectiveFrom to today so the new-row path is the
 * one of least resistance.
 */
export async function updatePolicy(actorId, leavePolicyId, input) {
  const existing = await getPolicy(leavePolicyId);

  const values = Object.fromEntries(
    POLICY_FIELDS.map((field) => [field, input[field] === undefined ? existing[field] : input[field]]),
  );

  try {
    const row = await queryOne(
      `UPDATE ${LeavePolicy.table}
          SET ${POLICY_FIELDS.map((f) => `${LeavePolicy.col(f)} = @${f}`).join(',\n              ')},
              IsActive   = @isActive,
              ModifiedBy = @actorId,
              ModifiedAt = SYSUTCDATETIME()
        OUTPUT ${OUTPUT_POLICY}
        WHERE LeavePolicyId = @leavePolicyId AND DeletedAt IS NULL`,
      {
        ...LeavePolicy.params({
          ...values,
          leavePolicyId,
          isActive: input.isActive ?? existing.isActive,
        }),
        actorId: LeavePolicy.param('modifiedBy', actorId),
      },
    );
    return shape(row);
  } catch (error) {
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.LEAVE_POLICY_EXISTS, {
        code: ERROR_CODE.LEAVE_POLICY_EXISTS,
      });
    }
    throw error;
  }
}

export async function deletePolicy(actorId, leavePolicyId) {
  const rows = await mutate(
    `UPDATE ${LeavePolicy.table}
        SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
      WHERE LeavePolicyId = @leavePolicyId AND DeletedAt IS NULL`,
    {
      ...LeavePolicy.params({ leavePolicyId }),
      actorId: LeavePolicy.param('modifiedBy', actorId),
    },
  );
  if (rows === 0) {
    throw ApiError.notFound(MESSAGES.LEAVE_POLICY_NOT_FOUND, {
      code: ERROR_CODE.LEAVE_POLICY_NOT_FOUND,
    });
  }
  return { leavePolicyId: Number(leavePolicyId) };
}

/* -------------------------------------------------------------------------
   Mapping
   ------------------------------------------------------------------------- */

export async function listMappings({ leaveTypeId = null } = {}) {
  return shapeAll(
    await query(
      `SELECT ${LEAVE_MAPPING_PUBLIC_PROPS.map((p) => `m.${LeaveMapping.col(p)} AS ${p}`).join(', ')},
              lt.Name AS leaveTypeName
         FROM ${LeaveMapping.table} AS m
         JOIN ${LeaveType.table}    AS lt ON lt.LeaveTypeId = m.LeaveTypeId
        WHERE m.DeletedAt IS NULL AND (@leaveTypeId IS NULL OR m.LeaveTypeId = @leaveTypeId)
        ORDER BY lt.Name`,
      LeaveMapping.params({ leaveTypeId }),
    ),
  );
}

export async function createMapping(actorId, input) {
  try {
    const row = await queryOne(
      `INSERT INTO ${LeaveMapping.table}
              (LeaveTypeId, LocationId, EmploymentType, Gender, MinTenureMonths,
               AvailableDuringProbation, CreatedBy, ModifiedBy)
       OUTPUT ${LEAVE_MAPPING_PUBLIC_PROPS.map((p) => `inserted.${LeaveMapping.col(p)} AS ${p}`).join(', ')}
       VALUES (@leaveTypeId, @locationId, @employmentType, @gender, @minTenureMonths,
               @availableDuringProbation, @actorId, @actorId)`,
      {
        ...LeaveMapping.params({
          leaveTypeId: input.leaveTypeId,
          locationId: input.locationId ?? null,
          employmentType: input.employmentType ?? null,
          gender: input.gender ?? null,
          minTenureMonths: input.minTenureMonths ?? null,
          availableDuringProbation: input.availableDuringProbation ?? false,
        }),
        actorId: LeaveMapping.param('createdBy', actorId),
      },
    );
    return shape(row);
  } catch (error) {
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.LEAVE_MAPPING_EXISTS, {
        code: ERROR_CODE.LEAVE_MAPPING_EXISTS,
      });
    }
    throw error;
  }
}

export async function updateMapping(actorId, leaveMappingId, input) {
  const row = await queryOne(
    `UPDATE ${LeaveMapping.table}
        SET MinTenureMonths          = @minTenureMonths,
            AvailableDuringProbation = COALESCE(@availableDuringProbation, AvailableDuringProbation),
            IsActive                 = COALESCE(@isActive, IsActive),
            ModifiedBy               = @actorId,
            ModifiedAt               = SYSUTCDATETIME()
      OUTPUT ${LEAVE_MAPPING_PUBLIC_PROPS.map((p) => `inserted.${LeaveMapping.col(p)} AS ${p}`).join(', ')}
      WHERE LeaveMappingId = @leaveMappingId AND DeletedAt IS NULL`,
    {
      ...LeaveMapping.params({
        leaveMappingId,
        minTenureMonths: input.minTenureMonths ?? null,
        availableDuringProbation: input.availableDuringProbation ?? null,
        isActive: input.isActive ?? null,
      }),
      actorId: LeaveMapping.param('modifiedBy', actorId),
    },
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.LEAVE_MAPPING_NOT_FOUND, {
      code: ERROR_CODE.LEAVE_MAPPING_NOT_FOUND,
    });
  }
  return shape(row);
}

export async function deleteMapping(actorId, leaveMappingId) {
  const rows = await mutate(
    `UPDATE ${LeaveMapping.table}
        SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
      WHERE LeaveMappingId = @leaveMappingId AND DeletedAt IS NULL`,
    {
      ...LeaveMapping.params({ leaveMappingId }),
      actorId: LeaveMapping.param('modifiedBy', actorId),
    },
  );
  if (rows === 0) {
    throw ApiError.notFound(MESSAGES.LEAVE_MAPPING_NOT_FOUND, {
      code: ERROR_CODE.LEAVE_MAPPING_NOT_FOUND,
    });
  }
  return { leaveMappingId: Number(leaveMappingId) };
}

/* -------------------------------------------------------------------------
   Per-employee overrides
   ------------------------------------------------------------------------- */

export async function listOverrides({ employeeDetailId = null } = {}) {
  return shapeAll(
    await query(
      `SELECT ${EmployeeLeavePolicy.select(EMPLOYEE_LEAVE_POLICY_PUBLIC_PROPS)}
         FROM ${EmployeeLeavePolicy.table}
        WHERE DeletedAt IS NULL
          AND (@employeeDetailId IS NULL OR EmployeeDetailId = @employeeDetailId)
        ORDER BY EmployeeDetailId, EffectiveFrom DESC`,
      EmployeeLeavePolicy.params({ employeeDetailId }),
    ),
  );
}

export async function createOverride(actorId, input) {
  await getPolicy(input.leavePolicyId);

  try {
    const row = await queryOne(
      `INSERT INTO ${EmployeeLeavePolicy.table}
              (EmployeeDetailId, LeavePolicyId, OverrideAnnualQuota, OverrideAccrualDays,
               EffectiveFrom, EffectiveTo, Reason, CreatedBy, ModifiedBy)
       OUTPUT ${EMPLOYEE_LEAVE_POLICY_PUBLIC_PROPS.map((p) => `inserted.${EmployeeLeavePolicy.col(p)} AS ${p}`).join(', ')}
       VALUES (@employeeDetailId, @leavePolicyId, @overrideAnnualQuota, @overrideAccrualDays,
               @effectiveFrom, @effectiveTo, @reason, @actorId, @actorId)`,
      {
        ...EmployeeLeavePolicy.params({
          employeeDetailId: input.employeeDetailId,
          leavePolicyId: input.leavePolicyId,
          overrideAnnualQuota: input.overrideAnnualQuota ?? null,
          overrideAccrualDays: input.overrideAccrualDays ?? null,
          effectiveFrom: input.effectiveFrom ?? today(),
          effectiveTo: input.effectiveTo ?? null,
          reason: input.reason,
        }),
        actorId: EmployeeLeavePolicy.param('createdBy', actorId),
      },
    );
    return shape(row);
  } catch (error) {
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.LEAVE_POLICY_EXISTS, {
        code: ERROR_CODE.LEAVE_POLICY_EXISTS,
      });
    }
    throw error;
  }
}

export async function updateOverride(actorId, employeeLeavePolicyId, input) {
  const row = await queryOne(
    `UPDATE ${EmployeeLeavePolicy.table}
        SET OverrideAnnualQuota = @overrideAnnualQuota,
            OverrideAccrualDays = @overrideAccrualDays,
            EffectiveTo         = @effectiveTo,
            Reason              = COALESCE(@reason, Reason),
            IsActive            = COALESCE(@isActive, IsActive),
            ModifiedBy          = @actorId,
            ModifiedAt          = SYSUTCDATETIME()
      OUTPUT ${EMPLOYEE_LEAVE_POLICY_PUBLIC_PROPS.map((p) => `inserted.${EmployeeLeavePolicy.col(p)} AS ${p}`).join(', ')}
      WHERE EmployeeLeavePolicyId = @employeeLeavePolicyId AND DeletedAt IS NULL`,
    {
      ...EmployeeLeavePolicy.params({
        employeeLeavePolicyId,
        overrideAnnualQuota: input.overrideAnnualQuota ?? null,
        overrideAccrualDays: input.overrideAccrualDays ?? null,
        effectiveTo: input.effectiveTo ?? null,
        reason: input.reason ?? null,
        isActive: input.isActive ?? null,
      }),
      actorId: EmployeeLeavePolicy.param('modifiedBy', actorId),
    },
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.LEAVE_OVERRIDE_NOT_FOUND, {
      code: ERROR_CODE.LEAVE_OVERRIDE_NOT_FOUND,
    });
  }
  return shape(row);
}

export async function deleteOverride(actorId, employeeLeavePolicyId) {
  const rows = await mutate(
    `UPDATE ${EmployeeLeavePolicy.table}
        SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
      WHERE EmployeeLeavePolicyId = @employeeLeavePolicyId AND DeletedAt IS NULL`,
    {
      ...EmployeeLeavePolicy.params({ employeeLeavePolicyId }),
      actorId: EmployeeLeavePolicy.param('modifiedBy', actorId),
    },
  );
  if (rows === 0) {
    throw ApiError.notFound(MESSAGES.LEAVE_OVERRIDE_NOT_FOUND, {
      code: ERROR_CODE.LEAVE_OVERRIDE_NOT_FOUND,
    });
  }
  return { employeeLeavePolicyId: Number(employeeLeavePolicyId) };
}

/* -------------------------------------------------------------------------
   Resolution - what every other caller actually wants
   ------------------------------------------------------------------------- */

/** The employee facts mapping and policy are matched against. */
export async function loadEmployeeForLeave(employeeDetailId) {
  const row = await queryOne(
    `SELECT EmployeeDetailId   AS employeeDetailId,
            WorkLocationId     AS workLocationId,
            EmploymentType     AS employmentType,
            Gender             AS gender,
            DateOfJoining      AS dateOfJoining,
            ProbationEndDate   AS probationEndDate,
            ConfirmationStatus AS confirmationStatus,
            ConfirmedOn        AS confirmedOn,
            ManagerId          AS managerId,
            SecondaryManagerId AS secondaryManagerId
       FROM ${EmployeeDetails.table}
      WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL AND IsActive = 1`,
    EmployeeDetails.params({ employeeDetailId }),
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.EMPLOYEE_NOT_FOUND, { code: ERROR_CODE.EMPLOYEE_NOT_FOUND });
  }

  const employee = {
    ...row,
    employeeDetailId: Number(row.employeeDetailId),
    workLocationId: row.workLocationId === null ? null : Number(row.workLocationId),
    managerId: row.managerId === null ? null : Number(row.managerId),
    secondaryManagerId: row.secondaryManagerId === null ? null : Number(row.secondaryManagerId),
    dateOfJoining: row.dateOfJoining ? dateOf(row.dateOfJoining) : null,
    probationEndDate: row.probationEndDate ? dateOf(row.probationEndDate) : null,
    confirmedOn: row.confirmedOn ? dateOf(row.confirmedOn) : null,
  };

  employee.isOnProbation = employee.confirmationStatus === CONFIRMATION_STATUS.PROBATION;
  return employee;
}

/**
 * Every leave category this employee is mapped to, with its effective
 * policy - and the ones that are mapped but not available right now, so the
 * dashboard can show them greyed out with a reason.
 *
 * ONE QUERY FOR THE MAPPINGS, ONE FOR THE POLICIES, ONE FOR THE OVERRIDES.
 * Not one per category: the dashboard shows every category an employee has,
 * and a per-row round trip is the difference between a page that loads and
 * one that does not.
 */
export async function resolveForEmployee(employeeDetailId, { onDate = today(), employee = null } = {}) {
  const person = employee ?? (await loadEmployeeForLeave(employeeDetailId));

  const tenureMonths = person.dateOfJoining
    ? monthsBetween(person.dateOfJoining, onDate)
    : 0;

  /*
    The mapped categories. NULL on a criterion means "do not filter on
    this", which is why each line is an OR against NULL rather than an
    equality - a mapping with no gender applies to everybody.
  */
  const mappings = shapeAll(
    await query(
      `SELECT ${LEAVE_MAPPING_PUBLIC_PROPS.map((p) => `m.${LeaveMapping.col(p)} AS ${p}`).join(', ')},
              lt.Name     AS leaveTypeName,
              lt.IsActive AS leaveTypeIsActive
         FROM ${LeaveMapping.table} AS m
         JOIN ${LeaveType.table}    AS lt ON lt.LeaveTypeId = m.LeaveTypeId
        WHERE m.DeletedAt IS NULL AND m.IsActive = 1
          AND lt.DeletedAt IS NULL AND lt.IsActive = 1
          AND (m.LocationId      IS NULL OR m.LocationId     = @locationId)
          AND (m.EmploymentType  IS NULL OR m.EmploymentType = @employmentType)
          AND (m.Gender          IS NULL OR m.Gender         = @gender)
          AND (m.MinTenureMonths IS NULL OR m.MinTenureMonths <= @tenureMonths)
        ORDER BY lt.Name`,
      {
        locationId: LeaveMapping.param('locationId', person.workLocationId),
        employmentType: LeaveMapping.param('employmentType', person.employmentType),
        gender: LeaveMapping.param('gender', person.gender),
        tenureMonths: LeaveMapping.param('minTenureMonths', tenureMonths),
      },
    ),
  );

  if (mappings.length === 0) return [];

  const leaveTypeIds = [...new Set(mappings.map((m) => m.leaveTypeId))];

  /*
    The policy for each mapped category, most specific cohort first.

    ROW_NUMBER rather than a correlated TOP(1) per category: one pass over
    the index, and the ORDER BY inside the window is where "a location-and-
    type policy beats a location-only policy beats the everybody policy"
    actually lives.
  */
  const policies = shapeAll(
    await query(
      `WITH ranked AS (
         SELECT ${LEAVE_POLICY_PUBLIC_PROPS.map((p) => `p.${LeavePolicy.col(p)} AS ${p}`).join(', ')},
                ROW_NUMBER() OVER (
                  PARTITION BY p.LeaveTypeId
                  ORDER BY CASE WHEN p.LocationId     IS NULL THEN 1 ELSE 0 END,
                           CASE WHEN p.EmploymentType IS NULL THEN 1 ELSE 0 END,
                           p.EffectiveFrom DESC
                ) AS rankInType
           FROM ${LeavePolicy.table} AS p
          WHERE p.DeletedAt IS NULL AND p.IsActive = 1
            AND p.LeaveTypeId IN (${leaveTypeIds.join(', ')})
            AND p.EffectiveFrom <= @onDate
            AND (p.EffectiveTo IS NULL OR p.EffectiveTo >= @onDate)
            AND (p.LocationId     IS NULL OR p.LocationId     = @locationId)
            AND (p.EmploymentType IS NULL OR p.EmploymentType = @employmentType)
       )
       SELECT * FROM ranked WHERE rankInType = 1`,
      {
        onDate: LeavePolicy.param('effectiveFrom', onDate),
        locationId: LeavePolicy.param('locationId', person.workLocationId),
        employmentType: LeavePolicy.param('employmentType', person.employmentType),
      },
    ),
  );

  const policyByType = new Map(policies.map((p) => [p.leaveTypeId, p]));

  const overrides = shapeAll(
    await query(
      `SELECT ${EmployeeLeavePolicy.select(EMPLOYEE_LEAVE_POLICY_PUBLIC_PROPS)}
         FROM ${EmployeeLeavePolicy.table}
        WHERE EmployeeDetailId = @employeeDetailId
          AND DeletedAt IS NULL AND IsActive = 1
          AND EffectiveFrom <= @onDate
          AND (EffectiveTo IS NULL OR EffectiveTo >= @onDate)`,
      {
        ...EmployeeLeavePolicy.params({ employeeDetailId }),
        onDate: EmployeeLeavePolicy.param('effectiveFrom', onDate),
      },
    ),
  );
  const overrideByPolicy = new Map(overrides.map((o) => [o.leavePolicyId, o]));

  return mappings.map((mapping) => {
    const policy = policyByType.get(mapping.leaveTypeId) ?? null;
    const override = policy ? (overrideByPolicy.get(policy.leavePolicyId) ?? null) : null;

    /*
      A category with no policy row is MAPPED BUT UNPRICED - it is offered
      to the cohort and nobody has said how it behaves. Returned rather than
      dropped, with `policy: null`, so the admin screen can show the gap:
      silently hiding it would make a half-configured category look like one
      that was deliberately withheld.
    */
    const effective = policy
      ? {
          ...policy,
          // The override replaces one or two numbers and nothing else.
          annualQuota: override?.overrideAnnualQuota ?? policy.annualQuota,
          accrualDays: override?.overrideAccrualDays ?? policy.accrualDays,
          isOverridden: override !== null,
          overrideReason: override?.reason ?? null,
        }
      : null;

    // Both the policy and the mapping get a veto on probation - mapping
    // decides the audience, policy decides the rules, either can exclude.
    const availableOnProbation =
      Boolean(mapping.availableDuringProbation) && Boolean(policy?.availableDuringProbation);

    return {
      leaveTypeId: mapping.leaveTypeId,
      leaveTypeName: mapping.leaveTypeName,
      mapping,
      policy: effective,
      isAvailable: policy
        ? person.isOnProbation
          ? availableOnProbation
          : true
        : false,
      isVisible: policy
        ? person.isOnProbation
          ? Boolean(policy.visibleDuringProbation)
          : true
        : true,
      unavailableReason: !policy
        ? 'No leave policy is configured for this category'
        : person.isOnProbation && !availableOnProbation
          ? 'Not available during probation'
          : null,
    };
  });
}

/** One category's effective rules, or a 400 naming which is missing. */
export async function requirePolicyFor(employeeDetailId, leaveTypeId, options = {}) {
  const resolved = await resolveForEmployee(employeeDetailId, options);
  const entry = resolved.find((row) => row.leaveTypeId === Number(leaveTypeId));

  if (!entry) {
    throw ApiError.forbidden(MESSAGES.LEAVE_NOT_MAPPED, { code: ERROR_CODE.LEAVE_NOT_MAPPED });
  }
  if (!entry.policy) {
    throw ApiError.badRequest(MESSAGES.LEAVE_POLICY_MISSING, {
      code: ERROR_CODE.LEAVE_POLICY_MISSING,
    });
  }
  if (!entry.isAvailable) {
    throw ApiError.forbidden(MESSAGES.LEAVE_NOT_AVAILABLE_ON_PROBATION, {
      code: ERROR_CODE.LEAVE_NOT_AVAILABLE_ON_PROBATION,
      reason: entry.unavailableReason,
    });
  }
  return entry;
}

/** The sandwich rule a policy points at, or null. */
export async function sandwichRuleFor(policy) {
  if (!policy?.sandwichRuleId) return null;

  return shape(
    await queryOne(
      `SELECT ${SandwichRule.select(SANDWICH_RULE_PUBLIC_PROPS)} FROM ${SandwichRule.table}
        WHERE SandwichRuleId = @sandwichRuleId AND DeletedAt IS NULL AND IsActive = 1`,
      SandwichRule.params({ sandwichRuleId: policy.sandwichRuleId }),
    ),
  );
}

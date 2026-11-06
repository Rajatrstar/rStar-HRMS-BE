/**
 * Holidays per location, and the floating / restricted holiday an employee
 * picks once a year.
 *
 * TWO AUDIENCES, and the split runs through the file: everybody reads the
 * holiday calendar (it is on the dashboard), and only HR writes it. The
 * route file enforces that with two different modules; nothing here
 * re-checks a right.
 *
 * holidaysFor() is the hot path - the attendance close asks it for every
 * employee every night, and the leave charge calculation asks it for every
 * application. It takes a LOCATION and a DATE RANGE and answers in one
 * query, because the alternative is a round trip per day.
 */
import { query, queryOne, mutate, withTransaction } from '../helpers/query.helper.js';
import {
  Holiday,
  HolidayLocation,
  HolidayType,
  RestrictedHolidayMapping,
  RestrictedHolidayOptIn,
  EmployeeDetails,
  HOLIDAY_PUBLIC_PROPS,
  HOLIDAY_TYPE_PUBLIC_PROPS,
  RESTRICTED_HOLIDAY_MAPPING_PUBLIC_PROPS,
  RESTRICTED_HOLIDAY_OPT_IN_PUBLIC_PROPS,
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import {
  MESSAGES,
  ERROR_CODE,
  HOLIDAY_TYPE,
  OPT_IN_STATUS,
  OPT_IN_OPEN_STATUSES,
  CYCLE_TYPE,
} from '../enums/index.js';
import { today, dateOf } from '../helpers/date.helper.js';
import { requireCycleFor, findCycleFor } from './leave-cycle.service.js';

const HOLIDAY_COLUMNS = Holiday.select(HOLIDAY_PUBLIC_PROPS);
const OUTPUT_HOLIDAY = HOLIDAY_PUBLIC_PROPS.map((p) => `inserted.${Holiday.col(p)} AS ${p}`).join(', ');
const OPT_IN_COLUMNS = RestrictedHolidayOptIn.select(RESTRICTED_HOLIDAY_OPT_IN_PUBLIC_PROPS);
const MAPPING_COLUMNS = RestrictedHolidayMapping.select(RESTRICTED_HOLIDAY_MAPPING_PUBLIC_PROPS);

const ID_PROPS = Object.freeze([
  'holidayId',
  'holidayLocationId',
  'locationId',
  'leaveCycleId',
  'restrictedHolidayMappingId',
  'restrictedHolidayOptInId',
  'employeeDetailId',
  'approvedBy',
]);

function shape(row) {
  if (!row) return row;

  const copy = { ...row };
  for (const prop of ID_PROPS) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  /*
    A DATE comes back from the driver as a Date object, which JSON.stringify
    turns into a full ISO timestamp - so "2026-01-01" would reach a browser
    as "2026-01-01T00:00:00.000Z" and be rendered in the viewer's timezone,
    landing on 31 December for anybody west of UTC. A holiday has no time
    and no timezone; it goes out as the calendar string it is.
  */
  for (const prop of ['holidayDate', 'startDate', 'endDate']) {
    if (copy[prop]) copy[prop] = dateOf(copy[prop]);
  }
  return copy;
}

const shapeAll = (rows) => rows.map(shape);
const uniqueViolation = (error) => error?.number === 2601 || error?.number === 2627;

/* -------------------------------------------------------------------------
   Reading the calendar
   ------------------------------------------------------------------------- */

/** The two fixed types, for a dropdown. */
export async function listHolidayTypes() {
  return query(
    `SELECT ${HolidayType.select(HOLIDAY_TYPE_PUBLIC_PROPS)}
       FROM ${HolidayType.table}
      WHERE IsActive = 1
      ORDER BY HolidayTypeId`,
  );
}

/**
 * The calendar, with the locations each holiday is observed at.
 *
 * Locations come back as a comma-separated list from a correlated subquery
 * rather than as a second round trip or a row per location: the screen
 * shows one line per holiday with its offices listed, and joining would
 * mean the caller re-grouping rows it only ever wanted grouped.
 */
export async function listHolidays({
  year = null,
  locationId = null,
  holidayTypeId = null,
  fromDate = null,
  toDate = null,
  includeInactive = false,
} = {}) {
  const rows = await query(
    `SELECT ${HOLIDAY_PUBLIC_PROPS.map((p) => `h.${Holiday.col(p)} AS ${p}`).join(', ')},
            ht.TypeCode AS holidayTypeCode,
            ht.TypeName AS holidayTypeName,
            STUFF((
              SELECT ',' + CAST(hl.LocationId AS NVARCHAR(20))
                FROM ${HolidayLocation.table} AS hl
               WHERE hl.HolidayId = h.HolidayId AND hl.DeletedAt IS NULL
               ORDER BY hl.LocationId
                 FOR XML PATH('')
            ), 1, 1, '') AS locationIdList
       FROM ${Holiday.table}     AS h
       JOIN ${HolidayType.table} AS ht ON ht.HolidayTypeId = h.HolidayTypeId
      WHERE h.DeletedAt IS NULL
        AND (@includeInactive = 1 OR h.IsActive = 1)
        AND (@year          IS NULL OR h.HolidayYear   = @year)
        AND (@holidayTypeId IS NULL OR h.HolidayTypeId = @holidayTypeId)
        AND (@fromDate      IS NULL OR h.HolidayDate  >= @fromDate)
        AND (@toDate        IS NULL OR h.HolidayDate  <= @toDate)
        AND (@locationId    IS NULL OR EXISTS (
               SELECT 1 FROM ${HolidayLocation.table} AS hl
                WHERE hl.HolidayId = h.HolidayId
                  AND hl.LocationId = @locationId
                  AND hl.DeletedAt IS NULL))
      ORDER BY h.HolidayDate`,
    {
      ...Holiday.params({ holidayYear: year, holidayTypeId, isActive: includeInactive ? 1 : 0 }),
      year: Holiday.param('holidayYear', year),
      includeInactive: Holiday.param('isActive', includeInactive ? 1 : 0),
      fromDate: Holiday.param('holidayDate', fromDate),
      toDate: Holiday.param('holidayDate', toDate),
      locationId: HolidayLocation.param('locationId', locationId),
    },
  );

  return rows.map((row) => {
    const { locationIdList, ...rest } = row;
    return {
      ...shape(rest),
      locationIds: locationIdList ? locationIdList.split(',').map(Number) : [],
    };
  });
}

/**
 * THE HOT PATH: which dates in a range are holidays at one location.
 *
 * Returns a Map keyed by date so a caller iterating days can answer in O(1)
 * instead of scanning an array per day. NORMAL holidays only - a restricted
 * holiday applies to the one person who picked it, never to the office, so
 * including it here would mark the whole company off on Holi.
 */
export async function holidayMapFor(locationId, fromDate, toDate) {
  const rows = await query(
    `SELECT h.HolidayId AS holidayId, h.HolidayName AS holidayName, h.HolidayDate AS holidayDate
       FROM ${Holiday.table}         AS h
       JOIN ${HolidayLocation.table} AS hl
         ON hl.HolidayId = h.HolidayId AND hl.DeletedAt IS NULL
      WHERE h.DeletedAt IS NULL AND h.IsActive = 1
        AND h.HolidayTypeId = @normalType
        AND hl.LocationId = @locationId
        AND h.HolidayDate BETWEEN @fromDate AND @toDate`,
    {
      normalType: Holiday.param('holidayTypeId', HOLIDAY_TYPE.NORMAL),
      locationId: HolidayLocation.param('locationId', locationId),
      fromDate: Holiday.param('holidayDate', fromDate),
      toDate: Holiday.param('holidayDate', toDate),
    },
  );

  const map = new Map();
  for (const row of rows) {
    // The driver hands a DATE back as a Date; the key must be the string
    // form or lookups by "YYYY-MM-DD" silently miss every time.
    const key = row.holidayDate instanceof Date
      ? row.holidayDate.toISOString().slice(0, 10)
      : String(row.holidayDate).slice(0, 10);
    map.set(key, { holidayId: Number(row.holidayId), holidayName: row.holidayName });
  }
  return map;
}

/**
 * The restricted holidays ONE EMPLOYEE has approved, as a Map by date.
 *
 * Separate from holidayMapFor because the audience is different: this is a
 * personal day off, and the attendance close must mark it for that person
 * alone.
 */
export async function approvedRestrictedMapFor(employeeDetailId, fromDate, toDate) {
  const rows = await query(
    `SELECT h.HolidayId AS holidayId, h.HolidayName AS holidayName, h.HolidayDate AS holidayDate
       FROM ${RestrictedHolidayOptIn.table} AS o
       JOIN ${Holiday.table}                AS h ON h.HolidayId = o.HolidayId
      WHERE o.EmployeeDetailId = @employeeDetailId
        AND o.Status = @approved
        AND o.DeletedAt IS NULL
        AND h.DeletedAt IS NULL AND h.IsActive = 1
        AND h.HolidayDate BETWEEN @fromDate AND @toDate`,
    {
      ...RestrictedHolidayOptIn.params({ employeeDetailId }),
      approved: RestrictedHolidayOptIn.param('status', OPT_IN_STATUS.APPROVED),
      fromDate: Holiday.param('holidayDate', fromDate),
      toDate: Holiday.param('holidayDate', toDate),
    },
  );

  const map = new Map();
  for (const row of rows) {
    const key = row.holidayDate instanceof Date
      ? row.holidayDate.toISOString().slice(0, 10)
      : String(row.holidayDate).slice(0, 10);
    map.set(key, { holidayId: Number(row.holidayId), holidayName: row.holidayName });
  }
  return map;
}

export async function getHoliday(holidayId) {
  const row = await queryOne(
    `SELECT ${HOLIDAY_COLUMNS} FROM ${Holiday.table}
      WHERE HolidayId = @holidayId AND DeletedAt IS NULL`,
    Holiday.params({ holidayId }),
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.HOLIDAY_NOT_FOUND, { code: ERROR_CODE.HOLIDAY_NOT_FOUND });
  }

  const locations = await query(
    `SELECT LocationId AS locationId FROM ${HolidayLocation.table}
      WHERE HolidayId = @holidayId AND DeletedAt IS NULL ORDER BY LocationId`,
    HolidayLocation.params({ holidayId }),
  );

  return { ...shape(row), locationIds: locations.map((r) => Number(r.locationId)) };
}

/* -------------------------------------------------------------------------
   Writing the calendar
   ------------------------------------------------------------------------- */

/**
 * A holiday and its locations are written together, in one transaction.
 *
 * A holiday observed nowhere is invisible to every read path - it would
 * appear on the admin screen and on nobody's calendar - so it is refused
 * rather than created. HolidayYear is derived from the date, never taken
 * from the client: CK_tblHoliday_YearMatchesDate would reject a mismatch
 * anyway, with a constraint name nobody can act on.
 */
export async function createHoliday(actorId, input) {
  if (!input.locationIds?.length) {
    throw ApiError.badRequest(MESSAGES.HOLIDAY_NEEDS_LOCATION, {
      code: ERROR_CODE.HOLIDAY_NEEDS_LOCATION,
    });
  }

  try {
    return await withTransaction(async (run) => {
      const [row] = await run(
        `INSERT INTO ${Holiday.table}
                (HolidayName, HolidayDate, HolidayTypeId, HolidayYear, Description,
                 CreatedBy, ModifiedBy)
         OUTPUT ${OUTPUT_HOLIDAY}
         VALUES (@holidayName, @holidayDate, @holidayTypeId, @holidayYear, @description,
                 @actorId, @actorId)`,
        {
          ...Holiday.params({
            holidayName: input.holidayName,
            holidayDate: input.holidayDate,
            holidayTypeId: input.holidayTypeId,
            holidayYear: Number(input.holidayDate.slice(0, 4)),
            description: input.description ?? null,
          }),
          actorId: Holiday.param('createdBy', actorId),
        },
      );

      for (const locationId of input.locationIds) {
        await run(
          `INSERT INTO ${HolidayLocation.table} (HolidayId, LocationId, CreatedBy, ModifiedBy)
           VALUES (@holidayId, @locationId, @actorId, @actorId)`,
          {
            ...HolidayLocation.params({ holidayId: row.holidayId, locationId }),
            actorId: HolidayLocation.param('createdBy', actorId),
          },
        );
      }

      return { ...shape(row), locationIds: input.locationIds.map(Number) };
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.HOLIDAY_EXISTS, { code: ERROR_CODE.HOLIDAY_EXISTS });
    }
    throw error;
  }
}

/** Same shape as create: the location set is replaced wholesale. */
export async function updateHoliday(actorId, holidayId, input) {
  const existing = await getHoliday(holidayId);
  const holidayDate = input.holidayDate ?? existing.holidayDate;
  const locationIds = input.locationIds ?? existing.locationIds;

  if (!locationIds.length) {
    throw ApiError.badRequest(MESSAGES.HOLIDAY_NEEDS_LOCATION, {
      code: ERROR_CODE.HOLIDAY_NEEDS_LOCATION,
    });
  }

  const dateText = holidayDate instanceof Date
    ? holidayDate.toISOString().slice(0, 10)
    : String(holidayDate).slice(0, 10);

  try {
    return await withTransaction(async (run) => {
      const [row] = await run(
        `UPDATE ${Holiday.table}
            SET HolidayName = @holidayName,
                HolidayDate = @holidayDate,
                HolidayTypeId = @holidayTypeId,
                HolidayYear = @holidayYear,
                Description = @description,
                IsActive    = @isActive,
                ModifiedBy  = @actorId,
                ModifiedAt  = SYSUTCDATETIME()
          OUTPUT ${OUTPUT_HOLIDAY}
          WHERE HolidayId = @holidayId AND DeletedAt IS NULL`,
        {
          ...Holiday.params({
            holidayId,
            holidayName: input.holidayName ?? existing.holidayName,
            holidayDate: dateText,
            holidayTypeId: input.holidayTypeId ?? existing.holidayTypeId,
            holidayYear: Number(dateText.slice(0, 4)),
            description: input.description === undefined ? existing.description : input.description,
            isActive: input.isActive ?? existing.isActive,
          }),
          actorId: Holiday.param('modifiedBy', actorId),
        },
      );

      await run(
        `UPDATE ${HolidayLocation.table}
            SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
          WHERE HolidayId = @holidayId AND DeletedAt IS NULL`,
        {
          ...HolidayLocation.params({ holidayId }),
          actorId: HolidayLocation.param('modifiedBy', actorId),
        },
      );

      for (const locationId of locationIds) {
        await run(
          `INSERT INTO ${HolidayLocation.table} (HolidayId, LocationId, CreatedBy, ModifiedBy)
           VALUES (@holidayId, @locationId, @actorId, @actorId)`,
          {
            ...HolidayLocation.params({ holidayId, locationId }),
            actorId: HolidayLocation.param('createdBy', actorId),
          },
        );
      }

      return { ...shape(row), locationIds: locationIds.map(Number) };
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.HOLIDAY_EXISTS, { code: ERROR_CODE.HOLIDAY_EXISTS });
    }
    throw error;
  }
}

/**
 * Soft delete. Attendance rows point at a holiday and must still resolve to
 * a name, so nothing here is ever hard-deleted.
 */
export async function deleteHoliday(actorId, holidayId) {
  await getHoliday(holidayId);

  const row = await queryOne(
    `UPDATE ${Holiday.table}
        SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
      OUTPUT ${OUTPUT_HOLIDAY}
      WHERE HolidayId = @holidayId AND DeletedAt IS NULL`,
    { ...Holiday.params({ holidayId }), actorId: Holiday.param('modifiedBy', actorId) },
  );
  return shape(row);
}

/* -------------------------------------------------------------------------
   Restricted-holiday mapping: who gets the list, and how many picks
   ------------------------------------------------------------------------- */

export async function listRestrictedMappings({ leaveCycleId = null } = {}) {
  return shapeAll(
    await query(
      `SELECT ${MAPPING_COLUMNS} FROM ${RestrictedHolidayMapping.table}
        WHERE DeletedAt IS NULL AND (@leaveCycleId IS NULL OR LeaveCycleId = @leaveCycleId)
        ORDER BY LeaveCycleId DESC, LocationId, EmploymentType`,
      RestrictedHolidayMapping.params({ leaveCycleId }),
    ),
  );
}

export async function createRestrictedMapping(actorId, input) {
  try {
    const row = await queryOne(
      `INSERT INTO ${RestrictedHolidayMapping.table}
              (LocationId, EmploymentType, LeaveCycleId, PickQuota, CreatedBy, ModifiedBy)
       OUTPUT ${RESTRICTED_HOLIDAY_MAPPING_PUBLIC_PROPS.map((p) => `inserted.${RestrictedHolidayMapping.col(p)} AS ${p}`).join(', ')}
       VALUES (@locationId, @employmentType, @leaveCycleId, @pickQuota, @actorId, @actorId)`,
      {
        ...RestrictedHolidayMapping.params({
          locationId: input.locationId ?? null,
          employmentType: input.employmentType ?? null,
          leaveCycleId: input.leaveCycleId,
          pickQuota: input.pickQuota ?? 1,
        }),
        actorId: RestrictedHolidayMapping.param('createdBy', actorId),
      },
    );
    return shape(row);
  } catch (error) {
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.RESTRICTED_MAPPING_EXISTS, {
        code: ERROR_CODE.RESTRICTED_MAPPING_NOT_FOUND,
      });
    }
    throw error;
  }
}

export async function updateRestrictedMapping(actorId, restrictedHolidayMappingId, input) {
  const row = await queryOne(
    `UPDATE ${RestrictedHolidayMapping.table}
        SET PickQuota  = COALESCE(@pickQuota, PickQuota),
            IsActive   = COALESCE(@isActive, IsActive),
            ModifiedBy = @actorId,
            ModifiedAt = SYSUTCDATETIME()
      OUTPUT ${RESTRICTED_HOLIDAY_MAPPING_PUBLIC_PROPS.map((p) => `inserted.${RestrictedHolidayMapping.col(p)} AS ${p}`).join(', ')}
      WHERE RestrictedHolidayMappingId = @restrictedHolidayMappingId AND DeletedAt IS NULL`,
    {
      ...RestrictedHolidayMapping.params({
        restrictedHolidayMappingId,
        pickQuota: input.pickQuota ?? null,
        isActive: input.isActive ?? null,
      }),
      actorId: RestrictedHolidayMapping.param('modifiedBy', actorId),
    },
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.RESTRICTED_MAPPING_NOT_FOUND, {
      code: ERROR_CODE.RESTRICTED_MAPPING_NOT_FOUND,
    });
  }
  return shape(row);
}

export async function deleteRestrictedMapping(actorId, restrictedHolidayMappingId) {
  const rows = await mutate(
    `UPDATE ${RestrictedHolidayMapping.table}
        SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
      WHERE RestrictedHolidayMappingId = @restrictedHolidayMappingId AND DeletedAt IS NULL`,
    {
      ...RestrictedHolidayMapping.params({ restrictedHolidayMappingId }),
      actorId: RestrictedHolidayMapping.param('modifiedBy', actorId),
    },
  );
  if (rows === 0) {
    throw ApiError.notFound(MESSAGES.RESTRICTED_MAPPING_NOT_FOUND, {
      code: ERROR_CODE.RESTRICTED_MAPPING_NOT_FOUND,
    });
  }
  return { restrictedHolidayMappingId: Number(restrictedHolidayMappingId) };
}

/**
 * The mapping that applies to one employee, most specific first.
 *
 * A location-and-type row beats a location-only row beats the
 * everybody row. ORDER BY scores the NULLs so the most specific match is
 * first - the same shape as the shift fallback in shift.service.js.
 */
async function mappingFor(employee, leaveCycleId) {
  return queryOne(
    `SELECT TOP (1) ${MAPPING_COLUMNS}
       FROM ${RestrictedHolidayMapping.table}
      WHERE DeletedAt IS NULL AND IsActive = 1
        AND LeaveCycleId = @leaveCycleId
        AND (LocationId     IS NULL OR LocationId     = @locationId)
        AND (EmploymentType IS NULL OR EmploymentType = @employmentType)
      ORDER BY CASE WHEN LocationId     IS NULL THEN 1 ELSE 0 END,
               CASE WHEN EmploymentType IS NULL THEN 1 ELSE 0 END`,
    {
      ...RestrictedHolidayMapping.params({ leaveCycleId }),
      locationId: RestrictedHolidayMapping.param('locationId', employee.workLocationId ?? null),
      employmentType: RestrictedHolidayMapping.param(
        'employmentType',
        employee.employmentType ?? null,
      ),
    },
  );
}

/** The employee facts the mapping and the opt-in need. */
async function loadEmployee(employeeDetailId) {
  const row = await queryOne(
    `SELECT EmployeeDetailId AS employeeDetailId,
            WorkLocationId   AS workLocationId,
            EmploymentType   AS employmentType
       FROM ${EmployeeDetails.table}
      WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL`,
    EmployeeDetails.params({ employeeDetailId }),
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.EMPLOYEE_NOT_FOUND, { code: ERROR_CODE.EMPLOYEE_NOT_FOUND });
  }
  return shape(row);
}

/* -------------------------------------------------------------------------
   The employee's pick
   ------------------------------------------------------------------------- */

/**
 * The restricted holidays this employee may choose from, with their quota
 * and what they have already used.
 *
 * Everything the pick screen needs in one call: the list, how many picks
 * are allowed, and the current selection - so the screen does not have to
 * assemble "you have used 1 of 1" from three endpoints and get it wrong
 * while one of them is still loading.
 */
export async function restrictedOptionsFor(employeeDetailId, { onDate = today() } = {}) {
  const employee = await loadEmployee(employeeDetailId);

  // ALWAYS the calendar cycle: the floating holiday year is 1 Jan - 31 Dec,
  // whatever the financial year is doing.
  const cycle = await findCycleFor(CYCLE_TYPE.CALENDAR, onDate);
  if (!cycle) {
    return { cycle: null, pickQuota: 0, used: 0, remaining: 0, selection: null, options: [] };
  }

  const mapping = await mappingFor(employee, cycle.leaveCycleId);
  const pickQuota = mapping ? Number(mapping.pickQuota) : 0;

  const existing = await query(
    `SELECT ${OPT_IN_COLUMNS} FROM ${RestrictedHolidayOptIn.table}
      WHERE EmployeeDetailId = @employeeDetailId
        AND LeaveCycleId = @leaveCycleId
        AND DeletedAt IS NULL
        AND Status IN ('${OPT_IN_OPEN_STATUSES.join("','")}')`,
    RestrictedHolidayOptIn.params({ employeeDetailId, leaveCycleId: cycle.leaveCycleId }),
  );

  const options = pickQuota
    ? await listHolidays({
        holidayTypeId: HOLIDAY_TYPE.RESTRICTED,
        locationId: employee.workLocationId,
        fromDate: cycle.startDate instanceof Date
          ? cycle.startDate.toISOString().slice(0, 10)
          : String(cycle.startDate).slice(0, 10),
        toDate: cycle.endDate instanceof Date
          ? cycle.endDate.toISOString().slice(0, 10)
          : String(cycle.endDate).slice(0, 10),
      })
    : [];

  return {
    cycle,
    pickQuota,
    used: existing.length,
    remaining: Math.max(0, pickQuota - existing.length),
    selection: existing.length ? shape(existing[0]) : null,
    options,
  };
}

/**
 * Choose a restricted holiday.
 *
 * THE ONE-PER-YEAR RULE IS CHECKED HERE AND ENFORCED BY THE INDEX. The
 * check gives a readable 409; UQ_tblRestrictedHolidayOptIn_Employee_Cycle
 * is what makes a double-submit or a retried request fail rather than
 * quietly granting two. Catching the violation as well as pre-checking is
 * deliberate: the pre-check is still wrong under concurrency.
 */
export async function optIn(actorId, employeeDetailId, { holidayId, reason = null }) {
  const holiday = await getHoliday(holidayId);

  if (Number(holiday.holidayTypeId) !== HOLIDAY_TYPE.RESTRICTED) {
    throw ApiError.badRequest(MESSAGES.RESTRICTED_WRONG_TYPE, {
      code: ERROR_CODE.RESTRICTED_WRONG_TYPE,
    });
  }

  const holidayDate = holiday.holidayDate instanceof Date
    ? holiday.holidayDate.toISOString().slice(0, 10)
    : String(holiday.holidayDate).slice(0, 10);

  // The cycle of the HOLIDAY's year, not of today: picking next year's Holi
  // in December must land in next year's quota.
  const cycle = await requireCycleFor(CYCLE_TYPE.CALENDAR, holidayDate);

  const employee = await loadEmployee(employeeDetailId);
  const mapping = await mappingFor(employee, cycle.leaveCycleId);

  if (!mapping) {
    throw ApiError.forbidden(MESSAGES.RESTRICTED_NOT_ELIGIBLE, {
      code: ERROR_CODE.RESTRICTED_NOT_ELIGIBLE,
    });
  }

  const used = await query(
    `SELECT RestrictedHolidayOptInId AS id FROM ${RestrictedHolidayOptIn.table}
      WHERE EmployeeDetailId = @employeeDetailId AND LeaveCycleId = @leaveCycleId
        AND DeletedAt IS NULL AND Status IN ('${OPT_IN_OPEN_STATUSES.join("','")}')`,
    RestrictedHolidayOptIn.params({ employeeDetailId, leaveCycleId: cycle.leaveCycleId }),
  );

  if (used.length >= Number(mapping.pickQuota)) {
    throw ApiError.conflict(MESSAGES.RESTRICTED_QUOTA_USED, {
      code: ERROR_CODE.RESTRICTED_QUOTA_USED,
      pickQuota: Number(mapping.pickQuota),
    });
  }

  try {
    const row = await queryOne(
      `INSERT INTO ${RestrictedHolidayOptIn.table}
              (EmployeeDetailId, HolidayId, LeaveCycleId, Status, Reason, CreatedBy, ModifiedBy)
       OUTPUT ${RESTRICTED_HOLIDAY_OPT_IN_PUBLIC_PROPS.map((p) => `inserted.${RestrictedHolidayOptIn.col(p)} AS ${p}`).join(', ')}
       VALUES (@employeeDetailId, @holidayId, @leaveCycleId, @status, @reason, @actorId, @actorId)`,
      {
        ...RestrictedHolidayOptIn.params({
          employeeDetailId,
          holidayId,
          leaveCycleId: cycle.leaveCycleId,
          status: OPT_IN_STATUS.PENDING,
          reason,
        }),
        actorId: RestrictedHolidayOptIn.param('createdBy', actorId),
      },
    );
    return shape(row);
  } catch (error) {
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.RESTRICTED_QUOTA_USED, {
        code: ERROR_CODE.RESTRICTED_QUOTA_USED,
      });
    }
    throw error;
  }
}

/** The approver's queue. */
export async function listPendingOptIns() {
  return shapeAll(
    await query(
      `SELECT ${OPT_IN_COLUMNS} FROM ${RestrictedHolidayOptIn.table}
        WHERE Status = @pending AND DeletedAt IS NULL
        ORDER BY CreatedAt`,
      { pending: RestrictedHolidayOptIn.param('status', OPT_IN_STATUS.PENDING) },
    ),
  );
}

/**
 * Approve or reject a pick.
 *
 * A rejection FREES THE SLOT - the unique index is filtered to the open
 * statuses precisely so the employee can choose again. Locking somebody out
 * of their floating holiday for the year over a request somebody turned
 * down is the opposite of what the policy says.
 */
export async function decideOptIn(actorId, restrictedHolidayOptInId, { approve, remarks = null }) {
  const row = await queryOne(
    `UPDATE ${RestrictedHolidayOptIn.table}
        SET Status          = @status,
            ApprovedBy      = @actorId,
            ApprovedAt      = SYSUTCDATETIME(),
            ApproverRemarks = @remarks,
            ModifiedBy      = @actorId,
            ModifiedAt      = SYSUTCDATETIME()
      OUTPUT ${RESTRICTED_HOLIDAY_OPT_IN_PUBLIC_PROPS.map((p) => `inserted.${RestrictedHolidayOptIn.col(p)} AS ${p}`).join(', ')}
      WHERE RestrictedHolidayOptInId = @restrictedHolidayOptInId
        AND Status = @pending AND DeletedAt IS NULL`,
    {
      ...RestrictedHolidayOptIn.params({
        restrictedHolidayOptInId,
        status: approve ? OPT_IN_STATUS.APPROVED : OPT_IN_STATUS.REJECTED,
        approverRemarks: remarks,
      }),
      pending: RestrictedHolidayOptIn.param('status', OPT_IN_STATUS.PENDING),
      remarks: RestrictedHolidayOptIn.param('approverRemarks', remarks),
      actorId: RestrictedHolidayOptIn.param('approvedBy', actorId),
    },
  );

  if (!row) {
    // Either it does not exist or somebody else decided it first. The same
    // 404 for both: the caller's next step is to reload the queue either way.
    throw ApiError.notFound(MESSAGES.RESTRICTED_OPT_IN_NOT_FOUND, {
      code: ERROR_CODE.RESTRICTED_OPT_IN_NOT_FOUND,
    });
  }
  return shape(row);
}

/** The employee taking their own pick back. Frees the slot, as above. */
export async function cancelOptIn(actorId, employeeDetailId, restrictedHolidayOptInId) {
  const row = await queryOne(
    `UPDATE ${RestrictedHolidayOptIn.table}
        SET Status = @cancelled, ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
      OUTPUT ${RESTRICTED_HOLIDAY_OPT_IN_PUBLIC_PROPS.map((p) => `inserted.${RestrictedHolidayOptIn.col(p)} AS ${p}`).join(', ')}
      WHERE RestrictedHolidayOptInId = @restrictedHolidayOptInId
        AND EmployeeDetailId = @employeeDetailId
        AND Status IN ('${OPT_IN_OPEN_STATUSES.join("','")}')
        AND DeletedAt IS NULL`,
    {
      ...RestrictedHolidayOptIn.params({
        restrictedHolidayOptInId,
        employeeDetailId,
        status: OPT_IN_STATUS.CANCELLED,
      }),
      cancelled: RestrictedHolidayOptIn.param('status', OPT_IN_STATUS.CANCELLED),
      actorId: RestrictedHolidayOptIn.param('modifiedBy', actorId),
    },
  );

  if (!row) {
    throw ApiError.notFound(MESSAGES.RESTRICTED_OPT_IN_NOT_FOUND, {
      code: ERROR_CODE.RESTRICTED_OPT_IN_NOT_FOUND,
    });
  }
  return shape(row);
}

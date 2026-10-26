/**
 * Organisation setup: the company profile and its locations.
 *
 * Two rules shape everything here:
 *
 *   1. A location is addressed THROUGH its organisation. Every location
 *      function takes an organizationId and filters on it, so a location id
 *      guessed from another organisation answers 404 rather than quietly
 *      being renamed. That check costs nothing - it is in the same WHERE.
 *   2. Nothing is ever hard-deleted. tblEmployeeDetails.WorkLocationId points
 *      at a location and a real FOREIGN KEY now enforces it, so "delete" is a
 *      DeletedAt stamp and the endpoint refuses while anybody is assigned.
 *
 * Who may call these is settled before the request arrives, by
 * requirePermission in the route file. Nothing here re-checks a permission -
 * none of these permissions is scoped, so there are no rows to narrow and no
 * second question to answer.
 */
import { query, queryOne } from '../helpers/query.helper.js';
import {
  Organization,
  OrganizationLocation,
  EmployeeDetails,
  ORGANIZATION_PUBLIC_PROPS,
  ORGANIZATION_LOCATION_PUBLIC_PROPS,
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { MESSAGES, ERROR_CODE } from '../enums/index.js';

const ORGANIZATION_COLUMNS = Organization.select(ORGANIZATION_PUBLIC_PROPS);
const LOCATION_COLUMNS = OrganizationLocation.select(ORGANIZATION_LOCATION_PUBLIC_PROPS);

/**
 * Hand-qualified copies of the two select lists, for the statements that join
 * or carry a correlated subquery. `Model.select()` emits unqualified column
 * names, which stop being unambiguous the moment a second table is in scope.
 */
const LOCATION_COLUMNS_QUALIFIED = ORGANIZATION_LOCATION_PUBLIC_PROPS.map(
  (prop) => `l.${OrganizationLocation.col(prop)} AS ${prop}`,
).join(', ');

/**
 * BIGINT arrives from the driver as a STRING, not a number - it has no way to
 * know the value fits, so it protects everything past Number.MAX_SAFE_INTEGER
 * by never narrowing. The same reason src/services/access-control.service.js
 * wraps employeeDetailId in Number().
 *
 * Ids go out as JSON numbers anyway: `data.organizationId === 1` silently
 * being false is a worse bug than a ceiling no organisation table will reach,
 * and the validator already refuses a path id above that same ceiling - so a
 * string id could never have been looked up again in the first place.
 */
const ID_PROPS = Object.freeze(['organizationId', 'locationId']);

function withNumericIds(row) {
  if (!row) return row;

  const copy = { ...row };
  for (const prop of ID_PROPS) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  return copy;
}

const allWithNumericIds = (rows) => rows.map(withNumericIds);

/**
 * SQL Server's two unique-index violations: 2627 is a UNIQUE/PK constraint,
 * 2601 a unique index. Both can come back from these inserts.
 */
function uniqueViolation(error) {
  return error?.number === 2601 || error?.number === 2627;
}

/**
 * Turns a unique-index violation into the right 409.
 *
 * Caught rather than pre-checked with a SELECT: a pre-check is a second round
 * trip that is still wrong under concurrency, because the row can land between
 * the check and the insert. The index is the only authority, so this reads the
 * answer from it. The index NAME is what identifies which rule was broken -
 * SQL Server puts it in the message, and the names are stable because they are
 * declared in the migration.
 */
function conflictFor(error, { nameMessage, codeMessage }) {
  if (!uniqueViolation(error)) return error;

  if (codeMessage && /_Code\b/i.test(error.message)) {
    return ApiError.conflict(codeMessage, { code: ERROR_CODE.CODE_ALREADY_EXISTS });
  }
  return ApiError.conflict(nameMessage, { code: ERROR_CODE.NAME_ALREADY_EXISTS });
}

/* -------------------------------------------------------------------------- */
/* Organisation                                                               */
/* -------------------------------------------------------------------------- */

/** Every live organisation, newest name order. */
export async function listOrganizations() {
  return allWithNumericIds(
    await query(
    `SELECT ${ORGANIZATION_COLUMNS}
       FROM ${Organization.table}
      WHERE DeletedAt IS NULL
      ORDER BY OrganizationName`,
    ),
  );
}

/** One organisation, or a 404. */
export async function getOrganization(organizationId) {
  const row = await queryOne(
    `SELECT ${ORGANIZATION_COLUMNS}
       FROM ${Organization.table}
      WHERE OrganizationId = @organizationId AND DeletedAt IS NULL`,
    Organization.params({ organizationId }),
  );

  if (!row) {
    throw ApiError.notFound(MESSAGES.ORGANIZATION_NOT_FOUND);
  }

  return withNumericIds(row);
}

/**
 * Exists-check for the location endpoints.
 *
 * Separate from getOrganization so the location paths pay for one column
 * instead of twenty, and so the 404 they raise names the organisation rather
 * than the location the caller actually asked about.
 */
async function assertOrganizationExists(organizationId) {
  const row = await queryOne(
    `SELECT TOP (1) OrganizationId AS organizationId
       FROM ${Organization.table}
      WHERE OrganizationId = @organizationId AND DeletedAt IS NULL`,
    Organization.params({ organizationId }),
  );

  if (!row) {
    throw ApiError.notFound(MESSAGES.ORGANIZATION_NOT_FOUND);
  }
}

/**
 * @param {number} actorId  EmployeeLogin.EmployeeId of the caller
 * @param {object} input    already validated and cleaned by the controller
 */
export async function createOrganization(actorId, input) {
  try {
    const row = await queryOne(
      `INSERT INTO ${Organization.table} (
            OrganizationName, LogoUrl, Website, OrganizationType,
            ContactPerson, ContactNumber, ContactEmail,
            AddressLine1, AddressLine2, City, State, Country, PostalCode,
            CreatedBy, ModifiedBy
       )
       OUTPUT ${ORGANIZATION_PUBLIC_PROPS.map((p) => `inserted.${Organization.col(p)} AS ${p}`).join(', ')}
       VALUES (
            @organizationName, @logoUrl, @website, @organizationType,
            @contactPerson, @contactNumber, @contactEmail,
            @addressLine1, @addressLine2, @city, @state, @country, @postalCode,
            @actorId, @actorId
       )`,
      {
        ...Organization.params({
          organizationName: input.organizationName,
          logoUrl: input.logoUrl ?? null,
          website: input.website ?? null,
          organizationType: input.organizationType ?? null,
          contactPerson: input.contactPerson ?? null,
          contactNumber: input.contactNumber ?? null,
          contactEmail: input.contactEmail,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          country: input.country ?? null,
          postalCode: input.postalCode ?? null,
        }),
        actorId: Organization.param('createdBy', actorId),
      },
    );

    return withNumericIds(row);
  } catch (error) {
    throw conflictFor(error, { nameMessage: MESSAGES.ORGANIZATION_NAME_EXISTS });
  }
}

/**
 * Full replace, PUT semantics: a field the client leaves out becomes NULL.
 *
 * Partial-update semantics were rejected because the settings screen posts the
 * whole form back every time, and a PATCH that silently keeps an old value is
 * how a cleared field reappears after a reload.
 */
export async function updateOrganization(actorId, organizationId, input) {
  let row;

  try {
    row = await queryOne(
      `UPDATE ${Organization.table}
          SET OrganizationName = @organizationName,
              LogoUrl          = @logoUrl,
              Website          = @website,
              OrganizationType = @organizationType,
              ContactPerson    = @contactPerson,
              ContactNumber    = @contactNumber,
              ContactEmail     = @contactEmail,
              AddressLine1     = @addressLine1,
              AddressLine2     = @addressLine2,
              City             = @city,
              State            = @state,
              Country          = @country,
              PostalCode       = @postalCode,
              IsActive         = @isActive,
              ModifiedBy       = @actorId,
              ModifiedAt       = SYSUTCDATETIME()
        OUTPUT ${ORGANIZATION_PUBLIC_PROPS.map((p) => `inserted.${Organization.col(p)} AS ${p}`).join(', ')}
        WHERE OrganizationId = @organizationId AND DeletedAt IS NULL`,
      {
        ...Organization.params({
          organizationId,
          organizationName: input.organizationName,
          logoUrl: input.logoUrl ?? null,
          website: input.website ?? null,
          organizationType: input.organizationType ?? null,
          contactPerson: input.contactPerson ?? null,
          contactNumber: input.contactNumber ?? null,
          contactEmail: input.contactEmail,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          country: input.country ?? null,
          postalCode: input.postalCode ?? null,
          isActive: input.isActive ?? true,
        }),
        actorId: Organization.param('modifiedBy', actorId),
      },
    );
  } catch (error) {
    throw conflictFor(error, { nameMessage: MESSAGES.ORGANIZATION_NAME_EXISTS });
  }

  // OUTPUT returns nothing when the WHERE matched nothing, which is the only
  // way to tell "updated" from "no such row" here - withTransaction's run()
  // reports no rowsAffected, and this path does not want a second SELECT.
  if (!row) {
    throw ApiError.notFound(MESSAGES.ORGANIZATION_NOT_FOUND);
  }

  return withNumericIds(row);
}

/* -------------------------------------------------------------------------- */
/* Locations                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every live location of one organisation, each with its headcount.
 *
 * `associatedUsers` is the "Associated users" column on the grid: live
 * employees whose WorkLocationId is this location. A correlated subquery
 * rather than a GROUP BY join, so a location with nobody at it still comes
 * back - with a zero, which is exactly what the grid should show.
 */
export async function listLocations(organizationId) {
  await assertOrganizationExists(organizationId);

  const rows = await query(
    `SELECT ${LOCATION_COLUMNS_QUALIFIED},
            (SELECT COUNT(*)
               FROM ${EmployeeDetails.table} AS e
              WHERE e.WorkLocationId = l.LocationId
                AND e.DeletedAt IS NULL) AS associatedUsers
       FROM ${OrganizationLocation.table} AS l
      WHERE l.OrganizationId = @organizationId
        AND l.DeletedAt IS NULL
      ORDER BY l.LocationName`,
    OrganizationLocation.params({ organizationId }),
  );

  return allWithNumericIds(rows);
}

/** One location of one organisation, or a 404. */
export async function getLocation(organizationId, locationId) {
  const row = await queryOne(
    `SELECT ${LOCATION_COLUMNS_QUALIFIED},
            (SELECT COUNT(*)
               FROM ${EmployeeDetails.table} AS e
              WHERE e.WorkLocationId = l.LocationId
                AND e.DeletedAt IS NULL) AS associatedUsers
       FROM ${OrganizationLocation.table} AS l
      WHERE l.LocationId = @locationId
        AND l.OrganizationId = @organizationId
        AND l.DeletedAt IS NULL`,
    OrganizationLocation.params({ locationId, organizationId }),
  );

  if (!row) {
    throw ApiError.notFound(MESSAGES.LOCATION_NOT_FOUND);
  }

  return withNumericIds(row);
}

export async function createLocation(actorId, organizationId, input) {
  await assertOrganizationExists(organizationId);

  try {
    const row = await queryOne(
      `INSERT INTO ${OrganizationLocation.table} (
            OrganizationId, LocationName, LocationCode, Email,
            AddressLine1, AddressLine2, City, State, Country, PostalCode,
            TimeZone, Description, CreatedBy, ModifiedBy
       )
       OUTPUT ${ORGANIZATION_LOCATION_PUBLIC_PROPS.map((p) => `inserted.${OrganizationLocation.col(p)} AS ${p}`).join(', ')}
       VALUES (
            @organizationId, @locationName, @locationCode, @email,
            @addressLine1, @addressLine2, @city, @state, @country, @postalCode,
            @timeZone, @description, @actorId, @actorId
       )`,
      {
        ...OrganizationLocation.params({
          organizationId,
          locationName: input.locationName,
          locationCode: input.locationCode ?? null,
          email: input.email ?? null,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          country: input.country ?? null,
          postalCode: input.postalCode ?? null,
          timeZone: input.timeZone ?? null,
          description: input.description ?? null,
        }),
        actorId: OrganizationLocation.param('createdBy', actorId),
      },
    );

    return withNumericIds(row);
  } catch (error) {
    throw conflictFor(error, {
      nameMessage: MESSAGES.LOCATION_NAME_EXISTS,
      codeMessage: MESSAGES.LOCATION_CODE_EXISTS,
    });
  }
}

/** Full replace, same PUT semantics as updateOrganization. */
export async function updateLocation(actorId, organizationId, locationId, input) {
  let row;

  try {
    row = await queryOne(
      `UPDATE ${OrganizationLocation.table}
          SET LocationName = @locationName,
              LocationCode = @locationCode,
              Email        = @email,
              AddressLine1 = @addressLine1,
              AddressLine2 = @addressLine2,
              City         = @city,
              State        = @state,
              Country      = @country,
              PostalCode   = @postalCode,
              TimeZone     = @timeZone,
              Description  = @description,
              IsActive     = @isActive,
              ModifiedBy   = @actorId,
              ModifiedAt   = SYSUTCDATETIME()
        OUTPUT ${ORGANIZATION_LOCATION_PUBLIC_PROPS.map((p) => `inserted.${OrganizationLocation.col(p)} AS ${p}`).join(', ')}
        WHERE LocationId = @locationId
          AND OrganizationId = @organizationId
          AND DeletedAt IS NULL`,
      {
        ...OrganizationLocation.params({
          locationId,
          organizationId,
          locationName: input.locationName,
          locationCode: input.locationCode ?? null,
          email: input.email ?? null,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          country: input.country ?? null,
          postalCode: input.postalCode ?? null,
          timeZone: input.timeZone ?? null,
          description: input.description ?? null,
          isActive: input.isActive ?? true,
        }),
        actorId: OrganizationLocation.param('modifiedBy', actorId),
      },
    );
  } catch (error) {
    throw conflictFor(error, {
      nameMessage: MESSAGES.LOCATION_NAME_EXISTS,
      codeMessage: MESSAGES.LOCATION_CODE_EXISTS,
    });
  }

  if (!row) {
    throw ApiError.notFound(MESSAGES.LOCATION_NOT_FOUND);
  }

  return withNumericIds(row);
}

/**
 * Soft-deletes a location, unless somebody still works there.
 *
 * The headcount check is not belt-and-braces over the FOREIGN KEY: the key
 * cannot help here, because this is an UPDATE and the references stay valid.
 * Without the check, deleting a location would leave 57 employees pointing at
 * a row the UI no longer lists - and nothing would complain until somebody
 * asks why the location filter is empty.
 */
export async function deleteLocation(actorId, organizationId, locationId) {
  const assigned = await queryOne(
    `SELECT COUNT(*) AS assignedCount
       FROM ${EmployeeDetails.table}
      WHERE WorkLocationId = @locationId AND DeletedAt IS NULL`,
    // Typed from the EmployeeDetails side: WorkLocationId is the column being
    // compared, and it is the model that knows it is a BigInt.
    { locationId: EmployeeDetails.param('workLocationId', locationId) },
  );

  if (assigned && assigned.assignedCount > 0) {
    throw ApiError.conflict(MESSAGES.LOCATION_IN_USE, {
      code: ERROR_CODE.LOCATION_IN_USE,
      assignedEmployees: assigned.assignedCount,
    });
  }

  const row = await queryOne(
    `UPDATE ${OrganizationLocation.table}
        SET DeletedAt  = SYSUTCDATETIME(),
            ModifiedBy = @actorId,
            ModifiedAt = SYSUTCDATETIME()
      OUTPUT deleted.LocationId AS locationId, deleted.LocationName AS locationName
      WHERE LocationId = @locationId
        AND OrganizationId = @organizationId
        AND DeletedAt IS NULL`,
    {
      ...OrganizationLocation.params({ locationId, organizationId }),
      actorId: OrganizationLocation.param('modifiedBy', actorId),
    },
  );

  if (!row) {
    throw ApiError.notFound(MESSAGES.LOCATION_NOT_FOUND);
  }

  return withNumericIds(row);
}

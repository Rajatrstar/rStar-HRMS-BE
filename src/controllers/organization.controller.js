/**
 * Organisation controller: validate input, call the service, shape the reply.
 * No SQL and no business rules live here.
 *
 * The field rules below mirror db/migrations/005_organization.sql exactly -
 * every maxLength is the column width. A value that would be truncated by SQL
 * Server is rejected with a 400 naming the field instead, because a silently
 * shortened postcode is worse than a failed save.
 */
import * as organizationService from '../services/organization.service.js';
import { sendSuccess } from '../helpers/response.helper.js';
import { validateBody, validateParams } from '../helpers/validation.helper.js';
import { HTTP_STATUS, MESSAGES, ORGANIZATION_TYPES } from '../enums/index.js';

/** Shared by the organisation and location bodies - the same six columns. */
const ADDRESS_RULES = {
  addressLine1: { maxLength: 255 },
  addressLine2: { maxLength: 255 },
  city: { maxLength: 100 },
  state: { maxLength: 100 },
  country: { maxLength: 100 },
  postalCode: { maxLength: 20 },
};

/**
 * Name and contact email are the two the form marks with an asterisk; the
 * rest of the screen is optional and stays that way here.
 */
const ORGANIZATION_RULES = {
  organizationName: { required: true, maxLength: 200 },
  logoUrl: { url: true, maxLength: 2048 },
  website: { url: true, maxLength: 2048 },
  organizationType: { oneOf: ORGANIZATION_TYPES, maxLength: 100 },
  contactPerson: { maxLength: 150 },
  // Not `digits: true`: a contact number legitimately carries "+", spaces and
  // brackets, and rejecting "+1 630 555 0100" would be a bug, not a check.
  contactNumber: { maxLength: 20 },
  contactEmail: { required: true, email: true, lowercase: true, maxLength: 255 },
  ...ADDRESS_RULES,
};

const LOCATION_RULES = {
  locationName: { required: true, maxLength: 150 },
  locationCode: { maxLength: 50 },
  email: { email: true, lowercase: true, maxLength: 255 },
  ...ADDRESS_RULES,
  timeZone: { maxLength: 100 },
  description: { maxLength: 500 },
};

/** The id in the path. Shared, because four handlers need the same check. */
const ORGANIZATION_PARAM = { organizationId: { required: true, integer: true } };
const LOCATION_PARAMS = {
  organizationId: { required: true, integer: true },
  locationId: { required: true, integer: true },
};

/* -------------------------------------------------------------------------- */
/* Organisation                                                               */
/* -------------------------------------------------------------------------- */

/** GET /api/v1/organizations */
export async function list(req, res) {
  const data = await organizationService.listOrganizations();

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.ORGANIZATIONS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/**
 * GET /api/v1/organizations/types
 *
 * Served rather than hard-coded in the client, so the dropdown and the
 * validator cannot disagree about the spelling of "Information Technology".
 */
export async function types(req, res) {
  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.ORGANIZATION_TYPES_FETCHED,
    data: ORGANIZATION_TYPES,
  });
}

/** GET /api/v1/organizations/:organizationId */
export async function detail(req, res) {
  const { organizationId } = validateParams(req.params, ORGANIZATION_PARAM);

  const data = await organizationService.getOrganization(organizationId);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.ORGANIZATION_FETCHED,
    data,
  });
}

/** POST /api/v1/organizations */
export async function create(req, res) {
  const input = validateBody(req.body, ORGANIZATION_RULES);

  // req.access is attached by the permission guard and carries the resolved
  // EmployeeDetailId - the same number the token holds, already proven to
  // belong to a live employee.
  const data = await organizationService.createOrganization(req.access.employeeDetailId, input);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.ORGANIZATION_CREATED,
    data,
  });
}

/** PUT /api/v1/organizations/:organizationId */
export async function update(req, res) {
  const { organizationId } = validateParams(req.params, ORGANIZATION_PARAM);
  const input = validateBody(req.body, { ...ORGANIZATION_RULES, isActive: { boolean: true } });

  const data = await organizationService.updateOrganization(
    req.access.employeeDetailId,
    organizationId,
    input,
  );

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.ORGANIZATION_UPDATED,
    data,
  });
}

/* -------------------------------------------------------------------------- */
/* Locations                                                                  */
/* -------------------------------------------------------------------------- */

/** GET /api/v1/organizations/:organizationId/locations */
export async function listLocations(req, res) {
  const { organizationId } = validateParams(req.params, ORGANIZATION_PARAM);

  const data = await organizationService.listLocations(organizationId);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.LOCATIONS_FETCHED,
    data,
    // The grid's "Total Count" header, so it does not have to count the array
    // and get a different answer once this list is paginated.
    meta: { total: data.length },
  });
}

/** GET /api/v1/organizations/:organizationId/locations/:locationId */
export async function locationDetail(req, res) {
  const { organizationId, locationId } = validateParams(req.params, LOCATION_PARAMS);

  const data = await organizationService.getLocation(organizationId, locationId);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.LOCATION_FETCHED,
    data,
  });
}

/** POST /api/v1/organizations/:organizationId/locations */
export async function createLocation(req, res) {
  const { organizationId } = validateParams(req.params, ORGANIZATION_PARAM);
  const input = validateBody(req.body, LOCATION_RULES);

  const data = await organizationService.createLocation(
    req.access.employeeDetailId,
    organizationId,
    input,
  );

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.LOCATION_CREATED,
    data,
  });
}

/** PUT /api/v1/organizations/:organizationId/locations/:locationId */
export async function updateLocation(req, res) {
  const { organizationId, locationId } = validateParams(req.params, LOCATION_PARAMS);
  const input = validateBody(req.body, { ...LOCATION_RULES, isActive: { boolean: true } });

  const data = await organizationService.updateLocation(
    req.access.employeeDetailId,
    organizationId,
    locationId,
    input,
  );

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.LOCATION_UPDATED,
    data,
  });
}

/** DELETE /api/v1/organizations/:organizationId/locations/:locationId */
export async function deleteLocation(req, res) {
  const { organizationId, locationId } = validateParams(req.params, LOCATION_PARAMS);

  const data = await organizationService.deleteLocation(
    req.access.employeeDetailId,
    organizationId,
    locationId,
  );

  // 200 with the deleted row's identity, not 204: the client toast says
  // "India deleted", and a 204 would make it fetch the name it just lost.
  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.LOCATION_DELETED,
    data,
  });
}

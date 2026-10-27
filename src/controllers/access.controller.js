/**
 * User-access controller: one person's roles, groups and overrides, and the
 * signed-in person's own ACL. The actor is `req.access`, as elsewhere.
 */
import * as userAccessService from '../services/user-access.service.js';
import { sendSuccess } from '../helpers/response.helper.js';
import { validateBody, validateParams } from '../helpers/validation.helper.js';
import { withClears, assertSomethingToUpdate } from '../helpers/access-input.helper.js';
import { HTTP_STATUS, MESSAGES, OVERRIDE_EFFECT, PERMISSION_SCOPES } from '../enums/index.js';

const USER_PARAM = { employeeDetailId: { required: true, integer: true } };
const OVERRIDE_PARAMS = {
  employeeDetailId: { required: true, integer: true },
  overrideId: { required: true, integer: true },
};

/** GET /api/v1/access/my-permissions - any signed-in employee. */
export async function myPermissions(req, res) {
  const data = await userAccessService.getMyPermissions(req.access.employeeDetailId);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.MY_PERMISSIONS_FETCHED, data });
}

/** GET /api/v1/access/users/:employeeDetailId */
export async function user(req, res) {
  const { employeeDetailId } = validateParams(req.params, USER_PARAM);
  const data = await userAccessService.getUserAccess(employeeDetailId);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.USER_ACCESS_FETCHED, data });
}

/** GET /api/v1/access/users/:employeeDetailId/roles */
export async function roles(req, res) {
  const { employeeDetailId } = validateParams(req.params, USER_PARAM);
  const data = await userAccessService.getUserRoles(employeeDetailId);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.USER_ROLES_FETCHED, data });
}

/** PUT /api/v1/access/users/:employeeDetailId/roles { roleIds: [1, 4] } - full replace. */
export async function replaceRoles(req, res) {
  const { employeeDetailId } = validateParams(req.params, USER_PARAM);
  const { roleIds } = validateBody(req.body, {
    roleIds: { required: true, integerList: true, maxItems: 50 },
  });

  const data = await userAccessService.replaceUserRoles(req.access, employeeDetailId, roleIds);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.USER_ROLES_UPDATED, data });
}

/** GET /api/v1/access/users/:employeeDetailId/groups */
export async function groups(req, res) {
  const { employeeDetailId } = validateParams(req.params, USER_PARAM);
  const data = await userAccessService.getUserGroups(employeeDetailId);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.USER_GROUPS_FETCHED, data });
}

/** PUT /api/v1/access/users/:employeeDetailId/groups { groupIds: [2] } - full replace. */
export async function replaceGroups(req, res) {
  const { employeeDetailId } = validateParams(req.params, USER_PARAM);
  const { groupIds } = validateBody(req.body, {
    groupIds: { required: true, integerList: true, maxItems: 100 },
  });

  const data = await userAccessService.replaceUserGroups(req.access, employeeDetailId, groupIds);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.USER_GROUPS_UPDATED, data });
}

/** GET /api/v1/access/users/:employeeDetailId/overrides */
export async function overrides(req, res) {
  const { employeeDetailId } = validateParams(req.params, USER_PARAM);
  const data = await userAccessService.listOverrides(employeeDetailId);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.OVERRIDES_FETCHED, data });
}

/**
 * POST /api/v1/access/users/:employeeDetailId/overrides
 *   { permissionId, effect: 'GRANT'|'DENY', scope?, reason, expiresAt? }
 *
 * `reason` is required: an exception nobody can explain is the first thing an
 * auditor asks about. The column allows NULL; the API does not.
 */
export async function createOverride(req, res) {
  const { employeeDetailId } = validateParams(req.params, USER_PARAM);
  const input = validateBody(req.body, {
    permissionId: { required: true, integer: true },
    effect: { required: true, oneOf: Object.values(OVERRIDE_EFFECT) },
    scope: { oneOf: PERMISSION_SCOPES },
    reason: { required: true, maxLength: 255 },
    expiresAt: { datetime: true },
  });

  const data = await userAccessService.createOverride(req.access, employeeDetailId, input);

  return sendSuccess(res, { statusCode: HTTP_STATUS.CREATED, message: MESSAGES.OVERRIDE_CREATED, data });
}

/**
 * PATCH /api/v1/access/users/:employeeDetailId/overrides/:overrideId
 *   { scope?, reason?, expiresAt? }   expiresAt: null makes it permanent.
 */
export async function updateOverride(req, res) {
  const { employeeDetailId, overrideId } = validateParams(req.params, OVERRIDE_PARAMS);
  const input = withClears(
    req.body,
    validateBody(req.body, {
      scope: { oneOf: PERMISSION_SCOPES },
      reason: { maxLength: 255 },
      expiresAt: { datetime: true },
    }),
    ['expiresAt'],
  );
  assertSomethingToUpdate(input);

  const data = await userAccessService.updateOverride(req.access, employeeDetailId, overrideId, input);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.OVERRIDE_UPDATED, data });
}

/** DELETE /api/v1/access/users/:employeeDetailId/overrides/:overrideId */
export async function deleteOverride(req, res) {
  const { employeeDetailId, overrideId } = validateParams(req.params, OVERRIDE_PARAMS);
  const data = await userAccessService.deleteOverride(req.access, employeeDetailId, overrideId);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.OVERRIDE_REMOVED, data });
}

/** GET /api/v1/access/users/:employeeDetailId/effective-permissions */
export async function effectivePermissions(req, res) {
  const { employeeDetailId } = validateParams(req.params, USER_PARAM);
  const data = await userAccessService.getEffectivePermissions(employeeDetailId);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.EFFECTIVE_PERMISSIONS_FETCHED,
    data,
  });
}

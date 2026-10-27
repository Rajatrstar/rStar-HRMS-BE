/**
 * Role controller: validate input, call the service, shape the reply.
 *
 * Every handler that writes passes `req.access` - the resolved AccessContext
 * the permission guard attached - as the actor. The service needs the whole
 * context, not just an id, because the escalation check compares what is
 * being granted against what the actor holds.
 */
import * as roleService from '../services/role.service.js';
import { sendSuccess } from '../helpers/response.helper.js';
import { validateBody, validateParams } from '../helpers/validation.helper.js';
import {
  CODE_RULE,
  LIST_QUERY_RULES,
  PERMISSION_SET_RULES,
  withClears,
  assertSomethingToUpdate,
} from '../helpers/access-input.helper.js';
import { HTTP_STATUS, MESSAGES } from '../enums/index.js';

const ROLE_PARAM = { roleId: { required: true, integer: true } };

/** GET /api/v1/roles?page=&pageSize=&search= */
export async function list(req, res) {
  const filters = validateParams(req.query, LIST_QUERY_RULES);
  const { data, meta } = await roleService.listRoles(filters);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.ROLES_FETCHED, data, meta });
}

/** GET /api/v1/roles/:roleId */
export async function detail(req, res) {
  const { roleId } = validateParams(req.params, ROLE_PARAM);
  const data = await roleService.getRole(roleId);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.ROLE_FETCHED, data });
}

/** POST /api/v1/roles */
export async function create(req, res) {
  const input = validateBody(req.body, {
    roleCode: CODE_RULE,
    roleName: { required: true, maxLength: 100 },
    description: { maxLength: 255 },
  });

  const data = await roleService.createRole(req.access, input);

  return sendSuccess(res, { statusCode: HTTP_STATUS.CREATED, message: MESSAGES.ROLE_CREATED, data });
}

/** PATCH /api/v1/roles/:roleId - name, description, isActive. The code is immutable. */
export async function update(req, res) {
  const { roleId } = validateParams(req.params, ROLE_PARAM);
  const input = withClears(
    req.body,
    validateBody(req.body, {
      roleName: { maxLength: 100 },
      description: { maxLength: 255 },
      isActive: { boolean: true },
    }),
    ['description'],
  );
  assertSomethingToUpdate(input);

  const data = await roleService.updateRole(req.access, roleId, input);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.ROLE_UPDATED, data });
}

/** DELETE /api/v1/roles/:roleId */
export async function remove(req, res) {
  const { roleId } = validateParams(req.params, ROLE_PARAM);
  const data = await roleService.deleteRole(req.access, roleId);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.ROLE_DELETED, data });
}

/** GET /api/v1/roles/:roleId/permissions */
export async function permissions(req, res) {
  const { roleId } = validateParams(req.params, ROLE_PARAM);
  const data = await roleService.getRolePermissions(roleId);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.ROLE_PERMISSIONS_FETCHED,
    data,
  });
}

/** PUT /api/v1/roles/:roleId/permissions - full replace. */
export async function replacePermissions(req, res) {
  const { roleId } = validateParams(req.params, ROLE_PARAM);
  const input = validateBody(req.body, PERMISSION_SET_RULES);

  const data = await roleService.replaceRolePermissions(req.access, roleId, input);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.ROLE_PERMISSIONS_UPDATED,
    data,
  });
}

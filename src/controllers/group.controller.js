/**
 * Group controller: validate input, call the service, shape the reply.
 * The actor is `req.access`, as in role.controller.js.
 */
import * as groupService from '../services/group.service.js';
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

const GROUP_PARAM = { groupId: { required: true, integer: true } };
const MEMBER_PARAMS = {
  groupId: { required: true, integer: true },
  employeeDetailId: { required: true, integer: true },
};

/** GET /api/v1/groups?page=&pageSize=&search= */
export async function list(req, res) {
  const filters = validateParams(req.query, LIST_QUERY_RULES);
  const { data, meta } = await groupService.listGroups(filters);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.GROUPS_FETCHED, data, meta });
}

/** GET /api/v1/groups/:groupId */
export async function detail(req, res) {
  const { groupId } = validateParams(req.params, GROUP_PARAM);
  const data = await groupService.getGroup(groupId);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.GROUP_FETCHED, data });
}

/** POST /api/v1/groups */
export async function create(req, res) {
  const input = validateBody(req.body, {
    groupCode: CODE_RULE,
    groupName: { required: true, maxLength: 100 },
    description: { maxLength: 255 },
  });

  const data = await groupService.createGroup(req.access, input);

  return sendSuccess(res, { statusCode: HTTP_STATUS.CREATED, message: MESSAGES.GROUP_CREATED, data });
}

/** PATCH /api/v1/groups/:groupId - name, description, isActive. */
export async function update(req, res) {
  const { groupId } = validateParams(req.params, GROUP_PARAM);
  const input = withClears(
    req.body,
    validateBody(req.body, {
      groupName: { maxLength: 100 },
      description: { maxLength: 255 },
      isActive: { boolean: true },
    }),
    ['description'],
  );
  assertSomethingToUpdate(input);

  const data = await groupService.updateGroup(req.access, groupId, input);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.GROUP_UPDATED, data });
}

/** DELETE /api/v1/groups/:groupId */
export async function remove(req, res) {
  const { groupId } = validateParams(req.params, GROUP_PARAM);
  const data = await groupService.deleteGroup(req.access, groupId);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.GROUP_DELETED, data });
}

/** GET /api/v1/groups/:groupId/permissions */
export async function permissions(req, res) {
  const { groupId } = validateParams(req.params, GROUP_PARAM);
  const data = await groupService.getGroupPermissions(groupId);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.GROUP_PERMISSIONS_FETCHED,
    data,
  });
}

/** PUT /api/v1/groups/:groupId/permissions - full replace. */
export async function replacePermissions(req, res) {
  const { groupId } = validateParams(req.params, GROUP_PARAM);
  const input = validateBody(req.body, PERMISSION_SET_RULES);

  const data = await groupService.replaceGroupPermissions(req.access, groupId, input);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.GROUP_PERMISSIONS_UPDATED,
    data,
  });
}

/** GET /api/v1/groups/:groupId/members?search= */
export async function members(req, res) {
  const { groupId } = validateParams(req.params, GROUP_PARAM);
  const filters = validateParams(req.query, { search: { maxLength: 100 } });

  const data = await groupService.listMembers(groupId, filters);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.GROUP_MEMBERS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** POST /api/v1/groups/:groupId/members { employeeIds: [12, 13] } */
export async function addMembers(req, res) {
  const { groupId } = validateParams(req.params, GROUP_PARAM);
  // `employeeIds` to match the frontend contract; the values are
  // EmployeeDetailIds, the only employee id this API knows.
  const { employeeIds } = validateBody(req.body, {
    employeeIds: { required: true, integerList: true, maxItems: 500 },
  });

  const data = await groupService.addMembers(req.access, groupId, employeeIds);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.GROUP_MEMBERS_UPDATED,
    data,
  });
}

/** DELETE /api/v1/groups/:groupId/members/:employeeDetailId */
export async function removeMember(req, res) {
  const { groupId, employeeDetailId } = validateParams(req.params, MEMBER_PARAMS);

  const data = await groupService.removeMember(req.access, groupId, employeeDetailId);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.GROUP_MEMBER_REMOVED,
    data,
  });
}

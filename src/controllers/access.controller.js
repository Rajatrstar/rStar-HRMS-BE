/**
 * Access-control controller: validate input, call the service, shape the
 * reply. No SQL and no business rules live here.
 *
 * Three audiences, and it is worth knowing which handler serves which:
 *
 *   - the ADMINISTRATOR's screens: modules, groups, rights, membership
 *   - EVERY signed-in user, on login: /me and /menu
 *   - EVERY page, as it opens: /page
 *
 * The last one is the small endpoint that makes the frontend simple. A screen
 * asks "what may I do here?" with the path it already has, and renders its
 * buttons from the answer - instead of each screen hard-coding which right
 * governs it and drifting from the backend the first time one changes.
 */
import * as groupService from '../services/group.service.js';
import { buildMenu, pageRights, resolveAccess } from '../services/access-control.service.js';
import { sendSuccess } from '../helpers/response.helper.js';
import { validateBody, validateParams } from '../helpers/validation.helper.js';
import { ApiError } from '../utils/api-error.js';
import { HTTP_STATUS, MESSAGES, ERROR_CODE } from '../enums/index.js';
import { ACTIONS, ACTION_PROP, MODULE_BY_ID } from '../enums/module.enum.js';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

const GROUP_PARAM = { groupId: { required: true, integer: true } };
const EMPLOYEE_PARAM = { employeeDetailId: { required: true, integer: true } };

/**
 * Name is the only required field. Description is optional and rights may be
 * omitted entirely - a group with no rights is a legitimate thing to create
 * first and fill in afterwards, which is how the screen is actually used.
 */
const GROUP_RULES = {
  groupName: { required: true, maxLength: 100 },
  description: { maxLength: 255 },
  isActive: { boolean: true },
};

/** Clamped, not rejected: a client asking for 10 000 rows gets 200, not a 400. */
function pagination(query) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const requested = Number.parseInt(query.pageSize ?? String(DEFAULT_PAGE_SIZE), 10);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requested || DEFAULT_PAGE_SIZE));
  return { page, pageSize };
}

const pageMeta = (page, pageSize, total) => ({
  page,
  pageSize,
  total,
  totalPages: Math.max(1, Math.ceil(total / pageSize)),
});

/* -------------------------------------------------------------------------- */
/* What the signed-in user may do                                             */
/* -------------------------------------------------------------------------- */

/**
 * GET /access/me - the whole picture for the logged-in user.
 *
 * Returned as a module-keyed map as well as a list, because the two have
 * different jobs: the list renders an admin view, the map is what a frontend
 * guard does an O(1) lookup in on every route change.
 */
export async function me(req, res) {
  const access = req.access;

  const modules = await groupService.listModules();
  const rights = modules.map((module) => ({
    moduleId: module.moduleId,
    moduleCode: module.moduleCode,
    moduleName: module.moduleName,
    path: module.routePath,
    ...access.rightsFor(module.moduleId),
  }));

  const byCode = Object.fromEntries(
    rights.map((row) => [
      row.moduleCode,
      Object.fromEntries(ACTIONS.map((action) => [ACTION_PROP[action], row[ACTION_PROP[action]]])),
    ]),
  );

  return sendSuccess(res, {
    message: MESSAGES.MY_ACCESS_FETCHED,
    data: {
      employeeDetailId: access.employeeDetailId,
      group: access.groupId === null ? null : { groupId: access.groupId, groupName: access.groupName },
      isSystemGroup: access.isSystemGroup,
      modules: rights,
      rightsByModule: byCode,
    },
  });
}

/** GET /access/menu - the navigation this user may see, as a tree. */
export async function menu(req, res) {
  return sendSuccess(res, {
    message: MESSAGES.MENU_FETCHED,
    data: await buildMenu(req.access),
  });
}

/**
 * GET /access/page?path=/employees  (or ?moduleCode=EMPLOYEES, or ?moduleId=11)
 *
 * The menu-binding call. A page that is not in the catalog answers 404 rather
 * than an all-false matrix: "you may do nothing here" and "there is no such
 * page" are different problems, and returning the first for the second sends
 * a frontend developer hunting through group rights for a typo in a URL.
 */
export async function page(req, res) {
  const { path, moduleCode, moduleId } = req.query;

  if (!path && !moduleCode && moduleId === undefined) {
    throw ApiError.badRequest(MESSAGES.VALIDATION_FAILED, {
      code: ERROR_CODE.VALIDATION_FAILED,
      details: { path: 'one of path, moduleCode or moduleId is required' },
    });
  }

  const found = await pageRights(req.access, { path, moduleCode, moduleId });
  if (!found) {
    throw ApiError.notFound(MESSAGES.PAGE_NOT_MAPPED, {
      code: ERROR_CODE.UNKNOWN_MODULE,
      path: path ?? moduleCode ?? moduleId,
    });
  }

  return sendSuccess(res, { message: MESSAGES.PAGE_ACCESS_FETCHED, data: found });
}

/* -------------------------------------------------------------------------- */
/* Modules                                                                    */
/* -------------------------------------------------------------------------- */

/** GET /access/modules - the catalog the rights matrix is drawn from. */
export async function modules(req, res) {
  const includeInactive = req.query.includeInactive === 'true';
  return sendSuccess(res, {
    message: MESSAGES.MODULES_FETCHED,
    data: await groupService.listModules({ includeInactive }),
  });
}

/* -------------------------------------------------------------------------- */
/* Groups                                                                     */
/* -------------------------------------------------------------------------- */

/** GET /access/groups */
export async function listGroups(req, res) {
  const { page: pageNumber, pageSize } = pagination(req.query);
  const search = (req.query.search ?? '').trim() || null;
  const includeInactive = req.query.includeInactive === 'true';

  const { groups, total } = await groupService.listGroups({
    search,
    includeInactive,
    page: pageNumber,
    pageSize,
  });

  return sendSuccess(res, {
    message: MESSAGES.GROUPS_FETCHED,
    data: groups,
    meta: pageMeta(pageNumber, pageSize, total),
  });
}

/** GET /access/groups/:groupId - the group and its complete rights matrix. */
export async function groupDetail(req, res) {
  const { groupId } = validateParams(req.params, GROUP_PARAM);
  return sendSuccess(res, {
    message: MESSAGES.GROUP_FETCHED,
    data: await groupService.getGroup(groupId),
  });
}

/** POST /access/groups - create, with the rights matrix in the same call. */
export async function createGroup(req, res) {
  const body = validateBody(req.body, GROUP_RULES);
  const created = await groupService.createGroup(
    { ...body, rights: req.body?.rights },
    req.employee.employeeDetailId,
  );
  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.GROUP_CREATED,
    data: created,
  });
}

/** PUT /access/groups/:groupId - rename, and/or rewrite the matrix. */
export async function updateGroup(req, res) {
  const { groupId } = validateParams(req.params, GROUP_PARAM);
  const body = validateBody(req.body, GROUP_RULES);
  const updated = await groupService.updateGroup(
    groupId,
    { ...body, rights: req.body?.rights },
    req.employee.employeeDetailId,
  );
  return sendSuccess(res, { message: MESSAGES.GROUP_UPDATED, data: updated });
}

/**
 * PUT /access/groups/:groupId/rights - the matrix alone.
 *
 * Separate from the group update because it is a separate screen action with
 * a separate failure mode: saving a 60-row matrix should not be refused
 * because the name field happens to be blank in the form state.
 */
export async function updateGroupRights(req, res) {
  const { groupId } = validateParams(req.params, GROUP_PARAM);
  const updated = await groupService.setGroupRights(
    groupId,
    req.body?.rights,
    req.employee.employeeDetailId,
  );
  return sendSuccess(res, { message: MESSAGES.GROUP_RIGHTS_UPDATED, data: updated });
}

/** DELETE /access/groups/:groupId - refused while anybody is in it. */
export async function deleteGroup(req, res) {
  const { groupId } = validateParams(req.params, GROUP_PARAM);
  return sendSuccess(res, {
    message: MESSAGES.GROUP_DELETED,
    data: await groupService.deleteGroup(groupId, req.employee.employeeDetailId),
  });
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* -------------------------------------------------------------------------- */

/** GET /access/groups/:groupId/members */
export async function groupMembers(req, res) {
  const { groupId } = validateParams(req.params, GROUP_PARAM);
  const { page: pageNumber, pageSize } = pagination(req.query);

  const { group, members, total } = await groupService.listGroupMembers(groupId, {
    page: pageNumber,
    pageSize,
  });

  return sendSuccess(res, {
    message: MESSAGES.GROUP_MEMBERS_FETCHED,
    data: { group, members },
    meta: pageMeta(pageNumber, pageSize, total),
  });
}

/**
 * POST /access/groups/:groupId/members - put several employees in at once.
 *
 * Body: { employeeDetailIds: [1, 2, 3] }
 */
export async function assignMembers(req, res) {
  const { groupId } = validateParams(req.params, GROUP_PARAM);
  const ids = req.body?.employeeDetailIds;

  if (!Array.isArray(ids) || ids.length === 0) {
    throw ApiError.badRequest(MESSAGES.VALIDATION_FAILED, {
      code: ERROR_CODE.VALIDATION_FAILED,
      details: { employeeDetailIds: 'must be a non-empty array of employee ids' },
    });
  }
  if (ids.some((id) => !Number.isInteger(Number(id)))) {
    throw ApiError.badRequest(MESSAGES.VALIDATION_FAILED, {
      code: ERROR_CODE.VALIDATION_FAILED,
      details: { employeeDetailIds: 'every id must be a whole number' },
    });
  }

  return sendSuccess(res, {
    message: MESSAGES.MEMBERS_ASSIGNED,
    data: await groupService.assignEmployeesToGroup(groupId, ids, req.employee.employeeDetailId),
  });
}

/**
 * PUT /access/employees/:employeeDetailId/group  body { groupId }
 *
 * `groupId: null` removes them from every group, which is the same operation:
 * "which group is this person in" has one answer, so setting it is one call.
 */
export async function setEmployeeGroup(req, res) {
  const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);
  const raw = req.body?.groupId;

  if (raw !== null && raw !== undefined && !Number.isInteger(Number(raw))) {
    throw ApiError.badRequest(MESSAGES.VALIDATION_FAILED, {
      code: ERROR_CODE.VALIDATION_FAILED,
      details: { groupId: 'must be a whole number, or null to remove the group' },
    });
  }
  const groupId = raw === null || raw === undefined ? null : Number(raw);

  const result = await groupService.assignEmployeeGroup(
    employeeDetailId,
    groupId,
    req.employee.employeeDetailId,
  );

  return sendSuccess(res, {
    message: groupId === null ? MESSAGES.GROUP_REMOVED : MESSAGES.GROUP_ASSIGNED,
    data: result,
  });
}

/** DELETE /access/employees/:employeeDetailId/group - take them out of theirs. */
export async function removeEmployeeGroup(req, res) {
  const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);
  return sendSuccess(res, {
    message: MESSAGES.GROUP_REMOVED,
    data: await groupService.assignEmployeeGroup(
      employeeDetailId,
      null,
      req.employee.employeeDetailId,
    ),
  });
}

export { MODULE_BY_ID };

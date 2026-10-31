/**
 * Master-data controller: validate input, call the service, shape the reply.
 * No SQL and no business rules live here.
 *
 * ONE SET OF HANDLERS, BUILT PER RESOURCE. `buildMasterDataController(resource)`
 * closes over a registry entry and returns the five handlers for that lookup
 * list, so the route file wires parent departments and leave types from the
 * same code. The resource is baked in at wiring time rather than read from
 * the URL at request time, which is what keeps each route's permission guard
 * a static, auditable `requireAccess(MODULE.DEPARTMENTS, ACTION.EDIT)`.
 *
 * The field rules mirror db/migrations/009_master_data.sql: every maxLength is
 * the column width, so a value SQL Server would truncate is rejected with a
 * 400 naming the field instead of being silently shortened.
 */
import * as masterDataService from '../services/master-data.service.js';
import { sendSuccess } from '../helpers/response.helper.js';
import { validateBody, validateParams } from '../helpers/validation.helper.js';
import { HTTP_STATUS, MASTER_DATA_LIMITS } from '../enums/index.js';

/** The id in the path. `:id` on all five - see ROUTES.ORGANIZATIONS.MASTER_DATA. */
const ID_PARAM = { id: { required: true, integer: true } };

/**
 * The list screen's filters, all optional.
 *
 * `search` is capped well below the Name column's width: it is a fragment to
 * match, not a name, and the service wraps it in % before binding it as an
 * NVARCHAR(150) parameter.
 */
const LIST_QUERY_RULES = {
  isActive: { boolean: true },
  search: { maxLength: 100 },
  parentDepartmentId: { integer: true },
};

/** Name is the only required field; a lookup row is a name and little else. */
function bodyRules(resource) {
  const rules = {
    name: { required: true, maxLength: MASTER_DATA_LIMITS.NAME },
    description: { maxLength: MASTER_DATA_LIMITS.DESCRIPTION },
  };

  if (resource.hasParentDepartment) {
    // Optional: a department at the top of the tree has no parent.
    rules.parentDepartmentId = { integer: true };
  }

  return rules;
}

/**
 * The five handlers for one lookup list.
 *
 * @param {object} resource an entry from MASTER_DATA_RESOURCES
 */
export function buildMasterDataController(resource) {
  const CREATE_RULES = bodyRules(resource);
  // isActive is editable but not creatable: see createMasterData.
  const UPDATE_RULES = { ...CREATE_RULES, isActive: { boolean: true } };

  const LIST_RULES = resource.hasParentDepartment
    ? LIST_QUERY_RULES
    : // Offering a parent filter on a flat list would answer 200 and ignore
      // it, which reads to a client as "no departments match".
      { isActive: LIST_QUERY_RULES.isActive, search: LIST_QUERY_RULES.search };

  /** GET /api/v1/organizations/<resource> */
  async function list(req, res) {
    const filters = validateParams(req.query, LIST_RULES);

    const data = await masterDataService.listMasterData(resource, filters);

    return sendSuccess(res, {
      statusCode: HTTP_STATUS.OK,
      message: resource.messages.listed,
      data,
      // The grid's "Total Count" header, so it does not have to count the
      // array and get a different answer once this list is paginated.
      meta: { total: data.length },
    });
  }

  /** GET /api/v1/organizations/<resource>/:id */
  async function detail(req, res) {
    const { id } = validateParams(req.params, ID_PARAM);

    const data = await masterDataService.getMasterData(resource, id);

    return sendSuccess(res, {
      statusCode: HTTP_STATUS.OK,
      message: resource.messages.fetched,
      data,
    });
  }

  /** POST /api/v1/organizations/<resource> */
  async function create(req, res) {
    const input = validateBody(req.body, CREATE_RULES);

    // req.access is attached by the permission guard and carries the resolved
    // EmployeeDetailId - already proven to belong to a live employee.
    const data = await masterDataService.createMasterData(
      resource,
      req.access.employeeDetailId,
      input,
    );

    return sendSuccess(res, {
      statusCode: HTTP_STATUS.CREATED,
      message: resource.messages.created,
      data,
    });
  }

  /** PUT /api/v1/organizations/<resource>/:id */
  async function update(req, res) {
    const { id } = validateParams(req.params, ID_PARAM);
    const input = validateBody(req.body, UPDATE_RULES);

    const data = await masterDataService.updateMasterData(
      resource,
      req.access.employeeDetailId,
      id,
      input,
    );

    return sendSuccess(res, {
      statusCode: HTTP_STATUS.OK,
      message: resource.messages.updated,
      data,
    });
  }

  /** DELETE /api/v1/organizations/<resource>/:id */
  async function remove(req, res) {
    const { id } = validateParams(req.params, ID_PARAM);

    const data = await masterDataService.deleteMasterData(
      resource,
      req.access.employeeDetailId,
      id,
    );

    // 200 with the deleted row's identity, not 204: the client toast says
    // "QA deleted", and a 204 would make it fetch the name it just lost.
    return sendSuccess(res, {
      statusCode: HTTP_STATUS.OK,
      message: resource.messages.deleted,
      data,
    });
  }

  return { list, detail, create, update, remove };
}

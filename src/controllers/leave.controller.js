/**
 * Leave controller: validate input, call the service, shape the reply.
 * No SQL and no business rules live here.
 *
 * SAME SELF / TEAM SPLIT AS THE ATTENDANCE CONTROLLER, and for the same
 * reason: every `me*` handler reads req.access.employeeDetailId and never
 * takes an employee id from the request, so there is no path by which
 * /leave/me/dashboard can answer for somebody else.
 *
 * APPROVAL IS TWO SEPARATE CHECKS, and both are needed:
 *
 *   the MODULE RIGHT      may this person approve leave at all?
 *                         Enforced by requireAccess in the route file.
 *   the ROW-LEVEL RULE    whose leave may they approve?
 *                         Enforced in the service, which refuses a request
 *                         from somebody who is not the employee's manager.
 *
 * Holding TEAM_LEAVE:EDIT says you may approve leave. It does not say whose,
 * and no module right could - which is exactly why the second check is not
 * optional.
 */
import * as leaveService from '../services/leave.service.js';
import * as policyService from '../services/leave-policy.service.js';
import * as cycleService from '../services/leave-cycle.service.js';
import * as compOffService from '../services/comp-off.service.js';
import * as confirmationService from '../services/confirmation.service.js';
import { sendSuccess } from '../helpers/response.helper.js';
import { validateBody, validateParams } from '../helpers/validation.helper.js';
import { ApiError } from '../utils/api-error.js';
import {
  HTTP_STATUS,
  MESSAGES,
  ERROR_CODE,
  MODULE,
  ACTION,
  DAY_PART,
  CYCLE_TYPE,
  POLICY_CYCLE_TYPE,
  ACCRUAL_FREQUENCY,
  ACCRUAL_ANCHOR,
  SANDWICH_MODE,
  COMP_OFF_REQUEST_STATUS,
  APPROVER_ROLE,
} from '../enums/index.js';
import { today, addDays } from '../helpers/date.helper.js';

/* -------------------------------------------------------------------------
   Shared
   ------------------------------------------------------------------------- */

const REQUEST_PARAM = { leaveRequestId: { required: true, integer: true } };
const EMPLOYEE_PARAM = { employeeDetailId: { required: true, integer: true } };

/** Whose rows this caller may see - the same shape as teamScope() in attendance. */
function teamScope(req) {
  const isHr =
    req.access.can(MODULE.LEAVE_POLICY, ACTION.VIEW) ||
    req.access.can(MODULE.LEAVE_BALANCE, ACTION.VIEW);

  return isHr ? null : req.access.employeeDetailId;
}

/** The capacity somebody is acting in, recorded on the approval trail. */
function approverRole(req) {
  if (req.access.isSystemGroup) return APPROVER_ROLE.ADMIN;
  if (req.access.can(MODULE.LEAVE_POLICY, ACTION.EDIT)) return APPROVER_ROLE.HR_ADMIN;
  if (req.access.can(MODULE.LEAVE_BALANCE, ACTION.EDIT)) return APPROVER_ROLE.HR;
  return APPROVER_ROLE.MANAGER;
}

/* -------------------------------------------------------------------------
   Self service - MODULE.MY_LEAVE
   ------------------------------------------------------------------------- */

/** GET /api/v1/leave/me/dashboard - the tiles of section 10. */
export async function meDashboard(req, res) {
  const data = await leaveService.dashboardFor(req.access.employeeDetailId);
  return sendSuccess(res, { message: MESSAGES.LEAVE_DASHBOARD_FETCHED, data });
}

/** GET /api/v1/leave/me/types - what I may apply for, with the rules. */
export async function meTypes(req, res) {
  const data = await policyService.resolveForEmployee(req.access.employeeDetailId);
  return sendSuccess(res, {
    message: MESSAGES.LEAVE_TYPES_AVAILABLE_FETCHED,
    data,
    meta: { total: data.length },
  });
}

const APPLY_RULES = {
  leaveTypeId: { required: true, integer: true },
  fromDate: { required: true, date: true },
  toDate: { required: true, date: true },
  dayPart: { oneOf: Object.values(DAY_PART) },
  reason: { required: true, maxLength: 1000 },
  contactDuringLeave: { maxLength: 100 },
  documentUrl: { url: true, maxLength: 2048 },
};

/**
 * POST /api/v1/leave/me/preview
 *
 * The charge preview, before anybody commits. Exactly the calculation the
 * apply path runs, so what the confirmation dialog says is what gets
 * charged - including how many days fall through to LWP.
 */
export async function mePreview(req, res) {
  const input = validateBody(req.body, {
    leaveTypeId: { required: true, integer: true },
    fromDate: { required: true, date: true },
    toDate: { required: true, date: true },
    dayPart: { oneOf: Object.values(DAY_PART) },
  });

  if (input.toDate < input.fromDate) {
    throw ApiError.badRequest(MESSAGES.ATTENDANCE_DATE_RANGE, {
      code: ERROR_CODE.INVALID_DATE_RANGE,
    });
  }

  const data = await leaveService.previewRequest(req.access.employeeDetailId, input);
  return sendSuccess(res, { message: MESSAGES.LEAVE_PREVIEW_FETCHED, data });
}

/** POST /api/v1/leave/requests */
export async function apply(req, res) {
  const input = validateBody(req.body, APPLY_RULES);

  if (input.toDate < input.fromDate) {
    throw ApiError.badRequest(MESSAGES.ATTENDANCE_DATE_RANGE, {
      code: ERROR_CODE.INVALID_DATE_RANGE,
    });
  }

  const data = await leaveService.applyForLeave(
    req.access.employeeDetailId,
    req.access.employeeDetailId,
    input,
  );

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.LEAVE_REQUEST_CREATED,
    data,
  });
}

/** GET /api/v1/leave/me/requests?status=&from=&to= */
export async function meRequests(req, res) {
  const filters = validateParams(req.query, {
    status: { maxLength: 20 },
    from: { date: true },
    to: { date: true },
  });

  const data = await leaveService.listForEmployee(req.access.employeeDetailId, {
    status: filters.status ?? null,
    fromDate: filters.from ?? null,
    toDate: filters.to ?? null,
  });

  return sendSuccess(res, {
    message: MESSAGES.LEAVE_REQUESTS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** GET /api/v1/leave/me/ledger?leaveTypeId=&leaveCycleId= */
export async function meLedger(req, res) {
  const filters = validateParams(req.query, {
    leaveTypeId: { integer: true },
    leaveCycleId: { integer: true },
  });

  const data = await leaveService.ledgerFor(req.access.employeeDetailId, {
    leaveTypeId: filters.leaveTypeId ?? null,
    leaveCycleId: filters.leaveCycleId ?? null,
  });

  return sendSuccess(res, {
    message: MESSAGES.LEAVE_LEDGER_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** GET /api/v1/leave/me/balance?leaveTypeId=&leaveCycleId= */
export async function meBalance(req, res) {
  const { leaveTypeId, leaveCycleId } = validateParams(req.query, {
    leaveTypeId: { required: true, integer: true },
    leaveCycleId: { required: true, integer: true },
  });

  const data = await leaveService.balanceFor(req.access.employeeDetailId, leaveTypeId, leaveCycleId);
  return sendSuccess(res, { message: MESSAGES.LEAVE_BALANCE_FETCHED, data });
}

/** GET /api/v1/leave/requests/:leaveRequestId */
export async function requestDetail(req, res) {
  const { leaveRequestId } = validateParams(req.params, REQUEST_PARAM);
  const data = await leaveService.requestDetail(leaveRequestId);

  /*
    A request belongs either to the caller or to somebody they may approve
    for. Without this, any signed-in employee who may see their OWN leave
    could read anybody's by guessing an id - the module right says "you may
    see leave", not "you may see this leave".

    404 rather than 403: the caller has no business learning that the
    request exists.
  */
  const isOwn = data.employeeDetailId === req.access.employeeDetailId;
  const mayApprove = req.access.can(MODULE.TEAM_LEAVE, ACTION.VIEW);

  if (!isOwn && !mayApprove) {
    throw ApiError.notFound(MESSAGES.LEAVE_REQUEST_NOT_FOUND, {
      code: ERROR_CODE.LEAVE_REQUEST_NOT_FOUND,
    });
  }

  return sendSuccess(res, { message: MESSAGES.LEAVE_REQUEST_FETCHED, data });
}

/** PUT /api/v1/leave/requests/:leaveRequestId/cancel */
export async function cancel(req, res) {
  const { leaveRequestId } = validateParams(req.params, REQUEST_PARAM);
  const { reason } = validateBody(req.body, { reason: { maxLength: 500 } });

  const data = await leaveService.cancel(
    req.access.employeeDetailId,
    req.access.employeeDetailId,
    leaveRequestId,
    { reason },
  );

  return sendSuccess(res, { message: MESSAGES.LEAVE_REQUEST_CANCELLED, data });
}

/** PUT /api/v1/leave/requests/:leaveRequestId/withdraw */
export async function withdraw(req, res) {
  const { leaveRequestId } = validateParams(req.params, REQUEST_PARAM);
  const { reason } = validateBody(req.body, { reason: { maxLength: 500 } });

  const data = await leaveService.withdraw(
    req.access.employeeDetailId,
    req.access.employeeDetailId,
    leaveRequestId,
    { reason },
  );

  return sendSuccess(res, { message: MESSAGES.LEAVE_REQUEST_WITHDRAWN, data });
}

/* -------------------------------------------------------------------------
   Approvals - MODULE.TEAM_LEAVE
   ------------------------------------------------------------------------- */

/** GET /api/v1/leave/requests/pending */
export async function pending(req, res) {
  const data = await leaveService.listPending({ managerId: teamScope(req) });
  return sendSuccess(res, {
    message: MESSAGES.LEAVE_REQUESTS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** PUT /api/v1/leave/requests/:leaveRequestId/approve */
export async function approve(req, res) {
  const { leaveRequestId } = validateParams(req.params, REQUEST_PARAM);
  const { remarks } = validateBody(req.body, { remarks: { maxLength: 1000 } });

  const data = await leaveService.approve(req.access.employeeDetailId, leaveRequestId, {
    remarks,
    approverRole: approverRole(req),
  });

  return sendSuccess(res, { message: MESSAGES.LEAVE_REQUEST_APPROVED, data });
}

/** PUT /api/v1/leave/requests/:leaveRequestId/reject */
export async function reject(req, res) {
  const { leaveRequestId } = validateParams(req.params, REQUEST_PARAM);
  const { remarks } = validateBody(req.body, { remarks: { maxLength: 1000 } });

  const data = await leaveService.reject(req.access.employeeDetailId, leaveRequestId, {
    remarks,
    approverRole: approverRole(req),
  });

  return sendSuccess(res, { message: MESSAGES.LEAVE_REQUEST_REJECTED, data });
}

/** GET /api/v1/leave/team/calendar?from=&to= */
export async function teamCalendar(req, res) {
  const filters = validateParams(req.query, {
    from: { date: true },
    to: { date: true },
    locationId: { integer: true },
  });

  const fromDate = filters.from ?? today();
  const toDate = filters.to ?? addDays(fromDate, 30);

  const data = await leaveService.teamCalendar({
    fromDate,
    toDate,
    managerId: teamScope(req),
    locationId: filters.locationId ?? null,
  });

  return sendSuccess(res, {
    message: MESSAGES.LEAVE_REQUESTS_FETCHED,
    data,
    meta: { fromDate, toDate, total: data.length },
  });
}

/** GET /api/v1/leave/team/requests?employeeDetailId= */
export async function teamRequests(req, res) {
  const { employeeDetailId } = validateParams(req.query, {
    employeeDetailId: { required: true, integer: true },
  });

  const data = await leaveService.listForEmployee(employeeDetailId);
  return sendSuccess(res, {
    message: MESSAGES.LEAVE_REQUESTS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/* -------------------------------------------------------------------------
   Cycles - MODULE.LEAVE_POLICY
   ------------------------------------------------------------------------- */

/** GET /api/v1/leave/cycles?cycleType= */
export async function listCycles(req, res) {
  const { cycleType } = validateParams(req.query, {
    cycleType: { oneOf: Object.values(CYCLE_TYPE) },
  });

  const data = await cycleService.listCycles({ cycleType: cycleType ?? null });
  return sendSuccess(res, {
    message: MESSAGES.LEAVE_CYCLES_FETCHED,
    data,
    meta: { total: data.length, suggestions: {
      financial: cycleService.suggestCycle(CYCLE_TYPE.FINANCIAL),
      calendar: cycleService.suggestCycle(CYCLE_TYPE.CALENDAR),
    } },
  });
}

/** POST /api/v1/leave/cycles */
export async function createCycle(req, res) {
  const input = validateBody(req.body, {
    cycleType: { required: true, oneOf: Object.values(CYCLE_TYPE) },
    cycleLabel: { required: true, maxLength: 20 },
    startDate: { required: true, date: true },
    endDate: { required: true, date: true },
  });

  const data = await cycleService.createCycle(req.access.employeeDetailId, input);
  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.LEAVE_CYCLE_CREATED,
    data,
  });
}

/** PUT /api/v1/leave/cycles/:leaveCycleId */
export async function updateCycle(req, res) {
  const { leaveCycleId } = validateParams(req.params, {
    leaveCycleId: { required: true, integer: true },
  });
  const input = validateBody(req.body, {
    cycleLabel: { maxLength: 20 },
    startDate: { date: true },
    endDate: { date: true },
  });

  const data = await cycleService.updateCycle(req.access.employeeDetailId, leaveCycleId, input);
  return sendSuccess(res, { message: MESSAGES.LEAVE_CYCLE_UPDATED, data });
}

/** PUT /api/v1/leave/cycles/:leaveCycleId/close */
export async function closeCycle(req, res) {
  const { leaveCycleId } = validateParams(req.params, {
    leaveCycleId: { required: true, integer: true },
  });

  const data = await cycleService.closeCycle(req.access.employeeDetailId, leaveCycleId);
  return sendSuccess(res, { message: MESSAGES.LEAVE_CYCLE_CLOSED, data });
}

/* -------------------------------------------------------------------------
   Policies - MODULE.LEAVE_POLICY
   ------------------------------------------------------------------------- */

const POLICY_RULES = {
  leaveTypeId: { required: true, integer: true },
  locationId: { integer: true },
  employmentType: { maxLength: 30 },
  cycleType: { oneOf: Object.values(POLICY_CYCLE_TYPE) },
  availableDuringProbation: { boolean: true },
  visibleDuringProbation: { boolean: true },
  isPaid: { boolean: true },
  tracksBalance: { boolean: true },
  accrualFrequency: { oneOf: Object.values(ACCRUAL_FREQUENCY) },
  accrualDays: { decimal: true, min: 0, max: 999 },
  accrualAnchor: { oneOf: Object.values(ACCRUAL_ANCHOR) },
  proRateOnJoining: { boolean: true },
  annualQuota: { decimal: true, min: 0, max: 999 },
  maxCarryForward: { decimal: true, min: 0, max: 999 },
  allowHalfDay: { boolean: true },
  allowBackdated: { boolean: true },
  minNoticeDays: { integer: true, min: 0 },
  requiresDocumentAfterDays: { integer: true, min: 1 },
  sandwichRuleId: { integer: true },
  validityDays: { integer: true, min: 1 },
  requiresSecondApproval: { boolean: true },
  effectiveFrom: { date: true },
  effectiveTo: { date: true },
};

/** GET /api/v1/leave/policies */
export async function listPolicies(req, res) {
  const filters = validateParams(req.query, {
    leaveTypeId: { integer: true },
    onDate: { date: true },
  });

  const data = await policyService.listPolicies({
    leaveTypeId: filters.leaveTypeId ?? null,
    onDate: filters.onDate ?? null,
  });

  return sendSuccess(res, {
    message: MESSAGES.LEAVE_POLICIES_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** GET /api/v1/leave/policies/:leavePolicyId */
export async function policyDetail(req, res) {
  const { leavePolicyId } = validateParams(req.params, {
    leavePolicyId: { required: true, integer: true },
  });

  const data = await policyService.getPolicy(leavePolicyId);
  return sendSuccess(res, { message: MESSAGES.LEAVE_POLICY_FETCHED, data });
}

/** POST /api/v1/leave/policies */
export async function createPolicy(req, res) {
  const input = validateBody(req.body, POLICY_RULES);
  const data = await policyService.createPolicy(req.access.employeeDetailId, input);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.LEAVE_POLICY_CREATED,
    data,
  });
}

/** PUT /api/v1/leave/policies/:leavePolicyId */
export async function updatePolicy(req, res) {
  const { leavePolicyId } = validateParams(req.params, {
    leavePolicyId: { required: true, integer: true },
  });
  const input = validateBody(req.body, {
    ...POLICY_RULES,
    leaveTypeId: { integer: true },
    isActive: { boolean: true },
  });

  const data = await policyService.updatePolicy(req.access.employeeDetailId, leavePolicyId, input);
  return sendSuccess(res, { message: MESSAGES.LEAVE_POLICY_UPDATED, data });
}

/** DELETE /api/v1/leave/policies/:leavePolicyId */
export async function deletePolicy(req, res) {
  const { leavePolicyId } = validateParams(req.params, {
    leavePolicyId: { required: true, integer: true },
  });

  const data = await policyService.deletePolicy(req.access.employeeDetailId, leavePolicyId);
  return sendSuccess(res, { message: MESSAGES.LEAVE_POLICY_DELETED, data });
}

/* --- Sandwich rules ------------------------------------------------------- */

/** GET /api/v1/leave/sandwich-rules */
export async function listSandwichRules(req, res) {
  const data = await policyService.listSandwichRules();
  return sendSuccess(res, {
    message: MESSAGES.SANDWICH_RULES_FETCHED,
    data,
    meta: { total: data.length, modes: Object.values(SANDWICH_MODE) },
  });
}

/** POST /api/v1/leave/sandwich-rules */
export async function createSandwichRule(req, res) {
  const input = validateBody(req.body, {
    ruleName: { required: true, maxLength: 100 },
    mode: { required: true, oneOf: Object.values(SANDWICH_MODE) },
    locationId: { integer: true },
    includeHolidays: { boolean: true },
    description: { maxLength: 500 },
  });

  const data = await policyService.createSandwichRule(req.access.employeeDetailId, input);
  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.SANDWICH_RULE_CREATED,
    data,
  });
}

/** PUT /api/v1/leave/sandwich-rules/:sandwichRuleId */
export async function updateSandwichRule(req, res) {
  const { sandwichRuleId } = validateParams(req.params, {
    sandwichRuleId: { required: true, integer: true },
  });
  const input = validateBody(req.body, {
    ruleName: { maxLength: 100 },
    mode: { oneOf: Object.values(SANDWICH_MODE) },
    includeHolidays: { boolean: true },
    description: { maxLength: 500 },
    isActive: { boolean: true },
  });

  const data = await policyService.updateSandwichRule(
    req.access.employeeDetailId,
    sandwichRuleId,
    input,
  );

  return sendSuccess(res, { message: MESSAGES.SANDWICH_RULE_UPDATED, data });
}

/** DELETE /api/v1/leave/sandwich-rules/:sandwichRuleId */
export async function deleteSandwichRule(req, res) {
  const { sandwichRuleId } = validateParams(req.params, {
    sandwichRuleId: { required: true, integer: true },
  });

  const data = await policyService.deleteSandwichRule(req.access.employeeDetailId, sandwichRuleId);
  return sendSuccess(res, { message: MESSAGES.SANDWICH_RULE_DELETED, data });
}

/* --- Per-employee overrides ----------------------------------------------- */

/** GET /api/v1/leave/overrides?employeeDetailId= */
export async function listOverrides(req, res) {
  const { employeeDetailId } = validateParams(req.query, {
    employeeDetailId: { integer: true },
  });

  const data = await policyService.listOverrides({ employeeDetailId: employeeDetailId ?? null });
  return sendSuccess(res, {
    message: MESSAGES.LEAVE_OVERRIDES_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** POST /api/v1/leave/overrides */
export async function createOverride(req, res) {
  const input = validateBody(req.body, {
    employeeDetailId: { required: true, integer: true },
    leavePolicyId: { required: true, integer: true },
    overrideAnnualQuota: { decimal: true, min: 0, max: 999 },
    overrideAccrualDays: { decimal: true, min: 0, max: 999 },
    effectiveFrom: { date: true },
    effectiveTo: { date: true },
    // Required: an exception nobody has to justify is one nobody reviews.
    reason: { required: true, maxLength: 500 },
  });

  const data = await policyService.createOverride(req.access.employeeDetailId, input);
  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.LEAVE_OVERRIDE_CREATED,
    data,
  });
}

/** PUT /api/v1/leave/overrides/:employeeLeavePolicyId */
export async function updateOverride(req, res) {
  const { employeeLeavePolicyId } = validateParams(req.params, {
    employeeLeavePolicyId: { required: true, integer: true },
  });
  const input = validateBody(req.body, {
    overrideAnnualQuota: { decimal: true, min: 0, max: 999 },
    overrideAccrualDays: { decimal: true, min: 0, max: 999 },
    effectiveTo: { date: true },
    reason: { maxLength: 500 },
    isActive: { boolean: true },
  });

  const data = await policyService.updateOverride(
    req.access.employeeDetailId,
    employeeLeavePolicyId,
    input,
  );

  return sendSuccess(res, { message: MESSAGES.LEAVE_OVERRIDE_UPDATED, data });
}

/** DELETE /api/v1/leave/overrides/:employeeLeavePolicyId */
export async function deleteOverride(req, res) {
  const { employeeLeavePolicyId } = validateParams(req.params, {
    employeeLeavePolicyId: { required: true, integer: true },
  });

  const data = await policyService.deleteOverride(req.access.employeeDetailId, employeeLeavePolicyId);
  return sendSuccess(res, { message: MESSAGES.LEAVE_OVERRIDE_DELETED, data });
}

/* -------------------------------------------------------------------------
   Mapping - MODULE.LEAVE_MAPPING
   ------------------------------------------------------------------------- */

/** GET /api/v1/leave/mappings */
export async function listMappings(req, res) {
  const { leaveTypeId } = validateParams(req.query, { leaveTypeId: { integer: true } });

  const data = await policyService.listMappings({ leaveTypeId: leaveTypeId ?? null });
  return sendSuccess(res, {
    message: MESSAGES.LEAVE_MAPPINGS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** POST /api/v1/leave/mappings */
export async function createMapping(req, res) {
  const input = validateBody(req.body, {
    leaveTypeId: { required: true, integer: true },
    locationId: { integer: true },
    employmentType: { maxLength: 30 },
    gender: { maxLength: 30 },
    minTenureMonths: { integer: true, min: 0 },
    availableDuringProbation: { boolean: true },
  });

  const data = await policyService.createMapping(req.access.employeeDetailId, input);
  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.LEAVE_MAPPING_CREATED,
    data,
  });
}

/** PUT /api/v1/leave/mappings/:leaveMappingId */
export async function updateMapping(req, res) {
  const { leaveMappingId } = validateParams(req.params, {
    leaveMappingId: { required: true, integer: true },
  });
  const input = validateBody(req.body, {
    minTenureMonths: { integer: true, min: 0 },
    availableDuringProbation: { boolean: true },
    isActive: { boolean: true },
  });

  const data = await policyService.updateMapping(req.access.employeeDetailId, leaveMappingId, input);
  return sendSuccess(res, { message: MESSAGES.LEAVE_MAPPING_UPDATED, data });
}

/** DELETE /api/v1/leave/mappings/:leaveMappingId */
export async function deleteMapping(req, res) {
  const { leaveMappingId } = validateParams(req.params, {
    leaveMappingId: { required: true, integer: true },
  });

  const data = await policyService.deleteMapping(req.access.employeeDetailId, leaveMappingId);
  return sendSuccess(res, { message: MESSAGES.LEAVE_MAPPING_DELETED, data });
}

/* -------------------------------------------------------------------------
   Balances - MODULE.LEAVE_BALANCE
   ------------------------------------------------------------------------- */

/** GET /api/v1/leave/balances?leaveCycleId=&leaveTypeId= */
export async function listBalances(req, res) {
  const filters = validateParams(req.query, {
    leaveCycleId: { required: true, integer: true },
    leaveTypeId: { integer: true },
    employeeDetailId: { integer: true },
  });

  const data = await leaveService.balanceGrid({
    leaveCycleId: filters.leaveCycleId,
    leaveTypeId: filters.leaveTypeId ?? null,
    employeeDetailId: filters.employeeDetailId ?? null,
  });

  return sendSuccess(res, {
    message: MESSAGES.LEAVE_BALANCES_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** GET /api/v1/leave/balances/:employeeDetailId */
export async function employeeBalances(req, res) {
  const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);
  const data = await leaveService.dashboardFor(employeeDetailId);
  return sendSuccess(res, { message: MESSAGES.LEAVE_BALANCE_FETCHED, data });
}

/** GET /api/v1/leave/balances/:employeeDetailId/ledger */
export async function employeeLedger(req, res) {
  const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);
  const filters = validateParams(req.query, {
    leaveTypeId: { integer: true },
    leaveCycleId: { integer: true },
  });

  const data = await leaveService.ledgerFor(employeeDetailId, {
    leaveTypeId: filters.leaveTypeId ?? null,
    leaveCycleId: filters.leaveCycleId ?? null,
  });

  return sendSuccess(res, {
    message: MESSAGES.LEAVE_LEDGER_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/**
 * POST /api/v1/leave/balances/:employeeDetailId/adjust
 *
 * `days` is deliberately a plain number and may be negative - a correction
 * goes both ways. `remarks` is required, and the service refuses without
 * it: an adjustment points at nothing, so without a reason the statement
 * line reads "+3 days" with no way for anybody to find out why.
 */
export async function adjustBalance(req, res) {
  const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);
  const input = validateBody(req.body, {
    leaveTypeId: { required: true, integer: true },
    leaveCycleId: { required: true, integer: true },
    days: { required: true, decimal: true, min: -999, max: 999 },
    effectiveDate: { date: true },
    remarks: { required: true, maxLength: 500 },
  });

  const data = await leaveService.adjustBalance(req.access.employeeDetailId, employeeDetailId, input);
  return sendSuccess(res, { message: MESSAGES.LEAVE_BALANCE_ADJUSTED, data });
}

/** POST /api/v1/leave/balances/grant - the "add leaves" screen. */
export async function grantBalance(req, res) {
  const input = validateBody(req.body, {
    leaveTypeId: { required: true, integer: true },
    leaveCycleId: { required: true, integer: true },
    days: { required: true, decimal: true, min: 0.5, max: 999 },
    effectiveDate: { date: true },
    remarks: { required: true, maxLength: 500 },
  });

  const employeeDetailIds = Array.isArray(req.body?.employeeDetailIds)
    ? req.body.employeeDetailIds.map(Number).filter(Number.isInteger)
    : [];

  if (employeeDetailIds.length === 0) {
    throw ApiError.badRequest(MESSAGES.VALIDATION_FAILED, {
      employeeDetailIds: 'At least one employee is required',
    });
  }

  const data = await leaveService.grantBalance(req.access.employeeDetailId, {
    ...input,
    employeeDetailIds,
  });

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.LEAVE_BALANCE_GRANTED,
    data,
  });
}

/* -------------------------------------------------------------------------
   Comp-off - MODULE.COMP_OFF
   ------------------------------------------------------------------------- */

const COMP_OFF_PARAM = { compOffRequestId: { required: true, integer: true } };

/** GET /api/v1/leave/comp-off/me */
export async function myCompOff(req, res) {
  const data = await compOffService.listForEmployee(req.access.employeeDetailId);
  return sendSuccess(res, {
    message: MESSAGES.COMP_OFF_REQUESTS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** POST /api/v1/leave/comp-off */
export async function createCompOff(req, res) {
  const input = validateBody(req.body, {
    workedOnDate: { required: true, date: true },
    reason: { required: true, maxLength: 500 },
  });

  const data = await compOffService.createRequest(
    req.access.employeeDetailId,
    req.access.employeeDetailId,
    input,
  );

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.COMP_OFF_REQUEST_CREATED,
    data,
  });
}

/** GET /api/v1/leave/comp-off/pending - the manager's queue. */
export async function pendingCompOff(req, res) {
  const data = await compOffService.listByStatus(COMP_OFF_REQUEST_STATUS.PENDING_MANAGER, {
    managerId: teamScope(req),
  });

  return sendSuccess(res, {
    message: MESSAGES.COMP_OFF_REQUESTS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/**
 * GET /api/v1/leave/comp-off/awaiting-credit
 *
 * HR's outstanding list: approved by the manager, not yet credited. Without
 * this screen those requests are invisible - the employee believes they
 * have a day and nobody has granted one.
 */
export async function awaitingCredit(req, res) {
  const data = await compOffService.listByStatus(
    COMP_OFF_REQUEST_STATUS.APPROVED_AWAITING_CREDIT,
  );

  return sendSuccess(res, {
    message: MESSAGES.COMP_OFF_REQUESTS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** PUT /api/v1/leave/comp-off/:compOffRequestId/approve */
export async function approveCompOff(req, res) {
  const { compOffRequestId } = validateParams(req.params, COMP_OFF_PARAM);
  const { remarks } = validateBody(req.body, { remarks: { maxLength: 1000 } });

  const data = await compOffService.approve(req.access.employeeDetailId, compOffRequestId, { remarks });
  return sendSuccess(res, { message: MESSAGES.COMP_OFF_APPROVED, data });
}

/** PUT /api/v1/leave/comp-off/:compOffRequestId/reject */
export async function rejectCompOff(req, res) {
  const { compOffRequestId } = validateParams(req.params, COMP_OFF_PARAM);
  const { remarks } = validateBody(req.body, { remarks: { maxLength: 1000 } });

  const data = await compOffService.reject(req.access.employeeDetailId, compOffRequestId, { remarks });
  return sendSuccess(res, { message: MESSAGES.COMP_OFF_REJECTED, data });
}

/** PUT /api/v1/leave/comp-off/:compOffRequestId/cancel */
export async function cancelCompOff(req, res) {
  const { compOffRequestId } = validateParams(req.params, COMP_OFF_PARAM);

  const data = await compOffService.cancel(
    req.access.employeeDetailId,
    req.access.employeeDetailId,
    compOffRequestId,
  );

  return sendSuccess(res, { message: MESSAGES.COMP_OFF_CANCELLED, data });
}

/**
 * POST /api/v1/leave/comp-off/:compOffRequestId/credit
 *
 * THE ONLY CALL THAT GRANTS A COMP-OFF DAY, and it is HR's. Approval by the
 * manager credits nothing - see comp-off.service.js.
 */
export async function creditCompOff(req, res) {
  const { compOffRequestId } = validateParams(req.params, COMP_OFF_PARAM);
  const input = validateBody(req.body, {
    days: { decimal: true, min: 0.5, max: 2 },
    remarks: { maxLength: 500 },
  });

  const data = await compOffService.credit(req.access.employeeDetailId, compOffRequestId, input);
  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.COMP_OFF_CREDITED,
    data,
  });
}

/** GET /api/v1/leave/comp-off/credits */
export async function listCompOffCredits(req, res) {
  const filters = validateParams(req.query, {
    employeeDetailId: { integer: true },
    status: { maxLength: 20 },
  });

  const data = await compOffService.listCredits({
    employeeDetailId: filters.employeeDetailId ?? null,
    status: filters.status ?? null,
  });

  return sendSuccess(res, {
    message: MESSAGES.COMP_OFF_CREDITS_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/* -------------------------------------------------------------------------
   Confirmation - MODULE.EMPLOYMENT_STATUS
   ------------------------------------------------------------------------- */

/** GET /api/v1/leave/confirmation/due?withinDays= */
export async function confirmationDue(req, res) {
  const { withinDays } = validateParams(req.query, { withinDays: { integer: true, min: 0 } });

  const data = await confirmationService.listDueForConfirmation({
    dueWithinDays: withinDays ?? 30,
  });

  return sendSuccess(res, {
    message: MESSAGES.CONFIRMATION_DUE_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** GET /api/v1/leave/confirmation/:employeeDetailId/history */
export async function confirmationHistory(req, res) {
  const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);
  const data = await confirmationService.historyFor(employeeDetailId);

  return sendSuccess(res, {
    message: MESSAGES.CONFIRMATION_HISTORY_FETCHED,
    data,
    meta: { total: data.length },
  });
}

/** PUT /api/v1/leave/confirmation/:employeeDetailId/confirm */
export async function confirmEmployee(req, res) {
  const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);
  const input = validateBody(req.body, {
    reason: { required: true, maxLength: 500 },
    // May be backdated: EL accrual starts from this date, so HR signing off
    // in April for a March completion should record March.
    confirmedOn: { date: true },
  });

  const data = await confirmationService.confirm(req.access.employeeDetailId, employeeDetailId, input);
  return sendSuccess(res, { message: MESSAGES.EMPLOYEE_CONFIRMED, data });
}

/** PUT /api/v1/leave/confirmation/:employeeDetailId/extend */
export async function extendProbation(req, res) {
  const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);
  const input = validateBody(req.body, {
    newProbationEndDate: { required: true, date: true },
    reason: { required: true, maxLength: 500 },
  });

  const data = await confirmationService.changeProbationEnd(
    req.access.employeeDetailId,
    employeeDetailId,
    input,
  );

  return sendSuccess(res, { message: MESSAGES.PROBATION_EXTENDED, data });
}

/* -------------------------------------------------------------------------
   Payroll - MODULE.LWP_REPORT
   ------------------------------------------------------------------------- */

/** GET /api/v1/leave/reports/lwp?from=&to=&locationId= */
export async function lwpReport(req, res) {
  const filters = validateParams(req.query, {
    from: { required: true, date: true },
    to: { required: true, date: true },
    locationId: { integer: true },
  });

  if (filters.to < filters.from) {
    throw ApiError.badRequest(MESSAGES.ATTENDANCE_DATE_RANGE, {
      code: ERROR_CODE.INVALID_DATE_RANGE,
    });
  }

  const data = await leaveService.lwpReport({
    fromDate: filters.from,
    toDate: filters.to,
    locationId: filters.locationId ?? null,
  });

  return sendSuccess(res, {
    message: MESSAGES.LWP_REPORT_FETCHED,
    data,
    meta: { fromDate: filters.from, toDate: filters.to, total: data.length },
  });
}

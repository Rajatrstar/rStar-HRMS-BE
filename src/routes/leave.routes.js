/**
 * Leave routes: path (from the enum) -> guard -> controller method.
 *
 * ACCESS, and the two halves that make an approval safe:
 *
 *   THE MODULE RIGHT, here. TEAM_LEAVE:EDIT says "this group may approve
 *   leave". It is set on the Add/Edit Group screen and changed without a
 *   deploy, and nothing in this file names a group.
 *
 *   THE ROW-LEVEL RULE, in the service. "Whose leave?" is not something a
 *   module right can express - leave.service.js refuses an approver who is
 *   not the employee's manager, and refuses anybody approving their own.
 *
 * Both are required. Without the first, anybody could approve; without the
 * second, any approver could approve anybody's.
 *
 * MY_LEAVE is meant to be granted to EVERY group - an employee who cannot
 * see their own balance cannot use the module at all.
 *
 * DECLARATION ORDER MATTERS, and this file has the sharpest case in the
 * codebase: /requests/pending MUST be declared before /requests/:id, or
 * Express reads "pending" as a leave request id and the approver's queue
 * dies in the validator with "must be a whole number".
 */
import { Router } from 'express';
import { ROUTES } from '../enums/index.js';
import { MODULE, ACTION } from '../enums/module.enum.js';
import * as leaveController from '../controllers/leave.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { requireAccess, requireAnyAccess } from '../middlewares/permission.middleware.js';

const router = Router();

router.use(authenticate);

/* -------------------------------------------------------------------------
   Self service - MODULE.MY_LEAVE
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.LEAVE.ME_DASHBOARD,
  requireAccess(MODULE.MY_LEAVE, ACTION.VIEW),
  leaveController.meDashboard,
);

router.get(
  ROUTES.LEAVE.ME_TYPES,
  // ADD as well as VIEW: the apply form must work for a group that may
  // apply without browsing its own history.
  requireAnyAccess(MODULE.MY_LEAVE, [ACTION.VIEW, ACTION.ADD]),
  leaveController.meTypes,
);

router.post(
  ROUTES.LEAVE.ME_PREVIEW,
  requireAnyAccess(MODULE.MY_LEAVE, [ACTION.VIEW, ACTION.ADD]),
  leaveController.mePreview,
);

router.get(
  ROUTES.LEAVE.ME_REQUESTS,
  requireAccess(MODULE.MY_LEAVE, ACTION.VIEW),
  leaveController.meRequests,
);

router.get(
  ROUTES.LEAVE.ME_LEDGER,
  requireAccess(MODULE.MY_LEAVE, ACTION.VIEW),
  leaveController.meLedger,
);

router.get(
  ROUTES.LEAVE.ME_BALANCE,
  requireAccess(MODULE.MY_LEAVE, ACTION.VIEW),
  leaveController.meBalance,
);

/* -------------------------------------------------------------------------
   Requests.

   PENDING IS DECLARED FIRST - see the file header. Everything else in this
   block is /requests/:leaveRequestId/<verb>, which cannot collide with it
   once it is above them.
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.LEAVE.PENDING,
  requireAccess(MODULE.TEAM_LEAVE, ACTION.EDIT),
  leaveController.pending,
);

router.post(
  ROUTES.LEAVE.REQUEST_CREATE,
  requireAccess(MODULE.MY_LEAVE, ACTION.ADD),
  leaveController.apply,
);

router.put(
  ROUTES.LEAVE.REQUEST_APPROVE,
  requireAccess(MODULE.TEAM_LEAVE, ACTION.EDIT),
  leaveController.approve,
);

router.put(
  ROUTES.LEAVE.REQUEST_REJECT,
  requireAccess(MODULE.TEAM_LEAVE, ACTION.EDIT),
  leaveController.reject,
);

// Cancelling and withdrawing your OWN request is MY_LEAVE:ADD, not
// TEAM_LEAVE:EDIT - taking back what you submitted is part of submitting
// it, and must not require approver rights.
router.put(
  ROUTES.LEAVE.REQUEST_CANCEL,
  requireAccess(MODULE.MY_LEAVE, ACTION.ADD),
  leaveController.cancel,
);

router.put(
  ROUTES.LEAVE.REQUEST_WITHDRAW,
  requireAccess(MODULE.MY_LEAVE, ACTION.ADD),
  leaveController.withdraw,
);

/*
  The detail endpoint is reachable by anybody who may see their own leave;
  the CONTROLLER then refuses a request that is neither theirs nor one they
  may approve. The guard cannot express that - it knows about modules, not
  about who owns a row - which is exactly why the check is in the handler.
*/
router.get(
  ROUTES.LEAVE.REQUEST_DETAIL,
  requireAnyAccess(MODULE.MY_LEAVE, [ACTION.VIEW, ACTION.ADD]),
  leaveController.requestDetail,
);

/* -------------------------------------------------------------------------
   Team - MODULE.TEAM_LEAVE
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.LEAVE.TEAM_CALENDAR,
  requireAccess(MODULE.TEAM_LEAVE, ACTION.VIEW),
  leaveController.teamCalendar,
);

router.get(
  ROUTES.LEAVE.TEAM_REQUESTS,
  requireAccess(MODULE.TEAM_LEAVE, ACTION.VIEW),
  leaveController.teamRequests,
);

/* -------------------------------------------------------------------------
   Cycles - MODULE.LEAVE_POLICY

   CLOSING A CYCLE IS ACTION.DELETE, not EDIT. It is one-way and it stops
   anything further being written into the year, which is closer to a
   destructive act than to an edit - and a group that maintains policy rows
   should not be able to settle a year by accident.
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.LEAVE.CYCLE_LIST,
  // Every screen that shows a balance needs the cycle list for its dropdown.
  requireAnyAccess(MODULE.MY_LEAVE, [ACTION.VIEW, ACTION.ADD]),
  leaveController.listCycles,
);

router.post(
  ROUTES.LEAVE.CYCLE_CREATE,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.ADD),
  leaveController.createCycle,
);

router.put(
  ROUTES.LEAVE.CYCLE_CLOSE,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.DELETE),
  leaveController.closeCycle,
);

router.put(
  ROUTES.LEAVE.CYCLE_UPDATE,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.EDIT),
  leaveController.updateCycle,
);

/* -------------------------------------------------------------------------
   Sandwich rules - MODULE.LEAVE_POLICY
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.LEAVE.SANDWICH_RULE_LIST,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.VIEW),
  leaveController.listSandwichRules,
);

router.post(
  ROUTES.LEAVE.SANDWICH_RULE_CREATE,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.ADD),
  leaveController.createSandwichRule,
);

router.put(
  ROUTES.LEAVE.SANDWICH_RULE_UPDATE,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.EDIT),
  leaveController.updateSandwichRule,
);

router.delete(
  ROUTES.LEAVE.SANDWICH_RULE_DELETE,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.DELETE),
  leaveController.deleteSandwichRule,
);

/* -------------------------------------------------------------------------
   Per-employee overrides - MODULE.LEAVE_POLICY
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.LEAVE.OVERRIDE_LIST,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.VIEW),
  leaveController.listOverrides,
);

router.post(
  ROUTES.LEAVE.OVERRIDE_CREATE,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.ADD),
  leaveController.createOverride,
);

router.put(
  ROUTES.LEAVE.OVERRIDE_UPDATE,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.EDIT),
  leaveController.updateOverride,
);

router.delete(
  ROUTES.LEAVE.OVERRIDE_DELETE,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.DELETE),
  leaveController.deleteOverride,
);

/* -------------------------------------------------------------------------
   Policies - MODULE.LEAVE_POLICY
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.LEAVE.POLICY_LIST,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.VIEW),
  leaveController.listPolicies,
);

router.post(
  ROUTES.LEAVE.POLICY_CREATE,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.ADD),
  leaveController.createPolicy,
);

router.get(
  ROUTES.LEAVE.POLICY_DETAIL,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.VIEW),
  leaveController.policyDetail,
);

router.put(
  ROUTES.LEAVE.POLICY_UPDATE,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.EDIT),
  leaveController.updatePolicy,
);

router.delete(
  ROUTES.LEAVE.POLICY_DELETE,
  requireAccess(MODULE.LEAVE_POLICY, ACTION.DELETE),
  leaveController.deletePolicy,
);

/* -------------------------------------------------------------------------
   Mapping - MODULE.LEAVE_MAPPING
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.LEAVE.MAPPING_LIST,
  requireAccess(MODULE.LEAVE_MAPPING, ACTION.VIEW),
  leaveController.listMappings,
);

router.post(
  ROUTES.LEAVE.MAPPING_CREATE,
  requireAccess(MODULE.LEAVE_MAPPING, ACTION.ADD),
  leaveController.createMapping,
);

router.put(
  ROUTES.LEAVE.MAPPING_UPDATE,
  requireAccess(MODULE.LEAVE_MAPPING, ACTION.EDIT),
  leaveController.updateMapping,
);

router.delete(
  ROUTES.LEAVE.MAPPING_DELETE,
  requireAccess(MODULE.LEAVE_MAPPING, ACTION.DELETE),
  leaveController.deleteMapping,
);

/* -------------------------------------------------------------------------
   Comp-off - MODULE.COMP_OFF

   /comp-off/me, /comp-off/pending, /comp-off/awaiting-credit and
   /comp-off/credits are all declared BEFORE /comp-off/:compOffRequestId/*.

   CREDITING IS ACTION.ADD and approving is ACTION.EDIT, which is how the
   HR document's two-step is expressed in rights: a manager who may approve
   gets EDIT and still cannot grant the day, because granting it is a
   different action on the same module.
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.LEAVE.COMP_OFF_MINE,
  requireAnyAccess(MODULE.COMP_OFF, [ACTION.VIEW, ACTION.ADD]),
  leaveController.myCompOff,
);

router.get(
  ROUTES.LEAVE.COMP_OFF_PENDING,
  requireAccess(MODULE.COMP_OFF, ACTION.EDIT),
  leaveController.pendingCompOff,
);

router.get(
  ROUTES.LEAVE.COMP_OFF_AWAITING_CREDIT,
  requireAccess(MODULE.COMP_OFF, ACTION.ADD),
  leaveController.awaitingCredit,
);

router.get(
  ROUTES.LEAVE.COMP_OFF_CREDITS,
  requireAccess(MODULE.COMP_OFF, ACTION.VIEW),
  leaveController.listCompOffCredits,
);

router.post(
  ROUTES.LEAVE.COMP_OFF_CREATE,
  requireAccess(MODULE.COMP_OFF, ACTION.ADD),
  leaveController.createCompOff,
);

router.put(
  ROUTES.LEAVE.COMP_OFF_APPROVE,
  requireAccess(MODULE.COMP_OFF, ACTION.EDIT),
  leaveController.approveCompOff,
);

router.put(
  ROUTES.LEAVE.COMP_OFF_REJECT,
  requireAccess(MODULE.COMP_OFF, ACTION.EDIT),
  leaveController.rejectCompOff,
);

router.put(
  ROUTES.LEAVE.COMP_OFF_CANCEL,
  requireAccess(MODULE.COMP_OFF, ACTION.ADD),
  leaveController.cancelCompOff,
);

router.post(
  ROUTES.LEAVE.COMP_OFF_CREDIT,
  requireAccess(MODULE.COMP_OFF, ACTION.ADD),
  leaveController.creditCompOff,
);

/* -------------------------------------------------------------------------
   Balances - MODULE.LEAVE_BALANCE

   /balances/grant is declared BEFORE /balances/:employeeDetailId, or
   "grant" is read as an employee id.
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.LEAVE.BALANCE_LIST,
  requireAccess(MODULE.LEAVE_BALANCE, ACTION.VIEW),
  leaveController.listBalances,
);

router.post(
  ROUTES.LEAVE.BALANCE_GRANT,
  requireAccess(MODULE.LEAVE_BALANCE, ACTION.ADD),
  leaveController.grantBalance,
);

router.get(
  ROUTES.LEAVE.EMPLOYEE_LEDGER,
  requireAccess(MODULE.LEAVE_BALANCE, ACTION.VIEW),
  leaveController.employeeLedger,
);

router.post(
  ROUTES.LEAVE.BALANCE_ADJUST,
  requireAccess(MODULE.LEAVE_BALANCE, ACTION.EDIT),
  leaveController.adjustBalance,
);

router.get(
  ROUTES.LEAVE.EMPLOYEE_BALANCE,
  requireAccess(MODULE.LEAVE_BALANCE, ACTION.VIEW),
  leaveController.employeeBalances,
);

/* -------------------------------------------------------------------------
   Confirmation - MODULE.EMPLOYMENT_STATUS
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.LEAVE.CONFIRMATION_DUE,
  requireAccess(MODULE.EMPLOYMENT_STATUS, ACTION.VIEW),
  leaveController.confirmationDue,
);

router.get(
  ROUTES.LEAVE.CONFIRMATION_HISTORY,
  requireAccess(MODULE.EMPLOYMENT_STATUS, ACTION.VIEW),
  leaveController.confirmationHistory,
);

router.put(
  ROUTES.LEAVE.CONFIRMATION_CONFIRM,
  requireAccess(MODULE.EMPLOYMENT_STATUS, ACTION.EDIT),
  leaveController.confirmEmployee,
);

router.put(
  ROUTES.LEAVE.CONFIRMATION_EXTEND,
  requireAccess(MODULE.EMPLOYMENT_STATUS, ACTION.EDIT),
  leaveController.extendProbation,
);

/* -------------------------------------------------------------------------
   Payroll - MODULE.LWP_REPORT

   ACTION.PRINT as well as VIEW: this report leaves the building as a
   spreadsheet and lands in a payroll run, which is exactly the distinction
   the separate Print right exists for.
   ------------------------------------------------------------------------- */

router.get(
  ROUTES.LEAVE.LWP_REPORT,
  requireAnyAccess(MODULE.LWP_REPORT, [ACTION.VIEW, ACTION.PRINT]),
  leaveController.lwpReport,
);

export default router;

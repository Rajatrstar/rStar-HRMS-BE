/**
 * Access-control routes: path (from the enum) -> guard -> controller method.
 *
 * TWO TIERS, and the split is the whole design:
 *
 *   /me, /menu, /page   any signed-in employee. These are how a user finds
 *                       out they may do nothing; putting them behind a right
 *                       would mean needing access in order to discover you
 *                       have none, and a frontend with nothing to render and
 *                       no reason why.
 *
 *   everything else     MODULE.GROUPS, with the action matching the verb.
 *                       Reading the module catalog is a VIEW on GROUPS
 *                       rather than a module of its own: the catalog exists
 *                       to draw the rights matrix, and anyone who may see
 *                       that screen needs it.
 *
 * Membership is governed by MODULE.USER_ACCESS, not GROUPS. Deciding what a
 * group may do and deciding who is in it are different jobs - an HR
 * administrator can reasonably be trusted to put a new joiner into the
 * "Recruiter" group without also being able to grant that group the right to
 * delete employees.
 */
import { Router } from 'express';
import { ROUTES } from '../enums/index.js';
import { MODULE, ACTION } from '../enums/module.enum.js';
import * as accessController from '../controllers/access.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { requireAccess, requireAuthenticatedAccess } from '../middlewares/permission.middleware.js';

const router = Router();

// Every endpoint below needs a valid access token. Mounted once rather than
// repeated per route, so a new endpoint cannot be added unauthenticated by
// forgetting an argument.
router.use(authenticate);

/* What the signed-in user may do ------------------------------------------ */

router.get(ROUTES.ACCESS.ME, requireAuthenticatedAccess(), accessController.me);
router.get(ROUTES.ACCESS.MENU, requireAuthenticatedAccess(), accessController.menu);
router.get(ROUTES.ACCESS.PAGE, requireAuthenticatedAccess(), accessController.page);

/* The module catalog ------------------------------------------------------ */

router.get(
  ROUTES.ACCESS.MODULES,
  requireAccess(MODULE.GROUPS, ACTION.VIEW),
  accessController.modules,
);

/* Groups ------------------------------------------------------------------ */

router.get(
  ROUTES.ACCESS.GROUP_LIST,
  requireAccess(MODULE.GROUPS, ACTION.VIEW),
  accessController.listGroups,
);

router.post(
  ROUTES.ACCESS.GROUP_CREATE,
  requireAccess(MODULE.GROUPS, ACTION.ADD),
  accessController.createGroup,
);

// Declared BEFORE /groups/:groupId so "/groups/5/rights" and "/groups/5/members"
// are not swallowed by the id route and then rejected by the validator.
router.put(
  ROUTES.ACCESS.GROUP_RIGHTS,
  requireAccess(MODULE.GROUPS, ACTION.EDIT),
  accessController.updateGroupRights,
);

router.get(
  ROUTES.ACCESS.GROUP_MEMBERS,
  requireAccess(MODULE.USER_ACCESS, ACTION.VIEW),
  accessController.groupMembers,
);

router.post(
  ROUTES.ACCESS.GROUP_MEMBERS_ASSIGN,
  requireAccess(MODULE.USER_ACCESS, ACTION.EDIT),
  accessController.assignMembers,
);

router.get(
  ROUTES.ACCESS.GROUP_DETAIL,
  requireAccess(MODULE.GROUPS, ACTION.VIEW),
  accessController.groupDetail,
);

router.put(
  ROUTES.ACCESS.GROUP_UPDATE,
  requireAccess(MODULE.GROUPS, ACTION.EDIT),
  accessController.updateGroup,
);

router.delete(
  ROUTES.ACCESS.GROUP_DELETE,
  requireAccess(MODULE.GROUPS, ACTION.DELETE),
  accessController.deleteGroup,
);

/* Mapping an employee to a group ------------------------------------------ */

router.put(
  ROUTES.ACCESS.EMPLOYEE_GROUP,
  requireAccess(MODULE.USER_ACCESS, ACTION.EDIT),
  accessController.setEmployeeGroup,
);

router.delete(
  ROUTES.ACCESS.EMPLOYEE_GROUP,
  requireAccess(MODULE.USER_ACCESS, ACTION.EDIT),
  accessController.removeEmployeeGroup,
);

export default router;

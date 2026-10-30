/**
 * Employee routes: path (from the enum) -> guard -> controller method.
 *
 * ACCESS: every endpoint here is MODULE.EMPLOYEES, with the action matching
 * the verb. A group either holds that action or the request never arrives.
 *
 * DEACTIVATE maps to EDIT rather than to a right of its own. Under the group
 * model the six actions are fixed, so "may exit somebody" cannot be its own
 * checkbox - it is part of editing an employee. That is a real narrowing from
 * the permission model this replaced, where it was separate; if the
 * distinction turns out to matter, the way back is a module of its own
 * ("Employee Exit") rather than a seventh flag, because the six are what
 * every screen in the system renders.
 *
 * Nothing here names a group, and nothing should. Granting any of this to
 * another group is six checkboxes on the Add/Edit Group screen, not a deploy.
 */
import { Router } from 'express';
import { ROUTES } from '../enums/index.js';
import { MODULE, ACTION } from '../enums/module.enum.js';
import * as employeeController from '../controllers/employee.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { requireAccess } from '../middlewares/permission.middleware.js';

const router = Router();

// Mounted once rather than repeated per route, so a new endpoint cannot be
// added unauthenticated by forgetting an argument.
router.use(authenticate);

router.get(
  ROUTES.EMPLOYEES.LIST,
  requireAccess(MODULE.EMPLOYEES, ACTION.VIEW),
  employeeController.list,
);

router.post(
  ROUTES.EMPLOYEES.CREATE,
  requireAccess(MODULE.EMPLOYEES, ACTION.ADD),
  employeeController.create,
);

/*
  DEACTIVATE is declared BEFORE DETAIL and UPDATE. Express matches in
  declaration order, and `/:employeeDetailId` would otherwise swallow
  `/5/deactivate` - though only for a verb they share, which is exactly the
  kind of bug that shows up months later when somebody adds a GET.
*/
router.patch(
  ROUTES.EMPLOYEES.DEACTIVATE,
  requireAccess(MODULE.EMPLOYEES, ACTION.EDIT),
  employeeController.deactivate,
);

router.get(
  ROUTES.EMPLOYEES.DETAIL,
  requireAccess(MODULE.EMPLOYEES, ACTION.VIEW),
  employeeController.detail,
);

router.put(
  ROUTES.EMPLOYEES.UPDATE,
  requireAccess(MODULE.EMPLOYEES, ACTION.EDIT),
  employeeController.update,
);

// Soft delete: the row is stamped, never removed. Roles, grants, logins and
// every CreatedBy in the schema point at these ids.
router.delete(
  ROUTES.EMPLOYEES.DELETE,
  requireAccess(MODULE.EMPLOYEES, ACTION.DELETE),
  employeeController.remove,
);

export default router;

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
import * as profileController from '../controllers/employee-profile.controller.js';
import { SECTION_KEYS } from '../services/employee-section.service.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { requireAccess, requireAnyAccess } from '../middlewares/permission.middleware.js';
import { singleFileUpload } from '../middlewares/upload.middleware.js';

/*
  The Add Employee form saves the record, then its sections and documents.
  A group that may Add but not Edit must be able to finish that form, so the
  profile writes accept either right. The dropdown that serves both forms
  accepts View as well.
*/
const WRITE_PROFILE = [ACTION.ADD, ACTION.EDIT];
const PICK_FROM = [ACTION.VIEW, ACTION.ADD, ACTION.EDIT];

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

// Before DETAIL, or "/managers" is read as an employee id.
router.get(
  ROUTES.EMPLOYEES.MANAGER_OPTIONS,
  requireAnyAccess(MODULE.EMPLOYEES, PICK_FROM),
  employeeController.managerOptions,
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

// Add, like CREATE: the wizard's "Send invite" is the second half of adding
// somebody. Declared before DETAIL for the same reason DEACTIVATE is.
router.post(
  ROUTES.EMPLOYEES.INVITE,
  requireAccess(MODULE.EMPLOYEES, ACTION.ADD),
  employeeController.invite,
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

// Work experience, education, dependents: one GET and one PUT each.
for (const section of SECTION_KEYS) {
  const path = `${ROUTES.EMPLOYEES.SECTION}/${section}`;

  router.get(
    path,
    requireAccess(MODULE.EMPLOYEES, ACTION.VIEW),
    profileController.listSection(section),
  );
  router.put(
    path,
    requireAnyAccess(MODULE.EMPLOYEES, WRITE_PROFILE),
    profileController.saveSection(section),
  );
}

router.get(
  ROUTES.EMPLOYEES.DOCUMENT_LIST,
  requireAccess(MODULE.EMPLOYEES, ACTION.VIEW),
  profileController.listDocuments,
);

// The guard runs before the upload is read, so a refused caller never gets
// to stream a file into memory.
router.put(
  ROUTES.EMPLOYEES.DOCUMENT_UPLOAD,
  requireAnyAccess(MODULE.EMPLOYEES, WRITE_PROFILE),
  singleFileUpload('file'),
  profileController.uploadDocument,
);

router.delete(
  ROUTES.EMPLOYEES.DOCUMENT_DELETE,
  requireAccess(MODULE.EMPLOYEES, ACTION.EDIT),
  profileController.deleteDocument,
);

export default router;

/**
 * Error log routes: path (from the enum) -> guard -> controller method.
 *
 * TWO TIERS:
 *
 *   POST /           any signed-in employee. The frontend reports a crashed
 *                    screen for whoever was using it, and most of those are
 *                    not administrators.
 *
 *   everything else  MODULE.ERROR_LOGS, with the action matching the verb:
 *                    View to read the list, summary and detail; Edit to
 *                    resolve or reopen; Delete to remove rows. Stack traces
 *                    and request bodies are in here, so this is an
 *                    Administrator-only screen unless a group is granted it.
 */
import { Router } from 'express';
import { ROUTES } from '../enums/index.js';
import { MODULE, ACTION } from '../enums/module.enum.js';
import * as errorLogController from '../controllers/error-log.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { requireAccess, requireAuthenticatedAccess } from '../middlewares/permission.middleware.js';

const router = Router();

// Mounted once rather than repeated per route, so a new endpoint cannot be
// added unauthenticated by forgetting an argument.
router.use(authenticate);

router.post(
  ROUTES.ERROR_LOGS.REPORT,
  requireAuthenticatedAccess(),
  errorLogController.report,
);

router.get(
  ROUTES.ERROR_LOGS.LIST,
  requireAccess(MODULE.ERROR_LOGS, ACTION.VIEW),
  errorLogController.list,
);

// Before DETAIL, or "summary" is read as an id.
router.get(
  ROUTES.ERROR_LOGS.SUMMARY,
  requireAccess(MODULE.ERROR_LOGS, ACTION.VIEW),
  errorLogController.summary,
);

router.get(
  ROUTES.ERROR_LOGS.DETAIL,
  requireAccess(MODULE.ERROR_LOGS, ACTION.VIEW),
  errorLogController.detail,
);

router.put(
  ROUTES.ERROR_LOGS.UPDATE,
  requireAccess(MODULE.ERROR_LOGS, ACTION.EDIT),
  errorLogController.update,
);

router.delete(
  ROUTES.ERROR_LOGS.DELETE,
  requireAccess(MODULE.ERROR_LOGS, ACTION.DELETE),
  errorLogController.remove,
);

export default router;

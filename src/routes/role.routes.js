/**
 * Role routes: path (from the enum) -> guard -> controller method.
 *
 * The guard answers "may you administer roles at all". Whether you may grant
 * THIS permission at THIS scope is the service's escalation check, because it
 * depends on the request body, which a route guard never sees.
 */
import { Router } from 'express';
import { ROUTES, PERMISSION } from '../enums/index.js';
import * as roleController from '../controllers/role.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { requirePermission } from '../middlewares/permission.middleware.js';

const router = Router();

router.use(authenticate);

router.get(ROUTES.ROLES.LIST, requirePermission(PERMISSION.ROLES_VIEW), roleController.list);
router.post(ROUTES.ROLES.CREATE, requirePermission(PERMISSION.ROLES_CREATE), roleController.create);
router.get(ROUTES.ROLES.DETAIL, requirePermission(PERMISSION.ROLES_VIEW), roleController.detail);
router.patch(ROUTES.ROLES.UPDATE, requirePermission(PERMISSION.ROLES_UPDATE), roleController.update);
router.delete(ROUTES.ROLES.DELETE, requirePermission(PERMISSION.ROLES_DELETE), roleController.remove);

router.get(
  ROUTES.ROLES.PERMISSIONS,
  requirePermission(PERMISSION.ROLES_VIEW),
  roleController.permissions,
);
router.put(
  ROUTES.ROLES.PERMISSIONS_REPLACE,
  requirePermission(PERMISSION.ROLES_ASSIGN_PERMISSION),
  roleController.replacePermissions,
);

export default router;

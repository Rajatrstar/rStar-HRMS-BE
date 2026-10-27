/**
 * User-access routes: one person's roles, groups and overrides.
 *
 * Reading any of it needs user-access.view. Each kind of change has its own
 * permission, because they are not equally dangerous: assigning a role is
 * routine HR work, while an override bypasses the role model entirely and is
 * held by Super Admin alone by default.
 */
import { Router } from 'express';
import { ROUTES, PERMISSION } from '../enums/index.js';
import * as accessController from '../controllers/access.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import {
  requirePermission,
  requireAuthenticatedAccess,
} from '../middlewares/permission.middleware.js';

const router = Router();

router.use(authenticate);

// Any signed-in, active employee - it describes only themselves. Guarded
// rather than left bare, so "open to everyone" is a written decision.
router.get(
  ROUTES.ACCESS.MY_PERMISSIONS,
  requireAuthenticatedAccess(),
  accessController.myPermissions,
);

router.get(ROUTES.ACCESS.USER, requirePermission(PERMISSION.USER_ACCESS_VIEW), accessController.user);

router.get(
  ROUTES.ACCESS.USER_ROLES,
  requirePermission(PERMISSION.USER_ACCESS_VIEW),
  accessController.roles,
);
router.put(
  ROUTES.ACCESS.USER_ROLES_REPLACE,
  requirePermission(PERMISSION.USER_ACCESS_ASSIGN_ROLE),
  accessController.replaceRoles,
);

router.get(
  ROUTES.ACCESS.USER_GROUPS,
  requirePermission(PERMISSION.USER_ACCESS_VIEW),
  accessController.groups,
);
router.put(
  ROUTES.ACCESS.USER_GROUPS_REPLACE,
  requirePermission(PERMISSION.USER_ACCESS_MANAGE_GROUP),
  accessController.replaceGroups,
);

router.get(
  ROUTES.ACCESS.USER_OVERRIDES,
  requirePermission(PERMISSION.USER_ACCESS_VIEW),
  accessController.overrides,
);
router.post(
  ROUTES.ACCESS.USER_OVERRIDE_CREATE,
  requirePermission(PERMISSION.USER_ACCESS_OVERRIDE),
  accessController.createOverride,
);
router.patch(
  ROUTES.ACCESS.USER_OVERRIDE_UPDATE,
  requirePermission(PERMISSION.USER_ACCESS_OVERRIDE),
  accessController.updateOverride,
);
router.delete(
  ROUTES.ACCESS.USER_OVERRIDE_DELETE,
  requirePermission(PERMISSION.USER_ACCESS_OVERRIDE),
  accessController.deleteOverride,
);

router.get(
  ROUTES.ACCESS.USER_EFFECTIVE,
  requirePermission(PERMISSION.USER_ACCESS_VIEW),
  accessController.effectivePermissions,
);

export default router;

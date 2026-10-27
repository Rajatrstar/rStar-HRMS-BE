/**
 * Group routes: path (from the enum) -> guard -> controller method.
 *
 * As with roles, the guard says whether you may administer groups at all; the
 * service decides whether you may grant what a particular request asks for.
 */
import { Router } from 'express';
import { ROUTES, PERMISSION } from '../enums/index.js';
import * as groupController from '../controllers/group.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { requirePermission } from '../middlewares/permission.middleware.js';

const router = Router();

router.use(authenticate);

router.get(ROUTES.GROUPS.LIST, requirePermission(PERMISSION.GROUPS_VIEW), groupController.list);
router.post(ROUTES.GROUPS.CREATE, requirePermission(PERMISSION.GROUPS_CREATE), groupController.create);
router.get(ROUTES.GROUPS.DETAIL, requirePermission(PERMISSION.GROUPS_VIEW), groupController.detail);
router.patch(ROUTES.GROUPS.UPDATE, requirePermission(PERMISSION.GROUPS_UPDATE), groupController.update);
router.delete(ROUTES.GROUPS.DELETE, requirePermission(PERMISSION.GROUPS_DELETE), groupController.remove);

router.get(
  ROUTES.GROUPS.PERMISSIONS,
  requirePermission(PERMISSION.GROUPS_VIEW),
  groupController.permissions,
);
router.put(
  ROUTES.GROUPS.PERMISSIONS_REPLACE,
  requirePermission(PERMISSION.GROUPS_ASSIGN_PERMISSION),
  groupController.replacePermissions,
);

router.get(ROUTES.GROUPS.MEMBERS, requirePermission(PERMISSION.GROUPS_VIEW), groupController.members);
router.post(
  ROUTES.GROUPS.MEMBERS_ADD,
  requirePermission(PERMISSION.GROUPS_MANAGE_MEMBER),
  groupController.addMembers,
);
router.delete(
  ROUTES.GROUPS.MEMBER_REMOVE,
  requirePermission(PERMISSION.GROUPS_MANAGE_MEMBER),
  groupController.removeMember,
);

export default router;

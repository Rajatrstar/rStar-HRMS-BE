/**
 * Permission catalog routes. Read-only; there is deliberately no create.
 */
import { Router } from 'express';
import { ROUTES, PERMISSION } from '../enums/index.js';
import * as permissionController from '../controllers/permission.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { requirePermission } from '../middlewares/permission.middleware.js';

const router = Router();

router.use(authenticate);

router.get(
  ROUTES.PERMISSIONS.CATALOG,
  requirePermission(PERMISSION.PERMISSIONS_VIEW),
  permissionController.catalog,
);

export default router;

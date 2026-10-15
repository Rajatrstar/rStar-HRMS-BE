/**
 * Health routes: path (from the enum) -> controller method. Nothing else.
 */
import { Router } from 'express';
import { ROUTES } from '../enums/index.js';
import * as healthController from '../controllers/health.controller.js';

const router = Router();

router.get(ROUTES.HEALTH.LIVENESS, healthController.liveness);
router.get(ROUTES.HEALTH.READINESS, healthController.readiness);

export default router;

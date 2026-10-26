/**
 * The v1 API surface. app.js mounts this once under API_PREFIX.
 *
 * Adding a module is two lines: a ROUTE_GROUP entry in the enum, and a `use`
 * below pointing at that module's router.
 */
import { Router } from 'express';
import { ROUTE_GROUP } from '../enums/index.js';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import organizationRoutes from './organization.routes.js';

const router = Router();

router.use(ROUTE_GROUP.HEALTH, healthRoutes);
router.use(ROUTE_GROUP.AUTH, authRoutes);
router.use(ROUTE_GROUP.ORGANIZATIONS, organizationRoutes);
// router.use(ROUTE_GROUP.EMPLOYEES, employeeRoutes);

export default router;

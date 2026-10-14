import { Router } from 'express';
import { pingDatabase } from '../config/db.js';
import { HttpStatus } from '../enums.js';
import authRoutes from './auth.routes.js';
import employeeRoutes from './employee.routes.js';

/** Liveness and readiness probes. Mounted outside the rate limiter in app.ts. */
export const healthRouter = Router();

/** Liveness: is the process up? Must not touch the database. */
healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

/** Readiness: can the process serve traffic? 503 pulls it out of the load balancer. */
healthRouter.get('/ready', async (_req, res) => {
  const database = await pingDatabase();
  res
    .status(database ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
    .json({ status: database ? 'ready' : 'degraded', checks: { database } });
});

/** v1 API surface. Mount new HRMS modules here. */
const apiRouter = Router();

apiRouter.use('/auth', authRoutes);
apiRouter.use('/employees', employeeRoutes);

export default apiRouter;

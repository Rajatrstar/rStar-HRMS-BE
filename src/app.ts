import express from 'express';
import type { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { corsOrigins, env } from './config/env.js';
import { errorHandler, notFound } from './middlewares/error.middleware.js';
import { globalRateLimiter, requestContext } from './middlewares/request.middleware.js';
import apiRoutes, { healthRouter } from './routes/index.js';

/**
 * Builds the Express application. Order matters throughout this file:
 * context -> security -> parsing -> rate limiting -> routes -> 404 -> error handler.
 *
 * Note there is no async wrapper around handlers: Express 5 forwards a rejected promise
 * from a handler to the error middleware on its own.
 */
export function createApp(): Express {
  const app = express();

  // Required for correct req.ip (rate limiting, audit trail) behind Azure App Service / nginx.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');

  app.use(requestContext);

  app.use(helmet());
  app.use(
    cors({
      // An empty allowlist blocks all cross-origin browser traffic rather than opening it up.
      origin: corsOrigins.length > 0 ? corsOrigins : false,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
    }),
  );

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // Health checks sit outside the rate limiter so probes never trip it.
  app.use('/health', healthRouter);

  app.use(env.API_PREFIX, globalRateLimiter, apiRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

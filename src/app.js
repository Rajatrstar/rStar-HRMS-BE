/**
 * Builds the Express app. Deliberately knows nothing about ports, sockets or
 * the database lifecycle — index.js owns those — so this stays importable from
 * a test without starting a server.
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { API_PREFIX, UPLOADS_PATH, REQUEST_ID_HEADER } from './enums/index.js';
import { requestContext } from './middlewares/request-context.middleware.js';
import { MODULE, ACTION } from './enums/module.enum.js';
import { authenticate } from './middlewares/auth.middleware.js';
import { requireAccess } from './middlewares/permission.middleware.js';
import { EMPLOYEE_UPLOAD_ROOT } from './utils/upload-storage.js';
import { env, isProduction } from './config/env.js';
import apiRouter from './routes/index.js';
import { notFoundHandler } from './middlewares/not-found.middleware.js';
import { errorHandler } from './middlewares/error.middleware.js';
import { apiLimiter } from './middlewares/rate-limit.middleware.js';

export function createApp() {
  const app = express();

  // Behind a reverse proxy this makes req.ip and req.protocol honest.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // First, so every response - including a helmet or CORS refusal - carries
  // an X-Request-Id, and every later failure knows its id and start time.
  app.use(requestContext);

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',').map((o) => o.trim()),
      credentials: env.CORS_ORIGIN !== '*',
      // Without this a browser hides the header from the frontend's code.
      exposedHeaders: [REQUEST_ID_HEADER],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan(isProduction ? 'combined' : 'dev'));

  // The whole API hangs off one prefix, defined once in the enums. The global
  // limiter sits in front of it - after the body parser, because the
  // per-account limiters downstream key on req.body.email.
  /*
    Uploaded employee documents - PAN and Aadhaar scans - served from the
    FileUrl stored against them. Behind a token and View on Employees,
    because these are exactly the files a public static folder must never
    hold. Mounted ahead of the API router so its 404 does not answer first.

    A static mount is not a route, so the boot-time route audit cannot see
    it: the guard here is written out by hand, and must stay.
  */
  app.use(
    `${API_PREFIX}${UPLOADS_PATH.EMPLOYEES}`,
    apiLimiter,
    authenticate,
    requireAccess(MODULE.EMPLOYEES, ACTION.VIEW),
    express.static(EMPLOYEE_UPLOAD_ROOT, {
      index: false,
      dotfiles: 'deny',
      redirect: false,
      setHeaders: (res) => res.setHeader('Cache-Control', 'private, no-store'),
    }),
  );

  app.use(API_PREFIX, apiLimiter, apiRouter);

  // Order matters: unmatched route first, then the error handler last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

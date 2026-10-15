/**
 * Builds the Express app. Deliberately knows nothing about ports, sockets or
 * the database lifecycle — index.js owns those — so this stays importable from
 * a test without starting a server.
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { API_PREFIX } from './enums/index.js';
import { env, isProduction } from './config/env.js';
import apiRouter from './routes/index.js';
import { notFoundHandler } from './middlewares/not-found.middleware.js';
import { errorHandler } from './middlewares/error.middleware.js';

export function createApp() {
  const app = express();

  // Behind a reverse proxy this makes req.ip and req.protocol honest.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',').map((o) => o.trim()),
      credentials: env.CORS_ORIGIN !== '*',
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan(isProduction ? 'combined' : 'dev'));

  // The whole API hangs off one prefix, defined once in the enums.
  app.use(API_PREFIX, apiRouter);

  // Order matters: unmatched route first, then the error handler last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

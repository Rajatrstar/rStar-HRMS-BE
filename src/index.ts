import type { Server } from 'node:http';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

async function bootstrap(): Promise<void> {
  await connectDatabase();

  const server = createApp().listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, apiPrefix: env.API_PREFIX },
      'HRMS API listening',
    );
  });

  registerShutdownHandlers(server);
}

/**
 * Stops accepting new connections, lets in-flight requests finish, then closes the pool.
 * The timeout is the backstop for a connection that refuses to drain.
 */
function registerShutdownHandlers(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close(() => {
      void disconnectDatabase()
        .catch((error: unknown) => logger.error({ err: error }, 'Error closing database'))
        .finally(() => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A process in an unknown state must not keep serving requests.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    shutdown('uncaughtException');
  });
}

await bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start the application');
  process.exit(1);
});

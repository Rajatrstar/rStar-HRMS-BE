/**
 * Process entry point: start the app, then shut it down cleanly.
 *
 * Environment variables are loaded by Node itself via
 * `--env-file-if-exists=.env` (see the npm scripts), so there is no dotenv
 * import here.
 */
import { createApp } from './app.js';
import { env } from './config/env.js';
import { getPool, closePool } from './config/db.js';
import { API_PREFIX } from './enums/index.js';
import { logger } from './utils/logger.js';
import { assertTemplatesExist } from './utils/template.js';
import { startEmailWorker, stopEmailWorker } from './workers/email-outbox.worker.js';
import { startAccessStampWorker, stopAccessStampWorker } from './workers/access-stamp.worker.js';

async function start() {
  // Connect before listening so a bad connection string fails loudly at boot
  // instead of turning into a 500 on the first request.
  await getPool();

  // Fail here rather than when an employee never receives their email: every
  // EMAIL_TEMPLATE entry must have a file behind it.
  logger.debug(`${assertTemplatesExist()} email template(s) loaded`);

  startEmailWorker();
  startAccessStampWorker();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT}${API_PREFIX} [${env.NODE_ENV}]`);
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);

    // Stop accepting connections, then release the pool.
    server.close(async () => {
      stopEmailWorker();
      stopAccessStampWorker();
      await closePool();
      logger.info('Shutdown complete');
      process.exit(0);
    });

    // Don't hang forever on a stuck keep-alive connection.
    setTimeout(() => {
      logger.warn('Forcing shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

start().catch((error) => {
  logger.error('Failed to start the server', error);
  process.exit(1);
});

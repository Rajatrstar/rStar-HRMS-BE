/**
 * Process entry point: start the app, then shut it down cleanly.
 *
 * Environment variables are loaded by Node itself via
 * `--env-file-if-exists=.env` (see the npm scripts), so there is no dotenv
 * import here.
 */
import { createApp } from './app.js';
import { env, useDefaultOtp } from './config/env.js';
import { getPool, closePool } from './config/db.js';
import { syncSchema, isPermissionError, tableCount } from './config/schema-sync.js';
import { seedAccessControl } from './services/access-seed.service.js';
import { API_PREFIX } from './enums/index.js';
import { logger } from './utils/logger.js';
import { assertTemplatesExist } from './utils/template.js';
import { auditRoutes } from './utils/route-audit.js';
import { startEmailWorker, stopEmailWorker } from './workers/email-outbox.worker.js';

/**
 * Applies pending migrations, then makes sure the module catalog is in place.
 *
 * The catalog is seeded whenever a migration ran or the table is empty, not on
 * every boot: it ends by bumping tblAccessControlStamp, which every instance
 * watches to drop its permission cache. Doing that on each restart would throw
 * away a warm cache across the whole cluster for nothing.
 *
 * A failure here stops the process. The Python service logs and carries on,
 * which suits it - it still answers in mock mode. This one has nothing useful
 * to answer with: every endpoint reads a table, so starting would mean serving
 * 500s from a server whose health check says it is fine.
 */
async function prepareDatabase() {
  const pool = await getPool();
  const before = await tableCount(pool);

  let applied;
  try {
    ({ applied } = await syncSchema({ pool }));
  } catch (error) {
    if (isPermissionError(error.cause ?? error)) {
      throw new Error(
        `${env.DB_USER} can connect to ${env.DB_NAME} but may not create tables, and the ` +
          `schema is not there yet (${before} table(s)).\n` +
          `  Grant it once, as the server administrator:  ALTER ROLE db_ddladmin ADD MEMBER [${env.DB_USER}];\n` +
          '  See db/azure/002_grant_schema_rights.sql. Or set DB_AUTO_MIGRATE=false if ' +
          'something else owns the schema.',
        { cause: error },
      );
    }
    throw error;
  }

  if (applied.length > 0) {
    logger.info(`Schema synced: ${applied.length} migration(s) applied`);
  } else {
    logger.debug('Schema already up to date');
  }

  if (applied.length > 0 || before === 0) {
    const { steps } = await seedAccessControl();
    for (const step of steps) logger.info(`  ${step}`);
  }
}

async function start() {
  // Connect before listening so a bad connection string fails loudly at boot
  // instead of turning into a 500 on the first request.
  await getPool();

  // Build the schema before anything else touches it. An empty database -
  // a developer's first run, a fresh Azure one - becomes a working one here.
  if (env.DB_AUTO_MIGRATE) await prepareDatabase();

  // Fail here rather than when an employee never receives their email: every
  // EMAIL_TEMPLATE entry must have a file behind it.
  logger.debug(`${assertTemplatesExist()} email template(s) loaded`);

  // Loud on purpose. Everything below this line behaves differently, and the
  // difference is invisible from the outside until somebody wonders why their
  // OTP email never arrived.
  if (useDefaultOtp) {
    logger.warn(
      `DefaultOTP is ON: every OTP is ${env.DEFAULT_OTP_CODE} and NO email will be sent. ` +
        'Development only - this is ignored when NODE_ENV=production.',
    );
  }

  startEmailWorker();

  const app = createApp();

  // Refuses to start if any API route is missing its access guard. Deliberately
  // before listen(): an unguarded endpoint must never be reachable, not even for
  // the moment it takes somebody to read the log.
  const audit = auditRoutes(app);
  logger.info(
    `Access guards verified on ${audit.guarded}/${audit.total} API routes (${audit.public} public)`,
  );

  const server = app.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT}${API_PREFIX} [${env.NODE_ENV}]`);
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);

    // Stop accepting connections, then release the pool.
    server.close(async () => {
      stopEmailWorker();
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

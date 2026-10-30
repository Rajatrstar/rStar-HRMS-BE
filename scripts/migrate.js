/**
 * Applies every .sql file in db/migrations, in filename order, once.
 *
 *   npm run db:migrate
 *
 * The work itself lives in src/config/schema-sync.js, because the server runs
 * the same thing at startup when DB_AUTO_MIGRATE is on. This script exists for
 * the times you want to apply the schema without starting an API: a deploy
 * step, a fresh Azure database, or checking what a new migration does.
 */
import { getPool, closePool } from '../src/config/db.js';
import { syncSchema, isPermissionError } from '../src/config/schema-sync.js';
import { logger } from '../src/utils/logger.js';
import { env } from '../src/config/env.js';

async function run() {
  await getPool();
  const { applied, total } = await syncSchema();

  logger.info(
    applied.length === 0
      ? `Database already up to date (${total} migration(s))`
      : `Applied ${applied.length} of ${total} migration(s)`,
  );

  await closePool();
}

run().catch(async (error) => {
  if (isPermissionError(error.cause ?? error)) {
    logger.error(
      `${env.DB_USER} can connect to ${env.DB_NAME} but is not allowed to create tables.\n` +
        '  Grant it once, as the server administrator:\n' +
        `      ALTER ROLE db_ddladmin ADD MEMBER [${env.DB_USER}];\n` +
        '  or see db/azure/002_grant_schema_rights.sql.',
    );
  } else {
    logger.error('Migration failed', error);
  }
  await closePool();
  process.exit(1);
});

/**
 * Seeds the module catalog and the Administrator group.
 *
 *   npm run db:seed:access
 *
 * The work lives in src/services/access-seed.service.js, because the server
 * runs the same thing at startup when DB_AUTO_MIGRATE is on. Run this by hand
 * after adding a module to MODULE_CATALOG in src/enums/module.enum.js if you
 * would rather not restart to pick it up.
 */
import { getPool, closePool } from '../src/config/db.js';
import { seedAccessControl, ADMIN_GROUP_NAME } from '../src/services/access-seed.service.js';
import { logger } from '../src/utils/logger.js';

async function run() {
  await getPool();

  const outcome = await seedAccessControl();
  for (const step of outcome.steps) logger.info(`  ${step}`);

  logger.info('');
  logger.info(`${ADMIN_GROUP_NAME} group is GroupId ${outcome.groupId}.`);
  logger.info('Put somebody in it with:  npm run db:create:admin');
  logger.info('Every other group starts with no rights - set them on the group screen.');

  await closePool();
}

run().catch(async (error) => {
  logger.error('Seeding access control failed', error);
  await closePool();
  process.exit(1);
});

/**
 * Grants the master-data rights to the administrator groups.
 *
 *   npm run db:grant:masterdata
 *
 * WHY THIS IS A SCRIPT AND NOT PART OF THE ACCESS SEED. The access seeder
 * deliberately grants nothing to anybody - "a seeder that guessed them would
 * quietly widen somebody's access on every deploy" - and that rule is worth
 * keeping. This file is the opposite thing: one decision, written down, run
 * when somebody asks for it. Master data is administrator territory, so
 * View / Add / Edit / Delete on the five lookup lists goes to the groups that
 * administer the company, and to nobody else.
 *
 * WHO ENDS UP WITH WHAT:
 *
 *   Super Admin, Administrator  everything already. They are system groups,
 *                               and resolveAccess() treats a system group as
 *                               holding every right on every module - which
 *                               is also why updateGroup refuses to write
 *                               rows for them, and why this script skips
 *                               them rather than failing on them.
 *   HR Admin                    the four rights, written as real rows here.
 *   Manager, Employee           nothing. They hold no row for these modules,
 *                               and no row means no right - so they are
 *                               already refused, with nothing to take away.
 *
 * Print and Mail are left off. They are separate rights precisely because
 * "may read this on screen" and "may walk out with a PDF of it" are different
 * decisions, and nobody has asked for the second one on a list of department
 * names.
 *
 * Idempotent: the rights are MERGEd by (group, module), so re-running writes
 * the same matrix and changes nothing. It is also the supported way to put
 * the rights back after somebody has unticked a box by accident.
 *
 * Rights set anywhere else - this script, the group screen, the API - all go
 * through the same service, so the access cache is invalidated and every
 * signed-in user sees the change on their next request.
 */
import { getPool, closePool } from '../src/config/db.js';
import { query } from '../src/helpers/query.helper.js';
import { setGroupRights } from '../src/services/group.service.js';
import { Group } from '../src/models/index.js';
import { MODULE, MASTER_DATA_RESOURCES } from '../src/enums/index.js';
import { logger } from '../src/utils/logger.js';

/**
 * The groups that administer master data.
 *
 * By name, not by id: ids differ between databases, and a name that is not
 * there is reported rather than skipped - a typo here would otherwise look
 * exactly like a successful run that granted nothing.
 */
const ADMIN_GROUPS = ['Super Admin', 'HR Admin'];

/** What they get on each list. Print and Mail stay off - see the header. */
const RIGHTS = Object.freeze({
  canView: true,
  canAdd: true,
  canEdit: true,
  canDelete: true,
  canPrint: false,
  canMail: false,
});

/**
 * The five lists, plus the heading they hang under.
 *
 * The heading gets View only, and it is not decoration: buildMenu() hides a
 * child whose parent is not visible, so without this the five screens would
 * be reachable by URL and absent from the menu.
 */
const MASTER_DATA_MODULE_IDS = [
  MODULE.MASTER_DATA,
  ...MASTER_DATA_RESOURCES.map((resource) => resource.moduleId),
];

function rightsFor(moduleId) {
  return moduleId === MODULE.MASTER_DATA
    ? { moduleId, ...RIGHTS, canAdd: false, canEdit: false, canDelete: false }
    : { moduleId, ...RIGHTS };
}

async function run() {
  await getPool();

  const groups = await query(
    `SELECT ${Group.select(['groupId', 'groupName', 'isSystem'])}
       FROM ${Group.table}
      WHERE DeletedAt IS NULL`,
  );

  const byName = new Map(groups.map((group) => [group.groupName.toLowerCase(), group]));
  const rights = MASTER_DATA_MODULE_IDS.map(rightsFor);

  logger.info(`Granting master data to: ${ADMIN_GROUPS.join(', ')}`);

  for (const name of ADMIN_GROUPS) {
    const group = byName.get(name.toLowerCase());

    if (!group) {
      logger.warn(`  ${name}: no such group - skipped`);
      continue;
    }

    if (group.isSystem) {
      logger.info(`  ${name}: system group, already holds every right - nothing to write`);
      continue;
    }

    await setGroupRights(Number(group.groupId), rights, null);
    logger.info(
      `  ${name}: view/add/edit/delete on ${MASTER_DATA_RESOURCES.length} lists ` +
        '(+ view on the Master Data heading)',
    );
  }

  const others = groups
    .filter((group) => !group.isSystem)
    .filter((group) => !ADMIN_GROUPS.some((name) => name.toLowerCase() === group.groupName.toLowerCase()))
    .map((group) => group.groupName);

  logger.info('');
  logger.info(
    others.length === 0
      ? 'No other group exists, so nobody else can reach master data.'
      : `Untouched, and therefore still refused: ${others.join(', ')}.`,
  );
  logger.info('Change any of this on the group screen - it is data, not code.');

  await closePool();
}

run().catch(async (error) => {
  logger.error('Granting master-data access failed', error);
  await closePool();
  process.exit(1);
});

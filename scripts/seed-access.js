/**
 * Seeds the module catalog and the Administrator group.
 *
 *   npm run db:seed:access
 *
 * Run it after every migration, and after adding a module to MODULE_CATALOG
 * in src/enums/module.enum.js. It is idempotent: modules are upserted by id,
 * so changing a name or a menu position there and re-running is the supported
 * way to edit the catalog.
 *
 * WHAT IT DOES NOT DO: grant anything to any group. Rights are the
 * administrator's to set on the Add/Edit Group screen, and a seeder that
 * guessed them would quietly widen somebody's access on every deploy.
 *
 * The one exception is the Administrator group, created with IsSystem = 1.
 * Its rights are not rows at all - resolveAccess() treats the system group as
 * holding everything - so a new module is covered by it the moment it exists,
 * with nothing to re-seed and no window in which the people who administer
 * the system cannot reach the screen that fixes it.
 */
import { getPool, closePool, sql } from '../src/config/db.js';
import { withTransaction } from '../src/helpers/query.helper.js';
import { Module, Group, AccessControlStamp, GLOBAL_STAMP } from '../src/models/index.js';
import { MODULE_CATALOG } from '../src/enums/module.enum.js';
import { logger } from '../src/utils/logger.js';

const ADMIN_GROUP_NAME = 'Administrator';

async function run() {
  await getPool();

  const outcome = await withTransaction(async (exec) => {
    const steps = [];

    /* 1 - the module catalog --------------------------------------------- */
    let inserted = 0;
    let updated = 0;

    // Parents before children: FK_tblModule_Parent will not accept a child
    // whose parent is not in the table yet, and the catalog is authored in
    // menu order rather than dependency order.
    const ordered = [...MODULE_CATALOG].sort((a, b) => {
      if (a.parentModuleId === null && b.parentModuleId !== null) return -1;
      if (a.parentModuleId !== null && b.parentModuleId === null) return 1;
      return a.moduleId - b.moduleId;
    });

    for (const module of ordered) {
      const [result] = await exec(
        `MERGE ${Module.table} WITH (HOLDLOCK) AS target
         USING (SELECT @moduleId AS ModuleId) AS source
            ON target.ModuleId = source.ModuleId
          WHEN MATCHED THEN UPDATE SET
               ModuleCode     = @moduleCode,
               ModuleName     = @moduleName,
               Description    = @description,
               ParentModuleId = @parentModuleId,
               RoutePath      = @routePath,
               Icon           = @icon,
               SortOrder      = @sortOrder,
               ShowInMenu     = @showInMenu,
               IsActive       = 1,
               ModifiedAt     = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN INSERT
               (ModuleId, ModuleCode, ModuleName, Description, ParentModuleId,
                RoutePath, Icon, SortOrder, ShowInMenu)
          VALUES
               (@moduleId, @moduleCode, @moduleName, @description, @parentModuleId,
                @routePath, @icon, @sortOrder, @showInMenu)
          OUTPUT $action AS action;`,
        {
          moduleId: { type: sql.Int, value: module.moduleId },
          moduleCode: { type: sql.NVarChar(60), value: module.moduleCode },
          moduleName: { type: sql.NVarChar(100), value: module.moduleName },
          description: { type: sql.NVarChar(255), value: module.description ?? null },
          parentModuleId: { type: sql.Int, value: module.parentModuleId },
          routePath: { type: sql.NVarChar(150), value: module.routePath },
          icon: { type: sql.NVarChar(60), value: module.icon ?? null },
          sortOrder: { type: sql.Int, value: module.sortOrder },
          showInMenu: { type: sql.Bit, value: module.showInMenu },
        },
      );

      if (result.action === 'INSERT') inserted += 1;
      else updated += 1;
    }

    steps.push(`modules: ${inserted} added, ${updated} refreshed`);

    /*
      A module left in the table but no longer in the catalog is deactivated,
      not deleted: tblAccessRight rows point at it, and a group that is
      granted the module again later should find its old ticks intact rather
      than silently cleared.
    */
    const ids = MODULE_CATALOG.map((module) => module.moduleId);
    const retired = await exec(
      `UPDATE ${Module.table}
          SET IsActive = 0, ModifiedAt = SYSUTCDATETIME()
        OUTPUT deleted.ModuleCode AS moduleCode
        WHERE IsActive = 1 AND ModuleId NOT IN (${ids.join(', ')});`,
    );
    if (retired.length > 0) {
      steps.push(
        `retired (no longer in the catalog): ${retired.map((row) => row.moduleCode).join(', ')}`,
      );
    }

    /* 2 - the Administrator group ---------------------------------------- */
    const [group] = await exec(
      `MERGE ${Group.table} WITH (HOLDLOCK) AS target
       USING (SELECT @groupName AS GroupName) AS source
          ON target.GroupName = source.GroupName AND target.DeletedAt IS NULL
        WHEN MATCHED THEN UPDATE SET
             IsSystem = 1, IsActive = 1, ModifiedAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (GroupName, Description, IsSystem, IsActive)
        VALUES (@groupName, @description, 1, 1)
        OUTPUT $action AS action, INSERTED.GroupId AS groupId;`,
      {
        groupName: { type: sql.NVarChar(100), value: ADMIN_GROUP_NAME },
        description: {
          type: sql.NVarChar(255),
          value: 'Full access to every module. Cannot be edited or deleted.',
        },
      },
    );

    steps.push(
      group.action === 'INSERT'
        ? `group "${ADMIN_GROUP_NAME}" created (GroupId ${group.groupId})`
        : `group "${ADMIN_GROUP_NAME}" already existed (GroupId ${group.groupId})`,
    );

    /* 3 - tell every instance its cached access is stale ------------------ */
    await exec(
      `UPDATE ${AccessControlStamp.table}
          SET Version = Version + 1, ModifiedAt = SYSUTCDATETIME()
        WHERE StampName = @stampName`,
      { stampName: { type: sql.NVarChar(50), value: GLOBAL_STAMP } },
    );

    return { steps, groupId: Number(group.groupId) };
  });

  for (const step of outcome.steps) logger.info(`  ${step}`);

  logger.info('');
  logger.info(`Administrator group is GroupId ${outcome.groupId}.`);
  logger.info('Put somebody in it with:  npm run db:create:admin');
  logger.info('Every other group starts with no rights - set them on the group screen.');

  await closePool();
}

run().catch(async (error) => {
  logger.error('Seeding access control failed', error);
  await closePool();
  process.exit(1);
});

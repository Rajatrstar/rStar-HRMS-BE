/**
 * Syncs the permission catalog and the master roles into the database.
 *
 *   npm run db:seed:permissions
 *   npm run db:seed:permissions -- --reset-roles
 *
 * Idempotent, and deliberately asymmetric about what it overwrites:
 *
 *   - The CATALOG is always synced. src/enums/permission.enum.js is the source
 *     of truth, a code it no longer lists is retired, and a code it lists
 *     again is resurrected with its original PermissionId so existing grants
 *     keep pointing at the right row.
 *   - ROLE PERMISSIONS are applied only to a role this run just created.
 *     Re-applying the defaults every time would undo exactly the edits the
 *     whole feature exists to allow. `--reset-roles` forces it, for a
 *     development database that has drifted.
 *   - SUPER_ADMIN is the one exception and is always re-synced to every live
 *     permission at ALL. There is no code path that treats it as special, so
 *     this sync is the only thing that keeps it complete - which also means a
 *     newly added permission 403s for Super Admin until this script runs.
 *     That fails in the safe direction and is one command to fix.
 */
import { getPool, closePool } from '../src/config/db.js';
import { withTransaction, sql } from '../src/helpers/query.helper.js';
import {
  Permission,
  Role,
  RolePermission,
  AccessControlStamp,
  GLOBAL_STAMP,
} from '../src/models/index.js';
import {
  PERMISSION_CATALOG,
  PERMISSION_SCOPE,
  ROLE,
  ROLE_META,
  ROLE_PERMISSION_DEFAULTS,
} from '../src/enums/index.js';
import { logger } from '../src/utils/logger.js';

const resetRoles = process.argv.slice(2).includes('--reset-roles');

/** Inserts or updates one catalog row, clearing DeletedAt if it was retired. */
async function syncPermission(run, entry) {
  const rows = await run(
    `MERGE ${Permission.table} AS target
      USING (SELECT @permissionCode AS PermissionCode) AS source
         ON target.PermissionCode = source.PermissionCode
      WHEN MATCHED THEN
        UPDATE SET Module = @module,
                   Action = @action,
                   Description = @description,
                   IsScoped = @isScoped,
                   DefaultScope = @defaultScope,
                   -- The resurrection path. UQ_tblPermission_PermissionCode is
                   -- deliberately unfiltered so a retired code keeps its id.
                   DeletedAt = NULL,
                   ModifiedAt = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (PermissionCode, Module, Action, Description, IsScoped, DefaultScope)
        VALUES (@permissionCode, @module, @action, @description, @isScoped, @defaultScope)
      OUTPUT $action AS mergeAction, inserted.PermissionId AS permissionId;`,
    Permission.params({
      permissionCode: entry.code,
      module: entry.module,
      action: entry.action,
      description: entry.description,
      isScoped: entry.isScoped,
      defaultScope: entry.defaultScope,
    }),
  );
  return rows[0];
}

/**
 * Retires every live code the enum no longer lists.
 *
 * STRING_SPLIT rather than an IN list because the query helper has no array
 * support, and this is safe only because CK_tblPermission_CodeShape forbids a
 * comma inside a code. Never a hard DELETE - four foreign keys point here.
 */
async function retireMissing(run) {
  const codes = PERMISSION_CATALOG.map((entry) => entry.code).join(',');

  return run(
    `UPDATE ${Permission.table}
        SET DeletedAt = SYSUTCDATETIME(), ModifiedAt = SYSUTCDATETIME()
      OUTPUT deleted.PermissionCode AS retiredCode
      WHERE DeletedAt IS NULL
        AND PermissionCode NOT IN (SELECT value FROM STRING_SPLIT(@codes, ','));`,
    // NVarChar(MAX), not the column's own NVarChar(100): this is every code
    // joined together, roughly 1 KB, and binding it at the column width would
    // truncate the list and retire everything past the cut.
    { codes: { type: sql.NVarChar(sql.MAX), value: codes } },
  );
}

/** Inserts the role if it is absent. Returns { roleId, created }. */
async function ensureRole(run, roleCode) {
  const existing = await run(
    `SELECT ${Role.select(['roleId'])} FROM ${Role.table}
      WHERE RoleCode = @roleCode AND DeletedAt IS NULL`,
    Role.params({ roleCode }),
  );

  if (existing.length > 0) return { roleId: existing[0].roleId, created: false };

  const meta = ROLE_META[roleCode];
  const inserted = await run(
    `INSERT INTO ${Role.table} (RoleCode, RoleName, Description, IsSystem)
     OUTPUT inserted.RoleId AS roleId
     VALUES (@roleCode, @roleName, @description, 1)`,
    Role.params({ roleCode, roleName: meta.name, description: meta.description }),
  );

  return { roleId: inserted[0].roleId, created: true };
}

/**
 * Makes the role's live grants exactly `wanted` ({ code: scope }).
 *
 * Soft-deletes what is no longer wanted, inserts what is new, and updates a
 * scope that changed - rather than wiping and re-inserting, so the audit trail
 * on an untouched grant survives.
 */
async function applyGrants(run, roleId, wanted) {
  const current = await run(
    `SELECT rp.RolePermissionId AS rolePermissionId,
            p.PermissionCode    AS permissionCode,
            rp.Scope            AS scope
       FROM ${RolePermission.table} AS rp
       JOIN ${Permission.table}     AS p ON p.PermissionId = rp.PermissionId
      WHERE rp.RoleId = @roleId AND rp.DeletedAt IS NULL`,
    RolePermission.params({ roleId }),
  );

  const held = new Map(current.map((row) => [row.permissionCode, row]));
  let added = 0;
  let changed = 0;
  let removed = 0;

  for (const [code, scope] of Object.entries(wanted)) {
    const existing = held.get(code);

    if (!existing) {
      await run(
        `INSERT INTO ${RolePermission.table} (RoleId, PermissionId, Scope)
         SELECT @roleId, p.PermissionId, @scope
           FROM ${Permission.table} AS p
          WHERE p.PermissionCode = @permissionCode AND p.DeletedAt IS NULL`,
        {
          ...RolePermission.params({ roleId, scope }),
          permissionCode: Permission.param('permissionCode', code),
        },
      );
      added += 1;
      continue;
    }

    if (existing.scope !== scope) {
      await run(
        `UPDATE ${RolePermission.table}
            SET Scope = @scope, ModifiedAt = SYSUTCDATETIME()
          WHERE RolePermissionId = @rolePermissionId`,
        RolePermission.params({ scope, rolePermissionId: existing.rolePermissionId }),
      );
      changed += 1;
    }

    held.delete(code);
  }

  for (const leftover of held.values()) {
    await run(
      `UPDATE ${RolePermission.table}
          SET DeletedAt = SYSUTCDATETIME(), ModifiedAt = SYSUTCDATETIME()
        WHERE RolePermissionId = @rolePermissionId`,
      RolePermission.params({ rolePermissionId: leftover.rolePermissionId }),
    );
    removed += 1;
  }

  return { added, changed, removed };
}

async function run_() {
  await getPool();

  const summary = await withTransaction(async (run) => {
    let inserted = 0;
    for (const entry of PERMISSION_CATALOG) {
      const result = await syncPermission(run, entry);
      if (result?.mergeAction === 'INSERT') inserted += 1;
    }
    logger.info(
      `catalog: ${PERMISSION_CATALOG.length} permission(s) synced, ${inserted} new`,
    );

    const retired = await retireMissing(run);
    for (const row of retired) logger.info(`retired ${row.retiredCode}`);

    const roleOutcomes = [];
    for (const roleCode of Object.values(ROLE)) {
      const { roleId, created } = await ensureRole(run, roleCode);
      logger.info(`role ${roleCode} ${created ? 'created' : 'already present'} (${roleId})`);

      if (roleCode === ROLE.SUPER_ADMIN) {
        // Always every live permission, at the widest scope.
        const live = await run(
          `SELECT ${Permission.select(['permissionCode'])} FROM ${Permission.table}
            WHERE DeletedAt IS NULL`,
        );
        const wanted = Object.fromEntries(
          live.map((row) => [row.permissionCode, PERMISSION_SCOPE.ALL]),
        );
        const delta = await applyGrants(run, roleId, wanted);
        roleOutcomes.push({ roleCode, ...delta, forced: true });
        continue;
      }

      const defaults = ROLE_PERMISSION_DEFAULTS[roleCode] ?? {};

      if (!created && !resetRoles) {
        logger.info(`  skipped (already provisioned) - pass --reset-roles to overwrite`);
        roleOutcomes.push({ roleCode, skipped: true });
        continue;
      }

      const delta = await applyGrants(run, roleId, defaults);
      roleOutcomes.push({ roleCode, ...delta });
    }

    // Tells every other instance its cached permission sets are stale.
    await run(
      `UPDATE ${AccessControlStamp.table}
          SET Version = Version + 1, ModifiedAt = SYSUTCDATETIME()
        OUTPUT inserted.Version AS version
        WHERE StampName = @stampName`,
      AccessControlStamp.params({ stampName: GLOBAL_STAMP }),
    );

    return roleOutcomes;
  });

  for (const outcome of summary) {
    if (outcome.skipped) continue;
    logger.info(
      `  ${outcome.roleCode}: +${outcome.added} added, ~${outcome.changed} rescoped, ` +
        `-${outcome.removed} revoked${outcome.forced ? ' (always re-synced)' : ''}`,
    );
  }

  logger.info('Done.');
  await closePool();
}

run_().catch(async (error) => {
  logger.error('Permission seed failed', error);
  await closePool();
  process.exit(1);
});

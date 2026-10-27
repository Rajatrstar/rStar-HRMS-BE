/**
 * One person's access: the roles they hold, the groups they are in, their
 * per-user overrides, and what all of it adds up to.
 *
 * This is where the three layers meet for a single employee:
 *
 *   RBAC        PUT .../roles      Rahul holds EMPLOYEE.
 *   OVERRIDE    POST .../overrides Rahul alone also gets employees.view at ALL
 *                                  - his role is untouched and he gets nothing
 *                                  else HR Admin has.
 *   GROUP       PUT .../groups     Rahul joins FINANCE, which carries
 *                                  report.payroll for all ten of its members.
 *
 * The subject throughout is an EmployeeDetailId. Every write goes through
 * withAccessWrite (self-lockout, stamp, cache) and checks escalation first.
 */
import { createHash } from 'node:crypto';
import { query, querySets, queryOne, sql } from '../helpers/query.helper.js';
import { resolveAccess, resolveAccessUncached } from './access-control.service.js';
import {
  Role,
  Group,
  Permission,
  EmployeeRole,
  EmployeeGroup,
  EmployeePermission,
  RolePermission,
  GroupPermission,
  EmployeeDetails,
  EmployeeLogin,
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import {
  MESSAGES,
  ERROR_CODE,
  ROLE,
  OVERRIDE_EFFECT,
  PERMISSION_SCOPE,
  PERMISSION_SCOPE_RANK,
  PERMISSION_MODULE_META,
  PERMISSION_CATALOG,
} from '../enums/index.js';
import {
  withAccessWrite,
  withNumericIds,
  isUniqueViolation,
  loadLiveCatalog,
  storedScopeFor,
  loadGrantSet,
  assertActorCovers,
  assertEmployeeExists,
  GRANT_TARGET,
} from './access-write.service.js';

const CATALOG_ORDER = new Map(PERMISSION_CATALOG.map((entry, index) => [entry.code, index]));
const byCatalogOrder = (a, b) => (CATALOG_ORDER.get(a) ?? 9999) - (CATALOG_ORDER.get(b) ?? 9999);

/** The employee's live roles. `isActive` is shown: an inactive role grants nothing. */
const HELD_ROLES_SQL = `
  SELECT r.RoleId AS roleId, r.RoleCode AS roleCode, r.RoleName AS roleName,
         r.IsSystem AS isSystem, r.IsActive AS isActive, er.CreatedAt AS assignedAt
    FROM ${EmployeeRole.table} AS er
    JOIN ${Role.table} AS r ON r.RoleId = er.RoleId AND r.DeletedAt IS NULL
   WHERE er.EmployeeDetailId = @employeeDetailId AND er.DeletedAt IS NULL
   ORDER BY r.IsSystem DESC, r.RoleName`;

const HELD_GROUPS_SQL = `
  SELECT g.GroupId AS groupId, g.GroupCode AS groupCode, g.GroupName AS groupName,
         g.IsActive AS isActive, eg.CreatedAt AS joinedAt
    FROM ${EmployeeGroup.table} AS eg
    JOIN ${Group.table} AS g ON g.GroupId = eg.GroupId AND g.DeletedAt IS NULL
   WHERE eg.EmployeeDetailId = @employeeDetailId AND eg.DeletedAt IS NULL
   ORDER BY g.GroupName`;

const subject = (employeeDetailId) => EmployeeRole.params({ employeeDetailId });

/* -------------------------------------------------------------------------- */
/* The signed-in person's own ACL                                             */
/* -------------------------------------------------------------------------- */

/**
 * A short, stable fingerprint of everything that shapes the menu. Changes the
 * moment a grant, role or group changes, so a client comparing it against
 * GET /auth/me knows when its cached copy is stale.
 */
function accessVersion(permissions, roleIds, groupIds) {
  return createHash('sha256')
    .update(JSON.stringify({ permissions, roleIds, groupIds }))
    .digest('hex')
    .slice(0, 16);
}

/**
 * GET /access/my-permissions - the payload the frontend hydrates from.
 *
 * Only ACTIVE roles and groups are listed: they are the ones contributing to
 * the permission map beside them, and listing an inactive one would invite the
 * question "why does my Manager role do nothing".
 */
export async function getMyPermissions(employeeDetailId) {
  const [access, [roles = [], groups = [], logins = []]] = await Promise.all([
    resolveAccess(employeeDetailId),
    querySets(
      `${HELD_ROLES_SQL};
       ${HELD_GROUPS_SQL};
       SELECT ${EmployeeLogin.select(['email'])} FROM ${EmployeeLogin.table}
        WHERE EmployeeDetailId = @employeeDetailId;`,
      subject(employeeDetailId),
    ),
  ]);

  const codes = [...access.permissions.keys()].sort(byCatalogOrder);
  const permissions = Object.fromEntries(codes.map((code) => [code, access.permissions.get(code)]));

  const modules = new Map();
  for (const code of codes) {
    const module = code.split('.')[0];
    const scope = permissions[code];
    const current = modules.get(module);
    if (!current || PERMISSION_SCOPE_RANK[scope] > PERMISSION_SCOPE_RANK[current.maxScope]) {
      const meta = PERMISSION_MODULE_META[module] ?? { name: module, sortOrder: 9999 };
      modules.set(module, { code: module, name: meta.name, sortOrder: meta.sortOrder, maxScope: scope });
    }
  }

  const activeRoles = roles
    .filter((role) => role.isActive)
    .map((role) => ({ roleId: Number(role.roleId), code: role.roleCode, name: role.roleName }));
  const activeGroups = groups
    .filter((group) => group.isActive)
    .map((group) => ({ groupId: Number(group.groupId), code: group.groupCode, name: group.groupName }));

  return {
    employeeDetailId,
    email: logins[0]?.email ?? null,
    roles: activeRoles,
    groups: activeGroups,
    scopeContext: {
      employeeDetailId,
      departmentId: access.departmentId,
      managerId: access.managerId,
    },
    permissions,
    modules: [...modules.values()].sort((a, b) => a.sortOrder - b.sortOrder),
    version: accessVersion(
      permissions,
      activeRoles.map((role) => role.roleId),
      activeGroups.map((group) => group.groupId),
    ),
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Roles held                                                                 */
/* -------------------------------------------------------------------------- */

export async function getUserRoles(employeeDetailId) {
  await assertEmployeeExists(employeeDetailId);
  const rows = await query(HELD_ROLES_SQL, subject(employeeDetailId));
  const roles = rows.map((row) => withNumericIds(row, ['roleId']));

  // The single most likely onboarding mistake: Manager omits the self-service
  // set on purpose, so a Manager without Employee cannot book their own leave.
  const codes = new Set(roles.map((role) => role.roleCode));
  const warnings =
    codes.has(ROLE.MANAGER) && !codes.has(ROLE.EMPLOYEE) ? ['MANAGER_WITHOUT_EMPLOYEE'] : [];

  return { employeeDetailId, roles, warnings };
}

/**
 * Makes the employee's roles exactly `roleIds`.
 *
 * The actor must cover every role being added OR removed - taking SUPER_ADMIN
 * away from somebody is as much a decision about Super Admin as giving it.
 * Removing the last live, active Super Admin is refused outright.
 */
export async function replaceUserRoles(actor, employeeDetailId, roleIds) {
  await withAccessWrite(actor, async (run) => {
    await assertEmployeeExists(employeeDetailId, run);

    const found = roleIds.length
      ? await run(
          `SELECT RoleId AS roleId, RoleCode AS roleCode FROM ${Role.table}
            WHERE DeletedAt IS NULL
              AND RoleId IN (SELECT CAST(value AS BIGINT) FROM STRING_SPLIT(@ids, ','))`,
          { ids: { type: sql.NVarChar(sql.MAX), value: roleIds.join(',') } },
        )
      : [];
    const foundIds = new Set(found.map((row) => Number(row.roleId)));
    const unknown = roleIds.filter((id) => !foundIds.has(id));
    if (unknown.length > 0) {
      throw ApiError.unprocessable(MESSAGES.UNKNOWN_ROLE_IDS, {
        code: ERROR_CODE.UNKNOWN_ROLE_IDS,
        roleIds: unknown,
      });
    }

    const current = await run(
      `SELECT er.EmployeeRoleId AS employeeRoleId, er.RoleId AS roleId, r.RoleCode AS roleCode
         FROM ${EmployeeRole.table} AS er
         JOIN ${Role.table} AS r ON r.RoleId = er.RoleId
        WHERE er.EmployeeDetailId = @employeeDetailId AND er.DeletedAt IS NULL`,
      subject(employeeDetailId),
    );
    const currentIds = new Set(current.map((row) => Number(row.roleId)));
    const wanted = new Set(roleIds);

    const toAdd = roleIds.filter((id) => !currentIds.has(id));
    const toRemove = current.filter((row) => !wanted.has(Number(row.roleId)));

    for (const roleId of [...toAdd, ...toRemove.map((row) => Number(row.roleId))]) {
      const grants = await loadGrantSet(GRANT_TARGET.ROLE, roleId, run);
      assertActorCovers(actor, grants.values());
    }

    const actorId = { type: sql.BigInt, value: actor.employeeDetailId };

    for (const roleId of toAdd) {
      await run(
        `INSERT INTO ${EmployeeRole.table} (EmployeeDetailId, RoleId, CreatedBy, ModifiedBy)
         VALUES (@employeeDetailId, @roleId, @actorId, @actorId)`,
        { ...EmployeeRole.params({ employeeDetailId, roleId }), actorId },
      );
    }

    for (const row of toRemove) {
      await run(
        `UPDATE ${EmployeeRole.table}
            SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
          WHERE EmployeeRoleId = @employeeRoleId`,
        { ...EmployeeRole.params({ employeeRoleId: row.employeeRoleId }), actorId },
      );
    }

    if (toRemove.some((row) => row.roleCode === ROLE.SUPER_ADMIN)) {
      const [remaining] = await run(
        `SELECT COUNT(*) AS holders
           FROM ${EmployeeRole.table} AS er
           JOIN ${Role.table} AS r ON r.RoleId = er.RoleId
           JOIN ${EmployeeDetails.table} AS d ON d.EmployeeDetailId = er.EmployeeDetailId
          WHERE r.RoleCode = @roleCode AND r.DeletedAt IS NULL
            AND er.DeletedAt IS NULL
            AND d.DeletedAt IS NULL AND d.IsActive = 1`,
        Role.params({ roleCode: ROLE.SUPER_ADMIN }),
      );
      if (remaining.holders === 0) {
        throw ApiError.conflict(MESSAGES.LAST_SUPER_ADMIN, { code: ERROR_CODE.LAST_SUPER_ADMIN });
      }
    }
  });

  return getUserRoles(employeeDetailId);
}

/* -------------------------------------------------------------------------- */
/* Groups held                                                                */
/* -------------------------------------------------------------------------- */

export async function getUserGroups(employeeDetailId) {
  await assertEmployeeExists(employeeDetailId);
  const rows = await query(HELD_GROUPS_SQL, subject(employeeDetailId));
  return { employeeDetailId, groups: rows.map((row) => withNumericIds(row, ['groupId'])) };
}

/** Makes the employee's groups exactly `groupIds`. Same escalation rule as roles. */
export async function replaceUserGroups(actor, employeeDetailId, groupIds) {
  await withAccessWrite(actor, async (run) => {
    await assertEmployeeExists(employeeDetailId, run);

    const found = groupIds.length
      ? await run(
          `SELECT GroupId AS groupId FROM ${Group.table}
            WHERE DeletedAt IS NULL
              AND GroupId IN (SELECT CAST(value AS BIGINT) FROM STRING_SPLIT(@ids, ','))`,
          { ids: { type: sql.NVarChar(sql.MAX), value: groupIds.join(',') } },
        )
      : [];
    const foundIds = new Set(found.map((row) => Number(row.groupId)));
    const unknown = groupIds.filter((id) => !foundIds.has(id));
    if (unknown.length > 0) {
      throw ApiError.unprocessable(MESSAGES.UNKNOWN_GROUP_IDS, {
        code: ERROR_CODE.UNKNOWN_GROUP_IDS,
        groupIds: unknown,
      });
    }

    const current = await run(
      `SELECT EmployeeGroupId AS employeeGroupId, GroupId AS groupId
         FROM ${EmployeeGroup.table}
        WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL`,
      subject(employeeDetailId),
    );
    const currentIds = new Set(current.map((row) => Number(row.groupId)));
    const wanted = new Set(groupIds);

    const toAdd = groupIds.filter((id) => !currentIds.has(id));
    const toRemove = current.filter((row) => !wanted.has(Number(row.groupId)));

    for (const groupId of [...toAdd, ...toRemove.map((row) => Number(row.groupId))]) {
      const grants = await loadGrantSet(GRANT_TARGET.GROUP, groupId, run);
      assertActorCovers(actor, grants.values());
    }

    const actorId = { type: sql.BigInt, value: actor.employeeDetailId };

    for (const groupId of toAdd) {
      await run(
        `INSERT INTO ${EmployeeGroup.table} (EmployeeDetailId, GroupId, CreatedBy, ModifiedBy)
         VALUES (@employeeDetailId, @groupId, @actorId, @actorId)`,
        { ...EmployeeGroup.params({ employeeDetailId, groupId }), actorId },
      );
    }

    for (const row of toRemove) {
      await run(
        `UPDATE ${EmployeeGroup.table}
            SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
          WHERE EmployeeGroupId = @employeeGroupId`,
        { ...EmployeeGroup.params({ employeeGroupId: row.employeeGroupId }), actorId },
      );
    }
  });

  return getUserGroups(employeeDetailId);
}

/* -------------------------------------------------------------------------- */
/* Overrides                                                                  */
/* -------------------------------------------------------------------------- */

const OVERRIDE_COLUMNS = `
  ep.EmployeePermissionId AS overrideId,
  p.PermissionId          AS permissionId,
  p.PermissionCode        AS code,
  p.IsScoped              AS isScoped,
  ep.Effect               AS effect,
  ep.Scope                AS scope,
  ep.Reason               AS reason,
  ep.ExpiresAt            AS expiresAt,
  CAST(CASE WHEN ep.ExpiresAt IS NOT NULL AND ep.ExpiresAt <= SYSUTCDATETIME()
            THEN 1 ELSE 0 END AS BIT) AS isExpired,
  ep.CreatedBy            AS createdById,
  CONCAT(c.FirstName, ' ', c.LastName) AS createdByName,
  ep.CreatedAt            AS createdAt,
  ep.ModifiedAt           AS modifiedAt`;

const OVERRIDE_FROM = `
  FROM ${EmployeePermission.table} AS ep
  JOIN ${Permission.table} AS p ON p.PermissionId = ep.PermissionId
  LEFT JOIN ${EmployeeDetails.table} AS c ON c.EmployeeDetailId = ep.CreatedBy`;

function presentOverride(row) {
  const out = withNumericIds(row, ['overrideId', 'permissionId', 'createdById']);
  // Stored at ALL for an unscoped GRANT; the client was never asked for one.
  if (!out.isScoped && out.effect === OVERRIDE_EFFECT.GRANT) out.scope = null;
  return out;
}

export async function listOverrides(employeeDetailId) {
  await assertEmployeeExists(employeeDetailId);

  const rows = await query(
    `SELECT ${OVERRIDE_COLUMNS} ${OVERRIDE_FROM}
      WHERE ep.EmployeeDetailId = @employeeDetailId AND ep.DeletedAt IS NULL
      ORDER BY p.Module, p.Action`,
    subject(employeeDetailId),
  );

  return { employeeDetailId, overrides: rows.map(presentOverride) };
}

async function getOverride(employeeDetailId, overrideId) {
  const row = await queryOne(
    `SELECT ${OVERRIDE_COLUMNS} ${OVERRIDE_FROM}
      WHERE ep.EmployeePermissionId = @overrideId
        AND ep.EmployeeDetailId = @employeeDetailId
        AND ep.DeletedAt IS NULL`,
    {
      ...subject(employeeDetailId),
      overrideId: EmployeePermission.param('employeePermissionId', overrideId),
    },
  );
  if (!row) throw ApiError.notFound(MESSAGES.OVERRIDE_NOT_FOUND);
  return presentOverride(row);
}

/** The override row, locked, for an update or delete in progress. */
async function lockOverride(run, employeeDetailId, overrideId) {
  const rows = await run(
    `SELECT ep.EmployeePermissionId AS overrideId, ep.Effect AS effect, ep.Scope AS scope,
            p.PermissionCode AS code, p.IsScoped AS isScoped
       FROM ${EmployeePermission.table} AS ep WITH (UPDLOCK, HOLDLOCK)
       JOIN ${Permission.table} AS p ON p.PermissionId = ep.PermissionId
      WHERE ep.EmployeePermissionId = @overrideId
        AND ep.EmployeeDetailId = @employeeDetailId
        AND ep.DeletedAt IS NULL`,
    {
      ...subject(employeeDetailId),
      overrideId: EmployeePermission.param('employeePermissionId', overrideId),
    },
  );
  if (rows.length === 0) throw ApiError.notFound(MESSAGES.OVERRIDE_NOT_FOUND);
  return rows[0];
}

function assertFuture(expiresAt) {
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw ApiError.unprocessable(MESSAGES.EXPIRY_IN_PAST, { code: ERROR_CODE.EXPIRY_IN_PAST });
  }
}

/**
 * Adds one exception for one person.
 *
 *   GRANT - gives a permission their roles and groups do not (Rahul and
 *           employees.view at ALL). The actor must hold it at least as widely.
 *   DENY  - removes a permission whatever granted it. Takes no scope.
 */
export async function createOverride(actor, employeeDetailId, input) {
  let overrideId;

  try {
    overrideId = await withAccessWrite(actor, async (run) => {
      await assertEmployeeExists(employeeDetailId, run);

      const catalog = await loadLiveCatalog(run);
      const entry = catalog.get(input.permissionId);
      if (!entry) {
        throw ApiError.unprocessable(MESSAGES.UNKNOWN_PERMISSION_IDS, {
          code: ERROR_CODE.UNKNOWN_PERMISSION_IDS,
          permissionIds: [input.permissionId],
        });
      }

      assertFuture(input.expiresAt);

      let scope = null;
      if (input.effect === OVERRIDE_EFFECT.DENY) {
        if (input.scope) {
          throw ApiError.unprocessable(MESSAGES.SCOPE_NOT_SUPPORTED, {
            code: ERROR_CODE.SCOPE_NOT_SUPPORTED,
            field: 'scope',
            reason: 'A DENY override takes no scope',
          });
        }
      } else {
        scope = storedScopeFor(entry, input.scope);
        assertActorCovers(actor, [{ code: entry.code, scope }]);
      }

      const rows = await run(
        `INSERT INTO ${EmployeePermission.table}
              (EmployeeDetailId, PermissionId, Effect, Scope, Reason, ExpiresAt, CreatedBy, ModifiedBy)
         OUTPUT inserted.EmployeePermissionId AS overrideId
         VALUES (@employeeDetailId, @permissionId, @effect, @scope, @reason, @expiresAt, @actorId, @actorId)`,
        {
          ...EmployeePermission.params({
            employeeDetailId,
            permissionId: entry.permissionId,
            effect: input.effect,
            scope,
            reason: input.reason,
            expiresAt: input.expiresAt ?? null,
          }),
          actorId: EmployeePermission.param('createdBy', actor.employeeDetailId),
        },
      );
      return Number(rows[0].overrideId);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.OVERRIDE_EXISTS, { code: ERROR_CODE.OVERRIDE_ALREADY_EXISTS });
    }
    throw error;
  }

  return getOverride(employeeDetailId, overrideId);
}

/**
 * Changes an override's scope, reason or expiry. The effect and the permission
 * are fixed: turning a GRANT into a DENY is a different decision, made by
 * removing one and adding the other, so the history reads that way too.
 */
export async function updateOverride(actor, employeeDetailId, overrideId, input) {
  await withAccessWrite(actor, async (run) => {
    const current = await lockOverride(run, employeeDetailId, overrideId);

    let scope = current.scope;
    if ('scope' in input) {
      if (current.effect === OVERRIDE_EFFECT.DENY) {
        throw ApiError.unprocessable(MESSAGES.OVERRIDE_DENY_HAS_NO_SCOPE, {
          code: ERROR_CODE.SCOPE_NOT_SUPPORTED,
          field: 'scope',
        });
      }
      scope = storedScopeFor({ code: current.code, isScoped: Boolean(current.isScoped) }, input.scope);
      // The wider of old and new, as for a role's rescope.
      const wider =
        PERMISSION_SCOPE_RANK[scope] >= PERMISSION_SCOPE_RANK[current.scope] ? scope : current.scope;
      assertActorCovers(actor, [{ code: current.code, scope: wider }]);
    }

    if ('expiresAt' in input) assertFuture(input.expiresAt);

    await run(
      `UPDATE ${EmployeePermission.table}
          SET Scope      = @scope,
              Reason     = COALESCE(@reason, Reason),
              ExpiresAt  = CASE WHEN @setExpiresAt = 1 THEN @expiresAt ELSE ExpiresAt END,
              ModifiedBy = @actorId,
              ModifiedAt = SYSUTCDATETIME()
        WHERE EmployeePermissionId = @overrideId`,
      {
        ...EmployeePermission.params({
          scope,
          reason: input.reason ?? null,
          expiresAt: input.expiresAt ?? null,
        }),
        setExpiresAt: { type: sql.Bit, value: 'expiresAt' in input },
        overrideId: EmployeePermission.param('employeePermissionId', overrideId),
        actorId: EmployeePermission.param('modifiedBy', actor.employeeDetailId),
      },
    );
  });

  return getOverride(employeeDetailId, overrideId);
}

/**
 * Removes an override. Removing a GRANT takes access away; removing a DENY
 * hands back whatever the person's roles and groups give, so the actor must
 * hold that permission themselves - otherwise lifting a DENY would be a way
 * to grant something they could not grant directly.
 */
export async function deleteOverride(actor, employeeDetailId, overrideId) {
  return withAccessWrite(actor, async (run) => {
    const current = await lockOverride(run, employeeDetailId, overrideId);

    assertActorCovers(actor, [
      {
        code: current.code,
        scope: current.effect === OVERRIDE_EFFECT.DENY ? PERMISSION_SCOPE.OWN : current.scope,
      },
    ]);

    await run(
      `UPDATE ${EmployeePermission.table}
          SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE EmployeePermissionId = @overrideId`,
      {
        overrideId: EmployeePermission.param('employeePermissionId', overrideId),
        actorId: EmployeePermission.param('modifiedBy', actor.employeeDetailId),
      },
    );

    return {
      overrideId: Number(current.overrideId),
      employeeDetailId,
      permission: current.code,
      effect: current.effect,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Effective permissions, with the reason for each                            */
/* -------------------------------------------------------------------------- */

/**
 * Every source that grants or denies anything, one row per source. Same
 * filters as the resolver: live and active roles and groups, live and
 * unexpired overrides, live permissions.
 */
const SOURCES_SQL = `
  SELECT p.PermissionCode AS code, p.IsScoped AS isScoped,
         'ROLE' AS type, r.RoleName AS name, rp.Scope AS scope,
         CAST(NULL AS NVARCHAR(10)) AS effect, CAST(NULL AS NVARCHAR(255)) AS reason,
         CAST(NULL AS DATETIME2(3)) AS expiresAt
    FROM ${EmployeeRole.table} AS er
    JOIN ${Role.table} AS r            ON r.RoleId = er.RoleId AND r.DeletedAt IS NULL AND r.IsActive = 1
    JOIN ${RolePermission.table} AS rp ON rp.RoleId = r.RoleId AND rp.DeletedAt IS NULL
    JOIN ${Permission.table} AS p      ON p.PermissionId = rp.PermissionId AND p.DeletedAt IS NULL
   WHERE er.EmployeeDetailId = @employeeDetailId AND er.DeletedAt IS NULL

  UNION ALL
  SELECT p.PermissionCode, p.IsScoped, 'GROUP', g.GroupName, gp.Scope, NULL, NULL, NULL
    FROM ${EmployeeGroup.table} AS eg
    JOIN ${Group.table} AS g            ON g.GroupId = eg.GroupId AND g.DeletedAt IS NULL AND g.IsActive = 1
    JOIN ${GroupPermission.table} AS gp ON gp.GroupId = g.GroupId AND gp.DeletedAt IS NULL
    JOIN ${Permission.table} AS p       ON p.PermissionId = gp.PermissionId AND p.DeletedAt IS NULL
   WHERE eg.EmployeeDetailId = @employeeDetailId AND eg.DeletedAt IS NULL

  UNION ALL
  SELECT p.PermissionCode, p.IsScoped, 'OVERRIDE', NULL, ep.Scope, ep.Effect, ep.Reason, ep.ExpiresAt
    FROM ${EmployeePermission.table} AS ep
    JOIN ${Permission.table} AS p ON p.PermissionId = ep.PermissionId AND p.DeletedAt IS NULL
   WHERE ep.EmployeeDetailId = @employeeDetailId
     AND ep.DeletedAt IS NULL
     AND (ep.ExpiresAt IS NULL OR ep.ExpiresAt > SYSUTCDATETIME())`;

/**
 * For each permission that any source mentions: the final answer, and every
 * source behind it - so "why can Rahul see everyone?" has a one-glance answer
 * ("OVERRIDE GRANT at ALL, reason: ...").
 *
 * The final scope comes from the real resolver, uncached, rather than being
 * recomputed here from the sources: two implementations of DENY-wins and
 * widest-scope-wins would eventually disagree, and this screen exists to
 * explain the resolver, not to second-guess it.
 */
export async function getEffectivePermissions(employeeDetailId) {
  await assertEmployeeExists(employeeDetailId);

  const [access, rows] = await Promise.all([
    resolveAccessUncached(employeeDetailId),
    query(SOURCES_SQL, subject(employeeDetailId)),
  ]);

  const byCode = new Map();
  for (const row of rows) {
    const code = String(row.code).toLowerCase();
    if (!byCode.has(code)) byCode.set(code, { isScoped: Boolean(row.isScoped), sources: [] });

    const source =
      row.type === 'OVERRIDE'
        ? {
            type: 'OVERRIDE',
            effect: row.effect,
            ...(row.effect === OVERRIDE_EFFECT.GRANT ? { scope: row.scope } : {}),
            reason: row.reason,
            expiresAt: row.expiresAt,
          }
        : { type: row.type, name: row.name, scope: row.scope };

    byCode.get(code).sources.push(source);
  }

  const permissions = [...byCode.keys()].sort(byCatalogOrder).map((code) => {
    const { isScoped, sources } = byCode.get(code);
    const effectiveScope = access.scopeOf(code);
    return {
      code,
      isScoped,
      granted: effectiveScope !== null,
      effectiveScope,
      sources,
    };
  });

  return { employeeDetailId, permissions };
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

/** GET /access/users/:id - the person and their three panels in one call. */
export async function getUserAccess(employeeDetailId) {
  const employee = await queryOne(
    `SELECT ${EmployeeDetails.select([
      'employeeDetailId',
      'employeeCode',
      'firstName',
      'lastName',
      'workEmail',
      'departmentId',
      'managerId',
      'isActive',
    ])}
       FROM ${EmployeeDetails.table}
      WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL`,
    EmployeeDetails.params({ employeeDetailId }),
  );

  if (!employee) throw ApiError.notFound(MESSAGES.EMPLOYEE_NOT_FOUND);

  const [roles, groups, overrides] = await Promise.all([
    getUserRoles(employeeDetailId),
    getUserGroups(employeeDetailId),
    listOverrides(employeeDetailId),
  ]);

  return {
    employee: withNumericIds(employee, ['employeeDetailId', 'departmentId', 'managerId']),
    roles: roles.roles,
    groups: groups.groups,
    overrides: overrides.overrides,
    warnings: roles.warnings,
  };
}

/**
 * The rules every access-control WRITE obeys, in one place.
 *
 * Roles, groups and per-user overrides are three admin screens over one
 * resolver, and the same three things can go wrong on all of them:
 *
 *   1. ESCALATION. An admin grants access they do not hold themselves. HR Admin
 *      may assign roles; if HR Admin could also assign SUPER_ADMIN, or add
 *      payroll.configure to a group they belong to, "may assign roles" would be
 *      a wildcard with extra steps. assertActorCovers() refuses any grant wider
 *      than the actor's own - on add AND on remove, because taking a role away
 *      from a Super Admin is managing a role you could never have granted.
 *   2. SELF-LOCKOUT. An admin strips their own administrative access, and only
 *      a database edit brings it back. Checked AFTER the write, inside the
 *      transaction, by re-running the real resolver - so the check can never
 *      disagree with what the resolver will say once the change commits.
 *   3. STALE CACHES. Every write bumps tblAccessControlStamp in the same
 *      transaction and clears this instance's cache after commit; other
 *      instances notice the stamp within ACCESS_CONTROL_STAMP_POLL_SECONDS.
 *
 * withAccessWrite() wraps all three around the caller's statements, so a new
 * admin endpoint gets them by construction rather than by remembering.
 */
import { query, withTransaction, sql } from '../helpers/query.helper.js';
import { resolvePermissionsWith } from './access-control.service.js';
import { clear as clearAccessCache } from '../utils/access-cache.js';
import { ApiError } from '../utils/api-error.js';
import {
  Permission,
  RolePermission,
  GroupPermission,
  EmployeeDetails,
  AccessControlStamp,
  GLOBAL_STAMP,
} from '../models/index.js';
import {
  MESSAGES,
  ERROR_CODE,
  PERMISSION_SCOPE,
  PERMISSION_SCOPE_RANK,
  ACCESS_ADMIN_MODULES,
} from '../enums/index.js';

/* -------------------------------------------------------------------------- */
/* Small shared pieces                                                        */
/* -------------------------------------------------------------------------- */

/** SQL Server's two unique-violation numbers: 2627 constraint, 2601 index. */
export function isUniqueViolation(error) {
  return error?.number === 2601 || error?.number === 2627;
}

/**
 * BIGINT comes back from the driver as a string. Ids leave this API as JSON
 * numbers - see the note on withNumericIds in organization.service.js.
 */
export function withNumericIds(row, props) {
  if (!row) return row;
  const copy = { ...row };
  for (const prop of props) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  return copy;
}

/**
 * A LIKE pattern matching `search` anywhere, with the user's own wildcards
 * escaped - "50%" should find "50%", not everything starting with 50.
 */
export function containsPattern(search) {
  return `%${search.replace(/[[%_]/g, '[$&]')}%`;
}

/** Turns page/pageSize into OFFSET/FETCH parameters and the reply's meta. */
export function paging({ page = 1, pageSize = 20 }) {
  return {
    page,
    pageSize,
    params: {
      offset: { type: sql.Int, value: (page - 1) * pageSize },
      pageSize: { type: sql.Int, value: pageSize },
    },
  };
}

/** True when `held` reaches at least as far as `wanted`. */
function scopeCovers(held, wanted) {
  return (
    held !== null &&
    held !== undefined &&
    PERMISSION_SCOPE_RANK[held] >= PERMISSION_SCOPE_RANK[wanted]
  );
}

const isAccessAdminCode = (code) => ACCESS_ADMIN_MODULES.includes(code.split('.')[0]);

/* -------------------------------------------------------------------------- */
/* The catalog, and turning a request into grants                             */
/* -------------------------------------------------------------------------- */

/**
 * Every live permission by id.
 *
 * @param {Function} [run] a transaction's run(); the pool is used without one
 * @returns {Promise<Map<number, { permissionId: number, code: string, isScoped: boolean }>>}
 */
export async function loadLiveCatalog(run) {
  const statement = `SELECT ${Permission.select(['permissionId', 'permissionCode', 'isScoped'])}
                       FROM ${Permission.table}
                      WHERE DeletedAt IS NULL`;
  const rows = run ? await run(statement) : await query(statement);

  return new Map(
    rows.map((row) => [
      Number(row.permissionId),
      {
        permissionId: Number(row.permissionId),
        code: row.permissionCode,
        isScoped: Boolean(row.isScoped),
      },
    ]),
  );
}

/**
 * The scope stored for one requested grant, or a 422.
 *
 * An unscoped permission (roles.create - there is no "my role") is stored at
 * ALL, the same convention scripts/seed-permissions.js uses, so the resolver's
 * MAX(ScopeRank) never has to special-case it. A client that sends a scope
 * for one is told so rather than silently ignored: it is a bug in the screen.
 */
export function storedScopeFor(entry, requestedScope, field = 'scope') {
  if (!entry.isScoped) {
    if (requestedScope) {
      throw ApiError.unprocessable(MESSAGES.SCOPE_NOT_SUPPORTED, {
        code: ERROR_CODE.SCOPE_NOT_SUPPORTED,
        field,
        permission: entry.code,
      });
    }
    return PERMISSION_SCOPE.ALL;
  }

  if (!requestedScope) {
    throw ApiError.unprocessable(MESSAGES.SCOPE_REQUIRED, {
      code: ERROR_CODE.SCOPE_REQUIRED,
      field,
      permission: entry.code,
    });
  }
  return requestedScope;
}

/**
 * Turns `[{ permissionId, scope }]` from a matrix save into the grant set it
 * describes: Map<permissionId, { permissionId, code, scope }>.
 *
 * Every id must be a live permission, each may appear once, and the scope
 * must suit the permission. All of it is checked before anything is written.
 */
export function toGrantSet(items, catalog) {
  const seen = new Set();
  const duplicates = new Set();
  const unknown = [];

  for (const item of items) {
    if (seen.has(item.permissionId)) duplicates.add(item.permissionId);
    seen.add(item.permissionId);
    if (!catalog.has(item.permissionId)) unknown.push(item.permissionId);
  }

  if (duplicates.size > 0) {
    throw ApiError.badRequest(MESSAGES.DUPLICATE_PERMISSION_IDS, {
      code: ERROR_CODE.DUPLICATE_PERMISSION_IDS,
      permissionIds: [...duplicates],
    });
  }
  if (unknown.length > 0) {
    throw ApiError.unprocessable(MESSAGES.UNKNOWN_PERMISSION_IDS, {
      code: ERROR_CODE.UNKNOWN_PERMISSION_IDS,
      permissionIds: unknown,
    });
  }

  return new Map(
    items.map((item, index) => {
      const entry = catalog.get(item.permissionId);
      return [
        entry.permissionId,
        {
          permissionId: entry.permissionId,
          code: entry.code,
          scope: storedScopeFor(entry, item.scope, `permissions[${index}].scope`),
        },
      ];
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Escalation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Refuses unless the actor holds every one of `grants` at least as widely.
 *
 * Super Admin passes everything here without a special case: it holds every
 * permission at ALL as real rows, which is the whole reason it has no bypass.
 *
 * @param {import('./access-control.service.js').AccessContext} actor
 * @param {Iterable<{ code: string, scope: string }>} grants
 */
export function assertActorCovers(actor, grants) {
  const uncovered = [];

  for (const grant of grants) {
    const held = actor.scopeOf(grant.code);
    if (!scopeCovers(held, grant.scope)) {
      uncovered.push({ permission: grant.code, requiredScope: grant.scope, heldScope: held });
    }
  }

  if (uncovered.length > 0) {
    throw ApiError.forbidden(MESSAGES.ESCALATION_BLOCKED, {
      code: ERROR_CODE.ESCALATION_BLOCKED,
      permissions: uncovered,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Role and group grant sets                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The two grant tables have the same shape and differ only in names, so one
 * implementation serves both. Column names are constants, never user input.
 */
export const GRANT_TARGET = Object.freeze({
  ROLE: Object.freeze({ model: RolePermission, ownerColumn: 'RoleId', rowIdColumn: 'RolePermissionId' }),
  GROUP: Object.freeze({ model: GroupPermission, ownerColumn: 'GroupId', rowIdColumn: 'GroupPermissionId' }),
});

/**
 * The live grants of one role or group.
 *
 * @returns {Promise<Map<number, { rowId: number, permissionId: number, code: string, isScoped: boolean, scope: string }>>}
 */
export async function loadGrantSet(target, ownerId, run) {
  const statement = `
    SELECT gp.${target.rowIdColumn} AS rowId,
           p.PermissionId           AS permissionId,
           p.PermissionCode         AS code,
           p.IsScoped               AS isScoped,
           gp.Scope                 AS scope
      FROM ${target.model.table} AS gp
      JOIN ${Permission.table}   AS p ON p.PermissionId = gp.PermissionId
                                     AND p.DeletedAt IS NULL
     WHERE gp.${target.ownerColumn} = @ownerId
       AND gp.DeletedAt IS NULL
     ORDER BY p.Module, p.Action`;
  const params = { ownerId: { type: sql.BigInt, value: ownerId } };
  const rows = run ? await run(statement, params) : await query(statement, params);

  return new Map(
    rows.map((row) => [
      Number(row.permissionId),
      {
        rowId: Number(row.rowId),
        permissionId: Number(row.permissionId),
        code: row.code,
        isScoped: Boolean(row.isScoped),
        scope: row.scope,
      },
    ]),
  );
}

/**
 * What it takes to get from `current` to `wanted`.
 *
 * `touched` is everything whose reach changes - added, removed, or rescoped
 * either way - at the WIDER of its old and new scope. That is what the actor
 * must cover: narrowing payroll.view from ALL to TEAM is still a decision
 * about payroll.view at ALL.
 */
export function diffGrantSets(current, wanted) {
  const toAdd = [];
  const toRescope = [];
  const toRemove = [];
  const touched = [];

  const wider = (a, b) => (PERMISSION_SCOPE_RANK[a] >= PERMISSION_SCOPE_RANK[b] ? a : b);

  for (const [permissionId, grant] of wanted) {
    const existing = current.get(permissionId);
    if (!existing) {
      toAdd.push(grant);
      touched.push(grant);
    } else if (existing.scope !== grant.scope) {
      toRescope.push({ ...grant, rowId: existing.rowId });
      touched.push({ code: grant.code, scope: wider(existing.scope, grant.scope) });
    }
  }

  for (const [permissionId, existing] of current) {
    if (!wanted.has(permissionId)) {
      toRemove.push(existing);
      touched.push(existing);
    }
  }

  return { toAdd, toRescope, toRemove, touched };
}

/**
 * Applies a diff row by row rather than wiping and re-inserting, so an
 * untouched grant keeps its CreatedBy/CreatedAt - the same choice the seed
 * makes, for the same audit reason.
 */
export async function applyGrantDiff(run, target, ownerId, diff, actorId) {
  const { model, ownerColumn, rowIdColumn } = target;
  const actor = { type: sql.BigInt, value: actorId };

  for (const grant of diff.toAdd) {
    await run(
      `INSERT INTO ${model.table} (${ownerColumn}, PermissionId, Scope, CreatedBy, ModifiedBy)
       VALUES (@ownerId, @permissionId, @scope, @actorId, @actorId)`,
      {
        ownerId: { type: sql.BigInt, value: ownerId },
        ...model.params({ permissionId: grant.permissionId, scope: grant.scope }),
        actorId: actor,
      },
    );
  }

  for (const grant of diff.toRescope) {
    await run(
      `UPDATE ${model.table}
          SET Scope = @scope, ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE ${rowIdColumn} = @rowId`,
      {
        ...model.params({ scope: grant.scope }),
        rowId: { type: sql.BigInt, value: grant.rowId },
        actorId: actor,
      },
    );
  }

  for (const grant of diff.toRemove) {
    await run(
      `UPDATE ${model.table}
          SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE ${rowIdColumn} = @rowId`,
      { rowId: { type: sql.BigInt, value: grant.rowId }, actorId: actor },
    );
  }

  return {
    added: diff.toAdd.length,
    rescoped: diff.toRescope.length,
    removed: diff.toRemove.length,
  };
}

/** A grant set as the API returns it, in catalog order. */
export function grantSetToList(grantSet) {
  return [...grantSet.values()].map(({ permissionId, code, isScoped, scope }) => ({
    permissionId,
    code,
    isScoped,
    // An unscoped permission is stored at ALL by convention; the client was
    // never asked for a scope, so it is not shown one back.
    scope: isScoped ? scope : null,
  }));
}

/* -------------------------------------------------------------------------- */
/* Employees as targets                                                       */
/* -------------------------------------------------------------------------- */

/** 404 unless the id is a live employee. Inactive ones may still be managed. */
export async function assertEmployeeExists(employeeDetailId, run) {
  const statement = `SELECT TOP (1) EmployeeDetailId AS employeeDetailId
                       FROM ${EmployeeDetails.table}
                      WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL`;
  const params = EmployeeDetails.params({ employeeDetailId });
  const rows = run ? await run(statement, params) : await query(statement, params);

  if (rows.length === 0) {
    throw ApiError.notFound(MESSAGES.EMPLOYEE_NOT_FOUND);
  }
}

/** The subset of `ids` that are NOT live employees. */
export async function missingEmployeeIds(ids, run) {
  if (ids.length === 0) return [];

  // STRING_SPLIT, because the query helper has no array binding. Safe: every
  // element was validated as an integer before it got here.
  const rows = await run(
    `SELECT CAST(s.value AS BIGINT) AS employeeDetailId
       FROM STRING_SPLIT(@ids, ',') AS s
      WHERE NOT EXISTS (
              SELECT 1 FROM ${EmployeeDetails.table} AS d
               WHERE d.EmployeeDetailId = CAST(s.value AS BIGINT)
                 AND d.DeletedAt IS NULL
            )`,
    { ids: { type: sql.NVarChar(sql.MAX), value: ids.join(',') } },
  );
  return rows.map((row) => Number(row.employeeDetailId));
}

/* -------------------------------------------------------------------------- */
/* The wrapper                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Refuses, by rolling back, a change that strips the actor's own access-admin
 * permissions. Runs after the writes, inside their transaction.
 */
async function assertNoSelfLockout(run, actor) {
  const after = await resolvePermissionsWith(run, actor.employeeDetailId);

  const lost = [...actor.permissions.keys()].filter(
    (code) => isAccessAdminCode(code) && !after.has(code),
  );

  if (lost.length > 0) {
    throw ApiError.conflict(MESSAGES.SELF_LOCKOUT_BLOCKED, {
      code: ERROR_CODE.SELF_LOCKOUT_BLOCKED,
      lostPermissions: lost,
    });
  }
}

/**
 * Runs an access-control write.
 *
 *   return withAccessWrite(actor, async (run) => { ...statements... });
 *
 * Inside one transaction: the caller's statements, then the self-lockout check
 * against the uncommitted result, then the stamp bump. After commit, this
 * instance's cache is cleared - wholesale, because working out who a role or
 * group change touches costs more than rebuilding the few entries used next.
 *
 * @param {import('./access-control.service.js').AccessContext} actor
 * @param {(run: Function) => Promise<T>} work
 * @returns {Promise<T>}
 * @template T
 */
export async function withAccessWrite(actor, work) {
  const outcome = await withTransaction(async (run) => {
    const result = await work(run);

    await assertNoSelfLockout(run, actor);

    await run(
      `UPDATE ${AccessControlStamp.table}
          SET Version = Version + 1, ModifiedAt = SYSUTCDATETIME()
        WHERE StampName = @stampName`,
      AccessControlStamp.params({ stampName: GLOBAL_STAMP }),
    );

    return result;
  });

  clearAccessCache();
  return outcome;
}

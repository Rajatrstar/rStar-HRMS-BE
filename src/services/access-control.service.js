/**
 * Resolving what one person may do.
 *
 * Three sources stack - the roles they hold, the groups they belong to, and
 * per-user overrides - and two rules settle the result:
 *
 *   1. Any live DENY override removes the permission, whatever granted it.
 *   2. Otherwise the effective scope is the WIDEST any contributing source
 *      gave, which the database computes as MAX(ScopeRank).
 *
 * Those are two separate questions. Precedence decides allow or deny; scope is
 * a union, not a precedence chain. An override GRANT at OWN does not shrink a
 * role grant at ALL - to narrow somebody, take the wide role away.
 *
 * Nothing here touches req or res. The resolved AccessContext is a frozen
 * plain object, so a controller can hand it to a service as the actor argument
 * without dragging Express into the service layer.
 */
import { querySets } from '../helpers/query.helper.js';
import {
  Permission,
  Role,
  Group,
  RolePermission,
  GroupPermission,
  EmployeeRole,
  EmployeeGroup,
  EmployeePermission,
} from '../models/index.js';
import { EmployeeDetails } from '../models/index.js';
import { PERMISSION_SCOPE, PERMISSION_SCOPE_RANK } from '../enums/index.js';
import { getCached, cacheAccess } from '../utils/access-cache.js';

/**
 * One round trip, two recordsets, one scalar parameter.
 *
 * Hand-qualified throughout: `Model.select()` emits unqualified column names,
 * which would be ambiguous the moment two of these tables meet in a join. Only
 * the table names come from the models.
 *
 * The scope context deliberately does NOT filter DeletedAt - a soft-deleted
 * employee must come back so the guard can answer "deactivated" rather than
 * "unknown", which are different answers to the caller.
 */
const RESOLVE_SQL = `
WITH Denied AS (
    SELECT ep.PermissionId
      FROM ${EmployeePermission.table} AS ep
     WHERE ep.EmployeeDetailId = @employeeDetailId
       AND ep.Effect = 'DENY'
       AND ep.DeletedAt IS NULL
       AND (ep.ExpiresAt IS NULL OR ep.ExpiresAt > SYSUTCDATETIME())
),
Granted AS (
    /* 3 - the per-user GRANT override */
    SELECT ep.PermissionId AS PermissionId, ep.ScopeRank AS ScopeRank, 3 AS SourceRank
      FROM ${EmployeePermission.table} AS ep
     WHERE ep.EmployeeDetailId = @employeeDetailId
       AND ep.Effect = 'GRANT'
       AND ep.DeletedAt IS NULL
       AND (ep.ExpiresAt IS NULL OR ep.ExpiresAt > SYSUTCDATETIME())

    UNION ALL
    /* 2 - groups */
    SELECT gp.PermissionId, gp.ScopeRank, 2
      FROM ${EmployeeGroup.table}   AS eg
      JOIN ${Group.table}           AS g  ON g.GroupId  = eg.GroupId
                                         AND g.DeletedAt IS NULL AND g.IsActive = 1
      JOIN ${GroupPermission.table} AS gp ON gp.GroupId = g.GroupId
                                         AND gp.DeletedAt IS NULL
     WHERE eg.EmployeeDetailId = @employeeDetailId
       AND eg.DeletedAt IS NULL

    UNION ALL
    /* 1 - roles */
    SELECT rp.PermissionId, rp.ScopeRank, 1
      FROM ${EmployeeRole.table}   AS er
      JOIN ${Role.table}           AS r  ON r.RoleId  = er.RoleId
                                        AND r.DeletedAt IS NULL AND r.IsActive = 1
      JOIN ${RolePermission.table} AS rp ON rp.RoleId = r.RoleId
                                        AND rp.DeletedAt IS NULL
     WHERE er.EmployeeDetailId = @employeeDetailId
       AND er.DeletedAt IS NULL
)
SELECT p.PermissionCode AS permissionCode,
       MAX(g.ScopeRank) AS scopeRank,
       MAX(g.SourceRank) AS sourceRank
  FROM Granted AS g
  JOIN ${Permission.table} AS p
    ON p.PermissionId = g.PermissionId
   AND p.DeletedAt IS NULL
 WHERE NOT EXISTS (SELECT 1 FROM Denied AS d WHERE d.PermissionId = g.PermissionId)
 GROUP BY p.PermissionCode;

SELECT d.DepartmentId AS departmentId,
       d.ManagerId     AS managerId,
       d.IsActive      AS isActive,
       d.DeletedAt     AS deletedAt
  FROM ${EmployeeDetails.table} AS d
 WHERE d.EmployeeDetailId = @employeeDetailId;
`;

/** Rank back to its name, for the one place that has to go that way. */
const SCOPE_BY_RANK = Object.freeze(
  Object.fromEntries(Object.entries(PERMISSION_SCOPE_RANK).map(([scope, rank]) => [rank, scope])),
);

/**
 * @typedef {object} AccessContext
 * @property {number} employeeDetailId      dbo.tblEmployeeDetails.EmployeeDetailId
 * @property {number|null} departmentId
 * @property {number|null} managerId
 * @property {boolean} exists               false when no such employee row
 * @property {boolean} active               false when the employee is inactive or soft-deleted
 * @property {ReadonlyMap<string, string>} permissions  code -> scope
 * @property {(code: string) => boolean} has
 * @property {(code: string) => string|null} scopeOf
 */

/** Builds the frozen context the guards and services pass around. */
function buildContext(employeeDetailId, grantRows, contextRow) {
  const permissions = new Map(
    // Lowercased: the database collation is case-insensitive, a JS Map is not,
    // so 'Employees.View' would pass the unique index and never match here.
    grantRows.map((row) => [
      String(row.permissionCode).toLowerCase(),
      SCOPE_BY_RANK[row.scopeRank] ?? PERMISSION_SCOPE.OWN,
    ]),
  );

  // The subject IS an employee row now, so this is a lookup that normally
  // hits. It can still miss if a caller passes an id that was never valid.
  const exists = Boolean(contextRow);

  return Object.freeze({
    employeeDetailId,
    departmentId: contextRow?.departmentId == null ? null : Number(contextRow.departmentId),
    managerId: contextRow?.managerId == null ? null : Number(contextRow.managerId),
    exists,
    active: exists ? Boolean(contextRow.isActive) && contextRow.deletedAt === null : false,
    permissions,
    has: (code) => permissions.has(String(code).toLowerCase()),
    scopeOf: (code) => permissions.get(String(code).toLowerCase()) ?? null,
  });
}

/** Goes to the database every time. Exported for the cache and for tests. */
export async function resolveAccessUncached(employeeDetailId) {
  const [grantRows = [], contextRows = []] = await querySets(
    RESOLVE_SQL,
    EmployeeRole.params({ employeeDetailId }),
  );
  return buildContext(employeeDetailId, grantRows, contextRows[0] ?? null);
}

/**
 * The effective access of one employee, cached.
 *
 * @param {number} employeeDetailId dbo.tblEmployeeDetails.EmployeeDetailId
 * @returns {Promise<AccessContext>}
 */
export function resolveAccess(employeeDetailId) {
  const cached = getCached(employeeDetailId);
  if (cached) return cached;

  // The promise goes into the cache before it settles, so a burst of
  // concurrent requests from one person produces one query rather than one
  // each - the same reason config/db.js caches poolPromise.
  return cacheAccess(employeeDetailId, resolveAccessUncached(employeeDetailId));
}

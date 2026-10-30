/**
 * Resolving what one person may do.
 *
 * One rule, and that is the whole point of this model:
 *
 *     the employee belongs to a GROUP, the group holds RIGHTS on MODULES.
 *
 * There is no stacking, no precedence and no scope. If the answer surprises
 * you, there is exactly one row to look at - tblAccessRight for that group
 * and that module - and one screen that wrote it.
 *
 * Nothing here touches req or res. The resolved AccessContext is a frozen
 * plain object, so a controller can hand it to a service as the actor
 * argument without dragging Express into the service layer.
 */
import { querySets, query, mutate } from '../helpers/query.helper.js';
import { EmployeeDetails, GLOBAL_STAMP } from '../models/index.js';
import {
  ACTION,
  ACTION_PROP,
  ACTIONS,
  MODULE_BY_ID,
  MODULE_CATALOG,
} from '../enums/module.enum.js';
import { getCached, cacheAccess, invalidateEmployee, clear } from '../utils/access-cache.js';

/**
 * One round trip, two recordsets, one scalar parameter.
 *
 * Hand-qualified throughout: a model's select() emits unqualified column
 * names, which would be ambiguous the moment two of these tables meet.
 *
 * The employee row deliberately does NOT filter DeletedAt - a soft-deleted
 * employee must come back so the guard can answer "deactivated" rather than
 * "unknown", which are different answers to the caller.
 *
 * An inactive GROUP yields no rights at all: deactivating a group is how an
 * administrator switches off a whole category of user without unpicking who
 * is in it, so it has to mean something at resolve time rather than only on
 * the screen that lists groups.
 */
const RESOLVE_SQL = `
  SELECT  ar.ModuleId   AS moduleId,
          ar.CanView    AS canView,
          ar.CanAdd     AS canAdd,
          ar.CanEdit    AS canEdit,
          ar.CanDelete  AS canDelete,
          ar.CanPrint   AS canPrint,
          ar.CanMail    AS canMail
  FROM    dbo.tblAccessRight AS ar
  JOIN    dbo.tblModule      AS m ON m.ModuleId = ar.ModuleId AND m.IsActive = 1
  JOIN    dbo.tblGroup       AS g ON g.GroupId  = ar.GroupId
  WHERE   g.DeletedAt IS NULL
    AND   g.IsActive = 1
    AND   ar.GroupId = (
            SELECT GroupId FROM dbo.tblEmployeeDetails WHERE EmployeeDetailId = @employeeDetailId
          );

  SELECT  ed.EmployeeDetailId AS employeeDetailId,
          ed.IsActive         AS isActive,
          ed.DeletedAt        AS deletedAt,
          ed.GroupId          AS groupId,
          g.GroupName         AS groupName,
          g.IsActive          AS groupIsActive,
          g.IsSystem          AS groupIsSystem
  FROM    dbo.tblEmployeeDetails AS ed
  LEFT JOIN dbo.tblGroup AS g
         ON g.GroupId = ed.GroupId AND g.DeletedAt IS NULL
  WHERE   ed.EmployeeDetailId = @employeeDetailId;
`;

/** An all-false rights object, for a module the group has no row on. */
const NO_RIGHTS = Object.freeze(
  Object.fromEntries(ACTIONS.map((action) => [ACTION_PROP[action], false])),
);

/**
 * All-true, for the system group.
 *
 * The Administrator group's rights are NOT stored as rows. They are a
 * property of being the system group, which is the only way to make the
 * guarantee hold over time: stored rows would be a snapshot of the modules
 * that existed on the day it was seeded, so adding a module next month would
 * silently lock administrators out of it until somebody remembered to re-run
 * the seed. One group that always holds everything is also what makes it safe
 * to refuse every other kind of edit to it.
 */
const ALL_RIGHTS = Object.freeze(
  Object.fromEntries(ACTIONS.map((action) => [ACTION_PROP[action], true])),
);

/** Turns one tblAccessRight row into the shape the API and the frontend use. */
function toRights(row) {
  return Object.freeze(
    Object.fromEntries(ACTIONS.map((action) => [ACTION_PROP[action], Boolean(row[ACTION_PROP[action]])])),
  );
}

/** @typedef {{exists: boolean, active: boolean, groupId: number|null, groupName: string|null, rightsFor: Function, can: Function}} AccessContext */

function buildContext(employeeDetailId, rightRows, employeeRow) {
  const exists = employeeRow !== null;

  const isSystemGroup = exists && Boolean(employeeRow.groupIsSystem);

  // moduleId -> frozen rights object. Only modules the group actually has a
  // row on are present; everything else answers through NO_RIGHTS.
  const rights = new Map(rightRows.map((row) => [Number(row.moduleId), toRights(row)]));

  const rightsFor = (moduleId) =>
    isSystemGroup ? ALL_RIGHTS : (rights.get(Number(moduleId)) ?? NO_RIGHTS);

  return Object.freeze({
    employeeDetailId: Number(employeeDetailId),
    exists,
    // An employee switched off or soft-deleted is a leaver, whatever their
    // group still says.
    active: exists ? Boolean(employeeRow.isActive) && employeeRow.deletedAt === null : false,

    groupId: exists && employeeRow.groupId !== null ? Number(employeeRow.groupId) : null,
    groupName: exists ? (employeeRow.groupName ?? null) : null,
    isSystemGroup,

    rights,
    rightsFor,

    /** can(MODULE.EMPLOYEES, ACTION.EDIT) -> boolean */
    can: (moduleId, action) => Boolean(rightsFor(moduleId)[ACTION_PROP[action]]),

    /** True when the group holds ANY right on the module - "may see the menu entry". */
    canReach: (moduleId) =>
      isSystemGroup || ACTIONS.some((action) => rightsFor(moduleId)[ACTION_PROP[action]]),
  });
}

/** Goes to the database every time. Exported for the cache and for tests. */
export async function resolveAccessUncached(employeeDetailId) {
  const [rightRows = [], employeeRows = []] = await querySets(
    RESOLVE_SQL,
    EmployeeDetails.params({ employeeDetailId }),
  );
  return buildContext(employeeDetailId, rightRows, employeeRows[0] ?? null);
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

/* -------------------------------------------------------------------------
   Invalidation

   A rights change must take effect without waiting for a cache entry to age
   out, and without the administrator being told to ask everyone to log in
   again. Two halves: this instance drops what it holds immediately, and the
   stamp tells every OTHER instance to do the same within its poll interval.
   ------------------------------------------------------------------------- */

const BUMP_STAMP_SQL = `
  UPDATE dbo.tblAccessControlStamp
     SET Version = Version + 1, ModifiedAt = SYSUTCDATETIME()
   WHERE StampName = '${GLOBAL_STAMP}';
`;

/**
 * Bumps the global stamp.
 *
 * Takes the `run` that withTransaction() hands its callback, so the bump
 * commits with the write that caused it - a stamp that moved for a change
 * that rolled back would invalidate every cache for nothing. Called with no
 * argument it runs on its own.
 */
export async function bumpAccessStamp(run) {
  if (run) {
    await run(BUMP_STAMP_SQL);
    return;
  }
  await mutate(BUMP_STAMP_SQL);
}

/**
 * Forget what we know about one employee, or about everyone.
 *
 * Changing a GROUP's rights changes it for every member at once, and the
 * cache is keyed by employee, so there is nothing cheaper than clearing it -
 * the alternative is a reverse index from group to member that exists only
 * to avoid a handful of re-resolves.
 */
export function invalidateAccess({ employeeDetailId = null } = {}) {
  if (employeeDetailId === null) clear();
  else invalidateEmployee(employeeDetailId);
}

/* -------------------------------------------------------------------------
   What the frontend asks for
   ------------------------------------------------------------------------- */

/**
 * The menu this person may see.
 *
 * Built from the module catalog in the database rather than from the enum, so
 * an administrator who retires a module (IsActive = 0) sees it leave the menu
 * without a deploy.
 *
 * A heading is included when at least one of its children is - a parent the
 * group can "reach" but whose children it cannot is an empty dropdown, which
 * is worse than no entry at all. A heading that has no children of its own
 * (there are none today) falls back to its own rights.
 */
export async function buildMenu(access) {
  const modules = await query(`
    SELECT  ModuleId       AS moduleId,
            ModuleCode     AS moduleCode,
            ModuleName     AS moduleName,
            ParentModuleId AS parentModuleId,
            RoutePath      AS routePath,
            Icon           AS icon,
            SortOrder      AS sortOrder
    FROM    dbo.tblModule
    WHERE   IsActive = 1 AND ShowInMenu = 1
    ORDER BY SortOrder, ModuleName;
  `);

  const visible = (moduleId) => access.canReach(moduleId);

  const children = new Map();
  for (const row of modules) {
    if (row.parentModuleId === null) continue;
    if (!children.has(row.parentModuleId)) children.set(row.parentModuleId, []);
    children.get(row.parentModuleId).push(row);
  }

  const entry = (row) => ({
    moduleId: row.moduleId,
    moduleCode: row.moduleCode,
    label: row.moduleName,
    path: row.routePath,
    icon: row.icon,
    rights: access.rightsFor(row.moduleId),
  });

  const menu = [];
  for (const row of modules) {
    if (row.parentModuleId !== null) continue;

    const kids = (children.get(row.moduleId) ?? []).filter((child) => visible(child.moduleId));

    // A top-level page (routePath, no children) stands on its own rights.
    if (kids.length === 0 && (children.get(row.moduleId) ?? []).length === 0) {
      if (visible(row.moduleId)) menu.push({ ...entry(row), children: [] });
      continue;
    }
    if (kids.length > 0) {
      menu.push({ ...entry(row), children: kids.map(entry) });
    }
  }

  return menu;
}

/**
 * What this person may do on one page.
 *
 * Takes either a module id, a module code or the frontend route path, because
 * the screen asking the question knows its own URL and should not have to
 * carry a module id around to ask about itself.
 */
export async function pageRights(access, { moduleId, moduleCode, path }) {
  let row = null;

  if (moduleId !== undefined && moduleId !== null) {
    row = MODULE_BY_ID.get(Number(moduleId)) ?? null;
  } else if (moduleCode) {
    const wanted = String(moduleCode).toUpperCase();
    row = MODULE_CATALOG.find((module) => module.moduleCode === wanted) ?? null;
  } else if (path) {
    // Compared without a trailing slash and case-insensitively: a router that
    // emits "/Employees/" must not look like a different page.
    const wanted = String(path).replace(/\/+$/, '').toLowerCase() || '/';
    row =
      MODULE_CATALOG.find(
        (module) => (module.routePath ?? '').toLowerCase() === wanted,
      ) ?? null;
  }

  if (row === null) return null;

  return {
    moduleId: row.moduleId,
    moduleCode: row.moduleCode,
    moduleName: row.moduleName,
    path: row.routePath,
    rights: access.rightsFor(row.moduleId),
  };
}

export { ACTION, ACTIONS, ACTION_PROP };

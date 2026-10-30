/**
 * Groups, their rights, and who is in them.
 *
 * Three things an administrator does, and this file is all three:
 *
 *   1. create / rename / delete a group
 *   2. tick the six boxes for each module on that group   (the matrix)
 *   3. put employees into it                              (the mapping)
 *
 * The matrix is always returned WHOLE - every active module, with zeros where
 * the group has no row. The screen needs a complete grid to render, and a
 * caller should never have to merge the catalog with the grants itself to
 * find out that a module exists but is unticked. That is what
 * sp_GetSelectGroupAccessRightsByGroupId does in the .NET portal, with the
 * same LEFT JOIN, for the same reason.
 *
 * Who may call these is settled before the request arrives, by requireAccess
 * in the route file. Nothing here re-checks a right.
 */
import { query, queryOne, withTransaction } from '../helpers/query.helper.js';
import { sql } from '../config/db.js';
import {
  Group,
  AccessRight,
  EmployeeDetails,
  GROUP_PUBLIC_PROPS,
  MODULE_PUBLIC_PROPS,
  Module,
  RIGHT_PROPS,
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { MESSAGES, ERROR_CODE } from '../enums/index.js';
import { MODULE_BY_ID } from '../enums/module.enum.js';
import { bumpAccessStamp, invalidateAccess } from './access-control.service.js';

const GROUP_COLUMNS = Group.select(GROUP_PUBLIC_PROPS);
const MODULE_COLUMNS = Module.select(MODULE_PUBLIC_PROPS);

/**
 * BIGINT and INT both arrive as strings from tedious when they are wide
 * enough to need it. Ids cross a JSON boundary, so they are converted once
 * here rather than being compared as strings somewhere far away.
 */
const NUMERIC_PROPS = ['groupId', 'moduleId', 'parentModuleId', 'employeeDetailId', 'memberCount'];

function withNumericIds(row) {
  if (!row) return row;
  const copy = { ...row };
  for (const prop of NUMERIC_PROPS) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  for (const prop of RIGHT_PROPS) {
    if (copy[prop] !== undefined) copy[prop] = Boolean(copy[prop]);
  }
  return copy;
}

const allWithNumericIds = (rows) => rows.map(withNumericIds);

/** 2627 is a UNIQUE/PK constraint, 2601 a unique index. Both mean "taken". */
function uniqueViolation(error) {
  return error?.number === 2601 || error?.number === 2627;
}

/* -------------------------------------------------------------------------- */
/* Modules                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The module catalog: every module a group can hold rights on.
 *
 * Read from the table rather than from MODULE_CATALOG so that a module
 * retired in the database disappears here too, and the matrix screen and the
 * menu never disagree about what exists.
 */
export async function listModules({ includeInactive = false } = {}) {
  return allWithNumericIds(
    await query(
      `SELECT ${MODULE_COLUMNS}
         FROM ${Module.table}
        ${includeInactive ? '' : 'WHERE IsActive = 1'}
        ORDER BY SortOrder, ModuleName`,
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Groups                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Live groups, with how many employees are in each.
 *
 * The member count rides along because the list screen shows it and because
 * it is what makes the Delete button's refusal predictable - you can see
 * before clicking that a group has 12 people in it.
 */
export async function listGroups({ search = null, includeInactive = false, page = 1, pageSize = 25 } = {}) {
  const rows = await query(
    `SELECT ${GROUP_PUBLIC_PROPS.map((prop) => `g.${Group.col(prop)} AS ${prop}`).join(', ')},
            memberCount = (
              SELECT COUNT(*) FROM ${EmployeeDetails.table} AS e
               WHERE e.GroupId = g.GroupId AND e.DeletedAt IS NULL
            ),
            totalCount = COUNT(*) OVER()
       FROM ${Group.table} AS g
      WHERE g.DeletedAt IS NULL
        AND (@includeInactive = 1 OR g.IsActive = 1)
        AND (@search IS NULL OR g.GroupName LIKE '%' + @search + '%'
                             OR g.Description LIKE '%' + @search + '%')
      ORDER BY g.GroupName
      OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    {
      search: { type: sql.NVarChar(100), value: search },
      includeInactive: { type: sql.Bit, value: includeInactive },
      offset: { type: sql.Int, value: (page - 1) * pageSize },
      pageSize: { type: sql.Int, value: pageSize },
    },
  );

  // COUNT(*) OVER() is on every row and belongs on none of them.
  const total = rows.length > 0 ? Number(rows[0].totalCount) : 0;
  const groups = rows.map(({ totalCount, ...rest }) => withNumericIds(rest));

  return { groups, total };
}

/** The group row alone, or null. Used by the write paths before they write. */
async function loadGroup(groupId) {
  return withNumericIds(
    await queryOne(
      `SELECT ${GROUP_COLUMNS} FROM ${Group.table}
        WHERE GroupId = @groupId AND DeletedAt IS NULL`,
      Group.params({ groupId }),
    ),
  );
}

/**
 * One group, with the complete rights matrix.
 *
 * LEFT JOIN from the module side, so every module appears whether or not the
 * group has a row for it. A system group reads back all-true: its rights are
 * not stored, they are a property of being the system group - see
 * resolveAccess.
 */
export async function getGroup(groupId) {
  const group = await loadGroup(groupId);
  if (!group) throw ApiError.notFound(MESSAGES.GROUP_NOT_FOUND, { code: ERROR_CODE.GROUP_NOT_FOUND });

  const rights = allWithNumericIds(
    await query(
      `SELECT  m.ModuleId       AS moduleId,
               m.ModuleCode     AS moduleCode,
               m.ModuleName     AS moduleName,
               m.ParentModuleId AS parentModuleId,
               m.RoutePath      AS routePath,
               m.SortOrder      AS sortOrder,
               canView   = CASE WHEN @isSystem = 1 THEN 1 ELSE ISNULL(ar.CanView, 0)   END,
               canAdd    = CASE WHEN @isSystem = 1 THEN 1 ELSE ISNULL(ar.CanAdd, 0)    END,
               canEdit   = CASE WHEN @isSystem = 1 THEN 1 ELSE ISNULL(ar.CanEdit, 0)   END,
               canDelete = CASE WHEN @isSystem = 1 THEN 1 ELSE ISNULL(ar.CanDelete, 0) END,
               canPrint  = CASE WHEN @isSystem = 1 THEN 1 ELSE ISNULL(ar.CanPrint, 0)  END,
               canMail   = CASE WHEN @isSystem = 1 THEN 1 ELSE ISNULL(ar.CanMail, 0)   END
         FROM  ${Module.table} AS m
    LEFT JOIN  ${AccessRight.table} AS ar
           ON  ar.ModuleId = m.ModuleId AND ar.GroupId = @groupId
        WHERE  m.IsActive = 1
     ORDER BY  m.SortOrder, m.ModuleName`,
      {
        ...Group.params({ groupId }),
        isSystem: { type: sql.Bit, value: group.isSystem },
      },
    ),
  );

  const memberCount = await queryOne(
    `SELECT n = COUNT(*) FROM ${EmployeeDetails.table}
      WHERE GroupId = @groupId AND DeletedAt IS NULL`,
    Group.params({ groupId }),
  );

  return { ...group, memberCount: Number(memberCount.n), rights };
}

/**
 * Validates the rights payload against the catalog.
 *
 * An unknown module id is a 400 and not a silent skip: the frontend sending
 * module 99 has a bug, and writing nothing while answering 200 is how that
 * bug reaches production as "the checkbox doesn't save".
 */
function normaliseRights(rights) {
  if (rights === undefined || rights === null) return [];
  if (!Array.isArray(rights)) {
    throw ApiError.badRequest(MESSAGES.VALIDATION_FAILED, {
      code: ERROR_CODE.VALIDATION_FAILED,
      details: { rights: 'must be an array of { moduleId, canView, ... }' },
    });
  }

  const seen = new Set();
  return rights.map((row) => {
    const moduleId = Number(row?.moduleId);
    if (!Number.isInteger(moduleId) || !MODULE_BY_ID.has(moduleId)) {
      throw ApiError.badRequest(MESSAGES.UNKNOWN_MODULE, {
        code: ERROR_CODE.UNKNOWN_MODULE,
        moduleId: row?.moduleId ?? null,
      });
    }
    if (seen.has(moduleId)) {
      throw ApiError.badRequest(MESSAGES.DUPLICATE_MODULE_RIGHT, {
        code: ERROR_CODE.DUPLICATE_MODULE_RIGHT,
        moduleId,
      });
    }
    seen.add(moduleId);

    const normalised = { moduleId };
    for (const prop of RIGHT_PROPS) normalised[prop] = Boolean(row[prop]);
    return normalised;
  });
}

/**
 * Writes the matrix rows for one group, inside a caller's transaction.
 *
 * MERGE rather than delete-then-insert: the AccessId stays stable, so an
 * audit trail that references it keeps pointing at the same thing, and a
 * group that is saved twice does not churn every row.
 *
 * WITH (HOLDLOCK) is not decoration. Without it, two administrators saving
 * the same group at the same instant can both miss the match and both insert,
 * and the unique index turns that into a 409 for one of them - a lost save
 * reported as a conflict the user cannot act on.
 *
 * Modules absent from the payload are left exactly as they are, which is what
 * makes a partial save ("just tick Delete on Employees") possible.
 */
async function writeRights(run, groupId, rights, actorId) {
  if (rights.length === 0) return;

  const params = {
    groupId: { type: sql.Int, value: groupId },
    actorId: { type: sql.BigInt, value: actorId ?? null },
  };

  const values = rights.map((row, index) => {
    params[`m${index}`] = { type: sql.Int, value: row.moduleId };
    for (const prop of RIGHT_PROPS) {
      params[`${prop}${index}`] = { type: sql.Bit, value: row[prop] };
    }
    return `(@m${index}, ${RIGHT_PROPS.map((prop) => `@${prop}${index}`).join(', ')})`;
  });

  await run(`
    MERGE ${AccessRight.table} WITH (HOLDLOCK) AS target
    USING (VALUES ${values.join(', ')})
          AS source (ModuleId, ${RIGHT_PROPS.map((p) => p[0].toUpperCase() + p.slice(1)).join(', ')})
       ON target.GroupId = @groupId AND target.ModuleId = source.ModuleId
     WHEN MATCHED THEN UPDATE SET
          ${RIGHT_PROPS.map((p) => {
            const column = p[0].toUpperCase() + p.slice(1);
            return `target.${column} = source.${column}`;
          }).join(',\n          ')},
          target.ModifiedBy = @actorId,
          target.ModifiedAt = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT
          (GroupId, ModuleId, ${RIGHT_PROPS.map((p) => p[0].toUpperCase() + p.slice(1)).join(', ')},
           CreatedBy, ModifiedBy)
     VALUES
          (@groupId, source.ModuleId,
           ${RIGHT_PROPS.map((p) => `source.${p[0].toUpperCase() + p.slice(1)}`).join(', ')},
           @actorId, @actorId);
  `,
    params,
  );
}

/** Creates the group and its rights in one transaction. */
export async function createGroup(input, actorId) {
  const rights = normaliseRights(input.rights);

  let groupId;
  try {
    groupId = await withTransaction(async (run) => {
      const inserted = await run(
        `INSERT INTO ${Group.table} (GroupName, Description, IsActive, CreatedBy, ModifiedBy)
         OUTPUT INSERTED.GroupId AS groupId
         VALUES (@groupName, @description, @isActive, @actorId, @actorId);`,
        {
          groupName: { type: sql.NVarChar(100), value: input.groupName },
          description: { type: sql.NVarChar(255), value: input.description ?? null },
          isActive: { type: sql.Bit, value: input.isActive ?? true },
          actorId: { type: sql.BigInt, value: actorId ?? null },
        },
      );

      const newId = Number(inserted[0].groupId);
      await writeRights(run, newId, rights, actorId);
      await bumpAccessStamp(run);
      return newId;
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.GROUP_NAME_EXISTS, { code: ERROR_CODE.NAME_ALREADY_EXISTS });
    }
    throw error;
  }

  return getGroup(groupId);
}

/**
 * Renames a group and/or rewrites its rights.
 *
 * A system group is refused outright. It exists so that a mistake on this
 * screen cannot lock every administrator out of this screen; letting the
 * screen edit it would remove the guarantee it is there to provide.
 */
export async function updateGroup(groupId, input, actorId) {
  const group = await loadGroup(groupId);
  if (!group) throw ApiError.notFound(MESSAGES.GROUP_NOT_FOUND, { code: ERROR_CODE.GROUP_NOT_FOUND });
  if (group.isSystem) {
    throw ApiError.conflict(MESSAGES.GROUP_IS_SYSTEM, { code: ERROR_CODE.GROUP_IS_SYSTEM });
  }

  const rights = normaliseRights(input.rights);

  try {
    await withTransaction(async (run) => {
      await run(
        `UPDATE ${Group.table}
            SET GroupName   = COALESCE(@groupName, GroupName),
                Description = COALESCE(@description, Description),
                IsActive    = COALESCE(@isActive, IsActive),
                ModifiedBy  = @actorId,
                ModifiedAt  = SYSUTCDATETIME()
          WHERE GroupId = @groupId AND DeletedAt IS NULL;`,
        {
          groupId: { type: sql.Int, value: groupId },
          groupName: { type: sql.NVarChar(100), value: input.groupName ?? null },
          description: { type: sql.NVarChar(255), value: input.description ?? null },
          isActive: { type: sql.Bit, value: input.isActive ?? null },
          actorId: { type: sql.BigInt, value: actorId ?? null },
        },
      );

      await writeRights(run, groupId, rights, actorId);
      await bumpAccessStamp(run);
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      throw ApiError.conflict(MESSAGES.GROUP_NAME_EXISTS, { code: ERROR_CODE.NAME_ALREADY_EXISTS });
    }
    throw error;
  }

  // Every member's resolved access just changed.
  invalidateAccess();
  return getGroup(groupId);
}

/** Rewrites only the matrix. The mapping screen's save button. */
export async function setGroupRights(groupId, rights, actorId) {
  return updateGroup(groupId, { rights }, actorId);
}

/**
 * Soft-deletes an empty group.
 *
 * Refused while anybody is in it, exactly as the .NET portal refuses
 * ("Users Exist in this Group"). Deleting a group out from under its members
 * would leave them with a GroupId pointing at nothing, which resolves to no
 * access at all - a silent lockout rather than a decision somebody made.
 */
export async function deleteGroup(groupId, actorId) {
  const group = await loadGroup(groupId);
  if (!group) throw ApiError.notFound(MESSAGES.GROUP_NOT_FOUND, { code: ERROR_CODE.GROUP_NOT_FOUND });
  if (group.isSystem) {
    throw ApiError.conflict(MESSAGES.GROUP_IS_SYSTEM, { code: ERROR_CODE.GROUP_IS_SYSTEM });
  }

  const members = await queryOne(
    `SELECT n = COUNT(*) FROM ${EmployeeDetails.table}
      WHERE GroupId = @groupId AND DeletedAt IS NULL`,
    Group.params({ groupId }),
  );
  if (Number(members.n) > 0) {
    throw ApiError.conflict(MESSAGES.GROUP_HAS_MEMBERS, {
      code: ERROR_CODE.GROUP_HAS_MEMBERS,
      memberCount: Number(members.n),
    });
  }

  await withTransaction(async (run) => {
    await run(
      `UPDATE ${Group.table}
          SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE GroupId = @groupId AND DeletedAt IS NULL;`,
      {
        groupId: { type: sql.Int, value: groupId },
        actorId: { type: sql.BigInt, value: actorId ?? null },
      },
    );
    await bumpAccessStamp(run);
  });

  invalidateAccess();
  return { groupId: Number(groupId), deleted: true };
}

/* -------------------------------------------------------------------------- */
/* Mapping: who is in the group                                               */
/* -------------------------------------------------------------------------- */

/** The employees in one group. */
export async function listGroupMembers(groupId, { page = 1, pageSize = 25 } = {}) {
  const group = await loadGroup(groupId);
  if (!group) throw ApiError.notFound(MESSAGES.GROUP_NOT_FOUND, { code: ERROR_CODE.GROUP_NOT_FOUND });

  const rows = await query(
    `SELECT  e.EmployeeDetailId AS employeeDetailId,
             e.EmployeeCode     AS employeeCode,
             e.FirstName        AS firstName,
             e.LastName         AS lastName,
             e.WorkEmail        AS workEmail,
             e.IsActive         AS isActive,
             totalCount = COUNT(*) OVER()
       FROM  ${EmployeeDetails.table} AS e
      WHERE  e.GroupId = @groupId AND e.DeletedAt IS NULL
   ORDER BY  e.FirstName, e.LastName
     OFFSET  @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    {
      ...Group.params({ groupId }),
      offset: { type: sql.Int, value: (page - 1) * pageSize },
      pageSize: { type: sql.Int, value: pageSize },
    },
  );

  const total = rows.length > 0 ? Number(rows[0].totalCount) : 0;
  const members = rows.map(({ totalCount, ...rest }) => ({
    ...rest,
    employeeDetailId: Number(rest.employeeDetailId),
    isActive: Boolean(rest.isActive),
  }));

  return { group, members, total };
}

/**
 * Puts one employee into a group, or takes them out of every group.
 *
 * `groupId: null` is the removal, and it is deliberately the same endpoint:
 * "which group is this person in" has exactly one answer, so setting it is
 * one operation rather than an add and a remove that can disagree.
 */
export async function assignEmployeeGroup(employeeDetailId, groupId, actorId) {
  if (groupId !== null) {
    const group = await loadGroup(groupId);
    if (!group) {
      throw ApiError.notFound(MESSAGES.GROUP_NOT_FOUND, { code: ERROR_CODE.GROUP_NOT_FOUND });
    }
    if (!group.isActive) {
      throw ApiError.conflict(MESSAGES.GROUP_INACTIVE, { code: ERROR_CODE.GROUP_INACTIVE });
    }
  }

  const updated = await queryOne(
    `UPDATE ${EmployeeDetails.table}
        SET GroupId = @groupId, ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
      OUTPUT INSERTED.EmployeeDetailId AS employeeDetailId, INSERTED.GroupId AS groupId
      WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL`,
    {
      employeeDetailId: { type: sql.BigInt, value: employeeDetailId },
      groupId: { type: sql.Int, value: groupId },
      actorId: { type: sql.BigInt, value: actorId ?? null },
    },
  );

  if (!updated) {
    throw ApiError.notFound(MESSAGES.EMPLOYEE_NOT_FOUND, { code: ERROR_CODE.EMPLOYEE_NOT_FOUND });
  }

  // This one person's access changed; everybody else's is untouched.
  invalidateAccess({ employeeDetailId });
  return withNumericIds(updated);
}

/**
 * Puts several employees into one group in a single transaction.
 *
 * All or nothing. Assigning 40 people and having it stop at 23 leaves an
 * administrator with no way to know which 23 without checking each one.
 */
export async function assignEmployeesToGroup(groupId, employeeDetailIds, actorId) {
  const group = await loadGroup(groupId);
  if (!group) throw ApiError.notFound(MESSAGES.GROUP_NOT_FOUND, { code: ERROR_CODE.GROUP_NOT_FOUND });
  if (!group.isActive) {
    throw ApiError.conflict(MESSAGES.GROUP_INACTIVE, { code: ERROR_CODE.GROUP_INACTIVE });
  }

  const ids = [...new Set(employeeDetailIds.map(Number))];

  const assigned = await withTransaction(async (run) => {
    const params = {
      groupId: { type: sql.Int, value: groupId },
      actorId: { type: sql.BigInt, value: actorId ?? null },
    };
    ids.forEach((id, index) => {
      params[`e${index}`] = { type: sql.BigInt, value: id };
    });

    const rows = await run(
      `UPDATE ${EmployeeDetails.table}
          SET GroupId = @groupId, ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        OUTPUT INSERTED.EmployeeDetailId AS employeeDetailId
        WHERE DeletedAt IS NULL
          AND EmployeeDetailId IN (${ids.map((_, index) => `@e${index}`).join(', ')});`,
      params,
    );
    await bumpAccessStamp(run);
    return rows.map((row) => Number(row.employeeDetailId));
  });

  // Reported rather than thrown: an id that is already gone is worth knowing
  // about, but it is not a reason to refuse the other 39.
  const missing = ids.filter((id) => !assigned.includes(id));

  invalidateAccess();
  return { groupId: Number(groupId), assigned, missing };
}

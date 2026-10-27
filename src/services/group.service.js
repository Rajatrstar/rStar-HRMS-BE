/**
 * Groups: a bundle of permissions several people share - "Finance team sees
 * payroll reports" is one group and one grant, not ten individual overrides.
 *
 * Groups carry permissions, never roles (see 004_access_control.sql), and they
 * only ever ADD access. Taking something away from one person is a per-user
 * DENY override, not a group.
 *
 * Membership is guarded like a role assignment: putting somebody in a group,
 * or taking them out, is a decision about everything the group grants, so the
 * actor must hold all of it at least as widely. Otherwise "may manage group
 * members" would let an admin hand out any permission a group happens to hold.
 */
import { query, queryOne, sql } from '../helpers/query.helper.js';
import {
  Group,
  EmployeeGroup,
  GroupPermission,
  EmployeeDetails,
  GROUP_PUBLIC_PROPS,
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { MESSAGES, ERROR_CODE } from '../enums/index.js';
import {
  withAccessWrite,
  withNumericIds,
  isUniqueViolation,
  containsPattern,
  paging,
  loadLiveCatalog,
  toGrantSet,
  loadGrantSet,
  diffGrantSets,
  applyGrantDiff,
  assertActorCovers,
  grantSetToList,
  missingEmployeeIds,
  GRANT_TARGET,
} from './access-write.service.js';

const ID_PROPS = ['groupId'];

/** Live members only: a soft-deleted employee is not a member of anything. */
const MEMBER_COUNT = `
  (SELECT COUNT(*) FROM ${EmployeeGroup.table} AS eg
     JOIN ${EmployeeDetails.table} AS d ON d.EmployeeDetailId = eg.EmployeeDetailId
                                       AND d.DeletedAt IS NULL
    WHERE eg.GroupId = g.GroupId AND eg.DeletedAt IS NULL)`;

const SUMMARY_COLUMNS = `
  ${GROUP_PUBLIC_PROPS.map((prop) => `g.${Group.col(prop)} AS ${prop}`).join(', ')},
  (SELECT COUNT(*) FROM ${GroupPermission.table} AS gp
    WHERE gp.GroupId = g.GroupId AND gp.DeletedAt IS NULL) AS permissionCount,
  ${MEMBER_COUNT} AS memberCount`;

function groupConflict(error) {
  if (!isUniqueViolation(error)) return error;
  if (/GroupCode/i.test(error.message)) {
    return ApiError.conflict(MESSAGES.CODE_ALREADY_EXISTS, { code: ERROR_CODE.CODE_ALREADY_EXISTS });
  }
  return ApiError.conflict(MESSAGES.GROUP_NAME_EXISTS, { code: ERROR_CODE.NAME_ALREADY_EXISTS });
}

/** The group row, locked for the rest of the transaction when `run` is one. */
async function findGroup(groupId, run) {
  const statement = `
    SELECT ${Group.select(['groupId', 'groupCode', 'groupName', 'isActive', 'modifiedAt'])}
      FROM ${Group.table} ${run ? 'WITH (UPDLOCK, HOLDLOCK)' : ''}
     WHERE GroupId = @groupId AND DeletedAt IS NULL`;
  const params = Group.params({ groupId });
  const rows = run ? await run(statement, params) : await query(statement, params);

  if (rows.length === 0) {
    throw ApiError.notFound(MESSAGES.GROUP_NOT_FOUND);
  }
  return withNumericIds(rows[0], ID_PROPS);
}

/**
 * Refuses unless the actor holds everything the group grants. Used by every
 * membership change, in both directions.
 */
async function assertActorCoversGroup(actor, groupId, run) {
  const grants = await loadGrantSet(GRANT_TARGET.GROUP, groupId, run);
  assertActorCovers(actor, grants.values());
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function listGroups({ page, pageSize, search }) {
  const { params, ...meta } = paging({ page, pageSize });
  const filter = search ? 'AND (g.GroupCode LIKE @search OR g.GroupName LIKE @search)' : '';
  const searchParam = search ? { search: Group.param('groupName', containsPattern(search)) } : {};

  const [rows, total] = await Promise.all([
    query(
      `SELECT ${SUMMARY_COLUMNS}
         FROM ${Group.table} AS g
        WHERE g.DeletedAt IS NULL ${filter}
        ORDER BY g.GroupName
        OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
      { ...params, ...searchParam },
    ),
    queryOne(
      `SELECT COUNT(*) AS total FROM ${Group.table} AS g WHERE g.DeletedAt IS NULL ${filter}`,
      searchParam,
    ),
  ]);

  return {
    data: rows.map((row) => withNumericIds(row, ID_PROPS)),
    meta: { ...meta, total: total?.total ?? 0 },
  };
}

export async function getGroup(groupId) {
  const row = await queryOne(
    `SELECT ${SUMMARY_COLUMNS} FROM ${Group.table} AS g
      WHERE g.GroupId = @groupId AND g.DeletedAt IS NULL`,
    Group.params({ groupId }),
  );
  if (!row) throw ApiError.notFound(MESSAGES.GROUP_NOT_FOUND);
  return withNumericIds(row, ID_PROPS);
}

export async function getGroupPermissions(groupId) {
  const group = await findGroup(groupId);
  const grants = await loadGrantSet(GRANT_TARGET.GROUP, groupId);

  return {
    groupId: group.groupId,
    groupCode: group.groupCode,
    modifiedAt: group.modifiedAt,
    permissions: grantSetToList(grants),
  };
}

/** Live members of a live group, optionally filtered by code, name or email. */
export async function listMembers(groupId, { search }) {
  await findGroup(groupId);

  const filter = search
    ? `AND (d.EmployeeCode LIKE @search OR d.FirstName LIKE @search
            OR d.LastName LIKE @search OR d.WorkEmail LIKE @search)`
    : '';

  const rows = await query(
    `SELECT d.EmployeeDetailId AS employeeDetailId,
            d.EmployeeCode     AS employeeCode,
            d.FirstName        AS firstName,
            d.LastName         AS lastName,
            d.WorkEmail        AS workEmail,
            d.IsActive         AS isActive,
            eg.CreatedAt       AS addedAt
       FROM ${EmployeeGroup.table} AS eg
       JOIN ${EmployeeDetails.table} AS d ON d.EmployeeDetailId = eg.EmployeeDetailId
                                         AND d.DeletedAt IS NULL
      WHERE eg.GroupId = @groupId AND eg.DeletedAt IS NULL ${filter}
      ORDER BY d.FirstName, d.LastName`,
    {
      ...EmployeeGroup.params({ groupId }),
      ...(search ? { search: EmployeeDetails.param('workEmail', containsPattern(search)) } : {}),
    },
  );

  return rows.map((row) => withNumericIds(row, ['employeeDetailId']));
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export async function createGroup(actor, input) {
  try {
    const row = await withAccessWrite(actor, async (run) => {
      const rows = await run(
        `INSERT INTO ${Group.table} (GroupCode, GroupName, Description, CreatedBy, ModifiedBy)
         OUTPUT inserted.GroupId AS groupId
         VALUES (@groupCode, @groupName, @description, @actorId, @actorId)`,
        {
          ...Group.params({
            groupCode: input.groupCode,
            groupName: input.groupName,
            description: input.description ?? null,
          }),
          actorId: Group.param('createdBy', actor.employeeDetailId),
        },
      );
      return rows[0];
    });

    return getGroup(Number(row.groupId));
  } catch (error) {
    throw groupConflict(error);
  }
}

/** Partial update. The code is immutable once created. */
export async function updateGroup(actor, groupId, input) {
  try {
    await withAccessWrite(actor, async (run) => {
      await findGroup(groupId, run);

      await run(
        `UPDATE ${Group.table}
            SET GroupName   = COALESCE(@groupName, GroupName),
                Description = CASE WHEN @setDescription = 1 THEN @description ELSE Description END,
                IsActive    = COALESCE(@isActive, IsActive),
                ModifiedBy  = @actorId,
                ModifiedAt  = SYSUTCDATETIME()
          WHERE GroupId = @groupId`,
        {
          ...Group.params({
            groupId,
            groupName: input.groupName ?? null,
            description: input.description ?? null,
            isActive: input.isActive ?? null,
          }),
          setDescription: { type: sql.Bit, value: 'description' in input },
          actorId: Group.param('modifiedBy', actor.employeeDetailId),
        },
      );
    });
  } catch (error) {
    throw groupConflict(error);
  }

  return getGroup(groupId);
}

/** Soft delete, refused while the group still has members. */
export async function deleteGroup(actor, groupId) {
  return withAccessWrite(actor, async (run) => {
    const group = await findGroup(groupId, run);

    const [members] = await run(
      `SELECT COUNT(*) AS memberCount
         FROM ${EmployeeGroup.table} AS eg
         JOIN ${EmployeeDetails.table} AS d ON d.EmployeeDetailId = eg.EmployeeDetailId
                                           AND d.DeletedAt IS NULL
        WHERE eg.GroupId = @groupId AND eg.DeletedAt IS NULL`,
      EmployeeGroup.params({ groupId }),
    );

    if (members.memberCount > 0) {
      throw ApiError.conflict(MESSAGES.GROUP_IN_USE, {
        code: ERROR_CODE.GROUP_IN_USE,
        memberCount: members.memberCount,
      });
    }

    const actorId = { type: sql.BigInt, value: actor.employeeDetailId };

    await run(
      `UPDATE ${GroupPermission.table}
          SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE GroupId = @groupId AND DeletedAt IS NULL`,
      { ...GroupPermission.params({ groupId }), actorId },
    );

    await run(
      `UPDATE ${Group.table}
          SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE GroupId = @groupId`,
      { ...Group.params({ groupId }), actorId },
    );

    return { groupId: group.groupId, groupCode: group.groupCode, groupName: group.groupName };
  });
}

/** Full replace with optimistic concurrency - the same contract as a role's. */
export async function replaceGroupPermissions(actor, groupId, { permissions, expectedModifiedAt }) {
  const changes = await withAccessWrite(actor, async (run) => {
    const group = await findGroup(groupId, run);

    if (
      expectedModifiedAt &&
      new Date(group.modifiedAt).getTime() !== expectedModifiedAt.getTime()
    ) {
      throw ApiError.conflict(MESSAGES.MODIFIED_ELSEWHERE, {
        code: ERROR_CODE.MODIFIED_ELSEWHERE,
        currentModifiedAt: group.modifiedAt,
      });
    }

    const catalog = await loadLiveCatalog(run);
    const wanted = toGrantSet(permissions, catalog);
    const current = await loadGrantSet(GRANT_TARGET.GROUP, groupId, run);
    const diff = diffGrantSets(current, wanted);

    assertActorCovers(actor, diff.touched);

    const counts = await applyGrantDiff(run, GRANT_TARGET.GROUP, groupId, diff, actor.employeeDetailId);

    await run(
      `UPDATE ${Group.table}
          SET ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE GroupId = @groupId`,
      {
        ...Group.params({ groupId }),
        actorId: Group.param('modifiedBy', actor.employeeDetailId),
      },
    );

    return counts;
  });

  return { ...(await getGroupPermissions(groupId)), changes };
}

/**
 * Adds employees to a group. Idempotent: somebody already in it is reported,
 * not rejected, so a picker that re-sends its whole selection still works.
 */
export async function addMembers(actor, groupId, employeeIds) {
  return withAccessWrite(actor, async (run) => {
    await findGroup(groupId, run);
    await assertActorCoversGroup(actor, groupId, run);

    const missing = await missingEmployeeIds(employeeIds, run);
    if (missing.length > 0) {
      throw ApiError.unprocessable(MESSAGES.UNKNOWN_EMPLOYEE_IDS, {
        code: ERROR_CODE.UNKNOWN_EMPLOYEE_IDS,
        employeeIds: missing,
      });
    }

    const added = await run(
      `INSERT INTO ${EmployeeGroup.table} (EmployeeDetailId, GroupId, CreatedBy, ModifiedBy)
       OUTPUT inserted.EmployeeDetailId AS employeeDetailId
       SELECT CAST(s.value AS BIGINT), @groupId, @actorId, @actorId
         FROM STRING_SPLIT(@ids, ',') AS s
        WHERE NOT EXISTS (
                SELECT 1 FROM ${EmployeeGroup.table} AS eg
                 WHERE eg.GroupId = @groupId
                   AND eg.EmployeeDetailId = CAST(s.value AS BIGINT)
                   AND eg.DeletedAt IS NULL
              )`,
      {
        ...EmployeeGroup.params({ groupId }),
        ids: { type: sql.NVarChar(sql.MAX), value: employeeIds.join(',') },
        actorId: EmployeeGroup.param('createdBy', actor.employeeDetailId),
      },
    );

    const addedIds = added.map((row) => Number(row.employeeDetailId));
    return {
      groupId,
      added: addedIds,
      alreadyMembers: employeeIds.filter((id) => !addedIds.includes(id)),
    };
  });
}

export async function removeMember(actor, groupId, employeeDetailId) {
  return withAccessWrite(actor, async (run) => {
    await findGroup(groupId, run);
    await assertActorCoversGroup(actor, groupId, run);

    const rows = await run(
      `UPDATE ${EmployeeGroup.table}
          SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
       OUTPUT deleted.EmployeeDetailId AS employeeDetailId
        WHERE GroupId = @groupId
          AND EmployeeDetailId = @employeeDetailId
          AND DeletedAt IS NULL`,
      {
        ...EmployeeGroup.params({ groupId, employeeDetailId }),
        actorId: EmployeeGroup.param('modifiedBy', actor.employeeDetailId),
      },
    );

    if (rows.length === 0) {
      throw ApiError.notFound(MESSAGES.GROUP_MEMBER_NOT_FOUND);
    }

    return { groupId, employeeDetailId };
  });
}

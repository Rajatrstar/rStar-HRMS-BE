/**
 * Roles: the RBAC layer. Every employee holds one or more, and each role
 * carries a set of permissions at a scope.
 *
 * Three rules beyond plain CRUD:
 *
 *   - The five master roles (IsSystem = 1) cannot be renamed, deactivated or
 *     deleted. Their PERMISSIONS can be edited - that is the feature - with
 *     one exception: SUPER_ADMIN, which scripts/seed-permissions.js re-syncs
 *     to the full catalog on every run. An edit to it would be silently undone
 *     by the next deploy, so it is refused now rather than lost later.
 *   - A role still held by somebody cannot be deleted. Strip it from people
 *     first; deleting it out from under them would change their access as a
 *     side effect of tidying a list.
 *   - Permission saves are a full replace with optimistic concurrency: the
 *     client sends the role's modifiedAt from when it loaded the grid, and a
 *     save against a role somebody else has changed since answers 409.
 *
 * Every write goes through withAccessWrite, which adds the escalation-safe
 * self-lockout check, the stamp bump and the cache clear.
 */
import { query, queryOne, sql } from '../helpers/query.helper.js';
import { Role, EmployeeRole, RolePermission, EmployeeDetails, ROLE_PUBLIC_PROPS } from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { MESSAGES, ERROR_CODE, ROLE } from '../enums/index.js';
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
  GRANT_TARGET,
} from './access-write.service.js';

const ID_PROPS = ['roleId'];

/**
 * The summary row: the public columns, plus how many live permissions the role
 * carries and how many live employees hold it. Correlated subqueries rather
 * than GROUP BY joins, so a role with neither still comes back with zeros.
 */
const SUMMARY_COLUMNS = `
  ${ROLE_PUBLIC_PROPS.map((prop) => `r.${Role.col(prop)} AS ${prop}`).join(', ')},
  (SELECT COUNT(*) FROM ${RolePermission.table} AS rp
    WHERE rp.RoleId = r.RoleId AND rp.DeletedAt IS NULL) AS permissionCount,
  (SELECT COUNT(*) FROM ${EmployeeRole.table} AS er
     JOIN ${EmployeeDetails.table} AS d ON d.EmployeeDetailId = er.EmployeeDetailId
                                       AND d.DeletedAt IS NULL
    WHERE er.RoleId = r.RoleId AND er.DeletedAt IS NULL) AS userCount`;

/** Turns a 2601/2627 on tblRole into the right 409, by index name. */
function roleConflict(error) {
  if (!isUniqueViolation(error)) return error;
  if (/RoleCode/i.test(error.message)) {
    return ApiError.conflict(MESSAGES.CODE_ALREADY_EXISTS, { code: ERROR_CODE.CODE_ALREADY_EXISTS });
  }
  return ApiError.conflict(MESSAGES.ROLE_NAME_EXISTS, { code: ERROR_CODE.NAME_ALREADY_EXISTS });
}

/** The role row, locked for the rest of the transaction when `run` is one. */
async function findRole(roleId, run) {
  const statement = `
    SELECT ${Role.select(['roleId', 'roleCode', 'roleName', 'isSystem', 'isActive', 'modifiedAt'])}
      FROM ${Role.table} ${run ? 'WITH (UPDLOCK, HOLDLOCK)' : ''}
     WHERE RoleId = @roleId AND DeletedAt IS NULL`;
  const params = Role.params({ roleId });
  const rows = run ? await run(statement, params) : await query(statement, params);

  if (rows.length === 0) {
    throw ApiError.notFound(MESSAGES.ROLE_NOT_FOUND);
  }
  return withNumericIds(rows[0], ID_PROPS);
}

function assertNotSystem(role) {
  if (role.isSystem) {
    throw ApiError.forbidden(MESSAGES.ROLE_IS_PROTECTED, {
      code: ERROR_CODE.ROLE_IS_PROTECTED,
      roleCode: role.roleCode,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** Paginated, searchable on code and name. System roles first. */
export async function listRoles({ page, pageSize, search }) {
  const { params, ...meta } = paging({ page, pageSize });
  const filter = search ? 'AND (r.RoleCode LIKE @search OR r.RoleName LIKE @search)' : '';
  const searchParam = search ? { search: Role.param('roleName', containsPattern(search)) } : {};

  const [rows, total] = await Promise.all([
    query(
      `SELECT ${SUMMARY_COLUMNS}
         FROM ${Role.table} AS r
        WHERE r.DeletedAt IS NULL ${filter}
        ORDER BY r.IsSystem DESC, r.RoleName
        OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
      { ...params, ...searchParam },
    ),
    queryOne(
      `SELECT COUNT(*) AS total FROM ${Role.table} AS r WHERE r.DeletedAt IS NULL ${filter}`,
      searchParam,
    ),
  ]);

  return {
    data: rows.map((row) => withNumericIds(row, ID_PROPS)),
    meta: { ...meta, total: total?.total ?? 0 },
  };
}

export async function getRole(roleId) {
  const row = await queryOne(
    `SELECT ${SUMMARY_COLUMNS} FROM ${Role.table} AS r
      WHERE r.RoleId = @roleId AND r.DeletedAt IS NULL`,
    Role.params({ roleId }),
  );
  if (!row) throw ApiError.notFound(MESSAGES.ROLE_NOT_FOUND);
  return withNumericIds(row, ID_PROPS);
}

/** The role's live permissions, with the role's modifiedAt for the next save. */
export async function getRolePermissions(roleId) {
  const role = await findRole(roleId);
  const grants = await loadGrantSet(GRANT_TARGET.ROLE, roleId);

  return {
    roleId: role.roleId,
    roleCode: role.roleCode,
    modifiedAt: role.modifiedAt,
    permissions: grantSetToList(grants),
  };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/** A new role is never a system role, and starts with no permissions. */
export async function createRole(actor, input) {
  try {
    const row = await withAccessWrite(actor, async (run) => {
      const rows = await run(
        `INSERT INTO ${Role.table} (RoleCode, RoleName, Description, IsSystem, CreatedBy, ModifiedBy)
         OUTPUT inserted.RoleId AS roleId
         VALUES (@roleCode, @roleName, @description, 0, @actorId, @actorId)`,
        {
          ...Role.params({
            roleCode: input.roleCode,
            roleName: input.roleName,
            description: input.description ?? null,
          }),
          actorId: Role.param('createdBy', actor.employeeDetailId),
        },
      );
      return rows[0];
    });

    return getRole(Number(row.roleId));
  } catch (error) {
    throw roleConflict(error);
  }
}

/**
 * Partial update: only the fields present change. The code is immutable once
 * created - imports and payroll files key on it.
 *
 * Deactivating a role switches off every grant it carries for every holder at
 * once, so it goes through the same self-lockout check as any other write.
 */
export async function updateRole(actor, roleId, input) {
  try {
    await withAccessWrite(actor, async (run) => {
      const role = await findRole(roleId, run);
      assertNotSystem(role);

      await run(
        `UPDATE ${Role.table}
            SET RoleName    = COALESCE(@roleName, RoleName),
                Description = CASE WHEN @setDescription = 1 THEN @description ELSE Description END,
                IsActive    = COALESCE(@isActive, IsActive),
                ModifiedBy  = @actorId,
                ModifiedAt  = SYSUTCDATETIME()
          WHERE RoleId = @roleId`,
        {
          ...Role.params({
            roleId,
            roleName: input.roleName ?? null,
            description: input.description ?? null,
            isActive: input.isActive ?? null,
          }),
          // Present-but-null clears the description; absent leaves it alone.
          // COALESCE cannot tell those apart, so the flag says which it is.
          setDescription: { type: sql.Bit, value: 'description' in input },
          actorId: Role.param('modifiedBy', actor.employeeDetailId),
        },
      );
    });
  } catch (error) {
    throw roleConflict(error);
  }

  return getRole(roleId);
}

/** Soft delete, refused for system roles and for roles anybody still holds. */
export async function deleteRole(actor, roleId) {
  return withAccessWrite(actor, async (run) => {
    const role = await findRole(roleId, run);
    assertNotSystem(role);

    const [holders] = await run(
      `SELECT COUNT(*) AS userCount
         FROM ${EmployeeRole.table} AS er
         JOIN ${EmployeeDetails.table} AS d ON d.EmployeeDetailId = er.EmployeeDetailId
                                           AND d.DeletedAt IS NULL
        WHERE er.RoleId = @roleId AND er.DeletedAt IS NULL`,
      EmployeeRole.params({ roleId }),
    );

    if (holders.userCount > 0) {
      throw ApiError.conflict(MESSAGES.ROLE_IN_USE, {
        code: ERROR_CODE.ROLE_IN_USE,
        userCount: holders.userCount,
      });
    }

    // The grants go with the role. Kept as rows, like everything here, so
    // "what did Finance Lead carry before it was deleted" stays answerable.
    await run(
      `UPDATE ${RolePermission.table}
          SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE RoleId = @roleId AND DeletedAt IS NULL`,
      {
        ...RolePermission.params({ roleId }),
        actorId: RolePermission.param('modifiedBy', actor.employeeDetailId),
      },
    );

    await run(
      `UPDATE ${Role.table}
          SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE RoleId = @roleId`,
      {
        ...Role.params({ roleId }),
        actorId: Role.param('modifiedBy', actor.employeeDetailId),
      },
    );

    return { roleId: role.roleId, roleCode: role.roleCode, roleName: role.roleName };
  });
}

/**
 * Makes the role's permissions exactly `permissions`.
 *
 * The actor must cover every permission whose reach this save changes - added,
 * removed or rescoped - which is what stops HR Admin (who holds
 * roles.assign-permission only if someone grants it) from writing
 * payroll.configure into a role they hold.
 */
export async function replaceRolePermissions(actor, roleId, { permissions, expectedModifiedAt }) {
  const result = await withAccessWrite(actor, async (run) => {
    const role = await findRole(roleId, run);

    if (role.roleCode === ROLE.SUPER_ADMIN) {
      throw ApiError.forbidden(MESSAGES.ROLE_IS_PROTECTED, {
        code: ERROR_CODE.ROLE_IS_PROTECTED,
        roleCode: role.roleCode,
        reason: 'Super Admin always holds every permission; the seed re-syncs it',
      });
    }

    if (
      expectedModifiedAt &&
      new Date(role.modifiedAt).getTime() !== expectedModifiedAt.getTime()
    ) {
      throw ApiError.conflict(MESSAGES.MODIFIED_ELSEWHERE, {
        code: ERROR_CODE.MODIFIED_ELSEWHERE,
        currentModifiedAt: role.modifiedAt,
      });
    }

    const catalog = await loadLiveCatalog(run);
    const wanted = toGrantSet(permissions, catalog);
    const current = await loadGrantSet(GRANT_TARGET.ROLE, roleId, run);
    const diff = diffGrantSets(current, wanted);

    assertActorCovers(actor, diff.touched);

    const counts = await applyGrantDiff(run, GRANT_TARGET.ROLE, roleId, diff, actor.employeeDetailId);

    // Moves modifiedAt even though no column on the role itself changed: the
    // permission set IS the role as far as the matrix screen is concerned, and
    // this is the value the next save's expectedModifiedAt is compared to.
    await run(
      `UPDATE ${Role.table}
          SET ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE RoleId = @roleId`,
      {
        ...Role.params({ roleId }),
        actorId: Role.param('modifiedBy', actor.employeeDetailId),
      },
    );

    return counts;
  });

  return { ...(await getRolePermissions(roleId)), changes: result };
}

/**
 * Turning a scope into a WHERE clause.
 *
 * The resolver answers "you hold employees.view at TEAM". It does not know
 * what TEAM means for an employee list versus a leave register, so every
 * module gets one clause builder here and none of them is ever inlined into a
 * service - otherwise "OWN" quietly means four different things within six
 * months.
 *
 * THE TRAP, stated once so it is never rediscovered the hard way:
 * dbo.tblEmployeeDetails.ManagerId references EmployeeDetailId (BIGINT), NOT
 * EmployeeLogin.EmployeeId (INT). A TEAM clause written against the wrong one
 * compiles, runs, returns rows, and returns the WRONG PEOPLE. The two
 * parameter names below differ on purpose - @scopeDetailId and
 * @scopeEmployeeId - so a mix-up fails loudly instead of silently.
 *
 * Every parameter is prefixed `scope` so a caller's own @employeeId can never
 * collide with one of these.
 */
import { ApiError } from '../utils/api-error.js';
import { EmployeeDetails } from '../models/index.js';
import { PERMISSION_SCOPE, MESSAGES, ERROR_CODE } from '../enums/index.js';

/**
 * A scope that needs a profile, on a login that has none, is unresolvable.
 *
 * It throws rather than returning a clause that matches nothing. An empty list
 * looks exactly like "there are no employees" and gets debugged as a data
 * problem for an hour; a 403 naming the cause does not.
 */
function requireContext(value, access, code, field) {
  if (value !== null && value !== undefined) return value;

  throw ApiError.forbidden(MESSAGES.SCOPE_UNRESOLVED, {
    code: ERROR_CODE.SCOPE_UNRESOLVED,
    requiredPermission: code,
    reason: `The employee profile for this login has no ${field}`,
  });
}

/**
 * Restricts a read of dbo.tblEmployeeDetails to the rows `access` may see.
 *
 *   const { clause, params } = employeeScopeClause('d', access, PERMISSION.EMPLOYEES_VIEW);
 *   await query(
 *     `SELECT ... FROM ${EmployeeDetails.table} AS d
 *       WHERE d.DeletedAt IS NULL AND ${clause}`,
 *     { ...params },
 *   );
 *
 * @param {string} alias the table alias used in the caller's SQL
 * @param {import('../services/access-control.service.js').AccessContext} access
 * @param {string} code the permission whose scope governs this read
 * @returns {{ clause: string, params: Record<string, { type: unknown, value: unknown }> }}
 */
export function employeeScopeClause(alias, access, code) {
  switch (access.scopeOf(code)) {
    case PERMISSION_SCOPE.ALL:
      // Literal rather than an omitted clause, so callers can always
      // interpolate without worrying whether to add the AND.
      return { clause: '1 = 1', params: {} };

    case PERMISSION_SCOPE.DEPARTMENT:
      return {
        clause: `${alias}.DepartmentId = @scopeDepartmentId`,
        params: {
          scopeDepartmentId: EmployeeDetails.param(
            'departmentId',
            requireContext(access.departmentId, access, code, 'department'),
          ),
        },
      };

    case PERMISSION_SCOPE.TEAM:
      // Direct reports plus the manager's own record. One level deep on
      // purpose: a recursive walk up ManagerId is how "Manager" quietly
      // becomes "sees the whole org chart", and that is a separate decision.
      return {
        clause: `(${alias}.ManagerId = @scopeDetailId OR ${alias}.EmployeeDetailId = @scopeDetailId)`,
        params: {
          scopeDetailId: EmployeeDetails.param(
            'employeeDetailId',
            requireContext(access.employeeDetailId, access, code, 'profile record'),
          ),
        },
      };

    case PERMISSION_SCOPE.OWN:
    default:
      // Keyed on the login id, which always exists - so OWN is the one scope
      // that works for a login with no profile yet.
      return {
        clause: `${alias}.EmployeeId = @scopeEmployeeId`,
        params: { scopeEmployeeId: EmployeeDetails.param('employeeId', access.employeeId) },
      };
  }
}

/**
 * Whether `access` may reach one specific employee row at `code`'s scope.
 *
 * Used by write paths, which need the answer before they touch anything. Read
 * paths do not need it: their scope clause is already in the WHERE, so a row
 * outside scope simply is not in the result set.
 *
 * @param {object} row an employee row carrying employeeDetailId, managerId, departmentId
 */
export function canReachEmployee(access, code, row) {
  switch (access.scopeOf(code)) {
    case PERMISSION_SCOPE.ALL:
      return true;
    case PERMISSION_SCOPE.DEPARTMENT:
      return access.departmentId !== null && Number(row.departmentId) === access.departmentId;
    case PERMISSION_SCOPE.TEAM:
      return (
        access.employeeDetailId !== null &&
        (Number(row.managerId) === access.employeeDetailId ||
          Number(row.employeeDetailId) === access.employeeDetailId)
      );
    case PERMISSION_SCOPE.OWN:
      return Number(row.employeeId) === access.employeeId;
    default:
      return false;
  }
}

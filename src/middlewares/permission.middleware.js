/**
 * The authorisation guard.
 *
 *   router.get(ROUTES.EMPLOYEES.LIST,
 *     authenticate,
 *     requirePermission(PERMISSION.EMPLOYEES_VIEW),
 *     employeeController.list);
 *
 * It runs after `authenticate`, which it depends on for
 * `req.employee.employeeId`, and before the controller. It answers only "may
 * this person do this at all" - which ROWS they may touch is the service's
 * job, through src/helpers/access-scope.helper.js and the scope this guard
 * attaches.
 *
 * Built as a factory for the same reason buildLimiter is in
 * rate-limit.middleware.js: the shared behaviour - resolve, check, attach,
 * log, deny in the standard envelope - lives once, and the exported wrappers
 * read as declarations.
 */
import { resolveAccess } from '../services/access-control.service.js';
import { ApiError } from '../utils/api-error.js';
import { logger } from '../utils/logger.js';
import { MESSAGES, ERROR_CODE, PERMISSION_SCOPE_RANK } from '../enums/index.js';

/** The widest of several scopes, or null when the list is empty. */
function widestScope(scopes) {
  let best = null;
  for (const scope of scopes) {
    if (scope && (best === null || PERMISSION_SCOPE_RANK[scope] > PERMISSION_SCOPE_RANK[best])) {
      best = scope;
    }
  }
  return best;
}

/**
 * @param {object} config
 * @param {string} config.name   what to call this guard in a log line
 * @param {string[]} config.codes from PERMISSION, never a literal
 * @param {'any'|'all'} config.mode
 */
function buildPermissionGuard({ name, codes, mode }) {
  // Lowercased once, at wiring time rather than per request: the database
  // collation is case-insensitive but the resolver's Map is not.
  const wanted = codes.map((code) => String(code).toLowerCase());

  const guard = async (req, res, next) => {
    const access = await resolveAccess(req.employee.employeeDetailId);

    // An employee who has been switched off or soft-deleted is a leaver. This
    // is the only revocation that beats the access token's lifetime, so it is
    // checked before permissions rather than after. `exists` is false only
    // when the token names an employee the table has never had.
    if (!access.exists || !access.active) {
      throw ApiError.forbidden(MESSAGES.ACCOUNT_INACTIVE, {
        code: ERROR_CODE.ACCOUNT_INACTIVE,
      });
    }

    const held = wanted.filter((code) => access.has(code));
    // An empty list means "any signed-in employee". Spelt out rather than
    // left to fall out of the mode check, where `held.length > 0` would deny
    // everyone and the guard that is supposed to let people through would be
    // the one that locks them out.
    const satisfied =
      wanted.length === 0 ? true : mode === 'all' ? held.length === wanted.length : held.length > 0;

    if (!satisfied) {
      // Logged, because a role that is missing a permission looks to the user
      // like a broken button and would otherwise leave no trace anywhere.
      logger.warn(
        `[permission:${name}] denied ${req.method} ${req.originalUrl} ` +
          `for employee ${access.employeeDetailId}`,
      );
      // `requiredPermission` is not a secret - it names a capability, not
      // data, and it is exactly what a user quotes in a help-desk ticket and
      // what a frontend developer needs to find the missing guard.
      throw ApiError.forbidden(MESSAGES.PERMISSION_DENIED, {
        code: ERROR_CODE.PERMISSION_DENIED,
        requiredPermission: codes.length === 1 ? codes[0] : codes,
        mode,
      });
    }

    req.access = Object.freeze({
      ...access,
      matchedCodes: Object.freeze(held),
      // The widest scope among the codes that actually matched. For a single
      // required permission that is simply its scope.
      scope: widestScope(held.map((code) => access.scopeOf(code))),
    });

    next();
  };

  // Read by the boot-time route audit in src/index.js, which refuses to start
  // the server if any route under the API prefix has no guard. That is what
  // makes "every new module is covered" an assertion rather than a hope.
  guard.isPermissionGuard = true;
  guard.requiredPermissions = Object.freeze([...codes]);

  return guard;
}

/** Passes when the caller holds this permission. */
export function requirePermission(code) {
  return buildPermissionGuard({ name: code, codes: [code], mode: 'all' });
}

/** Passes when the caller holds ANY of them. `req.access.scope` is the widest matched. */
export function requireAnyPermission(codes) {
  return buildPermissionGuard({ name: `any(${codes.join('|')})`, codes, mode: 'any' });
}

/** Passes only when the caller holds EVERY one. */
export function requireAllPermissions(codes) {
  return buildPermissionGuard({ name: `all(${codes.join('+')})`, codes, mode: 'all' });
}

/**
 * For a route that any signed-in employee may call, such as
 * GET /access/my-permissions.
 *
 * It resolves and attaches `req.access` exactly as the others do, and still
 * rejects a deactivated profile - it just requires no particular permission.
 * Using this rather than omitting a guard is what keeps the route audit honest:
 * "open to everyone" becomes a decision written in the route file instead of
 * an omission nobody notices.
 */
export function requireAuthenticatedAccess() {
  return buildPermissionGuard({ name: 'authenticated', codes: [], mode: 'any' });
}

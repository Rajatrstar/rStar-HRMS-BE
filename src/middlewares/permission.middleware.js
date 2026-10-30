/**
 * The authorisation guard.
 *
 *   router.get(ROUTES.EMPLOYEES.LIST,
 *     authenticate,
 *     requireAccess(MODULE.EMPLOYEES, ACTION.VIEW),
 *     employeeController.list);
 *
 * It runs after `authenticate`, which it depends on for
 * `req.employee.employeeDetailId`, and before the controller.
 *
 * THIS IS THE ENFORCEMENT POINT, and it is the reason hiding a button is not
 * security. A frontend that never renders the Delete button is a courtesy to
 * the user; this is what stops the DELETE request that was typed into curl,
 * replayed from the network tab, or sent by a page that was open before the
 * administrator took the right away. Every route under the API prefix carries
 * one, and src/index.js refuses to boot if one is missing.
 */
import { resolveAccess } from '../services/access-control.service.js';
import { ApiError } from '../utils/api-error.js';
import { logger } from '../utils/logger.js';
import { MESSAGES, ERROR_CODE } from '../enums/index.js';
import { ACTION, ACTION_PROP, moduleName } from '../enums/module.enum.js';

/**
 * @param {object} config
 * @param {number|null} config.moduleId from MODULE, never a literal
 * @param {string|null} config.action   from ACTION
 */
function buildGuard({ moduleId, action }) {
  const label = moduleId === null ? 'authenticated' : `${moduleName(moduleId)}:${action}`;

  const guard = async (req, res, next) => {
    const access = await resolveAccess(req.employee.employeeDetailId);

    // An employee who has been switched off or soft-deleted is a leaver. This
    // is the only revocation that beats the access token's lifetime, so it is
    // checked before rights rather than after. `exists` is false only when the
    // token names an employee the table has never had.
    if (!access.exists || !access.active) {
      throw ApiError.forbidden(MESSAGES.ACCOUNT_INACTIVE, {
        code: ERROR_CODE.ACCOUNT_INACTIVE,
      });
    }

    // A null moduleId means "any signed-in employee" - /access/me and the
    // menu, which every user needs before they can be shown anything at all.
    if (moduleId !== null && !access.can(moduleId, action)) {
      // An employee with no group reaches here for every guarded route. Said
      // separately because it is a different fix: assign them a group, rather
      // than hunting for a missing checkbox on a group they are not in.
      const reason = access.groupId === null ? 'no group assigned' : `group ${access.groupName}`;

      // Logged, because a group missing a right looks to the user like a
      // broken button and would otherwise leave no trace anywhere.
      logger.warn(
        `[access:${label}] denied ${req.method} ${req.originalUrl} ` +
          `for employee ${access.employeeDetailId} (${reason})`,
      );

      // The module and action are not secret - they name a capability, not
      // data, and they are exactly what a user quotes in a help-desk ticket
      // and what the administrator needs to find the right checkbox.
      throw ApiError.forbidden(MESSAGES.PERMISSION_DENIED, {
        code:
          access.groupId === null ? ERROR_CODE.NO_GROUP_ASSIGNED : ERROR_CODE.PERMISSION_DENIED,
        requiredAccess: { module: moduleName(moduleId), action },
      });
    }

    req.access = access;
    next();
  };

  // Read by the boot-time route audit in src/index.js, which refuses to start
  // the server if any route under the API prefix has no guard. That is what
  // makes "every new module is covered" an assertion rather than a hope.
  guard.isPermissionGuard = true;
  guard.requiredAccess = Object.freeze({ moduleId, action });

  return guard;
}

/**
 * The guard. One module, one action.
 *
 *   requireAccess(MODULE.EMPLOYEES, ACTION.DELETE)
 */
export function requireAccess(moduleId, action) {
  if (!Object.values(ACTION).includes(action)) {
    // Thrown at wiring time, not request time: a typo here would otherwise
    // read every right as false and deny everybody, which looks exactly like
    // a permissions problem and would be debugged as one.
    throw new Error(`Unknown action "${action}". Use one of ACTION.*.`);
  }
  if (!Number.isInteger(moduleId)) {
    throw new Error(`Module must be a MODULE.* id, received ${JSON.stringify(moduleId)}.`);
  }
  return buildGuard({ moduleId, action });
}

/** Shorthand for the four common ones, so route files read as declarations. */
export const requireView = (moduleId) => requireAccess(moduleId, ACTION.VIEW);
export const requireAdd = (moduleId) => requireAccess(moduleId, ACTION.ADD);
export const requireEdit = (moduleId) => requireAccess(moduleId, ACTION.EDIT);
export const requireDelete = (moduleId) => requireAccess(moduleId, ACTION.DELETE);

/**
 * For a route any signed-in employee may call: /access/me, /access/menu.
 *
 * It resolves and attaches `req.access` exactly as the others do, and still
 * rejects a deactivated profile - it just requires no particular right. Using
 * this rather than omitting a guard is what keeps the route audit honest:
 * "open to everyone" becomes a decision written in the route file instead of
 * an omission nobody notices.
 */
export function requireAuthenticatedAccess() {
  return buildGuard({ moduleId: null, action: null });
}

export { ACTION, ACTION_PROP };

/**
 * Walks the mounted router at boot and refuses to start if any endpoint
 * under the API prefix is missing its guard.
 *
 * WHY THIS EXISTS. The access model is only as good as its weakest route,
 * and the way it gets weak is not malice - it is a new endpoint added in a
 * hurry, copied from the one above it, with the middleware argument dropped.
 * Nothing fails. The tests pass, because the author is an administrator.
 * It ships, and the endpoint is open to every signed-in user until somebody
 * notices.
 *
 * A review cannot catch that reliably; a process that will not start can.
 * The cost is a few milliseconds once, at boot.
 *
 * Two kinds of route are legitimately unguarded, and both must say so out
 * loud rather than being inferred:
 *   - PUBLIC_ROUTES below: health checks and the login endpoints, which by
 *     definition run before anyone is signed in.
 *   - requireAuthenticatedAccess(): "any signed-in employee", which IS a
 *     guard - it still rejects a deactivated account - and is what /access/me
 *     and /access/menu use.
 */
import { API_PREFIX, ROUTE_GROUP, ROUTES } from '../enums/index.js';
import { logger } from './logger.js';

/**
 * Endpoints that are reachable without a token, by design.
 *
 * Spelt out as full paths rather than prefixes: `/auth` as a prefix would
 * have quietly covered /auth/logout and every future endpoint added to that
 * router, which is exactly the accident this file exists to catch.
 */
const PUBLIC_ROUTES = Object.freeze([
  `${ROUTE_GROUP.HEALTH}${ROUTES.HEALTH.LIVENESS}`,
  `${ROUTE_GROUP.HEALTH}${ROUTES.HEALTH.READINESS}`,
  `${ROUTE_GROUP.AUTH}${ROUTES.AUTH.LOGIN}`,
  `${ROUTE_GROUP.AUTH}${ROUTES.AUTH.VERIFY_OTP}`,
  `${ROUTE_GROUP.AUTH}${ROUTES.AUTH.RESEND_OTP}`,
  `${ROUTE_GROUP.AUTH}${ROUTES.AUTH.REFRESH}`,
  `${ROUTE_GROUP.AUTH}${ROUTES.AUTH.FORGOT_PASSWORD}`,
  `${ROUTE_GROUP.AUTH}${ROUTES.AUTH.RESET_PASSWORD}`,
]);

/**
 * Authenticated, but deliberately holding no module right.
 *
 * Both are about the token rather than about data. /auth/me is who you are;
 * /auth/logout must keep working for somebody whose account was deactivated
 * while they were signed in - refusing it would leave a live session that
 * its owner cannot end, which is the opposite of what deactivation is for.
 * They still require a valid token: the audit checks for it below.
 */
const AUTHENTICATED_ONLY_ROUTES = Object.freeze([
  `${ROUTE_GROUP.AUTH}${ROUTES.AUTH.ME}`,
  `${ROUTE_GROUP.AUTH}${ROUTES.AUTH.LOGOUT}`,
]);

/**
 * Where a sub-router is mounted.
 *
 * Express 5 does not store the mount path on the layer - it keeps a matcher
 * function and fills `layer.path` in only while a request is being routed.
 * So the path is recovered by ASKING the matcher: handed a candidate it
 * recognises, it answers with the prefix it matched.
 *
 * The candidates are the mount points this application declares, which is
 * also what makes an unrecognised router an error rather than a silent empty
 * prefix - see below.
 */
function mountPath(layer, candidates) {
  for (const candidate of candidates) {
    const match = layer.matchers?.[0]?.(candidate);
    if (match && typeof match.path === 'string') return match.path;
  }
  // Express 4 kept it as a plain string.
  if (typeof layer.path === 'string') return layer.path;
  return null;
}

/** Every endpoint the router will answer, as { method, path, handlers }. */
function collect(stack, prefix, candidates) {
  const found = [];

  for (const layer of stack) {
    if (layer.route) {
      const path = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}` || '/';
      for (const method of Object.keys(layer.route.methods)) {
        found.push({
          method: method.toUpperCase(),
          path,
          handlers: layer.route.stack.map((entry) => entry.handle),
        });
      }
      continue;
    }

    if (layer.handle?.stack) {
      const mount = mountPath(layer, candidates);
      if (mount === null) {
        // A router mounted somewhere this file does not know about. Its
        // routes would be collected under the wrong prefix, fail the
        // startsWith(API_PREFIX) test, and be skipped - an unguarded
        // endpoint that the audit reports as fine. Refuse instead.
        throw new Error(
          'Route audit found a router at an unrecognised mount point. Add its path to ' +
            'ROUTE_GROUP in src/enums/api-routes.enum.js so the audit can see inside it.',
        );
      }
      // One level down from the API prefix are the route groups; below that
      // this application does not nest, and an unexpected router there hits
      // the branch above rather than being walked blind.
      found.push(...collect(layer.handle.stack, `${prefix}${mount}`, GROUP_PATHS));
    }
  }

  return found;
}

const GROUP_PATHS = Object.freeze(Object.values(ROUTE_GROUP));

/**
 * @param {import('express').Express} app
 * @returns {{ total: number, guarded: number, public: number }}
 * @throws when an endpoint under the API prefix has no guard
 */
export function auditRoutes(app) {
  const stack = app.router?.stack ?? app._router?.stack ?? [];
  const routes = collect(stack, '', [API_PREFIX]);

  const api = routes.filter((route) => route.path.startsWith(API_PREFIX));

  /*
    A floor, because the failure this file exists to prevent has a quiet
    cousin: an audit that walks the router wrongly, finds nothing, and
    announces that all zero routes are guarded. That is exactly what happened
    the first time this was written against Express 5, which moved the mount
    path off the layer. Any real build has dozens of endpoints, so "none"
    means the walker is broken, not that the application is empty.
  */
  if (api.length === 0) {
    throw new Error(
      'Route audit found no API routes at all. The router walk is broken - ' +
        'it cannot vouch for anything, so the server will not start.',
    );
  }
  const unguarded = [];
  let guarded = 0;
  let open = 0;

  /*
    A group's root endpoint is "/health" once mounted, while the enums spell
    it as ROUTE_GROUP.HEALTH + ROUTES.HEALTH.LIVENESS = "/health/". Compared
    raw, the two never match and a public route is reported as unguarded.
    Both sides lose the trailing slash so the comparison is about the route.
  */
  const normalise = (path) => path.replace(/\/+$/, '') || '/';
  const publicRoutes = PUBLIC_ROUTES.map(normalise);
  const authOnlyRoutes = AUTHENTICATED_ONLY_ROUTES.map(normalise);

  for (const route of api) {
    const relative = normalise(route.path.slice(API_PREFIX.length) || '/');

    if (publicRoutes.includes(relative)) {
      open += 1;
      continue;
    }
    if (route.handlers.some((handler) => handler?.isPermissionGuard)) {
      guarded += 1;
      continue;
    }
    // Listed as token-only - but it still has to carry the token check. An
    // entry on that list is permission to skip the module right, not
    // permission to be open.
    if (
      authOnlyRoutes.includes(relative) &&
      route.handlers.some((handler) => handler?.isAuthGuard)
    ) {
      guarded += 1;
      continue;
    }
    unguarded.push(`${route.method} ${route.path}`);
  }

  if (unguarded.length > 0) {
    throw new Error(
      `${unguarded.length} API route(s) have no access guard:\n` +
        unguarded.map((route) => `  - ${route}`).join('\n') +
        '\n\nAdd requireAccess(MODULE.X, ACTION.Y) in the route file, or ' +
        'requireAuthenticatedAccess() if every signed-in employee may call it. ' +
        'If it is genuinely public, add it to PUBLIC_ROUTES in src/utils/route-audit.js ' +
        'so the decision is written down.',
    );
  }

  logger.debug(`Route audit: ${guarded} guarded, ${open} public, ${api.length} total`);
  return { total: api.length, guarded, public: open };
}

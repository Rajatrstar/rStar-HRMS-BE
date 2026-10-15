/**
 * The single authority on every path this API exposes.
 *
 * Nothing outside this file writes a route string. `app.js` mounts API_PREFIX,
 * `routes/index.js` mounts each ROUTE_GROUP, and each route file reads its own
 * endpoints out of ROUTES. Renaming an endpoint is a one-line change here.
 */

/** Mounted once, in app.js. Bump to /api/v2 when the contract breaks. */
export const API_PREFIX = '/api/v1';

/** Where each module's router mounts under the prefix. One entry per module. */
export const ROUTE_GROUP = Object.freeze({
  HEALTH: '/health',
  AUTH: '/auth',
  // EMPLOYEES: '/employees',
});

/**
 * Endpoints within a group, relative to that group's mount point.
 * ROUTES.HEALTH.READINESS resolves to /api/v1/health/ready.
 */
export const ROUTES = Object.freeze({
  HEALTH: Object.freeze({
    LIVENESS: '/',
    READINESS: '/ready',
  }),
  AUTH: Object.freeze({
    LOGIN: '/login',
    VERIFY_OTP: '/verify-otp',
    RESEND_OTP: '/resend-otp',
    REFRESH: '/refresh',
    ME: '/me',
  }),
  // EMPLOYEES: Object.freeze({
  //   LIST: '/',
  //   CREATE: '/',
  //   DETAIL: '/:id',
  //   UPDATE: '/:id',
  //   DELETE: '/:id',
  // }),
});

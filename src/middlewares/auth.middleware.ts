import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Role } from '../enums.js';
import { isRole } from '../enums.js';
import { ApiError } from '../utils/api-error.js';
import { verifyAccessToken } from '../utils/jwt.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * Verifies the access token and populates `req.user`.
 *
 * Deliberately stateless - no database round trip per request. The cost is that a
 * deactivated user keeps access until their short-lived access token expires; their
 * refresh tokens are revoked immediately, so the window is bounded by JWT_ACCESS_TTL.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header?.startsWith(BEARER_PREFIX)) {
    next(ApiError.unauthorized('Missing or malformed Authorization header'));
    return;
  }

  const payload = verifyAccessToken(header.slice(BEARER_PREFIX.length).trim());

  if (!isRole(payload.role)) {
    next(ApiError.unauthorized('Token carries an unknown role'));
    return;
  }

  req.user = { id: payload.sub, role: payload.role };
  next();
}

/**
 * Role gate. Always mount after `authenticate`; a missing `req.user` here means the route
 * was wired up wrong, so it fails closed rather than silently allowing the request through.
 *
 *   router.post('/', authenticate, authorize(Role.HR_ADMIN), handler)
 */
export function authorize(...allowedRoles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(ApiError.unauthorized());
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      next(ApiError.forbidden());
      return;
    }

    next();
  };
}

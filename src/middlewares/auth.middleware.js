/**
 * Protects a route with a bearer access token.
 *
 *   router.get(ROUTES.AUTH.ME, authenticate, authController.me);
 *
 * On success it attaches `req.employee`, which carries `employeeDetailId` -
 * the person the token speaks for - and `sessionId`, the login the token
 * belongs to. The login's own id is not in the token and is not needed:
 * nothing downstream keys on it.
 *
 * Two checks, not one. The signature says the token is genuine and unexpired;
 * the revocation lookup says the session behind it has not been logged out.
 * Without the second, "log out" would only clear the client's copy and every
 * token already issued would keep working until it expired on its own.
 */
import { verifyToken, TOKEN_TYPE } from '../utils/jwt.js';
import { isSessionRevoked } from '../services/session.service.js';
import { ApiError } from '../utils/api-error.js';
import { MESSAGES } from '../enums/index.js';

export async function authenticate(req, res, next) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw ApiError.unauthorized(MESSAGES.TOKEN_MISSING);
  }

  // Throws a 401 ApiError if the token is forged, expired, or a refresh token.
  const claims = verifyToken(token, TOKEN_TYPE.ACCESS);

  // Deliberately the same error as a forged or expired token. A caller
  // learning that a token was specifically REVOKED learns that the account
  // exists and that somebody logged it out, and can do nothing useful with
  // either fact.
  if (await isSessionRevoked(claims.sessionId)) {
    throw ApiError.unauthorized(MESSAGES.TOKEN_INVALID);
  }

  req.employee = claims;

  next();
}

// Read by the boot-time route audit in src/utils/route-audit.js. A handful of
// endpoints - /auth/me, /auth/logout - are authenticated but carry no module
// right, and the audit has to be able to tell that apart from a route where
// the guard was simply forgotten.
authenticate.isAuthGuard = true;

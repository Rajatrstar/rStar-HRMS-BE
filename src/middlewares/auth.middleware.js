/**
 * Protects a route with a bearer access token.
 *
 *   router.get(ROUTES.AUTH.ME, authenticate, authController.me);
 *
 * On success it attaches `req.employee`; otherwise it throws a 401 that the
 * central error handler turns into the standard response envelope.
 */
import { verifyToken, TOKEN_TYPE } from '../utils/jwt.js';
import { ApiError } from '../utils/api-error.js';
import { MESSAGES } from '../enums/index.js';

export function authenticate(req, res, next) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw ApiError.unauthorized(MESSAGES.TOKEN_MISSING);
  }

  // Throws a 401 ApiError if the token is forged, expired, or a refresh token.
  req.employee = verifyToken(token, TOKEN_TYPE.ACCESS);

  next();
}

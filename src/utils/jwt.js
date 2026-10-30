/**
 * Access and refresh token signing.
 *
 * The two token kinds are signed with different secrets AND carry a `type`
 * claim that is checked on verify. Either one alone would stop a refresh token
 * being replayed as an access token; together they also survive someone
 * accidentally configuring both secrets to the same value.
 *
 * Both also carry `sid`, the session id they SHARE. It is what makes logout
 * possible at all: a signed token cannot be unsigned, so revocation has to
 * name something the server can look up, and naming the pair rather than
 * either token means one row kills both. See db/migrations/006_revoked_session.sql.
 */
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError } from './api-error.js';
import { MESSAGES } from '../enums/index.js';

export const TOKEN_TYPE = Object.freeze({ ACCESS: 'access', REFRESH: 'refresh' });

/**
 * `sub` is the EMPLOYEE, not the credential.
 *
 * dbo.EmployeeLogin.EmployeeId identifies a password row and nothing else;
 * every permission, grant and audit column in this schema keys on
 * EmployeeDetailId. Carrying that in the token is what lets the resolver and
 * the row-scope clauses work in one id space with no lookup to translate.
 *
 * `sessionId` is passed in by /auth/refresh so a refreshed pair stays in the
 * SAME session. Minting a new one there would leave the refresh token that
 * was just exchanged outside any later revocation, and a logout would then
 * fail to kill a token the client still holds. Login omits it and gets a new
 * session, which is the only place a session should ever begin.
 *
 * @param {{ employeeDetailId: number, email: string, sessionId?: string }} employee
 * @returns {{ accessToken: string, refreshToken: string, tokenType: 'Bearer', expiresIn: string, sessionId: string }}
 */
export function issueTokens({ employeeDetailId, email, sessionId = randomUUID() }) {
  const accessToken = jwt.sign(
    { sub: String(employeeDetailId), email, sid: sessionId, type: TOKEN_TYPE.ACCESS },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN },
  );

  const refreshToken = jwt.sign(
    { sub: String(employeeDetailId), sid: sessionId, type: TOKEN_TYPE.REFRESH },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN },
  );

  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
    // Not for the client - callers need it to revoke the pair.
    sessionId,
  };
}

/**
 * Verifies a token of the given type. Throws a 401 ApiError on any problem —
 * bad signature, expiry, a token of the wrong kind, or one with no `sid`.
 *
 * A missing `sid` is treated as invalid rather than waved through. Such a
 * token predates logout existing and so could never be revoked; accepting it
 * would mean a token that logout cannot touch, which is exactly the hole this
 * was built to close. The cost is that tokens issued before this deploy stop
 * working - one re-login, once.
 *
 * Revocation itself is NOT checked here. This module does no I/O; the lookup
 * lives in src/middlewares/auth.middleware.js and src/services/auth.service.js.
 *
 * @returns {{ employeeDetailId: number, email?: string, sessionId: string }}
 */
export function verifyToken(token, type) {
  const secret = type === TOKEN_TYPE.ACCESS ? env.JWT_ACCESS_SECRET : env.JWT_REFRESH_SECRET;

  let payload;
  try {
    payload = jwt.verify(token, secret);
  } catch {
    // The underlying reason (expired vs forged) is not echoed to the caller.
    throw ApiError.unauthorized(MESSAGES.TOKEN_INVALID);
  }

  if (payload.type !== type || !payload.sid) {
    throw ApiError.unauthorized(MESSAGES.TOKEN_INVALID);
  }

  return { employeeDetailId: Number(payload.sub), email: payload.email, sessionId: payload.sid };
}

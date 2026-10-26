/**
 * Access and refresh token signing.
 *
 * The two token kinds are signed with different secrets AND carry a `type`
 * claim that is checked on verify. Either one alone would stop a refresh token
 * being replayed as an access token; together they also survive someone
 * accidentally configuring both secrets to the same value.
 */
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
 * @param {{ employeeDetailId: number, email: string }} employee
 * @returns {{ accessToken: string, refreshToken: string, tokenType: 'Bearer', expiresIn: string }}
 */
export function issueTokens({ employeeDetailId, email }) {
  const accessToken = jwt.sign({ sub: String(employeeDetailId), email, type: TOKEN_TYPE.ACCESS }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  });

  const refreshToken = jwt.sign({ sub: String(employeeDetailId), type: TOKEN_TYPE.REFRESH }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  });

  return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: env.JWT_ACCESS_EXPIRES_IN };
}

/**
 * Verifies a token of the given type. Throws a 401 ApiError on any problem —
 * bad signature, expiry, or a token of the wrong kind.
 * @returns {{ employeeDetailId: number, email?: string }}
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

  if (payload.type !== type) {
    throw ApiError.unauthorized(MESSAGES.TOKEN_INVALID);
  }

  return { employeeDetailId: Number(payload.sub), email: payload.email };
}

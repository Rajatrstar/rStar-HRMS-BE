import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { TokenType } from '../enums.js';
import type { Role } from '../enums.js';
import { ApiError } from './api-error.js';

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  type: typeof TokenType.ACCESS;
}

export interface RefreshTokenPayload {
  sub: string;
  /** Token id; matches `refresh_tokens.id` so a single session can be revoked. */
  jti: string;
  type: typeof TokenType.REFRESH;
}

export interface IssuedRefreshToken {
  token: string;
  tokenId: string;
  expiresAt: Date;
}

const baseOptions = { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE } as const;

export function signAccessToken(userId: string, role: Role): string {
  const payload: AccessTokenPayload = { sub: userId, role, type: TokenType.ACCESS };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    ...baseOptions,
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function signRefreshToken(userId: string): IssuedRefreshToken {
  const tokenId = randomUUID();
  const payload: RefreshTokenPayload = { sub: userId, jti: tokenId, type: TokenType.REFRESH };
  const token = jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    ...baseOptions,
    expiresIn: env.JWT_REFRESH_TTL as jwt.SignOptions['expiresIn'],
  });

  const { exp } = jwt.decode(token) as { exp: number };
  return { token, tokenId, expiresAt: new Date(exp * 1000) };
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = verify(token, env.JWT_ACCESS_SECRET);
  if (payload.type !== TokenType.ACCESS) {
    throw ApiError.unauthorized('Invalid token type');
  }
  return payload as unknown as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = verify(token, env.JWT_REFRESH_SECRET);
  if (payload.type !== TokenType.REFRESH) {
    throw ApiError.unauthorized('Invalid token type');
  }
  return payload as unknown as RefreshTokenPayload;
}

/**
 * Refresh tokens are stored as digests, so a dump of `refresh_tokens` yields nothing
 * replayable. SHA-256 (not argon2) is deliberate: the input is already 256 bits of
 * unguessable entropy, and lookups happen on every refresh.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function verify(token: string, secret: string): jwt.JwtPayload {
  try {
    const payload = jwt.verify(token, secret, baseOptions);
    if (typeof payload === 'string') {
      throw ApiError.unauthorized('Malformed token');
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof jwt.TokenExpiredError) {
      throw ApiError.unauthorized('Token has expired');
    }
    throw ApiError.unauthorized('Invalid token');
  }
}

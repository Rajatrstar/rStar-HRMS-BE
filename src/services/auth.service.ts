import { prisma } from '../config/db.js';
import { env } from '../config/env.js';
import { getLogger } from '../config/logger.js';
import { AuditAction } from '../enums.js';
import type { Role } from '../enums.js';
import { ApiError } from '../utils/api-error.js';
import { hashToken, signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { recordAudit } from './audit.service.js';
import type { LoginInput } from '../validations/auth.validation.js';

/**
 * Everything about proving who someone is and keeping their session alive: login, logout,
 * profile, and the refresh-token lifecycle.
 */

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface ClientFingerprint {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export interface AuthenticatedProfile {
  id: string;
  email: string;
  role: Role;
  lastLoginAt: Date | null;
  employee: {
    id: string;
    employeeCode: string;
    firstName: string;
    lastName: string;
    department: string;
    designation: string;
  } | null;
}

/**
 * Burned when the email is unknown, so a request for a non-existent account costs the same
 * as one for a real account. Without it, response timing is a user-enumeration oracle.
 */
const DUMMY_HASH = await hashPassword('invalid-password-placeholder');

const INVALID_CREDENTIALS = 'Invalid email or password';

/* --- Login / logout / profile --------------------------------------------- */

export async function login(
  { email, password }: LoginInput,
  client: ClientFingerprint,
): Promise<TokenPair> {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    await verifyPassword(DUMMY_HASH, password);
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }

  if (!user.isActive) {
    throw ApiError.unauthorized('Account is deactivated');
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    // Telling a locked-out user why they are locked out is deliberate: it is the difference
    // between a support ticket and a user retrying until the lock extends indefinitely.
    throw ApiError.unauthorized(
      'Account is temporarily locked after too many failed login attempts',
    );
  }

  if (!(await verifyPassword(user.passwordHash, password))) {
    await registerFailedAttempt(user.id, user.failedLoginAttempts, client);
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  await recordAudit({
    action: AuditAction.LOGIN_SUCCESS,
    entity: 'User',
    entityId: user.id,
    actorId: user.id,
    ipAddress: client.ipAddress,
  });

  return issueTokenPair(user.id, user.role as Role, client);
}

export async function logout(refreshToken: string, actorId: string | undefined): Promise<void> {
  await revokeSession(refreshToken);
  await recordAudit({ action: AuditAction.LOGOUT, entity: 'User', entityId: actorId, actorId });
}

export async function getProfile(userId: string): Promise<AuthenticatedProfile> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      lastLoginAt: true,
      employee: {
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          department: true,
          designation: true,
        },
      },
    },
  });

  if (!user) {
    throw ApiError.notFound('User not found');
  }

  return { ...user, role: user.role as Role };
}

async function registerFailedAttempt(
  userId: string,
  currentAttempts: number,
  client: ClientFingerprint,
): Promise<void> {
  const attempts = currentAttempts + 1;
  const shouldLock = attempts >= env.MAX_FAILED_LOGINS;

  await prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginAttempts: attempts,
      lockedUntil: shouldLock ? new Date(Date.now() + env.ACCOUNT_LOCK_MINUTES * 60_000) : null,
    },
  });

  if (shouldLock) {
    // Whoever is guessing may already hold a valid session from an earlier compromise.
    await revokeAllSessions(userId);
  }

  await recordAudit({
    action: shouldLock ? AuditAction.ACCOUNT_LOCKED : AuditAction.LOGIN_FAILED,
    entity: 'User',
    entityId: userId,
    actorId: userId,
    ipAddress: client.ipAddress,
    metadata: { attempts },
  });
}

/* --- Refresh token lifecycle ---------------------------------------------- */

/** Issues a fresh pair and persists the refresh token digest as a revocable session. */
export async function issueTokenPair(
  userId: string,
  role: Role,
  client: ClientFingerprint,
): Promise<TokenPair> {
  const refresh = signRefreshToken(userId);

  await prisma.refreshToken.create({
    data: {
      id: refresh.tokenId,
      userId,
      tokenHash: hashToken(refresh.token),
      expiresAt: refresh.expiresAt,
      userAgent: client.userAgent?.slice(0, 255) ?? null,
      ipAddress: client.ipAddress ?? null,
    },
  });

  return { accessToken: signAccessToken(userId, role), refreshToken: refresh.token };
}

/**
 * Exchanges a refresh token for a new pair, revoking the one presented.
 *
 * A token that is valid but already revoked means it was captured and replayed: the whole
 * session chain for that user is torn down rather than just refusing this one request.
 */
export async function rotateTokenPair(
  token: string,
  client: ClientFingerprint,
): Promise<TokenPair> {
  const payload = verifyRefreshToken(token);

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, role: true, isActive: true } } },
  });

  if (!stored) {
    throw ApiError.unauthorized('Invalid refresh token');
  }

  if (stored.revokedAt) {
    getLogger().warn({ userId: stored.userId }, 'Refresh token reuse detected');
    await revokeAllSessions(stored.userId);
    await recordAudit({
      action: AuditAction.TOKEN_REUSE_DETECTED,
      entity: 'RefreshToken',
      entityId: stored.id,
      actorId: stored.userId,
      ipAddress: client.ipAddress,
    });
    throw ApiError.unauthorized('Refresh token has already been used');
  }

  if (stored.expiresAt <= new Date()) {
    throw ApiError.unauthorized('Refresh token has expired');
  }

  if (!stored.user.isActive) {
    throw ApiError.unauthorized('Account is deactivated');
  }

  const role = stored.user.role as Role;
  const refresh = signRefreshToken(payload.sub);

  // Revoking the old row and inserting its replacement must be atomic - a crash between
  // the two would either leave a replayable token alive or lock the user out.
  await prisma.$transaction([
    prisma.refreshToken.create({
      data: {
        id: refresh.tokenId,
        userId: payload.sub,
        tokenHash: hashToken(refresh.token),
        expiresAt: refresh.expiresAt,
        userAgent: client.userAgent?.slice(0, 255) ?? null,
        ipAddress: client.ipAddress ?? null,
      },
    }),
    prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedById: refresh.tokenId },
    }),
  ]);

  await recordAudit({
    action: AuditAction.TOKEN_REFRESHED,
    entity: 'RefreshToken',
    entityId: refresh.tokenId,
    actorId: payload.sub,
    ipAddress: client.ipAddress,
  });

  return { accessToken: signAccessToken(payload.sub, role), refreshToken: refresh.token };
}

/** Revokes a single session. Silent when the token is unknown - logout is idempotent. */
export async function revokeSession(token: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revokes every live session for a user: reuse detection, deactivation, password change. */
export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

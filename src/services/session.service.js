/**
 * Session revocation - the half of logout the token cannot do by itself.
 *
 * A signed JWT stays valid until it expires; nothing can take it back. So
 * both tokens of a login carry the same `sid`, and logging out records that
 * id here. Every authenticated request then asks one question - "is this
 * session revoked?" - and a single row answers it for the access token and
 * the refresh token at once.
 *
 * See db/migrations/006_revoked_session.sql for why a denylist of dead
 * sessions rather than a table of live ones.
 */
import { queryOne, mutate } from '../helpers/query.helper.js';
import { RevokedSession } from '../models/index.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Milliseconds for a jsonwebtoken lifetime string: '15m', '5d', '30s', '2h',
 * or a bare number of seconds.
 *
 * jsonwebtoken parses these with the `ms` package, but that is its dependency
 * and not ours - importing it would mean relying on a transitive install that
 * is free to disappear on any upgrade. The grammar is small enough to read
 * here, and an unparseable value is a config error worth failing loudly on
 * rather than guessing a default for.
 */
export function durationToMs(value) {
  if (typeof value === 'number') return value * 1000;

  const match = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(String(value).trim());
  if (!match) {
    throw new Error(
      `JWT_REFRESH_EXPIRES_IN is "${value}", which is not a duration. Use 30s, 15m, 2h or 5d.`,
    );
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const perUnit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

  return amount * perUnit[unit];
}

/**
 * When a session's longest-lived token can no longer be accepted on its own.
 *
 * Measured from NOW rather than from the token's `iat`, which overshoots by
 * however long the session had already been running. Overshooting is the safe
 * direction: the row outlives the tokens it names, so nothing is ever purged
 * while a token carrying that id could still be presented.
 */
function revocationExpiry() {
  return new Date(Date.now() + durationToMs(env.JWT_REFRESH_EXPIRES_IN));
}

/**
 * Records a session as dead. Both tokens carrying this id stop working on the
 * next request.
 *
 * Idempotent: logging out twice - a retry, a second browser tab - is ordinary
 * client behaviour, not an error, so a repeat insert is skipped rather than
 * allowed to violate the unique index.
 */
export async function revokeSession({ sessionId, employeeDetailId }) {
  const affected = await mutate(
    `INSERT INTO ${RevokedSession.table} (SessionId, EmployeeDetailId, ExpiresAt)
     SELECT @sessionId, @employeeDetailId, @expiresAt
      WHERE NOT EXISTS (
            SELECT 1 FROM ${RevokedSession.table} WHERE SessionId = @sessionId)`,
    RevokedSession.params({
      sessionId,
      employeeDetailId,
      expiresAt: revocationExpiry(),
    }),
  );

  if (affected > 0) {
    logger.info(`Session revoked for EmployeeDetailId ${employeeDetailId}`);
  }

  // Cheap, and it keeps the table at the size of "logouts in the last five
  // days" instead of growing forever. Logout is rare, so piggybacking the
  // purge here costs nothing a cron job would save.
  await purgeExpired();

  return { alreadyRevoked: affected === 0 };
}

/**
 * True when this session has been logged out.
 *
 * Runs on every authenticated request. It is a seek on a unique index over a
 * table holding only unexpired logouts, which is the cost of logout being
 * real rather than cosmetic.
 */
export async function isSessionRevoked(sessionId) {
  const row = await queryOne(
    `SELECT TOP 1 1 AS revoked FROM ${RevokedSession.table} WHERE SessionId = @sessionId`,
    RevokedSession.params({ sessionId }),
  );

  return row !== null;
}

/**
 * Drops rows whose tokens have expired on their own. Past that moment the
 * signature check rejects them without help, so the row proves nothing.
 */
export async function purgeExpired() {
  const removed = await mutate(
    `DELETE FROM ${RevokedSession.table} WHERE ExpiresAt < SYSUTCDATETIME()`,
  );

  if (removed > 0) {
    logger.debug(`Purged ${removed} expired revocation row(s)`);
  }

  return removed;
}

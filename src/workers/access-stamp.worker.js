/**
 * Watches dbo.tblAccessControlStamp and drops this instance's permission cache
 * when another instance changes access.
 *
 * Every admin write bumps the stamp in its own transaction and clears the
 * cache of the instance that made it. Every OTHER instance only finds out
 * here, within ACCESS_CONTROL_STAMP_POLL_SECONDS - not within the cache TTL,
 * which is the gap this worker exists to close.
 *
 * Polling one row by a unique key is a single index seek; doing it per
 * request instead would be the round trip the cache exists to remove.
 *
 * Started from src/index.js once the pool is up, stopped in the shutdown
 * handler. The interval is unref'd, like the mail worker's.
 */
import { queryOne } from '../helpers/query.helper.js';
import { env } from '../config/env.js';
import { clear as clearAccessCache } from '../utils/access-cache.js';
import { logger } from '../utils/logger.js';
import { AccessControlStamp, GLOBAL_STAMP } from '../models/index.js';

let timer = null;
let running = false;
/** The version this instance last saw. null until the first successful read. */
let lastVersion = null;

async function tick() {
  if (running) return;
  running = true;

  try {
    const row = await queryOne(
      `SELECT ${AccessControlStamp.select(['version'])}
         FROM ${AccessControlStamp.table}
        WHERE StampName = @stampName`,
      AccessControlStamp.params({ stampName: GLOBAL_STAMP }),
    );

    // BIGINT arrives as a string; compared as one, which is all this needs.
    const version = row ? String(row.version) : null;

    if (lastVersion !== null && version !== lastVersion) {
      clearAccessCache();
      logger.debug(`[access-stamp] version ${lastVersion} -> ${version}, cache cleared`);
    }
    lastVersion = version;
  } catch (error) {
    // A missed poll only means a slower invalidation; the TTL still bounds it.
    logger.warn('[access-stamp] poll failed', error);
  } finally {
    running = false;
  }
}

export function startAccessStampWorker() {
  // Nothing to invalidate when nothing is cached.
  if (timer || !env.ACCESS_CONTROL_CACHE_ENABLED) return;

  void tick();
  timer = setInterval(() => void tick(), env.ACCESS_CONTROL_STAMP_POLL_SECONDS * 1000);
  timer.unref();
  logger.debug(`[access-stamp] polling every ${env.ACCESS_CONTROL_STAMP_POLL_SECONDS}s`);
}

export function stopAccessStampWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

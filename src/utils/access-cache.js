/**
 * A small in-process cache for resolved permission sets.
 *
 * Without it every authenticated request pays a database round trip to answer
 * "may you?". That query is cheap - a handful of index seeks - but it would be
 * paid on every request forever, where a login pays bcrypt once.
 *
 * Three things make it safe rather than just fast:
 *
 *   - It stores the PROMISE, not the resolved value. A hundred concurrent
 *     requests from one person on a cold key produce one query, not a hundred.
 *     Exactly the pattern config/db.js uses for poolPromise.
 *   - Every admin write invalidates directly on the instance that performed
 *     it, so an admin sees their own change immediately.
 *   - Other instances learn through the stamp poller in
 *     src/workers/access-stamp.worker.js, which calls clear() when the global
 *     version moves.
 *
 * What this cache is NOT is the revocation gap. A fired employee's access
 * token stays valid for up to JWT_ACCESS_EXPIRES_IN no matter what happens
 * here. The mitigation that does exist today is the IsActive / DeletedAt check
 * in the permission guard: deactivating a profile cuts access off within one
 * TTL rather than one token lifetime.
 */
import { env } from '../config/env.js';
import { logger } from './logger.js';

/** @type {Map<number, { promise: Promise<any>, expiresAt: number }>} */
const entries = new Map();

const ttlMs = () => env.ACCESS_CONTROL_CACHE_TTL_SECONDS * 1000;

/**
 * The live entry for an employee, or undefined.
 *
 * Eviction is lazy - there is no sweeper timer, because an expired entry costs
 * nothing until somebody asks for it, and the size bound below handles the
 * pathological case.
 */
export function getCached(employeeId) {
  if (!env.ACCESS_CONTROL_CACHE_ENABLED) return undefined;

  const entry = entries.get(employeeId);
  if (!entry) return undefined;

  if (entry.expiresAt <= Date.now()) {
    entries.delete(employeeId);
    return undefined;
  }

  return entry.promise;
}

/**
 * Stores an in-flight resolution and returns it unchanged.
 *
 * A rejected promise is dropped rather than cached: a transient database error
 * must not deny the next request for a whole TTL.
 */
export function cacheAccess(employeeId, promise) {
  if (!env.ACCESS_CONTROL_CACHE_ENABLED) return promise;

  // A hard bound rather than an LRU. Access sets are small and uniform, the
  // ceiling is only reached by an unusually large active population, and
  // dropping everything is both correct and one line.
  if (entries.size >= env.ACCESS_CONTROL_CACHE_MAX_ENTRIES) {
    logger.debug(`[access-cache] size bound reached (${entries.size}), clearing`);
    entries.clear();
  }

  entries.set(employeeId, { promise, expiresAt: Date.now() + ttlMs() });

  promise.catch(() => {
    entries.delete(employeeId);
  });

  return promise;
}

/** Drops one person's entry. For writes that touch a single user. */
export function invalidateEmployee(employeeId) {
  entries.delete(employeeId);
}

/**
 * Drops everything.
 *
 * Used for role, group and catalog writes. Computing who is affected would mean
 * expanding every holder of a role plus every member of every group - more
 * work than simply rebuilding the few entries that actually get touched next.
 */
export function clear() {
  entries.clear();
}

/** For the health endpoint and for debugging. */
export function stats() {
  return {
    enabled: env.ACCESS_CONTROL_CACHE_ENABLED,
    entries: entries.size,
    ttlSeconds: env.ACCESS_CONTROL_CACHE_TTL_SECONDS,
  };
}

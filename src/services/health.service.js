/**
 * Business logic for the health module.
 *
 * A service never touches req or res — it takes plain arguments, returns plain
 * data, and throws ApiError when something is wrong. That keeps it callable
 * from a controller, a script, or a scheduled job alike.
 */
import { pingDatabase } from '../config/db.js';
import { env, isProduction } from '../config/env.js';

/** Liveness: is the process itself up? Deliberately does not touch the database. */
export function getLiveness() {
  return {
    status: 'ok',
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

/** Readiness: can the process actually serve traffic? */
export async function getReadiness() {
  const database = await pingDatabase();

  return {
    ready: database,
    checks: { database },
    // The host is a debugging aid on a developer machine. On a deployed server
    // it is the address of the database, published to anyone who can reach
    // /health — so production reports only whether it answered.
    database: isProduction
      ? { name: env.DB_NAME }
      : { host: env.DB_HOST, port: env.DB_PORT, name: env.DB_NAME },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Business logic for the health module.
 *
 * A service never touches req or res — it takes plain arguments, returns plain
 * data, and throws ApiError when something is wrong. That keeps it callable
 * from a controller, a script, or a scheduled job alike.
 */
import { pingDatabase } from '../config/db.js';
import { env } from '../config/env.js';

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
    database: { host: env.DB_HOST, port: env.DB_PORT, name: env.DB_NAME },
    timestamp: new Date().toISOString(),
  };
}

/**
 * One mssql ConnectionPool for the whole process.
 *
 * Connecting by named instance ("HOST\SQLEXPRESS") asks the SQL Server Browser
 * service on UDP 1434 to resolve the instance to a port. That service is often
 * disabled, and the failure looks like an unexplained connect timeout — so this
 * config always uses an explicit host + port instead.
 */
import sql from 'mssql';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

/** @type {import('mssql').config} */
const poolConfig = {
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  server: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  options: {
    encrypt: env.DB_ENCRYPT,
    // Local SQL Server uses a self-signed certificate, which no CA vouches for.
    trustServerCertificate: env.DB_TRUST_SERVER_CERTIFICATE,
    enableArithAbort: true,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30_000,
  },
  connectionTimeout: 15_000,
  requestTimeout: 30_000,
};

/** @type {Promise<import('mssql').ConnectionPool> | null} */
let poolPromise = null;

/**
 * Returns the shared pool, connecting on first call. Concurrent callers during
 * startup await the same promise instead of opening competing pools.
 */
export function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(poolConfig)
      .connect()
      .then((pool) => {
        logger.info(`Connected to SQL Server ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`);
        // A pool-level error (dropped network, server restart) must not take the
        // process down; drop the cached promise so the next call reconnects.
        pool.on('error', (error) => {
          logger.error('SQL Server pool error', error);
          poolPromise = null;
        });
        return pool;
      })
      .catch((error) => {
        poolPromise = null;
        throw error;
      });
  }
  return poolPromise;
}

/** Cheap readiness probe. Resolves false instead of throwing. */
export async function pingDatabase() {
  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1 AS ok');
    return true;
  } catch (error) {
    logger.error('Database ping failed', error);
    return false;
  }
}

/** Closes the pool during graceful shutdown. */
export async function closePool() {
  if (!poolPromise) return;
  const pending = poolPromise;
  poolPromise = null;
  try {
    const pool = await pending;
    await pool.close();
    logger.info('SQL Server pool closed');
  } catch (error) {
    logger.error('Failed to close SQL Server pool', error);
  }
}

export { sql };

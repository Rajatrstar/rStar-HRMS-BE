/**
 * One mssql ConnectionPool for the whole process.
 *
 * Two targets share this config: a local SQL Server instance and Azure SQL
 * Database. The difference that matters is not the host name — it is that
 * Azure is a shared service. It moves a database between nodes to patch them,
 * throttles an instance that is over its tier limits, and parks a serverless
 * database after an idle period, so the first connection has to wait for it to
 * wake up. Those all arrive as a connect failure that would be gone a few
 * seconds later, which is why connecting retries instead of killing the boot.
 *
 * Connecting by named instance ("HOST\SQLEXPRESS") asks the SQL Server Browser
 * service on UDP 1434 to resolve the instance to a port. That service is often
 * disabled, and the failure looks like an unexplained connect timeout — so this
 * config always uses an explicit host + port instead.
 */
import sql from 'mssql';
import { env, isAzureSql } from './env.js';
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
    // Azure SQL does not: its certificate chains to a public CA, so this is
    // false there and env.js refuses to let it be anything else.
    trustServerCertificate: env.DB_TRUST_SERVER_CERTIFICATE,
    enableArithAbort: true,
  },
  pool: {
    max: env.DB_POOL_MAX,
    min: 0,
    // Azure drops a connection that has been idle for around 30 minutes.
    // Giving up on one first means the pool never hands out a socket the
    // service has already closed.
    idleTimeoutMillis: 30_000,
  },
  connectionTimeout: env.DB_CONNECTION_TIMEOUT_MS,
  requestTimeout: env.DB_REQUEST_TIMEOUT_MS,
};

/**
 * Error numbers that mean "try again shortly", not "you got something wrong".
 *
 *   40613                  database unavailable: serverless resuming, or a failover
 *   40197 / 40501 / 40540  the service is reconfiguring or busy
 *   49918 / 49919 / 49920  not enough resources to process the request yet
 *   10928 / 10929          tier resource limits reached
 *   4221                   waiting for a readable secondary to catch up
 *   1205                   deadlock victim
 *   233 / 64 / 20 / 121 / 10053 / 10054 / 10060   transport-level drops
 *
 * Deliberately absent: 18456 (login failed), 4060 (cannot open that database)
 * and 40615 (firewall). Those are configuration, and retrying them only delays
 * the message that tells you so.
 */
const TRANSIENT_NUMBERS = new Set([
  40613, 40197, 40501, 40540, 49918, 49919, 49920, 10928, 10929, 4221, 1205, 233, 64, 20, 121,
  10053, 10054, 10060,
]);

const TRANSIENT_CODES = new Set(['ETIMEOUT', 'ESOCKET', 'ECONNRESET', 'ECONNCLOSED', 'EPIPE']);

function errorNumber(error) {
  return error?.number ?? error?.originalError?.info?.number ?? error?.originalError?.number;
}

function isTransient(error) {
  // A rejected certificate surfaces as ESOCKET, and no amount of retrying
  // makes an untrusted chain trusted — fail on the first one and say why.
  if (/certificate/i.test(error?.message ?? '')) return false;

  const number = errorNumber(error);
  if (number !== undefined && TRANSIENT_NUMBERS.has(number)) return true;
  return TRANSIENT_CODES.has(error?.code);
}

/**
 * Turns a driver error into the thing you would have to go and fix.
 *
 * Most of these reach the application as a bare timeout, and against a cloud
 * database the cause is rarely the one the raw message suggests. Returns null
 * when there is nothing useful to add.
 */
export function explainConnectionError(error) {
  const number = errorNumber(error);
  const message = error?.message ?? '';

  if (number === 18456 || /login failed/i.test(message)) {
    return isAzureSql
      ? `Login failed for "${env.DB_USER}". Check the password, and note that a contained user has to ` +
          `exist inside ${env.DB_NAME} itself — a login created in master does not grant access to it.`
      : `Login failed for "${env.DB_USER}". Check the password and that SQL authentication is enabled.`;
  }
  if (number === 4060 || /cannot open database/i.test(message)) {
    return `The server answered but "${env.DB_NAME}" did not — wrong database name, or ${env.DB_USER} has no access to it.`;
  }
  if (number === 40615 || /not allowed to access the server/i.test(message)) {
    return (
      'The Azure SQL firewall rejected this client IP (the message above names it). Allow it with:\n' +
      `  az sql server firewall-rule create -g <resource-group> -s ${env.DB_HOST.split('.')[0]} ` +
      '-n my-machine --start-ip-address <ip> --end-ip-address <ip>'
    );
  }
  if (number === 40613) {
    return 'The database is unavailable right now — a serverless database waking, or a failover. It normally clears within a minute.';
  }
  if (/certificate/i.test(message)) {
    return isAzureSql
      ? 'TLS rejected the server certificate. Azure SQL chains to a public CA, so this points at an intercepting proxy rather than a bad server.'
      : 'TLS rejected the server certificate. A local instance presents a self-signed one — set DB_TRUST_SERVER_CERTIFICATE=true for it.';
  }
  if (error?.code === 'ENOTFOUND' || error?.code === 'EAI_AGAIN') {
    return `DB_HOST "${env.DB_HOST}" does not resolve. Check the spelling of the server name.`;
  }
  if (error?.code === 'ETIMEOUT' || error?.code === 'ESOCKET') {
    return isAzureSql
      ? `Could not reach ${env.DB_HOST}:${env.DB_PORT}. Either outbound TCP 1433 is blocked on this network ` +
          '(common on corporate and hotel Wi-Fi), or no firewall rule on the Azure server allows this IP.'
      : `Could not reach ${env.DB_HOST}:${env.DB_PORT}. Check the instance is running and TCP/IP is enabled on that port.`;
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens one pool, retrying only the failures that are worth retrying. */
async function connect() {
  const attempts = Math.max(1, env.DB_CONNECT_RETRIES);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await new sql.ConnectionPool(poolConfig).connect();
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) throw error;

      const delay = Math.min(1000 * 2 ** (attempt - 1), 8_000);
      logger.warn(
        `Database connect ${attempt}/${attempts} failed ` +
          `(${error.code ?? errorNumber(error)}: ${error.message}); retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
}

/** @type {Promise<import('mssql').ConnectionPool> | null} */
let poolPromise = null;

/**
 * Returns the shared pool, connecting on first call. Concurrent callers during
 * startup await the same promise instead of opening competing pools.
 */
export function getPool() {
  if (!poolPromise) {
    poolPromise = connect()
      .then((pool) => {
        logger.info(
          `Connected to ${isAzureSql ? 'Azure SQL' : 'SQL Server'} ` +
            `${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`,
        );
        // A pool-level error (dropped network, server restart, Azure moving
        // the database) must not take the process down; drop the cached
        // promise so the next call reconnects.
        pool.on('error', (error) => {
          logger.error('SQL Server pool error', error);
          poolPromise = null;
        });
        return pool;
      })
      .catch((error) => {
        poolPromise = null;
        const hint = explainConnectionError(error);
        if (hint) logger.error(`Database connection failed. ${hint}`);
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

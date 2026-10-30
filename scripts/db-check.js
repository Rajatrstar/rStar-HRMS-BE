/**
 * Answers one question before you go looking for a bug in the app: can this
 * machine reach this database, as this user, and what is actually in it?
 *
 * Exists because every connection failure arrives as the same timeout. Against
 * Azure SQL in particular, "connect timeout" is usually a firewall rule that
 * was never added or a network that blocks outbound 1433 — neither of which
 * the raw error says, and both of which this prints.
 *
 *   npm run db:check
 */
import { lookup } from 'node:dns/promises';
import { getPool, closePool, explainConnectionError } from '../src/config/db.js';
import { env, isAzureSql } from '../src/config/env.js';

const OK = '\x1b[32mok\x1b[0m';
const BAD = '\x1b[31mfailed\x1b[0m';

function line(label, value) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function run() {
  console.log(`\n${isAzureSql ? 'Azure SQL Database' : 'SQL Server'}\n`);
  line('host', `${env.DB_HOST}:${env.DB_PORT}`);
  line('database', env.DB_NAME);
  line('user', env.DB_USER);
  line('encrypt', String(env.DB_ENCRYPT));
  line('trust certificate', String(env.DB_TRUST_SERVER_CERTIFICATE));
  line('connect timeout', `${env.DB_CONNECTION_TIMEOUT_MS} ms, ${env.DB_CONNECT_RETRIES} attempt(s)`);

  console.log('\nchecks\n');

  // DNS first: a mistyped server name and a blocked port both time out, and
  // only one of them gets this far.
  try {
    const { address } = await lookup(env.DB_HOST);
    line('dns', `${OK}  ${env.DB_HOST} -> ${address}`);
  } catch {
    line('dns', `${BAD}  ${env.DB_HOST} does not resolve`);
    throw new Error(`DB_HOST "${env.DB_HOST}" could not be resolved.`);
  }

  const started = Date.now();
  const pool = await getPool();
  line('connect', `${OK}  ${Date.now() - started} ms`);

  const info = await pool.request().query(`
    SELECT
      login      = SUSER_SNAME(),
      dbUser     = USER_NAME(),
      dbName     = DB_NAME(),
      version    = CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(50)),
      edition    = CAST(SERVERPROPERTY('Edition') AS NVARCHAR(100)),
      engine     = CAST(SERVERPROPERTY('EngineEdition') AS INT),
      collation  = CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS NVARCHAR(100)),
      utcNow     = SYSUTCDATETIME()
  `);
  const row = info.recordset[0];

  line('authenticated as', `${OK}  ${row.login} (database user ${row.dbUser})`);
  line('database', `${OK}  ${row.dbName}`);
  line('edition', `${row.edition} (engine ${row.engine}, version ${row.version})`);
  line('collation', row.collation);

  // EngineEdition 5 is Azure SQL Database. Reported rather than assumed, so a
  // host name that merely looks like Azure cannot mislead this output.
  if (row.engine === 5) {
    const tier = await pool.request().query(`
      SELECT objective = service_objective, edition = edition
      FROM sys.database_service_objectives
      WHERE database_id = DB_ID()
    `);
    if (tier.recordset[0]) {
      line('service tier', `${tier.recordset[0].edition} / ${tier.recordset[0].objective}`);
    }
  } else if (isAzureSql) {
    line('warning', 'the host looks like Azure SQL but the server reports otherwise');
  }

  // Rights, asked for rather than inferred: a read-only user connects
  // perfectly and then fails on the first migration. Note that creating a
  // *temp* table proves nothing here — every user may do that — so this asks
  // about the real permissions instead of probing with one.
  const rights = await pool.request().query(`
    SELECT
      owner       = IS_ROLEMEMBER('db_owner'),
      writer      = IS_ROLEMEMBER('db_datawriter'),
      reader      = IS_ROLEMEMBER('db_datareader'),
      createTable = HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE')
  `);
  const { owner, writer, reader, createTable } = rights.recordset[0];
  line('can read / write', owner === 1 || (reader === 1 && writer === 1) ? OK : `${BAD}  the API needs both`);
  line('can migrate', createTable === 1 ? OK : `${BAD}  CREATE TABLE is denied, db:migrate will fail`);

  // Deferred name resolution does not apply outside a stored procedure, so a
  // SELECT naming a table that does not exist fails to compile — the check has
  // to happen before the query, not inside it.
  const history = await pool
    .request()
    .query("SELECT present = CASE WHEN OBJECT_ID('dbo._Migrations', 'U') IS NULL THEN 0 ELSE 1 END");

  if (history.recordset[0].present === 0) {
    line('migrations', 'none applied yet — run npm run db:migrate');
  } else {
    const migrations = await pool
      .request()
      .query('SELECT applied = COUNT(*), latest = MAX(Name) FROM dbo._Migrations');
    const { applied, latest } = migrations.recordset[0];
    line('migrations', `${applied} applied, latest ${latest}`);
  }

  const tables = await pool
    .request()
    .query("SELECT n = COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'");
  line('tables', String(tables.recordset[0].n));

  console.log('\nReady.\n');
  await closePool();
}

run().catch(async (error) => {
  const hint = explainConnectionError(error);
  console.error(`\n  ${BAD}  ${error.message}`);
  if (hint) console.error(`\n  ${hint}`);
  console.error('');
  await closePool();
  process.exit(1);
});

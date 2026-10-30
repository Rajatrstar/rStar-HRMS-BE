/**
 * Brings the database up to the schema this build expects.
 *
 * The Python service next door calls SQLAlchemy's `Base.metadata.create_all()`
 * from its FastAPI lifespan: point it at an empty database, start it, and the
 * tables appear. This is the same idea for a project with no ORM — on boot,
 * every .sql file in db/migrations that has not run yet is applied.
 *
 * It is not quite create_all, and the difference is the point. create_all only
 * ever CREATEs: it adds tables that are missing and is blind to a column that
 * changed, so a model edit silently does nothing against a database that
 * already has the table. Here the unit is a migration file, recorded by name
 * in dbo._Migrations, so altering an existing table is a supported thing to
 * ship rather than something you discover was never applied.
 *
 * Used from two places, which is why it lives here and not in the script:
 *   - scripts/migrate.js, run by hand
 *   - src/index.js at startup, when DB_AUTO_MIGRATE is on
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, sql } from './db.js';
import { logger } from '../utils/logger.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'db',
  'migrations',
);

/**
 * SQL Server error numbers for "you are not allowed to do that".
 *
 * Worth naming because this is the failure an empty Azure database is most
 * likely to hit: the application login is usually db_datareader +
 * db_datawriter, which is exactly right for serving traffic and not enough to
 * create a table. The generic message ("CREATE TABLE permission denied in
 * database X") sends people to check their connection string, which is fine.
 */
const PERMISSION_ERRORS = new Set([229, 262, 300]);

export function isPermissionError(error) {
  return PERMISSION_ERRORS.has(error?.number) || PERMISSION_ERRORS.has(error?.originalError?.number);
}

async function ensureHistoryTable(pool) {
  await pool.request().query(`
    IF OBJECT_ID('dbo._Migrations', 'U') IS NULL
      CREATE TABLE dbo._Migrations (
        Name       NVARCHAR(255) NOT NULL CONSTRAINT PK__Migrations PRIMARY KEY,
        AppliedAt  DATETIME2(3)  NOT NULL CONSTRAINT DF__Migrations_AppliedAt DEFAULT SYSUTCDATETIME()
      );
  `);
}

async function appliedMigrations(pool) {
  const result = await pool.request().query('SELECT Name FROM dbo._Migrations');
  return new Set(result.recordset.map((row) => row.Name));
}

/** Every migration filename on disk, in the order they must run. */
export async function migrationFiles() {
  return (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
}

/**
 * Applies whatever has not run yet.
 *
 * Each file runs inside its own transaction, so a file that fails half way
 * leaves nothing behind and is retried in full next time. A file that
 * succeeded stays applied even if a later one fails — which is why the files
 * are numbered and must not be reordered after they have shipped.
 *
 * @returns {Promise<{ applied: string[], alreadyApplied: number, total: number }>}
 */
export async function syncSchema({ pool: given } = {}) {
  const pool = given ?? (await getPool());

  await ensureHistoryTable(pool);
  const applied = await appliedMigrations(pool);
  const files = await migrationFiles();

  const ran = [];

  for (const file of files) {
    if (applied.has(file)) continue;

    const statement = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      // GO is a sqlcmd batch separator, not SQL — the driver cannot parse it.
      for (const batch of statement.split(/^\s*GO\s*$/gim)) {
        if (batch.trim()) await new sql.Request(transaction).batch(batch);
      }
      await new sql.Request(transaction)
        .input('name', sql.NVarChar(255), file)
        .query('INSERT INTO dbo._Migrations (Name) VALUES (@name)');
      await transaction.commit();
      logger.info(`applied ${file}`);
      ran.push(file);
    } catch (error) {
      await transaction.rollback();
      throw new Error(`Migration ${file} failed: ${error.message}`, { cause: error });
    }
  }

  return { applied: ran, alreadyApplied: files.length - ran.length, total: files.length };
}

/** How many user tables exist, used to tell "empty database" from "up to date". */
export async function tableCount(pool) {
  const result = await pool
    .request()
    .query("SELECT COUNT(*) AS total FROM sys.tables WHERE is_ms_shipped = 0");
  return result.recordset[0].total;
}

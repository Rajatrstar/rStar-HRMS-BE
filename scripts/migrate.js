/**
 * Applies every .sql file in db/migrations, in filename order, once.
 *
 * Deliberately tiny: applied filenames are recorded in dbo._Migrations, so
 * re-running is safe and only new files execute. Each file runs inside a
 * transaction, so a failure half way through leaves nothing behind.
 *
 *   npm run db:migrate
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool, sql } from '../src/config/db.js';
import { logger } from '../src/utils/logger.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

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

async function run() {
  const pool = await getPool();
  await ensureHistoryTable(pool);

  const applied = await appliedMigrations(pool);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      logger.debug(`skip ${file} (already applied)`);
      continue;
    }

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
      count += 1;
    } catch (error) {
      await transaction.rollback();
      throw new Error(`Migration ${file} failed: ${error.message}`, { cause: error });
    }
  }

  logger.info(count === 0 ? 'Database already up to date' : `Applied ${count} migration(s)`);
  await closePool();
}

run().catch(async (error) => {
  logger.error('Migration failed', error);
  await closePool();
  process.exit(1);
});

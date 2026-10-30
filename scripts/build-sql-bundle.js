/**
 * Prints every pending migration as one script, for the case where the account
 * that may change the schema is not the account in .env.
 *
 * On Azure the API's login is deliberately read/write only, so `db:migrate`
 * cannot run as it. Rather than hand those credentials around, an
 * administrator runs this output once in SSMS, sqlcmd or the portal:
 *
 *   node --env-file=.env scripts/build-sql-bundle.js > bundle.sql
 *
 * The bundle writes dbo._Migrations itself, so a later `npm run db:migrate`
 * sees these files as applied and skips them, and only genuinely new ones run.
 *
 * It is meant for an EMPTY database. A migration body cannot be wrapped in
 * "IF NOT EXISTS ... BEGIN ... END" because the bodies contain GO, which ends
 * the batch — so re-running the bundle over a half-built database fails on the
 * first object that already exists, rather than skipping it. If that happens,
 * delete the migrations that already succeeded from the top of the file and
 * run the rest.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

const out = [];
out.push('/*');
out.push(' * rSTAR HRMS - full schema bundle');
out.push(` * Generated ${new Date().toISOString()} from db/migrations`);
out.push(' *');
out.push(' * Run as an account that may create tables. Needs GO support, so use');
out.push(' * SSMS, Azure Data Studio or sqlcmd - the portal query editor does not');
out.push(' * understand GO and will fail part way through.');
out.push(' */');
out.push('');
out.push(`IF OBJECT_ID('dbo._Migrations', 'U') IS NULL`);
out.push('  CREATE TABLE dbo._Migrations (');
out.push('    Name       NVARCHAR(255) NOT NULL CONSTRAINT PK__Migrations PRIMARY KEY,');
out.push(
  '    AppliedAt  DATETIME2(3)  NOT NULL CONSTRAINT DF__Migrations_AppliedAt DEFAULT SYSUTCDATETIME()',
);
out.push('  );');
out.push('GO');
out.push('');

for (const file of files) {
  const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8');

  out.push('-- ' + '='.repeat(74));
  out.push(`-- ${file}`);
  out.push('-- ' + '='.repeat(74));
  out.push(body.trimEnd());
  out.push('GO');
  out.push('');
  out.push(`IF NOT EXISTS (SELECT 1 FROM dbo._Migrations WHERE Name = '${file}')`);
  out.push(`  INSERT INTO dbo._Migrations (Name) VALUES ('${file}');`);
  out.push('GO');
  out.push('');
}

process.stdout.write(out.join('\n'));

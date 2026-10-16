/**
 * Compares every model in src/models against the live database.
 *
 *   npm run db:verify
 *
 * Models are hand-written, so without this they are a second source of truth
 * that silently rots the first time a migration renames a column. This script
 * is what makes the folder trustworthy: it fails loudly on a missing column, a
 * wrong type or a length that no longer matches.
 *
 * Columns the database has but no model mentions are reported as a warning,
 * not a failure - a table may legitimately carry something the app never reads.
 */
import { query, sql } from '../src/helpers/query.helper.js';
import { closePool } from '../src/config/db.js';
import { logger } from '../src/utils/logger.js';
import * as models from '../src/models/index.js';

/** Unwraps sql.Int (a function) and sql.NVarChar(256) (an object) into one shape. */
function describe(type) {
  const declaration = (type.declaration ?? type.type?.declaration ?? '').toLowerCase();
  const length = typeof type === 'function' ? null : (type.length ?? null);
  return { declaration, length };
}

/** What INFORMATION_SCHEMA reports, in the same shape. */
function describeColumn(row) {
  return {
    declaration: row.dataType.toLowerCase(),
    // -1 is how SQL Server reports MAX; the driver calls the same thing 65535.
    length: row.maxLength === -1 ? sql.MAX : row.maxLength,
  };
}

async function verifyModel(name, model) {
  const [schema, table] = model.table.replace(/[[\]]/g, '').split('.');

  const rows = await query(
    `SELECT COLUMN_NAME AS columnName,
            DATA_TYPE   AS dataType,
            CHARACTER_MAXIMUM_LENGTH AS maxLength
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table`,
    {
      schema: { type: sql.NVarChar(128), value: schema },
      table: { type: sql.NVarChar(128), value: table },
    },
  );

  if (rows.length === 0) {
    return [`${name}: table ${model.table} does not exist - run npm run db:migrate`];
  }

  const live = new Map(rows.map((row) => [row.columnName.toLowerCase(), row]));
  const problems = [];

  for (const prop of model.props) {
    const { column, type } = model.columns[prop];
    const row = live.get(column.toLowerCase());

    if (!row) {
      problems.push(`${name}.${prop}: ${model.table} has no column ${column}`);
      continue;
    }
    live.delete(column.toLowerCase());

    const want = describe(type);
    const got = describeColumn(row);

    if (want.declaration !== got.declaration) {
      problems.push(
        `${name}.${prop}: ${column} is ${got.declaration}, model says ${want.declaration}`,
      );
      continue;
    }

    // Only character types carry a length worth comparing.
    if (want.length !== null && got.length !== null && want.length !== got.length) {
      const asText = (value) => (value === sql.MAX ? 'MAX' : value);
      problems.push(
        `${name}.${prop}: ${column} is ${got.declaration}(${asText(got.length)}), ` +
          `model says ${asText(want.length)}`,
      );
    }
  }

  for (const row of live.values()) {
    logger.warn(`${name}: ${model.table}.${row.columnName} exists but no model property maps it`);
  }

  return problems;
}

async function run() {
  const defined = Object.entries(models).filter(
    ([, value]) => value && typeof value === 'object' && 'table' in value && 'props' in value,
  );

  if (defined.length === 0) throw new Error('No models found in src/models.');

  const problems = [];
  for (const [name, model] of defined) {
    const found = await verifyModel(name, model);
    if (found.length === 0) {
      logger.info(`${name} matches ${model.table} (${model.props.length} columns)`);
    }
    problems.push(...found);
  }

  await closePool();

  if (problems.length > 0) {
    for (const problem of problems) logger.error(problem);
    logger.error(`${problems.length} mismatch(es) between src/models and the database`);
    process.exit(1);
  }

  logger.info(`All ${defined.length} model(s) match the database`);
}

run().catch(async (error) => {
  logger.error('Schema verification failed', error);
  await closePool();
  process.exit(1);
});

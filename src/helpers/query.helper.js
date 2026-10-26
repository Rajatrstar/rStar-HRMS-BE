/**
 * Thin layer over the shared pool so no caller builds SQL by concatenation.
 *
 * Every value goes in as a named parameter:
 *
 *   await query('SELECT * FROM employees WHERE id = @id', {
 *     id: { type: sql.Int, value: employeeId },
 *   });
 *
 * The shorthand `{ id: 5 }` works too and lets the driver infer the type, but
 * naming the type is better: it avoids surprise NVARCHAR(MAX) parameters that
 * stop SQL Server using an index.
 */
import { getPool, sql } from '../config/db.js';

/**
 * @param {import('mssql').Request} request
 * @param {Record<string, unknown>} params
 */
function bind(request, params) {
  for (const [name, param] of Object.entries(params)) {
    if (param !== null && typeof param === 'object' && 'type' in param) {
      request.input(name, param.type, param.value);
    } else {
      request.input(name, param);
    }
  }
  return request;
}

/**
 * Runs a batch of statements and returns every recordset, in order.
 *
 * `query()` below returns only the first and silently drops the rest, which is
 * a trap when one round trip deliberately answers two questions - the access
 * resolver asks for a permission set and the scope context together.
 *
 * @returns {Promise<any[][]>}
 */
export async function querySets(statement, params = {}) {
  const pool = await getPool();
  const result = await bind(pool.request(), params).query(statement);
  return result.recordsets ?? [];
}

/**
 * Runs a statement and returns all rows.
 * @returns {Promise<any[]>}
 */
export async function query(statement, params = {}) {
  const pool = await getPool();
  const result = await bind(pool.request(), params).query(statement);
  return result.recordset ?? [];
}

/**
 * Runs a statement and returns the first row, or null when there is none.
 * @returns {Promise<any | null>}
 */
export async function queryOne(statement, params = {}) {
  const rows = await query(statement, params);
  return rows[0] ?? null;
}

/**
 * Runs a statement that changes data and returns the number of rows affected.
 * @returns {Promise<number>}
 */
export async function mutate(statement, params = {}) {
  const pool = await getPool();
  const result = await bind(pool.request(), params).query(statement);
  return result.rowsAffected?.[0] ?? 0;
}

/**
 * Calls a stored procedure.
 * @returns {Promise<{ rows: any[], returnValue: number, output: Record<string, unknown> }>}
 */
export async function execute(procedureName, params = {}) {
  const pool = await getPool();
  const result = await bind(pool.request(), params).execute(procedureName);
  return {
    rows: result.recordset ?? [],
    returnValue: result.returnValue,
    output: result.output ?? {},
  };
}

/**
 * Runs `work` inside a transaction, committing on success and rolling back on
 * any thrown error. The callback receives a request factory bound to the
 * transaction — use it instead of the helpers above, which use the pool.
 *
 *   await withTransaction(async (run) => {
 *     await run('UPDATE ...', { id: 1 });
 *     await run('INSERT ...', { name: 'x' });
 *   });
 */
export async function withTransaction(work) {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const run = async (statement, params = {}) => {
      const result = await bind(new sql.Request(transaction), params).query(statement);
      return result.recordset ?? [];
    };
    const outcome = await work(run);
    await transaction.commit();
    return outcome;
  } catch (error) {
    // Roll back, but never let the rollback's own failure replace the error
    // that caused it. SQL Server aborts a transaction on many errors, so the
    // rollback then throws "Transaction has been aborted" - and that message,
    // reported on its own, says nothing about the statement that failed.
    try {
      await transaction.rollback();
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  }
}

export { sql };

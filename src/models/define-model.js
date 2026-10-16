/**
 * Describes one table: its name, its columns and their SQL types.
 *
 * There is no ORM here, so a model is a reference and a source of typed
 * parameters - not a query builder. Queries stay hand-written SQL, because
 * readable SQL is worth more than a fluent API that hides what the database
 * actually runs.
 *
 * What a model buys you:
 *   - one place that mirrors db/migrations for every table
 *   - parameters bound with the right type, so NVARCHAR(256) never arrives as
 *     NVARCHAR(MAX) and quietly stops SQL Server using an index
 *   - select lists that alias database columns to JS property names
 *
 * `npm run db:verify` compares every model against the live database, which is
 * what keeps this folder honest.
 */

/**
 * @param {{ table: string, columns: Record<string, { column: string, type: unknown, identity?: boolean, nullable?: boolean }> }} definition
 */
export function defineModel({ table, columns }) {
  const frozenColumns = Object.freeze(
    Object.fromEntries(Object.entries(columns).map(([prop, meta]) => [prop, Object.freeze(meta)])),
  );

  const props = Object.freeze(Object.keys(frozenColumns));

  function meta(prop) {
    const found = frozenColumns[prop];
    if (!found) {
      throw new Error(`${table} has no property "${prop}". Known: ${props.join(', ')}.`);
    }
    return found;
  }

  return Object.freeze({
    table,
    columns: frozenColumns,
    props,

    /** Database column name for a property: col('employeeId') -> 'EmployeeId'. */
    col: (prop) => meta(prop).column,

    /** One typed parameter for helpers/query.helper.js. */
    param: (prop, value) => ({ type: meta(prop).type, value }),

    /**
     * Several at once:
     *   params({ email, otp })  ->  { email: {type, value}, otp: {type, value} }
     */
    params(values) {
      return Object.fromEntries(
        Object.entries(values).map(([prop, value]) => [prop, { type: meta(prop).type, value }]),
      );
    },

    /**
     * Aliased select list, so rows come back with JS property names:
     *   select(['employeeId', 'email'])  ->  'EmployeeId AS employeeId, Email AS email'
     */
    select(chosen = props) {
      return chosen.map((prop) => `${meta(prop).column} AS ${prop}`).join(', ');
    },
  });
}

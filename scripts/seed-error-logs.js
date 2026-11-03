/**
 * Fills dbo.tblErrorLog with sample entries, so the admin Error Logs
 * dashboard has something to show while it is being built.
 *
 *   npm run db:seed:errorlogs            replace the samples with a fresh set
 *   npm run db:seed:errorlogs -- --clear remove the samples, add nothing
 *
 * DEVELOPMENT ONLY. Refuses to run when NODE_ENV is production.
 *
 * Every sample row has ServerName 'sample-seed'. That is the only thing this
 * script ever deletes, so real entries written by the running server are
 * never touched, and re-running replaces the samples instead of doubling them.
 *
 * The set covers every source and severity, repeats of one issue (same
 * fingerprint) for the "happened N times" view and top issues, a spread over
 * the last 14 days for the daily chart, and a few already resolved. Times are
 * relative to now, so the default 7-day summary is never empty.
 */
import { createHash, randomUUID } from 'node:crypto';
import { getPool, closePool } from '../src/config/db.js';
import { mutate, query } from '../src/helpers/query.helper.js';
import { ErrorLog } from '../src/models/index.js';
import { ERROR_LOG_SOURCE, ERROR_LOG_SEVERITY } from '../src/enums/index.js';
import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';

const SAMPLE_SERVER = 'sample-seed';
const DAYS = 14;

const { API, JOB, PROCESS, STARTUP, CLIENT } = ERROR_LOG_SOURCE;
const { WARN, ERROR, FATAL } = ERROR_LOG_SEVERITY;

const BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

/*
  One entry per issue. `count` rows are written for it, spread over the last
  DAYS days. `user` is a role resolved to a real employee below; `url` may use
  {id}, filled with a different number on each row. `resolved` marks every
  row of the issue resolved by the admin, with that note.
*/
const ISSUES = [
  {
    key: 'education-timeout',
    count: 9,
    source: API, severity: ERROR, statusCode: 500, user: 'admin',
    httpMethod: 'PUT', routePattern: '/api/v1/employees/:employeeDetailId/education', url: '/api/v1/employees/{id}/education',
    errorName: 'RequestError', sqlErrorNumber: -2, durationMs: [15000, 15100],
    message: 'Timeout: Request failed to complete in 15000ms',
    stackTrace: 'RequestError: Timeout: Request failed to complete in 15000ms\n    at Request.userCallback (node_modules/mssql/lib/tedious/request.js:492:19)\n    at replaceSection (src/services/employee-profile.service.js:214:9)\n    at async updateEducation (src/controllers/employee-profile.controller.js:88:20)',
    requestBody: { items: [{ qualificationId: 3, institution: 'Punjab University', yearOfPassing: 2016, percentage: 78.4 }] },
  },
  {
    key: 'employee-create-reset',
    count: 3,
    source: API, severity: ERROR, statusCode: 500, user: 'admin',
    httpMethod: 'POST', routePattern: '/api/v1/employees', url: '/api/v1/employees',
    errorName: 'ConnectionError', durationMs: [800, 2400],
    message: 'Connection lost - read ECONNRESET',
    stackTrace: 'ConnectionError: Connection lost - read ECONNRESET\n    at Connection.socketError (node_modules/tedious/lib/connection.js:1428:26)\n    at createEmployee (src/services/employee.service.js:301:5)',
    requestBody: { firstName: 'Neha', lastName: 'Verma', workEmail: 'neha.verma@rstartec.com', password: 'Welcome@123', dateOfJoining: '2026-11-01' },
    resolved: 'Azure SQL failover during maintenance window. No code change needed.',
  },
  {
    key: 'employee-list-typeerror',
    count: 6,
    source: API, severity: ERROR, statusCode: 500, user: 'manager',
    httpMethod: 'GET', routePattern: '/api/v1/employees', url: '/api/v1/employees?page=1&pageSize=25&search=sha',
    errorName: 'TypeError', durationMs: [40, 120],
    message: "Cannot read properties of undefined (reading 'map')",
    stackTrace: "TypeError: Cannot read properties of undefined (reading 'map')\n    at toListRow (src/services/employee.service.js:142:31)\n    at Array.map (<anonymous>)\n    at listEmployees (src/services/employee.service.js:160:22)",
  },
  {
    key: 'location-delete-fk',
    count: 2,
    source: API, severity: ERROR, statusCode: 500, user: 'admin',
    httpMethod: 'DELETE', routePattern: '/api/v1/organizations/:organizationId/locations/:locationId', url: '/api/v1/organizations/1/locations/{id}',
    errorName: 'RequestError', sqlErrorNumber: 547, durationMs: [60, 180],
    message: 'The DELETE statement conflicted with the REFERENCE constraint "FK_tblEmployeeDetails_Location". The conflict occurred in database "rstar-hrms-sql", table "dbo.tblEmployeeDetails", column \'LocationId\'.',
    stackTrace: 'RequestError: The DELETE statement conflicted with the REFERENCE constraint "FK_tblEmployeeDetails_Location".\n    at handleError (node_modules/mssql/lib/tedious/request.js:384:15)\n    at deleteLocation (src/services/organization.service.js:276:3)',
  },
  {
    key: 'employee-list-denied',
    count: 12,
    source: API, severity: WARN, statusCode: 403, errorCode: 'PERMISSION_DENIED', user: 'employee',
    httpMethod: 'GET', routePattern: '/api/v1/employees', url: '/api/v1/employees?page=1&pageSize=25',
    errorName: 'ApiError', durationMs: [8, 30],
    message: 'You do not have permission to perform this action',
  },
  {
    key: 'employee-delete-denied',
    count: 4,
    source: API, severity: WARN, statusCode: 403, errorCode: 'PERMISSION_DENIED', user: 'manager',
    httpMethod: 'DELETE', routePattern: '/api/v1/employees/:employeeDetailId', url: '/api/v1/employees/{id}',
    errorName: 'ApiError', durationMs: [8, 30],
    message: 'You do not have permission to perform this action',
  },
  {
    key: 'error-logs-denied',
    count: 2,
    source: API, severity: WARN, statusCode: 403, errorCode: 'PERMISSION_DENIED', user: 'employee',
    httpMethod: 'GET', routePattern: '/api/v1/error-logs', url: '/api/v1/error-logs?page=1&pageSize=25',
    errorName: 'ApiError', durationMs: [8, 30],
    message: 'You do not have permission to perform this action',
  },
  {
    key: 'employee-code-taken',
    count: 6,
    source: API, severity: WARN, statusCode: 409, errorCode: 'CODE_ALREADY_EXISTS', user: 'admin',
    httpMethod: 'POST', routePattern: '/api/v1/employees', url: '/api/v1/employees',
    errorName: 'ApiError', durationMs: [50, 140],
    message: 'That employee code is already in use',
    requestBody: { employeeCode: 'EMP001', firstName: 'Rohit', lastName: 'Mehra', workEmail: 'rohit.mehra@rstartec.com' },
  },
  {
    key: 'document-modified-elsewhere',
    count: 2,
    source: API, severity: WARN, statusCode: 409, errorCode: 'MODIFIED_ELSEWHERE', user: 'admin',
    httpMethod: 'PUT', routePattern: '/api/v1/employees/:employeeDetailId/documents/:documentType', url: '/api/v1/employees/{id}/documents/PAN',
    errorName: 'ApiError', durationMs: [300, 900],
    message: 'Someone else changed this record at the same time. Reload and try again.',
    requestBody: { panNumber: 'ABCDE1234F' },
  },
  {
    key: 'email-auth-failed',
    count: 3,
    source: JOB, severity: ERROR,
    errorName: 'Error',
    message: 'Email 1842 to anmol.ghai@rstartec.com failed after 5 attempts: Invalid login: 535 5.7.3 Authentication unsuccessful',
    stackTrace: 'Error: Invalid login: 535 5.7.3 Authentication unsuccessful\n    at SMTPConnection._formatError (node_modules/nodemailer/lib/smtp-connection/index.js:798:19)\n    at sendOne (src/workers/email-outbox.worker.js:74:7)',
    resolved: 'SMTP app password rotated; MAIL_PASSWORD updated on the server.',
  },
  {
    key: 'unhandled-rejection',
    count: 1,
    source: PROCESS, severity: FATAL,
    errorName: 'Error',
    message: 'Unhandled promise rejection: connect ETIMEDOUT 20.192.98.161:1433',
    stackTrace: 'Error: connect ETIMEDOUT 20.192.98.161:1433\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16)',
  },
  {
    key: 'startup-db',
    count: 1,
    source: STARTUP, severity: FATAL,
    errorName: 'ConnectionError',
    message: "Failed to connect to sql-azure-server-dev.database.windows.net:1433 - Client with IP address '103.41.25.14' is not allowed to access the server.",
    stackTrace: "ConnectionError: Failed to connect to sql-azure-server-dev.database.windows.net:1433\n    at getPool (src/config/db.js:58:11)\n    at start (src/index.js:31:3)",
    resolved: 'Office IP added to the Azure SQL firewall.',
  },
  {
    key: 'client-employee-tab',
    count: 4,
    source: CLIENT, severity: ERROR, user: 'manager',
    routePattern: '/employees/:id', url: '/employees/{id}?tab=documents',
    errorName: 'TypeError', userAgent: BROWSER,
    message: "Cannot read properties of null (reading 'fileUrl')",
    stackTrace: "TypeError: Cannot read properties of null (reading 'fileUrl')\n    at DocumentCard (DocumentCard.tsx:41:23)\n    at renderWithHooks (react-dom.development.js:15486:18)\n\n    in DocumentCard\n    in DocumentsTab\n    in EmployeeProfile",
    requestBody: { appVersion: '1.4.0', screen: 'EmployeeProfile', tab: 'documents' },
  },
  {
    key: 'client-chunk-load',
    count: 3,
    source: CLIENT, severity: WARN, user: 'employee',
    routePattern: '/dashboard', url: '/dashboard',
    errorName: 'ChunkLoadError', userAgent: MOBILE,
    message: 'Loading chunk 412 failed. (timeout: https://hrms.rstartec.com/static/js/412.chunk.js)',
    stackTrace: 'ChunkLoadError: Loading chunk 412 failed.\n    at __webpack_require__.f.j (bootstrap:194:29)',
    requestBody: { appVersion: '1.4.0', online: true, accessToken: 'eyJhbGciOi...' },
  },
];

/** Who each role is in this database: the first active employee of that group. */
async function resolveUsers() {
  const rows = await query(
    `SELECT d.EmployeeDetailId AS id, g.GroupName AS groupName
       FROM dbo.tblEmployeeDetails d
       JOIN dbo.tblGroup g ON g.GroupId = d.GroupId
      WHERE d.IsActive = 1 AND d.DeletedAt IS NULL
      ORDER BY d.EmployeeDetailId`,
  );
  const first = (pattern) => rows.find((row) => pattern.test(row.groupName))?.id ?? null;
  return { admin: first(/admin/i), manager: first(/manager/i), employee: first(/employee/i) };
}

/*
  Deterministic, so every run produces the same set relative to now and a
  screenshot taken on one machine matches another.
*/
let seed = 20261103;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const between = ([low, high]) => Math.round(low + random() * (high - low));

/** Biased towards recent days, as a real log is. */
function occurredAt(now) {
  const daysAgo = Math.floor(random() ** 1.6 * DAYS);
  const at = new Date(now - daysAgo * 86_400_000 - Math.floor(random() * 86_400_000));
  return at > now ? new Date(now - 60_000) : at;
}

/** Same rule as the service: grouped on what failed and where, not on ids. */
const fingerprintOf = (issue) =>
  createHash('sha256')
    .update([issue.source, issue.errorName, issue.routePattern ?? '', issue.key].join('|'))
    .digest('hex');

function rowsFor(issue, users, now) {
  const fingerprint = fingerprintOf(issue);
  const resolver = users.admin;

  return Array.from({ length: issue.count }, () => {
    const at = occurredAt(now);
    const isRequest = issue.source === API || issue.source === CLIENT;
    const resolvedAt = issue.resolved ? new Date(Math.min(now, at.getTime() + 3 * 3_600_000)) : null;

    return {
      requestId: isRequest ? randomUUID() : null,
      occurredAt: at,
      source: issue.source,
      severity: issue.severity,
      httpMethod: issue.httpMethod ?? null,
      routePattern: issue.routePattern ?? null,
      url: issue.url?.replace('{id}', String(between([2, 60]))) ?? null,
      statusCode: issue.statusCode ?? null,
      errorCode: issue.errorCode ?? null,
      errorName: issue.errorName,
      message: issue.message,
      stackTrace: issue.stackTrace ?? null,
      sqlErrorNumber: issue.sqlErrorNumber ?? null,
      requestBody: issue.requestBody ? JSON.stringify(mask(issue.requestBody)) : null,
      employeeDetailId: issue.user ? users[issue.user] : null,
      ipAddress: isRequest ? `10.0.${between([0, 3])}.${between([10, 250])}` : null,
      userAgent: isRequest ? (issue.userAgent ?? (issue.source === API ? 'axios/1.7.7' : BROWSER)) : null,
      durationMs: issue.durationMs ? between(issue.durationMs) : null,
      serverName: SAMPLE_SERVER,
      environment: env.NODE_ENV,
      fingerprint,
      isResolved: Boolean(issue.resolved),
      resolvedBy: issue.resolved ? resolver : null,
      resolvedAt,
      resolutionNote: issue.resolved ?? null,
    };
  });
}

/** The samples show what a stored body looks like: secrets already masked. */
function mask(body) {
  const secret = /password|token|secret|^otp$|pannumber|aadha+rnumber/i;
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, secret.test(key) ? '[REDACTED]' : value]));
}

async function insert(row) {
  const columns = Object.keys(row);
  await mutate(
    `INSERT INTO ${ErrorLog.table} (${columns.map((prop) => ErrorLog.col(prop)).join(', ')})
     VALUES (${columns.map((prop) => `@${prop}`).join(', ')})`,
    ErrorLog.params(row),
  );
}

async function run() {
  if (env.NODE_ENV === 'production') {
    throw new Error('Sample error logs are for development only - refusing to run in production');
  }

  await getPool();

  const removed = await mutate(`DELETE FROM ${ErrorLog.table} WHERE ServerName = @serverName`, ErrorLog.params({ serverName: SAMPLE_SERVER }));
  logger.info(`Removed ${removed} previous sample row(s)`);

  if (process.argv.includes('--clear')) {
    await closePool();
    return;
  }

  const users = await resolveUsers();
  const now = Date.now();
  const rows = ISSUES.flatMap((issue) => rowsFor(issue, users, now)).sort((a, b) => a.occurredAt - b.occurredAt);

  for (const row of rows) await insert(row);

  const bySeverity = rows.reduce((counts, row) => ({ ...counts, [row.severity]: (counts[row.severity] ?? 0) + 1 }), {});
  logger.info(
    `Inserted ${rows.length} sample error log(s) over the last ${DAYS} days across ${ISSUES.length} issues ` +
      `(${Object.entries(bySeverity).map(([severity, count]) => `${count} ${severity}`).join(', ')})`,
  );
  logger.info(`Remove them with: npm run db:seed:errorlogs -- --clear`);

  await closePool();
}

run().catch(async (error) => {
  logger.error('Error log seed failed', error);
  await closePool();
  process.exit(1);
});

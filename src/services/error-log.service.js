/**
 * Writes dbo.tblErrorLog, and purges it.
 *
 * WHAT CALLS IN: the error middleware for every 5xx, 403 and 409; the email
 * worker; the process-level crash handlers and the startup failure path in
 * src/index.js; and POST /error-logs, the frontend reporting its own failures.
 * The rest of this file is what the admin dashboard reads and changes.
 * See db/migrations/012_error_log.sql for what is and is not logged.
 *
 * THE ONE RULE: logging an error must never cause one. The commonest reason
 * for a 500 is the database being unreachable, and then this INSERT fails
 * too - so every failure in here is caught, reported to the console with the
 * entry it was trying to save, and swallowed. Callers do not await it on the
 * request path; the client already has its response.
 */
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { mutate, query, queryOne, querySets, sql } from '../helpers/query.helper.js';
import { ErrorLog } from '../models/index.js';
import { ERROR_LOG_SEVERITY, MESSAGES, ERROR_CODE } from '../enums/index.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/api-error.js';
import { logger } from '../utils/logger.js';

const MAX_BODY_CHARS = 8000;
const MASK = '[REDACTED]';

/*
  Masked wherever they appear in a body or query string, at any depth.
  Matched on the key name: a value cannot be recognised as a secret, but
  every field that carries one is named for it.
*/
const SECRET_KEYS = new Set([
  'otp',
  'resetotp',
  'pannumber',
  'aadharnumber',
  'aadhaarnumber',
  'authorization',
  'cookie',
]);
const SECRET_KEY_PARTS = ['password', 'token', 'secret'];

function isSecretKey(key) {
  const lower = String(key).toLowerCase();
  return SECRET_KEYS.has(lower) || SECRET_KEY_PARTS.some((part) => lower.includes(part));
}

function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[DEPTH]';
  if (Array.isArray(value)) return value.map((each) => redact(each, depth + 1));

  return Object.fromEntries(
    Object.entries(value).map(([key, each]) => [
      key,
      isSecretKey(key) ? MASK : redact(each, depth + 1),
    ]),
  );
}

const cut = (text, max) =>
  text === undefined || text === null ? null : String(text).slice(0, max);

function parseUrl(raw) {
  try {
    return new URL(raw, 'http://local');
  } catch {
    return null;
  }
}

/**
 * The path as called, with any secret query value masked. Host and scheme
 * are dropped, so a page URL the frontend reports lands in the same shape.
 */
export function safeUrl(originalUrl) {
  if (!originalUrl) return null;
  const parsed = parseUrl(originalUrl);
  if (!parsed) return null;
  for (const key of [...parsed.searchParams.keys()]) {
    if (isSecretKey(key)) parsed.searchParams.set(key, MASK);
  }
  return cut(`${parsed.pathname}${parsed.search}`, 1000);
}

/** Just the path of a URL, or null. */
export function pathOf(raw) {
  return raw ? (parseUrl(raw)?.pathname ?? null) : null;
}

export function safeBody(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'object' && Object.keys(body).length === 0) return null;
  try {
    return cut(JSON.stringify(redact(body)), MAX_BODY_CHARS);
  } catch {
    return '[unserialisable body]';
  }
}

/**
 * One bug, one value: what failed, where it was called, and the first frame
 * of the stack. Ids in the URL are not part of it, so the same failure on
 * employee 5 and employee 6 groups together.
 */
function fingerprintOf({ source, errorName, routePattern, stack }) {
  const firstFrame = (stack ?? '').split('\n').find((line) => line.trim().startsWith('at ')) ?? '';
  return createHash('sha256')
    .update([source, errorName ?? '', routePattern ?? '', firstFrame.trim()].join('|'))
    .digest('hex');
}

/*
  Flood guard. A bug on a busy route can fire hundreds of times a minute, and
  a row per hit buries everything else and loads the database that may be the
  thing failing. The first few per fingerprint per minute are written; the
  rest are counted and reported to the console when the window turns over.
*/
const FLOOD_WINDOW_MS = 60_000;
const FLOOD_MAX_PER_WINDOW = 10;
const floodWindows = new Map();

function admit(fingerprint) {
  const now = Date.now();
  const window = floodWindows.get(fingerprint);

  if (!window || now - window.startedAt >= FLOOD_WINDOW_MS) {
    if (window?.suppressed > 0) {
      logger.warn(
        `[error-log] ${window.suppressed} repeat(s) of ${fingerprint.slice(0, 12)} not written in the last minute`,
      );
    }
    // Forget stale fingerprints so the map cannot grow without bound.
    if (floodWindows.size > 1000) floodWindows.clear();
    floodWindows.set(fingerprint, { startedAt: now, written: 1, suppressed: 0 });
    return true;
  }

  if (window.written < FLOOD_MAX_PER_WINDOW) {
    window.written += 1;
    return true;
  }
  window.suppressed += 1;
  return false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVER_NAME = cut(hostname(), 100);

/**
 * Saves one entry. Never throws, never rejects.
 *
 * Resolves to the new ErrorLogId, or null when nothing was written - logging
 * off, a repeat held back by the flood guard, or the write itself failing.
 *
 * @param {object} entry
 * @param {string} entry.source - ERROR_LOG_SOURCE.*
 * @param {string} [entry.severity] - ERROR_LOG_SEVERITY.*, ERROR by default
 * @param {unknown} entry.error - whatever was thrown
 * @param {string} [entry.message] - overrides error.message, for callers with context to add
 * @param {object} [entry.request] - from requestDetails()
 * @param {number} [entry.statusCode]
 */
export async function recordError({ source, severity = ERROR_LOG_SEVERITY.ERROR, error, message, request = {}, statusCode }) {
  if (!env.ERROR_LOG_ENABLED) return null;

  let row;
  try {
    const errorName = error?.name ?? (error === undefined ? null : typeof error);
    const stack = typeof error?.stack === 'string' ? error.stack : null;
    const fingerprint = fingerprintOf({ source, errorName, routePattern: request.routePattern, stack });

    if (!admit(fingerprint)) return null;

    row = {
      requestId: UUID.test(request.requestId ?? '') ? request.requestId : null,
      source,
      severity,
      httpMethod: cut(request.httpMethod, 10),
      routePattern: cut(request.routePattern, 300),
      url: request.url ?? null,
      statusCode: statusCode ?? null,
      errorCode: cut(error?.details?.code, 100),
      errorName: cut(errorName, 200),
      message: cut(message ?? error?.message ?? String(error), 2000),
      stackTrace: stack,
      sqlErrorNumber: Number.isInteger(error?.number) ? error.number : null,
      requestBody: request.requestBody ?? null,
      employeeDetailId: request.employeeDetailId ?? null,
      ipAddress: cut(request.ipAddress, 45),
      userAgent: cut(request.userAgent, 500),
      durationMs: request.durationMs ?? null,
      serverName: SERVER_NAME,
      environment: cut(env.NODE_ENV, 20),
      fingerprint,
    };

    const columns = Object.keys(row);
    const inserted = await queryOne(
      `INSERT INTO ${ErrorLog.table} (${columns.map((prop) => ErrorLog.col(prop)).join(', ')})
       OUTPUT inserted.ErrorLogId AS errorLogId
       VALUES (${columns.map((prop) => `@${prop}`).join(', ')})`,
      ErrorLog.params(row),
    );
    return Number(inserted.errorLogId);
  } catch (writeError) {
    // The console is the last place left. Say what could not be saved.
    logger.error(
      `[error-log] could not write the error log (${writeError?.message}); entry was: ` +
        `${source} ${row?.httpMethod ?? ''} ${row?.url ?? ''} ${row?.statusCode ?? ''} ` +
        `${row?.errorName ?? ''}: ${row?.message ?? error?.message ?? ''}`,
    );
    return null;
  }
}

/**
 * recordError, but gives up after `timeoutMs`. For the paths that exit the
 * process right after: a hung connect must not keep a crashed server alive.
 */
export function recordErrorAndWait(entry, timeoutMs = 3000) {
  return Promise.race([
    recordError(entry),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}

/**
 * The declared route, e.g. /api/v1/employees/:employeeDetailId, so one bug
 * groups across ids. NULL when the request failed before reaching a route.
 *
 * By the time an error reaches the app-level handler, Express has already
 * unwound req.baseUrl to '' and only the router-relative req.route.path is
 * left. The mount path is put back from the URL actually called: everything
 * before the route's own segments.
 */
function routePatternOf(req) {
  const routePath = req.route?.path;
  if (typeof routePath !== 'string') return null;

  const called = (req.originalUrl ?? '').split('?')[0].split('/').filter(Boolean);
  const own = routePath.split('/').filter(Boolean).length;
  const mount = called.slice(0, Math.max(called.length - own, 0));
  return `/${[...mount, ...routePath.split('/').filter(Boolean)].join('/')}`;
}

/**
 * What a request contributes to a log row, secrets masked.
 *
 * @param {import('express').Request} req
 */
export function requestDetails(req) {
  return {
    requestId: req.requestId,
    httpMethod: req.method,
    routePattern: routePatternOf(req),
    url: safeUrl(req.originalUrl),
    requestBody: safeBody(req.body),
    employeeDetailId: Number.isInteger(req.employee?.employeeDetailId) ? req.employee.employeeDetailId : null,
    ipAddress: req.ip,
    userAgent: req.get?.('user-agent'),
    durationMs: req.startedAt ? Math.round(performance.now() - req.startedAt) : null,
  };
}

/**
 * Deletes rows past ERROR_LOG_RETENTION_DAYS, a batch at a time so a large
 * backlog never holds one long lock on the table.
 */
export async function purgeOldErrors() {
  const BATCH = 5000;
  let total = 0;

  for (;;) {
    const removed = await mutate(
      `DELETE TOP (${BATCH}) FROM ${ErrorLog.table}
        WHERE OccurredAt < DATEADD(DAY, -@days, SYSUTCDATETIME())`,
      { days: { type: sql.Int, value: env.ERROR_LOG_RETENTION_DAYS } },
    );
    total += removed;
    if (removed < BATCH) break;
  }

  if (total > 0) logger.info(`[error-log] purged ${total} row(s) older than ${env.ERROR_LOG_RETENTION_DAYS} days`);
  return total;
}

/* -------------------------------------------------------------------------- */
/* The admin dashboard: read, resolve, delete                                 */
/* -------------------------------------------------------------------------- */

/** One row of the list. The stack trace and body are left to the detail call. */
const LIST_COLUMNS = `
  l.ErrorLogId AS errorLogId, l.RequestId AS requestId, l.OccurredAt AS occurredAt,
  l.Source AS source, l.Severity AS severity,
  l.HttpMethod AS httpMethod, l.RoutePattern AS routePattern, l.Url AS url,
  l.StatusCode AS statusCode, l.ErrorCode AS errorCode,
  l.ErrorName AS errorName, l.Message AS message,
  l.EmployeeDetailId AS employeeDetailId,
  NULLIF(CONCAT_WS(' ', e.FirstName, e.LastName), '') AS employeeName,
  l.DurationMs AS durationMs, l.ServerName AS serverName, l.Environment AS environment,
  l.Fingerprint AS fingerprint, l.IsResolved AS isResolved, l.ResolvedAt AS resolvedAt`;

/** Everything, for the detail screen. */
const DETAIL_COLUMNS = `${LIST_COLUMNS},
  l.StackTrace AS stackTrace, l.SqlErrorNumber AS sqlErrorNumber,
  l.RequestBody AS requestBody, l.IpAddress AS ipAddress, l.UserAgent AS userAgent,
  l.ResolvedBy AS resolvedBy,
  NULLIF(CONCAT_WS(' ', r.FirstName, r.LastName), '') AS resolvedByName,
  l.ResolutionNote AS resolutionNote`;

/*
  Plain joins on the employee table, with no DeletedAt filter: a log row
  names whoever was calling at the time, and that stays true after the
  employee record is deleted.
*/
const FROM_LOG = `
  FROM ${ErrorLog.table} AS l
  LEFT JOIN dbo.tblEmployeeDetails AS e ON e.EmployeeDetailId = l.EmployeeDetailId
  LEFT JOIN dbo.tblEmployeeDetails AS r ON r.EmployeeDetailId = l.ResolvedBy`;

/** BIGINT ids come back from the driver as strings. */
function shapeRow(row) {
  const shaped = { ...row };
  for (const prop of ['errorLogId', 'employeeDetailId', 'resolvedBy']) {
    if (shaped[prop] !== null && shaped[prop] !== undefined) shaped[prop] = Number(shaped[prop]);
  }
  // SQL Server hands a UNIQUEIDENTIFIER back in upper case. The header and
  // the error body send it in lower case, so match what the user quotes.
  if (typeof shaped.requestId === 'string') shaped.requestId = shaped.requestId.toLowerCase();
  // Stored as masked JSON text; handed back as the object it was.
  if (typeof shaped.requestBody === 'string') {
    try {
      shaped.requestBody = JSON.parse(shaped.requestBody);
    } catch {
      // Cut at 8 KB, so it may no longer parse. The text is still useful.
    }
  }
  return shaped;
}

/** `%`, `_` and `[` typed into a search box mean themselves, not wildcards. */
const likeContains = (text) => `%${text.replace(/[[%_]/g, '[$&]')}%`;

/** From the start of a YYYY-MM-DD `from` to the end of a YYYY-MM-DD `to`, both UTC. */
function addDateRange(where, bound, { from, to }) {
  if (from) {
    where.push('l.OccurredAt >= @from');
    bound.from = { type: sql.Date, value: from };
  }
  if (to) {
    where.push('l.OccurredAt < DATEADD(DAY, 1, CAST(@to AS DATETIME2(3)))');
    bound.to = { type: sql.Date, value: to };
  }
}

/** One fingerprint's rows, or only the row itself. */
const targetRows = (allOccurrences) =>
  allOccurrences
    ? `(ErrorLogId = @errorLogId
        OR Fingerprint = (SELECT Fingerprint FROM ${ErrorLog.table} WHERE ErrorLogId = @errorLogId))`
    : 'ErrorLogId = @errorLogId';

const FILTER_PROPS = Object.freeze([
  'source',
  'severity',
  'statusCode',
  'isResolved',
  'errorCode',
  'fingerprint',
  'employeeDetailId',
  'requestId',
]);

/**
 * A page of log rows, newest first.
 *
 * @param {object} filters - validated by the controller; page and pageSize always set
 */
export async function listErrorLogs(filters) {
  const where = ['1 = 1'];
  const bound = {};

  addDateRange(where, bound, filters);

  for (const prop of FILTER_PROPS) {
    if (filters[prop] !== undefined) {
      where.push(`l.${ErrorLog.col(prop)} = @${prop}`);
      bound[prop] = ErrorLog.param(prop, filters[prop]);
    }
  }

  if (filters.statusGroup) {
    // '4xx' or '5xx': the two halves of the dashboard. A fixed literal from
    // a validated oneOf, not user text.
    const floor = filters.statusGroup === '5xx' ? 500 : 400;
    where.push(`l.StatusCode >= ${floor} AND l.StatusCode < ${floor + 100}`);
  }

  if (filters.search) {
    where.push(`(l.Message LIKE @search OR l.RoutePattern LIKE @search
                 OR l.Url LIKE @search OR l.ErrorName LIKE @search)`);
    bound.search = { type: sql.NVarChar(2000), value: likeContains(filters.search) };
  }

  const rows = await query(
    `SELECT ${LIST_COLUMNS}, COUNT(*) OVER() AS totalCount
     ${FROM_LOG}
      WHERE ${where.join(' AND ')}
      ORDER BY l.OccurredAt DESC, l.ErrorLogId DESC
     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    {
      ...bound,
      offset: { type: sql.Int, value: (filters.page - 1) * filters.pageSize },
      pageSize: { type: sql.Int, value: filters.pageSize },
    },
  );

  // COUNT(*) OVER() is on every row and belongs on none of them.
  const total = rows.length > 0 ? rows[0].totalCount : 0;

  return {
    errorLogs: rows.map(({ totalCount, ...rest }) => shapeRow(rest)),
    meta: {
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      totalPages: Math.ceil(total / filters.pageSize),
    },
  };
}

const notFound = () =>
  ApiError.notFound(MESSAGES.ERROR_LOG_NOT_FOUND, { code: ERROR_CODE.ERROR_LOG_NOT_FOUND });

/**
 * One row in full, plus how often the same failure (its fingerprint) has
 * happened - the first thing anyone asks on seeing it.
 */
export async function getErrorLog(errorLogId) {
  const row = await queryOne(
    `SELECT ${DETAIL_COLUMNS},
            o.occurrences, o.firstSeen, o.lastSeen
     ${FROM_LOG}
      OUTER APPLY (
        SELECT COUNT(*) AS occurrences, MIN(s.OccurredAt) AS firstSeen, MAX(s.OccurredAt) AS lastSeen
          FROM ${ErrorLog.table} AS s
         WHERE s.Fingerprint = l.Fingerprint
      ) AS o
      WHERE l.ErrorLogId = @errorLogId`,
    { errorLogId: ErrorLog.param('errorLogId', errorLogId) },
  );

  if (!row) throw notFound();
  return shapeRow(row);
}

/**
 * Marks a row resolved or open again, with a note.
 *
 * PUT semantics: the note sent replaces the stored one, and leaving it out
 * clears it. With `applyToAllOccurrences`, every row sharing the fingerprint
 * gets the same treatment - one fix closes every copy of one bug.
 *
 * @returns {Promise<object>} the updated row, plus affectedRows
 */
export async function updateErrorLog(
  actorId,
  errorLogId,
  { isResolved, resolutionNote = null, applyToAllOccurrences = false },
) {
  const affectedRows = await mutate(
    `UPDATE ${ErrorLog.table}
        SET IsResolved = @isResolved,
            ResolvedBy = CASE WHEN @isResolved = 1 THEN @actorId END,
            ResolvedAt = CASE WHEN @isResolved = 1 THEN SYSUTCDATETIME() END,
            ResolutionNote = @resolutionNote
      WHERE ${targetRows(applyToAllOccurrences)}`,
    {
      ...ErrorLog.params({ errorLogId, isResolved, resolutionNote }),
      actorId: ErrorLog.param('resolvedBy', actorId),
    },
  );

  if (affectedRows === 0) throw notFound();
  return { ...(await getErrorLog(errorLogId)), affectedRows };
}

/**
 * Removes a row for good - the log has no soft delete. With
 * `allOccurrences`, every row sharing its fingerprint goes too.
 */
export async function deleteErrorLog(errorLogId, { allOccurrences = false } = {}) {
  const deletedCount = await mutate(
    `DELETE FROM ${ErrorLog.table} WHERE ${targetRows(allOccurrences)}`,
    { errorLogId: ErrorLog.param('errorLogId', errorLogId) },
  );

  if (deletedCount === 0) throw notFound();
  return { errorLogId, deletedCount };
}

const TOP_ISSUES = 10;

/**
 * The dashboard's numbers for a date range, in one round trip: totals, a
 * split by source and by status, a day-by-day series, and the failures that
 * happen most (grouped by fingerprint) with their latest example.
 */
export async function summarizeErrorLogs(range) {
  const where = ['1 = 1'];
  const bound = {};
  addDateRange(where, bound, range);
  const scope = where.join(' AND ');

  const [[totals], bySource, byStatusCode, daily, topIssues] = await querySets(
    `SELECT COUNT(*) AS total,
            ISNULL(SUM(CASE WHEN l.IsResolved = 0 THEN 1 ELSE 0 END), 0) AS unresolved,
            ISNULL(SUM(CASE WHEN l.Severity = 'WARN' THEN 1 ELSE 0 END), 0) AS warn,
            ISNULL(SUM(CASE WHEN l.Severity = 'ERROR' THEN 1 ELSE 0 END), 0) AS error,
            ISNULL(SUM(CASE WHEN l.Severity = 'FATAL' THEN 1 ELSE 0 END), 0) AS fatal
       FROM ${ErrorLog.table} AS l WHERE ${scope};

     SELECT l.Source AS source, COUNT(*) AS count
       FROM ${ErrorLog.table} AS l WHERE ${scope}
      GROUP BY l.Source ORDER BY count DESC;

     SELECT l.StatusCode AS statusCode, COUNT(*) AS count
       FROM ${ErrorLog.table} AS l WHERE ${scope} AND l.StatusCode IS NOT NULL
      GROUP BY l.StatusCode ORDER BY count DESC;

     SELECT CONVERT(CHAR(10), CAST(l.OccurredAt AS DATE), 23) AS date,
            COUNT(*) AS total,
            SUM(CASE WHEN l.Severity = 'WARN' THEN 1 ELSE 0 END) AS warn,
            SUM(CASE WHEN l.Severity <> 'WARN' THEN 1 ELSE 0 END) AS error
       FROM ${ErrorLog.table} AS l WHERE ${scope}
      GROUP BY CAST(l.OccurredAt AS DATE) ORDER BY date;

     WITH ranked AS (
       SELECT l.*,
              ROW_NUMBER() OVER (PARTITION BY l.Fingerprint ORDER BY l.OccurredAt DESC, l.ErrorLogId DESC) AS rn,
              COUNT(*) OVER (PARTITION BY l.Fingerprint) AS occurrences,
              SUM(CASE WHEN l.IsResolved = 0 THEN 1 ELSE 0 END) OVER (PARTITION BY l.Fingerprint) AS unresolvedCount,
              MIN(l.OccurredAt) OVER (PARTITION BY l.Fingerprint) AS firstSeen
         FROM ${ErrorLog.table} AS l WHERE ${scope} AND l.Fingerprint IS NOT NULL
     )
     SELECT TOP (${TOP_ISSUES})
            Fingerprint AS fingerprint, occurrences, unresolvedCount AS unresolved, firstSeen,
            OccurredAt AS lastSeen, ErrorLogId AS latestErrorLogId,
            Source AS source, Severity AS severity, StatusCode AS statusCode,
            HttpMethod AS httpMethod, RoutePattern AS routePattern,
            ErrorName AS errorName, ErrorCode AS errorCode, Message AS message
       FROM ranked WHERE rn = 1
      ORDER BY occurrences DESC, lastSeen DESC;`,
    bound,
  );

  return {
    range: { from: range.from ?? null, to: range.to ?? null },
    totals: {
      total: totals.total,
      unresolved: totals.unresolved,
      bySeverity: { WARN: totals.warn, ERROR: totals.error, FATAL: totals.fatal },
    },
    bySource,
    byStatusCode,
    daily,
    topIssues: topIssues.map((issue) => ({ ...issue, latestErrorLogId: Number(issue.latestErrorLogId) })),
  };
}


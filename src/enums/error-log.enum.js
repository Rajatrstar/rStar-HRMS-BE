/**
 * Values of dbo.tblErrorLog.Source and .Severity. Mirrors the CHECK
 * constraints in db/migrations/013_error_log_client_and_warn.sql.
 */
export const ERROR_LOG_SOURCE = Object.freeze({
  /** A request that answered 5xx, 403 or 409. */
  API: 'API',
  /** A background job: the email outbox, the log purge. */
  JOB: 'JOB',
  /** An uncaught exception or unhandled rejection. */
  PROCESS: 'PROCESS',
  /** The server failed to boot. */
  STARTUP: 'STARTUP',
  /** Reported by the frontend through POST /error-logs. */
  CLIENT: 'CLIENT',
});

export const ERROR_LOG_SEVERITY = Object.freeze({
  /** The client's side of the line: 403, 409. */
  WARN: 'WARN',
  /** The server's own fault, or a frontend crash. */
  ERROR: 'ERROR',
  /** The process is about to exit because of it. */
  FATAL: 'FATAL',
});

/**
 * The 4xx statuses written to the log alongside every 5xx. A 403 is somebody
 * reaching for something they may not have - worth seeing in aggregate. A 409
 * is a rule refusing a write. The rest of 4xx (bad field, no token, unknown
 * route) is ordinary traffic and stays out.
 */
export const LOGGED_CLIENT_STATUSES = Object.freeze([403, 409]);

/** The response header, and the incoming one a proxy or client may set. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

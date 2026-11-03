/**
 * Error log controller: the admin dashboard's endpoints, and the one the
 * frontend reports its own failures through. Validate, call the service,
 * shape the reply - no SQL here.
 */
import * as errorLogService from '../services/error-log.service.js';
import { sendSuccess } from '../helpers/response.helper.js';
import { validateBody, validateParams } from '../helpers/validation.helper.js';
import { ApiError } from '../utils/api-error.js';
import {
  HTTP_STATUS,
  MESSAGES,
  ERROR_LOG_SOURCE,
  ERROR_LOG_SEVERITY,
} from '../enums/index.js';

const values = (enumObject) => Object.freeze(Object.values(enumObject));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERROR_LOG_PARAM = { errorLogId: { required: true, integer: true } };

const RANGE_RULES = {
  from: { date: true },
  to: { date: true },
};

const LIST_RULES = {
  ...RANGE_RULES,
  page: { integer: true, min: 1 },
  pageSize: { integer: true, min: 1 },
  source: { oneOf: values(ERROR_LOG_SOURCE) },
  severity: { oneOf: values(ERROR_LOG_SEVERITY) },
  statusCode: { integer: true, min: 100 },
  statusGroup: { oneOf: ['4xx', '5xx'] },
  isResolved: { boolean: true },
  errorCode: { maxLength: 100 },
  fingerprint: { maxLength: 64 },
  employeeDetailId: { integer: true },
  requestId: { maxLength: 36 },
  search: { maxLength: 200 },
};

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const DEFAULT_SUMMARY_DAYS = 7;

/** A YYYY-MM-DD in UTC, `daysAgo` days back from today. */
const utcDate = (daysAgo = 0) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

/** from <= to, and a request id that is a UUID. Both answer like field errors. */
function checkFilters(filters) {
  const errors = {};
  // YYYY-MM-DD compares correctly as text.
  if (filters.from && filters.to && filters.from > filters.to) {
    errors.from = MESSAGES.ERROR_LOG_DATE_RANGE;
  }
  if (filters.requestId && !UUID.test(filters.requestId)) {
    errors.requestId = 'Request id must be a UUID';
  }
  if (Object.keys(errors).length > 0) {
    throw ApiError.badRequest(MESSAGES.VALIDATION_FAILED, errors);
  }
  return filters;
}

/** GET /api/v1/error-logs */
export async function list(req, res) {
  const filters = checkFilters(validateParams(req.query, LIST_RULES));

  const { errorLogs, meta } = await errorLogService.listErrorLogs({
    ...filters,
    page: filters.page ?? 1,
    pageSize: Math.min(filters.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  });

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.ERROR_LOGS_FETCHED,
    data: errorLogs,
    meta,
  });
}

/** GET /api/v1/error-logs/summary - the last 7 days unless a range is given. */
export async function summary(req, res) {
  const range = checkFilters(validateParams(req.query, RANGE_RULES));

  const data = await errorLogService.summarizeErrorLogs({
    from: range.from ?? (range.to ? undefined : utcDate(DEFAULT_SUMMARY_DAYS - 1)),
    to: range.to ?? (range.from ? undefined : utcDate()),
  });

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.ERROR_LOG_SUMMARY_FETCHED,
    data,
  });
}

/** GET /api/v1/error-logs/:errorLogId */
export async function detail(req, res) {
  const { errorLogId } = validateParams(req.params, ERROR_LOG_PARAM);
  const data = await errorLogService.getErrorLog(errorLogId);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.ERROR_LOG_FETCHED, data });
}

const UPDATE_RULES = {
  isResolved: { required: true, boolean: true },
  resolutionNote: { maxLength: 1000 },
  applyToAllOccurrences: { boolean: true },
};

/** PUT /api/v1/error-logs/:errorLogId - resolve or reopen, with a note. */
export async function update(req, res) {
  const { errorLogId } = validateParams(req.params, ERROR_LOG_PARAM);
  const body = validateBody(req.body, UPDATE_RULES);

  const data = await errorLogService.updateErrorLog(req.employee.employeeDetailId, errorLogId, body);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.ERROR_LOG_UPDATED, data });
}

const DELETE_RULES = { allOccurrences: { boolean: true } };

/** DELETE /api/v1/error-logs/:errorLogId[?allOccurrences=true] */
export async function remove(req, res) {
  const { errorLogId } = validateParams(req.params, ERROR_LOG_PARAM);
  const options = validateParams(req.query, DELETE_RULES);

  const data = await errorLogService.deleteErrorLog(errorLogId, options);

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.ERROR_LOG_DELETED, data });
}

/*
  What the frontend may report. Severity is WARN or ERROR only: FATAL means
  the server process died, which a browser cannot know. The stack trace is
  not trimmed - leading spaces are how a stack is read.
*/
const REPORT_RULES = {
  message: { required: true, maxLength: 2000 },
  errorName: { maxLength: 200 },
  stackTrace: { maxLength: 20000, trim: false },
  pageUrl: { maxLength: 1000 },
  route: { maxLength: 300 },
  severity: { oneOf: [ERROR_LOG_SEVERITY.WARN, ERROR_LOG_SEVERITY.ERROR] },
};

/**
 * POST /api/v1/error-logs - the frontend reporting its own failure.
 *
 * Any signed-in user may call it: the screens that crash are not only the
 * admin's. Who reported it, from where and with what browser comes from the
 * request, never the body. `context` is free-form JSON (the screen's state,
 * the API call that failed), masked like any request body before it is kept.
 *
 * 201 with the new id, or errorLogId null when the same failure has already
 * been reported ten times this minute and this copy was only counted.
 */
export async function report(req, res) {
  const body = validateBody(req.body, REPORT_RULES);

  const { context } = req.body ?? {};
  if (context !== undefined && (context === null || typeof context !== 'object' || Array.isArray(context))) {
    throw ApiError.badRequest(MESSAGES.VALIDATION_FAILED, { context: 'Context must be a JSON object' });
  }

  const request = errorLogService.requestDetails(req);

  const errorLogId = await errorLogService.recordError({
    source: ERROR_LOG_SOURCE.CLIENT,
    severity: body.severity ?? ERROR_LOG_SEVERITY.ERROR,
    error: { name: body.errorName ?? 'Error', message: body.message, stack: body.stackTrace ?? null },
    request: {
      ...request,
      // The screen, not this endpoint: that is what groups one frontend bug.
      httpMethod: null,
      routePattern: body.route ?? errorLogService.pathOf(body.pageUrl),
      url: body.pageUrl ? errorLogService.safeUrl(body.pageUrl) : null,
      requestBody: errorLogService.safeBody(context),
      durationMs: null,
    },
  });

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.ERROR_LOG_REPORTED,
    data: { errorLogId, requestId: req.requestId },
  });
}


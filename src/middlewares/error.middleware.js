/**
 * The last middleware in the chain. Express 5 forwards rejected promises from
 * async handlers here automatically, so controllers can just `throw`.
 *
 * An ApiError is deliberate and its message is shown to the client. Anything
 * else is a bug: it is logged in full and reported as a generic 500, so stack
 * traces and driver messages never leak.
 */
import {
  HTTP_STATUS,
  MESSAGES,
  ERROR_LOG_SOURCE,
  ERROR_LOG_SEVERITY,
  LOGGED_CLIENT_STATUSES,
} from '../enums/index.js';
import { recordError, requestDetails } from '../services/error-log.service.js';
import { sendError } from '../helpers/response.helper.js';
import { ApiError } from '../utils/api-error.js';
import { logger } from '../utils/logger.js';
import { isProduction } from '../config/env.js';

/**
 * express.json() rejects an unparseable body with a SyntaxError that already
 * carries status 400. Without this it falls through as an unexpected error and
 * a client typo is reported as a server fault - and logged with a stack trace.
 */
function isBodyParseFailure(error) {
  return error?.type === 'entity.parse.failed';
}

// eslint-disable-next-line no-unused-vars -- Express needs all four args to see this as an error handler.
export function errorHandler(error, req, res, next) {
  const isKnown = error instanceof ApiError || isBodyParseFailure(error);

  let statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR;
  let message = MESSAGES.INTERNAL_ERROR;

  if (error instanceof ApiError) {
    statusCode = error.statusCode;
    message = error.message;
  } else if (isBodyParseFailure(error)) {
    statusCode = HTTP_STATUS.BAD_REQUEST;
    message = MESSAGES.MALFORMED_JSON;
  }

  const isServerFault = statusCode >= HTTP_STATUS.INTERNAL_SERVER_ERROR;

  if (!isKnown || isServerFault) {
    logger.error(`${req.method} ${req.originalUrl} failed [${req.requestId}]`, error);
  }

  let details = isBodyParseFailure(error)
    ? { reason: error.message }
    : isKnown
      ? error.details
      : isProduction
        ? undefined
        : { name: error.name, message: error.message };

  /*
    Kept in dbo.tblErrorLog: every 5xx (the server's fault, ERROR) and the
    4xx in LOGGED_CLIENT_STATUSES - 403 and 409 - as WARN. The rest of 4xx
    is ordinary traffic. A logged failure hands the client the row's id to
    quote. Not awaited: the response does not wait on the log, and
    recordError never rejects.
  */
  if (isServerFault || LOGGED_CLIENT_STATUSES.includes(statusCode)) {
    details = { ...(details ?? {}), requestId: req.requestId };
    void recordError({
      source: ERROR_LOG_SOURCE.API,
      severity: isServerFault ? ERROR_LOG_SEVERITY.ERROR : ERROR_LOG_SEVERITY.WARN,
      error,
      statusCode,
      request: requestDetails(req),
    });
  }

  return sendError(res, { statusCode, message, details });
}

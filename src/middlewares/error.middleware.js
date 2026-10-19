/**
 * The last middleware in the chain. Express 5 forwards rejected promises from
 * async handlers here automatically, so controllers can just `throw`.
 *
 * An ApiError is deliberate and its message is shown to the client. Anything
 * else is a bug: it is logged in full and reported as a generic 500, so stack
 * traces and driver messages never leak.
 */
import { HTTP_STATUS, MESSAGES } from '../enums/index.js';
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

  if (!isKnown || statusCode >= HTTP_STATUS.INTERNAL_SERVER_ERROR) {
    logger.error(`${req.method} ${req.originalUrl} failed`, error);
  }

  const details = isBodyParseFailure(error)
    ? { reason: error.message }
    : isKnown
      ? error.details
      : isProduction
        ? undefined
        : { name: error.name, message: error.message };

  return sendError(res, { statusCode, message, details });
}

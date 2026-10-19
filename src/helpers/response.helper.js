/**
 * One response envelope for the whole API, so clients can parse every reply
 * the same way. Controllers call these instead of res.json directly.
 *
 * Every reply, success or failure, has exactly these keys:
 *
 *   { success, statusCode, message, data }
 *
 * plus `meta` on a success that paginates and `details` on a failure that has
 * field-level information. `data` is null rather than absent when there is
 * nothing to return, so a client can read `body.data` without a guard.
 *
 * `success` is derived from `statusCode`, never passed in: the two cannot drift
 * apart and report a 503 as a success.
 */
import { HTTP_STATUS, MESSAGES } from '../enums/index.js';

/** True for 1xx-3xx. The one place the success flag is decided. */
function isSuccessStatus(statusCode) {
  return statusCode < HTTP_STATUS.BAD_REQUEST;
}

/**
 * @param {import('express').Response} res
 * @param {object} [options]
 * @param {number} [options.statusCode] - from HTTP_STATUS, never a literal
 * @param {string} [options.message] - from MESSAGES, never a literal
 * @param {unknown} [options.data]
 * @param {object} [options.meta] - pagination and the like
 */
export function sendSuccess(
  res,
  { statusCode = HTTP_STATUS.OK, message = MESSAGES.SUCCESS, data = null, meta } = {},
) {
  const body = { success: isSuccessStatus(statusCode), statusCode, message, data };
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
}

/**
 * @param {import('express').Response} res
 * @param {object} options
 * @param {number} [options.statusCode] - from HTTP_STATUS, never a literal
 * @param {string} [options.message] - from MESSAGES, never a literal
 * @param {unknown} [options.details] - field-level errors; omitted when absent
 */
export function sendError(
  res,
  { statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR, message = MESSAGES.INTERNAL_ERROR, details } = {},
) {
  const body = { success: isSuccessStatus(statusCode), statusCode, message, data: null };
  if (details !== undefined) body.details = details;
  return res.status(statusCode).json(body);
}

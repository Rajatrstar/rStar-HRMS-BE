/**
 * One response envelope for the whole API, so clients can parse every reply
 * the same way. Controllers call these instead of res.json directly.
 */
import { HTTP_STATUS } from '../enums/index.js';

/**
 * @param {import('express').Response} res
 * @param {object} [options]
 * @param {number} [options.statusCode]
 * @param {string} [options.message]
 * @param {unknown} [options.data]
 * @param {object} [options.meta] - pagination and the like
 */
export function sendSuccess(res, { statusCode = HTTP_STATUS.OK, message = 'Success', data = null, meta } = {}) {
  const body = { success: true, message, data };
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
}

/**
 * @param {import('express').Response} res
 * @param {object} options
 * @param {number} options.statusCode
 * @param {string} options.message
 * @param {unknown} [options.details] - field-level errors; omitted when absent
 */
export function sendError(res, { statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR, message, details }) {
  const body = { success: false, message, data: null };
  if (details !== undefined) body.details = details;
  return res.status(statusCode).json(body);
}

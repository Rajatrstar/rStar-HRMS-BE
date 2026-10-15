/**
 * Runs when no route matched. Without it Express replies with an HTML error
 * page, which breaks clients that always parse JSON.
 */
import { HTTP_STATUS, MESSAGES } from '../enums/index.js';
import { sendError } from '../helpers/response.helper.js';

export function notFoundHandler(req, res) {
  return sendError(res, {
    statusCode: HTTP_STATUS.NOT_FOUND,
    message: MESSAGES.ROUTE_NOT_FOUND,
    details: { method: req.method, path: req.originalUrl },
  });
}

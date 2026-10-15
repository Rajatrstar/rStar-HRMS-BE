import { HTTP_STATUS } from '../enums/index.js';

/**
 * An error with an HTTP status attached. Anything thrown that is NOT an
 * ApiError is treated by the error middleware as an unexpected 500, so its
 * message never reaches the client.
 */
export class ApiError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} message - safe to show a client
   * @param {unknown} [details] - field errors or similar
   */
  constructor(statusCode, message, details) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
    // Marks this as a deliberate, client-safe failure.
    this.isOperational = true;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message, details) {
    return new ApiError(HTTP_STATUS.BAD_REQUEST, message, details);
  }

  static unauthorized(message) {
    return new ApiError(HTTP_STATUS.UNAUTHORIZED, message);
  }

  static forbidden(message) {
    return new ApiError(HTTP_STATUS.FORBIDDEN, message);
  }

  static notFound(message) {
    return new ApiError(HTTP_STATUS.NOT_FOUND, message);
  }

  static conflict(message) {
    return new ApiError(HTTP_STATUS.CONFLICT, message);
  }

  static internal(message) {
    return new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, message);
  }
}

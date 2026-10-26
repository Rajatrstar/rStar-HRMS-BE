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

  // These three take `details` because an access-control failure is far more
  // actionable with the permission code attached than without it. Note the
  // deliberate asymmetry at the call sites: a 403 names what was required, a
  // 404 says nothing - attaching the reason there would undo the whole point
  // of answering 404 for a row outside the caller's scope.
  static forbidden(message, details) {
    return new ApiError(HTTP_STATUS.FORBIDDEN, message, details);
  }

  static notFound(message, details) {
    return new ApiError(HTTP_STATUS.NOT_FOUND, message, details);
  }

  static conflict(message, details) {
    return new ApiError(HTTP_STATUS.CONFLICT, message, details);
  }

  /** The body parsed and the fields are well formed, but the combination is not. */
  static unprocessable(message, details) {
    return new ApiError(HTTP_STATUS.UNPROCESSABLE_ENTITY, message, details);
  }

  static internal(message) {
    return new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, message);
  }
}

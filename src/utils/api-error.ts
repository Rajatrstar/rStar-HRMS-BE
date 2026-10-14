import { HttpStatus } from '../enums.js';

/**
 * An error the API meant to produce, as opposed to a crash.
 *
 * The error handler trusts `message` on these and returns it to the client; anything that
 * is *not* an ApiError is treated as a bug and reported as a generic 500, so never throw a
 * raw Error with a message you would not want a stranger to read.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly details: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, ApiError);
  }

  static badRequest(message = 'Bad request', details?: unknown): ApiError {
    return new ApiError(HttpStatus.BAD_REQUEST, message, details);
  }

  static unauthorized(message = 'Authentication required'): ApiError {
    return new ApiError(HttpStatus.UNAUTHORIZED, message);
  }

  static forbidden(message = 'You do not have permission to perform this action'): ApiError {
    return new ApiError(HttpStatus.FORBIDDEN, message);
  }

  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError(HttpStatus.NOT_FOUND, message);
  }

  static conflict(message = 'Resource already exists'): ApiError {
    return new ApiError(HttpStatus.CONFLICT, message);
  }

  static unprocessable(message = 'Validation failed', details?: unknown): ApiError {
    return new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, message, details);
  }

  static tooManyRequests(message = 'Too many requests'): ApiError {
    return new ApiError(HttpStatus.TOO_MANY_REQUESTS, message);
  }
}

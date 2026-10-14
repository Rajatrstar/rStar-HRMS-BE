import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isProduction } from '../config/env.js';
import { getLogger } from '../config/logger.js';
import { Prisma } from '../generated/prisma/client.js';
import { HttpStatus } from '../enums.js';
import { ApiError } from '../utils/api-error.js';

/** Terminates unmatched routes as a JSON 404 rather than Express's default HTML page. */
export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

interface NormalisedError {
  statusCode: number;
  message: string;
  details?: unknown;
}

/**
 * The single place an error turns into a response. Anything it does not recognise becomes a
 * generic 500 - an unrecognised error is a bug, and bug messages leak internals.
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Express cannot change the status once the response has started streaming.
  if (res.headersSent) {
    next(error);
    return;
  }

  const { statusCode, message, details } = normalise(error);
  const log = getLogger();

  if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
    log.error({ err: error }, 'Unhandled error');
  } else {
    log.warn({ err: error, statusCode }, message);
  }

  res.status(statusCode).json({
    success: false,
    requestId: res.req.id,
    error: {
      message,
      ...(details ? { details } : {}),
      ...(isProduction || !(error instanceof Error) ? {} : { stack: error.stack }),
    },
  });
}

function normalise(error: unknown): NormalisedError {
  if (error instanceof ApiError) {
    return { statusCode: error.statusCode, message: error.message, details: error.details };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      message: 'Validation failed',
      details: error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return normalisePrisma(error);
  }

  // Body-parser rejections (malformed JSON, payload over the size limit).
  if (error instanceof SyntaxError && 'body' in error) {
    return { statusCode: HttpStatus.BAD_REQUEST, message: 'Malformed JSON body' };
  }
  if (isPayloadTooLarge(error)) {
    return { statusCode: HttpStatus.BAD_REQUEST, message: 'Request body too large' };
  }

  return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
}

function normalisePrisma(error: Prisma.PrismaClientKnownRequestError): NormalisedError {
  switch (error.code) {
    case 'P2002': {
      const target = (error.meta?.['target'] as string[] | string | undefined) ?? 'field';
      const fields = Array.isArray(target) ? target.join(', ') : target;
      return {
        statusCode: HttpStatus.CONFLICT,
        message: `A record with this ${fields} already exists`,
      };
    }
    case 'P2025':
      return { statusCode: HttpStatus.NOT_FOUND, message: 'Resource not found' };
    case 'P2003':
      return { statusCode: HttpStatus.BAD_REQUEST, message: 'Referenced record does not exist' };
    default:
      return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
  }
}

function isPayloadTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.too.large'
  );
}

import type { Response } from 'express';
import { HttpStatus } from '../enums.js';

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Every successful response has the same envelope, so clients parse one shape.
 * Failures are produced exclusively by the error handler and mirror it with `success: false`.
 */
export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode: number = HttpStatus.OK,
  meta?: PaginationMeta,
): void {
  res.status(statusCode).json({
    success: true,
    requestId: res.req.id,
    ...(meta ? { meta } : {}),
    data,
  });
}

export interface PaginationParams {
  page: number;
  limit: number;
}

export function toPrismaPagination({ page, limit }: PaginationParams): {
  skip: number;
  take: number;
} {
  return { skip: (page - 1) * limit, take: limit };
}

export function buildPaginationMeta(
  { page, limit }: PaginationParams,
  total: number,
): PaginationMeta {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

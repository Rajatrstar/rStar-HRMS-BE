import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { ZodType } from 'zod';
import { env } from '../config/env.js';
import { logger, runWithContext } from '../config/logger.js';
import { HttpStatus } from '../enums.js';

/* -------------------------------------------------------------------------- */
/* Request context                                                            */
/* -------------------------------------------------------------------------- */

/** Max length accepted from a client-supplied id, to keep logs from being flooded. */
const MAX_INBOUND_ID_LENGTH = 64;
const SAFE_ID = /^[\w-]+$/;

/**
 * Gives every request a correlation id, echoes it on the response, and binds a child
 * logger for the lifetime of the request. An inbound `x-request-id` is honoured so a trace
 * survives across services - but only after validation, since it lands in logs.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers['x-request-id'];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const requestId =
    candidate && candidate.length <= MAX_INBOUND_ID_LENGTH && SAFE_ID.test(candidate)
      ? candidate
      : randomUUID();

  req.id = requestId;
  res.setHeader('x-request-id', requestId);

  const requestLogger = logger.child({ requestId });

  runWithContext({ requestId, logger: requestLogger }, () => {
    res.on('finish', () => {
      requestLogger.info(
        { method: req.method, path: req.originalUrl, status: res.statusCode, ip: req.ip },
        'request completed',
      );
    });
    next();
  });
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export interface RequestSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Parses the request against zod schemas and replaces each section with the parsed result,
 * so handlers only ever see validated, type-coerced data with unknown keys stripped.
 *
 * Failures throw a ZodError, which the error handler renders as a 422 with field detail.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (schemas.params) {
      req.params = schemas.params.parse(req.params) as typeof req.params;
    }
    if (schemas.query) {
      // Express 5 makes req.query a getter-only property, so it cannot be reassigned.
      Object.defineProperty(req, 'query', {
        value: schemas.query.parse(req.query),
        configurable: true,
        writable: true,
      });
    }
    if (schemas.body) {
      req.body = schemas.body.parse(req.body);
    }
    next();
  };
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

const sharedOptions = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { message: 'Too many requests, please try again later' } },
  statusCode: HttpStatus.TOO_MANY_REQUESTS,
} as const;

/** Blanket limit applied to the whole API. */
export const globalRateLimiter = rateLimit({
  ...sharedOptions,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
});

/**
 * Tighter limit for credential endpoints, keyed on IP *and* the submitted email so one
 * attacker cannot lock out a whole office NAT, and rotating IPs cannot grind one account.
 */
export const authRateLimiter = rateLimit({
  ...sharedOptions,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  keyGenerator: (req: Request): string => `${ipKeyGenerator(req.ip ?? '')}:${submittedEmail(req)}`,
});

/** The login body is not validated yet at this point in the chain, so it is read defensively. */
function submittedEmail(req: Request): string {
  const body: unknown = req.body;
  if (typeof body === 'object' && body !== null && 'email' in body) {
    const email: unknown = (body as Record<string, unknown>)['email'];
    if (typeof email === 'string') {
      return email.toLowerCase().slice(0, 190);
    }
  }
  return 'anonymous';
}

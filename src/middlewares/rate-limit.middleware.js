/**
 * Rate limiting, in three tiers.
 *
 *   apiLimiter         per IP, every endpoint       - floods and scrapers
 *   authLimiter        per IP, /auth only           - the endpoints worth attacking
 *   credentialLimiter  per ACCOUNT, failed attempts - password and OTP guessing
 *   otpSendLimiter     per ACCOUNT, every request   - mail bombing and cost
 *
 * Why two per-account tiers rather than one more IP tier: an IP limit is
 * trivially sidestepped with a proxy pool, and a 6-digit OTP is only a million
 * guesses. Keying on the submitted email means every attacker, from however
 * many addresses, shares one small budget against any single account.
 *
 * The split between them is about what counts as abuse. Guessing is only
 * abusive when it FAILS, so credentialLimiter ignores successful requests and
 * a person logging in normally is never throttled. Asking for an OTP is
 * abusive even when it succeeds - each one costs an email - so otpSendLimiter
 * counts everything.
 *
 * In-memory store: the counters live in this process. One instance is fine;
 * behind a load balancer each instance would keep its own tally and the
 * effective limit multiplies by the instance count. Swap in a shared store
 * (rate-limit-redis) when there is more than one.
 */
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.js';
import { HTTP_STATUS, MESSAGES, ROUTE_GROUP } from '../enums/index.js';
import { sendError } from '../helpers/response.helper.js';
import { logger } from '../utils/logger.js';

const WINDOW_MS = env.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000;

/**
 * One limiter, wired into the project's conventions: the 429 goes out in the
 * standard envelope, and a trip is logged so a real attack is visible rather
 * than silently absorbed.
 */
function buildLimiter({
  name,
  max,
  message,
  keyGenerator,
  skipSuccessfulRequests = false,
  skipFailedRequests = false,
  skip,
}) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: max,
    // RateLimit-* response headers; the legacy X-RateLimit-* pair is off.
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests,
    skipFailedRequests,
    keyGenerator,
    skip: (req, res) => {
      if (!env.RATE_LIMIT_ENABLED) return true;
      return skip ? skip(req, res) : false;
    },
    handler: (req, res) => {
      logger.warn(`[rate-limit:${name}] ${req.method} ${req.originalUrl} from ${req.ip}`);
      return sendError(res, {
        statusCode: HTTP_STATUS.TOO_MANY_REQUESTS,
        message,
        details: { retryAfterSeconds: Math.ceil(WINDOW_MS / 1000) },
      });
    },
  });
}

/**
 * Per-account key: the submitted email, lowercased so Admin@x.com and
 * admin@x.com share one budget.
 *
 * Falls back to the IP when no email was sent - a malformed body must not be a
 * way to opt out of the limit. ipKeyGenerator is what makes that fallback
 * IPv6-safe: a bare req.ip would give every address in a /64 its own bucket,
 * and a single attacker usually has the whole /64.
 */
function emailKey(req, res) {
  const email = req.body?.email;
  if (typeof email === 'string' && email.trim() !== '') {
    return `email:${email.trim().toLowerCase()}`;
  }
  return `ip:${ipKeyGenerator(req, res)}`;
}

/** Health checks are exempt: a load balancer polling must not spend the budget. */
function isHealthCheck(req) {
  return req.path === ROUTE_GROUP.HEALTH || req.path.startsWith(`${ROUTE_GROUP.HEALTH}/`);
}

/** Per IP, across the whole API. The backstop, not the real defence. */
export const apiLimiter = buildLimiter({
  name: 'api',
  max: env.RATE_LIMIT_MAX,
  message: MESSAGES.TOO_MANY_REQUESTS,
  skip: isHealthCheck,
});

/** Per IP, on /auth. Tighter, because nothing there is called in bulk legitimately. */
export const authLimiter = buildLimiter({
  name: 'auth',
  max: env.RATE_LIMIT_AUTH_MAX,
  message: MESSAGES.TOO_MANY_REQUESTS,
});

/**
 * Per account, on endpoints that check a password or an OTP.
 *
 * Only failures count, so a person who logs in correctly every time never sees
 * this - but an attacker gets RATE_LIMIT_CREDENTIAL_MAX guesses per window at
 * one account, from any number of addresses.
 */
export const credentialLimiter = buildLimiter({
  name: 'credential',
  max: env.RATE_LIMIT_CREDENTIAL_MAX,
  message: MESSAGES.TOO_MANY_ATTEMPTS,
  keyGenerator: emailKey,
  skipSuccessfulRequests: true,
});

/**
 * Per account, on endpoints that send an email.
 *
 * Successes count and failures do not - the mirror image of credentialLimiter,
 * and for the same reason. On login and forgot-password a 4xx means the secret
 * was wrong and no mail was queued, so charging it here would let wrong
 * passwords exhaust the budget for genuine OTP requests. What costs an email
 * is a request that succeeded, and that is exactly what this counts.
 */
export const otpSendLimiter = buildLimiter({
  name: 'otp-send',
  max: env.RATE_LIMIT_OTP_SEND_MAX,
  message: MESSAGES.TOO_MANY_OTP_REQUESTS,
  keyGenerator: emailKey,
  skipFailedRequests: true,
});

/**
 * One-time passcode generation and comparison.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Numeric OTP of the configured length, zero-padded so it never loses a
 * leading digit. randomInt is cryptographically secure — Math.random is not,
 * and its output is predictable from a few observed values.
 */
export function generateOtp() {
  const max = 10 ** env.OTP_LENGTH;
  return String(randomInt(0, max)).padStart(env.OTP_LENGTH, '0');
}

/** When a freshly generated OTP stops being valid. */
export function otpExpiryDate() {
  return new Date(Date.now() + env.OTP_EXPIRY_MINUTES * 60 * 1000);
}

/** Length-safe, timing-safe comparison of two OTP strings. */
export function otpMatches(submitted, stored) {
  if (typeof submitted !== 'string' || typeof stored !== 'string') return false;

  const a = Buffer.from(submitted, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

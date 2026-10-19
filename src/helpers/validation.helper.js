/**
 * A tiny declarative body validator, so controllers do not grow a pile of
 * hand-written `if (!req.body.x)` checks.
 *
 *   const { email, password } = validateBody(req.body, {
 *     email:    { required: true, email: true, lowercase: true, maxLength: 256 },
 *     password: { required: true, trim: false, maxLength: 72 },
 *   });
 *
 * Returns the cleaned values, or throws a 400 ApiError listing every bad field
 * at once — a client should not have to resubmit to discover the second error.
 */
import { ApiError } from '../utils/api-error.js';
import { MESSAGES } from '../enums/index.js';

// Deliberately permissive. The only authoritative test of an address is
// sending mail to it; anything stricter rejects valid, unusual addresses.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ISO calendar date only. A full timestamp is rejected rather than truncated:
// silently dropping a time zone is how a date of birth shifts by a day.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True when the string is both well-formed and a real calendar date. */
function isCalendarDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  // Round-tripping catches 2024-02-31, which Date happily rolls into March.
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function label(field) {
  // otpCode -> "Otp code"
  const spaced = field.replace(/([A-Z])/g, ' $1').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function validateBody(body, schema) {
  const errors = {};
  const values = {};

  for (const [field, rule] of Object.entries(schema)) {
    let value = body?.[field];

    // Trimming a password would silently change what the user typed.
    if (typeof value === 'string' && rule.trim !== false) value = value.trim();

    if (value === undefined || value === null || value === '') {
      if (rule.required) errors[field] = `${label(field)} is required`;
      continue;
    }

    if (typeof value !== 'string') {
      errors[field] = `${label(field)} must be text`;
      continue;
    }

    if (rule.email && !EMAIL_PATTERN.test(value)) {
      errors[field] = 'Must be a valid email address';
      continue;
    }

    if (rule.date && !isCalendarDate(value)) {
      errors[field] = `${label(field)} must be a real date in YYYY-MM-DD format`;
      continue;
    }

    if (rule.digits && !/^\d+$/.test(value)) {
      errors[field] = `${label(field)} must contain digits only`;
      continue;
    }

    if (rule.minLength && value.length < rule.minLength) {
      errors[field] = `${label(field)} must be at least ${rule.minLength} characters`;
      continue;
    }

    if (rule.maxLength && value.length > rule.maxLength) {
      errors[field] = `${label(field)} must be at most ${rule.maxLength} characters`;
      continue;
    }

    values[field] = rule.lowercase ? value.toLowerCase() : value;
  }

  if (Object.keys(errors).length > 0) {
    throw ApiError.badRequest(MESSAGES.VALIDATION_FAILED, errors);
  }

  return values;
}

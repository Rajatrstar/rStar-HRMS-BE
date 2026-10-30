/**
 * A tiny declarative body validator, so controllers do not grow a pile of
 * hand-written `if (!req.body.x)` checks.
 *
 *   const { email, password } = validateBody(req.body, {
 *     email:    { required: true, email: true, lowercase: true, maxLength: 256 },
 *     password: { required: true, trim: false, maxLength: 72 },
 *   });
 *
 * Rules: required, trim, lowercase, email, date, digits, url, oneOf,
 * minLength, maxLength, integer, decimal, boolean. The last three convert as
 * well as check, so a validated field is already the right JS type.
 *
 * Returns the cleaned values, or throws a 400 ApiError listing every bad field
 * at once — a client should not have to resubmit to discover the second error.
 *
 * A field that is absent is simply missing from the result, never `undefined`
 * with a key. That is what lets a PUT handler tell "the client left this out"
 * apart from "the client sent an empty string", and decide for itself which
 * one means NULL.
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

/**
 * The engine behind validateBody and validateParams.
 *
 * @param {Record<string, unknown>} source
 * @param {Record<string, object>} schema
 */
function validate(source, schema) {
  const errors = {};
  const values = {};

  for (const [field, rule] of Object.entries(schema)) {
    let value = source?.[field];

    // Trimming a password would silently change what the user typed.
    if (typeof value === 'string' && rule.trim !== false) value = value.trim();

    if (value === undefined || value === null || value === '') {
      if (rule.required) errors[field] = `${label(field)} is required`;
      continue;
    }

    // Numbers and booleans are checked before the "must be text" guard below,
    // which exists for the string rules and would otherwise reject them.
    if (rule.integer) {
      // A path parameter always arrives as a string, a JSON body may not.
      const parsed = typeof value === 'number' ? value : Number(value);
      const min = rule.min ?? 1;

      if (!Number.isInteger(parsed) || parsed < min) {
        errors[field] = `${label(field)} must be a whole number of at least ${min}`;
        continue;
      }
      // Number.MAX_SAFE_INTEGER, not the column's BIGINT range: beyond this a
      // JS number stops being able to tell two ids apart, so an id that large
      // would match the wrong row rather than fail.
      if (parsed > Number.MAX_SAFE_INTEGER) {
        errors[field] = `${label(field)} is out of range`;
        continue;
      }

      values[field] = parsed;
      continue;
    }

    if (rule.decimal) {
      const parsed = typeof value === 'number' ? value : Number(value);
      const max = rule.max ?? Number.MAX_SAFE_INTEGER;

      if (!Number.isFinite(parsed) || parsed < (rule.min ?? 0) || parsed > max) {
        errors[field] = `${label(field)} must be a number between ${rule.min ?? 0} and ${max}`;
        continue;
      }

      values[field] = parsed;
      continue;
    }

    if (rule.boolean) {
      if (typeof value === 'boolean') {
        values[field] = value;
        continue;
      }
      // A query string has no booleans, only "true" and "false".
      if (value === 'true' || value === 'false') {
        values[field] = value === 'true';
        continue;
      }
      errors[field] = `${label(field)} must be true or false`;
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

    // http(s) only. A javascript: or data: URL in a field that ends up in an
    // <img src> or an <a href> is the whole stored-XSS story in one line.
    if (rule.url && !/^https?:\/\/[^\s]+$/i.test(value)) {
      errors[field] = `${label(field)} must be a URL starting with http:// or https://`;
      continue;
    }

    // Case-sensitive on purpose: these lists come from an enum the client is
    // served, so "information technology" is a client bug worth surfacing
    // rather than quietly correcting into a value nobody chose.
    if (rule.oneOf && !rule.oneOf.includes(value)) {
      errors[field] = `${label(field)} must be one of: ${rule.oneOf.join(', ')}`;
      continue;
    }

    values[field] = rule.lowercase ? value.toLowerCase() : value;
  }

  if (Object.keys(errors).length > 0) {
    throw ApiError.badRequest(MESSAGES.VALIDATION_FAILED, errors);
  }

  return values;
}

/** Validates and cleans a request body. */
export function validateBody(body, schema) {
  return validate(body, schema);
}

/**
 * The same, for `req.params` — and for `req.query`, which has the same shape.
 *
 *   const { organizationId } = validateParams(req.params, {
 *     organizationId: { required: true, integer: true },
 *   });
 *
 * Worth doing rather than passing `req.params.id` straight into a query: the
 * parameter is typed as BigInt on the way to SQL Server, and "abc" would
 * otherwise reach the driver and come back as a 500 instead of a 400.
 */
export function validateParams(params, schema) {
  return validate(params, schema);
}

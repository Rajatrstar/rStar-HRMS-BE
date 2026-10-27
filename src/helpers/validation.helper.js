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

// A full ISO 8601 timestamp WITH a zone - "2026-12-31T18:30:00Z" or
// "...+05:30". A zoneless one is rejected: the server would have to guess
// whose midnight an override expires at, and it would guess UTC.
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function label(field) {
  // otpCode -> "Otp code"
  const spaced = field.replace(/([A-Z])/g, ' $1').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A whole number within [min, max], or null. */
function toBoundedInteger(value, min, max) {
  // A path parameter always arrives as a string, a JSON body may not.
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

/**
 * The engine behind validateBody and validateParams. Collects rather than
 * throws, so a `list` rule can validate each item with the same rules and
 * report the errors under the item's own key.
 *
 * @param {Record<string, unknown>} source
 * @param {Record<string, object>} schema
 */
function collect(source, schema) {
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
      if (rule.max !== undefined && parsed > rule.max) {
        errors[field] = `${label(field)} must be at most ${rule.max}`;
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

    /*
     * A list of ids: { roleIds: { required: true, integerList: true } }.
     *
     * An empty array is a legitimate value - "this person holds no roles" - so
     * it passes `required`, which only rejects an absent field. Duplicates are
     * dropped rather than rejected: [4, 4] means the same thing as [4].
     */
    if (rule.integerList) {
      if (!Array.isArray(value)) {
        errors[field] = `${label(field)} must be a list of ids`;
        continue;
      }
      if (rule.maxItems !== undefined && value.length > rule.maxItems) {
        errors[field] = `${label(field)} may hold at most ${rule.maxItems} items`;
        continue;
      }

      const parsed = value.map((item) => toBoundedInteger(item, 1, Number.MAX_SAFE_INTEGER));
      const bad = parsed.findIndex((item) => item === null);
      if (bad !== -1) {
        errors[`${field}[${bad}]`] = 'Must be a whole number of at least 1';
        continue;
      }

      values[field] = [...new Set(parsed)];
      continue;
    }

    /*
     * A list of objects, each checked against its own schema:
     *
     *   permissions: { required: true, list: {
     *     permissionId: { required: true, integer: true },
     *     scope:        { oneOf: PERMISSION_SCOPES },
     *   } }
     *
     * Item errors are reported under `permissions[2].scope`, which is the key
     * the permission-matrix screen maps straight onto one grid cell.
     */
    if (rule.list) {
      if (!Array.isArray(value)) {
        errors[field] = `${label(field)} must be a list`;
        continue;
      }
      if (rule.maxItems !== undefined && value.length > rule.maxItems) {
        errors[field] = `${label(field)} may hold at most ${rule.maxItems} items`;
        continue;
      }

      const items = [];
      value.forEach((item, index) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          errors[`${field}[${index}]`] = 'Must be an object';
          return;
        }
        const { values: itemValues, errors: itemErrors } = collect(item, rule.list);
        for (const [key, message] of Object.entries(itemErrors)) {
          errors[`${field}[${index}].${key}`] = message;
        }
        items.push(itemValues);
      });

      values[field] = items;
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

    // Returned as a Date, so the service binds it as DATETIME2 directly.
    if (rule.datetime) {
      const parsed = new Date(value);
      if (!DATETIME_PATTERN.test(value) || Number.isNaN(parsed.getTime())) {
        errors[field] =
          `${label(field)} must be an ISO 8601 timestamp with a time zone, ` +
          'e.g. 2026-12-31T18:30:00Z';
        continue;
      }
      values[field] = parsed;
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

    // Checked after the case is normalised, so `uppercase` + a pattern of
    // capitals accepts "finance_team" and stores FINANCE_TEAM.
    const normalised = rule.lowercase
      ? value.toLowerCase()
      : rule.uppercase
        ? value.toUpperCase()
        : value;

    if (rule.pattern && !rule.pattern.test(normalised)) {
      errors[field] = rule.patternMessage ?? `${label(field)} is not in the expected format`;
      continue;
    }

    values[field] = normalised;
  }

  return { values, errors };
}

/** The engine, throwing the single 400 that lists every bad field. */
function validate(source, schema) {
  const { values, errors } = collect(source, schema);

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

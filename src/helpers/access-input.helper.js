/**
 * Validation rules shared by the role, group and user-access controllers.
 *
 * Every maxLength is the column width in db/migrations/004_access_control.sql.
 */
import { ApiError } from '../utils/api-error.js';
import { MESSAGES, PERMISSION_SCOPES } from '../enums/index.js';

/**
 * Role and group codes: SCREAMING_SNAKE, like the five seeded roles. Sent in
 * any case and stored upper - "finance_team" becomes FINANCE_TEAM.
 */
export const CODE_RULE = {
  required: true,
  uppercase: true,
  maxLength: 50,
  pattern: /^[A-Z][A-Z0-9_]*$/,
  patternMessage: 'Code must start with a letter and contain only letters, digits and underscores',
};

/** ?page=&pageSize=&search= on the list screens. */
export const LIST_QUERY_RULES = {
  page: { integer: true, min: 1 },
  pageSize: { integer: true, min: 1, max: 100 },
  search: { maxLength: 100 },
};

/** The body of a matrix save, for roles and groups alike. */
export const PERMISSION_SET_RULES = {
  permissions: {
    required: true,
    maxItems: 500,
    list: {
      permissionId: { required: true, integer: true },
      // Optional here; whether it is REQUIRED depends on the permission, which
      // only the catalog knows - the service answers SCOPE_REQUIRED (422).
      scope: { oneOf: PERMISSION_SCOPES },
    },
  },
  expectedModifiedAt: { datetime: true },
};

/**
 * PATCH semantics for a clearable text column.
 *
 * The validator drops an empty string as "absent", which is right for a
 * required field and wrong here: `"description": ""` and `"description": null`
 * both mean "clear it", while leaving the key out means "leave it alone".
 * This puts the explicit clear back as a null the service can see.
 */
export function withClears(body, input, fields) {
  const out = { ...input };
  for (const field of fields) {
    if (
      body &&
      Object.hasOwn(body, field) &&
      (body[field] === null || (typeof body[field] === 'string' && body[field].trim() === ''))
    ) {
      out[field] = null;
    }
  }
  return out;
}

/** A PATCH that names no field is a client bug worth reporting, not a no-op 200. */
export function assertSomethingToUpdate(input) {
  if (Object.keys(input).length === 0) {
    throw ApiError.badRequest(MESSAGES.NOTHING_TO_UPDATE);
  }
}

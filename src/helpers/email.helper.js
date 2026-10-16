/**
 * Turns a template code plus data into a ready-to-send email.
 *
 * App-aware but database-free: it knows the EMAIL_TEMPLATE codes and nothing
 * about how mail is stored or sent. `src/services/email.service.js` uses it to
 * fill an outbox row.
 */
import { renderTemplate } from '../utils/template.js';
import { EMAIL_TEMPLATE } from '../enums/index.js';

const KNOWN_CODES = new Set(Object.values(EMAIL_TEMPLATE));

/**
 * @param {{ template: string, data?: Record<string, unknown> }} input
 * @returns {{ templateCode: string, subject: string, html: string, text: string }}
 */
export function buildEmail({ template, data = {} }) {
  // Catches a hand-typed string where an enum constant belongs, before it
  // becomes "template file is missing" three layers down.
  if (!KNOWN_CODES.has(template)) {
    throw new Error(
      `Unknown email template "${template}". Use a value from EMAIL_TEMPLATE ` +
        `(${[...KNOWN_CODES].join(', ')}).`,
    );
  }

  const { subject, html, text } = renderTemplate(template, data);
  return { templateCode: template, subject, html, text };
}

/** Normalises one address or a list into the single header string the outbox stores. */
export function addressList(value) {
  const list = (Array.isArray(value) ? value : [value])
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => entry.trim());

  if (list.length === 0) throw new Error('An email needs at least one recipient.');
  return list.join(', ');
}

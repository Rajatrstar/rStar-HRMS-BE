/**
 * Email template loading and rendering.
 *
 * A template is a single `.html` file under `src/templates/` that opens with a
 * front-matter block carrying its subject, so subject and body live together
 * and cannot drift apart:
 *
 *   ---
 *   subject: Your rSTAR HRMS login code
 *   ---
 *   <!doctype html> ...
 *
 * An optional sibling `.txt` supplies the plain-text alternative. Sending both
 * parts matters: HTML-only mail scores worse with spam filters, and some
 * corporate clients render the text part only.
 *
 * Placeholders are `{{key}}`, escaped for HTML. `{{{key}}}` inserts a value
 * unescaped - needed for things like a URL already built elsewhere.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EMAIL_TEMPLATE } from '../enums/email-template.enum.js';

const TEMPLATE_DIR = join(import.meta.dirname, '..', 'templates');

/** Parsed files, keyed by template code. Skipped outside production so a template edit shows up on restart. */
const cache = new Map();

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Substitutes every `{{key}}` / `{{{key}}}` in `source`.
 *
 * A placeholder with no matching key throws rather than silently mailing
 * `{{nmae}}` to an employee - the typo surfaces the first time the template is
 * used, not in someone's inbox.
 */
function renderString(source, data, { escape }) {
  return source.replace(/\{\{\{?\s*([\w.]+)\s*\}?\}\}/g, (match, key) => {
    if (!Object.hasOwn(data, key)) {
      throw new Error(`Email template placeholder "${key}" has no value supplied.`);
    }
    const raw = match.startsWith('{{{');
    const value = data[key] ?? '';
    return escape && !raw ? escapeHtml(value) : String(value);
  });
}

/** Reads and parses one template from disk. */
function loadTemplate(code) {
  const cached = cache.get(code);
  if (cached) return cached;

  const htmlPath = join(TEMPLATE_DIR, `${code}.html`);
  if (!existsSync(htmlPath)) {
    throw new Error(`Email template file is missing: ${htmlPath}`);
  }

  const file = readFileSync(htmlPath, 'utf8');
  const matter = FRONT_MATTER.exec(file);
  if (!matter) {
    throw new Error(
      `Email template ${code}.html has no front-matter block. ` +
        'It must start with ---\nsubject: ...\n---',
    );
  }

  const meta = Object.fromEntries(
    matter[1]
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const at = line.indexOf(':');
        if (at === -1) throw new Error(`Bad front-matter line in ${code}.html: "${line}"`);
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );

  if (!meta.subject) {
    throw new Error(`Email template ${code}.html has no "subject" in its front-matter.`);
  }

  const textPath = join(TEMPLATE_DIR, `${code}.txt`);

  const parsed = {
    subject: meta.subject,
    html: file.slice(matter[0].length),
    text: existsSync(textPath) ? readFileSync(textPath, 'utf8') : null,
  };

  // Read straight from process.env rather than importing config/env.js: this
  // file is a util and should stay usable without the database config loaded.
  if (process.env.NODE_ENV === 'production') cache.set(code, parsed);
  return parsed;
}

/** Crude HTML-to-text, used only when a template ships no `.txt` sibling. */
function deriveText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '-')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/**
 * Renders one template against `data`.
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderTemplate(code, data = {}) {
  const template = loadTemplate(code);

  const html = renderString(template.html, data, { escape: true });

  return {
    // Subject and text part are not HTML, so escaping them would turn an
    // apostrophe into &#39; in the recipient's inbox.
    subject: renderString(template.subject, data, { escape: false }),
    html,
    text: template.text
      ? renderString(template.text, data, { escape: false })
      : deriveText(html),
  };
}

/**
 * Checks every enum entry has a file behind it. Called once at boot so a
 * missing template is a startup failure, not something an employee discovers
 * by never receiving their email.
 */
export function assertTemplatesExist() {
  for (const code of Object.values(EMAIL_TEMPLATE)) {
    loadTemplate(code);
  }
  return Object.values(EMAIL_TEMPLATE).length;
}

/**
 * The SMTP transport - the one place in the application that talks to a mail
 * server.
 *
 * Everything else queues rendered mail into dbo.EmailOutbox and lets the worker
 * call sendRawMail(). Keeping the transport behind this single function is what
 * makes the coming auth change cheap: Microsoft disables SMTP basic
 * authentication by default for existing tenants at the end of December 2026,
 * and switching to OAuth2 (XOAUTH2) means editing `auth` below and nothing else.
 */
import nodemailer from 'nodemailer';
import { env, mailEnabled, mailFromAddress } from '../config/env.js';

let transporter = null;

/** Connection-pooled transporter, created on first use. */
function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: env.MAIL_HOST,
    port: env.MAIL_PORT,
    // false on 587: the connection starts plain and is upgraded by STARTTLS.
    secure: env.MAIL_SECURE,
    auth: { user: env.MAIL_USER, pass: env.MAIL_PASSWORD },
    // One connection reused across a batch instead of a fresh TLS handshake
    // per email. Office 365 throttles aggressively at 30 messages/minute.
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  return transporter;
}

/** Formatted From header, e.g. `rSTAR HRMS <hr@rstartec.com>`. */
export function mailFrom() {
  return { name: env.MAIL_FROM_NAME, address: mailFromAddress };
}

/**
 * Sends one already-rendered email.
 * @returns {Promise<{ messageId: string, accepted: string[] }>}
 */
export async function sendRawMail({ to, cc, subject, html, text }) {
  if (!mailEnabled) {
    throw new Error('sendRawMail called while mail is disabled - check mailEnabled first.');
  }

  const info = await getTransporter().sendMail({
    from: mailFrom(),
    to,
    ...(cc ? { cc } : {}),
    subject,
    html,
    text,
  });

  return { messageId: info.messageId, accepted: info.accepted ?? [] };
}

/**
 * Opens a connection and authenticates without sending anything. Used by
 * `npm run mail:test` to separate "credentials are wrong" from "the message
 * was rejected".
 */
export function verifyMailer() {
  return getTransporter().verify();
}

/** Releases pooled connections so shutdown is not held up by an idle socket. */
export function closeMailer() {
  if (!transporter) return;
  transporter.close();
  transporter = null;
}

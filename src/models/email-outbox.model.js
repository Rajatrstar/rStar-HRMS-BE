/**
 * dbo.EmailOutbox - the queue every outbound email passes through.
 *
 * Mirrors db/migrations/002_email_outbox.sql. Subject and bodies are stored
 * already rendered, so a row is both the thing to send and the record of what
 * was sent.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

/**
 * The four values CK_EmailOutbox_Status allows. Any new value needs a
 * migration to widen that constraint, which is why they live with the table
 * rather than in src/enums.
 */
export const EMAIL_STATUS = Object.freeze({
  PENDING: 'Pending',
  SENDING: 'Sending',
  SENT: 'Sent',
  FAILED: 'Failed',
});

export const EmailOutbox = defineModel({
  table: 'dbo.EmailOutbox',
  columns: {
    emailId: { column: 'EmailId', type: sql.Int, identity: true },

    // A value of EMAIL_TEMPLATE; kept for reporting, not used to send.
    templateCode: { column: 'TemplateCode', type: sql.NVarChar(64) },

    to: { column: 'ToAddress', type: sql.NVarChar(512) },
    cc: { column: 'CcAddress', type: sql.NVarChar(512), nullable: true },
    subject: { column: 'Subject', type: sql.NVarChar(512) },
    html: { column: 'HtmlBody', type: sql.NVarChar(sql.MAX) },
    text: { column: 'TextBody', type: sql.NVarChar(sql.MAX), nullable: true },

    status: { column: 'Status', type: sql.NVarChar(16) },
    attemptCount: { column: 'AttemptCount', type: sql.Int },
    maxAttempts: { column: 'MaxAttempts', type: sql.Int },
    nextAttemptAt: { column: 'NextAttemptAt', type: sql.DateTime2 },

    lastError: { column: 'LastError', type: sql.NVarChar(2000), nullable: true },
    sentAt: { column: 'SentAt', type: sql.DateTime2, nullable: true },

    createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
    modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
  },
});

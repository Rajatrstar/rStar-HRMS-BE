/**
 * The outbox: every statement that touches dbo.EmailOutbox lives here.
 *
 * Callers queue mail with queueTemplatedMail(); the worker in
 * src/workers/email-outbox.worker.js claims rows and reports the outcome back
 * through markSent / markRetry. Nothing here touches req or res, and nothing
 * here opens an SMTP connection.
 */
import { query, mutate, sql } from '../helpers/query.helper.js';
import { buildEmail, addressList } from '../helpers/email.helper.js';
import { env } from '../config/env.js';
import { EmailOutbox, EMAIL_STATUS } from '../models/index.js';

const INSERT_SQL = `
  INSERT INTO ${EmailOutbox.table}
    (TemplateCode, ToAddress, CcAddress, Subject, HtmlBody, TextBody, MaxAttempts)
  OUTPUT inserted.EmailId AS emailId
  VALUES
    (@templateCode, @to, @cc, @subject, @html, @text, @maxAttempts)
`;

/**
 * Renders a template and queues it for delivery.
 *
 * Returns as soon as the row is written - the SMTP conversation happens later,
 * on the worker, so a slow or dead mail server never shows up as API latency.
 *
 * Pass `run` (the callback from withTransaction) to enqueue inside a wider
 * transaction. The OTP flow does exactly that, so an account can never be left
 * holding a code whose email was never queued.
 *
 * @param {{ to: string|string[], cc?: string|string[], template: string, data?: object }} input
 * @param {(statement: string, params?: object) => Promise<any[]>} [run]
 * @returns {Promise<number>} the new EmailId
 */
export async function queueTemplatedMail({ to, cc, template, data }, run) {
  const { templateCode, subject, html, text } = buildEmail({ template, data });

  const params = EmailOutbox.params({
    templateCode,
    to: addressList(to),
    cc: cc ? addressList(cc) : null,
    subject,
    html,
    text,
    maxAttempts: env.MAIL_MAX_ATTEMPTS,
  });

  const rows = run ? await run(INSERT_SQL, params) : await query(INSERT_SQL, params);
  return rows[0]?.emailId;
}

/**
 * Atomically takes up to `batchSize` due rows and marks them Sending.
 *
 * One statement does the select and the claim together, so two processes can
 * never pick up the same email: READPAST makes a worker skip rows another one
 * has locked rather than queue behind them.
 */
export function claimBatch(batchSize = env.MAIL_BATCH_SIZE) {
  return query(
    `UPDATE TOP (@batchSize) ${EmailOutbox.table} WITH (READPAST, UPDLOCK, ROWLOCK)
        SET Status = @sending,
            AttemptCount = AttemptCount + 1,
            ModifiedAt = SYSUTCDATETIME()
     OUTPUT inserted.EmailId AS emailId, inserted.TemplateCode AS templateCode,
            inserted.ToAddress AS [to], inserted.CcAddress AS cc,
            inserted.Subject AS subject, inserted.HtmlBody AS html, inserted.TextBody AS text,
            inserted.AttemptCount AS attemptCount, inserted.MaxAttempts AS maxAttempts
      WHERE Status = @pending
        AND NextAttemptAt <= SYSUTCDATETIME()`,
    {
      batchSize: { type: sql.Int, value: batchSize },
      sending: EmailOutbox.param('status', EMAIL_STATUS.SENDING),
      pending: EmailOutbox.param('status', EMAIL_STATUS.PENDING),
    },
  );
}

/** Marks one row delivered. `note` records a log-only send when SMTP is off. */
export function markSent(emailId, note = null) {
  return mutate(
    `UPDATE ${EmailOutbox.table}
        SET Status = @status,
            SentAt = SYSUTCDATETIME(),
            LastError = @note,
            ModifiedAt = SYSUTCDATETIME()
      WHERE EmailId = @emailId`,
    {
      ...EmailOutbox.params({ emailId, status: EMAIL_STATUS.SENT }),
      note: EmailOutbox.param('lastError', note),
    },
  );
}

/**
 * Records a failed attempt: back to Pending with an exponential backoff, or
 * Failed once the attempts are used up.
 *
 * Backoff is 2^attempt minutes capped at an hour - 2, 4, 8, 16, 32, 60... - so
 * a brief outage retries quickly while a long one stops hammering the server.
 */
export function markRetry(emailId, { attemptCount, maxAttempts, error }) {
  const exhausted = attemptCount >= maxAttempts;
  const delayMinutes = Math.min(2 ** attemptCount, 60);

  return mutate(
    `UPDATE ${EmailOutbox.table}
        SET Status = @status,
            NextAttemptAt = DATEADD(MINUTE, @delayMinutes, SYSUTCDATETIME()),
            LastError = @error,
            ModifiedAt = SYSUTCDATETIME()
      WHERE EmailId = @emailId`,
    {
      ...EmailOutbox.params({
        emailId,
        status: exhausted ? EMAIL_STATUS.FAILED : EMAIL_STATUS.PENDING,
      }),
      delayMinutes: { type: sql.Int, value: exhausted ? 0 : delayMinutes },
      error: EmailOutbox.param('lastError', String(error).slice(0, 2000)),
    },
  );
}

/**
 * Returns rows stranded in Sending to the queue.
 *
 * A process killed between claiming a row and reporting on it would otherwise
 * leave that email stuck forever, since nothing else will ever claim a row that
 * is not Pending.
 */
export async function recoverStuck(olderThanMinutes = 10) {
  const affected = await mutate(
    `UPDATE ${EmailOutbox.table}
        SET Status = @pending,
            LastError = 'Recovered: worker stopped mid-send',
            ModifiedAt = SYSUTCDATETIME()
      WHERE Status = @sending
        AND ModifiedAt < DATEADD(MINUTE, -@minutes, SYSUTCDATETIME())`,
    {
      minutes: { type: sql.Int, value: olderThanMinutes },
      pending: EmailOutbox.param('status', EMAIL_STATUS.PENDING),
      sending: EmailOutbox.param('status', EMAIL_STATUS.SENDING),
    },
  );
  return affected;
}

/** Queue counts by status - used by the readiness check and by the test script. */
export function outboxStats() {
  return query(
    `SELECT Status AS status, COUNT(*) AS total
       FROM ${EmailOutbox.table}
      GROUP BY Status`,
  );
}

/**
 * Drains dbo.EmailOutbox on a timer.
 *
 * Started from src/index.js once the pool is up and stopped in the shutdown
 * handler. The interval is unref'd, so it never by itself keeps the process
 * alive - Ctrl+C still exits promptly.
 */
import { env, mailEnabled } from '../config/env.js';
import { sendRawMail, closeMailer } from '../utils/mailer.js';
import { logger } from '../utils/logger.js';
import { claimBatch, markSent, markRetry, recoverStuck } from '../services/email.service.js';

const STUCK_AFTER_MINUTES = 10;

let timer = null;
/** Guards against a slow tick overlapping the next one and double-claiming work. */
let running = false;

/**
 * With no SMTP credentials the email still has to go somewhere, or the whole
 * flow is untestable until the day the mailbox exists. It goes to the log, and
 * the row says plainly that nothing was delivered.
 */
function logInsteadOfSending(email) {
  logger.info(
    `[mail:disabled] to=${email.to} subject="${email.subject}"\n` +
      `${email.text ?? '(no text part)'}`,
  );
}

async function deliver(email) {
  if (!mailEnabled) {
    logInsteadOfSending(email);
    await markSent(email.emailId, 'MAIL_ENABLED=false - rendered to log, not delivered');
    return 'logged';
  }

  try {
    const { messageId } = await sendRawMail({
      to: email.to,
      cc: email.cc ?? undefined,
      subject: email.subject,
      html: email.html,
      text: email.text ?? undefined,
    });
    await markSent(email.emailId);
    logger.info(`[mail:sent] id=${email.emailId} to=${email.to} messageId=${messageId}`);
    return 'sent';
  } catch (error) {
    await markRetry(email.emailId, {
      attemptCount: email.attemptCount,
      maxAttempts: email.maxAttempts,
      error: error.message,
    });

    const exhausted = email.attemptCount >= email.maxAttempts;
    const line = `[mail:${exhausted ? 'failed' : 'retry'}] id=${email.emailId} to=${email.to} attempt=${email.attemptCount}/${email.maxAttempts}: ${error.message}`;
    if (exhausted) logger.error(line);
    else logger.warn(line);

    return exhausted ? 'failed' : 'retry';
  }
}

/** One pass: recover stranded rows, claim a batch, deliver each one. */
export async function processOutbox() {
  const recovered = await recoverStuck(STUCK_AFTER_MINUTES);
  if (recovered > 0) logger.warn(`[mail] requeued ${recovered} email(s) left mid-send`);

  const batch = await claimBatch();
  if (batch.length === 0) return { claimed: 0 };

  const outcomes = { claimed: batch.length, sent: 0, logged: 0, retry: 0, failed: 0 };

  // Sequential on purpose: Office 365 throttles concurrent submissions, and a
  // batch is small. Parallelism here buys nothing and risks a 4.3.2 error.
  for (const email of batch) {
    outcomes[await deliver(email)] += 1;
  }

  return outcomes;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await processOutbox();
  } catch (error) {
    // Never let a bad tick kill the interval - the next one should still run.
    logger.error('[mail] outbox tick failed', error);
  } finally {
    running = false;
  }
}

export function startEmailWorker() {
  if (timer) return;

  timer = setInterval(() => void tick(), env.MAIL_POLL_SECONDS * 1000);
  timer.unref();

  logger.info(
    `Email worker started: every ${env.MAIL_POLL_SECONDS}s, batch ${env.MAIL_BATCH_SIZE}` +
      (mailEnabled ? ` via ${env.MAIL_HOST}:${env.MAIL_PORT}` : ' (MAIL disabled - logging only)'),
  );

  // Don't wait a full interval for mail queued just before a restart.
  void tick();
}

export function stopEmailWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  closeMailer();
}

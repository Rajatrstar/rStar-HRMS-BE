/**
 * Sends one real email, end to end, to prove the SMTP credentials work.
 *
 *   npm run mail:test -- someone@rstartec.com
 *
 * It queues an OTP-shaped email and drains the outbox once, rather than
 * calling nodemailer directly, so what it exercises is the exact path a real
 * login takes - template, queue, claim, send.
 */
import { closePool } from '../src/config/db.js';
import { env, mailEnabled, mailFromAddress } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';
import { verifyMailer, closeMailer } from '../src/utils/mailer.js';
import { queueTemplatedMail, outboxStats } from '../src/services/email.service.js';
import { processOutbox } from '../src/workers/email-outbox.worker.js';
import { EMAIL_TEMPLATE } from '../src/enums/index.js';

const recipient = process.argv[2];

async function run() {
  if (!recipient) {
    throw new Error('Usage: npm run mail:test -- someone@rstartec.com');
  }

  if (!mailEnabled) {
    logger.warn(
      'MAIL_ENABLED is off or MAIL_USER/MAIL_PASSWORD are blank. ' +
        'The email will be queued and written to this log, not delivered.',
    );
  } else {
    logger.info(`Checking SMTP login ${env.MAIL_USER} at ${env.MAIL_HOST}:${env.MAIL_PORT}`);
    // Separates "the credentials are wrong" from "the message was rejected" -
    // the two produce very different-looking failures further down.
    await verifyMailer();
    logger.info(`SMTP authentication OK, sending as ${mailFromAddress}`);
  }

  const emailId = await queueTemplatedMail({
    to: recipient,
    template: EMAIL_TEMPLATE.OTP_LOGIN,
    data: { name: recipient.split('@')[0], otp: '123456', minutes: env.OTP_EXPIRY_MINUTES },
  });
  logger.info(`Queued EmailId ${emailId} for ${recipient}`);

  const outcome = await processOutbox();
  logger.info(`Outbox pass: ${JSON.stringify(outcome)}`);

  for (const row of await outboxStats()) {
    logger.info(`  ${row.status}: ${row.total}`);
  }

  if (mailEnabled && outcome.sent > 0) {
    logger.info(`Delivered. Check the inbox for ${recipient} (and the junk folder).`);
  }

  closeMailer();
  await closePool();
}

run().catch(async (error) => {
  logger.error('Test email failed', error);
  closeMailer();
  await closePool();
  process.exit(1);
});

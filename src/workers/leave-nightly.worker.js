/**
 * The nightly leave jobs, in the order they must run:
 *
 *   1. CONFIRM everybody whose probation end date has passed.
 *   2. ACCRUE the month's leave.
 *   3. LAPSE comp-off credits whose expiry has passed.
 *
 * THE ORDER IS NOT ARBITRARY. Confirmation must come first, because the
 * accrual reads ConfirmationStatus to decide whether Earned Leave accrues
 * at all - run them the other way round and somebody confirmed overnight
 * loses a month of EL, silently, and nobody notices until they count their
 * balance in March.
 *
 * ALL THREE ARE IDEMPOTENT, which is what makes a catch-up run safe:
 * confirmation only looks at people still on PROBATION, accrual checks the
 * ledger for an entry in the same month before writing one, and lapsing
 * only touches credits still AVAILABLE. Running twice does nothing twice.
 */
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { ERROR_LOG_SOURCE } from '../enums/index.js';
import { today } from '../helpers/date.helper.js';
import { confirmDueEmployees } from '../services/confirmation.service.js';
import { runAccrual } from '../services/leave-accrual.service.js';
import { lapseExpiredCredits } from '../services/comp-off.service.js';
import { recordError } from '../services/error-log.service.js';

let timer = null;
let running = false;
/** The last date this process ran, so an hourly tick does one run a day. */
let lastRunOn = null;

/**
 * One full nightly pass.
 *
 * Exported so it can be run by hand - `node -e "import('./src/workers/
 * leave-nightly.worker.js').then(m => m.runNightly())"` - which is what
 * you want after fixing a policy row rather than waiting until tomorrow.
 *
 * EACH STEP IS CAUGHT SEPARATELY. A failure in the accrual must not stop
 * comp-offs lapsing, and neither must hide the confirmation's result: the
 * three are independent pieces of work that happen to share a schedule.
 */
export async function runNightly({ onDate = today() } = {}) {
  const summary = { onDate, confirmation: null, accrual: null, lapsed: null, errors: [] };

  try {
    summary.confirmation = await confirmDueEmployees(env.SYSTEM_ACTOR_EMPLOYEE_ID, { onDate });

    const { due, confirmed, failed } = summary.confirmation;
    if (due > 0) {
      logger.info(
        `[leave:nightly] confirmation - ${confirmed.length} of ${due} confirmed` +
          (failed.length > 0 ? `, ${failed.length} failed` : ''),
      );
    }
  } catch (error) {
    summary.errors.push({ step: 'confirmation', message: error.message });
    logger.error('[leave:nightly] confirmation failed', error);
  }

  try {
    summary.accrual = await runAccrual({ onDate, actorId: env.SYSTEM_ACTOR_EMPLOYEE_ID });

    if (summary.accrual.granted > 0 || summary.accrual.failed.length > 0) {
      logger.info(
        `[leave:nightly] accrual - ${summary.accrual.granted} grant(s), ` +
          `${summary.accrual.days} day(s) across ${summary.accrual.employees} employee(s)` +
          (summary.accrual.failed.length > 0 ? `, ${summary.accrual.failed.length} failed` : ''),
      );
    }

    for (const failure of (summary.accrual.failed ?? []).slice(0, 10)) {
      logger.warn(`[leave:nightly] employee ${failure.employeeDetailId}: ${failure.message}`);
    }
  } catch (error) {
    summary.errors.push({ step: 'accrual', message: error.message });
    logger.error('[leave:nightly] accrual failed', error);
  }

  try {
    summary.lapsed = await lapseExpiredCredits(env.SYSTEM_ACTOR_EMPLOYEE_ID);
    if (summary.lapsed > 0) {
      logger.info(`[leave:nightly] ${summary.lapsed} comp-off credit(s) lapsed`);
    }
  } catch (error) {
    summary.errors.push({ step: 'compOffLapse', message: error.message });
    logger.error('[leave:nightly] comp-off lapse failed', error);
  }

  // One error-log row for the night, not three: they share a cause more
  // often than not, and three rows for one bad deploy is noise.
  if (summary.errors.length > 0) {
    void recordError({
      source: ERROR_LOG_SOURCE.JOB,
      error: new Error(summary.errors.map((e) => `${e.step}: ${e.message}`).join('; ')),
      message: `Nightly leave job had ${summary.errors.length} failure(s)`,
    });
  }

  return summary;
}

async function tick() {
  if (running) return;

  const now = new Date();
  const currentDate = now.toISOString().slice(0, 10);

  if (now.getUTCHours() < env.LEAVE_ACCRUAL_HOUR_UTC) return;
  if (lastRunOn === currentDate) return;

  running = true;
  try {
    await runNightly();
    lastRunOn = currentDate;
  } catch (error) {
    // runNightly catches each step itself, so reaching here means something
    // outside them failed. Never let it kill the interval.
    logger.error('[leave:nightly] run failed', error);
  } finally {
    running = false;
  }
}

export function startLeaveNightly() {
  if (timer || !env.LEAVE_ACCRUAL_ENABLED) return;

  timer = setInterval(() => void tick(), 60 * 60 * 1000);
  timer.unref();

  logger.info(
    `Leave nightly worker started: daily after ${env.LEAVE_ACCRUAL_HOUR_UTC}:00 UTC ` +
      '(confirmation, accrual, comp-off expiry)',
  );

  void tick();
}

export function stopLeaveNightly() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

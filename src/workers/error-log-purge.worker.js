/**
 * Trims dbo.tblErrorLog to ERROR_LOG_RETENTION_DAYS, once a day.
 *
 * Started from src/index.js next to the email worker and stopped in the
 * shutdown handler. Runs once shortly after boot, so a server that is
 * restarted more often than daily still purges. The interval is unref'd and
 * never by itself keeps the process alive.
 *
 * With several instances each one purges; the DELETE is idempotent, so the
 * only cost is a few empty deletes.
 */
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { ERROR_LOG_SOURCE } from '../enums/index.js';
import { purgeOldErrors, recordError } from '../services/error-log.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60_000;

let timer = null;
let firstRun = null;

async function tick() {
  try {
    await purgeOldErrors();
  } catch (error) {
    logger.error('[error-log] purge failed', error);
    void recordError({ source: ERROR_LOG_SOURCE.JOB, error, message: `Error log purge failed: ${error.message}` });
  }
}

export function startErrorLogPurge() {
  if (timer || !env.ERROR_LOG_ENABLED) return;

  firstRun = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
  firstRun.unref();
  timer = setInterval(() => void tick(), DAY_MS);
  timer.unref();

  logger.info(`Error log purge scheduled: daily, keeping ${env.ERROR_LOG_RETENTION_DAYS} days`);
}

export function stopErrorLogPurge() {
  clearTimeout(firstRun);
  clearInterval(timer);
  firstRun = null;
  timer = null;
}

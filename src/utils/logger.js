/**
 * Minimal leveled logger. Generic enough to swap for pino later without
 * touching call sites.
 */
const LEVEL_COLOURS = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';

function write(level, message, detail) {
  const stamp = new Date().toISOString();
  const colour = LEVEL_COLOURS[level] ?? '';
  const line = `${colour}[${stamp}] ${level.toUpperCase()}${RESET} ${message}`;

  if (detail instanceof Error) {
    console[level === 'debug' ? 'log' : level](line, '\n', detail.stack ?? detail.message);
    return;
  }
  if (detail !== undefined) {
    console[level === 'debug' ? 'log' : level](line, detail);
    return;
  }
  console[level === 'debug' ? 'log' : level](line);
}

export const logger = {
  info: (message, detail) => write('info', message, detail),
  warn: (message, detail) => write('warn', message, detail),
  error: (message, detail) => write('error', message, detail),
  debug: (message, detail) => {
    if (process.env.NODE_ENV !== 'production') write('debug', message, detail);
  },
};

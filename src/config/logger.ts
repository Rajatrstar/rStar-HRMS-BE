import { AsyncLocalStorage } from 'node:async_hooks';
import { pino, type Logger } from 'pino';
import { env, isDevelopment } from './env.js';

/**
 * Root logger. The redact list is the last line of defence against credentials reaching
 * log storage - add to it whenever a new sensitive field enters a logged payload.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'rstar-hrms-be' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      '*.passwordHash',
      '*.currentPassword',
      '*.newPassword',
      '*.accessToken',
      '*.refreshToken',
      '*.tokenHash',
    ],
    censor: '[REDACTED]',
  },
  ...(isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export interface RequestContext {
  requestId: string;
  logger: Logger;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

/**
 * The request-scoped logger when called inside a request, the root logger otherwise.
 * Lets services log with a request id without threading it through every signature.
 */
export function getLogger(): Logger {
  return storage.getStore()?.logger ?? logger;
}

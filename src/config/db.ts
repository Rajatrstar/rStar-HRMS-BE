import { PrismaMssql } from '@prisma/adapter-mssql';
import { PrismaClient } from '../generated/prisma/client.js';
import { env, isDevelopment } from './env.js';
import { logger } from './logger.js';

/**
 * Prisma 7 connects through a driver adapter rather than a bundled engine. The adapter
 * understands Prisma's own `sqlserver://host:1433;database=...` URL format, so DATABASE_URL
 * is handed over verbatim.
 */
const adapter = new PrismaMssql(env.DATABASE_URL);

export const prisma = new PrismaClient({
  adapter,
  log: isDevelopment ? [{ emit: 'event', level: 'query' }, 'warn', 'error'] : ['warn', 'error'],
});

if (isDevelopment) {
  prisma.$on('query', (e) => {
    logger.debug({ query: e.query, durationMs: e.duration }, 'prisma query');
  });
}

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info('Database connection established');
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Database connection closed');
}

/** Cheap liveness probe for the readiness endpoint. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error({ err: error }, 'Database ping failed');
    return false;
  }
}

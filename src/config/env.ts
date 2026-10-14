import 'dotenv/config';
import { z } from 'zod';

/**
 * Every environment variable the app reads, declared once. Parsed at import time so a
 * misconfigured deployment fails at boot with a readable message instead of throwing a
 * confusing `undefined` somewhere inside a request months later.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    API_PREFIX: z.string().startsWith('/').default('/api/v1'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    // 32 chars is the floor for an HS256 secret worth having.
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('7d'),
    JWT_ISSUER: z.string().default('rstar-hrms'),
    JWT_AUDIENCE: z.string().default('rstar-hrms-api'),

    /** Comma-separated allowlist. Empty means "same-origin only" - never a wildcard. */
    CORS_ORIGINS: z.string().default(''),

    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

    MAX_FAILED_LOGINS: z.coerce.number().int().positive().default(5),
    ACCOUNT_LOCK_MINUTES: z.coerce.number().int().positive().default(15),

    /** Hop count for X-Forwarded-For. 0 disables proxy trust; use 1 behind Azure App Service. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

    SEED_ADMIN_EMAIL: z.email().optional(),
    SEED_ADMIN_PASSWORD: z.string().min(12).optional(),
  })
  .refine((e) => e.JWT_ACCESS_SECRET !== e.JWT_REFRESH_SECRET, {
    message: 'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values',
    path: ['JWT_REFRESH_SECRET'],
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // Logger depends on env, so this one case has to use the console directly.
  console.error(`Invalid environment configuration:\n${details}`);
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';

/** Parsed CORS allowlist. An empty array disables cross-origin browser access entirely. */
export const corsOrigins: string[] = env.CORS_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

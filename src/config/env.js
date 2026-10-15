/**
 * Reads and validates process.env once, at import time.
 *
 * Values arrive via `node --env-file-if-exists=.env` (see package.json scripts),
 * so there is no dotenv dependency. A missing or malformed variable kills the
 * process here with a readable message rather than surfacing as a connection
 * timeout ten seconds into startup.
 */

/** @returns {string} */
function required(key) {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
        'Copy .env.example to .env and fill it in.',
    );
  }
  return value.trim();
}

function optional(key, fallback) {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function toInt(key, fallback) {
  const raw = optional(key, String(fallback));
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, got "${raw}".`);
  }
  return parsed;
}

function toBool(key, fallback) {
  return optional(key, String(fallback)).toLowerCase() === 'true';
}

export const env = Object.freeze({
  NODE_ENV: optional('NODE_ENV', 'development'),
  PORT: toInt('PORT', 5000),
  CORS_ORIGIN: optional('CORS_ORIGIN', '*'),

  DB_HOST: required('DB_HOST'),
  DB_PORT: toInt('DB_PORT', 1433),
  DB_NAME: required('DB_NAME'),
  DB_USER: required('DB_USER'),
  DB_PASSWORD: required('DB_PASSWORD'),
  DB_ENCRYPT: toBool('DB_ENCRYPT', true),
  DB_TRUST_SERVER_CERTIFICATE: toBool('DB_TRUST_SERVER_CERTIFICATE', true),

  // Separate secrets, so a leaked access secret cannot be used to mint refresh
  // tokens. Both are required: a default would silently ship to production.
  JWT_ACCESS_SECRET: required('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET'),
  JWT_ACCESS_EXPIRES_IN: optional('JWT_ACCESS_EXPIRES_IN', '15m'),
  JWT_REFRESH_EXPIRES_IN: optional('JWT_REFRESH_EXPIRES_IN', '7d'),

  BCRYPT_SALT_ROUNDS: toInt('BCRYPT_SALT_ROUNDS', 12),
  OTP_LENGTH: toInt('OTP_LENGTH', 6),
  OTP_EXPIRY_MINUTES: toInt('OTP_EXPIRY_MINUTES', 5),

  // Returns the OTP in the login response so a client (Postman, a test script)
  // can complete the two-step login without a human reading the server log.
  // Off by default, and ignored outright in production - see OTP_IN_RESPONSE below.
  OTP_IN_RESPONSE: toBool('OTP_IN_RESPONSE', false),
});

export const isProduction = env.NODE_ENV === 'production';

/**
 * Whether the login response may echo the OTP.
 *
 * Two gates, deliberately: the flag must be on AND the process must not be in
 * production. A single flag would leak every OTP to anyone who could call the
 * endpoint if it were ever set wrong on a deployed server.
 */
export const exposeOtpInResponse = env.OTP_IN_RESPONSE && !isProduction;

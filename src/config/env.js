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

const DB_HOST = required('DB_HOST');

/**
 * Whether we are pointed at Azure SQL Database rather than a SQL Server you
 * can walk up to.
 *
 * Derived from the host instead of being its own flag, because a flag can
 * disagree with the host name and the defaults it drives — encryption, patient
 * timeouts, retrying a connect — are exactly the ones you must not get wrong
 * by forgetting to flip a second setting.
 */
const IS_AZURE_SQL = /\.database\.windows\.net$/i.test(DB_HOST);

/**
 * Which spelling of the default-OTP switch is actually set.
 *
 * The flag is written DefaultOTP in the .env the team passes around, while
 * every other variable here is SCREAMING_SNAKE. process.env is
 * case-insensitive on Windows and case-sensitive everywhere else, so reading
 * one spelling alone would work on a developer's laptop and then silently do
 * nothing in a Linux container - the exact failure the flag exists to avoid.
 */
const DEFAULT_OTP_KEY =
  ['DEFAULT_OTP', 'DefaultOTP'].find(
    (key) => process.env[key] !== undefined && process.env[key].trim() !== '',
  ) ?? 'DEFAULT_OTP';

export const env = Object.freeze({
  NODE_ENV: optional('NODE_ENV', 'development'),
  PORT: toInt('PORT', 5000),
  CORS_ORIGIN: optional('CORS_ORIGIN', '*'),

  DB_HOST,
  DB_PORT: toInt('DB_PORT', 1433),
  DB_NAME: required('DB_NAME'),
  DB_USER: required('DB_USER'),
  DB_PASSWORD: required('DB_PASSWORD'),
  DB_ENCRYPT: toBool('DB_ENCRYPT', true),
  // A local instance presents a self-signed certificate that no CA vouches
  // for, so it has to be trusted blindly. Azure SQL does not, so the default
  // flips and the check below refuses to let it be turned off.
  DB_TRUST_SERVER_CERTIFICATE: toBool('DB_TRUST_SERVER_CERTIFICATE', !IS_AZURE_SQL),

  // Azure is allowed to be slow before it is allowed to be broken: a
  // serverless database that has auto-paused takes tens of seconds to resume,
  // and 15 seconds would turn every first request of the morning into an
  // outage.
  DB_CONNECTION_TIMEOUT_MS: toInt('DB_CONNECTION_TIMEOUT_MS', IS_AZURE_SQL ? 30_000 : 15_000),
  DB_REQUEST_TIMEOUT_MS: toInt('DB_REQUEST_TIMEOUT_MS', IS_AZURE_SQL ? 60_000 : 30_000),
  DB_POOL_MAX: toInt('DB_POOL_MAX', 10),
  // Retries are for transient Azure failures only (see db.js) — a wrong
  // password still fails on the first attempt.
  DB_CONNECT_RETRIES: toInt('DB_CONNECT_RETRIES', IS_AZURE_SQL ? 5 : 1),

  // Bring the schema up to date at startup, the way the Python service next
  // door calls create_all() from its lifespan: point the app at an empty
  // database and it builds itself. On by default because the alternative -
  // a server that starts happily and 500s on the first query because nobody
  // ran the migration step - is the worse failure.
  //
  // Turn it off where something else owns the schema: a CI deploy stage, a
  // DBA, or a read-only replica.
  DB_AUTO_MIGRATE: toBool('DB_AUTO_MIGRATE', true),

  // Separate secrets, so a leaked access secret cannot be used to mint refresh
  // tokens. Both are required: a default would silently ship to production.
  JWT_ACCESS_SECRET: required('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET'),
  JWT_ACCESS_EXPIRES_IN: optional('JWT_ACCESS_EXPIRES_IN', '15m'),
  JWT_REFRESH_EXPIRES_IN: optional('JWT_REFRESH_EXPIRES_IN', '7d'),

  BCRYPT_SALT_ROUNDS: toInt('BCRYPT_SALT_ROUNDS', 12),
  OTP_LENGTH: toInt('OTP_LENGTH', 6),
  // 10 rather than 5: a burst of logins queues a burst of mail, and the last
  // person in the queue must still have a usable code when theirs arrives.
  OTP_EXPIRY_MINUTES: toInt('OTP_EXPIRY_MINUTES', 10),

  // Returns the OTP in the login response so a client (Postman, a test script)
  // can complete the two-step login without a human reading the server log.
  // Off by default, and ignored outright in production - see OTP_IN_RESPONSE below.
  OTP_IN_RESPONSE: toBool('OTP_IN_RESPONSE', false),

  // Development only: every OTP issued is DEFAULT_OTP_CODE and no outbound
  // mail is queued or delivered, so a login can be completed on a machine
  // with no mailbox and no SMTP credentials. Hard-ignored in production -
  // see useDefaultOtp below.
  DEFAULT_OTP: toBool(DEFAULT_OTP_KEY, false),
  DEFAULT_OTP_CODE: optional('DEFAULT_OTP_CODE', '123456'),

  // Outbound mail. All optional: the server must still boot on a machine that
  // has no SMTP credentials, with queued mail rendered to the log instead.
  MAIL_ENABLED: toBool('MAIL_ENABLED', false),
  MAIL_HOST: optional('MAIL_HOST', 'smtp.office365.com'),
  MAIL_PORT: toInt('MAIL_PORT', 587),
  // Port 587 upgrades to TLS with STARTTLS, so the socket does NOT start
  // encrypted. Set true only for implicit TLS on port 465.
  MAIL_SECURE: toBool('MAIL_SECURE', false),
  MAIL_USER: optional('MAIL_USER', ''),
  MAIL_PASSWORD: optional('MAIL_PASSWORD', ''),
  MAIL_FROM_NAME: optional('MAIL_FROM_NAME', 'rSTAR HRMS'),
  MAIL_FROM_ADDRESS: optional('MAIL_FROM_ADDRESS', ''),

  // Rate limiting. Off switch included because an integration test suite that
  // fires hundreds of requests in a second would otherwise throttle itself.
  RATE_LIMIT_ENABLED: toBool('RATE_LIMIT_ENABLED', true),
  RATE_LIMIT_WINDOW_MINUTES: toInt('RATE_LIMIT_WINDOW_MINUTES', 15),
  // Per IP, across the whole API.
  RATE_LIMIT_MAX: toInt('RATE_LIMIT_MAX', 300),
  // Per IP, on /auth only. Generous on purpose: a whole office behind one NAT
  // address shares this bucket, and 20 locked every one of them out of a 10 AM
  // login rush. The real brute-force defence is the per-account tier below,
  // which an attacker cannot escape by changing IP - this tier only stops
  // crude floods.
  RATE_LIMIT_AUTH_MAX: toInt('RATE_LIMIT_AUTH_MAX', 300),
  // Per ACCOUNT, on the endpoints that check a credential. Keyed by email, so
  // rotating IPs does not buy an attacker more guesses at one account.
  RATE_LIMIT_CREDENTIAL_MAX: toInt('RATE_LIMIT_CREDENTIAL_MAX', 5),
  // Per ACCOUNT, on the endpoints that SEND an email. Caps mail cost and stops
  // the API being used to flood somebody's inbox.
  RATE_LIMIT_OTP_SEND_MAX: toInt('RATE_LIMIT_OTP_SEND_MAX', 3),

  // Access control. Resolving a permission set is a handful of index seeks,
  // but it would otherwise happen on every authenticated request forever.
  // The off switch is how you bisect "permissions bug or cache bug".
  ACCESS_CONTROL_CACHE_ENABLED: toBool('ACCESS_CONTROL_CACHE_ENABLED', true),
  ACCESS_CONTROL_CACHE_TTL_SECONDS: toInt('ACCESS_CONTROL_CACHE_TTL_SECONDS', 60),
  ACCESS_CONTROL_CACHE_MAX_ENTRIES: toInt('ACCESS_CONTROL_CACHE_MAX_ENTRIES', 1000),
  // How often each instance checks whether another one changed a role. A
  // per-request check would be the round trip the cache exists to remove.
  ACCESS_CONTROL_STAMP_POLL_SECONDS: toInt('ACCESS_CONTROL_STAMP_POLL_SECONDS', 5),

  MAIL_POLL_SECONDS: toInt('MAIL_POLL_SECONDS', 15),
  MAIL_BATCH_SIZE: toInt('MAIL_BATCH_SIZE', 25),
  MAIL_MAX_ATTEMPTS: toInt('MAIL_MAX_ATTEMPTS', 5),
});

export const isProduction = env.NODE_ENV === 'production';

/** True when DB_HOST is an Azure SQL logical server. */
export const isAzureSql = IS_AZURE_SQL;

/**
 * Two settings that are merely unwise locally are a hole in the wire against
 * Azure, and both fail in ways that do not look like themselves: an
 * unencrypted connection is simply refused, and a blindly trusted certificate
 * fails silently — by working.
 *
 * Checked here rather than in db.js so a misconfigured deployment dies at
 * import time, before it can serve a single request over that connection.
 */
if (IS_AZURE_SQL) {
  if (!env.DB_ENCRYPT) {
    throw new Error(
      'DB_ENCRYPT=false cannot be used with Azure SQL: the service only accepts encrypted ' +
        'connections. Remove it or set DB_ENCRYPT=true.',
    );
  }
  if (env.DB_TRUST_SERVER_CERTIFICATE) {
    throw new Error(
      'DB_TRUST_SERVER_CERTIFICATE=true cannot be used with Azure SQL. Its certificate is issued ' +
        'by a public CA and validates on its own; trusting any certificate only disables the ' +
        'check that would catch an interception. Set DB_TRUST_SERVER_CERTIFICATE=false.',
    );
  }
}

/**
 * Whether the login response may echo the OTP.
 *
 * Two gates, deliberately: the flag must be on AND the process must not be in
 * production. A single flag would leak every OTP to anyone who could call the
 * endpoint if it were ever set wrong on a deployed server.
 */
export const exposeOtpInResponse = env.OTP_IN_RESPONSE && !isProduction;

/**
 * Whether every OTP is the fixed development code and outbound mail is
 * suppressed.
 *
 * Two gates, like exposeOtpInResponse, and for a harder reason: a constant
 * second factor is no second factor at all. Anyone who learned one password -
 * or walked off with a hash list - would be through. The production check is
 * what makes the flag safe to leave in a shared .env.
 */
export const useDefaultOtp = env.DEFAULT_OTP && !isProduction;

/** True while DefaultOTP is suppressing mail; the outbox is bypassed entirely. */
export const suppressOutboundMail = useDefaultOtp;

if (env.DEFAULT_OTP && isProduction) {
  // Not fatal - the server is safe, it is simply behaving the way production
  // should. But the person who set the flag is expecting a fixed code and
  // will otherwise read "my OTP email never arrives" as a broken mail server.
  console.warn(
    '[env] DefaultOTP is set but NODE_ENV=production, so it is ignored: real OTPs are ' +
      'generated and real mail is sent.',
  );
}

if (useDefaultOtp && !new RegExp(`^[0-9]{${env.OTP_LENGTH}}$`).test(env.DEFAULT_OTP_CODE)) {
  // The login endpoint validates the submitted OTP against OTP_LENGTH before
  // it ever reaches a comparison, so a mismatched code here would make every
  // single login fail validation with nothing pointing at this setting.
  throw new Error(
    `DEFAULT_OTP_CODE must be exactly ${env.OTP_LENGTH} digits to match OTP_LENGTH, got ` +
      `"${env.DEFAULT_OTP_CODE}". Change one of the two so they agree.`,
  );
}

/**
 * Whether real mail can actually be sent.
 *
 * Enabling the flag without credentials would fail on every single outbox row
 * and burn through the retry budget, so the username and password are part of
 * the test rather than the flag alone.
 */
export const mailEnabled =
  env.MAIL_ENABLED && env.MAIL_USER !== '' && env.MAIL_PASSWORD !== '' && !suppressOutboundMail;

/**
 * The From address. Microsoft 365 rejects a From that is not the authenticated
 * mailbox unless that mailbox has Send As rights, so the login is the default.
 */
export const mailFromAddress = env.MAIL_FROM_ADDRESS || env.MAIL_USER;

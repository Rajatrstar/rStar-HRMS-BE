# rSTAR HRMS — Backend

Node.js + Express 5 REST API on SQL Server. Plain JavaScript (ESM), no build step.

## Requirements

- Node.js >= 22 (developed on 24)
- SQL Server with the `rStarHRMS` database

## Getting started

```bash
npm install
cp .env.example .env     # then fill in DB_PASSWORD and the two JWT secrets
npm run db:migrate       # creates the tables
npm run db:seed          # creates admin@rstartec.com / admin
npm run dev              # http://localhost:5000/api/v1
```

| Script               | Does                                                      |
| -------------------- | --------------------------------------------------------- |
| `npm run dev`        | Starts under **nodemon**, reloads on file change (`nodemon.json`) |
| `npm run dev:node`   | Same, using Node's built-in `--watch` instead of nodemon   |
| `npm start`          | Starts once, no watcher                                    |
| `npm run db:migrate` | Applies new files in `db/migrations`, once each            |
| `npm run db:seed`    | Creates or resets a login — defaults to `admin@rstartec.com` / `admin` |

Seed a different account with `npm run db:seed -- someone@rstartec.com theirPassword`.

Both load `.env` through Node's own `--env-file-if-exists`, so there is no `dotenv` dependency.

nodemon watches `src/` and `.env` for `.js`/`.json`/`.sql` changes; `postman/`, `scripts/`
and `db/migrations/` are ignored so editing a collection or a migration does not bounce the
server. Type `rs` + Enter in the terminal to force a restart.

## Endpoints

| Method | Path                      | Auth   | Purpose                                      |
| ------ | ------------------------- | ------ | -------------------------------------------- |
| GET    | `/api/v1/health`          | —      | Liveness — is the process up?                 |
| GET    | `/api/v1/health/ready`    | —      | Readiness — `503` when the database is down  |
| POST   | `/api/v1/auth/login`      | —      | Step 1: check email + password, issue an OTP  |
| POST   | `/api/v1/auth/verify-otp` | —      | Step 2: check the OTP, return the token pair  |
| POST   | `/api/v1/auth/resend-otp` | —      | Issue a fresh OTP for a login in progress     |
| POST   | `/api/v1/auth/refresh`    | —      | Exchange a refresh token for a new pair       |
| GET    | `/api/v1/auth/me`         | Bearer | The signed-in account                         |

Every response uses the same envelope:

```json
{ "success": true, "message": "Service is healthy", "data": { } }
```

## Logging in

Login is two steps: the password is checked first, then a one-time passcode.

```bash
# 1. password -> OTP
curl -X POST http://localhost:5000/api/v1/auth/login   -H "Content-Type: application/json"   -d '{"email":"admin@rstartec.com","password":"admin"}'
# { "data": { "otpRequired": true, "otpExpiresTime": "...", "expiresInSeconds": 300 } }
```

No mail provider is wired up yet, so **the OTP is written to the server log**:

```
[2026-10-14T09:55:12.158Z] INFO OTP for admin@rstartec.com: 512774 (valid 5 min)
```

Note that Node buffers stdout when it is redirected to a file, so the line can
lag behind the request. Reading it straight from the console (`npm run dev`) is
immediate. To send real mail, replace the single `logger.info` call in
`services/auth.service.js` — nothing else in the flow changes.

```bash
# 2. OTP -> tokens
curl -X POST http://localhost:5000/api/v1/auth/verify-otp   -H "Content-Type: application/json"   -d '{"email":"admin@rstartec.com","otp":"512774"}'
# { "data": { "accessToken": "...", "refreshToken": "...", "tokenType": "Bearer", "expiresIn": "15m" } }

# 3. use it
curl http://localhost:5000/api/v1/auth/me -H "Authorization: Bearer <accessToken>"
```

An OTP works once, expires after `OTP_EXPIRY_MINUTES`, and is replaced whenever
a new login starts.

## Postman

`postman/rSTAR-HRMS-API.postman_collection.json` — import that one file into
Postman and run the requests top to bottom.

**No bearer token is ever pasted.** Collection auth is set once to
`Bearer {{accessToken}}`; the test script on `verify-otp` writes the token into
that variable and every request inherits it. Request 4 (`me`) sends no
Authorization header of its own, so it passing is the proof the middleware
accepted a token nobody copied. Request 5 is the same endpoint with auth
switched off, expecting `401`.

Import the matching environment too:

```
postman/Local.postman_environment.json      baseUrl + the seeded login
postman/Staging.postman_environment.json    placeholders, password left empty
```

`{{baseUrl}}` also exists as a collection variable, so the collection runs even
with no environment selected. An environment overrides it — that is how you
point the same requests at another host. Tokens are deliberately **not** in the
environment: an environment variable outranks a collection one and would shadow
what the scripts write.

Headless:

```bash
postman collection run postman/rSTAR-HRMS-API.postman_collection.json   -e postman/Local.postman_environment.json
```

The same flow in plain curl:

```bash
./scripts/api-flow.sh
BASE_URL=https://hrms-staging.rstartec.com/api/v1 ./scripts/api-flow.sh
```

## Exposing the local API with ngrok

```bash
# agent lives at %LOCALAPPDATA%
grok
grok.exe (not on PATH)
"$LOCALAPPDATA/ngrok/ngrok.exe" http 5000
```

The public URL is printed by the agent and is also readable at
`http://127.0.0.1:4040/api/tunnels`. It changes every restart on the free plan,
so update `postman/Ngrok.postman_environment.json` each session (or use a
reserved domain on a paid plan).

Two things that bite:

- **ngrok free serves an HTML interstitial** to browser-like clients instead of
  your JSON. Send `ngrok-skip-browser-warning: true`. The collection does this
  automatically whenever `{{baseUrl}}` contains `ngrok`; a browser frontend has
  to send it itself.
- **The tunnel is public.** Anyone with the URL reaches your machine and the
  real database. Keep `OTP_IN_RESPONSE=false`, never use a weak password while
  the tunnel is open, and stop the agent when you are done.

With `OTP_IN_RESPONSE=false`, the collection cannot complete a login unattended
by design — run `login`, take the OTP from the server console, put it in the
`otp` variable, then run `verify-otp` onwards.

### What the auth code deliberately does

- **An unknown email and a wrong password return the identical 401**, and both
  spend the same time hashing (`fakeVerifyPassword`). Otherwise the endpoint
  answers faster for addresses that do not exist, which hands an attacker a
  list of your staff.
- **Access and refresh tokens use different secrets and carry a `type` claim**,
  so a refresh token cannot be replayed as an access token.
- **Refresh tokens are stateless** — there is no stored token, so signing out
  cannot revoke one before it expires. If you need that, add a
  `RefreshTokenHash` column and compare on refresh.
- **The OTP is stored in plain text** in a short-lived column, which matches the
  schema as specified. Hashing it is a small change in `auth.service.js` if you
  want defence against someone reading the table.
- **`OTP_IN_RESPONSE` returns the OTP in the login response** so Postman and
  the curl script can finish a login unattended. It is off by default and
  **ignored outright when `NODE_ENV=production`**, so a misconfigured deploy
  cannot leak one-time codes to callers.
- **Passwords are capped at 72 characters** because bcrypt ignores anything
  beyond 72 bytes; rejecting it is honest, silently truncating is not.

## Layout

```
src/
├── index.js          process entry: connect DB, listen, graceful shutdown
├── app.js            express app: middleware, router mount, 404, error handler
├── config/           env.js (validated settings), db.js (connection pool)
├── enums/            route paths, HTTP status codes, response messages
├── routes/           path -> controller mapping only
├── controllers/      req/res handling only
├── services/         business logic and SQL; never sees req/res
├── middlewares/      404 and central error handler
├── helpers/          app-aware shared logic (query binding, response envelope)
└── utils/            generic primitives (ApiError, logger, jwt, password, otp)

db/migrations/        .sql files applied in order by `npm run db:migrate`
scripts/              migrate.js and seed.js
```

**Request flow:** `routes` → `controllers` → `services` → `helpers` → `config/db`.
Each layer only calls the one to its right. A controller never writes SQL; a
service never touches `req` or `res`.

`helpers/` vs `utils/`: a helper knows about this app (binding SQL parameters,
shaping a response); a util would work in any project (an error class, a logger).

## Adding a module

Four files and two enum lines — say, employees:

1. `src/enums/api-routes.enum.js` — add `EMPLOYEES: '/employees'` to `ROUTE_GROUP`,
   and an `EMPLOYEES` block to `ROUTES` with its endpoints.
2. `src/services/employee.service.js` — the logic, using `query`/`queryOne`/`mutate`
   from `helpers/query.helper.js`.
3. `src/controllers/employee.controller.js` — call the service, reply via `sendSuccess`.
4. `src/routes/employee.routes.js` — map `ROUTES.EMPLOYEES.*` to controller methods.
5. `src/routes/index.js` — `router.use(ROUTE_GROUP.EMPLOYEES, employeeRoutes)`.

No path string is ever written outside `api-routes.enum.js`.

## Writing queries

Always parameterize — never build SQL with string concatenation:

```js
import { query, queryOne, mutate, withTransaction, sql } from '../helpers/query.helper.js';

const rows = await query('SELECT * FROM employees WHERE status = @status', {
  status: { type: sql.NVarChar(20), value: 'ACTIVE' },
});
```

`withTransaction` wraps several statements in one commit/rollback.

## Errors

Throw from anywhere; Express 5 routes rejected promises to the error handler:

```js
import { ApiError } from '../utils/api-error.js';

throw ApiError.notFound('Employee does not exist');
```

An `ApiError` message reaches the client. Any other thrown error is logged in
full and reported as a generic `500`, so internals never leak.

## Connecting to SQL Server

`.env` points at a **host and port**, not a named instance:

```
DB_HOST=localhost
DB_PORT=1433
```

Resolving `HOST\SQLEXPRESS` requires the *SQL Server Browser* service on UDP
1434. It is commonly disabled, and the failure looks like an unexplained
connect timeout. Find the real port in SQL Server Configuration Manager under
*TCP/IP → IP Addresses → IPAll → TCP Port*.

The local instance presents a self-signed certificate, so
`DB_TRUST_SERVER_CERTIFICATE=true`. Against a real server with a proper
certificate, set it to `false`.

Quick check that the server is reachable, independent of Node:

```bash
sqlcmd -S localhost,1433 -U sa -P <password> -C -Q "SELECT DB_NAME()"
```

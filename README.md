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
| `npm run db:seed`    | Creates an employee **and** their login — defaults to `admin@rstartec.com` / `admin`. No role |
| `npm run db:seed:employees` | Creates a couple of sample employees. They have no login and cannot sign in |
| `npm run db:seed:permissions` | Syncs the permission catalog and the five master roles |
| `npm run db:create:admin` | Creates a login **+** profile **+** role — a usable administrator |
| `npm run db:verify`  | Checks every model in `src/models` against the live schema |
| `npm run mail:test`  | Sends one real email to prove the SMTP settings work       |

Seed a different account with `npm run db:seed -- someone@rstartec.com theirPassword`.

**An administrator is three rows, not one**, and missing the third is silent — the
account logs in and then holds zero permissions, so every endpoint answers `403`
with nothing to explain it. The order matters: `dbo.tblEmployeeDetails` is the root
of the schema and `dbo.EmployeeLogin.EmployeeDetailId` is **NOT NULL**, so the
person is created first and the credentials point at them.

`db:seed:employees` writes the employee, `db:seed` writes an employee **and** a
login, and **neither writes the role**. That is what `db:create:admin` is for:

```bash
EMAIL=someone@rstartec.com FIRST_NAME=Super LAST_NAME=Admin npm run db:create:admin
```

It creates all three in one transaction, generates and prints a password when it
makes a new login, and is idempotent — re-running adds only what is missing and
never touches an existing password unless you ask:

```bash
EMAIL=someone@rstartec.com PASSWORD='NewPass@123' RESET_PASSWORD=1 npm run db:create:admin
EMAIL=hr@rstartec.com ROLE=HR_ADMIN npm run db:create:admin   # any code from tblRole
```

That bootstraps the **first** administrator. Every role, group and override
after that goes through the access-control API below.

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
| POST   | `/api/v1/auth/forgot-password` | —  | Check work email + date of birth, email a reset code |
| POST   | `/api/v1/auth/reset-password`  | —  | Exchange that code for a new password          |
| POST   | `/api/v1/auth/refresh`    | —      | Exchange a refresh token for a new pair       |
| GET    | `/api/v1/auth/me`         | Bearer | The signed-in account, plus `permissionsVersion` |

Organisation setup. Every one of these needs a bearer token **and** the permission
named beside it — today only Super Admin and HR Admin hold any of them:

| Method | Path                                                       | Permission                     |
| ------ | ---------------------------------------------------------- | ------------------------------ |
| GET    | `/api/v1/organizations`                                     | `organization.view`            |
| GET    | `/api/v1/organizations/types`                               | `organization.view`            |
| POST   | `/api/v1/organizations`                                     | `organization.create`          |
| GET    | `/api/v1/organizations/:organizationId`                     | `organization.view`            |
| PUT    | `/api/v1/organizations/:organizationId`                     | `organization.update`          |
| GET    | `/api/v1/organizations/:organizationId/locations`           | `organization-location.view`   |
| POST   | `/api/v1/organizations/:organizationId/locations`           | `organization-location.create` |
| GET    | `/api/v1/organizations/:organizationId/locations/:locationId` | `organization-location.view`   |
| PUT    | `/api/v1/organizations/:organizationId/locations/:locationId` | `organization-location.update` |
| DELETE | `/api/v1/organizations/:organizationId/locations/:locationId` | `organization-location.delete` |

There is deliberately no `DELETE /organizations/:id`: removing the organisation this
HRMS belongs to is a decommission, not an operation an endpoint should offer. Both
`PUT`s are a **full replace** — a field left out of the body is set to `NULL`.
Deleting a location is a soft delete and answers `409 LOCATION_IN_USE` while any
employee is still assigned to it.

Access control administration — three layers, one resolver:

| Layer | Example | How |
| ----- | ------- | --- |
| **Role** (RBAC) | Rahul is an Employee | `PUT /access/users/:id/roles` |
| **Override** (one person) | Rahul alone may also see every employee | `POST /access/users/:id/overrides` — `GRANT employees.view` at `ALL` |
| **Group** (many people) | The Finance team sees payroll reports | `POST /groups`, `PUT /groups/:id/permissions`, `POST /groups/:id/members` |

There is no `employees.view_all` permission: "view all" is `employees.view` at
scope `ALL`. One code, four reaches (`OWN` / `TEAM` / `DEPARTMENT` / `ALL`).

| Method | Path | Permission |
| ------ | ---- | ---------- |
| GET | `/api/v1/access/my-permissions` | any signed-in employee |
| GET | `/api/v1/permissions/catalog` | `permissions.view` |
| GET | `/api/v1/roles` · `/roles/:roleId` · `/roles/:roleId/permissions` | `roles.view` |
| POST | `/api/v1/roles` | `roles.create` |
| PATCH | `/api/v1/roles/:roleId` | `roles.update` |
| DELETE | `/api/v1/roles/:roleId` | `roles.delete` |
| PUT | `/api/v1/roles/:roleId/permissions` | `roles.assign-permission` |
| GET | `/api/v1/groups` · `/groups/:groupId` · `/permissions` · `/members` | `groups.view` |
| POST | `/api/v1/groups` | `groups.create` |
| PATCH | `/api/v1/groups/:groupId` | `groups.update` |
| DELETE | `/api/v1/groups/:groupId` | `groups.delete` |
| PUT | `/api/v1/groups/:groupId/permissions` | `groups.assign-permission` |
| POST / DELETE | `/api/v1/groups/:groupId/members[/:employeeDetailId]` | `groups.manage-member` |
| GET | `/api/v1/access/users/:employeeDetailId[/roles\|/groups\|/overrides\|/effective-permissions]` | `user-access.view` |
| PUT | `/api/v1/access/users/:employeeDetailId/roles` | `user-access.assign-role` |
| PUT | `/api/v1/access/users/:employeeDetailId/groups` | `user-access.manage-group` |
| POST / PATCH / DELETE | `/api/v1/access/users/:employeeDetailId/overrides[/:overrideId]` | `user-access.override` |

Holding the route's permission is necessary, not sufficient. Every write also
refuses, whatever the route guard said:

- **`403 ESCALATION_BLOCKED`** — granting, removing or rescoping anything you do
  not hold yourself at least as widely. Putting someone in a group or role (or
  taking them out) counts as granting everything it carries.
- **`409 SELF_LOCKOUT_BLOCKED`** — a change that would strip your own
  `roles.*`, `groups.*`, `permissions.*` or `user-access.*` permissions. Checked
  by re-running the real resolver inside the transaction, before commit.
- **`409 LAST_SUPER_ADMIN`** — removing the last active Super Admin.
- **`403 ROLE_IS_PROTECTED`** — renaming, deactivating or deleting one of the five
  system roles, or editing Super Admin's permissions (the seed re-syncs them).
- **`409 MODIFIED_ELSEWHERE`** — a matrix save whose `expectedModifiedAt` is stale.

Every write bumps `dbo.tblAccessControlStamp` and clears this instance's cache;
`src/workers/access-stamp.worker.js` clears every other instance's within
`ACCESS_CONTROL_STAMP_POLL_SECONDS`. The full contract, with payloads, is in
[docs/ACCESS-CONTROL-FRONTEND.md](docs/ACCESS-CONTROL-FRONTEND.md).

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
Postman. It is grouped into folders, one per area:

```
Health                    liveness, readiness. No auth
Auth                      login, OTP, refresh, password reset
Admin
  ├─ Organization         the company profile
  ├─ Locations            the location master
  └─ Access control       roles, overrides, groups - set {{targetEmployeeDetailId}} first
```

Requests are numbered **within** their folder, in the order they depend on each
other. First time through: run **Auth** top to bottom to capture the token, then
**Admin › Organization** before **Admin › Locations** — `create organization`
stores `{{organizationId}}`, and every location request reads it. After that any
request can be run on its own.

Each folder carries a description explaining what is in it and what it needs, so
the rules live next to the requests instead of only here.

**No bearer token is ever pasted.** Collection auth is set once to
`Bearer {{accessToken}}`; the test script on `Auth › 3. verify-otp` writes the
token into that variable and every request inherits it. `Auth › 4. me` sends no
Authorization header of its own, so it passing is the proof the middleware
accepted a token nobody copied. `Auth › 5.` is the same endpoint with auth
switched off, expecting `401`, and `Admin › Organization › 6.` does the same for
the organisation routes.

Import the matching environment too:

```
postman/Local.postman_environment.json      baseUrl + the seeded login
postman/Staging.postman_environment.json    placeholders, password left empty
```

Thirty-five requests. Every one asserts the response envelope, so a change to the
reply shape fails the run rather than slipping through.

`resend-otp` sits between login and verify-otp deliberately — it replaces the
live code, and after verify-otp succeeds there is no OTP left to resend.

Everything under **Admin** is permission-guarded, and today only Super Admin and
HR Admin hold any of those permissions. A `403` names the exact code it wanted in
`details.requiredPermission` — grant that code rather than guessing at a role.
`Admin › Locations › 3.` deliberately expects a `409`: one organisation may not
have two locations of the same name.

**`Auth › 8. reset-password` really changes a password.** It resets `{{forgotEmail}}`
(not `{{loginEmail}}`) to `{{newPassword}}`, a fixed value, so repeated runs are
idempotent. The employee needs a matching `WorkEmail` **and** `DateOfBirth` in
`dbo.tblEmployeeDetails` — `npm run db:seed:employees` sets both.

Two things scripts in this collection must not do:

- **never `const data = ...` at the top level of a script.** The sandbox already
  declares `data` for the current data-file row, so it is a redeclaration and
  the script dies with a `SyntaxError` before any test runs.
- **read variables with `pm.variables.get()`, not `pm.collectionVariables.get()`,**
  when asserting against what was sent. Only the former resolves through the
  scope chain and sees an environment override.

`{{baseUrl}}` also exists as a collection variable, so the collection runs even
with no environment selected. An environment overrides it — that is how you
point the same requests at another host. Tokens are deliberately **not** in the
environment: an environment variable outranks a collection one and would shadow
what the scripts write.

Headless:

```bash
postman collection run postman/rSTAR-HRMS-API.postman_collection.json   -e postman/Local.postman_environment.json

# One folder at a time, now that the collection has them:
postman collection run postman/rSTAR-HRMS-API.postman_collection.json   -e postman/Local.postman_environment.json --folder Auth
```

A folder that depends on an earlier one still needs that one to have run in the
same session — `Admin` on its own has no `{{accessToken}}` to inherit.

The same flow in plain curl:

```bash
./scripts/api-flow.sh
BASE_URL=https://hrms-staging.rstartec.com/api/v1 ./scripts/api-flow.sh

# The reset flow is opt-in there too - it is skipped unless an employee is named.
FORGOT_EMAIL=anmol.ghai@rstartec.com FORGOT_DOB=1995-06-12 ./scripts/api-flow.sh
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

### Rate limiting and the login rush

Four limiters, all configurable from `.env` (see `RATE_LIMIT_*` there):

| Tier | Keyed on | Default | Counts |
| ---- | -------- | ------- | ------ |
| `apiLimiter` | IP | 300 / 15 min | everything except `/health*` |
| `authLimiter` | IP | 300 / 15 min | every `/auth` request |
| `credentialLimiter` | **email** | 5 / 15 min | **failed** attempts only |
| `otpSendLimiter` | **email** | 3 / 15 min | **successful** requests only |

The per-account tiers are the real defence. An IP limit is sidestepped with a
proxy pool; keying on the submitted email means every attacker, from however
many addresses, shares five guesses per window against any one account — which
is what makes a six-digit OTP unguessable inside its ten-minute life.

The counting split follows what abuse looks like. Guessing is abusive when it
**fails**, so `credentialLimiter` ignores successes and nobody logging in
normally is ever throttled. Requesting an OTP is abusive when it **succeeds** —
each one costs an email — so `otpSendLimiter` ignores failures, and wrong
passwords cannot exhaust a real user's OTP budget.

**Why `authLimiter` is 300 and not 20.** An office behind one NAT address is a
single IP to this server. At 20, a simulated 10 AM rush of 70 home workers and
30 office staff locked out **every one of the 30**: the burst of logins spent
the shared budget, so their `verify-otp` calls were refused — 20 people holding
an OTP they could not use. Raising the IP tier fixes that without touching the
per-account limits that actually stop attacks.

**Capacity.** 100 simultaneous logins, measured end to end:

| | before | after |
| --- | --- | --- |
| wall clock, 100 people | 45 s | **7.9 s** |
| median login | 34 s | **3.3 s** |
| office staff locked out | 30 / 30 | **0** |

Three things got it there: the `authLimiter` default above, `@node-rs/bcrypt`
in place of `bcryptjs` (see `src/utils/password.js` — the win is the thread
pool, not per-hash speed), and a larger `MAIL_BATCH_SIZE` with a ten-minute
`OTP_EXPIRY_MINUTES` so the last code in a queued burst still arrives usable.

Counters live in process memory. One instance is fine; behind a load balancer
each keeps its own tally and the effective limit multiplies, so that is the
point to move to a shared store (`rate-limit-redis`). A restart also clears
them — an attacker's spent budget comes back, which is an argument for moving
account lockout into a column on `EmployeeLogin` rather than leaving it to the
limiter alone.

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

## Email

Mail is never sent from the request path. A caller renders a template and writes
one row to `dbo.EmailOutbox`; a worker started in `src/index.js` drains that
queue every `MAIL_POLL_SECONDS`. A dead mail server therefore delays email
instead of breaking login.

Sending one, from anywhere in the app:

```js
import { queueTemplatedMail } from '../services/email.service.js';
import { EMAIL_TEMPLATE } from '../enums/index.js';

await queueTemplatedMail({
  to: employee.email,
  template: EMAIL_TEMPLATE.OTP_LOGIN,
  data: { name, otp, minutes: 5 },
});
```

Pass the `run` callback from `withTransaction()` as a second argument to queue
the mail inside a wider transaction — `auth.service.js` does this so an account
can never hold an OTP whose email was never queued.

**Adding a template:** add an entry to `src/enums/email-template.enum.js`, then
drop `src/templates/<that-value>.html` next to its siblings. The file opens with
a front-matter block carrying the subject:

```html
---
subject: Your rSTAR HRMS login code
---
<p>Hi {{name}}, your code is {{otp}}.</p>
```

`{{key}}` is HTML-escaped, `{{{key}}}` is not, and a placeholder with no value
throws rather than mailing `{{nmae}}` to someone. An optional `<name>.txt`
sibling supplies the plain-text part; without one it is derived from the HTML.
Startup fails if an enum entry has no file.

**Without credentials** (`MAIL_ENABLED=false`, the default) mail is still queued
and the worker writes the rendered message to the server log, marking the row
`Sent` with a note saying nothing was delivered. The whole flow is testable
before a mailbox exists.

**With Office 365**, fill in `MAIL_USER` / `MAIL_PASSWORD`, set
`MAIL_ENABLED=true`, then `npm run mail:test -- you@rstartec.com`. Three things
make a correct password fail: SMTP AUTH disabled on the mailbox, MFA on the
mailbox, or a `MAIL_FROM_ADDRESS` that is not the authenticated mailbox. See
`.env.example`.

> Microsoft disables SMTP basic authentication by default for existing tenants
> at the end of **December 2026**, and tenants created after that cannot use it
> at all. The switch to OAuth2 is confined to the `auth` block in
> `src/utils/mailer.js`.

**Inspecting the queue:** `dbo.EmailOutbox` carries filtered indexes, so SQL
Server rejects DML on it unless `QUOTED_IDENTIFIER` is ON. SSMS and the app
driver set it; `sqlcmd` does not, so use `sqlcmd -I` when querying it by hand.

## Layout

```
src/
├── index.js          process entry: connect DB, listen, graceful shutdown
├── app.js            express app: middleware, router mount, 404, error handler
├── config/           env.js (validated settings), db.js (connection pool)
├── enums/            route paths, HTTP status codes, response messages
├── models/           one file per table: columns, SQL types, select lists
├── routes/           path -> controller mapping only
├── controllers/      req/res handling only
├── services/         business logic and SQL; never sees req/res
├── middlewares/      404 and central error handler
├── helpers/          app-aware shared logic (query binding, response envelope)
├── utils/            generic primitives (ApiError, logger, jwt, password, otp)
├── templates/        email bodies, one .html per EMAIL_TEMPLATE entry
└── workers/          background loops (outbox mail sender)

db/migrations/        .sql files applied in order by `npm run db:migrate`
scripts/              migrate.js, seed.js, send-test-email.js, verify-schema.js
```

**Request flow:** `routes` → `controllers` → `services` → `helpers` → `config/db`.
Each layer only calls the one to its right. A controller never writes SQL; a
service never touches `req` or `res`.

`helpers/` vs `utils/`: a helper knows about this app (binding SQL parameters,
shaping a response); a util would work in any project (an error class, a logger).

## Access control

Roles, groups, per-user overrides and row-level scope. Two documents:

| Doc | For |
| --- | --- |
| [docs/ACCESS-CONTROL.md](docs/ACCESS-CONTROL.md) | Backend: how it decides, and how to change it |
| [docs/ACCESS-CONTROL-FRONTEND.md](docs/ACCESS-CONTROL-FRONTEND.md) | Frontend: the contract, the screens, the UI patterns |

The short version: `src/enums/permission.enum.js` is the catalog and the source
of truth, `npm run db:seed:permissions` syncs it into the database, and a route
is guarded with `requirePermission(PERMISSION.SOMETHING)` from
`src/middlewares/permission.middleware.js`.

## Response contract

Every endpoint replies with the same envelope, success or failure. Clients parse
one shape and never branch on the route:

```jsonc
// success
{ "success": true,  "statusCode": 200, "message": "Login successful", "data": { } }

// failure
{ "success": false, "statusCode": 400, "message": "The submitted data is invalid",
  "data": null, "details": { "email": "Email is required" } }
```

| Key | Always present | Notes |
| --- | -------------- | ----- |
| `success` | yes | Derived from `statusCode`, never passed in — the two cannot disagree |
| `statusCode` | yes | Mirrors the HTTP status, for clients that only read the body |
| `message` | yes | Human-readable, always from `MESSAGES` |
| `data` | yes | `null` rather than absent on failure, so `body.data` needs no guard |
| `meta` | no | Pagination and the like, on a success |
| `details` | no | Field errors or diagnostics, on a failure |

Three rules keep it that way:

1. **Never call `res.json`, `res.send` or `res.status` in a controller.** Reply
   only through `sendSuccess` / `sendError` in `helpers/response.helper.js`.
2. **Never write a status code as a number.** Use `HTTP_STATUS`; for a thrown
   failure prefer `ApiError.badRequest(...)` and friends, which carry the code
   for you.
3. **Never write a client-visible string inline.** Add it to `MESSAGES` and
   reference it, so wording stays consistent and is changed in one place.

Anything thrown that is not an `ApiError` is treated as a bug: logged in full
and reported as a generic 500, so stack traces and driver messages never leak.
A malformed JSON body is the one exception — `express.json()` flags it and the
handler answers `400 MALFORMED_JSON` rather than blaming the server.

## Adding a module

Four files and two enum lines — say, employees:

1. `src/enums/api-routes.enum.js` — add `EMPLOYEES: '/employees'` to `ROUTE_GROUP`,
   and an `EMPLOYEES` block to `ROUTES` with its endpoints.
2. `src/services/employee.service.js` — the logic, using `query`/`queryOne`/`mutate`
   from `helpers/query.helper.js`.
3. `src/controllers/employee.controller.js` — call the service, reply via `sendSuccess`
   with a `HTTP_STATUS` code and a `MESSAGES` string (see **Response contract**).
4. `src/routes/employee.routes.js` — map `ROUTES.EMPLOYEES.*` to controller methods.
5. `src/routes/index.js` — `router.use(ROUTE_GROUP.EMPLOYEES, employeeRoutes)`.

No path string is ever written outside `api-routes.enum.js`.

## Models

`src/models/` holds one file per table, mirroring `db/migrations`. There is no
ORM: a model is a **reference and a source of typed parameters**, not a query
builder. SQL stays hand-written, because readable SQL is worth more than a
fluent API that hides what the database runs.

```js
import { EmployeeLogin } from '../models/index.js';

await queryOne(
  `SELECT ${EmployeeLogin.select(['employeeId', 'email'])}
     FROM ${EmployeeLogin.table} WHERE Email = @email`,
  EmployeeLogin.params({ email }),
);
```

| Member | Gives you |
| ------ | --------- |
| `.table` | `'dbo.EmployeeLogin'` |
| `.col(prop)` | `'EmployeeId'` — the database column name |
| `.param(prop, value)` | one correctly typed parameter |
| `.params({ ... })` | several at once, ready for the query helpers |
| `.select(props)` | `'EmployeeId AS employeeId, Email AS email'` |
| `.columns`, `.props` | the raw definition, for reflection |

Using `.param`/`.params` is what stops an `NVARCHAR(256)` column being probed
with an `NVARCHAR(MAX)` parameter, which quietly costs you the index. Rows come
back with JS property names because every select list is aliased.

**Keeping models honest:** they are hand-written, so `npm run db:verify`
compares each one against `INFORMATION_SCHEMA` and exits non-zero on a missing
column, a wrong type or a changed length. Run it after every migration.

**Adding a table:** write the migration, add `src/models/<table>.model.js` with
`defineModel`, export it from `src/models/index.js`, then `npm run db:migrate &&
npm run db:verify`.

Column names inside `WHERE` and `SET` clauses stay written out — swapping them
for `${Model.col('x')}` makes the SQL harder to read than the rename it guards
against. `dbo._Migrations` has no model on purpose: it belongs to
`scripts/migrate.js` and nothing else should read it.

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

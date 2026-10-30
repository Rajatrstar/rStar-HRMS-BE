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
| `npm run db:seed:access` | Syncs the module catalog and the Administrator group |
| `npm run db:create:admin` | Creates a login **+** profile **+** group — a usable administrator |
| `npm run db:verify`  | Checks every model in `src/models` against the live schema |
| `npm run db:check`   | Connects as the app does and reports what is there — the first thing to run when it will not connect |
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
EMAIL=hr@rstartec.com GROUP="HR Team" npm run db:create:admin  # any group in tblGroup
```

Groups are otherwise assigned through the access-control API — see
[docs/ACCESS-CONTROL-FRONTEND.md](docs/ACCESS-CONTROL-FRONTEND.md).

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
| POST   | `/api/v1/auth/logout`     | Bearer | End the session — kills BOTH tokens           |
| GET    | `/api/v1/auth/me`         | Bearer | The signed-in account                         |

### Logout actually logs you out

A signed JWT cannot be unsigned, so deleting the client's copy would leave the
access token opening guarded routes until it expired and the refresh token
minting replacements for days. Both tokens therefore carry the same `sid`, and
logout records that id in `dbo.tblRevokedSession`. One row kills the pair:

```
verify-otp  ->  session S: access(S) + refresh(S)
refresh     ->  session S: a new access(S) + refresh(S)   <- same session, on purpose
logout      ->  S is revoked  ->  every token carrying S is dead
```

Three consequences worth knowing:

- **`/auth/refresh` keeps the session rather than starting one.** A new id per
  refresh would leave the just-exchanged token outside any later revocation.
- **It is per session, not per account.** Logging out on your laptop does not
  sign you out on your phone.
- **Every authenticated request now does one extra lookup** — a seek on a
  unique index over a table holding only unexpired logouts. That is the price
  of logout meaning something.

Tokens issued before this existed carry no `sid` and are rejected, so the
deploy that introduces it signs everyone out once.

Employee onboarding. Every one needs a bearer token **and** the right beside
it, on the **Employees** module:

| Method | Path                                             | Right       |
| ------ | ------------------------------------------------ | ----------- |
| GET    | `/api/v1/employees`                              | `canView`   |
| GET    | `/api/v1/employees/:employeeDetailId`            | `canView`   |
| POST   | `/api/v1/employees`                              | `canAdd`    |
| PUT    | `/api/v1/employees/:employeeDetailId`            | `canEdit`   |
| PATCH  | `/api/v1/employees/:employeeDetailId/deactivate` | `canEdit`   |
| DELETE | `/api/v1/employees/:employeeDetailId`            | `canDelete` |

Holding `canView` means seeing **every** employee. There is no row scope in
the group model — see [docs/ACCESS-CONTROL.md](docs/ACCESS-CONTROL.md) for
what that replaced and how to get it back if it is ever needed.

`GET /employees` is paged (`page`, `pageSize`, max 200) and filterable by
`search` (name, code or work email), `employmentStatus`, `isActive`,
`departmentId` and `managerId`. The totals come back in `meta`.

### Exiting an employee

Deactivation is its own endpoint and its own permission, not `isActive: false`
on the update. Exiting somebody ends their access to the system — an act an HR
Executive may be trusted to prepare but not to perform — and it demands facts
an edit does not.

**Mandatory**, and why each one:

| Field | Why it cannot be optional |
| ----- | ------------------------- |
| `dateOfLeaving` | Final pay, leave encashment and every headcount-as-at report are computed from it |
| `employmentStatus` | Must be `Exited`, `Resigned`, `Terminated` or `Inactive`. `IsActive = 0` says they are gone; this says **how**, which is what notice pay and rehire eligibility turn on |

Optional: `contractorEndDate`. `dateOfLeaving` is writable **here and nowhere
else** — letting an ordinary edit set one would allow a leaving date on
somebody still marked active.

It is refused when:

- **you are exiting yourself** — you would withdraw your own access mid-request
- **they still have direct reports** (`409`, with the count) — their team would
  point at a manager no screen lists
- **the leaving date precedes the joining date** (`400`) — the CHECK constraint
  would refuse it anyway, as a 500 naming a constraint; this is a 400 naming
  the field
- **they are already exited** (`409`) — almost always a double-submit

Their access goes with it. The resolver reads `IsActive`, so guarded endpoints
start refusing within the access cache's 60-second TTL, and `login`, `refresh`
and `/auth/me` all answer **403 `ACCOUNT_INACTIVE`** from the next request.

**Delete is a different thing.** An exited employee is company history and
appears in last year's payroll; a deleted record is one that should not have
existed — a duplicate, a candidate who never joined, a typo. That is why
delete asks for no exit details. It soft-deletes (`DeletedAt`), because roles,
grants, logins and every `CreatedBy` in the schema point at that id.

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

# 4. end the session — no body, the token says which session to end
curl -X POST http://localhost:5000/api/v1/auth/logout   -H "Authorization: Bearer <accessToken>"
# { "data": { "employeeDetailId": 3, "alreadyRevoked": false } }

# 5. both halves are now dead — each of these answers 401
curl http://localhost:5000/api/v1/auth/me -H "Authorization: Bearer <accessToken>"
curl -X POST http://localhost:5000/api/v1/auth/refresh   -H "Content-Type: application/json"   -d '{"refreshToken":"<refreshToken>"}'
```

An OTP works once, expires after `OTP_EXPIRY_MINUTES`, and is replaced whenever
a new login starts.

## Postman

`postman/rSTAR-HRMS-API.postman_collection.json` — import that one file into
Postman. It is grouped into folders, one per area:

```
Health                    liveness, readiness. No auth
Auth                      login, OTP, refresh, logout, password reset
Admin
  ├─ Organization         the company profile
  └─ Locations            the location master
Employees                 onboarding: create, read, update, exit, delete
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

Forty requests. Every one asserts the response envelope, so a change to the
reply shape fails the run rather than slipping through.

Several requests are **supposed to fail**, and their test asserts the failure:
`Auth › 8` and `9` send the tokens logout just revoked and expect `401`;
`Employees › 7` sends an exit with no details and expects a `400` naming both
mandatory fields. A green run means the guards held, not that nothing went
wrong.

**Employees** runs top to bottom as one employee's whole life - created in
request 1, exited in 9, deleted in 11 - so a full run leaves the database as
it found it. The employee code and work email are generated per run by the
collection pre-request script, so running it twice does not collide with
itself.

`resend-otp` sits between login and verify-otp deliberately — it replaces the
live code, and after verify-otp succeeds there is no OTP left to resend.

Everything under **Admin** and **Access Control** is guarded, and out of the box
only the Administrator group holds anything. A `403` names the module and action
it wanted in `details.requiredAccess` — tick that checkbox for the user's group
rather than guessing.
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
`otp` variable, then run `verify-otp` onwards. Or set `DefaultOTP=true` and the
code is always `123456`.

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
- **`DefaultOTP` makes every code `DEFAULT_OTP_CODE` and stops all outbound
  mail** — see [Development mode](#development-mode-defaultotp). Same production
  gate, for a stronger reason: a constant second factor is no second factor, so
  anyone holding one password would be through.
- **Passwords are capped at 72 characters** because bcrypt ignores anything
  beyond 72 bytes; rejecting it is honest, silently truncating is not.

## Development mode (`DefaultOTP`)

Working on login without a mailbox is the normal case locally, so one switch
covers it:

```ini
DefaultOTP=true
DEFAULT_OTP_CODE=123456    # must be OTP_LENGTH digits
```

| | `DefaultOTP=true` | `DefaultOTP=false` (default) |
|---|---|---|
| OTP issued by `/auth/login` | always `DEFAULT_OTP_CODE` | a fresh random code |
| OTP issued by `/auth/forgot-password` | always `DEFAULT_OTP_CODE` | a fresh random code |
| Email | nothing queued, nothing sent, to anybody | queued to `dbo.EmailOutbox` and delivered |
| `NODE_ENV=production` | ignored, with a warning on startup | unchanged |

Everything else behaves exactly as it does in production: the code still has to
be submitted to `/auth/verify-otp`, it still expires after
`OTP_EXPIRY_MINUTES`, it is still single-use, and the rate limiters still
apply. Only where the code comes from changes.

Three details worth knowing:

- **The suppression happens at queue time**, not in the mail worker. Nothing is
  written to `dbo.EmailOutbox` at all, so turning the flag back off later
  cannot flush a backlog of stale reset codes into real inboxes. The rendered
  message is written to the log as `[mail:suppressed]` so you can still read
  it.
- **`generateOtp()` is the only place the code is chosen**, so login and
  password reset cannot disagree about which mode they are in.
- **The server refuses to start** if `DEFAULT_OTP_CODE` is not exactly
  `OTP_LENGTH` digits. The submitted OTP is length-validated before it reaches
  a comparison, so a mismatch would otherwise make every login fail with
  nothing pointing at this setting.

The variable is read as both `DefaultOTP` and `DEFAULT_OTP`. `process.env` is
case-insensitive on Windows and case-sensitive everywhere else, and a flag that
works on a laptop and silently does nothing in a container is the failure this
flag exists to prevent.

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

Group based, one rule:

> **an employee belongs to a GROUP, and a group holds RIGHTS on MODULES.**

Six rights per module — View, Add, Edit, Delete, Print, Mail — set on one
screen. No roles, no per-user exceptions, no row-level scopes: if somebody can
do something, exactly one group gave it to them.

| Doc | For |
| --- | --- |
| [docs/ACCESS-CONTROL.md](docs/ACCESS-CONTROL.md) | Backend: the schema, the resolver, and why it is shaped this way |
| [docs/ACCESS-CONTROL-FRONTEND.md](docs/ACCESS-CONTROL-FRONTEND.md) | Frontend: every endpoint, menu binding, page binding, the admin screens |

`src/enums/module.enum.js` is the module catalog and the source of truth,
`npm run db:seed:access` syncs it into the database, and a route is guarded
with `requireAccess(MODULE.EMPLOYEES, ACTION.DELETE)` from
`src/middlewares/permission.middleware.js`.

**The server will not start with an unguarded API route.** `src/utils/route-audit.js`
walks the router at boot and refuses to listen if any endpoint under
`/api/v1` has no guard — because the way access control goes wrong is an
endpoint copied from the one above it with the middleware argument dropped,
which fails silently and passes every test written by an administrator.

### What the frontend calls

| Method | Path | Who |
| --- | --- | --- |
| `GET` | `/access/me` | any signed-in user — group + the full rights map |
| `GET` | `/access/menu` | any signed-in user — the navigation, already filtered |
| `GET` | `/access/page?path=/employees` | any signed-in user — the six rights for one page |
| `GET` | `/access/modules` | `GROUPS: canView` — the catalog |
| `GET` `POST` | `/access/groups` | `GROUPS: canView` / `canAdd` |
| `GET` `PUT` `DELETE` | `/access/groups/:groupId` | `GROUPS: canView` / `canEdit` / `canDelete` |
| `PUT` | `/access/groups/:groupId/rights` | `GROUPS: canEdit` — the matrix alone |
| `GET` `POST` | `/access/groups/:groupId/members` | `USER_ACCESS: canView` / `canEdit` |
| `PUT` `DELETE` | `/access/employees/:employeeDetailId/group` | `USER_ACCESS: canEdit` |

`GET /access/groups/:groupId` returns the **complete** matrix — every active
module, with zeros where the group holds nothing — so the checkbox grid
renders without the client merging two lists.

### Setting it up

```bash
npm run db:migrate
npm run db:seed:access          # the module catalog + the Administrator group
EMAIL=you@rstartec.com npm run db:create:admin
```

`Administrator` is a **system group**: it holds every right on every module,
its rights are not stored as rows (so a module added next month is covered
with nothing to re-seed), and the API refuses to rename, strip or delete it.
That is the way back in if somebody clears the wrong checkbox.

Every other group starts with **nothing**. Grant it on the group screen.

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

### The employee table

`dbo.tblEmployeeDetails` carries 78 columns, matching the HR record kept in
Zoho People (migration `007`). Two things about it are easy to get wrong.

**There are two auto-numbers, and only one is an identity.**

| Column | How it is filled | What it is for |
| ------ | ---------------- | -------------- |
| `EmployeeDetailId` | `BIGINT IDENTITY` | the primary key; every FK, grant and JWT subject in the schema points at it |
| `EmployeeSerialNo` | `INT`, defaulted from `dbo.seqEmployeeSerialNo` | a plain counting number for HR to quote |
| `EmployeeCode` | written by hand | the human code, `EMP001` or `RSTR157` |

SQL Server allows exactly **one** identity column per table, so the second
number comes from a SEQUENCE instead. From a caller's side it behaves the
same — leave the column out of the `INSERT` and a number appears — with two
differences worth knowing: the next value can be read without inserting a
row, and **a rolled-back transaction still consumes its number**, because
sequences are not transactional. Gaps are normal and not a bug.

**Two vocabularies share `EmploymentType` and `EmploymentStatus`.** Ours
(`FullTime`, `Active`, …) and the Zoho export's (`Permanent`, `Resigned`, …).
Both are accepted because rows exist in the first and imports arrive in the
second. `src/enums/employee.enum.js` marks which is which; the CHECK
constraints in `001` and `007` are the enforcement, so adding a value means
editing the enum **and** writing a migration.

`PanNumber` and `AadharNumber` are deliberately **not indexed** and **not in
`EMPLOYEE_DETAILS_PUBLIC_PROPS`** — they should leave the table only through
an endpoint written for them, never by being swept into a default select
list. Only `ManagerId` drives the TEAM scope; `SecondaryManagerId` and
`AdditionalManagerId` are recorded but grant nothing, because widening who
can see whose data is an access-control decision, not an import side effect.

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

Or through the same configuration the app uses, which also reports what is
already in the database:

```bash
npm run db:check
```

## Connecting to Azure SQL

Nothing in the application is Azure-specific. A `DB_HOST` ending in
`.database.windows.net` is what switches it over, and from that one fact it
requires encryption, waits longer for a connection, and retries the failures
Azure produces on its own. `.env.azure.example` is the template; copy it over
the SQL Server block in `.env`.

```
DB_HOST=rstar-hrms.database.windows.net
DB_PORT=1433
DB_NAME=rStarHRMS
DB_USER=hrms_app
DB_PASSWORD=<the contained user's password>
DB_ENCRYPT=true
DB_TRUST_SERVER_CERTIFICATE=false
```

The last line is not optional and the app will not start without it. Azure's
certificate is issued by a public CA, so it validates on its own; trusting any
certificate does not make the connection work, it only switches off the check
that would notice an intercepted one. `DB_ENCRYPT=false` is refused for the
same reason — Azure would reject it anyway, with an error that does not say so.

### Creating the server

Once, from the Azure CLI. Pick your own names; the password rules are Azure's.

```bash
az group create -n rstar-hrms -l centralindia

az sql server create \
  -g rstar-hrms -n rstar-hrms -l centralindia \
  -u hrmsadmin -p '<strong-admin-password>'

# General Purpose serverless: it auto-pauses when idle, which is why the app
# waits 30 seconds for the first connection rather than failing the boot.
az sql db create \
  -g rstar-hrms -s rstar-hrms -n rStarHRMS \
  -e GeneralPurpose -f Gen5 -c 1 --compute-model Serverless \
  --auto-pause-delay 60 --backup-storage-redundancy Local

# Your own machine, for migrations and development.
az sql server firewall-rule create \
  -g rstar-hrms -s rstar-hrms -n my-machine \
  --start-ip-address <your-ip> --end-ip-address <your-ip>

# Azure-hosted services (App Service, Container Apps) reaching it. The
# all-zero range is Azure's "allow Azure services" rule, NOT 0.0.0.0/0 —
# it does not open the server to the internet.
az sql server firewall-rule create \
  -g rstar-hrms -s rstar-hrms -n allow-azure-services \
  --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0
```

### Creating the two users

The server administrator can drop the database, so the API never uses it.
`db/azure/001_app_users.sql` creates the two accounts that it does use — run it
once, as the administrator, **against `rStarHRMS` rather than `master`**:

```bash
sqlcmd -S rstar-hrms.database.windows.net -d rStarHRMS \
       -U hrmsadmin -P '<admin-password>' -i db/azure/001_app_users.sql
```

| User | Rights | Used by |
|---|---|---|
| `hrms_app` | read + write | the running API — this is what goes in `.env` |
| `hrms_deploy` | read + write + schema changes | `db:migrate`, nothing else |

They are split because the failure modes differ by an order of magnitude: SQL
injection reaching the database as `hrms_app` can corrupt rows, which a restore
fixes; as a user that can also `DROP TABLE` it is a different conversation.
Both are *contained* users, with their password held in the database rather
than in a master-level login, so the database can be copied, restored or failed
over to another server and still work without repairing orphaned users.

### First deploy

```bash
cp .env .env.deploy        # then set DB_USER/DB_PASSWORD to hrms_deploy
node --env-file=.env.deploy scripts/migrate.js
npm run db:seed:access
npm run db:create:admin
npm run db:verify
```

`.env.deploy` is git-ignored. Keeping the deployment credentials in their own
file rather than in `.env` is what stops the running API ever holding them.

Every migration in `db/migrations` runs on Azure SQL unchanged — nothing in
them uses a feature the service lacks.

### When it will not connect

```bash
npm run db:check
```

It reports the target, resolves the host, connects, and then says who you
authenticated as, what rights that user has, which migrations are applied and
what tier the database is on. On failure it names the cause rather than the
symptom, because against a cloud database almost every one of these arrives as
the same connect timeout:

| What you see | What it actually is |
|---|---|
| timeout, no error number | Outbound TCP 1433 is blocked — common on corporate and hotel Wi-Fi. Test from a phone hotspot |
| `Client with IP address ... is not allowed` | No firewall rule covers this machine. Your IP changed if it worked yesterday |
| `Login failed` (18456) | Wrong password, or the contained user was created in `master` instead of in `rStarHRMS` |
| `Cannot open database` (4060) | Right server, wrong database name, or that user has no access to it |
| `Database is not currently available` (40613) | A serverless database waking up, or a failover. The app retries this one by itself |

A certificate error against Azure means something is intercepting the
connection — a proxy or TLS-inspecting antivirus. The fix is to exempt
`*.database.windows.net` there, never to set `DB_TRUST_SERVER_CERTIFICATE=true`.

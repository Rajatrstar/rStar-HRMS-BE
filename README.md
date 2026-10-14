# rSTAR HRMS — Backend API

Node.js + TypeScript + Express 5 + Prisma 7 on Microsoft SQL Server / Azure SQL.

This repository is the **foundation**: project structure, security baseline, and one
reference CRUD module (`Employee`). HRMS features — attendance, leave, payroll — are added
on top by following the established pattern, not by inventing a new one each time.

## Requirements

|            |                                                                                         |
| ---------- | --------------------------------------------------------------------------------------- |
| Node.js    | 22+ (developed on 24.12)                                                                |
| Database   | SQL Server 2019+ or Azure SQL                                                           |
| Auth to DB | A **SQL login** — the Prisma MSSQL adapter does not support Windows integrated security |

## Getting started

```bash
npm install                 # also runs `prisma generate` via postinstall
cp .env.example .env        # then fill in DATABASE_URL and the two JWT secrets
npm run prisma:migrate      # creates the schema
npm run db:seed             # creates the first SUPER_ADMIN
npm run dev
```

### Creating the SQL login

The adapter needs a SQL login — Windows auth will not work — and it cannot address a named
instance by name, so use `host:port` (`localhost:1433` for a default SQLEXPRESS install).
Run this once as an administrator, then put the credentials in `DATABASE_URL`:

```sql
-- Enable mixed-mode auth first if the server is Windows-auth only, then restart SQL Server:
--   SQL Server Management Studio > Server Properties > Security > "SQL Server and Windows Authentication mode"

USE [master];
CREATE LOGIN [hrms_app] WITH PASSWORD = 'a-strong-password-here',
    CHECK_POLICY = ON, DEFAULT_DATABASE = [rSTAR_HRMS_BE];

USE [rSTAR_HRMS_BE];
CREATE USER [hrms_app] FOR LOGIN [hrms_app];

-- db_ddladmin is needed because `prisma migrate` creates and alters tables.
-- For production, run migrations with a separate privileged login and leave the
-- application login with only db_datareader + db_datawriter.
ALTER ROLE db_datareader  ADD MEMBER [hrms_app];
ALTER ROLE db_datawriter  ADD MEMBER [hrms_app];
ALTER ROLE db_ddladmin    ADD MEMBER [hrms_app];
```

Generate each JWT secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`src/generated/` is gitignored — the Prisma client is regenerated on every `npm install`.

## Layout

```
src/
  index.ts        entrypoint: connect DB -> listen -> graceful shutdown
  app.ts          middleware chain + route mounting
  enums.ts        Role, EmploymentStatus, HttpStatus, AuditAction, TokenType
  seed.ts         creates the first SUPER_ADMIN
  types.d.ts      what middleware attaches to req (req.user, req.id)
  config/         env.ts (zod-validated) | db.ts (Prisma) | logger.ts (pino + request context)
  routes/         index.ts (health + mounting) | auth.routes.ts | employee.routes.ts
  controllers/    auth.controller.ts | employee.controller.ts
  services/       auth.service.ts | employee.service.ts | audit.service.ts
  validations/    auth.validation.ts | employee.validation.ts
  middlewares/    auth (authenticate, authorize)
                  request (context, validate, rate limits)
                  error (notFound, errorHandler)
  utils/          api-error.ts | api-response.ts | jwt.ts | password.ts
```

### The layer rule

> Controllers never touch Prisma. Services never touch `req`/`res`. Routes contain only
> paths and middleware.

This is enforced by `no-restricted-imports` in `eslint.config.js`, not just by review —
importing the Prisma client outside `src/services/` fails `npm run lint`.

### Adding a module

Copy the `employee` slice: `validations/x.validation.ts` → `services/x.service.ts` →
`controllers/x.controller.ts` → `routes/x.routes.ts`, then mount it in `routes/index.ts`.

Handlers need no `try/catch` and no async wrapper — **Express 5 forwards rejected promises
to the error handler on its own**. Throw an `ApiError` and it becomes the right response.

## API

| Method | Path                    | Access                    |
| ------ | ----------------------- | ------------------------- |
| GET    | `/health`               | public, no DB             |
| GET    | `/health/ready`         | public, checks DB         |
| POST   | `/api/v1/auth/login`    | public, rate limited      |
| POST   | `/api/v1/auth/refresh`  | public, rate limited      |
| POST   | `/api/v1/auth/logout`   | public (idempotent)       |
| GET    | `/api/v1/auth/me`       | authenticated             |
| GET    | `/api/v1/employees`     | authenticated, paginated  |
| POST   | `/api/v1/employees`     | HR_ADMIN, SUPER_ADMIN     |
| GET    | `/api/v1/employees/:id` | authenticated             |
| PATCH  | `/api/v1/employees/:id` | HR_ADMIN, SUPER_ADMIN     |
| DELETE | `/api/v1/employees/:id` | SUPER_ADMIN (soft delete) |

There is **no public registration endpoint** by design — HRMS accounts are provisioned by HR.

Every response uses one envelope:

```jsonc
{ "success": true,  "requestId": "…", "meta": { … }, "data": … }
{ "success": false, "requestId": "…", "error": { "message": "…", "details": [ … ] } }
```

## Security baseline

- **Passwords** — argon2id at the OWASP baseline (19 MiB, 2 passes). An unknown email still
  burns one verification so response timing is not a user-enumeration oracle.
- **Tokens** — 15-minute access JWT, 7-day rotating refresh JWT. Refresh tokens are stored
  only as SHA-256 digests, so a database dump yields nothing replayable. Rotation chains
  rows via `replacedById`; presenting an already-revoked token is treated as theft and
  **revokes every session for that user**.
- **RBAC** — `authorize(...roles)` against the `Role` enum, fails closed.
- **Lockout** — `MAX_FAILED_LOGINS` strikes locks the account for `ACCOUNT_LOCK_MINUTES` and
  revokes live sessions.
- **Rate limiting** — global, plus a tighter limiter on credential endpoints keyed on IP _and_
  submitted email, so one attacker cannot lock out an office NAT and rotating IPs cannot
  grind a single account.
- **Validation** — zod on body/params/query; handlers only ever see parsed data with unknown
  keys stripped.
- **Errors** — one handler. Unrecognised errors become a generic 500; stack traces are
  omitted when `NODE_ENV=production`.
- **Audit trail** — append-only `audit_logs`, written by the service layer. Audit failures
  are logged, never escalated into a failed request.
- **Transport** — helmet, CORS from an env allowlist (never `*`; empty blocks all
  cross-origin browser traffic), 100 kb body cap, `x-powered-by` disabled.
- **Observability** — pino with a redaction list covering tokens and passwords; every request
  carries an `x-request-id` through `AsyncLocalStorage` and back on the response.

## SQL Server specifics

Two provider constraints shape `prisma/schema.prisma`:

1. **No native enum type.** Prisma `enum` blocks are unsupported on `sqlserver`, so roles and
   statuses are NVARCHAR columns and `src/enums/` is the authority on their values.
2. **900-byte index key limit.** An unlengthed Prisma string becomes `NVARCHAR(1000)` = 2000
   bytes, which cannot be indexed. Every unique column declares an explicit length.

Also note `mode: 'insensitive'` is unsupported here — SQL Server collations are
case-insensitive by default, so `contains` already does the right thing.

Azure SQL requires `encrypt=true` in `DATABASE_URL`. Set `TRUST_PROXY_HOPS=1` behind
Azure App Service so `req.ip` (rate limiting, audit trail) reflects the real client.

## Scripts

| Script                            | Purpose                                  |
| --------------------------------- | ---------------------------------------- |
| `npm run dev`                     | watch mode (tsx)                         |
| `npm run build` / `start`         | compile to `dist/` / run compiled output |
| `npm run typecheck`               | `tsc --noEmit`                           |
| `npm run lint` / `lint:fix`       | eslint, type-aware                       |
| `npm run format` / `format:check` | prettier                                 |
| `npm run prisma:migrate`          | dev migration                            |
| `npm run prisma:deploy`           | apply migrations in CI/production        |
| `npm run prisma:studio`           | browse data                              |
| `npm run db:seed`                 | idempotent SUPER_ADMIN seed              |

## Known advisories

`npm audit` reports findings in `deepmerge-ts` and `mysql2`. Both arrive through the
**`prisma` CLI dev dependency** — `mysql2` is a driver this project never loads, since it
runs on the SQL Server adapter. Neither is in the runtime dependency tree. `npm audit fix
--force` is not safe here: it moves Prisma to the 8.0 release candidate.

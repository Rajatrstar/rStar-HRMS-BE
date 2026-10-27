# Access Control — Backend Reference

What exists, how it decides, and how to change it.

For the client side see [ACCESS-CONTROL-FRONTEND.md](./ACCESS-CONTROL-FRONTEND.md).

---

## 1. What this answers

Two questions on every request:

1. **May this person do this?** — a permission code like `employees.view`.
2. **To whose records?** — a scope: `OWN`, `TEAM`, `DEPARTMENT` or `ALL`.

Three sources grant, one removes:

```
ROLES    the roles a person holds contribute their permissions
GROUPS   the groups they belong to contribute theirs, on top
GRANT    a per-user override adds one more
DENY     a per-user override REMOVES one, whatever granted it
```

Two rules settle it:

- **DENY wins absolutely.** It removes the permission whatever granted it, and
  it carries no scope — a DENY cannot narrow, only remove.
- **Widest scope wins.** If two sources grant the same code, the effective
  scope is the higher rank. `OWN=1 < TEAM=2 < DEPARTMENT=3 < ALL=4`.

Those are two separate questions. Precedence decides allow/deny; scope is a
union, not a precedence chain. An override GRANT at `OWN` does **not** shrink a
role grant at `ALL`.

Proven behaviour, from a live run against the seeded roles:

```
baseline (no roles)              total= 0   view=-     approve=-     apply=-    payroll=-
+ EMPLOYEE role                  total=16   view=OWN   approve=-     apply=OWN  payroll=-
+ MANAGER role (union)           total=21   view=TEAM  approve=TEAM  apply=OWN  payroll=-
+ group grant payroll.view       total=22   view=TEAM  approve=TEAM  apply=OWN  payroll=ALL
+ DENY override on payroll.view  total=21   view=TEAM  approve=TEAM  apply=OWN  payroll=-
  (that DENY now expired)        total=22   view=TEAM  approve=TEAM  apply=OWN  payroll=ALL
```

Note `leave.apply` staying at `OWN` while `leave.view` rises to `TEAM`: the
Manager role grants neither self-service permission, so a manager needs the
Employee role too. See §6.

---

## 2. Where everything lives

| File | Holds |
| --- | --- |
| `db/migrations/004_access_control.sql` | The nine tables |
| `src/models/access-control.model.js` | All nine models, plus `*_PUBLIC_PROPS` |
| `src/enums/permission.enum.js` | **The catalog — source of truth.** Codes, scopes, scope ranks |
| `src/enums/role.enum.js` | The five master roles and their default grants |
| `src/enums/error-code.enum.js` | Machine-readable `details.code` values |
| `src/enums/messages.enum.js` | Every client-visible string |
| `src/services/access-control.service.js` | The resolver — one SQL batch, one round trip |
| `src/utils/access-cache.js` | The per-employee cache |
| `src/helpers/access-scope.helper.js` | Scope → SQL `WHERE` clause |
| `src/middlewares/permission.middleware.js` | `requirePermission` and friends |
| `scripts/seed-permissions.js` | Syncs catalog + roles into the database |

### The nine tables

| Table | Holds |
| --- | --- |
| `tblPermission` | The catalog. Written only by the seed |
| `tblRole` | Five master roles (`IsSystem = 1`) plus any an admin creates |
| `tblGroup` | A bundle of permissions several people share |
| `tblRolePermission` | What a role may do, and at what scope |
| `tblGroupPermission` | The same, for a group |
| `tblEmployeeRole` | Which roles a login holds |
| `tblEmployeeGroup` | Which groups a login belongs to |
| `tblEmployeePermission` | Per-user GRANT / DENY overrides |
| `tblAccessControlStamp` | One row. Bumped by every write, to invalidate caches |

Everything is soft-deleted (`DeletedAt`), so "who gave Bob HR Admin, and when"
stays answerable. Every read path must filter `WHERE DeletedAt IS NULL`.

---

## 3. How to make the common changes

### 3.1 Add a permission

1. Add the code to `PERMISSION` in `src/enums/permission.enum.js`.
2. Add its entry to `PERMISSION_CATALOG` in the same file — pass `SCOPED` as the
   third argument if it addresses somebody's rows.
3. Decide which roles get it by default: edit `ROLE_PERMISSION_DEFAULTS` in
   `src/enums/role.enum.js`.
4. `npm run db:seed:permissions`

Point 3 only affects roles the seed **creates**. An existing role is left alone
unless you pass `--reset-roles` (see §3.4). Super Admin is the exception and
always picks the new permission up.

### 3.2 Add a role

Two ways, and the right one depends on whether it is a *product* role or a
*customer* role.

- **A role this product ships with** — add it to `ROLE` and `ROLE_META`, give it
  a block in `ROLE_PERMISSION_DEFAULTS`, run the seed. It is created with
  `IsSystem = 1`, so it cannot be renamed or deleted afterwards.
- **A role this customer wants** — create it through the admin API. It gets
  `IsSystem = 0` and is fully editable and deletable. No code change, no deploy.

### 3.3 Change what a role may do

Through the admin API (`PUT /roles/:roleId/permissions`), not the enum. The
whole point of storing permissions as rows is that this does not need a
deploy — and the seed deliberately will not overwrite your change.

### 3.4 Reset a role back to its defaults

```bash
npm run db:seed:permissions -- --reset-roles
```

This **overwrites** every non-Super-Admin role's grants with
`ROLE_PERMISSION_DEFAULTS`, discarding edits made through the API. It is for a
development database that has drifted; think twice on anything shared.

### 3.5 Add a scope

`OWN`/`TEAM`/`DEPARTMENT`/`ALL` live in three places that must move together:

1. `PERMISSION_SCOPE` and `PERMISSION_SCOPE_RANK` in `permission.enum.js`
2. The `CK_*_Scope` CHECK constraints and the `ScopeRank` **computed columns**
   in a new migration
3. The `switch` in `employeeScopeClause` in `access-scope.helper.js`

The duplication is deliberate: a new scope should be a decision, not a typo
that silently lands in a grant row.

### 3.6 Guard a new endpoint

```js
import { requirePermission } from '../middlewares/permission.middleware.js';
import { PERMISSION } from '../enums/index.js';

router.get(ROUTES.EMPLOYEES.LIST,
  authenticate,                                   // must come first
  requirePermission(PERMISSION.EMPLOYEES_VIEW),
  employeeController.list);
```

Variants: `requireAnyPermission([a, b])`, `requireAllPermissions([a, b])`, and
`requireAuthenticatedAccess()` for a route any signed-in employee may call.

Use `requireAuthenticatedAccess()` rather than omitting a guard. "Open to
everyone" should be a decision written in the route file, not an omission
nobody notices — and the planned boot-time route audit (§7) treats a missing
guard as a startup failure.

### 3.7 Filter rows by scope in a service

The guard answers "may you at all". Which rows is the service's job:

```js
import { employeeScopeClause } from '../helpers/access-scope.helper.js';

export async function list(access, filters) {
  const { clause, params } = employeeScopeClause('d', access, PERMISSION.EMPLOYEES_VIEW);
  return query(
    `SELECT ...
       FROM ${EmployeeDetails.table} AS d
      WHERE d.DeletedAt IS NULL AND ${clause}`,
    { ...params },
  );
}
```

`access` is `req.access`, a frozen plain object with no reference to Express —
so passing it in does not break the rule that services never see `req`/`res`.

**Add one clause builder per module, in that helper. Never inline the switch
into a service**, or "OWN" will mean four different things within six months.

---

## 4. The decisions, and why

### Super Admin holds real rows. There is no code bypass.

No `if (isSuperAdmin) return next()` exists anywhere. The seed gives
`SUPER_ADMIN` every live permission at `ALL` and re-syncs it on every run.

The bypass was rejected because the account used for most manual testing would
then never execute the resolver — so resolver bugs would ship and be found in
production by an HR Executive. It would also make DENY silently inapplicable to
Super Admins, a security property nobody wrote down.

The cost: a newly added permission returns 403 for Super Admin until the seed
runs. That is loud, self-healing in one command, and fails in the safe
direction.

### DENY is absolute, never narrowing

`Scope` is `NULL` on a DENY row, enforced by `CK_tblEmployeePermission_Scope`.

**Known limitation:** "Bob's Manager role gives TEAM, cap Bob at OWN" is not
expressible. The fix for that case is to not give Bob the Manager role — model
the reality rather than patching it with an exception.

If it is genuinely needed later, add `Effect = 'LIMIT'` to the CHECK and clamp
the aggregate in the resolver's final `SELECT`. One CHECK widening and one
`CASE`; no table change.

### A GRANT and a DENY for the same pair cannot both exist

`UQ_tblEmployeePermission_EmployeePermission` is a filtered unique index on
`(EmployeeDetailId, PermissionId)`. Precedence therefore only ever fires *across*
sources, never within one — there is no runtime conflict to arbitrate.

### `tblPermission`'s unique index is deliberately NOT filtered

Every other unique index in this schema is `WHERE DeletedAt IS NULL`. This one
is not, because retiring a code and later re-adding it must resurrect the
**same** `PermissionId` — role and group grants still point at it. A filtered
index would let the seed insert a second row with the same code and silently
orphan every existing grant.

### Groups carry permissions, not roles

A group holding roles would create a second inheritance axis and the diamond
problem with it, for no capability a flat bundle does not already give.

### Subjects are keyed on `tblEmployeeDetails.EmployeeDetailId`

The person, not the credential. `dbo.EmployeeLogin` is a satellite: it carries
a **NOT NULL** `EmployeeDetailId`, so a login cannot exist without an employee
while an employee can exist with no way to sign in. The token carries that same
id, so the resolver gets it for free.

This was the other way round at first — grants keyed on the login id, with a
nullable `EmployeeId` on the employee table. Two things came out of inverting
it, and both are the reason it is worth the churn:

- **Row scope stopped needing a translation.** `ManagerId` and `DepartmentId`
  are `EmployeeDetailId`s. When the subject was a login id, every scoped query
  had to convert first — and getting it wrong compiled, ran, returned rows,
  and returned the *wrong people*.
- **"Signed in with no profile" became unrepresentable** rather than handled.
  The resolver's `hasProfile` flag and a branch in the guard both went away.

### `ScopeRank` is a PERSISTED computed column

So "widest wins" is a plain `MAX(ScopeRank)` with no `CASE` in the hot query,
and the OWN/TEAM/DEPARTMENT/ALL ordering cannot drift between SQL and JS.

**Never put it in an `INSERT` column list** — SQL Server rejects writes to a
computed column.

---

## 5. The cache

An in-process `Map`, 60 s TTL, keyed by employee id.

- It stores the **promise**, not the value. A hundred concurrent requests from
  one person on a cold key produce one query, not a hundred — the same pattern
  `config/db.js` uses for `poolPromise`.
- A write invalidates **directly** on the instance that made it, so an admin
  sees their own change immediately.
- Other instances learn through `tblAccessControlStamp`: every write bumps
  `Version` inside its own transaction, and a poller clears the cache when the
  number moves. Polling rather than reading per request is the point — a
  per-request read would be the round trip the cache exists to remove.

| Variable | Default | |
| --- | --- | --- |
| `ACCESS_CONTROL_CACHE_ENABLED` | `true` | `false` makes every check hit the database |
| `ACCESS_CONTROL_CACHE_TTL_SECONDS` | `60` | |
| `ACCESS_CONTROL_CACHE_MAX_ENTRIES` | `1000` | Clears wholesale above this |
| `ACCESS_CONTROL_STAMP_POLL_SECONDS` | `5` | |

Turning the cache off is the fastest way to tell a permissions bug from a cache
bug.

**The cache is not the revocation gap — the access token is.** A fired
employee's token stays valid for up to `JWT_ACCESS_EXPIRES_IN` (15 minutes) no
matter what happens here. The mitigation that does exist: the guard rejects a
profile that is `IsActive = 0` or soft-deleted, so deactivating somebody cuts
them off within one cache TTL rather than one token lifetime.

---

## 6. The seeded roles

| Role | Grants | Notes |
| --- | --- | --- |
| `SUPER_ADMIN` | 56 | Every permission at `ALL`. Always re-synced |
| `HR_ADMIN` | 50 | Full HR operations |
| `HR_EXECUTIVE` | 21 | Record maintenance |
| `EMPLOYEE` | 16 | Self-service, `OWN` |
| `MANAGER` | 10 | `TEAM` visibility and approvals |

Three deliberate calls in that matrix:

**HR Admin can assign roles but not edit them.** `roles.assign-permission` is
Super Admin only. Otherwise HR Admin could add `payroll.configure` to their own
role — assign-role plus assign-permission is a wildcard with extra steps.

**Overrides are Super Admin only.** An override bypasses the role model
entirely, so it should be rare and attributable. `Reason` is required by the API.

**Manager is additive and must be held alongside Employee.** The Manager role
omits `leave.apply`, `payslip.view` and the rest of the self-service set —
those come from Employee, and the widest-scope union then gives
`leave.view: TEAM` with `leave.apply: OWN`. Assigning Manager **alone** leaves a
manager unable to book their own leave. This is the single most likely
onboarding mistake; the admin UI warns about it.

---

## 7. Status

**Built and verified**

- Migrations `001`–`005`, applied from scratch on a rebuilt database
- Models — `npm run db:verify` passes 14/14
- Enums — 63 permissions across 17 modules, `PERMISSION` ↔ `PERMISSION_CATALOG`
  in sync
- Resolver, cache, scope helper, permission guard — subject is
  `EmployeeDetailId` throughout
- `scripts/seed-permissions.js` — five roles seeded, idempotent on re-run
- `scripts/create-admin.js` — the only path that produces a usable
  administrator (employee + login + role in one transaction)
- The Organization module — the first module behind the permission guard
- Postman coverage (folder-grouped) and `scripts/api-flow.sh`

- The admin API — `/permissions/catalog`, `/roles`, `/groups`,
  `/access/my-permissions` and `/access/users/:employeeDetailId/...`. The rules
  every write obeys (escalation, self-lockout, stamp bump, cache clear) live
  once, in `src/services/access-write.service.js` → `withAccessWrite()`
- The stamp poller (`src/workers/access-stamp.worker.js`), so a second
  instance picks up a grant change within `ACCESS_CONTROL_STAMP_POLL_SECONDS`

**Not built yet**

- The boot-time route audit
- The Employees module — the first real consumer of row scope through an
  endpoint. The scope helper itself is tested directly

---

## 8. Gotchas

**`EmployeeId` is not `EmployeeDetailId` — and you should never need both.**
`EmployeeLogin.EmployeeId` (INT) identifies a password row. Everything else —
`ManagerId`, grants, audit columns, the JWT subject, every scope clause — is
`EmployeeDetailId` (BIGINT). Grants, audit columns, the JWT subject and
every scope clause are all `EmployeeDetailId`. If you find yourself converting
between them, something is wrong.

> The seeded data keeps them deliberately out of step — login 1 is employee 3,
> login 2 is employee 4 — so a stray `EmployeeId` shows up immediately instead
> of passing because the numbers happened to match.

**An employee may have no login**, which is normal: plenty of staff never sign
in. There is no inverse case to worry about. `SCOPE_UNRESOLVED` still exists,
but only for DEPARTMENT on an employee with no `DepartmentId` — `OWN` and
`TEAM` key on a column that is always present.

**`withTransaction`'s `run()` returns no `rowsAffected`.** Any write that needs
to know whether it changed anything must use `OUTPUT inserted.*` /
`OUTPUT deleted.*`. Forgetting this gives an endpoint that cheerfully reports
success for a no-op.

**No array / `IN` support in the query helper.** Generate `@p0..@pn` yourself,
or pass a delimited string to `STRING_SPLIT` — which is only safe here because
`CK_tblPermission_CodeShape` forbids a comma inside a code. Bind such a string
as `NVarChar(MAX)`, not at the column width; the joined catalog is about 1 KB
and binding it at `NVarChar(100)` truncates the list and retires everything
past the cut.

**`Model.select()` cannot be used across a join.** It emits unqualified column
names, and every table here has `CreatedAt`/`DeletedAt`. Multi-table reads are
hand-qualified SQL; only the table names come from the models.

**Group membership has no department link.** "Finance" is a manually maintained
list. Somebody who changes department stays in it. Not a bug today, but not a
surprise later either.

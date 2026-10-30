# Access Control — the model

> Frontend developers want [ACCESS-CONTROL-FRONTEND.md](ACCESS-CONTROL-FRONTEND.md).
> This file is the backend: the schema, the resolver, and why it is shaped
> this way.

## The rule

```
employee ──belongs to──> GROUP ──holds rights on──> MODULE
                                   View Add Edit Delete Print Mail
```

One sentence, and it is the whole model. An employee has **one** group. A
group has one row per module carrying six boolean flags. A right that is not
in that row does not exist.

This is deliberately the model from the EHMS portal
(`D:\projects\EHMS_Portal_GitLab`), where `tblgroup`, `tblmodule` and
`tblaccessright` have carried the same six flags through ten years of screens
coming and going, and the administrators here already know how to operate it.

## What it replaced, and why

Migration `004` modelled access as a catalog of 64 permission codes granted
through three independent channels — roles, groups and per-user GRANT/DENY
rows — each carrying a row **scope** (`OWN < TEAM < DEPARTMENT < ALL`), with
the widest grant winning and any DENY overriding everything.

It was more expressive, and the expressiveness was the problem. "Why can this
person see that record?" had three tables to check and an aggregate to reason
about, and no single screen showed the truth. Migration `008` drops all nine
tables.

**What was genuinely lost:** row scope. A group either holds View on Employees
or it does not, and holding it means seeing every employee. If per-team
visibility is wanted again, it belongs as a `DataScope` column on
`tblAccessRight` — read in one place by the resolver — not as a return to
three grant channels.

## Schema — `db/migrations/008_group_access_control.sql`

### `dbo.tblModule`

One row per screen. `ModuleId` is **not** an identity: the ids come from
`MODULE` in `src/enums/module.enum.js` and are stored in `tblAccessRight`, so
renumbering one would silently move every group's rights onto a different
screen. New modules get new numbers; retired numbers are never reused.

Carries the menu shape as well — `ParentModuleId`, `RoutePath`, `Icon`,
`SortOrder`, `ShowInMenu` — so the menu and the page-rights lookup come from
the same table and cannot disagree about what exists.

### `dbo.tblGroup`

`GroupName` is unique among live rows (filtered index on `DeletedAt IS NULL`,
so a deleted group's name is free again). `IsSystem` marks Administrator.

### `dbo.tblAccessRight`

`(GroupId, ModuleId)` unique, six `BIT NOT NULL DEFAULT 0` flags.

The .NET table has these nullable; here they are not. A nullable bit gives
three states for a two-state question, and the absence of a row already means
"no access" — so `NULL` was a second way to say the same thing, and every read
site had to write `isnull(CanAdd, 0)`.

`ON DELETE CASCADE` from the group: deleting a group takes its rights with it.

### `dbo.tblEmployeeDetails.GroupId`

A single nullable column, as `tblManagingUser.GroupId` is in the .NET portal.

**One group, not many.** Two would mean deciding what "Add from one group and
Delete from the other, on the same module" resolves to — and the entire value
of this model is that there is one place to look.

`NULL` is meaningful: no group, no access to anything. That is the correct
default for a new joiner.

## The system group

`Administrator` is seeded with `IsSystem = 1` and **its rights are not stored
as rows at all** — `resolveAccess()` returns all-true for every module when
the group is the system group.

Two reasons:

1. **It cannot go stale.** Stored rows would be a snapshot of the modules that
   existed on the day it was seeded, so adding a module next month would
   silently lock administrators out of it until somebody re-ran the seed.
2. **It is the way back in.** A mistake on the rights screen can otherwise
   remove everyone's access to the rights screen, with no way to fix it
   through the API. The group API refuses to rename, strip or delete the
   system group for exactly this reason (`409 GROUP_IS_SYSTEM`).

## Resolving

`src/services/access-control.service.js` — one query, two recordsets:

1. every `tblAccessRight` row for the employee's group, joined to
   `tblModule` (active only) and `tblGroup` (live and active only)
2. the employee row itself, **without** filtering `DeletedAt` — a soft-deleted
   employee must come back so the guard can answer "deactivated" rather than
   "unknown"

An **inactive group yields no rights**. Deactivating a group is how an
administrator switches off a whole category of user without unpicking who is
in it, so it has to mean something at resolve time, not just on a list screen.

The result is a frozen `AccessContext`:

```js
access.can(MODULE.EMPLOYEES, ACTION.EDIT)   // one right
access.canReach(MODULE.EMPLOYEES)           // any right — "show the menu entry"
access.rightsFor(MODULE.EMPLOYEES)          // { canView, canAdd, ... }
access.groupId / access.groupName / access.isSystemGroup
access.exists / access.active
```

### Caching

Per employee, in `src/utils/access-cache.js`, with a TTL from
`ACCESS_CONTROL_CACHE_TTL_SECONDS`. The promise is cached before it settles,
so a burst of concurrent requests from one person produces one query.

Writes invalidate twice over: this instance clears immediately, and
`tblAccessControlStamp` is bumped **inside the same transaction** so other
instances notice within `ACCESS_CONTROL_STAMP_POLL_SECONDS`. A stamp that
moved for a change that rolled back would invalidate every cache for nothing.

Changing a group's rights clears the whole cache rather than tracking down
its members: the cache is keyed by employee, and a reverse index from group to
member would exist only to avoid a handful of re-resolves.

## Enforcing

`src/middlewares/permission.middleware.js`:

```js
router.delete(
  ROUTES.EMPLOYEES.DELETE,
  requireAccess(MODULE.EMPLOYEES, ACTION.DELETE),
  employeeController.remove,
);
```

The guard rejects an inactive or deleted employee **before** checking rights —
that is the only revocation that beats the access token's lifetime — then
checks the one flag.

`requireAuthenticatedAccess()` is for routes any signed-in employee may call
(`/access/me`, `/access/menu`, `/access/page`). It is a guard, not an absence
of one: it still rejects a deactivated account.

Both validate their arguments at **wiring** time. A typo in an action name
would otherwise read as `false` for everybody and look exactly like a
permissions bug.

### The boot-time audit

`src/utils/route-audit.js` walks the mounted router at startup and **refuses
to start** if any route under `/api/v1` has no guard.

This exists because the way access control gets weak is not malice — it is a
new endpoint copied from the one above it with the middleware argument
dropped. Nothing fails, the tests pass (the author is an administrator), and
it ships open to every signed-in user.

Two exceptions, both written down rather than inferred: `PUBLIC_ROUTES` (health
and the login endpoints) and `AUTHENTICATED_ONLY_ROUTES` (`/auth/me`,
`/auth/logout` — which must keep working for somebody deactivated mid-session,
or they would hold a live session they cannot end).

The audit also throws if it finds **zero** routes. The first version of it
walked Express 5's router wrongly, found nothing, and cheerfully reported that
all zero routes were guarded; a check that can pass vacuously is worse than no
check.

## Adding a module

1. Add the id to `MODULE` and an entry to `MODULE_CATALOG` in
   `src/enums/module.enum.js` — a **new** number, never a reused one.
2. `npm run db:seed:access`
3. Guard the routes with `requireAccess(MODULE.NEW_THING, ACTION.VIEW)`.

The Administrator group covers it immediately. Every other group starts with
nothing on it, which is the safe default — an administrator grants it on the
group screen. A module removed from the catalog is **deactivated**, not
deleted, so its `tblAccessRight` rows survive and a later re-grant finds the
old ticks intact.

## Files

| File | What |
|---|---|
| `db/migrations/008_group_access_control.sql` | the schema, and the drop of 004 |
| `src/enums/module.enum.js` | the module catalog and the six actions |
| `src/models/access-control.model.js` | the three tables plus the stamp |
| `src/services/access-control.service.js` | resolving, the menu, page rights |
| `src/services/group.service.js` | group CRUD, the matrix, membership |
| `src/middlewares/permission.middleware.js` | `requireAccess` |
| `src/utils/route-audit.js` | the boot-time guarantee |
| `src/controllers/access.controller.js`, `src/routes/access.routes.js` | the API |
| `scripts/seed-access.js` | seeds the catalog and the Administrator group |

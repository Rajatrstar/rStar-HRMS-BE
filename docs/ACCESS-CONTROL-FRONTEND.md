# Access Control — Frontend Implementation Guide

Everything a frontend developer needs to build the permission-aware UI for
rSTAR HRMS: the screens, the API contracts, and the patterns that keep them
consistent.

**Backend reference:** `src/middlewares/permission.middleware.js`,
`src/enums/permission.enum.js`, `src/services/access-control.service.js`.
Response envelope rules are in the main [README](../README.md#response-contract).

---

## 1. Read this first — the frontend is not the gate

Every check in this document is **user experience only**. It hides a menu item,
disables a button, and keeps a user out of a route they would only be bounced
from. **It is not security.**

The backend re-checks every permission on every request, with no exception and
no trust in anything the client sends.

Concretely:

- If you **forget a guard**, a user sees a button, clicks it, and gets a `403`
  with a clear message. Nothing leaks. It is a cosmetic bug.
- If the **backend check were missing**, the data is gone. That is our problem,
  not yours, and it is covered by a boot-time assertion that refuses to start
  the server if any route is unguarded.

Three things never to do:

1. Never ask the backend to "trust the frontend check to save a round trip".
2. Never decide **what to fetch** from a permission. Fetch it, and let the API
   decide what comes back — the API already filters rows by scope.
3. Never read a permission out of the JWT. The token carries no permissions, by
   design, and anything you decode client-side is attacker-controlled anyway.

---

## 2. Core concepts

### 2.1 Permission codes

A permission code is `module.action`, lowercase:

```
employees.view        leave.approve        roles.assign-permission
```

The **module** segment is load-bearing — it is how the catalog groups, and how
you build menus. You can always derive it client-side:

```js
const module = code.split('.')[0];   // 'employees'
```

### 2.2 The four scopes

A permission does not only answer *"can I do this?"* but *"to whose records?"*.

| Scope | Rank | Means |
| --- | --- | --- |
| `OWN` | 1 | Only the user's own record |
| `TEAM` | 2 | Themselves plus their **direct reports** (one level, not the whole tree) |
| `DEPARTMENT` | 3 | Everyone in their department |
| `ALL` | 4 | The whole organisation |

```ts
export const SCOPE_RANK = { OWN: 1, TEAM: 2, DEPARTMENT: 3, ALL: 4 } as const;
```

A Manager and an HR Admin both hold `employees.view`. The Manager holds it at
`TEAM`, the HR Admin at `ALL`. Same code, different data.

**You use scope to *label and explain*. The server uses it to *filter*.** When a
Manager calls `GET /employees`, the response already contains only their team —
you do not filter it again.

### 2.3 Where permissions come from

Three sources stack, then one rule removes:

```
1. ROLES    — the user's roles contribute their permissions
2. GROUPS   — the user's groups contribute theirs, on top
3. OVERRIDE GRANT — a per-user exception adds one more
4. OVERRIDE DENY  — a per-user exception REMOVES one, whatever granted it
```

Two rules decide the outcome:

- **DENY always wins.** It removes the permission entirely, no matter which role
  or group granted it. A DENY is absolute — it cannot "narrow" a scope.
- **Widest scope wins.** If a user holds `leave.view` at `OWN` from the Employee
  role and at `TEAM` from the Manager role, the effective scope is `TEAM`.

You need this in your head for the override preview screen (§6.4), where an
admin asks *"why can this person approve leave?"*.

### 2.4 The five master roles

| Role | Code | In one sentence |
| --- | --- | --- |
| Super Admin | `SUPER_ADMIN` | Everything, including role and permission management |
| HR Admin | `HR_ADMIN` | Full HR operations; can assign roles but not edit them |
| HR Executive | `HR_EXECUTIVE` | Day-to-day employee record maintenance |
| Manager | `MANAGER` | Team visibility and approvals, `TEAM` scope |
| Employee | `EMPLOYEE` | Self-service only, `OWN` scope |

> **Important for the user-access screen:** a manager must hold **both**
> `MANAGER` and `EMPLOYEE`. The Manager role deliberately omits self-service
> permissions like `leave.apply` — those come from Employee. Assigning `MANAGER`
> alone leaves a manager unable to book their own leave. Show a warning in the
> role picker when `MANAGER` is selected without `EMPLOYEE`.

---

## 3. Bootstrap sequence

```
POST /api/v1/auth/login          -> OTP sent to the work email
POST /api/v1/auth/verify-otp     -> { accessToken, refreshToken, tokenType, expiresIn }
     store the tokens
     ├── GET /api/v1/auth/me                     profile
     └── GET /api/v1/access/my-permissions       the ACL payload   <- the one that matters
     hydrate the access store
     THEN render the app shell
```

The last two calls run **in parallel**. Both must resolve before you render the
shell — otherwise the menu flashes items the user cannot use, which looks like a
bug and occasionally like a security hole to anyone watching. Show a splash or
skeleton until then.

On a hard page reload with a token already in storage, repeat from
`GET /auth/me`.

---

## 4. The `/access/my-permissions` contract

`GET /api/v1/access/my-permissions` — requires only a valid access token, no
permission.

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Permissions fetched",
  "data": {
    "employeeId": 12,
    "email": "anmol.ghai@rstartec.com",

    "roles":  [ { "roleId": 4, "code": "MANAGER",  "name": "Manager" },
                { "roleId": 5, "code": "EMPLOYEE", "name": "Employee" } ],
    "groups": [ { "groupId": 2, "code": "PAYROLL_REVIEWERS", "name": "Payroll Reviewers" } ],

    "scopeContext": {
      "employeeDetailId": 88,
      "departmentId": 3,
      "managerId": 41
    },

    "permissions": {
      "profile.view": "OWN",
      "profile.update": "OWN",
      "employees.view": "TEAM",
      "attendance.view": "TEAM",
      "attendance.approve": "TEAM",
      "leave.view": "TEAM",
      "leave.approve": "TEAM",
      "leave.apply": "OWN",
      "payslip.view": "OWN",
      "announcement.view": "ALL"
    },

    "modules": [
      { "code": "employees",   "name": "Employees",    "sortOrder": 10, "maxScope": "TEAM" },
      { "code": "attendance",  "name": "Attendance",   "sortOrder": 20, "maxScope": "TEAM" },
      { "code": "leave",       "name": "Leave",        "sortOrder": 30, "maxScope": "TEAM" },
      { "code": "payslip",     "name": "Payslips",     "sortOrder": 60, "maxScope": "OWN"  },
      { "code": "announcement","name": "Announcements","sortOrder": 70, "maxScope": "ALL"  }
    ],

    "version": "7f3c91a2b85d4e60",
    "generatedAt": "2026-10-19T09:12:03.221Z"
  }
}
```

### 4.1 Types

```ts
export type Scope = 'OWN' | 'TEAM' | 'DEPARTMENT' | 'ALL';

export interface MyPermissions {
  employeeId: number;
  email: string;
  roles:  Array<{ roleId: number;  code: string; name: string }>;
  groups: Array<{ groupId: number; code: string; name: string }>;
  scopeContext: {
    employeeDetailId: number | null;
    departmentId: number | null;
    managerId: number | null;
  };
  /** code -> effective scope. Presence of the key IS the permission. */
  permissions: Record<string, Scope>;
  modules: Array<{ code: string; name: string; sortOrder: number; maxScope: Scope }>;
  version: string;
  generatedAt: string;
}
```

### 4.2 Why this shape

**`permissions` is a map, not an array.** One lookup answers both *"can I?"* and
*"over what?"*. `can(code)` is `code in permissions` — O(1), no `.find()`, no Set
rebuilt on every render. An array of codes would lose scope; an array of objects
would force every consumer to build an index.

**There is no separate `codes[]` array.** It would be the same data twice, and it
drifts the moment someone filters one and not the other. `Object.keys(permissions)`
is one line.

**`modules[]` is not a duplicate of the permissions.** The permission map already
*is* the module tree — `code.split('.')[0]`. What you cannot derive is the
**display name and sort order**, and that is all `modules[]` carries, one entry
per module. It exists so menu building is `data.modules.map(...)` rather than a
hardcoded label dictionary in the frontend that drifts from the backend catalog.
`maxScope` is the widest scope the user holds anywhere in that module — useful
for a subtitle like "Your team".

**Scope is a string, not a rank number.** Strings survive a log line and a bug
report. Use `SCOPE_RANK` for the rare comparison.

**`scopeContext`** lets you decide locally whether a row is "mine" — to grey out
an edit button on an already-fetched list without a second call. It is **not** a
security boundary; it is just enough to avoid rendering a control that would 403.

**`version`** is a stable hash of the whole access set. It changes the instant
anything changes, and `GET /auth/me` returns the same value — see §4.3.

### 4.3 Caching and refresh

| When | Do |
| --- | --- |
| After `verify-otp` | Fetch, hydrate, then render |
| Hard reload with a token | Fetch again |
| `GET /auth/me` returns a different `permissionsVersion` | Refetch |
| Window regains focus, `generatedAt` older than 15 min | Refetch |
| **Any `403` response** | **Refetch, then re-evaluate** |
| Logout, or any `401` | Clear the store |

**The 403 rule is the important one.** A 403 means your cached map was wrong —
an admin changed something mid-session. Refetch, then look again: if the
permission really is gone, the button disappears on re-render and you show the
"access removed" message. If it is still there, it was a *scope* problem and the
error body already explains it.

Storage: keep it in **one** store (React context / Pinia / NgRx). Mirror to
`sessionStorage` keyed `acl:<employeeId>:<version>` so F5 does not flash an empty
menu. **Never `localStorage`** — it survives logout on a shared machine.

---

## 5. The permission-driven UI pattern

### 5.1 One provider, one hook

```ts
interface AccessApi {
  can(code: string): boolean;
  canAny(codes: string[]): boolean;
  canAll(codes: string[]): boolean;
  scopeOf(code: string): Scope | null;
  hasScopeAtLeast(code: string, min: Scope): boolean;
  canModule(moduleCode: string): boolean;
  isLoading: boolean;
  refresh(): Promise<void>;
}
```

```tsx
export function useAccess(): AccessApi { /* reads the store */ }

// Reference implementation of the two that matter
const can = (code: string) => code in acl.permissions;

const hasScopeAtLeast = (code: string, min: Scope) => {
  const mine = acl.permissions[code];
  return mine !== undefined && SCOPE_RANK[mine] >= SCOPE_RANK[min];
};
```

> **House rule: nothing outside this hook reads `permissions` directly.** One
> place to change when the payload shape moves.

### 5.2 Route guards

Declare them **in the route table**, not inside page components, so the entire
access map of the app is readable in one file.

```tsx
{ path: '/admin/roles',  element: <RequirePermission code="roles.view"><RolesPage /></RequirePermission> },
{ path: '/admin/groups', element: <RequirePermission code="groups.view"><GroupsPage /></RequirePermission> },
{ path: '/employees',    element: <RequirePermission code="employees.view"><EmployeesPage /></RequirePermission> },
```

**On failure, redirect to `/no-access`, never to login.** Bouncing an
already-logged-in user to a login screen is the single most confusing thing an
ACL frontend can do — they log in again, land in the same place, and file a
ticket. Unauthenticated is a *separate*, outer guard that does go to login.

### 5.3 Component and button guards

```tsx
<Can code="employees.create">
  <Button onClick={openCreate}>Add employee</Button>
</Can>

<Can code="employees.delete" fallback={<Tooltip title="Requires DEPARTMENT access">
  <span><Button disabled>Delete</Button></span>
</Tooltip>}>
  <Button danger onClick={confirmDelete}>Delete</Button>
</Can>
```

**The rule: hide navigational affordances, disable destructive ones with a
tooltip.** A menu item the user can never reach is noise — hide it. A delete
button on a row they can see but cannot delete is *information* — disable it and
say why. Never render an **enabled** control that is guaranteed to 403.

### 5.4 Menu generation

Driven by `data.modules`, never a hardcoded array.

```ts
// Presentation only. Presence, label and order all come from the server.
const MENU_META: Record<string, { path: string; icon: string }> = {
  employees:    { path: '/employees',    icon: 'users' },
  attendance:   { path: '/attendance',   icon: 'clock' },
  leave:        { path: '/leave',        icon: 'calendar' },
  payslip:      { path: '/payslips',     icon: 'file-text' },
  announcement: { path: '/announcements',icon: 'megaphone' },
  roles:        { path: '/admin/roles',  icon: 'shield' },
  groups:       { path: '/admin/groups', icon: 'users-cog' },
};

const menu = acl.modules
  .filter((m) => MENU_META[m.code])
  .sort((a, b) => a.sortOrder - b.sortOrder)
  .map((m) => ({ ...MENU_META[m.code], label: m.name, moduleCode: m.code }));
```

A module absent from `modules[]` never renders. Adding a module to the backend
catalog makes it appear here with no frontend release — only the `MENU_META`
entry for path and icon is needed.

### 5.5 Column- and field-level control

```tsx
// A column only some people may see
const columns = [
  { key: 'name',  title: 'Name' },
  { key: 'email', title: 'Work email' },
  ...(can('payroll.view') ? [{ key: 'ctc', title: 'CTC' }] : []),
];

// A field that is readable but not editable
<Input value={employee.designation} readOnly={!can('employees.update')} />
```

### 5.6 Scope-aware labelling

```tsx
const scope = scopeOf('employees.view');
const subtitle = {
  OWN: 'Your own record',
  TEAM: 'You and your direct reports',
  DEPARTMENT: 'Your department',
  ALL: 'All employees',
}[scope ?? 'OWN'];
```

Use `scopeContext` to disable a row action on somebody else's record:

```ts
const isMine = row.employeeDetailId === acl.scopeContext.employeeDetailId;
const isMyReport = row.managerId === acl.scopeContext.employeeDetailId;
```

**Do not re-filter the list the server returned.** It is already scoped. These
values are for disabling controls, nothing else.

---

## 6. Screens to build

### 6.1 Role management — `/admin/roles`

**Needs** `roles.view` to open; `roles.create` / `roles.update` / `roles.delete`
for the actions.

**List table:** Name · Code · Permissions count · Users count · System badge ·
Active · row actions (Edit, Permissions, Delete).

**Create / Edit drawer:** `name`, `description`. `code` is editable **only on
create** — after that it is immutable and rendered read-only.

**System roles** (the five masters) come back with `isSystem: true`. Render a
lock icon and disable rename/delete **from that flag** — do not rely on catching
the 403. Catch it as a backstop anyway.

**Delete** opens a confirm naming the user count. If the role still has users the
API answers `409` with `details.userCount`; show that, do not retry.

```
GET    /api/v1/roles?page=1&pageSize=20&search=
POST   /api/v1/roles                      { code, name, description? }
PATCH  /api/v1/roles/:roleId              { name?, description?, isActive? }
DELETE /api/v1/roles/:roleId
```

```jsonc
// RoleSummary
{ "roleId": 3, "code": "HR_EXECUTIVE", "name": "HR Executive",
  "description": "Day-to-day employee record maintenance",
  "isSystem": true, "isActive": true,
  "permissionCount": 18, "userCount": 7,
  "modifiedAt": "2026-10-19T08:11:02.000Z" }
```

### 6.2 Permission matrix — `/admin/roles/:roleId/permissions`

**The centrepiece.** Needs `roles.view` to open, `roles.assign-permission` to save.

**Layout.** Collapsible section per module, from `GET /permissions/catalog`. One
row per permission: a checkbox, the permission name and description, and a scope
`<select>` that is **enabled only when the row is checked and `isScoped` is
true**. A "select all" checkbox per module header.

**Scope dropdown options come from `catalog.scopes`** in the same response —
never hardcode the four values, so adding a scope later is a backend-only change.

**Dirty tracking** with an unsaved-changes guard on navigation.

**Save sends the entire desired state** — every checked permission with its
scope — via `PUT`. The screen is a grid and the user's mental model is "this is
the state I want", so a full replace means no diffing on your side and no lost
update when two cells change.

Send `expectedModifiedAt` from the role you loaded. If someone else saved
meanwhile the API answers `409 ROLE_MODIFIED_ELSEWHERE`; show "This role was
changed by someone else. Reload and reapply."

**There is no "create permission" button.** The catalog is read-only, by design —
permissions are code artefacts, and one created through a UI is a permission
nothing checks. Say so in a hint on the page if there is room.

```
GET /api/v1/permissions/catalog
GET /api/v1/roles/:roleId/permissions
PUT /api/v1/roles/:roleId/permissions
    { "permissions": [ { "permissionId": 12, "scope": "ALL" }, ... ],
      "expectedModifiedAt": "2026-10-19T08:11:02.000Z" }
```

```jsonc
// GET /permissions/catalog
{ "modules": [
    { "code": "employees", "name": "Employees", "sortOrder": 10,
      "permissions": [
        { "permissionId": 11, "code": "employees.view", "module": "employees",
          "action": "view", "name": "View employees",
          "description": "See employee records", "isScoped": true,
          "defaultScope": "OWN", "sortOrder": 10 }
      ] }
  ],
  "scopes": [
    { "value": "OWN",        "rank": 1, "name": "Own record only" },
    { "value": "TEAM",       "rank": 2, "name": "Self and direct reports" },
    { "value": "DEPARTMENT", "rank": 3, "name": "Whole department" },
    { "value": "ALL",        "rank": 4, "name": "Entire organisation" }
  ] }
```

### 6.3 Group management — `/admin/groups`

**Needs** `groups.view`; `groups.create` / `update` / `delete`,
`groups.manage-member`, `groups.assign-permission` for actions.

Same list + drawer pattern as roles. The detail view has **two tabs**:

**Permissions tab** — the *identical matrix component* as §6.2, pointed at the
group endpoints. Build it once, parameterise the endpoints and the "save"
permission. Do not fork it.

**Members tab** — a searchable employee picker, add/remove. Optimistic update
with rollback on failure.

Add a one-line hint on the page: *"Groups only add permissions. They can never
remove one — use a per-user DENY for that."*

```
GET    /api/v1/groups
POST   /api/v1/groups                            { code, name, description? }
GET    /api/v1/groups/:groupId
PATCH  /api/v1/groups/:groupId
DELETE /api/v1/groups/:groupId
GET    /api/v1/groups/:groupId/permissions
PUT    /api/v1/groups/:groupId/permissions       { permissions: [...] }
GET    /api/v1/groups/:groupId/members?search=
POST   /api/v1/groups/:groupId/members           { employeeIds: [12, 13] }
DELETE /api/v1/groups/:groupId/members/:employeeId
```

Membership is add/remove rather than full-replace because a group can hold
hundreds of people and the UI is a picker, not a grid.

### 6.4 User access and overrides — `/admin/users/:employeeId/access`

**Needs** `user-access.view` to open. Four panels on one page.

**Panel 1 — Roles.** Multi-select of all active roles, saved with
`PUT .../roles` (full replace). Needs `user-access.assign-role`.
Warn when `MANAGER` is selected without `EMPLOYEE` (see §2.4).

**Panel 2 — Groups.** Multi-select, `PUT .../groups`. Needs
`user-access.manage-group`.

**Panel 3 — Overrides.** Needs `user-access.override` (Super Admin only by
default). A table: Permission · Effect · Scope · Reason · Expires · Added by ·
When.

The add dialog:
- `permissionId` — searchable picker over the catalog
- `effect` — `GRANT` or `DENY`
- `scope` — **shown only for `GRANT` on a scoped permission.** Sending a scope
  with a `DENY` is rejected `422 SCOPE_NOT_SUPPORTED`; omitting it on a scoped
  `GRANT` is `422 SCOPE_REQUIRED`
- `reason` — **required**. An exception nobody can explain is the thing an
  auditor asks about first
- `expiresAt` — optional

Render DENY rows in red with the hint *"This removes the permission regardless
of role or group."*

**Panel 4 — Effective permissions (read-only).** From
`GET .../effective-permissions`. For each code: the final scope **and the source
chain**, so an admin can answer "why can this person approve leave?" without
guessing.

```jsonc
{ "employeeId": 12,
  "permissions": [
    { "code": "leave.approve", "effectiveScope": "TEAM", "granted": true,
      "sources": [ { "type": "ROLE",  "name": "Manager", "scope": "TEAM" } ] },
    { "code": "leave.view", "effectiveScope": "TEAM", "granted": true,
      "sources": [ { "type": "ROLE",  "name": "Employee", "scope": "OWN" },
                   { "type": "ROLE",  "name": "Manager",  "scope": "TEAM" } ] },
    { "code": "payroll.view", "effectiveScope": null, "granted": false,
      "sources": [ { "type": "GROUP",    "name": "Payroll Reviewers", "scope": "ALL" },
                   { "type": "OVERRIDE", "effect": "DENY",
                     "reason": "Under investigation — SEC-114" } ] }
  ] }
```

Render the third case with the group row struck through and the DENY row
highlighted — that single visual is what makes the whole model explainable to a
non-technical admin.

**Self-edit guard:** if the admin is viewing their own record, warn before
saving. The API answers `409 SELF_LOCKOUT_BLOCKED` if the change would remove
their own administrative access.

```
GET    /api/v1/access/users/:employeeId
GET    /api/v1/access/users/:employeeId/roles
PUT    /api/v1/access/users/:employeeId/roles        { roleIds: [1, 4] }
GET    /api/v1/access/users/:employeeId/groups
PUT    /api/v1/access/users/:employeeId/groups       { groupIds: [2] }
GET    /api/v1/access/users/:employeeId/overrides
POST   /api/v1/access/users/:employeeId/overrides
       { permissionId, effect, scope?, reason, expiresAt? }
PATCH  /api/v1/access/users/:employeeId/overrides/:overrideId
DELETE /api/v1/access/users/:employeeId/overrides/:overrideId
GET    /api/v1/access/users/:employeeId/effective-permissions
```

### 6.5 `/no-access`

Reached by route guards and by catching a 403. Shows: the attempted route, the
required permission code, a "request access" link (mailto or ticket), and a back
button. **Never auto-redirects to login.**

---

## 7. Error handling

Every response — success or failure — uses the same envelope:

```jsonc
{ "success": false, "statusCode": 403,
  "message": "You do not have permission to perform this action",
  "data": null,
  "details": { "code": "PERMISSION_DENIED", "required": ["employees.update"] } }
```

| Status | What it means | What to do |
| --- | --- | --- |
| **400** | Validation failed | Map `details` onto form fields by key. Nested keys like `permissions[2].scope` address a grid cell |
| **401** | Not authenticated, or token expired | Try the refresh token **once**. On failure, clear the store and go to login |
| **403** | Authenticated, but not allowed | Toast `message`. **Refetch `/my-permissions`.** Re-render. Never retry the call |
| **404** | Not found — **or outside your scope** | "Record not found". The ambiguity is deliberate; do not try to distinguish |
| **409** | Conflict | Show `message`. For `ROLE_MODIFIED_ELSEWHERE` offer reload; for `*_IN_USE` show the count from `details` |
| **422** | Semantically invalid payload | A bug in your request. Show `message`, log `details` |
| **429** | Rate limited | Back off; `details.retryAfterSeconds` tells you how long |

**Always render `body.message`. Never invent your own copy.** Every string comes
from one backend enum, so the wording stays consistent across every client; a
hand-written toast drifts the moment the backend rewords something.

`details.code` is a stable machine-readable string (`PERMISSION_DENIED`,
`SCOPE_DENIED`, `ROLE_IS_PROTECTED`, `SELF_LOCKOUT_BLOCKED`, …). Branch on
**that**, never on the message text.

### Why 403 and 404 split the way they do

On a **read**, a row outside your scope returns **404**, not 403 — otherwise the
response would confirm that an employee id exists, which is exactly what scoping
is meant to hide.

On a **write** to a row you *can* read but not modify, you get **403
`SCOPE_DENIED`** with the required scope in `details`. You already see the row on
screen, so a 404 there would be a lie that generates a support ticket.

---

## 8. Testing checklist

- [ ] Log in as each of the five master roles — five visibly different menus.
- [ ] Manager sees only direct reports in `/employees`; HR Admin sees everyone.
- [ ] Employee cannot reach `/admin/roles` by typing the URL directly.
- [ ] **Deep-link every protected route** with the URL bar, not just the menu.
- [ ] Add a DENY override for a permission the user's role grants → after
      refetch, the button is gone.
- [ ] Toggle a role permission in a second browser tab, then save in the first →
      the `409` concurrency path shows the reload prompt.
- [ ] Strip a permission mid-session, then click the stale button → 403 →
      automatic refetch → control disappears. **No logout.**
- [ ] Clear `sessionStorage` mid-session and reload → the app rehydrates
      cleanly, no empty-menu flash.
- [ ] Log out → the access store is empty and no permission survives in storage.

---

## 9. Appendix — permission catalog

Scoped permissions accept OWN / TEAM / DEPARTMENT / ALL; unscoped ones are a
plain yes/no.

| Module | Permissions | Scoped |
| --- | --- | --- |
| `profile` | view, update | yes |
| `employees` | view, create, update, delete, export | yes |
| `employee-document` | view, upload, delete | yes |
| `attendance` | view, mark, regularize, approve, export | yes |
| `leave` | view, apply, cancel, approve | yes |
| `leave` | configure | no |
| `payroll` | view, process | yes |
| `payroll` | configure | no |
| `payslip` | view, download | yes |
| `department` | view, create, update, delete | no |
| `designation` | view, create, update, delete | no |
| `announcement` | view, create, update, delete | no |
| `report` | headcount, attendance, payroll | yes |
| `roles` | view, create, update, delete, assign-permission | no |
| `permissions` | view | no |
| `groups` | view, create, update, delete, manage-member, assign-permission | no |
| `user-access` | view, assign-role, manage-group, override | no |

The authoritative list is always `GET /api/v1/permissions/catalog`, generated
from `src/enums/permission.enum.js`. Build the matrix screen from that response,
never from this table.

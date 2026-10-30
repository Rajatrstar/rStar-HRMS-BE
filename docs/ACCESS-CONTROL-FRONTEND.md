# Access Control — Frontend Guide

Everything the UI needs to render the right menu, the right buttons, and the
right screens for the signed-in user.

The model is the one the EHMS portal has run on for years, moved onto an API:

> **an employee belongs to a GROUP, and a group holds RIGHTS on MODULES.**

There is nothing else. No roles, no per-user exceptions, no row-level scopes.
If a user can do something, exactly one group gave it to them, and one screen
changes it.

---

## 1. Read this first — the frontend is not the gate

Hiding a button is a **courtesy to the user**, not security. Every endpoint
checks the same rights again on the server, and the server is the only thing
that decides. A page that forgets to hide Delete is a cosmetic bug; the
`DELETE` still comes back `403`.

This matters for how you write the UI:

- Never branch on a group **name**. `if (group === 'HR Admin')` is a rule that
  lives in your bundle and that no administrator can change. Branch on the
  **right** — `if (rights.canDelete)`.
- Never cache rights across logins, and never put them in `localStorage` for
  longer than the session. An administrator who revokes access expects it gone.
- Always handle `403` as a real possibility on every call, even one the user
  "shouldn't" have been able to make. Their rights can change mid-session.

---

## 2. The six rights

Every module carries the same six flags, and they always come back together:

| Flag | Means | Typical binding |
|---|---|---|
| `canView` | may open the screen and read it | the menu entry, the route guard, read-only mode |
| `canAdd` | may create new records | the **Create** / **Add New** button |
| `canEdit` | may change existing records | the **Edit** button, enabled form fields, **Save** |
| `canDelete` | may remove records | the **Delete** button, the row's bin icon |
| `canPrint` | may export or print | the **Print** / **Export to Excel** button |
| `canMail` | may email records out | the **Send** / **Share** button |

`canPrint` and `canMail` are separate from `canView` on purpose. "May read
this employee's record on screen" and "may walk out with a PDF of it" or "may
email it outside the company" are different decisions for HR data, and the
administrator is given them as different checkboxes.

**A user with no group has every flag false, everywhere.** That is the default
for a new joiner, and it is not an error state — show the shell, an empty menu,
and a "your account has no access yet, contact your administrator" panel.

---

## 3. Modules

A module is one screen. The ids are **fixed and permanent** — they are stored
against each group's rights, so they never change.

| Id | Code | Name | Route | Parent |
|---|---|---|---|---|
| 1 | `DASHBOARD` | Dashboard | `/dashboard` | — |
| 10 | `EMPLOYEE_MANAGEMENT` | Employee Management | *(heading)* | — |
| 11 | `EMPLOYEES` | Employees | `/employees` | 10 |
| 20 | `ORGANIZATION_SETUP` | Organization Setup | *(heading)* | — |
| 21 | `ORGANIZATIONS` | Organizations | `/organizations` | 20 |
| 22 | `LOCATIONS` | Locations | `/locations` | 20 |
| 30 | `ADMINISTRATION` | Administration | *(heading)* | — |
| 31 | `GROUPS` | User Groups | `/administration/groups` | 30 |
| 32 | `USER_ACCESS` | User Access | `/administration/user-access` | 30 |

A row with no route is a **heading** — it groups children in the menu and is
not navigable. Don't hard-code this table; read it from `GET /access/modules`
so a module added next month appears without a frontend release.

---

## 4. Bootstrap sequence

Straight after the OTP step of login succeeds and you hold an access token:

```
POST /auth/login          ->  OTP sent
POST /auth/verify-otp     ->  accessToken + refreshToken
GET  /access/me           ->  who they are, and the full rights map
GET  /access/menu         ->  the navigation tree, already filtered
```

Store the `/access/me` response in whatever your app uses for session state
(a context, a store — not `localStorage`). Everything else reads from it.

```js
const session = {
  employeeDetailId: 3,
  group: { groupId: 1, groupName: 'Administrator' },
  isSystemGroup: true,
  rightsByModule: { EMPLOYEES: { canView: true, canAdd: true, ... }, ... },
};

// The only helper you need in most of the app.
const can = (moduleCode, action) => Boolean(session.rightsByModule[moduleCode]?.[action]);

can('EMPLOYEES', 'canDelete');   // -> true
```

Refresh `/access/me` and `/access/menu` when the token is refreshed, and after
the user's own group is changed. Rights changes take effect on the server
immediately — there is no cache to wait out.

---

## 5. Menu binding

`GET /access/menu` returns the tree **already filtered** to what this user may
see. Render it as-is; do not filter it again.

```json
{
  "success": true,
  "data": [
    {
      "moduleId": 10,
      "moduleCode": "EMPLOYEE_MANAGEMENT",
      "label": "Employee Management",
      "path": null,
      "icon": "users",
      "rights": { "canView": true, "canAdd": true, "canEdit": true,
                  "canDelete": false, "canPrint": false, "canMail": false },
      "children": [
        {
          "moduleId": 11,
          "moduleCode": "EMPLOYEES",
          "label": "Employees",
          "path": "/employees",
          "icon": "user",
          "rights": { "canView": true, "canAdd": true, "canEdit": true,
                      "canDelete": false, "canPrint": false, "canMail": false }
        }
      ]
    }
  ]
}
```

Rules the server already applies, so you don't have to:

- A module the group holds **no** right on is absent.
- A heading whose children are all hidden is absent too — no empty dropdowns.
- Entries are sorted; render in the order given.

```jsx
{menu.map((section) =>
  section.children.length > 0 ? (
    <MenuGroup key={section.moduleCode} label={section.label} icon={section.icon}>
      {section.children.map((item) => (
        <MenuLink key={item.moduleCode} to={item.path}>{item.label}</MenuLink>
      ))}
    </MenuGroup>
  ) : (
    <MenuLink key={section.moduleCode} to={section.path}>{section.label}</MenuLink>
  ),
)}
```

---

## 6. Page binding — what you asked for

**When the user clicks a page, ask the API what they may do on it.** One call,
with the path the router already knows:

```
GET /access/page?path=/employees
```

```json
{
  "success": true,
  "data": {
    "moduleId": 11,
    "moduleCode": "EMPLOYEES",
    "moduleName": "Employees",
    "path": "/employees",
    "rights": {
      "canView": true, "canAdd": true, "canEdit": true,
      "canDelete": false, "canPrint": true, "canMail": false
    }
  }
}
```

Then bind the screen to it:

```jsx
function EmployeesPage() {
  const { rights, loading } = usePageRights('/employees');

  if (loading) return <Spinner />;
  if (!rights.canView) return <NoAccess />;

  return (
    <Page>
      <Toolbar>
        {rights.canAdd   && <Button onClick={create}>Add Employee</Button>}
        {rights.canPrint && <Button onClick={exportXlsx}>Export</Button>}
        {rights.canMail  && <Button onClick={share}>Email</Button>}
      </Toolbar>

      <Table
        rows={employees}
        actions={(row) => (
          <>
            {rights.canEdit   && <IconButton icon="pencil" onClick={() => edit(row)} />}
            {rights.canDelete && <IconButton icon="trash"  onClick={() => remove(row)} />}
          </>
        )}
      />
    </Page>
  );
}
```

A reusable hook, so no screen hard-codes a module id:

```js
export function usePageRights(path) {
  const [state, setState] = useState({ loading: true, rights: NO_RIGHTS });

  useEffect(() => {
    let live = true;
    api.get('/access/page', { params: { path } })
      .then((res) => live && setState({ loading: false, rights: res.data.data.rights }))
      // 404 = this path is not a module. 403 cannot happen here.
      .catch(() => live && setState({ loading: false, rights: NO_RIGHTS }));
    return () => { live = false; };
  }, [path]);

  return state;
}

const NO_RIGHTS = {
  canView: false, canAdd: false, canEdit: false,
  canDelete: false, canPrint: false, canMail: false,
};
```

You can also ask by `?moduleCode=EMPLOYEES` or `?moduleId=11`. Path is usually
the most convenient, because the page already knows its own URL.

> **Prefer the cached map for hot paths.** `/access/page` is a round trip. If
> you already hold `rightsByModule` from `/access/me`, read it from there and
> use `/access/page` for the initial load or when you want a fresh answer. Both
> return the same thing.

### Read-only mode beats a hidden screen

If a user has `canView` but not `canEdit`, **show the record with the fields
disabled** rather than refusing to open it. That is what the .NET portal does
("…are view only for your user group"), and it is the difference between a
user who can do their job and one who files a ticket.

### Route guarding

```js
<Route
  path="/employees"
  element={<RequireRight moduleCode="EMPLOYEES" action="canView"><EmployeesPage /></RequireRight>}
/>
```

```jsx
function RequireRight({ moduleCode, action, children }) {
  const { rightsByModule } = useSession();
  if (!rightsByModule[moduleCode]?.[action]) return <Navigate to="/no-access" replace />;
  return children;
}
```

---

## 7. The administration screens

Three screens, mirroring the .NET portal.

### 7.1 Group List — `/administration/groups`

`GET /access/groups?search=&page=1&pageSize=25`

| Column | From |
|---|---|
| Group Name | `groupName` |
| Description | `description` |
| Members | `memberCount` |
| Active | `isActive` |
| Edit | show when `canEdit` on `GROUPS` |
| Delete | show when `canDelete` on `GROUPS`, and **disable when `memberCount > 0`** |

Show the Delete button disabled with a tooltip rather than hidden when a group
has members — the server refuses it with `409 GROUP_HAS_MEMBERS`, and a
disabled button with a reason is a better answer than a failed click.

A group with `isSystem: true` (Administrator) must render **without** Edit or
Delete. The server refuses both with `409 GROUP_IS_SYSTEM`.

### 7.2 Add / Edit Group — `/administration/groups/:id`

This is the matrix screen. Two calls:

```
GET /access/modules                 -> the catalog (for a new group)
GET /access/groups/:groupId         -> the group AND its complete matrix
```

`GET /access/groups/:groupId` already returns **every** active module, with
zeros where the group holds nothing — so you render the grid straight from
`data.rights` without merging anything yourself:

```json
{
  "data": {
    "groupId": 4,
    "groupName": "Recruiters",
    "description": "Hiring team",
    "isSystem": false,
    "isActive": true,
    "memberCount": 6,
    "rights": [
      { "moduleId": 1,  "moduleCode": "DASHBOARD", "moduleName": "Dashboard",
        "parentModuleId": null, "routePath": "/dashboard", "sortOrder": 10,
        "canView": true, "canAdd": false, "canEdit": false,
        "canDelete": false, "canPrint": false, "canMail": false },
      { "moduleId": 11, "moduleCode": "EMPLOYEES", "moduleName": "Employees", "...": "..." }
    ]
  }
}
```

The grid: one row per module, six checkboxes, exactly like the .NET screen.

```
Module                  View   Add   Edit   Delete   Print   Mail
Dashboard                [x]   [ ]   [ ]     [ ]      [ ]     [ ]
Employee Management      [x]   [ ]   [ ]     [ ]      [ ]     [ ]
  Employees              [x]   [x]   [x]     [ ]      [x]     [ ]
Organization Setup       [ ]   [ ]   [ ]     [ ]      [ ]     [ ]
  Organizations          [ ]   [ ]   [ ]     [ ]      [ ]     [ ]
```

Indent children under their `parentModuleId` and order by `sortOrder`.

Two conveniences worth building, because an administrator setting up a group
otherwise clicks sixty boxes: a **select-all per row**, and **ticking Add,
Edit, Delete, Print or Mail auto-ticks View** (a user who may edit a screen
they cannot open is a contradiction the backend will honour literally).

Save with the whole matrix:

```http
PUT /access/groups/4
{
  "groupName": "Recruiters",
  "description": "Hiring team",
  "isActive": true,
  "rights": [
    { "moduleId": 11, "canView": true, "canAdd": true, "canEdit": true,
      "canDelete": false, "canPrint": true, "canMail": false },
    { "moduleId": 1,  "canView": true }
  ]
}
```

Omitted flags default to `false`. **Modules you leave out of the array are
left untouched** — so you can save one row from a partial edit if you want to,
but the screen normally posts all of them.

If the form state might not carry a valid name, use the rights-only endpoint
instead so a blank name field cannot block a sixty-row save:

```http
PUT /access/groups/4/rights
{ "rights": [ ... ] }
```

### 7.3 User Access — `/administration/user-access`

Who is in which group. One employee has exactly **one** group.

```http
GET    /access/groups/4/members?page=1&pageSize=25
PUT    /access/employees/17/group     { "groupId": 4 }
PUT    /access/employees/17/group     { "groupId": null }   // remove
DELETE /access/employees/17/group                            // same thing
POST   /access/groups/4/members       { "employeeDetailIds": [17, 18, 19] }
```

The bulk call is all-or-nothing and reports ids it could not find rather than
failing the whole batch:

```json
{ "data": { "groupId": 4, "assigned": [17, 18], "missing": [19] } }
```

---

## 8. Complete API reference

Base: `/api/v1`. Every call needs `Authorization: Bearer <accessToken>`.

### For every signed-in user — no right required

| Method | Path | Returns |
|---|---|---|
| `GET` | `/access/me` | group, `isSystemGroup`, `modules[]`, `rightsByModule{}` |
| `GET` | `/access/menu` | the filtered navigation tree |
| `GET` | `/access/page?path=` | the six rights for one page (also `?moduleCode=`, `?moduleId=`) |

### Modules — needs `GROUPS: canView`

| Method | Path | Notes |
|---|---|---|
| `GET` | `/access/modules` | the catalog. `?includeInactive=true` for retired ones |

### Groups — needs `GROUPS`

| Method | Path | Right | Notes |
|---|---|---|---|
| `GET` | `/access/groups` | `canView` | `?search=`, `?page=`, `?pageSize=`, `?includeInactive=` |
| `GET` | `/access/groups/:groupId` | `canView` | group + **complete** matrix + `memberCount` |
| `POST` | `/access/groups` | `canAdd` | `{ groupName, description?, isActive?, rights? }` → `201` |
| `PUT` | `/access/groups/:groupId` | `canEdit` | name, description, isActive and/or rights |
| `PUT` | `/access/groups/:groupId/rights` | `canEdit` | `{ rights: [...] }` only |
| `DELETE` | `/access/groups/:groupId` | `canDelete` | refused while it has members |

### Membership — needs `USER_ACCESS`

| Method | Path | Right | Notes |
|---|---|---|---|
| `GET` | `/access/groups/:groupId/members` | `canView` | paged |
| `POST` | `/access/groups/:groupId/members` | `canEdit` | `{ employeeDetailIds: [] }` |
| `PUT` | `/access/employees/:employeeDetailId/group` | `canEdit` | `{ groupId }` or `{ groupId: null }` |
| `DELETE` | `/access/employees/:employeeDetailId/group` | `canEdit` | remove from their group |

---

## 9. Error handling

Every failure uses the standard envelope, with the machine-readable code in
**`details.code`** — not in `data`.

```json
{
  "success": false,
  "statusCode": 403,
  "message": "You do not have permission to perform this action",
  "details": {
    "code": "PERMISSION_DENIED",
    "requiredAccess": { "module": "EMPLOYEES", "action": "delete" }
  }
}
```

| Status | `details.code` | What the UI should do |
|---|---|---|
| `401` | — | token missing, expired or revoked → refresh once, then sign out |
| `403` | `NO_GROUP_ASSIGNED` | **no group at all.** Show "your account has no access yet — contact your administrator". Do not say "permission denied"; the fix is a different one |
| `403` | `PERMISSION_DENIED` | their group lacks that right. `requiredAccess` names it — safe to show in a support ticket |
| `403` | `ACCOUNT_INACTIVE` | they have been deactivated or exited → sign out |
| `404` | `GROUP_NOT_FOUND` | the group was deleted by someone else → refresh the list |
| `404` | `UNKNOWN_MODULE` (on `/access/page`) | that path is not a module. A frontend bug, not a rights problem |
| `409` | `NAME_ALREADY_EXISTS` | duplicate group name → highlight the field |
| `409` | `GROUP_IS_SYSTEM` | Administrator cannot be changed → the button should not have been shown |
| `409` | `GROUP_HAS_MEMBERS` | `details.memberCount` says how many → "move these N people first" |
| `409` | `GROUP_INACTIVE` | assigning into a switched-off group |
| `400` | `UNKNOWN_MODULE` | a module id in the payload is not in the catalog |
| `400` | `DUPLICATE_MODULE_RIGHT` | the same module twice in one matrix |

A `403` arriving on a screen you rendered is **not** necessarily a bug — the
user's rights may have changed since the page loaded. Re-fetch `/access/me`
and re-render before showing an error.

---

## 10. Testing checklist

- [ ] A user with **no group** sees the shell, an empty menu, and a clear message
- [ ] A user with `canView` only: no Add, Edit, Delete, Print or Mail buttons anywhere
- [ ] …and the detail screen opens **read-only** rather than refusing
- [ ] Granting a right in another browser takes effect on **refresh**, with no re-login
- [ ] Removing a user's group takes effect the same way
- [ ] The Administrator group shows no Edit or Delete
- [ ] Deleting a group with members is prevented, with the count shown
- [ ] A deep link to a page the user cannot view redirects instead of flashing the screen
- [ ] A `403` from any call is handled without a blank page
- [ ] **Call a guarded endpoint from curl with a low-rights token** — it must be refused.
      That is the real test; everything above is the UI being polite

---

## 11. Common mistakes

| Don't | Do |
|---|---|
| `if (group === 'HR Admin')` | `if (rights.canEdit)` |
| Hard-code module ids in screens | Ask `/access/page?path=` with the route you already have |
| Filter the menu yourself | Render `/access/menu` as given |
| Build the matrix by merging modules + grants | Use `GET /access/groups/:id`, which returns it whole |
| Treat `403` as fatal | Re-fetch `/access/me`; their rights may have changed |
| Cache rights in `localStorage` across sessions | Keep them in session state, re-fetch on login and refresh |
| Hide a record the user may view but not edit | Show it disabled |

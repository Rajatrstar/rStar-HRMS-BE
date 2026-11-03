# Employee API — Frontend Contract

The endpoints behind the **Employees** screens (list, add, view, edit, exit, delete).

- **Base URL:** `{{baseUrl}}/api/v1` (local: `http://localhost:5000/api/v1`)
- **Auth:** every endpoint needs `Authorization: Bearer <accessToken>` (from `/auth/verify-otp` or `/auth/refresh`).
- **Permission:** each endpoint needs a right on the **EMPLOYEES** module (module id `11`). Use `GET /access/page?path=/employees` to decide which buttons to show. See [ACCESS-CONTROL-FRONTEND.md](./ACCESS-CONTROL-FRONTEND.md).
- **Postman:** `postman/rSTAR-HRMS-API.postman_collection.json` → folder **Employees**.

---

## 1. Endpoint summary

| # | Method | Path | Right needed | Purpose |
|---|--------|------|--------------|---------|
| 1 | `GET` | `/employees` | `canView` | Paged list with search and filters |
| 2 | `GET` | `/employees/:employeeDetailId` | `canView` | One employee (full profile) |
| 3 | `POST` | `/employees` | `canAdd` | Onboard a new employee |
| 4 | `PUT` | `/employees/:employeeDetailId` | `canEdit` | Update the profile (**full replace**) |
| 5 | `PATCH` | `/employees/:employeeDetailId/deactivate` | `canEdit` | Exit an employee (resign / terminate) |
| 6 | `DELETE` | `/employees/:employeeDetailId` | `canDelete` | Remove a record created by mistake (soft delete) |
| 7 | `GET` | `/employees/managers` | `canView` **or** `canAdd` **or** `canEdit` | Manager picker for the Hierarchy section |
| 8 | `GET` | `/employees/:employeeDetailId/work-experience` | `canView` | Work experience rows |
| 9 | `PUT` | `/employees/:employeeDetailId/work-experience` | `canAdd` or `canEdit` | Save the whole work experience table |
| 10 | `GET` | `/employees/:employeeDetailId/education` | `canView` | Education rows |
| 11 | `PUT` | `/employees/:employeeDetailId/education` | `canAdd` or `canEdit` | Save the whole education table |
| 12 | `GET` | `/employees/:employeeDetailId/dependents` | `canView` | Dependent rows |
| 13 | `PUT` | `/employees/:employeeDetailId/dependents` | `canAdd` or `canEdit` | Save the whole dependents table |
| 14 | `GET` | `/employees/:employeeDetailId/documents` | `canView` | Uploaded documents (PAN, Aadhaar) |
| 15 | `PUT` | `/employees/:employeeDetailId/documents/:documentType` | `canAdd` or `canEdit` | Upload or replace a document (multipart) |
| 16 | `DELETE` | `/employees/:employeeDetailId/documents/:documentType` | `canEdit` | Remove a document |
| 17 | `GET` | `{fileUrl}` e.g. `/uploads/employees/42/pan-….jpg` | `canView` | Download the file itself |

### Add Employee flow

The record has to exist before sections and documents can hang off it:

1. Fill the Hierarchy dropdowns from `GET /employees/managers?search=…`.
2. `POST /employees`. Take `data.employeeDetailId` from the response.
3. In parallel: `PUT …/work-experience`, `PUT …/education`, `PUT …/dependents` (skip any the user left empty), and `PUT …/documents/PAN` / `…/documents/AADHAAR` for each file chosen.
4. If any call in step 3 fails, the employee already exists. Open the profile in edit mode with the error, rather than posting the employee again (that returns `CODE_ALREADY_EXISTS`).

The edit screen uses the same section and document calls.

Related endpoints (other modules):

| Method | Path | Right needed | Purpose |
|--------|------|--------------|---------|
| `PUT` | `/access/employees/:employeeDetailId/group` | User Access `canEdit` | Assign an access group. Body `{ "groupId": 3 }` (or `null` to remove) |
| `DELETE` | `/access/employees/:employeeDetailId/group` | User Access `canEdit` | Remove the access group |
| `GET` | `/organizations/departments`, `/organizations/designations`, `/organizations/genders`, `/organizations/marital-statuses`, `/organizations/relationships`, `/organizations/employment-types`, `/organizations/job-roles`, `/organizations/employee-bands`, `/organizations/sources-of-hire`, `/organizations/onboarding-statuses`, `/organizations/background-verification-statuses`, `/organizations/tax-regimes`, `/organizations/billability-types`, … | that list's `canView` | Dropdown values for the employee form. Each accepts `?isActive=true&search=` |

> `groupId` is returned on the employee but **cannot** be set through `/employees`. Use the access endpoint above.

---

## 2. Response envelope (all endpoints)

**Success**

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Employees fetched",
  "data": { },
  "meta": { }
}
```

`meta` appears only on the paged list.

**Error**

```json
{
  "success": false,
  "statusCode": 409,
  "message": "That work email is already in use",
  "data": null,
  "details": { "code": "EMAIL_ALREADY_EXISTS" }
}
```

`details` is optional. Its shape depends on the error:

| Status | When | `details` |
|--------|------|-----------|
| `400` | Field validation failed | A map of field → message: `{ "workEmail": "Must be a valid email address", "firstName": "First name is required" }`. All bad fields come back at once. **No `code`.** |
| `400` | Business rule (bad manager, department…) | `{ "code": "MANAGER_NOT_FOUND" }` |
| `400` | Body is not valid JSON | `{ "reason": "..." }` |
| `401` | Token missing, invalid, expired or logged out | none — refresh the token or send the user to login |
| `403` | Missing right | `{ "code": "PERMISSION_DENIED" \| "NO_GROUP_ASSIGNED", "requiredAccess": { "module": "Employees", "action": "edit" } }` |
| `403` | Caller's own account was deactivated | `{ "code": "ACCOUNT_INACTIVE" }` |
| `404` | Employee does not exist or was deleted | `{ "code": "EMPLOYEE_NOT_FOUND" }` (a document that isn't on file: `DOCUMENT_NOT_FOUND`) |
| `409` | Conflict (duplicate, already exited, has reports…) | `{ "code": "...", ...extra }` |
| `500` | Server fault | none in production |

---

## 3. Data types and formats

| Thing | Format |
|-------|--------|
| **Dates you send** | `"YYYY-MM-DD"` only (e.g. `"2025-04-01"`). A full timestamp is rejected with 400. |
| **Dates you receive** | ISO timestamp at midnight UTC, e.g. `"2025-04-01T00:00:00.000Z"`. Use the first 10 characters as the date. **Don't convert to local time**, or the date can shift by a day. |
| **Ids** | JSON numbers (`employeeDetailId`, `departmentId`, `designationId`, `workLocationId`, `managerId`, `secondaryManagerId`, `additionalManagerId`). |
| **Booleans** | `isActive`, `workFromOffice`: `true` / `false` / `null`. |
| **Empty values** | Send `null`, `""`, or leave the key out. All three mean "no value". Strings are trimmed. |
| **Enums** | Case-sensitive. `"fulltime"` is rejected; send `"FullTime"`. |
| **Emails** | Stored lowercase. |

---

## 4. Endpoints

### 4.1 List employees

`GET /employees`

**Query parameters (all optional)**

| Param | Type | Notes |
|-------|------|-------|
| `page` | integer ≥ 1 | Default `1` |
| `pageSize` | integer ≥ 1 | Default `25`, max `200` (higher values are capped to 200) |
| `search` | string ≤ 100 | Partial match on `firstName`, `lastName`, `employeeCode`, `workEmail` |
| `employmentStatus` | enum | See [EMPLOYMENT_STATUS](#employment_status) |
| `isActive` | `true` / `false` | Without this, active and exited employees are both returned |
| `departmentId` | integer | |
| `managerId` | integer | Direct reports of this employee |

Sorted by `firstName`, then `lastName`.

**Example:** `GET /employees?page=1&pageSize=25&search=ravi&isActive=true`

**200 OK**

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Employees fetched",
  "data": [ { /* Employee object, see section 5 */ } ],
  "meta": { "total": 137, "page": 1, "pageSize": 25, "totalPages": 6 }
}
```

**Errors:** `400` (bad filter), `401`, `403`.

---

### 4.2 Get one employee

`GET /employees/:employeeDetailId`

**200 OK.** The [Employee object](#5-employee-object-response) plus two extra fields:

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Employee fetched",
  "data": {
    "employeeDetailId": 42,
    "employeeCode": "RSTR157",
    "firstName": "Ravi",
    "...": "...",
    "directReports": 3,
    "hasLogin": true,
    "managerName": "Super Admin",
    "secondaryManagerName": null,
    "additionalManagerName": null
  }
}
```

| Extra field | Meaning |
|-------------|---------|
| `managerName`, `secondaryManagerName`, `additionalManagerName` | "First Last" of each manager, or `null`. Use these to show the current values in the Hierarchy dropdowns. |
| `directReports` | How many live employees have this person as their primary manager. If it's above 0, **Exit** and **Delete** will fail, so warn the user first. |
| `hasLogin` | Whether this employee has a login account. |

**Errors:** `400` (id not a positive integer), `401`, `403`, `404` with `details.code` `EMPLOYEE_NOT_FOUND`.

---

### 4.3 Create employee

`POST /employees`

**Body:** see [section 6](#6-request-fields-create--update). **Required:** `employeeCode`, `firstName`, `lastName`, `workEmail`, `employmentType`, `dateOfJoining`.

Minimal example:

```json
{
  "employeeCode": "RSTR158",
  "firstName": "Priya",
  "lastName": "Sharma",
  "workEmail": "priya.sharma@rstartec.com",
  "employmentType": "FullTime",
  "dateOfJoining": "2025-11-10"
}
```

Typical example:

```json
{
  "employeeCode": "RSTR158",
  "firstName": "Priya",
  "middleName": null,
  "lastName": "Sharma",
  "workEmail": "priya.sharma@rstartec.com",
  "personalEmail": "priya@example.com",
  "phone": "+91 98765 43210",
  "dateOfBirth": "1996-08-21",
  "gender": "Female",
  "maritalStatus": "Single",
  "departmentId": 4,
  "designationId": 12,
  "department": "Engineering",
  "designation": "Software Engineer",
  "managerId": 42,
  "employmentType": "FullTime",
  "employmentStatus": "Active",
  "dateOfJoining": "2025-11-10",
  "probationEndDate": "2026-05-10",
  "userType": "Employee",
  "billableStatus": "Billable",
  "taxRegime": "New",
  "workFromOffice": true,
  "presentCity": "Mohali",
  "presentState": "Punjab",
  "presentCountry": "India"
}
```

What the server does:
- `employmentStatus` defaults to `"Active"` if you leave it out.
- `isActive` is always `true` on create.
- `employeeSerialNo` is generated by the server.
- **No login account is created.** That is a separate step.
- The new employee has **no access group** (`groupId: null`), so they can't do anything until one is assigned via `PUT /access/employees/:id/group`.

**201 Created.** `data` is the created [Employee object](#5-employee-object-response). Use `data.employeeDetailId` to navigate to the new profile.

**Errors**

| Status | `details.code` | Message / cause |
|--------|----------------|-----------------|
| `400` | *(field map)* | Validation failed |
| `400` | `MANAGER_NOT_FOUND` | `managerId` / `secondaryManagerId` / `additionalManagerId` is not an active employee |
| `400` | `MASTER_DATA_NOT_FOUND` | `departmentId` or `designationId` does not exist |
| `400` | `INVALID_EMPLOYMENT_STATUS` | `employmentStatus` is an exit status (`Exited`, `Resigned`, `Terminated`, `Inactive`). New employees can't start exited |
| `409` | `CODE_ALREADY_EXISTS` | "That employee code is already in use" |
| `409` | `EMAIL_ALREADY_EXISTS` | "That work email is already in use" |
| `401` / `403` | | |

---

### 4.4 Update employee

`PUT /employees/:employeeDetailId`

> ⚠️ **This is a full replace.** Any field you leave out (or send as `null`) is **cleared** on the server. Always send the entire form, starting from the object you got from `GET /employees/:id`.
>
> Three exceptions keep their current value when you leave them out: `employmentStatus`, `panNumber` and `aadharNumber`.

**Body:** same fields and the same required fields as Create ([section 6](#6-request-fields-create--update)).

**Fields this endpoint never changes**, even if you send them: `isActive`, `dateOfLeaving`, `dateOfRehire`, `groupId`, `employeeSerialNo`. To exit someone, use [Deactivate](#45-deactivate-exit-employee). To change access, use the access endpoint.

> **PAN / Aadhar:** `panNumber` and `aadharNumber` are write-only. They are **never returned**, so render them as empty inputs (e.g. "Enter to replace"). Send a value only when the user types one. Leaving them out keeps what is stored. They cannot be cleared through this API.

**Status rule:** if the employee is active, `employmentStatus` can't be an exit status (`Exited`, `Resigned`, `Terminated`, `Inactive`); use [Deactivate](#45-deactivate-exit-employee) for exits. If the employee has already exited, it **must** stay an exit status.

**200 OK.** `data` is the updated [Employee object](#5-employee-object-response).

**Errors:** same as Create, plus:

| Status | `details.code` | Cause |
|--------|----------------|-------|
| `400` | `MANAGER_NOT_FOUND` | Message "An employee cannot be their own manager" (manager id equals this employee) |
| `400` | `INVALID_EMPLOYMENT_STATUS` | Exit status on an active employee, or a non-exit status on an exited one. `details.employmentStatus` holds the field message |
| `404` | `EMPLOYEE_NOT_FOUND` | Employee does not exist or was deleted |

---

### 4.5 Deactivate (exit) employee

`PATCH /employees/:employeeDetailId/deactivate`

Use this when someone leaves the company. It sets `isActive: false`, records the leaving date and exit status, and **removes the employee's access** (login is refused right away; existing sessions stop working within about 60 seconds). The record stays visible in the list (`isActive=false`).

**Body**

| Field | Required | Rule |
|-------|----------|------|
| `dateOfLeaving` | ✅ | `YYYY-MM-DD`, must not be before `dateOfJoining` |
| `employmentStatus` | ✅ | One of `"Exited"`, `"Resigned"`, `"Terminated"`, `"Inactive"` |
| `contractorEndDate` | optional | `YYYY-MM-DD`. If you leave it out, the existing value is kept |

```json
{
  "dateOfLeaving": "2025-12-31",
  "employmentStatus": "Resigned"
}
```

**200 OK.** Message `"Employee exited. Their access has been withdrawn"`. `data` is the updated [Employee object](#5-employee-object-response).

**Errors**

| Status | `details.code` | Cause / extra fields |
|--------|----------------|----------------------|
| `400` | *(field map)* | Missing or invalid `dateOfLeaving` / `employmentStatus` |
| `400` | `INVALID_EXIT_DATE` | Leaving date is before joining date. Extra fields: `dateOfJoining`, `dateOfLeaving` |
| `409` | `SELF_ACTION_BLOCKED` | User tried to exit themselves |
| `409` | `EMPLOYEE_ALREADY_INACTIVE` | Already exited (often a double click). Extra fields: `employmentStatus`, `dateOfLeaving` |
| `409` | `EMPLOYEE_HAS_REPORTS` | Still has direct reports. Extra field: `directReports` (count). Reassign their team first. |
| `404` | `EMPLOYEE_NOT_FOUND` | Not found |

> There is currently **no "reactivate / rehire" endpoint**.

---

### 4.6 Delete employee

`DELETE /employees/:employeeDetailId`

Use this only for records **that should never have existed**, such as a duplicate, a typo, or a candidate who never joined. For people who left, use **Deactivate**. A deleted employee disappears from every endpoint (later GETs return 404). No body.

**200 OK**

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Employee deleted",
  "data": {
    "employeeDetailId": 57,
    "employeeCode": "RSTR158",
    "firstName": "Priya",
    "lastName": "Sharma"
  }
}
```

**Errors**

| Status | `details.code` | Cause |
|--------|----------------|-------|
| `409` | `SELF_ACTION_BLOCKED` | User tried to delete themselves |
| `409` | `EMPLOYEE_HAS_REPORTS` | Has direct reports (`directReports` count included) |
| `404` | `EMPLOYEE_NOT_FOUND` | Not found / already deleted |

---

### 4.7 Manager picker

`GET /employees/managers`

Fills the **Reporting Manager**, **Secondary Manager** and **Additional Manager** dropdowns. It returns only active, non-deleted employees, which are the same people the save will accept. Works for any group with View, Add **or** Edit on Employees.

| Param | Type | Notes |
|-------|------|-------|
| `search` | string ≤ 100 | Partial match on first name, last name, full name, employee code, work email |
| `excludeEmployeeDetailId` | integer | On the edit screen, pass the employee being edited (nobody can manage themselves) |
| `limit` | integer | Default 20, max 50 |

Call it as the user types (debounce ~300 ms). Sorted by first name, then last name.

**200 OK**

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Managers fetched",
  "data": [
    {
      "employeeDetailId": 2,
      "employeeCode": "EMP002",
      "firstName": "HR",
      "lastName": "Admin",
      "displayName": "HR Admin (EMP002)",
      "designation": "HR Manager",
      "department": null,
      "workEmail": "hr.admin@rstartec.com",
      "profilePhotoUrl": null
    }
  ]
}
```

Send the chosen `employeeDetailId` as `managerId` / `secondaryManagerId` / `additionalManagerId` on create or update.

---

### 4.8 Work experience, education, dependents

These three sections work the same way: **read the table, save the whole table**.

| Section | Path suffix | Row id field |
|---------|-------------|--------------|
| Work experience | `/work-experience` | `employeeWorkExperienceId` |
| Education | `/education` | `employeeEducationId` |
| Dependents | `/dependents` | `employeeDependentId` |

**GET** `/employees/:employeeDetailId/<section>` returns `data` as an array of rows (empty array if none).

**PUT** `/employees/:employeeDetailId/<section>` takes the full table:

```json
{
  "items": [
    { "employeeWorkExperienceId": 7, "companyName": "Acme Corp", "jobTitle": "Developer", "fromDate": "2020-01-01", "toDate": "2022-12-31" },
    { "companyName": "Initech", "jobTitle": "Lead", "fromDate": "2024-01-01" }
  ]
}
```

What the server does, in one transaction:

| Row in `items` | Result |
|----------------|--------|
| Has its id | That row is updated (all fields replaced, like the employee PUT) |
| Has no id | A new row is inserted |
| Existing row not in `items` | Removed |

- Send `{ "items": [] }` to clear the section.
- Max 50 rows per save.
- **200 OK** returns the saved table in the same shape as GET, with ids for the new rows. Replace your local table with it.

**Validation errors** are keyed by row index, so you can mark the right cell:

```json
{
  "success": false,
  "statusCode": 400,
  "message": "The submitted data is invalid",
  "data": null,
  "details": {
    "items[0].toDate": "To date cannot be before from date",
    "items[1].companyName": "Company name is required"
  }
}
```

**Other errors**

| Status | `details.code` | Cause |
|--------|----------------|-------|
| `400` | `SECTION_ROW_NOT_FOUND` | A row id doesn't belong to this employee or was already removed (e.g. another tab saved first). Reload the section. |
| `400` | `MASTER_DATA_NOT_FOUND` | A `qualificationId`, `specializationId` or `relationshipId` doesn't exist. `details.field` names it. |
| `404` | `EMPLOYEE_NOT_FOUND` | Employee not found |

#### Work experience row

| Field | Required | Type / rule | Max |
|-------|:--------:|-------------|-----|
| `employeeWorkExperienceId` | | integer, only for existing rows | |
| `companyName` | ✅ | string | 200 |
| `jobTitle` | ✅ | string | 150 |
| `fromDate` | ✅ | `YYYY-MM-DD` | |
| `toDate` | | `YYYY-MM-DD`, not before `fromDate`. Empty = current job | |
| `jobDescription` | | string | 4000 |
| `isRelevant` | | boolean | |

Returned newest first (by `fromDate`), with `employeeDetailId` and `modifiedAt` added.

#### Education row

| Field | Required | Type / rule | Max |
|-------|:--------:|-------------|-----|
| `employeeEducationId` | | integer, only for existing rows | |
| `instituteName` | ✅ | string | 250 |
| `qualificationId` | | integer, from `GET /organizations/qualifications` | |
| `specializationId` | | integer, from `GET /organizations/specializations` | |
| `degree` | | string, e.g. "B.Tech" | 150 |
| `dateOfCompletion` | | `YYYY-MM-DD` | |
| `grade` | | string, e.g. "8.1 CGPA" or "72%" | 50 |

Returned with `qualificationName` and `specializationName` added for display.

#### Dependent row

| Field | Required | Type / rule | Max |
|-------|:--------:|-------------|-----|
| `employeeDependentId` | | integer, only for existing rows | |
| `name` | ✅ | string | 150 |
| `relationshipId` | ✅ | integer, from `GET /organizations/relationships` | |
| `dateOfBirth` | | `YYYY-MM-DD` | |
| `gender` | | string (see gender suggestions) | 30 |
| `contactNumber` | | string | 20 |

Returned with `relationshipName` added for display.

---

### 4.9 Documents (PAN and Aadhaar uploads)

`:documentType` is `PAN` or `AADHAAR` (case doesn't matter in the URL). Each employee has at most one of each.

#### Upload or replace

`PUT /employees/:employeeDetailId/documents/:documentType`

Send `multipart/form-data` with the file in a field named **`file`**. Don't set `Content-Type` yourself; the browser adds the boundary.

```js
const form = new FormData();
form.append('file', fileInput.files[0]);
await fetch(`${baseUrl}/employees/${id}/documents/PAN`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${token}` },
  body: form,
});
```

- Accepted: **JPEG, PNG, WebP, PDF**, up to **5 MB**. The server checks the file's actual contents, not its name or extension.
- Uploading again replaces the old file (the old one is deleted).

**200 OK**

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Document uploaded",
  "data": {
    "employeeDocumentId": 12,
    "employeeDetailId": 42,
    "documentType": "PAN",
    "fileUrl": "/uploads/employees/42/pan-bcddd09c-881e-4c76-bf3b-ab028774a479.png",
    "originalFileName": "pan card.png",
    "mimeType": "image/png",
    "fileSizeBytes": 70,
    "createdAt": "2026-11-03T05:10:20.123Z",
    "modifiedAt": "2026-11-03T05:10:20.123Z"
  }
}
```

**Errors**

| Status | `details.code` | Cause |
|--------|----------------|-------|
| `400` | `INVALID_FILE` | No file in the `file` field, file over 5 MB (`details.reason: "LIMIT_FILE_SIZE"`, `details.maxFileMb`), or not JPEG/PNG/WebP/PDF |
| `400` | *(field map)* | `documentType` is not `PAN` or `AADHAAR` |
| `409` | `MODIFIED_ELSEWHERE` | Two uploads of the same document type for the same employee landed at the same moment; one won. Reload the list and retry if needed. |
| `404` | `EMPLOYEE_NOT_FOUND` | Employee not found |

#### List

`GET /employees/:employeeDetailId/documents` returns an array of document objects (same shape as above). An empty array means nothing has been uploaded.

#### Delete

`DELETE /employees/:employeeDetailId/documents/:documentType` (needs `canEdit`). Returns `{ "employeeDocumentId": 12, "documentType": "PAN" }`. Returns `404` with `DOCUMENT_NOT_FOUND` if there is none.

#### Showing or downloading the file

`fileUrl` is a path under the API base URL: `GET {{baseUrl}}{fileUrl}`, e.g. `http://localhost:5000/api/v1/uploads/employees/42/pan-….png`.

The file **requires the bearer token** (these are government IDs), so a plain `<img src>` won't work. Fetch it and use an object URL:

```js
const res = await fetch(`${baseUrl}${doc.fileUrl}`, { headers: { Authorization: `Bearer ${token}` } });
const url = URL.createObjectURL(await res.blob());
img.src = url;              // for images
// window.open(url);        // for PDFs
// URL.revokeObjectURL(url) when done
```

Without a token it returns `401`. Without View on Employees it returns `403`.

---

## 5. Employee object (response)

Returned by list, detail, create, update and deactivate. Every field is always present. Any field can be `null` unless marked *not null*.

| Field | Type | Notes |
|-------|------|-------|
| `employeeDetailId` | number | *not null.* Primary id, used in URLs |
| `employeeSerialNo` | number | *not null.* Generated by the server |
| `employeeCode` | string | *not null.* e.g. `RSTR157`, unique |
| `internalEmployeeId` | string | Read-only (Zoho import) |
| `firstName` / `middleName` / `lastName` / `nickName` | string | first & last *not null* |
| `workEmail` | string | *not null*, unique |
| `personalEmail` | string | |
| `phone` | string | Personal mobile |
| `workPhone`, `workPhoneExtension` | string | |
| `emergencyContactNumber`, `emergencyContactRelation` | string | |
| `dateOfBirth` | date | |
| `gender`, `maritalStatus` | string | |
| `address` | string | Present address, full text |
| `presentAddressLine1/2`, `presentCity`, `presentState`, `presentCountry`, `presentPostalCode` | string | |
| `permanentAddress` | string | Full text |
| `permanentAddressLine1/2`, `permanentCity`, `permanentState`, `permanentCountry`, `permanentPostalCode` | string | |
| `departmentId`, `designationId`, `workLocationId` | number | Master-data ids |
| `department`, `designation`, `workLocation` | string | Display text, stored as written |
| `jobRole`, `employeeBand`, `userType`, `sourceOfHire`, `seatingLocation` | string | |
| `managerId` | number | Primary reporting manager (`employeeDetailId`) |
| `secondaryManagerId`, `additionalManagerId` | number | |
| `employmentType` | string | *not null.* [EMPLOYMENT_TYPE](#employment_type) |
| `employmentStatus` | string | *not null.* [EMPLOYMENT_STATUS](#employment_status) |
| `dateOfJoining` | date | *not null* |
| `probationEndDate`, `contractorEndDate` | date | |
| `dateOfLeaving` | date | Set only by Deactivate |
| `dateOfRehire` | date | Read-only |
| `totalExperience` | string | Free text, e.g. `"0 to 50"` |
| `currentExperience` | number | Years, up to 2 decimal places |
| `onboardingStatus`, `approvalStatus`, `backgroundVerificationStatus` | string | |
| `workFromOffice` | boolean | |
| `billableStatus`, `projectName`, `taxRegime` | string | |
| `systemConfiguration`, `additionalAccessories` | string | |
| `aboutMe`, `expertise`, `tags` | string | |
| `profilePhotoUrl` | string | http(s) URL |
| `isActive` | boolean | *not null.* `false` = exited or deleted |
| `groupId` | number | Access group. `null` = no access |

**Never returned:** `panNumber`, `aadharNumber`, `zohoUserId`, `zohoRecordId`, and audit columns (`createdBy`, `createdAt`, …).

---

## 6. Request fields (Create & Update)

Max lengths match the database column widths. Anything longer is rejected with a 400; it is never silently truncated.

| Field | Required | Type / rule | Max |
|-------|:--------:|-------------|-----|
| `employeeCode` | ✅ | string, unique | 50 |
| `firstName` | ✅ | string | 100 |
| `middleName` | | string | 100 |
| `lastName` | ✅ | string | 100 |
| `nickName` | | string | 150 |
| `workEmail` | ✅ | email, unique | 255 |
| `personalEmail` | | email | 255 |
| `phone`, `workPhone`, `workPhoneExtension`, `emergencyContactNumber` | | string (`+`, spaces, brackets allowed) | 20 |
| `emergencyContactRelation` | | string | 50 |
| `dateOfBirth` | | `YYYY-MM-DD` | |
| `gender`, `maritalStatus` | | string (suggested values below) | 30 |
| `address`, `permanentAddress` | | string | 4000 |
| `presentAddressLine1/2`, `permanentAddressLine1/2` | | string | 255 |
| `presentCity/State/Country`, `permanentCity/State/Country` | | string | 100 |
| `presentPostalCode`, `permanentPostalCode` | | string | 20 |
| `panNumber`, `aadharNumber` | | string (write-only, kept when omitted, see 4.4) | 20 |
| `departmentId` | | integer, must exist in Departments | |
| `designationId` | | integer, must exist in Designations | |
| `workLocationId` | | integer | |
| `workLocation`, `designation`, `department`, `jobRole`, `seatingLocation` | | string | 150 |
| `employeeBand` | | string | 50 |
| `userType` | | enum [USER_TYPE](#user_type) | 50 |
| `sourceOfHire` | | string | 100 |
| `managerId`, `secondaryManagerId`, `additionalManagerId` | | integer, must be an **active** employee, not self | |
| `employmentType` | ✅ | enum [EMPLOYMENT_TYPE](#employment_type) | 30 |
| `employmentStatus` | | enum [EMPLOYMENT_STATUS](#employment_status). Create defaults to `Active`; Update keeps the current value | 30 |
| `dateOfJoining` | ✅ | `YYYY-MM-DD` | |
| `probationEndDate`, `contractorEndDate` | | `YYYY-MM-DD` | |
| `totalExperience` | | string | 50 |
| `currentExperience` | | number 0 – 999.99 | |
| `onboardingStatus`, `approvalStatus`, `backgroundVerificationStatus` | | string (suggested values below) | 50 |
| `workFromOffice` | | boolean | |
| `billableStatus` | | enum [BILLABLE_STATUS](#billable_status) | 20 |
| `projectName` | | string | 200 |
| `taxRegime` | | enum [TAX_REGIME](#tax_regime) | 20 |
| `systemConfiguration`, `additionalAccessories`, `tags` | | string | 500 |
| `aboutMe`, `expertise` | | string | 4000 |
| `profilePhotoUrl` | | URL starting `http://` or `https://` | 2048 |

Fields not in this table are ignored.

---

## 7. Enum values

**Enforced:** the server rejects any other value with a 400.

#### EMPLOYMENT_TYPE
`FullTime`, `PartTime`, `Contract`, `Intern`, `Consultant`, `Permanent`, `Temporary`

#### EMPLOYMENT_STATUS
`Active`, `OnLeave`, `NoticePeriod`, `Exited`, `Suspended`, `Inactive`, `Resigned`, `Terminated`

> On the add form and on the edit form for active employees, offer only `Active`, `OnLeave`, `NoticePeriod`, `Suspended`. For exited employees (`isActive: false`), offer only `Exited`, `Resigned`, `Terminated`, `Inactive`. The server enforces both rules (`INVALID_EMPLOYMENT_STATUS`).

#### USER_TYPE
`Employee`, `Contractor`, `Vendor`, `Intern`

#### BILLABLE_STATUS
`Billable`, `Non-Billable`

#### TAX_REGIME
`New`, `Old`

**Suggested only:** free text is accepted. Prefer the master-data dropdown endpoints where they exist.

| Field | Suggested values |
|-------|------------------|
| `gender` | `Male`, `Female`, `Other`, `PreferNotToSay` |
| `maritalStatus` | `Single`, `Married`, `Divorced`, `Widowed`, `PreferNotToSay` |
| `onboardingStatus` | `Not Triggered`, `In Progress`, `Completed` |
| `backgroundVerificationStatus` | `Not Initiated`, `In Progress`, `Cleared`, `Failed` |
| `approvalStatus` | `Not Submitted`, `Pending`, `Approved`, `Rejected` |

---

## 8. Frontend checklist

- [ ] Show or hide Add / Edit / Exit / Delete using `GET /access/page?path=/employees` (`canAdd`, `canEdit`, `canDelete`). The server enforces these rights anyway.
- [ ] Show 400 `details` messages next to the matching form fields.
- [ ] On the edit screen, load `GET /employees/:id` and PUT back the **whole** object, because missing fields are cleared (except status, PAN and Aadhar).
- [ ] Send dates as `YYYY-MM-DD`; read them with `value.slice(0, 10)`.
- [ ] Before Exit or Delete, check `directReports` from the detail call and ask the user to reassign the team first.
- [ ] Hide Exit and Delete on the logged-in user's own record (the server returns `SELF_ACTION_BLOCKED`).
- [ ] Disable the submit button while a request is in flight, to avoid `EMPLOYEE_ALREADY_INACTIVE` from double clicks.
- [ ] After creating an employee, prompt the user to assign an access group.
- [ ] Hierarchy dropdowns: search with `GET /employees/managers` and pass `excludeEmployeeDetailId` on the edit screen. Show the current values from `managerName` etc. on the detail response.
- [ ] Section tables: keep each row's id from GET and send it back on PUT. Rows without an id are new. Replace the local table with the PUT response.
- [ ] Map `items[i].field` errors to row `i`, column `field`.
- [ ] Uploads: `multipart/form-data`, field `file`, max 5 MB, JPEG/PNG/WebP/PDF. Check size and type in the browser first for a faster message.
- [ ] Display uploaded files by fetching `{{baseUrl}}{fileUrl}` with the token and using an object URL.

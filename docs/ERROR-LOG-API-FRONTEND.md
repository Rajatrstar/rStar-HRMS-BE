# Error Log API — frontend contract

The endpoints behind the admin **Error Logs** dashboard, and the one every screen uses to report its own crashes. The server records its own failures automatically. This API lets an admin read, triage, resolve and clear them.

- **Base URL:** `{{baseUrl}}/api/v1/error-logs`
- **Auth:** `Authorization: Bearer <accessToken>` on every call
- **Permission:** module `ERROR_LOGS` (id 33) under Administration, frontend route `/administration/error-logs`. Check with `GET /access/page?path=/administration/error-logs`. Only the Administrator group has it by default.
- **Postman:** `rSTAR-HRMS-API` collection, folder **Error Logs**. Requests 16–21 are the dashboard's ready-made views (403s, 409s, open 5xx, 14-day summary, top issue drill-down, search).
- **Sample data:** the dev database has about 60 sample entries over the last 14 days, covering every source and severity, with repeats of one issue and some resolved. Their `serverName` is `sample-seed`. Backend: `npm run db:seed:errorlogs` refreshes them; `npm run db:seed:errorlogs -- --clear` removes them.
- Response envelope, 400 field maps, 401 and 403 work exactly as in [EMPLOYEE-API-FRONTEND.md](EMPLOYEE-API-FRONTEND.md).

## 1. Endpoint summary

| Method | Path | Right | Purpose |
|--------|------|-------|---------|
| `GET` | `/error-logs` | canView | Paged list with filters and search |
| `GET` | `/error-logs/summary` | canView | Dashboard numbers: totals, by source and status, per day, top issues |
| `GET` | `/error-logs/:errorLogId` | canView | One entry in full: stack trace, request body, how often it happened |
| `PUT` | `/error-logs/:errorLogId` | canEdit | Resolve or reopen with a note, optionally for every occurrence |
| `DELETE` | `/error-logs/:errorLogId` | canDelete | Delete permanently; `?allOccurrences=true` clears the whole issue |
| `POST` | `/error-logs` | any signed-in user | The frontend reports its own error |

## 2. What gets logged

| Source | Severity | When |
|--------|----------|------|
| `API` | `ERROR` | Any API call that answered **5xx** |
| `API` | `WARN` | Any API call that answered **403** or **409** |
| `JOB` | `ERROR` | An email that failed after its last retry, or a background job that crashed |
| `PROCESS` | `FATAL` | The server crashed on an uncaught error |
| `STARTUP` | `FATAL` | The server failed to start |
| `CLIENT` | `WARN` / `ERROR` | Sent by the frontend through `POST /error-logs` |

Not logged: 400, 401, 404. Passwords, OTPs, tokens, cookies and PAN / Aadhaar numbers are stored as `"[REDACTED]"`. The same failure is stored at most 10 times a minute (the rest are only counted). Entries older than 90 days are deleted automatically.

## 3. Request id — the "ref" a user can quote

Every response carries an `X-Request-Id` header (exposed to browser code). A logged failure (5xx, 403, 409) also returns it in the body:

```json
{
  "success": false,
  "statusCode": 500,
  "message": "Something went wrong on our end",
  "data": null,
  "details": { "requestId": "5c0c800b-d83e-4a19-957c-ae5ad1d9c9ed" }
}
```

Show its first 8 characters on the error toast ("Something went wrong. Ref 5c0c800b"). An admin finds the entry with `GET /error-logs?requestId=<full id>`.

## 4. Endpoints

### 4.1 List — `GET /error-logs`

Newest first. Rows are light (no `stackTrace` / `requestBody`; use the detail call).

| Param | Type | Notes |
|-------|------|-------|
| `page` | integer ≥ 1 | Default 1 |
| `pageSize` | integer ≥ 1 | Default 25, max 100 (capped) |
| `from`, `to` | `YYYY-MM-DD` | UTC days, inclusive. `from` after `to` → 400 |
| `source` | enum | `API` `JOB` `PROCESS` `STARTUP` `CLIENT` |
| `severity` | enum | `WARN` `ERROR` `FATAL` |
| `statusCode` | integer | Exact status |
| `statusGroup` | enum | `4xx` or `5xx` |
| `isResolved` | true / false | Open issues: `false` |
| `errorCode` | string ≤ 100 | e.g. `PERMISSION_DENIED` |
| `fingerprint` | 64 hex | Every occurrence of one issue |
| `employeeDetailId` | integer | Failures one user hit |
| `requestId` | UUID | Not a UUID → 400 |
| `search` | string ≤ 200 | Partial match on message, route, URL, error name |

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Error logs fetched",
  "data": [
    {
      "errorLogId": 412,
      "requestId": "5c0c800b-d83e-4a19-957c-ae5ad1d9c9ed",
      "occurredAt": "2026-11-03T09:34:31.712Z",
      "source": "API",
      "severity": "ERROR",
      "httpMethod": "PUT",
      "routePattern": "/api/v1/employees/:employeeDetailId/education",
      "url": "/api/v1/employees/42/education",
      "statusCode": 500,
      "errorCode": null,
      "errorName": "RequestError",
      "message": "Timeout: Request failed to complete in 60000ms",
      "employeeDetailId": 7,
      "employeeName": "Priya Sharma",
      "durationMs": 60012,
      "serverName": "hrms-api-01",
      "environment": "production",
      "fingerprint": "ab3276034db47a23378ffa6a3bda21bbb907a6ddf6ec21e7dbb46c58bf08e5c6",
      "isResolved": false,
      "resolvedAt": null
    }
  ],
  "meta": { "total": 37, "page": 1, "pageSize": 25, "totalPages": 2 }
}
```

**Errors:** 400 (bad filter, `details` names the field), 401, 403.

### 4.2 Summary — `GET /error-logs/summary`

Query `from`, `to` (`YYYY-MM-DD`, UTC, inclusive). **Without them: the last 7 days including today.**

```json
{
  "range": { "from": "2026-10-28", "to": "2026-11-03" },
  "totals": { "total": 58, "unresolved": 41, "bySeverity": { "WARN": 39, "ERROR": 18, "FATAL": 1 } },
  "bySource": [ { "source": "API", "count": 49 }, { "source": "CLIENT", "count": 8 } ],
  "byStatusCode": [ { "statusCode": 403, "count": 30 }, { "statusCode": 500, "count": 10 } ],
  "daily": [ { "date": "2026-11-03", "total": 37, "warn": 24, "error": 13 } ],
  "topIssues": [
    {
      "fingerprint": "ab32…e5c6", "occurrences": 12, "unresolved": 12,
      "firstSeen": "2026-11-02T06:10:24.931Z", "lastSeen": "2026-11-03T09:34:31.712Z",
      "latestErrorLogId": 412, "source": "API", "severity": "ERROR", "statusCode": 500,
      "httpMethod": "PUT", "routePattern": "/api/v1/employees/:employeeDetailId/education",
      "errorName": "RequestError", "errorCode": null,
      "message": "Timeout: Request failed to complete in 60000ms"
    }
  ]
}
```

- `daily` lists only days that had entries. Fill gaps with 0. `error` counts ERROR + FATAL.
- `topIssues`: the 10 most frequent issues. One issue = one `fingerprint` (same failure, same place in the code, whatever ids were in the URL). Drill in with `?fingerprint=…` or open `latestErrorLogId`.

**Errors:** 400, 401, 403.

### 4.3 Detail — `GET /error-logs/:errorLogId`

Every list field, plus:

| Field | Notes |
|-------|-------|
| `stackTrace` | Show in a monospace block that keeps line breaks |
| `sqlErrorNumber` | Database errors: 2627/2601 duplicate key, 547 foreign key, 1205 deadlock, -2 timeout |
| `requestBody` | JSON with secrets masked. Over 8 KB it is cut and may arrive as a **string** — handle both |
| `ipAddress`, `userAgent` | |
| `resolvedBy`, `resolvedByName`, `resolutionNote` | |
| `occurrences`, `firstSeen`, `lastSeen` | Across every entry with the same fingerprint |

**Errors:** 400, 401, 403, 404 `ERROR_LOG_NOT_FOUND` (also after delete or the 90-day purge).

### 4.4 Resolve / reopen — `PUT /error-logs/:errorLogId`

| Field | Required | Type | Notes |
|-------|:--------:|------|-------|
| `isResolved` | ✅ | boolean | `false` reopens and clears who/when |
| `resolutionNote` | | string ≤ 1000 | Replaces the stored note; leaving it out clears it |
| `applyToAllOccurrences` | | boolean | Same change for every entry with the same fingerprint |

```json
{ "isResolved": true, "resolutionNote": "Raised DB timeout; fixed in 0.1.4", "applyToAllOccurrences": true }
```

Returns the full detail object plus `affectedRows`. The server sets `resolvedBy` (the caller) and `resolvedAt`.

**Errors:** 400 (missing `isResolved`), 401, 403, 404 `ERROR_LOG_NOT_FOUND`.

### 4.5 Delete — `DELETE /error-logs/:errorLogId[?allOccurrences=true]`

Permanent; no soft delete. Returns `{ "errorLogId": 412, "deletedCount": 12 }`. Prefer resolving: a resolved entry still shows if the bug comes back.

**Errors:** 400, 401, 403, 404 `ERROR_LOG_NOT_FOUND` (also on a second delete).

### 4.6 Report a frontend error — `POST /error-logs`

Any signed-in user. Who, IP and browser come from the request, not the body.

| Field | Required | Type | Notes |
|-------|:--------:|------|-------|
| `message` | ✅ | string ≤ 2000 | `error.message` |
| `errorName` | | string ≤ 200 | e.g. `TypeError`; default `Error` |
| `stackTrace` | | string ≤ 20000 | `error.stack` (+ React component stack) |
| `pageUrl` | | string ≤ 1000 | `window.location.href`; only path + query stored, secrets masked |
| `route` | | string ≤ 300 | Router pattern, e.g. `/employees/:id`; falls back to the page path |
| `severity` | | enum | `WARN` or `ERROR` (default) |
| `context` | | JSON object | Failing API call, screen state, app version. Masked, cut at 8 KB |

`201`: `{ "errorLogId": 20, "requestId": "e2d3afa8-…" }`. `errorLogId` is `null` when the same error was already reported 10 times this minute (counted, not stored).

```js
// One reporter for the whole app. Never let reporting throw.
let sentThisMinute = 0;
setInterval(() => { sentThisMinute = 0; }, 60_000);

export function reportError(error, extra = {}) {
  if (sentThisMinute++ >= 20) return;
  api.post('/error-logs', {
    message: String(error?.message ?? error).slice(0, 2000),
    errorName: error?.name,
    stackTrace: [error?.stack, extra.componentStack].filter(Boolean).join('\n').slice(0, 20000),
    pageUrl: window.location.href,
    route: extra.route,
    context: { appVersion: APP_VERSION, ...extra.context },
  }).catch(() => {});
}

window.addEventListener('error', (e) => reportError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason));
// ErrorBoundary: componentDidCatch(error, info) { reportError(error, { componentStack: info.componentStack }); }
```

> **Don't report failed API calls from the frontend** — 5xx, 403 and 409 are already logged by the server with more detail. Never put tokens or passwords in `context`. The login page cannot report (no token).

**Errors:** 400 (missing `message`, `context` not an object, `severity` not WARN/ERROR), 401.

## 5. Suggested screens

- **Overview** (`/summary`): tiles for total, unresolved, ERROR, FATAL; daily bar chart split warn/error; by source and status; top-issues table.
- **Log list** (`/error-logs`): date range, severity, source, status group, resolved filters; one search box that also accepts a pasted request id; severity as a coloured pill.
- **Detail drawer** (`/error-logs/:id`): message, stack, masked body, who/when, "happened 12 times since …", Resolve / Reopen / Delete shown per `canEdit` / `canDelete`.

## 6. Frontend checklist

- [ ] Menu item and buttons from `GET /access/menu` and `/access/page?path=/administration/error-logs`.
- [ ] On every logged API failure (5xx, 403, 409), show `details.requestId` (first 8 chars) as a reference.
- [ ] Search box: a UUID goes to `requestId`, anything else to `search`.
- [ ] Fill missing days with 0 in the daily chart.
- [ ] Display `occurredAt` in local time; send `from` / `to` as UTC dates.
- [ ] Handle `requestBody` as an object or, when cut, a string.
- [ ] Wire `reportError` into the ErrorBoundary, `window.onerror` and `unhandledrejection`; never throw or retry.
- [ ] Confirm deletes in the page itself, showing how many entries `allOccurrences` will remove.

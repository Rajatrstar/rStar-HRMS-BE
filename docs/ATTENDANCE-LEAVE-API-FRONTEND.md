# Attendance & Leave API — Frontend Contract

The endpoints behind the **Attendance** and **Leave** screens.

- **Base URL:** `{{baseUrl}}/api/v1` (local: `http://localhost:5000/api/v1`)
- **Auth:** every endpoint needs `Authorization: Bearer <accessToken>` (from `/auth/verify-otp` or `/auth/refresh`).
- **Permission:** each endpoint names a module and an action. Use `GET /access/page?path=/leave/me` (or any route path below) to decide which buttons to show. See [ACCESS-CONTROL-FRONTEND.md](./ACCESS-CONTROL-FRONTEND.md).
- **Postman:** `postman/rSTAR-HRMS-API.postman_collection.json` → folders **Attendance** and **Leave**.
- **Walkthrough:** [ATTENDANCE-LEAVE-API.html](./ATTENDANCE-LEAVE-API.html) — the same endpoints as a flow-by-flow guide, with a curl and a real response for each step. Read that first if you are new to the module.
- **Policy and schema:** [ATTENDANCE-LEAVE.html](./ATTENDANCE-LEAVE.html).

---

## 1. Self, team and admin are different modules

This access model has no data scope: a group holds an action on a module, and that is all. So "everyone may punch, managers may also see their team" is expressed as **two modules**, granted separately:

| Module | Id | Covers | Grant it to |
|--------|----|--------|-------------|
| `MY_ATTENDANCE` | 71 | `/attendance/me/*`, the holiday calendar, the restricted-holiday pick | every group |
| `TEAM_ATTENDANCE` | 72 | `/attendance/team/*`, `/attendance/employees/:id/*` | managers and HR |
| `MY_LEAVE` | 81 | `/leave/me/*`, applying, cancelling, withdrawing | every group |
| `TEAM_LEAVE` | 82 | approving and rejecting, the team calendar | managers and HR |
| `REGULARIZATION` | 73 | raise (`canAdd`) and approve (`canEdit`) corrections | everyone / managers |
| `SHIFTS` | 74 | shift master, week-offs, assignment | HR |
| `HOLIDAY_CALENDAR` | 75 | creating and editing holidays | HR |
| `ATTENDANCE_EXEMPTIONS` | 76 | present-by-default grants | HR |
| `ATTENDANCE_ALERTS` | 77 | alert cadence | HR / Admin |
| `LEAVE_POLICY` | 83 | cycles, policies, sandwich rules, overrides | HR |
| `LEAVE_MAPPING` | 84 | leave mapping and restricted-holiday mapping | HR |
| `LEAVE_BALANCE` | 85 | the ledger, corrections, granting days | HR |
| `COMP_OFF` | 86 | claims (`canAdd`), approval (`canEdit`), HR credit (`canAdd`) | everyone / managers / HR |
| `EMPLOYMENT_STATUS` | 87 | probation tracking and confirmation | HR |
| `LWP_REPORT` | 88 | the payroll report | HR / Finance |

**The module right is only half of it.** It says you may approve leave; it cannot say *whose*. The service refuses an approver who is not the employee's manager, and refuses anybody approving their own request, with `403 LEAVE_SELF_APPROVAL`. Handle that in the UI: the approve button on your own request should not be rendered at all.

---

## 2. Response envelope (all endpoints)

Identical to the rest of the API.

```json
{ "success": true, "statusCode": 200, "message": "Leave balance fetched", "data": { }, "meta": { "total": 12 } }
```

```json
{ "success": false, "statusCode": 409, "message": "You already have leave applied for on one or more of those dates",
  "data": null, "details": { "code": "LEAVE_REQUEST_OVERLAP", "conflictsWith": { } } }
```

Branch on `details.code`, never on `message`. Section 5 lists the codes.

---

## 3. Two things to understand before you build a screen

### Policy and mapping answer different questions

- **Mapping** — *is this category offered to this person at all?* Location, employment type, gender, tenure.
- **Policy** — *if it is, how does it behave?* Accrual, quota, half days, approvals, sandwich rule.

`GET /leave/me/types` resolves both and returns every mapped category with `isAvailable`, `isVisible` and `unavailableReason`. Render the unavailable ones greyed out with the reason rather than hiding them — a hidden category gives the user nothing to ask HR about.

### The balance is a ledger, not a number

Nothing stores a balance. Every figure is a sum over `tblLeaveLedger`, and each step writes a row:

| Step | Ledger row | Effect |
|------|-----------|--------|
| Apply | `HOLD +n` (IsHold) | `heldDays` up, `availableDays` down, `balanceDays` **unchanged** |
| Approve | `REVERSAL −n` (IsHold) + `DEBIT −n` | hold cleared, `balanceDays` down |
| Reject / cancel | `REVERSAL −n` (IsHold) | hold cleared, nothing charged |
| Withdraw | `REVERSAL +n` | days returned after approval |

So a balance response has four numbers that mean different things:

```json
{ "accruedDays": 0, "consumedDays": 0, "lwpDaysConsumed": 0,
  "heldDays": 3, "balanceDays": 5, "availableDays": 2 }
```

Show **`availableDays`** on the apply screen. `lwpDaysConsumed` is a separate count that never offsets the paid balance.

---

## 4. Endpoints

### 4.1 Attendance

| # | Method | Path | Right needed | Purpose |
|---|--------|------|--------------|---------|
| 1 | `GET` | `/attendance/statuses` | MY_ATTENDANCE `canView` or `canAdd` | The nine statuses with names and colours — serve the calendar legend from here |
| 2 | `GET` | `/attendance/shifts` | SHIFTS `canView` | Shifts, optionally only those in force on a date |
| 3 | `POST` | `/attendance/shifts` | SHIFTS `canAdd` | New shift. `crossesMidnight` is derived, not accepted |
| 4 | `PUT` | `/attendance/shifts/:shiftId/week-offs` | SHIFTS `canEdit` | Replace the whole week-off pattern for a shift |
| 5 | `GET` | `/attendance/shifts/:shiftId/week-offs` | SHIFTS `canView` | The pattern on its own |
| 6 | `GET` | `/attendance/shifts/:shiftId` | SHIFTS `canView` | One shift with its week-offs attached |
| 7 | `PUT` | `/attendance/shifts/:shiftId` | SHIFTS `canEdit` | Edit a shift (a timing *change* should be a new effective-dated row) |
| 8 | `GET` | `/attendance/shift-assignments` | SHIFTS `canView` | Who is on which shift |
| 9 | `POST` | `/attendance/shift-assignments` | SHIFTS `canAdd` | Put an employee on a shift from a date |
| 10 | `PUT` | `/attendance/shift-assignments/:employeeShiftId` | SHIFTS `canEdit` | Move the dates or the shift |
| 11 | `GET` | `/attendance/employees/:employeeDetailId/shift` | SHIFTS `canView` or `canEdit` | Resolve the shift for one employee on one date, with the location fallback |
| 12 | `POST` | `/attendance/me/check-in` | MY_ATTENDANCE `canAdd` | Record an IN punch. Server time only |
| 13 | `GET` | `/attendance/me/today` | MY_ATTENDANCE `canView` | Punch-button state: shift, week off, exempt, isCheckedIn |
| 14 | `POST` | `/attendance/me/check-out` | MY_ATTENDANCE `canAdd` | Record an OUT punch and re-grade the day |
| 15 | `GET` | `/attendance/me/calendar` | MY_ATTENDANCE `canView` | Every date in a range, recorded or derived (max 366 days) |
| 16 | `GET` | `/attendance/me/summary` | MY_ATTENDANCE `canView` | Counts by status for a range |
| 17 | `GET` | `/attendance/me/day/:attendanceDate` | MY_ATTENDANCE `canView` | One day with the punches behind it |
| 18 | `GET` | `/attendance/team/day` | TEAM_ATTENDANCE `canView` | One row per employee for a date, including those who have not punched |
| 19 | `GET` | `/attendance/team/exceptions` | TEAM_ATTENDANCE `canView` | Absent, late, missing-punch and half days only |
| 20 | `GET` | `/attendance/employees/:employeeDetailId/calendar` | TEAM_ATTENDANCE `canView` | Another employee's calendar |
| 21 | `GET` | `/attendance/employees/:employeeDetailId/day/:attendanceDate` | TEAM_ATTENDANCE `canView` | Another employee's day, punches included |
| 22 | `GET` | `/attendance/holidays/types` | HOLIDAY_CALENDAR `canView` or `canAdd` | NORMAL and RESTRICTED, with `requiresOptIn` |
| 23 | `GET` | `/attendance/holidays` | MY_ATTENDANCE `canView` or `canAdd` | The calendar, filterable by year, location, type or range |
| 24 | `POST` | `/attendance/holidays` | HOLIDAY_CALENDAR `canAdd` | Declare a holiday. `locationIds` is required |
| 25 | `GET` | `/attendance/holidays/:holidayId` | MY_ATTENDANCE `canView` or `canAdd` | One holiday with its locations |
| 26 | `PUT` | `/attendance/holidays/:holidayId` | HOLIDAY_CALENDAR `canEdit` | Edit it; the location set is replaced wholesale |
| 27 | `GET` | `/attendance/holidays/restricted-mappings` | LEAVE_MAPPING `canView` | Which cohort may pick, and how many picks |
| 28 | `POST` | `/attendance/holidays/restricted-mappings` | LEAVE_MAPPING `canAdd` | Map a cohort to the restricted list |
| 29 | `PUT` | `/attendance/holidays/restricted-mappings/:restrictedHolidayMappingId` | LEAVE_MAPPING `canEdit` | Change the quota or switch it off |
| 30 | `GET` | `/attendance/holidays/restricted/options` | MY_ATTENDANCE `canView` | Quota, used, remaining, current pick and the list — in one call |
| 31 | `POST` | `/attendance/holidays/restricted/opt-in` | MY_ATTENDANCE `canAdd` | Opt in to one. Enforced at one per calendar year |
| 32 | `GET` | `/attendance/holidays/restricted/me` | MY_ATTENDANCE `canView` | The current pick |
| 33 | `GET` | `/attendance/holidays/restricted/pending` | HOLIDAY_CALENDAR `canEdit` | The approver queue |
| 34 | `PUT` | `/attendance/holidays/restricted/:restrictedHolidayOptInId/decide` | HOLIDAY_CALENDAR `canEdit` | Decide one. Body `{ "approve": true|false }` |
| 35 | `GET` | `/attendance/exemptions` | ATTENDANCE_EXEMPTIONS `canView` | Who is marked present by default |
| 36 | `POST` | `/attendance/exemptions` | ATTENDANCE_EXEMPTIONS `canAdd` | Exempt somebody from punching. `reason` required |
| 37 | `PUT` | `/attendance/exemptions/:attendanceExemptionId` | ATTENDANCE_EXEMPTIONS `canEdit` | Change the dates or the reason |
| 38 | `GET` | `/attendance/alert-settings` | ATTENDANCE_ALERTS `canView` | The missed-punch cadence, per location |
| 39 | `POST` | `/attendance/alert-settings` | ATTENDANCE_ALERTS `canAdd` | Add a rule. One per location per alert type |
| 40 | `PUT` | `/attendance/alert-settings/:attendanceAlertSettingId` | ATTENDANCE_ALERTS `canEdit` | Change the cadence |
| 41 | `GET` | `/organizations/regularization-types` | any signed-in user | The reason list (master data, under `/organizations`) |
| 42 | `POST` | `/attendance/regularizations` | REGULARIZATION `canAdd` | Request a correction to a day, inside the 24-hour window |
| 43 | `GET` | `/attendance/regularizations/me` | REGULARIZATION `canView` or `canAdd` | My own requests |
| 44 | `GET` | `/attendance/regularizations/:regularizationRequestId` | REGULARIZATION `canView` or `canEdit` | One request |
| 45 | `GET` | `/attendance/regularizations/pending` | REGULARIZATION `canEdit` | The approver queue |
| 46 | `PUT` | `/attendance/regularizations/:regularizationRequestId/approve` | REGULARIZATION `canEdit` | Approve: writes the punches, re-grades the day, records the old status |
| 47 | `PUT` | `/attendance/regularizations/:regularizationRequestId/reject` | REGULARIZATION `canEdit` | Reject: the day stays as recorded |
| 48 | `PUT` | `/attendance/regularizations/:regularizationRequestId/cancel` | REGULARIZATION `canAdd` | Withdraw your own request |
| 49 | `PUT` | `/attendance/holidays/restricted/:restrictedHolidayOptInId/cancel` | MY_ATTENDANCE `canAdd` | Take the pick back; frees the year’s slot |
| 50 | `DELETE` | `/attendance/alert-settings/:attendanceAlertSettingId` | ATTENDANCE_ALERTS `canDelete` | Remove the rule |
| 51 | `DELETE` | `/attendance/exemptions/:attendanceExemptionId` | ATTENDANCE_EXEMPTIONS `canDelete` | Withdraw the exemption |
| 52 | `DELETE` | `/attendance/holidays/restricted-mappings/:restrictedHolidayMappingId` | LEAVE_MAPPING `canDelete` | Remove the mapping |
| 53 | `DELETE` | `/attendance/holidays/:holidayId` | HOLIDAY_CALENDAR `canDelete` | Soft delete |
| 54 | `DELETE` | `/attendance/shift-assignments/:employeeShiftId` | SHIFTS `canDelete` | End an assignment |
| 55 | `DELETE` | `/attendance/shifts/:shiftId` | SHIFTS `canDelete` | Soft delete. Refused while anybody is assigned |

### 4.2 Leave

| # | Method | Path | Right needed | Purpose |
|---|--------|------|--------------|---------|
| 1 | `GET` | `/access/me` | any signed-in user | Your own employee id and rights map |
| 2 | `GET` | `/leave/cycles` | MY_LEAVE `canView` or `canAdd` | Every cycle. Two types run at once — FINANCIAL and CALENDAR |
| 3 | `POST` | `/leave/cycles` | LEAVE_POLICY `canAdd` | Open a year |
| 4 | `PUT` | `/leave/cycles/:leaveCycleId` | LEAVE_POLICY `canEdit` | Rename or move the boundaries (refused once closed) |
| 5 | `GET` | `/leave/me/types` | MY_LEAVE `canView` or `canAdd` | Mapped categories with their rules, including why one is unavailable |
| 6 | `GET` | `/leave/me/dashboard` | MY_LEAVE `canView` | One tile per visible category, each naming its cycle |
| 7 | `GET` | `/leave/sandwich-rules` | LEAVE_POLICY `canView` | The three sandwich modes |
| 8 | `POST` | `/leave/sandwich-rules` | LEAVE_POLICY `canAdd` | Add a rule |
| 9 | `PUT` | `/leave/sandwich-rules/:sandwichRuleId` | LEAVE_POLICY `canEdit` | Edit it |
| 10 | `GET` | `/leave/policies` | LEAVE_POLICY `canView` | How each category behaves |
| 11 | `POST` | `/leave/policies` | LEAVE_POLICY `canAdd` | Add a policy. Omitted fields take their database default |
| 12 | `GET` | `/leave/policies/:leavePolicyId` | LEAVE_POLICY `canView` | One policy |
| 13 | `PUT` | `/leave/policies/:leavePolicyId` | LEAVE_POLICY `canEdit` | Edit it |
| 14 | `GET` | `/leave/mappings` | LEAVE_MAPPING `canView` | Which cohort is offered which category |
| 15 | `POST` | `/leave/mappings` | LEAVE_MAPPING `canAdd` | Offer a category to a cohort |
| 16 | `PUT` | `/leave/mappings/:leaveMappingId` | LEAVE_MAPPING `canEdit` | Change the tenure floor or switch it off |
| 17 | `GET` | `/leave/overrides` | LEAVE_POLICY `canView` | Per-employee exceptions |
| 18 | `POST` | `/leave/overrides` | LEAVE_POLICY `canAdd` | Override a quota or accrual for one person. `reason` required |
| 19 | `PUT` | `/leave/overrides/:employeeLeavePolicyId` | LEAVE_POLICY `canEdit` | Change the override |
| 20 | `POST` | `/leave/balances/grant` | LEAVE_BALANCE `canAdd` | Grant days to several employees at once |
| 21 | `GET` | `/leave/me/balance` | MY_LEAVE `canView` | One category, one cycle: accrued, consumed, held, available, LWP |
| 22 | `POST` | `/leave/me/preview` | MY_LEAVE `canView` or `canAdd` | How many days, how many sandwich, how many unpaid — before applying |
| 23 | `POST` | `/leave/requests` | MY_LEAVE `canAdd` | Submit. Writes the request, its day rows and a HOLD |
| 24 | `GET` | `/leave/me/requests` | MY_LEAVE `canView` | My own applications |
| 25 | `GET` | `/leave/requests/:leaveRequestId` | MY_LEAVE `canView` or `canAdd` | One request with its day rows and approval trail |
| 26 | `GET` | `/leave/requests/pending` | TEAM_LEAVE `canEdit` | The approver queue |
| 27 | `PUT` | `/leave/requests/:leaveRequestId/approve` | TEAM_LEAVE `canEdit` | Approve: clears the hold, writes the DEBIT and any LWP_DEBIT |
| 28 | `PUT` | `/leave/requests/:leaveRequestId/reject` | TEAM_LEAVE `canEdit` | Reject: releases the hold, charges nothing |
| 29 | `GET` | `/leave/team/calendar` | TEAM_LEAVE `canView` | Who is off, by date |
| 30 | `GET` | `/leave/team/requests` | TEAM_LEAVE `canView` | One employee's applications |
| 31 | `GET` | `/leave/me/ledger` | MY_LEAVE `canView` | Every movement behind my balance |
| 32 | `GET` | `/leave/balances` | LEAVE_BALANCE `canView` | Every employee × category for one cycle |
| 33 | `GET` | `/leave/balances/:employeeDetailId` | LEAVE_BALANCE `canView` | One employee's dashboard |
| 34 | `GET` | `/leave/balances/:employeeDetailId/ledger` | LEAVE_BALANCE `canView` | One employee's movements |
| 35 | `POST` | `/leave/balances/:employeeDetailId/adjust` | LEAVE_BALANCE `canEdit` | Hand correction. `remarks` required; cannot go below zero |
| 36 | `POST` | `/leave/comp-off` | COMP_OFF `canAdd` | Claim a day worked on a non-working day |
| 37 | `GET` | `/leave/comp-off/me` | COMP_OFF `canView` or `canAdd` | My own claims |
| 38 | `GET` | `/leave/comp-off/pending` | COMP_OFF `canEdit` | The manager queue |
| 39 | `PUT` | `/leave/comp-off/:compOffRequestId/approve` | COMP_OFF `canEdit` | Manager agrees the work happened — **credits nothing** |
| 40 | `PUT` | `/leave/comp-off/:compOffRequestId/reject` | COMP_OFF `canEdit` | Reject the claim |
| 41 | `GET` | `/leave/comp-off/awaiting-credit` | COMP_OFF `canAdd` | Approved but not yet credited — HR’s outstanding list |
| 42 | `POST` | `/leave/comp-off/:compOffRequestId/credit` | COMP_OFF `canAdd` | HR grants the day. The only call that moves the balance |
| 43 | `GET` | `/leave/comp-off/credits` | COMP_OFF `canView` | Credits with their remaining days and expiry |
| 44 | `GET` | `/leave/confirmation/due` | EMPLOYMENT_STATUS `canView` | Who is due or overdue for confirmation |
| 45 | `GET` | `/leave/confirmation/:employeeDetailId/history` | EMPLOYMENT_STATUS `canView` | Every status change, with its reason |
| 46 | `PUT` | `/leave/confirmation/:employeeDetailId/extend` | EMPLOYMENT_STATUS `canEdit` | Move the probation end date (extend or shorten) |
| 47 | `PUT` | `/leave/confirmation/:employeeDetailId/confirm` | EMPLOYMENT_STATUS `canEdit` | Confirm. `confirmedOn` may be backdated |
| 48 | `GET` | `/leave/reports/lwp` | LWP_REPORT `canView` or `canPrint` | Employee-wise unpaid days for a period |
| 49 | `PUT` | `/leave/requests/:leaveRequestId/cancel` | MY_LEAVE `canAdd` | Withdraw before a decision |
| 50 | `PUT` | `/leave/requests/:leaveRequestId/withdraw` | MY_LEAVE `canAdd` | Give back an approved leave |
| 51 | `PUT` | `/leave/comp-off/:compOffRequestId/cancel` | COMP_OFF `canAdd` | Withdraw your own claim |
| 52 | `DELETE` | `/leave/overrides/:employeeLeavePolicyId` | LEAVE_POLICY `canDelete` | Remove it |
| 53 | `DELETE` | `/leave/mappings/:leaveMappingId` | LEAVE_MAPPING `canDelete` | Remove the mapping |
| 54 | `DELETE` | `/leave/policies/:leavePolicyId` | LEAVE_POLICY `canDelete` | Soft delete |
| 55 | `DELETE` | `/leave/sandwich-rules/:sandwichRuleId` | LEAVE_POLICY `canDelete` | Remove it. Refused while a policy uses it |
| 56 | `PUT` | `/leave/cycles/:leaveCycleId/close` | LEAVE_POLICY `canDelete` | Settle a year. One-way |

---

## 5. Error codes

Branch on `details.code`.

| Code | HTTP | Meaning |
|------|------|---------|
| `ALREADY_CHECKED_IN` | 409 | A session is already open |
| `NOT_CHECKED_IN` | 400 | Nothing open to close |
| `DATE_RANGE_TOO_WIDE` | 400 | More than 366 days requested |
| `NO_SHIFT_ASSIGNED` | 400 | No shift covers that date |
| `SHIFT_ASSIGNMENT_OVERLAP` | 409 | `details.conflictsWith` names the clashing row |
| `SHIFT_IN_USE` | 409 | Employees are still assigned |
| `HOLIDAY_NEEDS_LOCATION` | 400 | `locationIds` was empty |
| `REGULARIZATION_WINDOW_CLOSED` | 409 | Past the window; `details.deadline` says when it closed |
| `REGULARIZATION_ALREADY_OPEN` | 409 | A live request already covers that day |
| `RESTRICTED_QUOTA_USED` | 409 | The floating holiday for the calendar year is used |
| `RESTRICTED_NOT_ELIGIBLE` | 403 | No restricted-holiday mapping covers this employee |
| `LEAVE_CYCLE_MISSING` | 400 | No cycle of the policy's type covers that date |
| `LEAVE_CYCLE_IS_CLOSED` | 409 | The year is settled |
| `LEAVE_NOT_MAPPED` | 403 | The category is not offered to this employee |
| `LEAVE_POLICY_MISSING` | 400 | Mapped but no policy says how it behaves |
| `LEAVE_NOT_AVAILABLE_ON_PROBATION` | 403 | Visible but not applicable yet |
| `LEAVE_REQUEST_OVERLAP` | 409 | Those dates are already applied for |
| `LEAVE_NO_WORKING_DAYS` | 400 | The range is all week-offs and holidays |
| `LEAVE_HALF_DAY_NOT_ALLOWED` | 400 | The policy sets `allowHalfDay: false` |
| `LEAVE_SELF_APPROVAL` | 403 | You cannot approve your own request |
| `LEAVE_REQUEST_NOT_PENDING` | 409 | Already decided — reload the queue |
| `LEAVE_ADJUSTMENT_NEEDS_REMARKS` | 400 | An adjustment must say why |
| `LEAVE_ADJUSTMENT_WOULD_GO_NEGATIVE` | 400 | Record it as unpaid leave instead |
| `COMP_OFF_WORKING_DAY` | 400 | That day was a working day for this employee |
| `COMP_OFF_NOT_APPROVED` | 409 | Crediting before the manager approved |
| `COMP_OFF_ALREADY_CREDITED` | 409 | One credit per request |
| `ALREADY_CONFIRMED` | 409 | That employee is already confirmed |

---

## 6. Dates and times

| Field kind | Format | Note |
|-----------|--------|------|
| Calendar date | `"2026-11-09"` | Every `*Date`, `effectiveFrom/To`, `startDate/endDate`. Never a timestamp — send and expect `YYYY-MM-DD` |
| Timestamp | `"2026-11-06T05:19:46.284Z"` | Punches, `createdAt`, `approvedAt`. UTC |
| Time of day | `"09:00"` | Shift `startTime`/`endTime`, `sweepTime`. No timezone |
| Days | `3`, `0.5` | Two decimal places. Half days are `0.5` |

`dayOfWeek` is **1 = Sunday … 7 = Saturday**. `weekOfMonth` omitted means every week; `2` and `4` is "alternate Saturday".

---

## 7. Setup order

An empty database answers most of these with a 400 that names what is missing. The order is:

**Attendance:** a location → a shift with week-offs → holidays for the year → people can punch.

**Leave:** a leave cycle (one FINANCIAL, one CALENDAR) → a leave type → a policy → a mapping → a balance → people can apply.

`npm run db:seed:attendance` creates the shifts, this year's and next year's cycles, the three sandwich rules, a policy and mapping per category, the restricted-holiday quota and the alert rule. It deliberately does not create holidays — those differ per country and per year.

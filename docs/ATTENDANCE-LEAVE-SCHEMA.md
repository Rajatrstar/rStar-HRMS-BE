# Attendance & Leave — the schema

> The behaviour is [ATTENDANCE-LEAVE.md](ATTENDANCE-LEAVE.md): what the system
> decides and who configures it.
> A single self-contained page for sharing is
> [ATTENDANCE-LEAVE.html](ATTENDANCE-LEAVE.html).

Nothing here is migrated yet. Migrations `011` – `016` are the proposal.

## Conventions, inherited

Same as the rest of this schema, and deliberately not restated per table:

- `dbo.tblXxx`, singular. Primary key `XxxId BIGINT IDENTITY(1,1)`.
- Audit columns on everything a human edits: `CreatedBy`, `ModifiedBy`,
  `CreatedAt`, `ModifiedAt`, `DeletedAt`, with `CreatedBy` and `ModifiedBy`
  pointing at `dbo.tblEmployeeDetails (EmployeeDetailId)`.
- **Soft delete.** `DeletedAt IS NULL` means live. Unique indexes are filtered
  on it, so deleting a row frees its name.
- Times are UTC, `SYSUTCDATETIME()`.
- Filtered indexes mean `QUOTED_IDENTIFIER` must be ON — run `sqlcmd` with `-I`.
- **Ledger, punch and approval tables are the exception:** append-only, no
  `DeletedAt`, no `ModifiedBy`. A correction is a new row.

## What already exists and is pointed at

| Table | Used for |
| --- | --- |
| `dbo.tblEmployeeDetails` | The employee. Already carries `WorkLocationId`, `EmploymentType`, `DateOfJoining`, `ProbationEndDate` and `ManagerId` — these modules need **no new employee columns**. |
| `dbo.tblOrganizationLocation` | India / US. Shifts, holidays and alert settings scope to it. |
| `dbo.tblLeaveType` | The existing master-data list. Policies hang off it; it is not replaced. |
| `dbo.tblEmailOutbox` | Every alert and decision mail is a row here. No new notification table. |
| `dbo.tblModule`, `dbo.tblAccessRight` | New screens get `MODULE` ids and the usual six flags. |

---

## Entity relationships

`tblEmployeeDetails` is the hub. Attendance hangs off the left, leave off the
right, and `tblOrganizationLocation` scopes the configuration on both sides.

```
                            CONFIGURATION (location-scoped)
   tblOrganizationLocation ──┬── tblShift ──< tblShiftWeekOff
             │               ├── tblHoliday >──< tblHolidayLocation
             │               ├── tblAttendanceAlertSetting
             │               ├── tblRestrictedHolidayMapping
             │               ├── tblLeavePolicy
             │               ├── tblSandwichRule
             │               └── tblLeaveMapping
             │
             │ WorkLocationId
             v
┌─────────────────────────── tblEmployeeDetails ───────────────────────────┐
│                      (EmployeeDetailId, ManagerId,                        │
│                   ProbationEndDate, EmploymentType)                       │
└───────┬───────────────────────────────────────────────────────┬──────────┘
        │ ATTENDANCE                                    LEAVE   │
        │                                                       │
        ├──< tblEmployeeShift >── tblShift                      ├──< tblEmployeeLeavePolicy >── tblLeavePolicy
        ├──< tblAttendanceExemption                             │
        │                                                       ├──< tblLeaveRequest >── tblLeaveType
        └──< tblAttendanceDay >── tblShift                      │        │
                 │     │     └──> tblAttendanceStatus           │        ├──< tblLeaveRequestDay
                 │     │                                        │        └──< tblLeaveApproval >── tblEmployeeDetails
                 │     └─────────────────> tblLeaveRequest      │                                   (approver)
                 │        (the join: ON_LEAVE days point at     ├──< tblLeaveLedger >── tblLeaveType
                 │         the request that caused them)        │          ^
                 ├──< tblAttendancePunch                        │          │ SourceType / SourceId
                 │                                              │          │ (request, credit, job run, adjustment)
                 ├──< tblRegularizationRequest >── tblRegularizationType
                 │                                              │
                 └──< tblCompOffCredit ──────────────────────────┴──< tblCompOffConsumption >── tblLeaveRequest

   tblHoliday ──< tblRestrictedHolidayOptIn >── tblEmployeeDetails
```

Reading the notation: `A ──< B` is one-to-many (one A, many B).
`A >──< B` through a third table is many-to-many.

### Cardinality, precisely

| Parent | Child | Card. | Key | Note |
| --- | --- | --- | --- | --- |
| `tblEmployeeDetails` | `tblAttendanceDay` | 1:N | `EmployeeDetailId` | Unique on (employee, date) |
| `tblAttendanceDay` | `tblAttendancePunch` | 1:N | `AttendanceDayId` | Many punches per day |
| `tblAttendanceStatus` | `tblAttendanceDay` | 1:N | `AttendanceStatusId` | Master list |
| `tblShift` | `tblAttendanceDay` | 1:N | `ShiftId` | The shift *resolved* for that date, stored |
| `tblShift` | `tblShiftWeekOff` | 1:N | `ShiftId` | The week-off pattern |
| `tblShift` | `tblEmployeeShift` | 1:N | `ShiftId` | The assignment |
| `tblOrganizationLocation` | `tblShift` | 1:N | `LocationId` | Shifts are location-wise |
| `tblEmployeeDetails` | `tblAttendanceExemption` | 1:N | `EmployeeDetailId` | Present-by-default, date-bounded |
| `tblEmployeeDetails` | `tblRegularizationRequest` | 1:N | `EmployeeDetailId` | |
| `tblRegularizationType` | `tblRegularizationRequest` | 1:N | `RegularizationTypeId` | Master list |
| `tblHoliday` | `tblHolidayLocation` | 1:N | `HolidayId` | Many-to-many with location |
| `tblOrganizationLocation` | `tblHolidayLocation` | 1:N | `LocationId` | |
| `tblHolidayType` | `tblHoliday` | 1:N | `HolidayTypeId` | Normal / Restricted |
| `tblHoliday` | `tblRestrictedHolidayOptIn` | 1:N | `HolidayId` | One row per employee pick |
| `tblHoliday` | `tblAttendanceDay` | 1:N | `HolidayId` | Why the day is `HOLIDAY` |
| `tblLeaveType` | `tblLeavePolicy` | 1:N | `LeaveTypeId` | Policy versions per type |
| `tblLeavePolicy` | `tblEmployeeLeavePolicy` | 1:N | `LeavePolicyId` | Per-employee override |
| `tblSandwichRule` | `tblLeavePolicy` | 1:N | `SandwichRuleId` | Nullable — no rule means none applies |
| `tblLeaveType` | `tblLeaveRequest` | 1:N | `LeaveTypeId` | |
| `tblLeaveRequest` | `tblLeaveRequestDay` | 1:N | `LeaveRequestId` | One row per calendar date |
| `tblLeaveRequest` | `tblLeaveApproval` | 1:N | `LeaveRequestId` | One row per level acted on |
| `tblLeaveRequest` | `tblAttendanceDay` | 1:N | `LeaveRequestId` | **The join between the domains** |
| `tblEmployeeDetails` | `tblLeaveLedger` | 1:N | `EmployeeDetailId` | Append-only |
| `tblLeaveType` | `tblLeaveLedger` | 1:N | `LeaveTypeId` | |
| `tblAttendanceDay` | `tblCompOffCredit` | 1:1 | `AttendanceDayId` | Unique — one credit per worked date |
| `tblCompOffCredit` | `tblCompOffConsumption` | 1:N | `CompOffCreditId` | FIFO, partial use allowed |
| `tblLeaveRequest` | `tblCompOffConsumption` | 1:N | `LeaveRequestId` | Which request spent which credit |

---

## Migration 011 — shifts

### `dbo.tblShift`

| Column | Type | Note |
| --- | --- | --- |
| `ShiftId` | `BIGINT IDENTITY` | PK |
| `ShiftCode` | `NVARCHAR(20)` | `GEN`, `EVE`. Unique among live rows |
| `ShiftName` | `NVARCHAR(100)` | "General 9 AM – 6 PM" |
| `LocationId` | `BIGINT NULL` | FK → `tblOrganizationLocation`. NULL = every location |
| `StartTime` / `EndTime` | `TIME(0)` | 09:00 / 18:00 |
| `CrossesMidnight` | `BIT` | 1 for 15:00 – 00:00. `CHECK` that it is 1 whenever `EndTime <= StartTime` |
| `BreakMinutes` | `INT` | Unpaid, deducted from worked time |
| `GraceInMinutes` / `GraceOutMinutes` | `INT` | Late begins after grace-in |
| `FullDayMinutes` / `HalfDayMinutes` | `INT` | What the nightly close compares against |
| `EffectiveFrom` / `EffectiveTo` | `DATE` / `DATE NULL` | Versioning — see below |
| `IsActive` | `BIT` | |

**Why effective dates** (an addition, not a stated requirement). Changing 9 AM to
9:30 AM must not rewrite last month's attendance. A change writes a new version;
the resolver asks for the version live on the date being computed.

### `dbo.tblShiftWeekOff`

`ShiftWeekOffId`, `ShiftId`, `DayOfWeek TINYINT` (1 = Sunday … 7 = Saturday),
`WeekOfMonth TINYINT NULL` (NULL = every week — alternate-Saturday is rows for
weeks 2 and 4), `IsHalfDay BIT`. Unique on
(`ShiftId`, `DayOfWeek`, `WeekOfMonth`).

This table is what the sandwich rule reads to know Saturday and Sunday are
non-working. The rule must not hard-code weekends, because `EVE` in the US and
`GEN` in India may not share them.

### `dbo.tblEmployeeShift`

The assignment: `EmployeeShiftId`, `EmployeeDetailId`, `ShiftId`,
`EffectiveFrom`, `EffectiveTo NULL`. No overlapping live rows per employee —
enforced in the service, since SQL Server has no range-exclusion constraint.

---

## Migration 012 — attendance

### `dbo.tblAttendanceStatus`

Master list, ids fixed in the enum layer exactly as `MODULE` is: `PRESENT`,
`ABSENT`, `LATE`, `HALF_DAY`, `MISSING_PUNCH`, `ON_LEAVE`, `HOLIDAY`,
`WEEK_OFF`, `REGULARIZED`. Not an identity column — the ids live in
`tblAttendanceDay` and in reports.

### `dbo.tblAttendanceDay`

One row per employee per date. The spine of the module.

| Column | Type | Note |
| --- | --- | --- |
| `AttendanceDayId` | `BIGINT IDENTITY` | PK |
| `EmployeeDetailId` | `BIGINT` | FK |
| `AttendanceDate` | `DATE` | **Unique with EmployeeDetailId** |
| `ShiftId` | `BIGINT NULL` | The resolved shift, stored so history survives a shift change |
| `AttendanceStatusId` | `INT` | FK |
| `FirstCheckInAt` / `LastCheckOutAt` | `DATETIME2 NULL` | |
| `WorkedMinutes` | `INT NULL` | Computed by the close job, not by the client |
| `LateMinutes` | `INT NULL` | |
| `IsDefaultPresent` | `BIT` | Written by the auto-mark job |
| `LeaveRequestId` | `BIGINT NULL` | FK → `tblLeaveRequest`. Set when the day is `ON_LEAVE` |
| `HolidayId` | `BIGINT NULL` | FK → `tblHoliday`. Set when the day is `HOLIDAY` |
| `Remarks` | `NVARCHAR(500) NULL` | |

`LeaveRequestId` and `HolidayId` are the whole integration between the two
domains. They are nullable foreign keys rather than a derived lookup, because
"why is this day `ON_LEAVE`" has to be answerable from the row itself.

Index on (`EmployeeDetailId`, `AttendanceDate`) is the unique one; add
(`AttendanceDate`, `AttendanceStatusId`) for the exception list, which scans by
date, not by employee.

### `dbo.tblAttendancePunch`

Append-only. `PunchId`, `AttendanceDayId`, `PunchType` (`IN` / `OUT`),
`PunchAt DATETIME2`, `Source` (`WEB` / `MOBILE` / `BIOMETRIC` / `KIOSK`),
`CreatedAt`.

**No updates and no deletes.** A wrong punch is corrected by a regularization
that changes the day row, never by editing the punch — the punch is the evidence
the approver looks at.

### `dbo.tblAttendanceExemption`

Present-by-default. `AttendanceExemptionId`, `EmployeeDetailId`,
`EffectiveFrom DATE`, `EffectiveTo DATE NULL`, `Reason NVARCHAR(500)`,
`GrantedBy BIGINT`, plus audit.

### `dbo.tblAttendanceAlertSetting`

The configurable alert behaviour. `AttendanceAlertSettingId`,
`LocationId BIGINT NULL` (NULL = org default), `AlertType`
(`MISSED_CHECK_IN` / `MISSED_CHECK_OUT` / `REGULARIZATION_DECIDED`),
`DelayMinutes`, `IntervalMinutes`, `WindowMinutes`, `SweepTime TIME(0) NULL`,
`IsActive`, plus audit. Unique on (`LocationId`, `AlertType`) among live rows.

Resolution is location-first with an org fallback. This is the table HR Admin
edits to turn "every 10 minutes for 2 hours" into something else without a
release.

### `dbo.tblRegularizationType`

Master list, same seven-column shape as the existing master data, so it joins the
registry in `src/enums/master-data.enum.js` and is served by the existing
service, controller and route loop with no new code: missing check-in, missing
check-out, late arrival, early exit.

### `dbo.tblRegularizationRequest`

`RegularizationRequestId`, `EmployeeDetailId`, `AttendanceDate`,
`RegularizationTypeId`, `ProposedInAt DATETIME2 NULL`,
`ProposedOutAt DATETIME2 NULL`, `Reason NVARCHAR(1000)`,
`Status NVARCHAR(20)` (`PENDING` / `APPROVED` / `REJECTED` / `EXPIRED`),
`AppliedAt`, `DecidedBy BIGINT NULL`, `DecidedAt NULL`,
`DecisionRemarks NULL`, `PreviousAttendanceStatusId INT NULL`, plus audit.

The 24-hour window is measured from `AttendanceDate`, not from `AppliedAt`.
`PreviousAttendanceStatusId` is what makes an approval auditable: the day row is
recomputed, and this column remembers what it was. Unique on
(`EmployeeDetailId`, `AttendanceDate`) among rows that are `PENDING` or
`APPROVED`, so the same day cannot be regularized twice.

---

## Migration 013 — holidays

### `dbo.tblHolidayType`

Two rows, ids fixed: `NORMAL` and `RESTRICTED`. Master-data shape.

### `dbo.tblHoliday`

`HolidayId`, `HolidayName NVARCHAR(150)`, `HolidayDate DATE`,
`HolidayTypeId INT`, `HolidayYear SMALLINT`, `Description NVARCHAR(500) NULL`,
`IsActive BIT`, plus audit. `HolidayYear` is stored, not derived, because the
restricted quota is per year and the year-end job groups by it.

### `dbo.tblHolidayLocation`

`HolidayLocationId`, `HolidayId`, `LocationId`. Unique on both together.

**Why a link table and not a `LocationId` on the holiday.** New Year's Day is one
holiday observed in India and the US; Thanksgiving is one observed only in the
US. A single column forces either a duplicate row per location or a nullable
"all locations" special case, and the first bug either produces is a US employee
seeing an Indian festival. The employee's `WorkLocationId` joins straight through
this table.

### `dbo.tblRestrictedHolidayMapping`

Which restricted-holiday list an employee may pick from, and how many.
`RestrictedHolidayMappingId`, `LocationId BIGINT NULL`,
`EmploymentType NVARCHAR(30) NULL`, `LeaveYear SMALLINT`, `PickQuota TINYINT`,
`IsActive`, plus audit.

The list itself is the set of `tblHoliday` rows of type `RESTRICTED` linked to
that location for the year; this table says who may draw from it and how deeply.

### `dbo.tblRestrictedHolidayOptIn`

The employee's pick. `RestrictedHolidayOptInId`, `EmployeeDetailId`,
`HolidayId`, `LeaveYear SMALLINT`, `Status NVARCHAR(20)`
(`PENDING` / `APPROVED` / `REJECTED` / `CANCELLED`), `AppliedAt`,
`DecidedBy NULL`, `DecidedAt NULL`, plus audit. Unique on
(`EmployeeDetailId`, `HolidayId`) among live rows.

---

## Migration 014 — leave policy and mapping

### `dbo.tblSandwichRule`

The three configurable modes, as rows and not as code.

| Column | Note |
| --- | --- |
| `SandwichRuleId` | PK |
| `RuleName` | "Ignore week-offs", "Charge when flanked", "Always charge" |
| `Mode` | `IGNORE_WEEKOFF` / `COUNT_WHEN_BOTH_FLANKS` / `COUNT_ALWAYS` |
| `LocationId` | `BIGINT NULL` |
| `IsActive` | |

A policy points at a rule; a NULL `SandwichRuleId` means the type has no sandwich
behaviour at all.

### `dbo.tblLeavePolicy`

| Column | Note |
| --- | --- |
| `LeavePolicyId` | PK |
| `PolicyName` | |
| `LeaveTypeId` | FK → existing `tblLeaveType` |
| `LocationId` | `NULL` = every location |
| `EmploymentType` | `NULL` = every type. `'FullTime'` is the row that excludes contractors from EL |
| `AvailableDuringProbation` | `BIT` — 1 for CL and SL, 0 for EL |
| `AccrualFrequency` | `MONTHLY` / `ANNUAL` / `NONE` |
| `AccrualDay` | `TINYINT` — 1, for the 1st of the month |
| `AccrualDays` | `DECIMAL(5,2)` — 1.00 for EL |
| `AnnualQuota` | `DECIMAL(5,2) NULL` — block grants: maternity, paternity, sabbatical |
| `AllowHalfDay` | `BIT` |
| `SandwichRuleId` | `BIGINT NULL` |
| `ValidityDays` | `INT NULL` — comp-off expiry |
| `RequiresSecondApproval` | `BIT` — sabbatical, maternity and paternity go to HR as well |
| `EffectiveFrom` / `EffectiveTo` | Versioning |
| `IsActive` | |

Resolution for an employee: match on `LeaveTypeId`, then the most specific of
`LocationId` and `EmploymentType`, then the version live on the date. The EL row
is the one with `EmploymentType = 'FullTime'`, `AvailableDuringProbation = 0`,
`AccrualFrequency = 'MONTHLY'`, `AccrualDay = 1`, `AccrualDays = 1.00`.

### `dbo.tblEmployeeLeavePolicy`

The per-employee override, for customised policies.
`EmployeeLeavePolicyId`, `EmployeeDetailId`, `LeavePolicyId`,
`OverrideAnnualQuota DECIMAL(5,2) NULL`,
`OverrideAccrualDays DECIMAL(5,2) NULL`, `EffectiveFrom`, `EffectiveTo NULL`,
`Reason NVARCHAR(500) NOT NULL`, plus audit.

Only the differences are stored, and `Reason` is `NOT NULL` on purpose. The
alternative — a near-duplicate policy per negotiated hire — makes the policy list
unreadable within a year.

### `dbo.tblLeaveMapping`

Eligibility. `LeaveMappingId`, `LeaveTypeId`, `LocationId NULL`,
`EmploymentType NVARCHAR(30) NULL`, `Gender NVARCHAR(20) NULL`,
`MinTenureMonths INT NULL`, `AvailableDuringProbation BIT`, `IsActive`, plus
audit. A row is a *grant*: nothing matching means the type is not offered, so the
Apply Leave dropdown is built from this table and nothing else.

---

## Migration 015 — leave transactions

### `dbo.tblLeaveYear`

`LeaveYearId`, `LeaveYear SMALLINT`, `StartDate DATE`, `EndDate DATE`,
`IsClosed BIT`, `ClosedAt NULL`, `ClosedBy NULL`. 1 January to 31 December,
matching the restricted-holiday year. `IsClosed` is what stops a backdated
application landing in a year the year-end job has already settled.

### `dbo.tblLeaveRequest`

| Column | Note |
| --- | --- |
| `LeaveRequestId` | PK |
| `EmployeeDetailId` | FK |
| `LeaveTypeId` | FK |
| `FromDate` / `ToDate` | `DATE` |
| `DayPart` | `FULL` / `FIRST_HALF` / `SECOND_HALF` — half day lives here |
| `TotalDays` | `DECIMAL(5,2)` — what is charged, after the sandwich mode |
| `SandwichDays` | `DECIMAL(5,2)` — of which added by the rule |
| `LeaveYear` | `SMALLINT` |
| `Reason` | `NVARCHAR(1000)` |
| `Status` | `DRAFT` / `PENDING_MANAGER` / `PENDING_HR` / `APPROVED` / `REJECTED` / `CANCELLED` / `WITHDRAWN` |
| `AppliedAt` | |
| `CurrentApproverId` | `BIGINT NULL` — who the queue shows it to now |

`SandwichDays` is stored separately from `TotalDays` so the deduction can be
explained without re-running the rule against a setting that may since have
changed.

### `dbo.tblLeaveRequestDay`

One row per calendar date in the span. `LeaveRequestDayId`, `LeaveRequestId`,
`LeaveDate DATE`, `DayPart`, `DayType` (`WORKING` / `SANDWICH`),
`ChargedDays DECIMAL(3,2)`. Unique on (`LeaveRequestId`, `LeaveDate`).

This is the table that makes everything else tractable: the attendance writer
iterates it, the ledger debit sums it, and the sandwich explanation reads it.

### `dbo.tblLeaveApproval`

One row per level acted on. `LeaveApprovalId`, `LeaveRequestId`,
`ApprovalLevel TINYINT` (1 = manager, 2 = HR or HR Admin), `ApproverId BIGINT`,
`ApproverRole NVARCHAR(20)`, `Action NVARCHAR(20)` (`APPROVED` / `REJECTED`),
`Remarks NVARCHAR(1000) NULL`, `ActedAt`. Append-only.

### `dbo.tblLeaveLedger`

Append-only. The balance is `SUM(Days)` over this table and is **not** stored
anywhere else.

| Column | Note |
| --- | --- |
| `LeaveLedgerId` | PK |
| `EmployeeDetailId` | FK |
| `LeaveTypeId` | FK |
| `LeaveYear` | `SMALLINT` |
| `EntryType` | `OPENING` / `ACCRUAL` / `PROBATION_RELEASE` / `COMP_OFF_CREDIT` / `HOLD` / `DEBIT` / `REVERSAL` / `ADJUSTMENT` / `LAPSE` |
| `Days` | `DECIMAL(6,2)` — **signed**. A hold is a separate flag, not a sign |
| `IsHold` | `BIT` — reserved, not yet spent |
| `EffectiveDate` | `DATE` |
| `SourceType` | `LEAVE_REQUEST` / `COMPOFF_CREDIT` / `JOB_RUN` / `ADJUSTMENT` |
| `SourceId` | `BIGINT NULL` — the request, credit or job run |
| `Remarks` | `NVARCHAR(500) NULL` — mandatory for `ADJUSTMENT`, enforced in the service |
| `CreatedBy` / `CreatedAt` | No `ModifiedBy`, no `DeletedAt` |

> **Available** = `SUM(Days) WHERE IsHold = 0` − `SUM(Days) WHERE IsHold = 1`.
> **Balance** = `SUM(Days) WHERE IsHold = 0`.
> The apply screen checks available; the Manage Balance screen shows both.

Index on (`EmployeeDetailId`, `LeaveTypeId`, `LeaveYear`) — every balance read is
that query. A `vwLeaveBalance` view over it keeps the aggregate in one place.

**No snapshot table** (an addition, not a stated requirement). A `tblLeaveBalance`
carrying a running total would be a second source of truth, and the first time a
job half-runs the two disagree with no way to tell which is right. Recomputation
from the ledger is idempotent and replayable; a running total is neither. It is
also what lets the Manage Balance screen "correct" a balance without destroying
what was there before.

---

## Migration 016 — comp-off

### `dbo.tblCompOffCredit`

`CompOffCreditId`, `EmployeeDetailId`, `EarnedOnDate DATE`,
`AttendanceDayId BIGINT NULL` (**unique** — one credit per worked date),
`WorkedMinutes INT`, `Days DECIMAL(3,2)` (0.50 or 1.00), `ExpiresOn DATE`,
`RemainingDays DECIMAL(3,2)`, `Status NVARCHAR(20)`
(`PENDING` / `CREDITED` / `PARTIALLY_USED` / `CONSUMED` / `LAPSED` /
`REJECTED`), `ApprovedBy NULL`, `ApprovedAt NULL`, `Reason`, plus audit.

Each credit is its own row with its own expiry, because expiry is per credit and
not per balance. `RemainingDays` is the one deliberate denormalisation in this
schema: FIFO consumption needs to find the oldest credit with something left on
every application, and deriving it from `tblCompOffConsumption` on each read is a
join the apply screen does not need.

### `dbo.tblCompOffConsumption`

`CompOffConsumptionId`, `CompOffCreditId`, `LeaveRequestId`,
`DaysUsed DECIMAL(3,2)`, `CreatedAt`. Append-only. The ledger row for the debit
carries `SourceType = 'LEAVE_REQUEST'`; this table says which credits paid for
it.

---

## Module ids

`MODULE` in `src/enums/module.enum.js` currently ends at 68. Headings on round
tens, children beside them, gaps left for later screens — the existing
convention.

| Id | Code | Screen |
| --- | --- | --- |
| 70 | `ATTENDANCE_MANAGEMENT` | *heading* |
| 71 | `MY_ATTENDANCE` | Punch, own calendar, own exceptions |
| 72 | `TEAM_ATTENDANCE` | Manager view |
| 73 | `REGULARIZATION` | Raise and approve corrections |
| 74 | `SHIFTS` | Shift master, week-off patterns, assignment |
| 75 | `HOLIDAY_CALENDAR` | Per location, per year |
| 76 | `ATTENDANCE_EXEMPTIONS` | Present-by-default grants |
| 77 | `ATTENDANCE_ALERTS` | Alert settings |
| 80 | `LEAVE_MANAGEMENT` | *heading* |
| 81 | `MY_LEAVE` | Apply, balance, history |
| 82 | `TEAM_LEAVE` | Approvals |
| 83 | `LEAVE_POLICY` | Policy rows and overrides |
| 84 | `LEAVE_MAPPING` | Leave and restricted-holiday mapping |
| 85 | `LEAVE_BALANCE` | Ledger view, corrections, add leaves |
| 86 | `COMP_OFF` | Claims and credits |

Remember the rule from `module.enum.js`: **ids are fixed and permanent**. They
are stored in `dbo.tblAccessRight`, so renumbering one silently moves every
group's rights onto a different screen.

## Master-data registry additions

Three of the new tables are plain Name / Description / IsActive lookups and drop
into the existing registry with no new service, controller or route — one
migration, one model, one `MODULE` id, one `MESSAGES` block, one entry in
`MASTER_DATA_RESOURCES`:

- `tblHolidayType` → `holidayTypes`
- `tblRegularizationType` → `regularizationTypes`
- `tblAttendanceStatus` → `attendanceStatuses` (read-only in the UI; the ids are
  referenced by the resolver)

`tblShift`, `tblHoliday`, `tblLeavePolicy` and the rest are **not** master data.
They carry behaviour-bearing columns and effective dates, so they get their own
services. The test is whether the shape is exactly the seven master columns; if
it is not, it does not belong in the registry.

Note also that `009_master_data.sql` says `tblLeaveType`'s delete has no `inUse`
message "until the leave module lands". It lands here: `tblLeavePolicy`,
`tblLeaveMapping`, `tblLeaveRequest` and `tblLeaveLedger` all point at it, so the
delete endpoint now has dependants to refuse for, and
`MESSAGES.LEAVE_TYPE_IN_USE` needs adding.

## Migration order

```
011_shift.sql               tblShift, tblShiftWeekOff, tblEmployeeShift
012_attendance.sql          tblAttendanceStatus, tblAttendanceDay, tblAttendancePunch,
                            tblAttendanceExemption, tblAttendanceAlertSetting,
                            tblRegularizationType, tblRegularizationRequest
013_holiday.sql             tblHolidayType, tblHoliday, tblHolidayLocation,
                            tblRestrictedHolidayMapping, tblRestrictedHolidayOptIn
014_leave_policy.sql        tblSandwichRule, tblLeavePolicy, tblEmployeeLeavePolicy,
                            tblLeaveMapping
015_leave_request.sql       tblLeaveYear, tblLeaveRequest, tblLeaveRequestDay,
                            tblLeaveApproval, tblLeaveLedger, vwLeaveBalance
016_comp_off.sql            tblCompOffCredit, tblCompOffConsumption
```

Two notes on ordering:

1. `tblAttendanceDay.LeaveRequestId` → `tblLeaveRequest` is created as a plain
   column in `012` and constrained at the bottom of `015`, in its own batch —
   the same way `005` settles the `WorkLocationId` debt from `001`.
2. `tblLeaveLedger.SourceId` deliberately carries **no** foreign key: it points
   at four different tables depending on `SourceType`, and that is the one place
   in this schema where a polymorphic id is the honest model rather than a
   shortcut.

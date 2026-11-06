# Attendance & Leave — the model

> The schema is [ATTENDANCE-LEAVE-SCHEMA.md](ATTENDANCE-LEAVE-SCHEMA.md): tables,
> relationships, migration order.
> A single self-contained page for sharing is
> [ATTENDANCE-LEAVE.html](ATTENDANCE-LEAVE.html) — open it in any browser.

Nothing here is implemented yet. It is the agreed shape, written down before the
migrations so the arguments happen here and not in a review.

## The one rule

Attendance answers *was the person at work today*. Leave answers *was the person
allowed to be away*. They meet at exactly one row: one attendance day per
employee per date. That row's status comes from a single resolver that runs in a
fixed order and stops at the first match:

```
HOLIDAY  ->  WEEK_OFF  ->  ON_LEAVE  ->  DEFAULT_PRESENT  ->  punch-derived
```

First match wins. That is why a holiday can never also be marked absent, and why
a present-by-default employee who is on approved leave is `ON_LEAVE` and not
`PRESENT` — the exemption is from *punching*, not from the leave policy. This is
the rule people get wrong most often.

## Three additions that are not in the requirement list

Flagged so they can be removed if unwanted. Everything else in this document
traces to a stated requirement.

1. **Shifts and leave policies are versioned by effective date.** Without it,
   editing a shift's timing recomputes last month's attendance.
2. **Punches on a shift that crosses midnight stay attached to the shift's start
   date.** Without it, an 11:50 PM punch on the 3 PM – 12 AM shift lands on
   tomorrow and both days look wrong.
3. **Leave balance is a ledger of movements, not a stored number.** Without it,
   the "correction" the Manage Balance screen performs destroys what was there
   before, and nobody can answer "why is my balance 11.5?".

## What is configurable, and by whom

Admin and HR Admin both edit all of these; nobody else can.

| Setting | What it controls | Default | Scope |
| --- | --- | --- | --- |
| Check-in alert delay | Wait after shift start before the first alert | 10 min | Org / Location |
| Check-in alert interval | Gap between repeat alerts | 10 min | Org / Location |
| Check-in alert window | How long the repeats continue | 120 min | Org / Location |
| Check-out sweep time | When the missed-check-out sweep runs | 21:00 | Org / Location |
| Regularization window | How long after the date a request may be raised | 24 hours | Org / Location |
| Accrual day | Day of month leave is credited | 1 | Per policy |
| Accrual days | EL credited per month after probation | 1.0 | Per policy |
| Sandwich mode | Which of the three modes applies | to confirm | Per leave type / location |
| Validity days | Life of a comp-off credit from the day earned | to confirm | Per policy |
| Pick quota | Restricted holidays an employee may take in a year | to confirm | Per mapping |

The alert settings are per location because 9 AM in India and 9 AM in the US are
different sweeps. Anything scoped *Org / Location* resolves location-first,
falling back to the org row.

---

# Attendance

## Check-in and check-out

```
Employee opens Attendance
        |
        v
System resolves context for the date
  - work location  -> holiday calendar
  - assigned shift -> start, end, grace, thresholds
  - approved leave -> full day / half day / none
  - present-by-default flag
        |
        v
Is today a working day for this employee?
  |                        |                          |
  NO (holiday/week-off)    PARTLY (half-day leave)    YES
  punch optional;          punch for the working      punch required
  hours become a           half only
  comp-off candidate
                                                       |
                                                       v
                                            Employee checks in
                                              timestamp + source
                                                       |
                                                       v
                                            Within grace?
                                              |            |
                                            YES -> PRESENT |
                                                        NO -> LATE
                                                       |
                                                       v
                                            Employee checks out
                                              worked = out - in - break
                                                       |
                                                       v
                                            Nightly close job
```

The nightly close writes the final status:

| Condition | Status |
| --- | --- |
| Worked >= full-day minutes | `PRESENT` |
| Half-day <= worked < full-day | `HALF_DAY` |
| Worked < half-day minutes | `ABSENT` |
| Check-in present, check-out missing | `MISSING_PUNCH` |
| No punch at all, not on leave or holiday | `ABSENT` |

### Screens

- **My Attendance** — the employee's own calendar, punches, exceptions and
  pending regularizations. Employees see only themselves.
- **Team Attendance** — the reporting manager's view of everyone whose
  `ManagerId` is them.
- HR, HR Admin and Admin see all employees; this is an ordinary module right,
  not a separate screen.

## Alerts

Every alert is a scheduled job reading the attendance day row. None are
triggered by a person.

| When | Alert | Suppressed when |
| --- | --- | --- |
| Shift start + delay, then every interval for the window | "You forgot to check in", repeating until the employee punches | On approved leave, holiday, week-off, present-by-default, or already checked in |
| The configured sweep time, 21:00 by default | "You forgot to check out"; writes `MISSING_PUNCH` | Already checked out, or on leave |
| On decision | "Your regularization for *date* was approved / rejected" | Never |

**Worked example.** General shift 9 AM – 6 PM, defaults as configured: first mail
at 9:10, then 9:20, 9:30 … through 11:10, stopping the moment the employee checks
in. Twelve mails is the maximum, and the window is what bounds it, not a retry
count.

**On leave means silence.** If the employee has an approved leave covering the
date, the job skips the row entirely — it is not a filter applied afterwards.

Every alert that goes out writes a row through the existing
`dbo.tblEmailOutbox`, so "I never got a mail" has an answer.

## Regularization

```
An exception day exists  (MISSING_PUNCH / ABSENT / LATE)
        |
        v
Employee raises a regularization request
  date, type, proposed in/out time, reason
        |
        v
Is the request inside the window?
  - within 24 hours of the date, by default
  - no existing request or approved leave on that date
  |                               |
  NO -> blocked at submit         YES -> PENDING
                                         |
                                         v
                            Approver decides: Manager, HR Admin or Admin
                              |              |                |
                           APPROVE        REJECT          no action
                              |              |                |
                    day recomputed,   status stands    EXPIRED at the
                    previous status                     window close
                    kept on the row
                              |
                              v
                    Mail to the employee, on approval and on rejection
```

**Types:** missing check-in, missing check-out, late arrival, early exit.

**Approvers** are the reporting manager, HR Admin and Admin — any one of the
three can decide, from the same approval screen, which shows the recorded punch
beside the claim.

## Shifts

| Code | Window | Note |
| --- | --- | --- |
| `GEN` | 09:00 – 18:00 | General shift |
| `EVE` | 15:00 – 00:00 | Crosses midnight |

A third can be added as a row; nothing in the design assumes only two.

A shift is **resolved** for an employee on a date, not asked for directly:

```
1. The employee's assigned shift      <- the normal case
2. The location's default shift       <- fallback, so resolution never returns nothing
```

Each shift carries its window, grace-in and grace-out minutes, unpaid break
minutes, full-day and half-day thresholds, a crosses-midnight flag, and its
week-off pattern (fixed Sat + Sun, or alternate Saturday). The week-off pattern
is what the sandwich rule reads — it must not hard-code weekends, because India
and the US may not share them.

## Present by default

Switched on per employee. While it is on, that member does not check in on a
regular basis and is never chased for a punch, identically whether they are in
India or the US.

```
HR Admin grants the exemption
  effective-from, effective-to, reason
        |
        v
Daily job marks the day PRESENT at shift start, source DEFAULT_PRESENT
        |
        v
Approved leave on this date?
  |                                      |
  YES -> ON_LEAVE, balance deducted      NO -> PRESENT stands
         (leave always wins)
```

Effect: no missed-punch alerts, no regularization requests, no approvals for
these employees.

## Holidays

One calendar, scoped by location. India and the US have different holidays and
festivals, so a holiday row is linked to one or more locations, and an employee
sees only the holidays for the location they are assigned to.

| Type | Behaviour |
| --- | --- |
| **Normal** | Applies to everybody at the linked locations. Non-working, nothing to claim. |
| **Restricted** | Published as a list. The employee picks up to their quota from it, as a request approved like a leave. Unpicked days stay ordinary working days. |

HR Admin can **add, edit and delete** holidays. Delete is a soft delete, so a
holiday that days are already marked against never leaves the table.

**Why a link table and not a `LocationId` column.** New Year's Day is one holiday
observed in India and the US; Thanksgiving is one observed only in the US. A
single column forces either a duplicate row per location or a nullable "all
locations" special case, and the first bug either produces is a US employee
seeing an Indian festival.

**The restricted year runs 1 January to 31 December.** Quota is credited on
1 January, and whatever is unused **lapses on 31 December**. Who may pick from
which list, and how many, is the restricted-holiday mapping below.

A punch on any holiday does not make it a working day — it makes it a comp-off
claim candidate.

---

# Leave

## The leave types, and who gets them

| Type | Who | Accrual |
| --- | --- | --- |
| **CL** Casual | All employees | Per policy |
| **SL** Sick | All employees | Per policy |
| **EL** Earned | **Permanent only** — not contractors, not anyone still on probation | 1 day credited on the 1st of every month, after probation ends |
| **Maternity** | Mapped by gender, permanent | Granted as a block |
| **Paternity** | Mapped by gender, permanent | Granted as a block |
| **Sabbatical** | Mapped by tenure | Granted on approval |
| **Comp-off** | Anybody who worked a holiday or week-off | Earned per approved claim; expires |
| **Restricted** | All employees, per the location's list | Quota credited 1 Jan, lapses 31 Dec |

Both the accrual day and the per-month rate are configured, not hard-coded.

## The probation gate

```
Employee joins
        |
        v
ProbationEndDate = DateOfJoining + probation period    <- already a column on tblEmployeeDetails
        |
        v
Contractor?
  |                                     |
  YES -> no EL, ever                    NO -> continue
         (decided by employment type
          in the leave mapping)
        |
        v
Is the leave date inside the probation window?
  |                                              |
  YES — on probation                             NO — confirmed
   - CL and SL available                          - EL unlocks
   - EL does not accrue and cannot be applied for - 1 day on the 1st of each month
   - comp-off earnable
```

The gate is a date comparison against `ProbationEndDate`, not a flag somebody
remembers to flip.

## Applying — half day and full day

Days are computed **before** the balance is checked, because the sandwich rule
can change how many days are being asked for.

```
Employee opens Apply Leave
        |
        v
Show only the leave types mapped to this employee
        |
        v
Choose type, from-to, and duration
  FULL DAY  |  FIRST HALF  |  SECOND HALF        <- half day = 0.5
        |
        v
Compute chargeable days
  calendar days -> remove week-offs and location holidays
                -> apply the sandwich mode (may add them back)
                -> one row written per date
        |
        v
Balance check
  available = ledger balance - days held by pending requests
  |                                   |
  enough -> HOLD the days             short -> blocked, with the next
                                               accrual date shown
        |
        v
Approval -> hold becomes a debit, each date written to attendance as ON_LEAVE,
            employee and manager notified
```

A half-day leave does not excuse the day's punch: the employee is still expected
to check in for the half they are working.

## The sandwich rule — three selectable modes

Configured per leave type and location, never code. Scenario: week-off on
Saturday and Sunday.

| Mode | Fri leave only | Mon leave only | Fri **and** Mon |
| --- | --- | --- | --- |
| `IGNORE_WEEKOFF` | 1 day | 1 day | **2 days** — Sat and Sun ignored |
| `COUNT_WHEN_BOTH_FLANKS` | 1 day | 1 day | **4 days** — Sat and Sun charged |
| `COUNT_ALWAYS` | 3 days | 3 days | **4 days** |

Whichever mode is selected drives the calculation for every application of that
leave type. Worked example, `COUNT_WHEN_BOTH_FLANKS`:

```
Thu      Fri        Sat        Sun        Mon        Tue      charged
Work     Leave      Off        Off        Work       Work     1.0
Work     Work       Off        Off        Leave      Work     1.0
Work     Leave      CHARGED    CHARGED    Leave      Work     4.0
Leave    Leave      CHARGED    CHARGED    Leave      Leave    6.0
```

Every day the rule adds is tagged `SANDWICH` on the request's day rows, so the
deduction is explainable line by line, and the total is shown to the employee
before they submit.

## Comp-off

**Earning.** The employee claims comp-off for a week-off or holiday they worked.
The system verifies the claim against the attendance record: the date really is
non-working, the hours come from the punches and not from the claim form, and no
credit already exists for that date. Hours decide the credit — below the half-day
threshold nothing is banked, the half-day band gives 0.5, the full-day band gives
1.0, capped at 1.0 per date. The manager approves, and the credit is banked as
**its own row** with its own expiry.

**Spending.** Applied for like any other leave, with type comp-off. Credits are
consumed **FIFO by expiry date**, so nothing lapses while a newer credit is
spent, and the application shows which credit is being used. A partially used
credit keeps its remainder and its original expiry. Comp-off cannot go negative.

**Expiry.** A daily job lapses credits past their expiry and writes the lapse to
the ledger.

## Managing balances

The **Manage Leave Balance** screen is where HR Admin makes corrections and adds
leaves. It writes an `ADJUSTMENT` row with a mandatory reason and never edits
history.

| Entry | Raised by | Effect | When |
| --- | --- | --- | --- |
| `OPENING` | System | + | On joining, and each leave-year rollover |
| `ACCRUAL` | Scheduler | + | On the policy's credit date — the 1st, for EL |
| `PROBATION_RELEASE` | Scheduler | + | On confirmation, unlocking EL |
| `COMP_OFF_CREDIT` | Manager approval | + | On approving a claim; carries its own expiry |
| `HOLD` | Leave application | reserved | At submit — reduces *available*, not balance |
| `DEBIT` | Approval | − | On approval; converts the hold |
| `REVERSAL` | Rejection / cancellation | + | Releases a hold, or credits back unused days |
| `ADJUSTMENT` | HR Admin | ± | Manual correction — reason mandatory |
| `LAPSE` | Scheduler | − | Expired comp-off, unused restricted days |

**Balance** = the sum of every signed row. **Available** = balance minus open
holds. The apply screen checks available; the screen shows both, because the gap
between them is always somebody's pending request.

Bulk credit — a new leave type rolled out to everybody — is the same operation
repeated, as one import with one reason attached to every row it writes.

## Customised policy for certain employees

A policy is resolved from leave type × location × employment type. When somebody
is a genuine exception — a negotiated joining term, a transfer carrying an old
entitlement — HR Admin attaches an **employee-level override** instead of
creating a near-duplicate policy for one person.

The override carries only what differs (annual quota, accrual rate), plus
effective dates and a mandatory reason. Resolution checks the override first and
falls back to the policy. This keeps the policy list readable: one row per real
policy, not one per negotiated hire.

## Mapping

Two mappings, two tables.

**Leave mapping — which types an employee may take.** By location, employment
type, gender (maternity, paternity), tenure (sabbatical), and probation status.
A row is a *grant*: nothing matching means the type is not offered, so the Apply
Leave dropdown is built from this table and nothing else.

**Restricted-holiday mapping — which list, and how many picks.** By location
(the published list is per location), employment type where it differs, leave
year, and the pick quota. Credited on 1 January and lapsed on 31 December by the
same jobs that run every other leave type.

Evaluation order, first failure stops the request:

```
Gate 1  Mapping   is the type mapped to this employee?  -> if not, invisible
Gate 2  Policy    half day allowed, probation gate      -> blocked, rule named
Gate 3  Balance   enough available, after sandwich      -> blocked, next accrual shown
Gate 4  Approval  human judgement
```

Gates 1 to 3 are pure functions of configuration, so they are callable as a dry
run from the UI: the employee sees the verdict while picking dates, not after
pressing Submit. And approvers never have to be the ones catching policy
violations — by the time a request reaches them, it is already legal.

## Approvals

Leave is approved by the **reporting manager**, **HR** and **HR Admin**.

```
Level 1   reporting manager                 <- ManagerId on the employee record
     |
     v
Level 2   HR or HR Admin — only for leave types flagged as needing it
            (sabbatical, maternity, paternity)
     |
     v
APPROVED  ledger debit, attendance days written, employee notified
```

### Who can do what

| Capability | Employee | Manager | HR | HR Admin / Admin |
| --- | --- | --- | --- | --- |
| Apply for and cancel own leave | Yes | Yes | Yes | Yes |
| View own attendance | Yes | Yes | Yes | Yes |
| View team attendance | — | Yes | Yes | Yes |
| Approve team leave | — | Yes | Yes | Yes |
| Approve second level | — | — | Yes | Yes |
| Approve regularization | — | Yes | — | Yes |
| Grant present-by-default | — | — | — | Yes |
| Correct or add leave balance | — | — | — | Yes |
| Add / edit / delete holidays | — | — | — | Yes |
| Edit policies, shifts, alert settings | — | — | — | Yes |

This maps onto the existing group-and-module model — see
[ACCESS-CONTROL.md](ACCESS-CONTROL.md). No new permission mechanism; new
`MODULE` ids and the usual six flags.

---

## Use cases

| # | Use case | Actor | Trigger | Writes |
| --- | --- | --- | --- | --- |
| UC-01 | Check in | Employee | Start of day | Punch row; `PRESENT` or `LATE` |
| UC-02 | Check out | Employee | End of day | Punch row; worked minutes |
| UC-03 | Close the day | Scheduler | Nightly | Final day status |
| UC-04 | View own attendance | Employee | Opens the screen | — |
| UC-05 | View team attendance | Manager | Opens the screen | — |
| UC-06 | Alert on missed check-in | Scheduler | Shift start + delay, repeating | Outbox rows; suppressed on leave |
| UC-07 | Alert on missed check-out | Scheduler | The configured sweep time | Outbox row; `MISSING_PUNCH` |
| UC-08 | Configure alert timing | Admin, HR Admin | Policy change | Alert setting row |
| UC-09 | Raise regularization | Employee | An exception day exists | Request `PENDING` |
| UC-10 | Decide regularization | Manager, HR Admin, Admin | Approval screen | Day recomputed; mail to employee |
| UC-11 | Define a shift | HR Admin | Setup or timing change | Shift version + week-off rows |
| UC-12 | Assign a shift | HR Admin | Joining, or a shift move | Assignment row |
| UC-13 | Grant present-by-default | HR Admin | New exemption | Exemption row |
| UC-14 | Mark exempt members present | Scheduler | Daily at shift start | `PRESENT`, source `DEFAULT_PRESENT` |
| UC-15 | Add / edit / delete a holiday | HR Admin | Calendar maintenance | Holiday row + location links |
| UC-16 | View holidays for my location | Employee | Opens the calendar | — |
| UC-17 | Pick a restricted holiday | Employee | From the published list | Opt-in row; day becomes `HOLIDAY` |
| UC-18 | Lapse unused restricted days | Scheduler | 31 December | Lapse rows |
| UC-19 | Define a leave policy | HR Admin | Setup or revision | Policy version |
| UC-20 | Customise a policy for one employee | HR Admin | Negotiated exception | Override row + reason |
| UC-21 | Accrue leave on the 1st | Scheduler | Monthly | Accrual rows, EL post-probation only |
| UC-22 | Unlock EL on confirmation | Scheduler | Probation ends | `PROBATION_RELEASE` row |
| UC-23 | Apply for leave, full or half day | Employee | Needs time off | Request + hold + day rows |
| UC-24 | Compute chargeable days | Rule engine | At apply, again at approve | Day rows, sandwich days tagged |
| UC-25 | Select the sandwich mode | Admin, HR Admin | Policy decision | Sandwich rule row |
| UC-26 | Cancel or withdraw | Employee | Plans changed | Reversal; days released |
| UC-27 | Claim comp-off | Employee | Worked a holiday or week-off | Claim `PENDING` |
| UC-28 | Credit comp-off | Manager | Approving the claim | Credit row with expiry |
| UC-29 | Spend comp-off | Employee | Applying with type comp-off | Consumption rows; day `ON_LEAVE` |
| UC-30 | Lapse expired comp-off | Scheduler | Daily | Lapse rows |
| UC-31 | Correct or add leaves | HR Admin | Manage Balance screen | `ADJUSTMENT` + reason |
| UC-32 | Map leave types to employees | HR Admin | Setup, transfer, promotion | Mapping rows |
| UC-33 | Map restricted holidays and quota | HR Admin | Start of year | Restricted-holiday mapping rows |
| UC-34 | Approve leave | Manager, HR, HR Admin | Request in queue | Approval row; debit on commit |

## Scheduled jobs

| Cadence | Job |
| --- | --- |
| Every 10 min | Missed check-in alert sweep, within each alert window |
| Daily, 21:00 | Missed check-out sweep; write `MISSING_PUNCH` |
| Nightly | Close the day; compute final statuses |
| Daily, shift start | Mark present-by-default members present |
| Daily | Comp-off expiry; regularization window expiry |
| Monthly, 1st | Leave accrual, EL included |
| Annually, 1 Jan | Credit restricted-holiday quota; open the new leave year |
| Annually, 31 Dec | Lapse unused restricted days; close the year |

## To confirm

| Question | Why it matters |
| --- | --- |
| Comp-off validity — 30, 60 or 90 days | Sets `ValidityDays` and the expiry job |
| Restricted-holiday pick quota | Sets `PickQuota` on the mapping |
| Default sandwich mode per leave type | Changes every chargeable-day calculation |
| Comp-off consumable during probation, or earnable only | One flag on the policy |
| What happens to an `ABSENT` day when balance is available | Auto-convert to leave, or leave it absent |

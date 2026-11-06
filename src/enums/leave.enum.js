/**
 * Leave vocabulary: cycles, policy behaviour, request and approval states,
 * and the ledger's entry types.
 *
 * Every value here that is stored in a column is mirrored by a CHECK
 * constraint in db/migrations/018_leave_policy.sql, 019_leave_request.sql or
 * 020_comp_off.sql. Adding a value means editing both, deliberately - a
 * status that exists in JavaScript and not in the database fails at the
 * driver with a constraint name and no hint about which field caused it.
 *
 * Nothing in this file knows about the database. The leave service maps
 * these onto tables; the enums stay importable from anywhere.
 */

/* -------------------------------------------------------------------------
   Confirmation - db/migrations/014
   ------------------------------------------------------------------------- */

/**
 * CK_tblEmployeeDetails_ConfirmationStatus.
 *
 * NOT the same column as tblEmployeeDetails.EmploymentStatus, which has
 * existed since 001 and answers where somebody stands with the company
 * (Active / Exited / ...). These two are independent: an exited employee
 * was still either confirmed or not, and final settlement reads exactly
 * that. See the header of db/migrations/014_employment_confirmation.sql.
 */
export const CONFIRMATION_STATUS = Object.freeze({
  PROBATION: 'PROBATION',
  CONFIRMED: 'CONFIRMED',
});

/** CK_tblEmploymentStatusHistory_ChangeType. */
export const CONFIRMATION_CHANGE_TYPE = Object.freeze({
  /** The nightly job, on reaching the probation end date. */
  AUTO_CONFIRM: 'AUTO_CONFIRM',
  /** HR confirming early, or signing off late. */
  MANUAL_CONFIRM: 'MANUAL_CONFIRM',
  EXTEND: 'EXTEND',
  SHORTEN: 'SHORTEN',
});

/** The HR document's default. Overridable per employee - ProbationMonths. */
export const DEFAULT_PROBATION_MONTHS = 3;

/* -------------------------------------------------------------------------
   Cycles - db/migrations/018
   ------------------------------------------------------------------------- */

/**
 * CK_tblLeaveCycle_CycleType.
 *
 * Two cycles run at once, and that is the structural fact the whole leave
 * module is built around: CL/SL and EL on the financial year, the floating
 * holiday on the calendar year. A policy says which type it uses, and every
 * ledger row and request names a specific cycle.
 */
export const CYCLE_TYPE = Object.freeze({
  /** 1 April - 31 March. CL/SL and Earned Leave. */
  FINANCIAL: 'FINANCIAL',
  /** 1 January - 31 December. The floating / restricted holiday. */
  CALENDAR: 'CALENDAR',
});

/**
 * The same list plus NONE, which is valid on a POLICY but never on a cycle.
 * CK_tblLeavePolicy_CycleType.
 *
 * NONE is for Leave Without Pay and comp-off: neither belongs to a year at
 * all. LWP has no balance to reset and a comp-off expires on its own clock.
 */
export const POLICY_CYCLE_TYPE = Object.freeze({
  ...CYCLE_TYPE,
  NONE: 'NONE',
});

/** The month a financial year starts in, 1-based. April. */
export const FINANCIAL_YEAR_START_MONTH = 4;

/* -------------------------------------------------------------------------
   Policy behaviour - db/migrations/018
   ------------------------------------------------------------------------- */

/** CK_tblLeavePolicy_AccrualFrequency. */
export const ACCRUAL_FREQUENCY = Object.freeze({
  MONTHLY: 'MONTHLY',
  ANNUAL: 'ANNUAL',
  NONE: 'NONE',
});

/**
 * CK_tblLeavePolicy_AccrualAnchor - where the monthly clock starts.
 *
 * THIS ENUM EXISTS BECAUSE THE SOURCES DISAGREE. The original requirement
 * list says EL is credited on the 1st of every month; the HR document says
 * from the probation end date; and HR's own open question asks whether it
 * is the exact date or the month following. Section 28 of
 * docs/ATTENDANCE-LEAVE.html records that as unresolved.
 *
 * Rather than pick one and bury it in the accrual job, all four are
 * implemented and the policy row chooses. Whichever answer HR settles on
 * becomes a configuration value.
 */
export const ACCRUAL_ANCHOR = Object.freeze({
  /** Everybody accrues on the cycle's start date. */
  CYCLE_START: 'CYCLE_START',
  /** The 1st of each month - the original requirement list. */
  MONTH_START: 'MONTH_START',
  /** The confirmation anniversary - the HR document. */
  PROBATION_END: 'PROBATION_END',
  /** The joining anniversary. */
  JOINING_DATE: 'JOINING_DATE',
});

/** CK_tblSandwichRule_Mode. Section 12 - all three were specified. */
export const SANDWICH_MODE = Object.freeze({
  /** Friday and Monday off = 2 days. The weekend is not charged. */
  IGNORE_WEEKOFF: 'IGNORE_WEEKOFF',
  /** Friday and Monday off = 4 days. Friday alone is still 1. */
  COUNT_WHEN_BOTH_FLANKS: 'COUNT_WHEN_BOTH_FLANKS',
  /** Every non-working day inside the range is charged. */
  COUNT_ALWAYS: 'COUNT_ALWAYS',
});

/* -------------------------------------------------------------------------
   Requests and approvals - db/migrations/019
   ------------------------------------------------------------------------- */

/** CK_tblLeaveRequest_DayPart and CK_tblLeaveRequestDay_DayPart. */
export const DAY_PART = Object.freeze({
  FULL: 'FULL',
  FIRST_HALF: 'FIRST_HALF',
  SECOND_HALF: 'SECOND_HALF',
});

/** How many days each day part charges. */
export const DAY_PART_CHARGE = Object.freeze({
  [DAY_PART.FULL]: 1,
  [DAY_PART.FIRST_HALF]: 0.5,
  [DAY_PART.SECOND_HALF]: 0.5,
});

/**
 * CK_tblLeaveRequest_Status.
 *
 * PENDING_MANAGER and PENDING_HR are two states rather than one PENDING
 * with a level column, because the approver queues are different screens
 * and a single state would make "whose turn is it" a join every time.
 */
export const LEAVE_REQUEST_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  PENDING_MANAGER: 'PENDING_MANAGER',
  PENDING_HR: 'PENDING_HR',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  /** Withdrawn by the employee before anybody decided. */
  CANCELLED: 'CANCELLED',
  /** Taken back by the employee after approval. */
  WITHDRAWN: 'WITHDRAWN',
});

/** The states that still hold balance. A hold is live in exactly these. */
export const LEAVE_PENDING_STATUSES = Object.freeze([
  LEAVE_REQUEST_STATUS.PENDING_MANAGER,
  LEAVE_REQUEST_STATUS.PENDING_HR,
]);

/** The states a request can still be acted on from. */
export const LEAVE_OPEN_STATUSES = Object.freeze([
  LEAVE_REQUEST_STATUS.DRAFT,
  ...LEAVE_PENDING_STATUSES,
]);

/** CK_tblLeaveRequestDay_DayType. */
export const LEAVE_DAY_TYPE = Object.freeze({
  WORKING: 'WORKING',
  /** A week-off or holiday charged by the sandwich rule. */
  SANDWICH: 'SANDWICH',
});

/** CK_tblLeaveApproval_Action. */
export const APPROVAL_ACTION = Object.freeze({
  SUBMITTED: 'SUBMITTED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  WITHDRAWN: 'WITHDRAWN',
  /** Manager approved, and it now needs HR as well. */
  FORWARDED: 'FORWARDED',
});

/**
 * CK_tblLeaveApproval_ApproverRole - the capacity somebody acted in.
 *
 * Recorded as it was AT THE TIME. The person who approved this as a
 * reporting manager may not be one next year, and the trail must still say
 * what they were when they signed.
 */
export const APPROVER_ROLE = Object.freeze({
  MANAGER: 'MANAGER',
  SECONDARY_MANAGER: 'SECONDARY_MANAGER',
  HR: 'HR',
  HR_ADMIN: 'HR_ADMIN',
  ADMIN: 'ADMIN',
  /** The employee acting on their own request - cancel, withdraw. */
  EMPLOYEE: 'EMPLOYEE',
});

/** Approval levels. 1 is the reporting manager, 2 is HR. */
export const APPROVAL_LEVEL = Object.freeze({
  MANAGER: 1,
  HR: 2,
});

/* -------------------------------------------------------------------------
   The ledger - db/migrations/019
   ------------------------------------------------------------------------- */

/**
 * CK_tblLeaveLedger_EntryType.
 *
 * The balance is SUM(Days) over these rows and is stored nowhere else, so
 * this list is the complete set of reasons a balance can ever change. If
 * something moves a balance and is not one of these, it is a bug.
 */
export const LEDGER_ENTRY_TYPE = Object.freeze({
  /** Carry-forward from the previous cycle. */
  OPENING: 'OPENING',
  /** The monthly or annual grant. */
  ACCRUAL: 'ACCRUAL',
  /** Earned Leave opening when probation ends. */
  CONFIRMATION_RELEASE: 'CONFIRMATION_RELEASE',
  /** HR crediting an approved comp-off, by hand. */
  COMP_OFF_CREDIT: 'COMP_OFF_CREDIT',
  /** Applied for, awaiting a decision. Carries IsHold = 1. */
  HOLD: 'HOLD',
  /** Approved and spent. */
  DEBIT: 'DEBIT',
  /** Unpaid days. Counted, never deducted from a paid balance. */
  LWP_DEBIT: 'LWP_DEBIT',
  /** Undoing a hold or a debit. */
  REVERSAL: 'REVERSAL',
  /** HR correcting by hand. Remarks mandatory. */
  ADJUSTMENT: 'ADJUSTMENT',
  /** Unused days expiring at cycle end. */
  LAPSE: 'LAPSE',
});

/** CK_tblLeaveLedger_SourceType. What SourceId points at. */
export const LEDGER_SOURCE_TYPE = Object.freeze({
  LEAVE_REQUEST: 'LEAVE_REQUEST',
  COMP_OFF: 'COMP_OFF',
  ADJUSTMENT: 'ADJUSTMENT',
  ACCRUAL: 'ACCRUAL',
  CYCLE_CLOSE: 'CYCLE_CLOSE',
});

/** Entry types that add to a balance. Used by the view and by reports. */
export const LEDGER_CREDIT_TYPES = Object.freeze([
  LEDGER_ENTRY_TYPE.OPENING,
  LEDGER_ENTRY_TYPE.ACCRUAL,
  LEDGER_ENTRY_TYPE.CONFIRMATION_RELEASE,
  LEDGER_ENTRY_TYPE.COMP_OFF_CREDIT,
]);

/* -------------------------------------------------------------------------
   Restricted holidays - db/migrations/017
   ------------------------------------------------------------------------- */

/** Fixed ids, seeded by the migration itself. */
export const HOLIDAY_TYPE = Object.freeze({
  NORMAL: 1,
  RESTRICTED: 2,
});

/** CK_tblRestrictedHolidayOptIn_Status. */
export const OPT_IN_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
});

/** The statuses that occupy an employee's one pick for the cycle. */
export const OPT_IN_OPEN_STATUSES = Object.freeze([
  OPT_IN_STATUS.PENDING,
  OPT_IN_STATUS.APPROVED,
]);

/* -------------------------------------------------------------------------
   Compensatory off - db/migrations/020
   ------------------------------------------------------------------------- */

/**
 * CK_tblCompOffRequest_Status.
 *
 * APPROVED_AWAITING_CREDIT is the state the HR document requires and the
 * one a single-table design cannot express: the manager has agreed the work
 * happened, and HR has not yet granted the day. Without it, approval and
 * credit are the same event - which is precisely what the HR document says
 * must not happen.
 */
export const COMP_OFF_REQUEST_STATUS = Object.freeze({
  PENDING_MANAGER: 'PENDING_MANAGER',
  APPROVED_AWAITING_CREDIT: 'APPROVED_AWAITING_CREDIT',
  CREDITED: 'CREDITED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
});

/** Statuses that occupy the one-request-per-worked-day slot. */
export const COMP_OFF_OPEN_STATUSES = Object.freeze([
  COMP_OFF_REQUEST_STATUS.PENDING_MANAGER,
  COMP_OFF_REQUEST_STATUS.APPROVED_AWAITING_CREDIT,
  COMP_OFF_REQUEST_STATUS.CREDITED,
]);

/** CK_tblCompOffCredit_Status. */
export const COMP_OFF_CREDIT_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  CONSUMED: 'CONSUMED',
  LAPSED: 'LAPSED',
});

/** The HR document: one day per approved request. */
export const COMP_OFF_DAYS_PER_REQUEST = 1;

/**
 * Leave requests and the ledger: dbo.tblLeaveRequest,
 * dbo.tblLeaveRequestDay, dbo.tblLeaveApproval, dbo.tblLeaveLedger and the
 * dbo.vwLeaveBalance view.
 *
 * Mirrors db/migrations/019_leave_request.sql.
 *
 * THE BALANCE IS NOT STORED. It is SUM(Days) over tblLeaveLedger, and
 * LeaveBalance below is a VIEW, not a table - nothing writes to it. Two of
 * these models are append-only and say so by what they lack: tblLeaveApproval
 * and tblLeaveLedger have no modifiedAt and no deletedAt, because an
 * approval that can be edited is not an approval and a ledger that can be
 * edited is not a ledger.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

const auditColumns = () => ({
  createdBy: { column: 'CreatedBy', type: sql.BigInt, nullable: true },
  modifiedBy: { column: 'ModifiedBy', type: sql.BigInt, nullable: true },
  createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
  modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
  // NULL means live.
  deletedAt: { column: 'DeletedAt', type: sql.DateTime2, nullable: true },
});

/** dbo.tblLeaveRequest - one application. */
export const LeaveRequest = defineModel({
  table: 'dbo.tblLeaveRequest',
  columns: {
    leaveRequestId: { column: 'LeaveRequestId', type: sql.BigInt, identity: true },

    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },
    leaveTypeId: { column: 'LeaveTypeId', type: sql.BigInt },

    /*
      Resolved from the POLICY's cycle type, not from the date alone. A
      floating holiday in February belongs to that calendar year while
      CL/SL the same week belongs to the financial year - the date cannot
      tell them apart, only the policy can.
    */
    leaveCycleId: { column: 'LeaveCycleId', type: sql.BigInt },

    fromDate: { column: 'FromDate', type: sql.Date },
    toDate: { column: 'ToDate', type: sql.Date },

    // DAY_PART in src/enums/leave.enum.js. Only meaningful on a one-day
    // request - CK_tblLeaveRequest_HalfDayIsOneDay enforces that.
    dayPart: { column: 'DayPart', type: sql.NVarChar(12) },

    // CHARGEABLE days, after the sandwich rule. Not the span of the range.
    totalDays: { column: 'TotalDays', type: sql.Decimal(5, 2) },
    // Of which added by the rule, so the employee can be shown why four
    // days were charged for a two-day absence.
    sandwichDays: { column: 'SandwichDays', type: sql.Decimal(5, 2) },

    /*
      The split, stored rather than recomputed. When somebody on probation
      applies for three days with one day left, two fall through to LWP -
      and the payslip must be explainable next month without re-running the
      balance as it stood that day. CK_tblLeaveRequest_SplitAddsUp keeps
      the two honest against TotalDays.
    */
    paidDays: { column: 'PaidDays', type: sql.Decimal(5, 2) },
    lwpDays: { column: 'LWPDays', type: sql.Decimal(5, 2) },

    reason: { column: 'Reason', type: sql.NVarChar(1000) },
    contactDuringLeave: { column: 'ContactDuringLeave', type: sql.NVarChar(100), nullable: true },
    documentUrl: { column: 'DocumentUrl', type: sql.NVarChar(2048), nullable: true },

    // LEAVE_REQUEST_STATUS in src/enums/leave.enum.js.
    status: { column: 'Status', type: sql.NVarChar(20) },

    // Denormalised from the approval trail for the list screens.
    currentApproverId: { column: 'CurrentApproverId', type: sql.BigInt, nullable: true },
    decidedAt: { column: 'DecidedAt', type: sql.DateTime2, nullable: true },

    cancelledAt: { column: 'CancelledAt', type: sql.DateTime2, nullable: true },
    cancelReason: { column: 'CancelReason', type: sql.NVarChar(500), nullable: true },

    ...auditColumns(),
  },
});

/**
 * dbo.tblLeaveRequestDay - one row per calendar date in the request.
 *
 * Expanded rather than kept as a range because every interesting question
 * is per-day: which dates were sandwich days, which fell through to LWP,
 * which were half. A range answers none of them.
 */
export const LeaveRequestDay = defineModel({
  table: 'dbo.tblLeaveRequestDay',
  columns: {
    leaveRequestDayId: { column: 'LeaveRequestDayId', type: sql.BigInt, identity: true },

    leaveRequestId: { column: 'LeaveRequestId', type: sql.BigInt },
    leaveDate: { column: 'LeaveDate', type: sql.Date },

    // LEAVE_DAY_TYPE: WORKING, or SANDWICH for a day the rule added.
    dayType: { column: 'DayType', type: sql.NVarChar(12) },
    dayPart: { column: 'DayPart', type: sql.NVarChar(12) },

    isLWP: { column: 'IsLWP', type: sql.Bit },
    chargedDays: { column: 'ChargedDays', type: sql.Decimal(3, 2) },

    createdBy: { column: 'CreatedBy', type: sql.BigInt, nullable: true },
    createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
  },
});

/**
 * dbo.tblLeaveApproval - APPEND-ONLY.
 *
 * One row per DECISION, not per request: manager then HR is two rows, and a
 * rejection followed by a resubmission is more. `approverRole` records the
 * capacity somebody acted in AT THE TIME, because the person who approved
 * this as a reporting manager may not be one next year.
 */
export const LeaveApproval = defineModel({
  table: 'dbo.tblLeaveApproval',
  columns: {
    leaveApprovalId: { column: 'LeaveApprovalId', type: sql.BigInt, identity: true },

    leaveRequestId: { column: 'LeaveRequestId', type: sql.BigInt },

    // APPROVAL_LEVEL: 1 manager, 2 HR.
    approvalLevel: { column: 'ApprovalLevel', type: sql.TinyInt },

    approverId: { column: 'ApproverId', type: sql.BigInt },
    // APPROVER_ROLE in src/enums/leave.enum.js.
    approverRole: { column: 'ApproverRole', type: sql.NVarChar(30) },

    // APPROVAL_ACTION.
    action: { column: 'Action', type: sql.NVarChar(20) },
    remarks: { column: 'Remarks', type: sql.NVarChar(1000), nullable: true },

    actedAt: { column: 'ActedAt', type: sql.DateTime2 },
  },
});

/**
 * dbo.tblLeaveLedger - APPEND-ONLY, and the only record of a balance.
 *
 * Nothing here is ever updated or deleted. A mistake is corrected by
 * writing a REVERSAL or an ADJUSTMENT, which is what keeps the history
 * readable afterwards.
 */
export const LeaveLedger = defineModel({
  table: 'dbo.tblLeaveLedger',
  columns: {
    leaveLedgerId: { column: 'LeaveLedgerId', type: sql.BigInt, identity: true },

    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },
    leaveTypeId: { column: 'LeaveTypeId', type: sql.BigInt },
    leaveCycleId: { column: 'LeaveCycleId', type: sql.BigInt },

    // LEDGER_ENTRY_TYPE in src/enums/leave.enum.js - the complete set of
    // reasons a balance can ever change.
    entryType: { column: 'EntryType', type: sql.NVarChar(25) },

    // SIGNED. Credit positive, debit negative. A hold carries its days as
    // a POSITIVE number and is identified by isHold, not by a sign - a
    // negative held number would be subtracted twice.
    days: { column: 'Days', type: sql.Decimal(6, 2) },
    isHold: { column: 'IsHold', type: sql.Bit },

    // LEDGER_SOURCE_TYPE. sourceId is polymorphic and carries NO foreign
    // key - the only unconstrained reference in this schema.
    sourceType: { column: 'SourceType', type: sql.NVarChar(20) },
    sourceId: { column: 'SourceId', type: sql.BigInt, nullable: true },

    // The date the entry is ABOUT, not the date it was written: an accrual
    // posted late still belongs to its own month.
    effectiveDate: { column: 'EffectiveDate', type: sql.Date },

    // Mandatory for ADJUSTMENT, enforced in the service so the message can
    // name the field.
    remarks: { column: 'Remarks', type: sql.NVarChar(500), nullable: true },

    createdBy: { column: 'CreatedBy', type: sql.BigInt, nullable: true },
    createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
  },
});

/**
 * dbo.vwLeaveBalance - A VIEW. Nothing writes to it.
 *
 * The one place the balance sum is written down. Every screen that shows a
 * balance reads this; no service computes its own, because two versions of
 * this arithmetic is how the dashboard and the apply screen come to
 * disagree about whether somebody has half a day left.
 *
 * lwpDaysConsumed is deliberately NOT subtracted from anything - the HR
 * document is explicit that LWP never offsets paid leave. It sits
 * alongside the balance, for payroll.
 */
export const LeaveBalance = defineModel({
  table: 'dbo.vwLeaveBalance',
  columns: {
    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },
    leaveTypeId: { column: 'LeaveTypeId', type: sql.BigInt },
    leaveCycleId: { column: 'LeaveCycleId', type: sql.BigInt },

    accruedDays: { column: 'AccruedDays', type: sql.Decimal(10, 2) },
    consumedDays: { column: 'ConsumedDays', type: sql.Decimal(10, 2) },
    lwpDaysConsumed: { column: 'LWPDaysConsumed', type: sql.Decimal(10, 2) },
    heldDays: { column: 'HeldDays', type: sql.Decimal(10, 2) },
    balanceDays: { column: 'BalanceDays', type: sql.Decimal(10, 2) },
    // Balance minus holds. What the apply screen must check.
    availableDays: { column: 'AvailableDays', type: sql.Decimal(10, 2) },

    lastEntryAt: { column: 'LastEntryAt', type: sql.DateTime2, nullable: true },
  },
});

/* ------------------------------------------------------------------------- */

export const LEAVE_REQUEST_PUBLIC_PROPS = Object.freeze([
  'leaveRequestId',
  'employeeDetailId',
  'leaveTypeId',
  'leaveCycleId',
  'fromDate',
  'toDate',
  'dayPart',
  'totalDays',
  'sandwichDays',
  'paidDays',
  'lwpDays',
  'reason',
  'contactDuringLeave',
  'documentUrl',
  'status',
  'currentApproverId',
  'decidedAt',
  'cancelledAt',
  'cancelReason',
  'createdAt',
  'modifiedAt',
]);

export const LEAVE_REQUEST_DAY_PUBLIC_PROPS = Object.freeze([
  'leaveRequestDayId',
  'leaveRequestId',
  'leaveDate',
  'dayType',
  'dayPart',
  'isLWP',
  'chargedDays',
]);

export const LEAVE_APPROVAL_PUBLIC_PROPS = Object.freeze([
  'leaveApprovalId',
  'leaveRequestId',
  'approvalLevel',
  'approverId',
  'approverRole',
  'action',
  'remarks',
  'actedAt',
]);

export const LEAVE_LEDGER_PUBLIC_PROPS = Object.freeze([
  'leaveLedgerId',
  'employeeDetailId',
  'leaveTypeId',
  'leaveCycleId',
  'entryType',
  'days',
  'isHold',
  'sourceType',
  'sourceId',
  'effectiveDate',
  'remarks',
  'createdAt',
]);

export const LEAVE_BALANCE_PUBLIC_PROPS = Object.freeze([
  'employeeDetailId',
  'leaveTypeId',
  'leaveCycleId',
  'accruedDays',
  'consumedDays',
  'lwpDaysConsumed',
  'heldDays',
  'balanceDays',
  'availableDays',
]);

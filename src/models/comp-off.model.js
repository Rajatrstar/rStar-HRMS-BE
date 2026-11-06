/**
 * dbo.tblCompOffRequest and dbo.tblCompOffCredit, plus
 * dbo.tblEmploymentStatusHistory.
 *
 * Mirrors db/migrations/020_comp_off.sql and the history table from
 * db/migrations/014_employment_confirmation.sql. The two live together
 * because both are small, append-ish records of a human decision and
 * neither earns a file of its own.
 *
 * COMP-OFF IS TWO TABLES BECAUSE IT IS TWO ACTS. The HR document is
 * explicit: a comp-off is never credited merely because attendance exists
 * on a weekend. The manager approves that the work happened; HR then
 * credits a day, by hand. With one table and a Status of APPROVED those
 * two become the same fact, and the balance is granted the moment the
 * manager clicks - which is what the document forbids.
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

/** dbo.tblCompOffRequest - what the manager approves. */
export const CompOffRequest = defineModel({
  table: 'dbo.tblCompOffRequest',
  columns: {
    compOffRequestId: { column: 'CompOffRequestId', type: sql.BigInt, identity: true },

    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },

    // The day that was WORKED. Not the day off being asked for - that
    // comes later, as an ordinary leave request against the comp-off type.
    workedOnDate: { column: 'WorkedOnDate', type: sql.Date },

    // Nullable: the US team and anyone exempt from punching have no row to
    // point at, and the HR document does not require one.
    attendanceDayId: { column: 'AttendanceDayId', type: sql.BigInt, nullable: true },
    workedMinutes: { column: 'WorkedMinutes', type: sql.Int, nullable: true },

    reason: { column: 'Reason', type: sql.NVarChar(500) },

    // COMP_OFF_REQUEST_STATUS in src/enums/leave.enum.js.
    // APPROVED_AWAITING_CREDIT is the state that makes HR's queue visible.
    status: { column: 'Status', type: sql.NVarChar(30) },

    approvedBy: { column: 'ApprovedBy', type: sql.BigInt, nullable: true },
    approvedAt: { column: 'ApprovedAt', type: sql.DateTime2, nullable: true },
    approverRemarks: { column: 'ApproverRemarks', type: sql.NVarChar(1000), nullable: true },

    ...auditColumns(),
  },
});

/** dbo.tblCompOffCredit - what HR creates, by hand. */
export const CompOffCredit = defineModel({
  table: 'dbo.tblCompOffCredit',
  columns: {
    compOffCreditId: { column: 'CompOffCreditId', type: sql.BigInt, identity: true },

    compOffRequestId: { column: 'CompOffRequestId', type: sql.BigInt },
    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },

    // 1.00 per the HR document. A figure, so a half day for a half
    // Saturday is a decision rather than a schema change.
    days: { column: 'Days', type: sql.Decimal(3, 2) },

    // NOT NULL. The whole reason this table exists is that the credit is a
    // human act - the service refuses to write it on anyone's behalf.
    creditedBy: { column: 'CreditedBy', type: sql.BigInt },
    creditedAt: { column: 'CreditedAt', type: sql.DateTime2 },

    // NULL until HR confirms a validity period - section 28. NULL means it
    // does not lapse, which is the safe reading of silence.
    expiresOn: { column: 'ExpiresOn', type: sql.Date, nullable: true },

    /*
      Denormalised. The ledger remains the authority on the total, but
      comp-offs expire INDIVIDUALLY and a balance alone cannot say when -
      so the apply screen needs per-credit remainders to show "2 comp-offs,
      expiring 14 March and 2 April".
    */
    remainingDays: { column: 'RemainingDays', type: sql.Decimal(3, 2) },

    // COMP_OFF_CREDIT_STATUS in src/enums/leave.enum.js.
    status: { column: 'Status', type: sql.NVarChar(20) },
    remarks: { column: 'Remarks', type: sql.NVarChar(500), nullable: true },

    ...auditColumns(),
  },
});

/**
 * dbo.tblEmploymentStatusHistory - APPEND-ONLY.
 *
 * No modifiedBy, no modifiedAt, no deletedAt. The whole value of the table
 * is that a row never changes after it is written: it is the answer to
 * "why is this person still on probation in month seven", and an editable
 * answer is not an answer.
 *
 * Both fromStatus and toStatus are recorded rather than just the new one,
 * so a reversal is visible as itself rather than inferred from the row
 * before it.
 */
export const EmploymentStatusHistory = defineModel({
  table: 'dbo.tblEmploymentStatusHistory',
  columns: {
    employmentStatusHistoryId: {
      column: 'EmploymentStatusHistoryId',
      type: sql.BigInt,
      identity: true,
    },

    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },

    // CONFIRMATION_STATUS in src/enums/leave.enum.js.
    fromStatus: { column: 'FromStatus', type: sql.NVarChar(20) },
    toStatus: { column: 'ToStatus', type: sql.NVarChar(20) },

    oldProbationEndDate: { column: 'OldProbationEndDate', type: sql.Date, nullable: true },
    newProbationEndDate: { column: 'NewProbationEndDate', type: sql.Date, nullable: true },

    // CONFIRMATION_CHANGE_TYPE. AUTO_CONFIRM identifies the nightly job.
    changeType: { column: 'ChangeType', type: sql.NVarChar(20) },

    // NOT NULL, including for the job - a nullable reason becomes an empty
    // one, and then the table answers "when" but never "why".
    reason: { column: 'Reason', type: sql.NVarChar(500) },

    changedBy: { column: 'ChangedBy', type: sql.BigInt, nullable: true },
    changedAt: { column: 'ChangedAt', type: sql.DateTime2 },
  },
});

/* ------------------------------------------------------------------------- */

export const COMP_OFF_REQUEST_PUBLIC_PROPS = Object.freeze([
  'compOffRequestId',
  'employeeDetailId',
  'workedOnDate',
  'attendanceDayId',
  'workedMinutes',
  'reason',
  'status',
  'approvedBy',
  'approvedAt',
  'approverRemarks',
  'createdAt',
  'modifiedAt',
]);

export const COMP_OFF_CREDIT_PUBLIC_PROPS = Object.freeze([
  'compOffCreditId',
  'compOffRequestId',
  'employeeDetailId',
  'days',
  'creditedBy',
  'creditedAt',
  'expiresOn',
  'remainingDays',
  'status',
  'remarks',
]);

export const EMPLOYMENT_STATUS_HISTORY_PUBLIC_PROPS = Object.freeze([
  'employmentStatusHistoryId',
  'employeeDetailId',
  'fromStatus',
  'toStatus',
  'oldProbationEndDate',
  'newProbationEndDate',
  'changeType',
  'reason',
  'changedBy',
  'changedAt',
]);

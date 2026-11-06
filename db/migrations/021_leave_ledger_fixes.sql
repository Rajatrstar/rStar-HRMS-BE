/*
  Two corrections to the leave ledger, both found by testing 019 against a
  real database before anybody used it.

  WHY THIS IS A NEW FILE RATHER THAN AN EDIT TO 019. A migration is recorded
  in dbo._Migrations BY FILENAME, so once 019 has run anywhere, editing it
  changes nothing for that database and silently produces two different
  schemas from the same file - the exact failure the numbered-file
  discipline exists to prevent. 019 had already been applied by a running
  dev server with DB_AUTO_MIGRATE on, so it stays as it was written and the
  correction lives here.

  Both statements below are idempotent and both are safe on a database that
  never had the broken version, so a fresh database and the dev one end up
  identical.

  ---------------------------------------------------------------------------
  1 - CK_tblLeaveLedger_HoldIsHold was too narrow.

  The flag marks a row as living in the HELD bucket rather than in the
  balance, and exactly TWO kinds of row belong there: the hold itself, and
  the REVERSAL that cancels it.

  The reversal needs the flag for the arithmetic to work. vwLeaveBalance
  computes HeldDays as the sum of the flagged rows, so a hold of +3 and its
  reversal of -3 must both be flagged to net to zero held. The original
  constraint allowed only EntryType = 'HOLD', which made approving ANY
  leave request fail outright:

      The INSERT statement conflicted with the CHECK constraint
      "CK_tblLeaveLedger_HoldIsHold"

  Had the reversal simply been written without the flag instead, the hold
  would never have cleared: the employee's balance would read correctly
  while their AVAILABLE days stayed short by the length of every leave they
  had ever taken - which is the worse version of the same bug, because
  nothing would have failed.

  ---------------------------------------------------------------------------
  2 - vwLeaveBalance.LWPDaysConsumed used ABS().

  An LWP_DEBIT carries negative days like any other debit, so negating the
  signed sum reads as "4 days taken without pay". ABS() gives the same
  answer for a debit and the WRONG one for the row that undoes one:
  withdrawing an approved request writes a positive LWP_DEBIT to cancel the
  original, and under ABS() that counted as two further unpaid days rather
  than clearing them - sending payroll a deduction for leave nobody took.

  Nothing else in the view changes, so no model or caller is affected.
*/

/* -------------------------------------------------------------------------
   1 - widen the constraint.

   Dropped and re-added rather than altered: SQL Server has no ALTER for a
   CHECK's expression. Guarded on both sides so this runs cleanly whether or
   not the old constraint is there.
   ------------------------------------------------------------------------- */

IF EXISTS (
    SELECT 1 FROM sys.check_constraints WHERE name = 'CK_tblLeaveLedger_HoldIsHold'
)
BEGIN
    ALTER TABLE dbo.tblLeaveLedger DROP CONSTRAINT CK_tblLeaveLedger_HoldIsHold;
END;
GO

ALTER TABLE dbo.tblLeaveLedger WITH CHECK
    ADD CONSTRAINT CK_tblLeaveLedger_HoldIsHold
        CHECK (IsHold = 0 OR EntryType IN ('HOLD', 'REVERSAL'));
GO

/* -------------------------------------------------------------------------
   2 - replace the view.

   CREATE OR ALTER, alone in its own batch because CREATE VIEW must be the
   first statement in one. The column list is unchanged - only the
   LWPDaysConsumed expression differs - so dbo.vwLeaveBalance still matches
   the LeaveBalance model and `npm run db:verify` still passes.
   ------------------------------------------------------------------------- */
GO
CREATE OR ALTER VIEW dbo.vwLeaveBalance
AS
SELECT
    l.EmployeeDetailId,
    l.LeaveTypeId,
    l.LeaveCycleId,

    -- Grants only.
    SUM(CASE WHEN l.IsHold = 0
              AND l.EntryType IN ('OPENING', 'ACCRUAL', 'CONFIRMATION_RELEASE',
                                  'COMP_OFF_CREDIT')
              AND l.Days > 0
             THEN l.Days ELSE 0 END)                       AS AccruedDays,

    -- Spends, flipped to a positive number: "7.5 days used" reads better
    -- than "-7.5 days used" on every screen that shows it.
    SUM(CASE WHEN l.IsHold = 0 AND l.EntryType = 'DEBIT'
             THEN -l.Days ELSE 0 END)                      AS ConsumedDays,

    -- Unpaid days, negated rather than ABS()'d - see the header. Never
    -- offsets a paid balance; it is a separate figure, for payroll.
    -SUM(CASE WHEN l.EntryType = 'LWP_DEBIT'
              THEN l.Days ELSE 0 END)                      AS LWPDaysConsumed,

    -- Applied for, not yet decided. A hold and the reversal that clears it
    -- are both flagged, so an approved request nets to zero here.
    SUM(CASE WHEN l.IsHold = 1 THEN l.Days ELSE 0 END)     AS HeldDays,

    -- The ledger's own total. Holds are not in it: they have not been spent.
    SUM(CASE WHEN l.IsHold = 0 AND l.EntryType <> 'LWP_DEBIT'
             THEN l.Days ELSE 0 END)                       AS BalanceDays,

    -- What may actually be applied for today.
    SUM(CASE WHEN l.IsHold = 0 AND l.EntryType <> 'LWP_DEBIT'
             THEN l.Days ELSE 0 END)
  - SUM(CASE WHEN l.IsHold = 1 THEN l.Days ELSE 0 END)     AS AvailableDays,

    MAX(l.CreatedAt)                                       AS LastEntryAt
FROM dbo.tblLeaveLedger AS l
GROUP BY l.EmployeeDetailId, l.LeaveTypeId, l.LeaveCycleId;
GO

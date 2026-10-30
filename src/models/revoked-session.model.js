/**
 * dbo.tblRevokedSession - the sessions logout has killed.
 *
 * Mirrors db/migrations/006_revoked_session.sql. One row per logout, holding
 * the `sid` both tokens of that login carry; src/middlewares/auth.middleware.js
 * refuses any token whose session appears here.
 *
 * Rows are disposable: once ExpiresAt has passed, the token's own signature
 * check does the job and the row is purged.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

export const RevokedSession = defineModel({
  table: 'dbo.tblRevokedSession',
  columns: {
    revokedSessionId: { column: 'RevokedSessionId', type: sql.BigInt, identity: true },

    // The `sid` claim shared by the access and refresh token of one login.
    sessionId: { column: 'SessionId', type: sql.UniqueIdentifier },

    // Audit only - the check never filters on this.
    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },

    // When the longest-lived token naming this session expires on its own.
    expiresAt: { column: 'ExpiresAt', type: sql.DateTime2 },
    revokedAt: { column: 'RevokedAt', type: sql.DateTime2 },
  },
});

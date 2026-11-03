/**
 * dbo.tblErrorLog - failures the server did not mean to have.
 *
 * Mirrors db/migrations/012_error_log.sql. Append-only: written by
 * src/services/error-log.service.js, emptied only by its retention purge.
 * No DeletedAt, so no read path needs the usual filter.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

export const ErrorLog = defineModel({
  table: 'dbo.tblErrorLog',
  columns: {
    errorLogId: { column: 'ErrorLogId', type: sql.BigInt, identity: true },
    requestId: { column: 'RequestId', type: sql.UniqueIdentifier, nullable: true },
    occurredAt: { column: 'OccurredAt', type: sql.DateTime2 },

    source: { column: 'Source', type: sql.NVarChar(20) },
    severity: { column: 'Severity', type: sql.NVarChar(10) },

    httpMethod: { column: 'HttpMethod', type: sql.NVarChar(10), nullable: true },
    routePattern: { column: 'RoutePattern', type: sql.NVarChar(300), nullable: true },
    url: { column: 'Url', type: sql.NVarChar(1000), nullable: true },
    statusCode: { column: 'StatusCode', type: sql.SmallInt, nullable: true },
    errorCode: { column: 'ErrorCode', type: sql.NVarChar(100), nullable: true },

    errorName: { column: 'ErrorName', type: sql.NVarChar(200), nullable: true },
    message: { column: 'Message', type: sql.NVarChar(2000), nullable: true },
    stackTrace: { column: 'StackTrace', type: sql.NVarChar(sql.MAX), nullable: true },
    sqlErrorNumber: { column: 'SqlErrorNumber', type: sql.Int, nullable: true },

    requestBody: { column: 'RequestBody', type: sql.NVarChar(sql.MAX), nullable: true },

    // Audit only - no FK, so the row outlives the employee.
    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt, nullable: true },
    ipAddress: { column: 'IpAddress', type: sql.NVarChar(45), nullable: true },
    userAgent: { column: 'UserAgent', type: sql.NVarChar(500), nullable: true },
    durationMs: { column: 'DurationMs', type: sql.Int, nullable: true },

    serverName: { column: 'ServerName', type: sql.NVarChar(100), nullable: true },
    environment: { column: 'Environment', type: sql.NVarChar(20), nullable: true },
    fingerprint: { column: 'Fingerprint', type: sql.Char(64), nullable: true },

    isResolved: { column: 'IsResolved', type: sql.Bit },
    resolvedBy: { column: 'ResolvedBy', type: sql.BigInt, nullable: true },
    resolvedAt: { column: 'ResolvedAt', type: sql.DateTime2, nullable: true },
    resolutionNote: { column: 'ResolutionNote', type: sql.NVarChar(1000), nullable: true },
  },
});

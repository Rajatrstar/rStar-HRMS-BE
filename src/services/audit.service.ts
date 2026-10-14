import { prisma } from '../config/db.js';
import type { AuditAction } from '../enums.js';
import { getLogger } from '../config/logger.js';

export interface AuditEntry {
  action: AuditAction;
  entity: string;
  entityId?: string | undefined;
  actorId?: string | undefined;
  ipAddress?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Appends to the audit trail.
 *
 * Never throws: an audit write failing must not turn a successful operation into a 500.
 * It is logged at error level instead, so the gap is visible in log monitoring.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        actorId: entry.actorId ?? null,
        ipAddress: entry.ipAddress ?? null,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      },
    });
  } catch (error) {
    getLogger().error({ err: error, action: entry.action }, 'Failed to write audit log');
  }
}

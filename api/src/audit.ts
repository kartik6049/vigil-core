import type { Queryable } from './db.js';

export interface AuditEntry {
  actorId: string | null;
  action: string; // e.g. 'case.claim', 'case.block', 'rule.update'
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Appends one audit row. Always call it with the same client that performs the
 * change, so the audit row commits or rolls back together with it.
 */
export async function writeAudit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    `insert into audit_log (actor_id, action, entity_type, entity_id, before, after)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      e.actorId,
      e.action,
      e.entityType,
      e.entityId,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
    ],
  );
}

import { randomUUID } from 'node:crypto';
import { enqueueOutbox } from '@machvon/db';
import type { ApprovalEffects, AuditWriter, TenantTx } from '@machvon/db';

/** The audit trail and the outbox of work done outside a command (a callback, a pass of the worker), under the membership that does it, in the transaction that does it. */
export function effectsOf(audit: Pick<AuditWriter, 'recordInTx'>, tx: TenantTx, actor: string): ApprovalEffects {
  const correlationId = randomUUID();
  return {
    actor,
    audit: (entry) => audit.recordInTx(tx, actor, { ...entry, correlationId, requestId: randomUUID() }),
    emit: (event) => enqueueOutbox(tx, { ...event, correlationId }),
  };
}

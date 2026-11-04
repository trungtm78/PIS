import { randomUUID } from 'node:crypto';
import { SupportAccessStore, enqueueOutbox } from '@machvon/db';
import type { ApprovalEffects, AuditWriter, SupportPassResult, TenantTx } from '@machvon/db';

/**
 * The job `support-access-lifecycle` (SAS.md 3.9, the grant lapses to Expired by a job every minute): every minute, for the tenant it is given, an approved grant whose first instant has come is put in force, one whose window has ended
 * is Expired, and a request nobody decided on within a week lapses. The guard does not depend on it: it judges the window of the grant on every request; the pass makes the record say what the guard already does,
 * and gives the gauge of the grants in force. The work is `SupportAccessStore.sweep`; this class gives it the audit trail and the outbox of the pass, under the worker's membership. The pass is idempotent.
 */
export class SupportAccessJob {
  private readonly store = new SupportAccessStore();

  constructor(private readonly audit: Pick<AuditWriter, 'recordInTx'>) {}

  async run(tx: TenantTx, actor: string, now: Date): Promise<SupportPassResult> {
    const correlationId = randomUUID();
    const effects: ApprovalEffects = {
      actor,
      audit: (entry) => this.audit.recordInTx(tx, actor, { ...entry, correlationId, requestId: randomUUID() }),
      emit: (event) => enqueueOutbox(tx, { ...event, correlationId }),
    };
    return this.store.sweep(tx, effects, now);
  }
}

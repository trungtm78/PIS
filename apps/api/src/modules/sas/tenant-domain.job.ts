import { randomUUID } from 'node:crypto';
import { TenantDomainStore, enqueueOutbox } from '@machvon/db';
import type { ApprovalEffects, AuditWriter, DomainPassResult, DomainPorts, TenantTx } from '@machvon/db';

/**
 * The job `tenant-domain` (SAS.md 3.4, "recheck hằng tuần và job hết hạn TLS"): every five minutes, for the tenant it is given, a Verified domain gets its certificate and becomes Active, an Active custom domain is looked
 * at again when its week is up (the proof gone makes it Failed, so it no longer chooses the tenant) and a certificate with 14 days left is renewed. The work is `TenantDomainStore.sweep`; this class gives it the audit trail
 * and the outbox of the pass, under the worker's membership, through the control role acting as the tenant. The pass is idempotent.
 */
export class TenantDomainJob {
  private readonly store = new TenantDomainStore();

  constructor(
    private readonly audit: Pick<AuditWriter, 'recordInTx'>,
    private readonly ports: DomainPorts,
  ) {}

  async run(tx: TenantTx, actor: string, now: Date): Promise<DomainPassResult> {
    const correlationId = randomUUID();
    const effects: ApprovalEffects = {
      actor,
      audit: (entry) => this.audit.recordInTx(tx, actor, { ...entry, correlationId, requestId: randomUUID() }),
      emit: (event) => enqueueOutbox(tx, { ...event, correlationId }),
    };
    return this.store.sweep(tx, effects, this.ports, now);
  }
}

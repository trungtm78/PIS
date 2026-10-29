import { randomUUID } from 'node:crypto';
import { DelegationStore, RoleStore, enqueueOutbox } from '@machvon/db';
import type { AuditWriter } from '@machvon/db';
import type { ApprovalEffects, DelegationPassResult, TenantTx } from '@machvon/db';
import { NOOP_METRICS } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { delegatorStillHolds } from './delegation.controller';

/** The counter of the delegations that ended because the source of their authority did. */
export const DELEGATION_SOURCE_ENDED_METRIC = 'delegation_source_ended_total';

/**
 * The job `delegation-lifecycle` (ADM 3.5, "hết hạn delegation/grant mỗi phút"): every minute a delegation whose first instant has come is put in force, one whose window has ended is Ended, and one whose delegator no longer
 * holds what it passed on (the source grant was revoked or lapsed, the membership is no longer active) is Ended at once, so a delegate never keeps an authority their delegator lost. The work is `DelegationStore.sweep`; this class
 * gives it the audit trail and the outbox of the pass, under the worker's membership. The pass is idempotent.
 */
export class DelegationLifecycleJob {
  private readonly store = new DelegationStore();
  private readonly roles = new RoleStore();
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;
  private readonly metrics: MetricsSink;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>, options: { metrics?: MetricsSink } = {}) {
    this.audit = audit;
    this.metrics = options.metrics ?? NOOP_METRICS;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<DelegationPassResult> {
    const correlationId = randomUUID();
    const effects: ApprovalEffects = {
      actor,
      audit: (entry) => this.audit.recordInTx(tx, actor, { ...entry, correlationId, requestId: randomUUID() }),
      emit: (event) => enqueueOutbox(tx, { ...event, correlationId }),
    };
    const result = await this.store.sweep(tx, effects, now, (delegation) => delegatorStillHolds(tx, this.roles, delegation, now));
    for (let counted = 0; counted < result.sourceEnded; counted += 1) this.metrics.increment(DELEGATION_SOURCE_ENDED_METRIC);
    return result;
  }
}

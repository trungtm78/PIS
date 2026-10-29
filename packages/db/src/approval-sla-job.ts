import { randomUUID } from 'node:crypto';
import { NOOP_METRICS } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { ApprovalStore } from './approval-store.ts';
import type { ApprovalEffects, SlaSweepResult } from './approval-store.ts';
import type { AuditWriter } from './audit-writer.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

/** The counter of the tasks that passed their deadline (once for each task), and the gauges of the open tasks and of those past their deadline. */
export const APPROVAL_SLA_BREACH_METRIC = 'approval_sla_breach_total';
export const APPROVAL_OPEN_GAUGE = 'approval_task_open_total';
export const APPROVAL_OVERDUE_GAUGE = 'approval_task_overdue_total';

/**
 * The job `approval-sla` (ADM 3.7 item 4, ST-ADM-013): every 5 minutes, for the open approval tasks of a tenant, reminds at 80 percent of the working time to the deadline and does what the step says at the deadline (remind every
 * working day, escalate once, or expire). The work is `ApprovalStore.sweepSla`; this class gives it the audit trail and the outbox of the pass, under the worker's membership, and counts what it found. The pass is idempotent.
 */
export class ApprovalSlaJob {
  private readonly store = new ApprovalStore();
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;
  private readonly metrics: MetricsSink;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>, options: { metrics?: MetricsSink } = {}) {
    this.audit = audit;
    this.metrics = options.metrics ?? NOOP_METRICS;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<SlaSweepResult> {
    const correlationId = randomUUID();
    const effects: ApprovalEffects = {
      actor,
      audit: (entry) => this.audit.recordInTx(tx, actor, { ...entry, correlationId, requestId: randomUUID() }),
      emit: (event) => enqueueOutbox(tx, { ...event, correlationId }),
    };
    const result = await this.store.sweepSla(tx, effects, now);
    for (let counted = 0; counted < result.breached; counted += 1) this.metrics.increment(APPROVAL_SLA_BREACH_METRIC);
    return result;
  }
}

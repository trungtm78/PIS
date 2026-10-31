import { randomUUID } from 'node:crypto';
import { NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { AstEvaluationStore, EVALUATION_TRIGGER_RESOURCE } from './ast-evaluation-store.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

export const EVALUATION_DUE_EVENT = 'ast.evaluation.due.v1';
export const EVALUATION_DUE_METRIC = 'ast_evaluation_due_total';

export interface AstEvaluationDueSummary {
  fired: number;
}

/**
 * The triggers of evaluation that fall due (AST 3.4, UAT-AC394): a trigger that is SCHEDULED and whose day has come (the day in Vietnam) is fired, once, and `ast.evaluation.due.v1` tells MNE and the
 * one who set it. MNE does the evaluation itself. Running the pass again, or every hour, announces nothing twice.
 */
export class AstEvaluationDueJob {
  private readonly triggers = new AstEvaluationStore();

  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(audit: AuditWriter, metrics: MetricsSink = NOOP_METRICS) {
    this.audit = audit;
    this.metrics = metrics;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<AstEvaluationDueSummary> {
    const tenantId = (await tx.query<{ tenant_id: string }>("select nullif(current_setting('app.tenant_id', true), '') as tenant_id"))[0]?.tenant_id ?? '';
    const fired = await this.triggers.fireDue(tx, vietnamDateOf(now), now, actor);
    for (const trigger of fired) {
      const correlationId = randomUUID();
      await this.audit.recordInTx(tx, actor, {
        action: 'ast.evaluation_trigger_fired',
        resourceType: EVALUATION_TRIGGER_RESOURCE,
        resourceId: trigger.id,
        reason: 'evaluation_due',
        diff: { project_id: trigger.projectId, trigger_kind: trigger.triggerKind, handover_id: trigger.sourceHandoverId, due_on: trigger.dueOn, from_status: 'SCHEDULED', to_status: 'FIRED' },
        correlationId,
        requestId: correlationId,
      });
      const event = await enqueueOutbox(tx, {
        aggregateType: EVALUATION_TRIGGER_RESOURCE,
        aggregateId: trigger.id,
        aggregateVersion: trigger.version,
        type: EVALUATION_DUE_EVENT,
        schemaVersion: 1,
        payload: {
          tenant_id: tenantId,
          trigger_id: trigger.id,
          project_id: trigger.projectId,
          trigger_kind: trigger.triggerKind,
          handover_id: trigger.sourceHandoverId,
          due_on: trigger.dueOn,
          occurred_at: now.toISOString(),
          notification: {
            resource: { type: EVALUATION_TRIGGER_RESOURCE, id: trigger.id, ownerUnitId: trigger.ownerUnit.id, ownerUnitPath: trigger.ownerUnit.path, ...(trigger.investorUnit === null ? {} : { investorUnitId: trigger.investorUnit.id, investorUnitPath: trigger.investorUnit.path }), projectId: trigger.projectId },
            deepLink: `/ast/ast-07?project=${trigger.projectId}`,
            recipients: [trigger.recipientId],
          },
        },
        eventKey: `${EVALUATION_TRIGGER_RESOURCE}:${trigger.id}:due`,
        correlationId,
      });
      await this.triggers.announced(tx, trigger.id, event.id);
      this.metrics.increment(EVALUATION_DUE_METRIC);
    }
    return { fired: fired.length };
  }
}

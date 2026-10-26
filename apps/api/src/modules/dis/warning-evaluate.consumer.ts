import { randomUUID } from 'node:crypto';
import { AuditWriter, DIS_WARNING_OPEN_METRIC, DisWarningStore, WARNING_RESOURCE, WORKER_MEMBERSHIP_ID, consumeOnce, enqueueOutbox } from '@machvon/db';
import type { ConsumeSecurity, OutboxDelivery, TenantDatabase } from '@machvon/db';
import { DomainError, NOOP_METRICS, WARNING_SEVERITIES, asUuid } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';

export const DIS_WARNING_EVALUATE_CONSUMER = 'dis-warning-evaluate';
/** The event of the DIS module that a period snapshot was frozen (DIS section 9). */
const SNAPSHOT_FROZEN_EVENT = 'snapshot.frozen.v1';

export interface WarningEvaluateConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
  clock?: () => Date;
  metrics?: MetricsSink;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'payload'>;

/**
 * The job `dis.warning-evaluate` (ST-DIS-012, DIS 3 F7): when a close snapshot is frozen the published rules in force are evaluated over it. A violation opens one warning (`warning.opened.v1`, which carries
 * `auto_explanation` so that PRJ can ask for an explanation), the warning that is open already is updated with the figure of the new snapshot, and one whose violation is gone is closed as AUTO_CLEARED
 * (`warning.resolved.v1`). The inbox row of the delivery is written with the warnings, so a redelivery after a crash is a counted duplicate and opens nothing twice.
 */
export class WarningEvaluateConsumer {
  private readonly store = new DisWarningStore();
  private readonly audit: AuditWriter;
  private readonly clock: () => Date;
  private readonly metrics: MetricsSink;

  constructor(private readonly deps: WarningEvaluateConsumerDeps) {
    this.audit = new AuditWriter(deps.database);
    this.clock = deps.clock ?? ((): Date => new Date());
    this.metrics = deps.metrics ?? NOOP_METRICS;
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (delivery.type !== SNAPSHOT_FROZEN_EVENT) return 'ignored';
    if (delivery.payload.tenant_id !== undefined && asUuid(delivery.payload.tenant_id) !== delivery.tenantId) return 'ignored';
    const snapshotId = asUuid(delivery.payload.snapshot_id);
    if (snapshotId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'payload');
    const now = this.clock();
    let counts: Array<{ severity: string; count: number }> = [];
    const outcome = await consumeOnce(
      this.deps.database,
      delivery,
      DIS_WARNING_EVALUATE_CONSUMER,
      async (tx) => {
        const done = await this.store.evaluate(tx, snapshotId, now, WORKER_MEMBERSHIP_ID);
        const correlationId = randomUUID();
        for (const warning of done.opened) {
          await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
            action: 'dis.warning_opened',
            resourceType: WARNING_RESOURCE,
            resourceId: warning.id,
            diff: { rule_code: warning.ruleCode, severity: warning.severity, project_id: warning.projectId, dedupe_key: warning.dedupeKey, snapshot_id: snapshotId, event_id: delivery.id },
            correlationId,
            requestId: randomUUID(),
          });
          await enqueueOutbox(tx, {
            aggregateType: WARNING_RESOURCE,
            aggregateId: warning.id,
            aggregateVersion: 1,
            type: 'warning.opened.v1',
            schemaVersion: 1,
            payload: {
              tenant_id: delivery.tenantId,
              occurred_at: now.toISOString(),
              warning_id: warning.id,
              rule_code: warning.ruleCode,
              severity: warning.severity,
              subject: { project_id: warning.projectId, unit_id: warning.unitId },
              auto_explanation: warning.autoExplanation,
              explanation_due_days: warning.explanationDueDays,
              dedupe_key: warning.dedupeKey,
              snapshot_id: snapshotId,
              observed: warning.observed,
            },
            eventKey: `${WARNING_RESOURCE}:${warning.id}:opened`,
            correlationId,
          });
        }
        for (const warning of done.cleared) {
          await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
            action: 'dis.warning_auto_cleared',
            resourceType: WARNING_RESOURCE,
            resourceId: warning.id,
            diff: { rule_code: warning.ruleCode, dedupe_key: warning.dedupeKey, snapshot_id: snapshotId, event_id: delivery.id },
            correlationId,
            requestId: randomUUID(),
          });
          await enqueueOutbox(tx, {
            aggregateType: WARNING_RESOURCE,
            aggregateId: warning.id,
            aggregateVersion: 2,
            type: 'warning.resolved.v1',
            schemaVersion: 1,
            payload: { tenant_id: delivery.tenantId, occurred_at: now.toISOString(), warning_id: warning.id, rule_code: warning.ruleCode, resolution: 'AUTO_CLEARED', project_id: warning.projectId, snapshot_id: snapshotId },
            eventKey: `${WARNING_RESOURCE}:${warning.id}:closed`,
            correlationId,
          });
        }
        counts = await this.store.openCounts(tx);
      },
      this.deps.security,
    );
    if (outcome === 'processed') for (const severity of WARNING_SEVERITIES) this.metrics.gauge(DIS_WARNING_OPEN_METRIC, counts.find((item) => item.severity === severity)?.count ?? 0, { severity });
    return outcome;
  }
}

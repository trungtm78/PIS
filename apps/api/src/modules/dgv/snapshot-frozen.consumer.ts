import { randomUUID } from 'node:crypto';
import { AuditWriter, DgvQualityRunStore, WORKER_MEMBERSHIP_ID, consumeOnce } from '@machvon/db';
import type { ConsumeSecurity, OutboxDelivery, TenantDatabase } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';

export const DGV_SNAPSHOT_FROZEN_CONSUMER = 'dgv-snapshot-frozen';
/** The event of the DIS module that a period snapshot was frozen (DIS section 9). */
export const SNAPSHOT_FROZEN_EVENT = 'snapshot.frozen.v1';

export interface SnapshotFrozenConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'payload'>;

/**
 * The system consumer of `snapshot.frozen.v1` (ST-DGV-002, DGV 3.3 F3): the quality rules run when a snapshot freezes. For every dataset of the
 * producing module that has approved rules a run is requested against that snapshot, once, however often the event is delivered; the run itself
 * is executed by the quality job. The inbox row of the delivery is written with the requests, so a redelivery after a crash is a counted duplicate.
 */
export class SnapshotFrozenConsumer {
  private readonly runs = new DgvQualityRunStore();
  private readonly audit: AuditWriter;

  constructor(private readonly deps: SnapshotFrozenConsumerDeps) {
    this.audit = new AuditWriter(deps.database);
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (delivery.type !== SNAPSHOT_FROZEN_EVENT) return 'ignored';
    // The payload may name the tenant too; a delivery whose payload disagrees with its signed tenant is not ours to act on.
    if (delivery.payload.tenant_id !== undefined && asUuid(delivery.payload.tenant_id) !== delivery.tenantId) return 'ignored';
    const snapshotId = asUuid(delivery.payload.snapshot_id);
    // An event that does not carry the snapshot cannot be acted on, and retrying it would not help.
    if (snapshotId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'payload');
    return consumeOnce(
      this.deps.database,
      delivery,
      DGV_SNAPSHOT_FROZEN_CONSUMER,
      async (tx) => {
        const started = await this.runs.requestForFrozenSnapshot(tx, snapshotId, WORKER_MEMBERSHIP_ID);
        const correlationId = randomUUID();
        for (const run of started) {
          await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
            action: 'dgv.quality_run_requested',
            resourceType: 'quality_run',
            resourceId: run.id,
            diff: { dataset_id: run.datasetId, snapshot_id: run.snapshotId, trigger: run.trigger, rule_count: run.ruleCount, event_id: delivery.id },
            correlationId,
            requestId: randomUUID(),
          });
        }
      },
      this.deps.security,
    );
  }
}

import { randomUUID } from 'node:crypto';
import { AuditWriter, DisMilestoneStore, MILESTONE_RESOURCE, WORKER_MEMBERSHIP_ID, consumeOnce, milestoneRecord } from '@machvon/db';
import type { ConsumeSecurity, OutboxDelivery, TenantDatabase } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';

export const DIS_MILESTONE_FORECAST_CONSUMER = 'dis-milestone-forecast';
/** The event of the DIS module that a period snapshot was frozen (DIS section 9). */
const SNAPSHOT_FROZEN_EVENT = 'snapshot.frozen.v1';

export interface MilestoneForecastConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'payload'>;

/**
 * The job `dis.milestone-forecast` (G1-16): when a snapshot is frozen, every investor unit is judged against every directive milestone of the rule in force and the vintages are kept. The inbox row of the
 * delivery is written with the vintages, so a redelivery after a crash is a counted duplicate, and a snapshot that was judged already is left alone.
 */
export class MilestoneForecastConsumer {
  private readonly milestones = new DisMilestoneStore();
  private readonly audit: AuditWriter;

  constructor(private readonly deps: MilestoneForecastConsumerDeps) {
    this.audit = new AuditWriter(deps.database);
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (delivery.type !== SNAPSHOT_FROZEN_EVENT) return 'ignored';
    if (delivery.payload.tenant_id !== undefined && asUuid(delivery.payload.tenant_id) !== delivery.tenantId) return 'ignored';
    const snapshotId = asUuid(delivery.payload.snapshot_id);
    if (snapshotId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'payload');
    return consumeOnce(
      this.deps.database,
      delivery,
      DIS_MILESTONE_FORECAST_CONSUMER,
      async (tx) => {
        const done = await this.milestones.record(tx, snapshotId, WORKER_MEMBERSHIP_ID, new Date());
        if (done.outcome === 'ALREADY_RECORDED') return;
        await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
          ...milestoneRecord(done, { event_id: delivery.id }),
          resourceType: MILESTONE_RESOURCE,
          correlationId: randomUUID(),
          requestId: randomUUID(),
        });
      },
      this.deps.security,
    );
  }
}

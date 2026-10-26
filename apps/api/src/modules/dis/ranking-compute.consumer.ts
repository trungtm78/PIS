import { randomUUID } from 'node:crypto';
import { AuditWriter, DisRankingStore, RANKING_RESOURCE, WORKER_MEMBERSHIP_ID, consumeOnce } from '@machvon/db';
import type { ConsumeSecurity, OutboxDelivery, TenantDatabase } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';

export const DIS_RANKING_COMPUTE_CONSUMER = 'dis-ranking-compute';
/** The event of the DIS module that a period snapshot was frozen (DIS section 9). */
const SNAPSHOT_FROZEN_EVENT = 'snapshot.frozen.v1';

export interface RankingComputeConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'payload'>;

/**
 * The job `dis.ranking-compute` (ST-DIS-013, DIS 3 F8): when a close snapshot is frozen the units of each comparison group are ranked, for each denominator, and the ranking is kept. The inbox row of the
 * delivery is written with the ranking, so a redelivery after a crash is a counted duplicate, and a snapshot that has a ranking already is left alone.
 */
export class RankingComputeConsumer {
  private readonly rankings = new DisRankingStore();
  private readonly audit: AuditWriter;

  constructor(private readonly deps: RankingComputeConsumerDeps) {
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
      DIS_RANKING_COMPUTE_CONSUMER,
      async (tx) => {
        const done = await this.rankings.compute(tx, snapshotId);
        if (done.skipped !== undefined) return;
        await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
          action: 'dis.ranking_computed',
          resourceType: RANKING_RESOURCE,
          resourceId: snapshotId,
          diff: { snapshot_id: snapshotId, groups: done.groups, ranked: done.ranked, excluded: done.excluded, event_id: delivery.id },
          correlationId: randomUUID(),
          requestId: randomUUID(),
        });
      },
      this.deps.security,
    );
  }
}

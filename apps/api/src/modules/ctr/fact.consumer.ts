import { randomUUID } from 'node:crypto';
import { AuditWriter, BiDatasetStore, CtrFactStore, WORKER_MEMBERSHIP_ID, consumeOnce, enqueueOutbox } from '@machvon/db';
import type { ConsumeSecurity, OutboxDelivery, TenantDatabase } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import { frozenEventOf } from '../bi/dataset.controller';

export const CTR_FACT_CONSUMER = 'ctr-fact-snapshot';
/** The event of DIS that a period snapshot was frozen (DIS section 9). */
const SNAPSHOT_FROZEN_EVENT = 'snapshot.frozen.v1';

export interface ContractFactConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'payload'>;

/**
 * The consumer that freezes the contract fact with a period (CA-1, part 2; R16, R17). When DIS freezes a close snapshot, the fact of the contracts of the same cut-off day is frozen with it (revision 1 for a
 * period, the next one when DIS freezes the period again, saying which it replaces) and the version of the dataset DS-CTR for that period is built from it. A snapshot that is not a frozen close snapshot (an ad hoc
 * one, one that a later freeze replaced) builds nothing. Delivering an event twice builds once (the inbox row is in the transaction of the work), and a second delivery for one snapshot finds the fact already there.
 */
export class ContractFactConsumer {
  private readonly facts = new CtrFactStore();
  private readonly datasets = new BiDatasetStore();
  private readonly audit: AuditWriter;

  constructor(private readonly deps: ContractFactConsumerDeps) {
    this.audit = new AuditWriter(deps.database);
  }

  get name(): string {
    return CTR_FACT_CONSUMER;
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (delivery.type !== SNAPSHOT_FROZEN_EVENT) return 'ignored';
    // The payload may name the tenant too; a delivery whose payload disagrees with its signed tenant is not ours to act on.
    if (delivery.payload.tenant_id !== undefined && asUuid(delivery.payload.tenant_id) !== delivery.tenantId) return 'ignored';
    const snapshotId = asUuid(delivery.payload.snapshot_id);
    if (snapshotId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'payload');
    return consumeOnce(
      this.deps.database,
      delivery,
      CTR_FACT_CONSUMER,
      async (tx) => {
        const correlationId = randomUUID();
        // Only the work is inside the savepoint: a snapshot that is not a frozen close snapshot is refused before anything is written, and a failure of the record of what was made is not hidden by a rollback.
        await tx.query('savepoint ctr_fact_snapshot');
        let built: Awaited<ReturnType<CtrFactStore['buildFor']>>;
        try {
          built = await this.facts.buildFor(tx, snapshotId, WORKER_MEMBERSHIP_ID);
        } catch (error) {
          await tx.query('rollback to savepoint ctr_fact_snapshot');
          if (!(error instanceof DomainError) || error.code !== 'SOURCE_SNAPSHOT_NOT_FROZEN') throw error;
          return;
        }
        await tx.query('release savepoint ctr_fact_snapshot');
        if (built.outcome === 'BUILT') {
          await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
            action: 'ctr.fact_snapshot_built',
            resourceType: 'contract_fact_snapshot',
            resourceId: built.snapshot.id,
            diff: {
              period_snapshot_id: snapshotId,
              period_id: built.snapshot.periodId,
              revision: built.snapshot.revision,
              supersedes_id: built.snapshot.supersedesId,
              cutoff_date: built.snapshot.cutoffDate,
              contract_count: built.snapshot.contractCount,
              row_count: built.snapshot.rowCount,
              payload_sha256: built.snapshot.payloadSha256,
              event_id: delivery.id,
            },
            correlationId,
            requestId: randomUUID(),
          });
        }
        const datasetId = await this.datasets.ensureContractDataset(tx, WORKER_MEMBERSHIP_ID);
        const result = await this.datasets.build(tx, { datasetId, sourceSnapshotId: snapshotId, asOfPeriod: undefined, actor: WORKER_MEMBERSHIP_ID });
        if (result.outcome !== 'BUILT') return;
        const dataset = await this.datasets.find(tx, datasetId);
        await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
          action: 'bi.dataset_version_built',
          resourceType: 'bi_dataset_version',
          resourceId: result.version.id,
          diff: { dataset_id: datasetId, as_of_period: result.version.asOfPeriod, snapshot_id: snapshotId, quality_badge: result.version.qualityBadge, excluded_quarantine_rows: result.version.excludedQuarantineRows, superseded_id: result.supersededId, event_id: delivery.id },
          correlationId,
          requestId: randomUUID(),
        });
        await enqueueOutbox(tx, { ...frozenEventOf(result.version, dataset?.datasetCode ?? '', new Date()), correlationId });
      },
      this.deps.security,
    );
  }
}

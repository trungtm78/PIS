import { randomUUID } from 'node:crypto';
import { AuditWriter, BiDatasetStore, WORKER_MEMBERSHIP_ID, consumeOnce, enqueueOutbox } from '@machvon/db';
import type { BuildResult, ConsumeSecurity, OutboxDelivery, TenantDatabase } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import { frozenEventOf } from './dataset.controller';

export const BI_DATASET_BUILD_CONSUMER = 'bi-dataset-build';
/** The event of DIS that a period snapshot was frozen (DIS section 9). */
const SNAPSHOT_FROZEN_EVENT = 'snapshot.frozen.v1';
/** The event of DGV that a quality run of a snapshot completed. */
const QUALITY_RUN_COMPLETED_EVENT = 'dgv.quality_run.completed.v1';

export interface DatasetBuildConsumerDeps {
  database: TenantDatabase;
  security: ConsumeSecurity;
}

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'payload'>;

/**
 * The consumer that builds the versions of the datasets (ST-BI-002, BI 3 F2). When DIS freezes a close snapshot the version of its period is built for every dataset that is made from period snapshots (the dataset
 * of the disbursement figures is created the first time), `NOT_ASSESSED` until DGV has run; when DGV completes a run of that snapshot the version is built again with the run linked and the rows it quarantined
 * counted, and the one before is superseded. A snapshot that is not a frozen close snapshot (an ad hoc one, one that a later freeze replaced) builds nothing. Delivering an event twice builds once (the inbox row is
 * in the transaction of the work), and two events for one content find the version already there; a build in progress is retried.
 */
export class DatasetBuildConsumer {
  private readonly datasets = new BiDatasetStore();
  private readonly audit: AuditWriter;

  constructor(private readonly deps: DatasetBuildConsumerDeps) {
    this.audit = new AuditWriter(deps.database);
  }

  get name(): string {
    return BI_DATASET_BUILD_CONSUMER;
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (delivery.type !== SNAPSHOT_FROZEN_EVENT && delivery.type !== QUALITY_RUN_COMPLETED_EVENT) return 'ignored';
    // The payload may name the tenant too; a delivery whose payload disagrees with its signed tenant is not ours to act on.
    if (delivery.payload.tenant_id !== undefined && asUuid(delivery.payload.tenant_id) !== delivery.tenantId) return 'ignored';
    const snapshotId = asUuid(delivery.payload.snapshot_id);
    if (snapshotId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'payload');
    return consumeOnce(
      this.deps.database,
      delivery,
      BI_DATASET_BUILD_CONSUMER,
      async (tx) => {
        // A freezing makes the dataset of the disbursement figures if the tenant has none; a quality run only completes the versions of datasets that exist.
        if (delivery.type === SNAPSHOT_FROZEN_EVENT) await this.datasets.ensureDisbursementDataset(tx, WORKER_MEMBERSHIP_ID);
        const correlationId = randomUUID();
        for (const datasetId of await this.datasets.snapshotDatasets(tx)) {
          // Each build is a savepoint: a snapshot that is not a frozen close snapshot is refused before anything is written, and the other datasets are still built. Only the build is inside it: a failure of the
          // record of what it made (the audit, the event) is not hidden by a rollback to a savepoint that is gone, and fails the delivery as itself.
          await tx.query('savepoint bi_dataset_build');
          let result: BuildResult;
          try {
            result = await this.datasets.build(tx, { datasetId, sourceSnapshotId: snapshotId, asOfPeriod: undefined, actor: WORKER_MEMBERSHIP_ID });
          } catch (error) {
            await tx.query('rollback to savepoint bi_dataset_build');
            if (!(error instanceof DomainError) || error.code !== 'SOURCE_SNAPSHOT_NOT_FROZEN') throw error;
            continue;
          }
          await tx.query('release savepoint bi_dataset_build');
          if (result.outcome !== 'BUILT') continue;
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
        }
      },
      this.deps.security,
    );
  }
}

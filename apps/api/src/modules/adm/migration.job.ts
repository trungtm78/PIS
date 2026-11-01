import { createHash, randomUUID } from 'node:crypto';
import { AdmMigrationStore, MIGRATION_BATCH_RESOURCE, enqueueOutbox } from '@machvon/db';
import type { AuditWriter, MigrationBatch, TenantDatabase, TenantTx } from '@machvon/db';
import { DomainError, MIGRATION_LOT_SIZE, MIGRATION_TABULAR_LIMITS, NOOP_METRICS, judgeMigrationFile, readTabularFile } from '@machvon/kernel';
import type { MetricsSink, TenantContext } from '@machvon/kernel';
import type { FileService } from '../files';

export const MIGRATION_BATCH_APPLIED_EVENT = 'adm.migration_batch.applied.v1';
export const MIGRATION_BATCH_FAILED_METRIC = 'adm_migration_batch_failed_total';
export const MIGRATION_BATCH_APPLIED_METRIC = 'adm_migration_batch_applied_total';

/** What one pass did for a tenant. */
export interface MigrationPassResult {
  dryRuns: number;
  applied: number;
  failed: number;
  /** Batches that were Applied already when the pass reached them: nothing was written twice. */
  alreadyImported: number;
}

/**
 * The job `adm-migration` (ADM.md 3.10, the stand-in of `MigrationApplyWorkflow`): every minute it carries out the dry runs that were asked for and the applies that were approved. A dry run reads the file from the
 * object store, checks that it is the file that was registered and writes the errors it finds, never a row of the target. An apply writes the rows in lots of 1,000, each lot in a transaction of its own and each row
 * upserted by its business key, so that a lot that is run again, or a batch that is carried on after it stopped, does not double; at the end what was written is added up and compared with the file. A batch that cannot
 * go on stops as Failed with the code, and goes on from the rows it wrote when it is dry-run and applied again.
 */
export class AdmMigrationJob {
  private readonly store = new AdmMigrationStore();

  constructor(
    private readonly tenants: TenantDatabase,
    private readonly audit: Pick<AuditWriter, 'recordInTx'>,
    private readonly files: Pick<FileService, 'readStored'>,
    private readonly metrics: MetricsSink = NOOP_METRICS,
  ) {}

  private async audited(tx: TenantTx, actor: string, entry: { action: string; resourceId: string; diff: Record<string, unknown> }): Promise<void> {
    await this.audit.recordInTx(tx, actor, { ...entry, resourceType: MIGRATION_BATCH_RESOURCE, correlationId: randomUUID(), requestId: randomUUID() });
  }

  /** The table of the file of a batch, after the file was read from the store and found to be the one that was registered. */
  private async tableOf(ctx: TenantContext, batch: MigrationBatch) {
    const { bytes } = await this.files.readStored(ctx, batch.fileStorageKey);
    if (createHash('sha256').update(bytes).digest('hex') !== batch.fileSha256) throw new DomainError('VALIDATION_FAILED', 422, 'file_sha256');
    return readTabularFile(bytes, MIGRATION_TABULAR_LIMITS);
  }

  private async stop(ctx: TenantContext, id: string, error: unknown): Promise<void> {
    const code = error instanceof DomainError ? error.code : 'BATCH_STOPPED';
    await this.tenants.withTenant(ctx, async (tx) => {
      const stopped = await this.store.failApply(tx, id, code);
      if (stopped !== undefined) await this.audited(tx, ctx.membershipId, { action: 'adm.migration_batch.stopped', resourceId: id, diff: { status: stopped.status, code } });
    });
    this.metrics.increment(MIGRATION_BATCH_FAILED_METRIC, { tenant_id: ctx.tenantId });
  }

  async run(ctx: TenantContext): Promise<MigrationPassResult> {
    const result: MigrationPassResult = { dryRuns: 0, applied: 0, failed: 0, alreadyImported: 0 };
    const validating = await this.tenants.withTenant(ctx, (tx) => this.store.idsIn(tx, 'Validating', 10));
    for (const id of validating) {
      try {
        const batch = await this.tenants.withTenant(ctx, (tx) => this.store.find(tx, id));
        if (batch === undefined) continue;
        const table = await this.tableOf(ctx, batch);
        const outcome = await this.tenants.withTenant(ctx, async (tx) => {
          const decided = await this.store.recordDryRun(tx, id, table);
          if (decided !== undefined) {
            await this.audited(tx, ctx.membershipId, {
              action: 'adm.migration_batch.dry_run',
              resourceId: id,
              diff: { status: decided.status, row_count: decided.judgement.rowCount, error_count: decided.judgement.errorCount, totals: decided.judgement.totals },
            });
          }
          return decided;
        });
        if (outcome !== undefined) result.dryRuns += 1;
      } catch (error) {
        await this.stop(ctx, id, error);
        result.failed += 1;
      }
    }
    const applying = await this.tenants.withTenant(ctx, (tx) => this.store.idsIn(tx, 'Applying', 5));
    for (const id of applying) {
      try {
        const batch = await this.tenants.withTenant(ctx, (tx) => this.store.find(tx, id));
        if (batch === undefined) continue;
        const mapping = this.store.mappingOf(batch.mappingVersion);
        const table = await this.tableOf(ctx, batch);
        const judged = judgeMigrationFile(table, mapping);
        // Nothing but the rows that passed the dry run is written: the file is the same (its hash was checked), so is its judgement; the references were checked then and are not asked of rows migrated since.
        const rows = judged.rows;
        for (let from = 0; from < rows.length; from += MIGRATION_LOT_SIZE) {
          const lot = rows.slice(from, from + MIGRATION_LOT_SIZE);
          const written = await this.tenants.withTenant(ctx, (tx) => this.store.writeLot(tx, id, lot));
          if (written === undefined) break;
        }
        const closed = await this.tenants.withTenant(ctx, async (tx) => {
          const done = await this.store.finishApply(tx, id);
          if (done.outcome === 'APPLIED') {
            await this.audited(tx, ctx.membershipId, {
              action: 'adm.migration_batch.applied',
              resourceId: id,
              diff: { control_totals: done.batch.controlTotals, rows_applied: done.batch.rowsApplied },
            });
            await enqueueOutbox(tx, {
              aggregateType: MIGRATION_BATCH_RESOURCE,
              aggregateId: id,
              aggregateVersion: done.batch.version,
              type: MIGRATION_BATCH_APPLIED_EVENT,
              schemaVersion: 1,
              payload: { batch_id: id, target_entity: done.batch.targetEntity, rows: done.batch.rowsApplied, control_totals: done.batch.controlTotals },
              eventKey: `${MIGRATION_BATCH_RESOURCE}:${id}:applied`,
              correlationId: randomUUID(),
            });
          } else if (done.outcome === 'FAILED') {
            await this.audited(tx, ctx.membershipId, {
              action: 'adm.migration_batch.stopped',
              resourceId: id,
              diff: { status: 'Failed', code: 'CONTROL_TOTALS_MISMATCH', control_totals: done.batch.controlTotals },
            });
          }
          return done.outcome;
        });
        if (closed === 'APPLIED') {
          result.applied += 1;
          this.metrics.increment(MIGRATION_BATCH_APPLIED_METRIC, { tenant_id: ctx.tenantId });
        } else if (closed === 'FAILED') {
          result.failed += 1;
          this.metrics.increment(MIGRATION_BATCH_FAILED_METRIC, { tenant_id: ctx.tenantId });
        } else if (closed === 'ALREADY_IMPORTED') result.alreadyImported += 1;
      } catch (error) {
        await this.stop(ctx, id, error);
        result.failed += 1;
      }
    }
    return result;
  }
}

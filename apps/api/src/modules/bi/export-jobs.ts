import { randomUUID } from 'node:crypto';
import { BiExportStore, WORKER_MEMBERSHIP_ID, enqueueOutbox, loadAccessIn } from '@machvon/db';
import type { AuditWriter, BiExportJobRow, TenantDatabase, TenantTx } from '@machvon/db';
import { DomainError, NOOP_METRICS, parseCron, scheduleDue } from '@machvon/kernel';
import type { BiExportFormat, MetricsSink, TenantContext } from '@machvon/kernel';
import type { FileService } from '../files/file.service';
import { BiExportRunner, isDatabaseError, parseExportSpec } from './export-runner';
import { BiQueryCache } from './query-cache';
import { BiQueryEngine } from './query-engine';

export const EXPORT_DENIED_METRIC = 'bi_export_denied_total';
export const EXPORT_READY_METRIC = 'bi_export_ready_total';
const JOB_RESOURCE = 'bi_export_job';
const SCHEDULE_RESOURCE = 'bi_export_schedule';
const RECIPIENT_SAVEPOINT = 'bi_export_recipient';

export interface ExportJobDeps {
  audit?: AuditWriter;
  metrics?: MetricsSink;
  files: Pick<FileService, 'storeGenerated' | 'remove'>;
  /** How many jobs the expiry takes at a time (200 when none is given). */
  batchSize?: number;
}

export interface ScheduleRun {
  scheduleId: string;
  jobs: BiExportJobRow[];
}

/** What a job that ended is told by: the audit trail and an event, for the person the file was made for. */
async function announce(tx: TenantTx, tenantId: string, job: BiExportJobRow, linkOnly: boolean, deps: ExportJobDeps, now: Date): Promise<void> {
  const correlationId = randomUUID();
  const ready = job.status === 'READY';
  await enqueueOutbox(tx, {
    aggregateType: JOB_RESOURCE,
    aggregateId: job.id,
    aggregateVersion: job.version,
    type: ready ? 'bi.export.ready.v1' : 'bi.export.denied.v1',
    schemaVersion: 1,
    payload: {
      tenant_id: tenantId,
      job_id: job.id,
      schedule_id: job.scheduleId,
      subject_user_id: job.subjectUserId,
      format: job.format,
      // A schedule that only sends the link: the file waits behind the sign-in, and the right is judged again when the link is followed.
      link_only: linkOnly,
      code: ready ? null : job.deniedReason,
      actor_id: WORKER_MEMBERSHIP_ID,
      occurred_at: now.toISOString(),
    },
    eventKey: `${JOB_RESOURCE}:${job.id}:${job.status}`,
    correlationId,
  });
  await deps.audit?.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
    action: ready ? 'bi.export_scheduled' : 'bi.export_denied',
    resourceType: JOB_RESOURCE,
    resourceId: job.id,
    classification: 'CONFIDENTIAL',
    diff: {
      schedule_id: job.scheduleId,
      subject_user_id: job.subjectUserId,
      as_of_period: job.asOfPeriod,
      snapshot_id: job.datasetVersionId,
      scope_hash: job.scopeHash,
      format: job.format,
      ...(ready ? { rows: job.rowCount, file_sha256: job.fileSha256 } : { code: job.deniedReason }),
    },
    correlationId,
    requestId: correlationId,
  });
  (deps.metrics ?? NOOP_METRICS).increment(ready ? EXPORT_READY_METRIC : EXPORT_DENIED_METRIC);
}

/**
 * The job `bi.export-schedule-runner` (BI.md F7) for the tenant of the transaction: a schedule whose next time after its last run has come makes one job for each recipient, under the scope of that recipient as it is now (a
 * recipient who lost the right, or who is no longer active, gets a DENIED job and no file; one whose export failed gets a FAILED job and the others are still made). The run is written on the schedule, so the pass run again
 * makes nothing twice. A schedule that only sends the link makes the same file, and says in the event that the file is behind the sign-in.
 */
export async function runExportSchedules(tx: TenantTx, tenant: TenantContext, now: Date, deps: ExportJobDeps): Promise<ScheduleRun[]> {
  const store = new BiExportStore();
  const engine = new BiQueryEngine(new BiQueryCache());
  const done: ScheduleRun[] = [];
  const runId = randomUUID();
  for (const schedule of await store.activeSchedules(tx)) {
    if (!scheduleDue(parseCron(schedule.cron), new Date(schedule.lastRunAt ?? schedule.createdAt), now, schedule.timezone)) continue;
    const spec = parseExportSpec(schedule.querySpec, undefined, undefined);
    const format: BiExportFormat = schedule.format === 'LINK_ONLY' ? 'CSV' : schedule.format;
    const jobs: BiExportJobRow[] = [];
    // One after the other: the queries of a transaction share a connection.
    for (const recipient of schedule.recipients) {
      const access = await loadAccessIn(tx, recipient);
      // A savepoint for each recipient: a failure of the database for one is rolled back to here and the others are still made.
      await tx.query(`savepoint ${RECIPIENT_SAVEPOINT}`);
      // The files made for this recipient are noted: a rollback takes the job away, and a file that nothing names would stay in the store for good.
      const stored: string[] = [];
      const runner = new BiExportRunner(engine, {
        storeGenerated: async (...input) => {
          const key = await deps.files.storeGenerated(...input);
          stored.push(key);
          return key;
        },
        remove: (...input) => deps.files.remove(...input),
      });
      try {
        const outcome = await runner.run(tx, tenant, {
          subject: recipient,
          access,
          requestedBy: schedule.ownerUserId,
          scheduleId: schedule.id,
          spec,
          format,
          now,
          lenient: true,
          querySpec: schedule.querySpec,
        });
        await announce(tx, tenant.tenantId, outcome.job, schedule.format === 'LINK_ONLY', deps, now);
        jobs.push(outcome.job);
        await tx.query(`release savepoint ${RECIPIENT_SAVEPOINT}`);
      } catch (error) {
        // Nothing to make a job of (no frozen version to read yet), or a failure of the database for this recipient: what was done for them is undone, the others are still made, and the run is told.
        if (!(error instanceof DomainError) && !isDatabaseError(error)) throw error;
        await tx.query(`rollback to savepoint ${RECIPIENT_SAVEPOINT}`);
        for (const key of stored) await deps.files.remove(tenant, key).catch(() => false);
        await deps.audit?.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
          action: 'bi.export_schedule_skipped',
          resourceType: SCHEDULE_RESOURCE,
          resourceId: schedule.id,
          classification: 'INTERNAL',
          diff: { code: error instanceof DomainError ? error.code : 'EXPORT_FAILED', recipient_id: recipient },
          correlationId: runId,
          requestId: runId,
        });
      }
    }
    await store.markRun(tx, schedule.id, now);
    done.push({ scheduleId: schedule.id, jobs });
  }
  return done;
}

/**
 * The job `bi.export-schedule-runner` in a transaction of its own, with the files it makes noted across the whole transaction: if anything after a file was stored undoes the transaction (a later recipient, the mark of
 * the run, the commit), the jobs are gone and so must the files be, since the expiry finds files through committed jobs and would never see them.
 */
export async function runExportSchedulesIn(database: Pick<TenantDatabase, 'withTenant'>, tenant: TenantContext, now: Date, deps: ExportJobDeps): Promise<ScheduleRun[]> {
  const stored: string[] = [];
  const noted: ExportJobDeps = {
    ...deps,
    files: {
      storeGenerated: async (...input) => {
        const key = await deps.files.storeGenerated(...input);
        stored.push(key);
        return key;
      },
      remove: (...input) => deps.files.remove(...input),
    },
  };
  try {
    return await database.withTenant(tenant, (tx) => runExportSchedules(tx, tenant, now, noted));
  } catch (error) {
    for (const key of stored) await deps.files.remove(tenant, key).catch(() => false);
    throw error;
  }
}

/** The job `bi.export-expiry` for the tenant of the transaction: a file whose seven days are over is removed from the store and its job is EXPIRED, once. Returns the jobs expired now. */
export async function expireExports(tx: TenantTx, tenant: TenantContext, now: Date, deps: ExportJobDeps): Promise<string[]> {
  const store = new BiExportStore();
  const expired: string[] = [];
  const runId = randomUUID();
  // The jobs due are taken a batch at a time until none is left: a tenant that makes more files in an hour than a batch holds is not left with a backlog that only grows.
  for (;;) {
    const batch = await store.dueForExpiry(tx, now, deps.batchSize);
    if (batch.length === 0) break;
    for (const job of batch) {
      if (job.fileObjectKey !== null) await deps.files.remove(tenant, job.fileObjectKey);
      await store.markExpired(tx, job.id);
      await deps.audit?.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
        action: 'bi.export_expired',
        resourceType: JOB_RESOURCE,
        resourceId: job.id,
        classification: 'INTERNAL',
        diff: { expires_at: job.expiresAt, subject_user_id: job.subjectUserId },
        correlationId: runId,
        requestId: runId,
      });
      expired.push(job.id);
    }
  }
  return expired;
}

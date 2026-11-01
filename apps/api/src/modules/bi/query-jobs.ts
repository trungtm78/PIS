import { randomUUID } from 'node:crypto';
import { BiLineageStore, BiQueryJobStore, WORKER_MEMBERSHIP_ID, assertFilter, enqueueOutbox, loadAccessIn } from '@machvon/db';
import type { AuditWriter, QueryFilter, QueryJob, TenantDatabase, TenantTx } from '@machvon/db';
import { BI_JOB_BATCH, BI_RESULT_TTL_SECONDS, DomainError, NOOP_METRICS } from '@machvon/kernel';
import type { MetricsSink, TenantContext } from '@machvon/kernel';
import { holdsNow, isDatabaseError } from './export-runner';
import { BiQueryCache } from './query-cache';
import { BiQueryEngine, DATASET_CODE, FILTER_FIELDS, QUERY_PERMISSION } from './query-engine';

export const QUERY_JOB_DONE_METRIC = 'bi_query_job_completed_total';
export const QUERY_JOB_REFUSED_METRIC = 'bi_query_job_refused_total';
const RESOURCE = 'bi_query_run';
const JOB_SAVEPOINT = 'bi_query_job';
/** How long a job may run before the database stops it (a job is the heavy query: longer than a request waits, not for ever). */
export const QUERY_JOB_TIMEOUT_MS = 120_000;
/** The SQLSTATE of a statement the database stopped because it ran too long. */
const QUERY_CANCELED = '57014';

export interface QueryJobDeps {
  audit?: AuditWriter;
  metrics?: MetricsSink;
  /** How many jobs one pass takes (the batch of the kernel when none is given). */
  batchSize?: number;
  /** The cost a query may have and still be answered in the request: what the job judges the answer by, when it is asked again. */
  syncCostLimit?: number;
  /** How long one job may run before the database stops it (two minutes when none is given). */
  timeoutMs?: number;
  /** The time as it is when a job begins and when it ends: a job that runs for minutes is judged at the time it runs and its answer is kept from the time it ended (the time of the pass is used when none is given). */
  clock?: () => Date;
}

/** What a job was asked: the metric, the snapshot, one dimension at most and the filters, as the query had them (the reader is the run's own). */
export type QueryJobSpec = {
  metric_version_id: string;
  snapshot_id: string;
  dimension: string | null;
  filters: QueryFilter[];
  /** The question continues a drill that is open: the revision of the metric it was begun with is read even when a newer one has replaced it. */
  pinned: boolean;
};

export const specOf = (input: { metricId: string; snapshotId: string; dimension: string | undefined; filters: readonly QueryFilter[]; pinned: boolean }): QueryJobSpec => ({
  metric_version_id: input.metricId,
  snapshot_id: input.snapshotId,
  dimension: input.dimension ?? null,
  filters: [...input.filters],
  pinned: input.pinned,
});

/** The spec of a job as it was kept: anything that is not what a query takes is a job that cannot be run, and it ends as FAILED. */
function parseSpec(raw: unknown): { metricId: string; snapshotId: string; dimension: string | undefined; filters: QueryFilter[]; pinned: boolean } {
  const spec = raw as Partial<QueryJobSpec> | null;
  if (typeof spec !== 'object' || spec === null || typeof spec.metric_version_id !== 'string' || typeof spec.snapshot_id !== 'string' || !Array.isArray(spec.filters))
    throw new DomainError('VALIDATION_FAILED', 422, 'query_spec');
  const dimension = spec.dimension ?? undefined;
  if (dimension !== undefined && typeof dimension !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'query_spec.dimension');
  for (const filter of spec.filters) {
    if (!FILTER_FIELDS.has(filter.field)) throw new DomainError('DIMENSION_NOT_IN_DATASET', 422, filter.field);
    assertFilter(filter);
  }
  return { metricId: spec.metric_version_id, snapshotId: spec.snapshot_id, dimension, filters: spec.filters, pinned: spec.pinned === true };
}

type Ended = { status: 'COMPLETED'; rows: number; result: unknown } | { status: 'DENIED' | 'FAILED' | 'TIMEOUT'; code: string };

/** The audit trail and the event that tell the reader their job ended: what ended, with what, never the figures. */
async function announce(tx: TenantTx, tenantId: string, job: QueryJob, ended: Ended, durationMs: number, deps: QueryJobDeps, now: Date): Promise<void> {
  const correlationId = randomUUID();
  const done = ended.status === 'COMPLETED';
  await enqueueOutbox(tx, {
    aggregateType: RESOURCE,
    aggregateId: job.id,
    aggregateVersion: 1,
    type: done ? 'bi.query.completed.v1' : 'bi.query.refused.v1',
    schemaVersion: 1,
    payload: {
      tenant_id: tenantId,
      run_id: job.id,
      requested_by: job.requestedBy,
      metric_version_ids: job.metricVersionIds,
      as_of_period: job.asOfPeriod,
      status: ended.status,
      code: done ? null : ended.code,
      actor_id: WORKER_MEMBERSHIP_ID,
      occurred_at: now.toISOString(),
    },
    eventKey: `${RESOURCE}:${job.id}:${ended.status}`,
    correlationId,
  });
  await deps.audit?.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
    action: done ? 'bi.query_job_completed' : 'bi.query_job_refused',
    resourceType: RESOURCE,
    resourceId: job.id,
    classification: 'INTERNAL',
    diff: { requested_by: job.requestedBy, as_of_period: job.asOfPeriod, estimated_cost: job.estimatedCost, duration_ms: durationMs, ...(done ? { rows: ended.rows } : { code: ended.code }) },
    correlationId,
    requestId: correlationId,
  });
  (deps.metrics ?? NOOP_METRICS).increment(done ? QUERY_JOB_DONE_METRIC : QUERY_JOB_REFUSED_METRIC);
}

/** One job, run for the person who asked, under the access they have now: the right is judged again, and a scope that changed since the question was asked is not answered with the old one. */
async function runOne(tx: TenantTx, tenant: TenantContext, engine: BiQueryEngine, job: QueryJob, now: Date): Promise<Ended> {
  const access = await loadAccessIn(tx, job.requestedBy);
  if (!holdsNow(access, QUERY_PERMISSION, now)) return { status: 'DENIED', code: 'SCOPE_DENIED' };
  const spec = parseSpec(job.spec);
  const reading = await engine.read(tx, job.requestedBy, access, spec.metricId, spec.snapshotId, now, spec.pinned);
  if (reading.denied !== undefined) return { status: 'DENIED', code: reading.denied };
  const read = reading.value;
  // The answer is kept under the scope the question was asked under: a reader whose scope moved since asks again, under the new one, and gets a job of its own.
  if (engine.keyOf(read, spec.dimension, spec.filters, tenant.tenantId).digest !== job.cacheKey) return { status: 'DENIED', code: 'SCOPE_CHANGED' };
  engine.assertDimensions(read, [...(spec.dimension === undefined ? [] : [spec.dimension]), ...spec.filters.map((filter) => filter.field)]);
  const answer = await engine.compute(tx, read, spec.dimension, spec.filters, access, now);
  await new BiLineageStore().metricRead(tx, {
    metricId: read.metricId,
    metricCode: read.metricCode,
    metricRevision: read.metricRevision,
    versionId: read.version.datasetVersionId,
    datasetCode: DATASET_CODE,
    asOfPeriod: read.version.periodCode,
    runId: job.id,
    observedAt: now,
  });
  return { status: 'COMPLETED', rows: answer.rows.length, result: answer };
}

/**
 * The job `bi-query-jobs` for the tenant of the transaction (BI.md F3): the queries that were too heavy to wait for are taken oldest first and run for the person who asked, under the scope that person has now. Each ends
 * as COMPLETED (the answer kept for an hour, to be asked for again), DENIED (the right was lost, or the scope moved), FAILED, or TIMEOUT (the database stopped it), always with how long it took; the reader is told by an event.
 * A failure of the database for one job is rolled back to a savepoint and the others still run.
 */
export async function runQueryJobs(tx: TenantTx, tenant: TenantContext, now: Date, deps: QueryJobDeps = {}): Promise<number> {
  const store = new BiQueryJobStore();
  const engine = new BiQueryEngine(new BiQueryCache(), deps.syncCostLimit);
  const clock = deps.clock ?? ((): Date => now);
  const jobs = await store.claim(tx, deps.batchSize ?? BI_JOB_BATCH, clock());
  // One after the other: the queries of a transaction share a connection.
  for (const job of jobs) {
    const started = Date.now();
    const began = clock();
    await tx.query(`savepoint ${JOB_SAVEPOINT}`);
    const [{ limit: usual } = { limit: '0' }] = await tx.query<{ limit: string }>("select current_setting('statement_timeout') as limit");
    let ended: Ended;
    try {
      await tx.query("select set_config('statement_timeout', $1, true)", [String(deps.timeoutMs ?? QUERY_JOB_TIMEOUT_MS)]);
      ended = await runOne(tx, tenant, engine, job, began);
      await tx.query(`release savepoint ${JOB_SAVEPOINT}`);
    } catch (error) {
      // What the job did is undone (the claim is not: it was made before the savepoint), and it ends with the reason.
      if (!(error instanceof DomainError) && !isDatabaseError(error)) throw error;
      await tx.query(`rollback to savepoint ${JOB_SAVEPOINT}`);
      ended =
        error instanceof DomainError
          ? { status: 'FAILED', code: error.code }
          : { status: (error as { code?: string }).code === QUERY_CANCELED ? 'TIMEOUT' : 'FAILED', code: (error as { code?: string }).code === QUERY_CANCELED ? 'QUERY_TIMEOUT' : 'QUERY_FAILED' };
    }
    await tx.query("select set_config('statement_timeout', $1, true)", [usual]);
    const durationMs = Date.now() - started;
    const finished = clock();
    await store.finish(
      tx,
      job.id,
      ended.status === 'COMPLETED'
        ? { status: ended.status, durationMs, rowCount: ended.rows, errorCode: null, result: ended.result, resultExpiresAt: new Date(finished.getTime() + BI_RESULT_TTL_SECONDS * 1000), now: finished }
        : { status: ended.status, durationMs, rowCount: null, errorCode: ended.code, result: undefined, resultExpiresAt: null, now: finished },
    );
    await announce(tx, tenant.tenantId, job, ended, durationMs, deps, finished);
  }
  return jobs.length;
}

/**
 * The pass of the worker over one tenant: each job is taken, run and ended in a transaction of its own, so a job that ended is COMPLETED for the person who waits for it without waiting for the jobs that were queued with it,
 * and a failure of one (the connection, the audit) undoes that job alone and leaves it QUEUED. A pass takes up to a batch of jobs and stops when none waits.
 */
export async function runQueryJobsIn(tenants: Pick<TenantDatabase, 'withTenant'>, tenant: TenantContext, now: Date, deps: QueryJobDeps = {}): Promise<number> {
  const batch = deps.batchSize ?? BI_JOB_BATCH;
  let ran = 0;
  while (ran < batch) {
    const taken = await tenants.withTenant(tenant, (tx) => runQueryJobs(tx, tenant, now, { ...deps, batchSize: 1 }));
    if (taken === 0) break;
    ran += taken;
  }
  return ran;
}

/** The job `bi-query-answer-expiry`: the answers kept past their hour are taken away (the run stays in the log without them), a batch at a time until none is left. */
export async function expireQueryAnswers(tx: TenantTx, now: Date, deps: Pick<QueryJobDeps, 'batchSize'> = {}): Promise<number> {
  const store = new BiQueryJobStore();
  const batch = deps.batchSize ?? 200;
  let total = 0;
  for (;;) {
    const taken = await store.purge(tx, now, batch);
    total += taken;
    if (taken < batch) return total;
  }
}

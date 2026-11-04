import { randomUUID } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export const QUERY_RUN_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'DENIED', 'FAILED', 'TIMEOUT', 'CANCELLED'] as const;
export type QueryRunStatus = (typeof QUERY_RUN_STATUSES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A line of the log of the queries: how long it took and where it was answered from, never what it answered. */
export interface QueryRunLine {
  id: string;
  requestedBy: string;
  metricVersionIds: string[];
  asOfPeriod: string;
  datasetVersionId: string;
  mode: 'SYNC' | 'ASYNC_JOB';
  status: QueryRunStatus;
  servedFromCache: boolean;
  durationMs: number | null;
  rowCount: number | null;
  costUnits: number | null;
  estimatedCost: number | null;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** A job that waits to be run: what was asked, as it was asked, and the key its answer is kept under. */
export interface QueryJob {
  id: string;
  requestedBy: string;
  metricVersionIds: string[];
  asOfPeriod: string;
  datasetVersionId: string;
  scopeHash: string;
  cacheKey: string;
  spec: Record<string, unknown>;
  estimatedCost: number;
}

export interface QueryJobInput {
  requestedBy: string;
  metricVersionIds: readonly string[];
  asOfPeriod: string;
  datasetVersionId: string;
  scopeHash: string;
  cacheKey: string;
  spec: Record<string, unknown>;
  estimatedCost: number;
}

export interface QueryJobOutcome {
  status: 'COMPLETED' | 'DENIED' | 'FAILED' | 'TIMEOUT';
  durationMs: number;
  rowCount: number | null;
  errorCode: string | null;
  result: unknown;
  resultExpiresAt: Date | null;
  now: Date;
}

export interface QueryRunFilter {
  status?: string | undefined;
  requestedBy?: string | undefined;
  asOfPeriod?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

interface Sql {
  [column: string]: unknown;
  id: string;
  requested_by: string;
  metric_version_ids: string[];
  as_of_period: string;
  dataset_version_id: string;
  mode: "SYNC" | "ASYNC_JOB";
  status: "FAILED" | "QUEUED" | "RUNNING" | "DENIED" | "COMPLETED" | "TIMEOUT" | "CANCELLED";
  served_from_cache: boolean;
  duration_ms: number | null;
  row_count: number | null;
  error_code: string | null;
  created_at: string | number | Date;
  finished_at: string | number | Date;
  scope_hash: string;
  cache_key: string;
  query_spec: Record<string, unknown>;
}

const lineOf = (row: Sql): QueryRunLine => ({
  id: row.id,
  requestedBy: row.requested_by,
  metricVersionIds: row.metric_version_ids,
  asOfPeriod: row.as_of_period,
  datasetVersionId: row.dataset_version_id,
  mode: row.mode,
  status: row.status,
  servedFromCache: row.served_from_cache,
  durationMs: row.duration_ms,
  rowCount: row.row_count,
  costUnits: row.cost_units === null ? null : Number(row.cost_units),
  estimatedCost: row.estimated_cost === null ? null : Number(row.estimated_cost),
  errorCode: row.error_code,
  createdAt: new Date(row.created_at).toISOString(),
  finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
});

/**
 * The jobs the heavy queries of BI become and the log of the queries (ST-BI-009, BI 3 F3, BI-13). A job is one row of the log: it waits as QUEUED, a worker takes it as RUNNING and it ends with its answer kept for a
 * while, or as DENIED, FAILED or TIMEOUT. The same question of the same reader under the same scope is one job at a time (the unique index). The log tells how long and from where, never the figures.
 */
export class BiQueryJobStore {
  /** The job that is open (waiting or running) for a question, read as the database stood when the statement began: a worker that holds it in a transaction that has not ended does not make this wait. */
  private async openJob(tx: TenantTx, cacheKey: string): Promise<string | undefined> {
    const open = await tx.query<{ id: string }>("select id from machvon.bi_query_run where cache_key = $1 and mode = 'ASYNC_JOB' and status in ('QUEUED', 'RUNNING') order by created_at, id limit 1", [
      cacheKey,
    ]);
    return open[0]?.id;
  }

  /**
   * Makes the job, or tells the one that is open for the same question (the answer to a second request that came while the first waits or runs: it is found by a read that waits for nobody, so a person who asks again while a
   * worker is on the job gets the 202 at once). When there is no open job and an answer that is kept has come in the meantime, nothing is made and the answer is none: the caller reads it.
   */
  async enqueue(tx: TenantTx, input: QueryJobInput, now: Date): Promise<{ id: string; created: boolean } | undefined> {
    const open = await this.openJob(tx, input.cacheKey);
    if (open !== undefined) return { id: open, created: false };
    const id = randomUUID();
    // The unique index decides between two requests that come together; the condition decides between a request and a job that ended a moment ago (its answer is kept, so a job made now would answer what is answered).
    const made = await tx.query<{ id: string }>(
      `insert into machvon.bi_query_run (tenant_id, id, requested_by, metric_version_ids, as_of_period, dataset_version_id, scope_hash, mode, status, served_from_cache, query_spec, cache_key, estimated_cost)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::jsonb, $4, $5::uuid, $6, 'ASYNC_JOB', 'QUEUED', false, $7::jsonb, $8, $9::numeric
        where not exists (select 1 from machvon.bi_query_run k where k.cache_key = $8 and k.status = 'COMPLETED' and k.result is not null and k.result_expires_at > $10::timestamptz)
       on conflict (tenant_id, cache_key) where mode = 'ASYNC_JOB' and status in ('QUEUED', 'RUNNING') do nothing
       returning id`,
      [
        id,
        input.requestedBy,
        JSON.stringify(input.metricVersionIds),
        input.asOfPeriod,
        input.datasetVersionId,
        input.scopeHash,
        JSON.stringify(input.spec),
        input.cacheKey,
        input.estimatedCost,
        now.toISOString(),
      ],
    );
    if (made[0] !== undefined) return { id: made[0].id, created: true };
    const raced = await this.openJob(tx, input.cacheKey);
    return raced === undefined ? undefined : { id: raced, created: false };
  }

  /** The answer a job of the same question made and that is still kept: the newest one, or none. */
  async answerOf(tx: TenantTx, cacheKey: string, now: Date): Promise<unknown> {
    const rows = await tx.query<{ result: unknown }>(
      "select result from machvon.bi_query_run where cache_key = $1 and status = 'COMPLETED' and result is not null and result_expires_at > $2::timestamptz order by created_at desc, id desc limit 1",
      [cacheKey, now.toISOString()],
    );
    return rows[0]?.result;
  }

  /**
   * Takes the jobs that wait, oldest first, as RUNNING. A job another worker holds is passed by. The jobs are picked in a materialised step of their own: a locking
   * `limit` inside `where ... in (select ...)` may be run again by the planner and take more rows than the limit, and a pass that was to take one job would then take two
   * and end both in one transaction.
   */
  async claim(tx: TenantTx, limit: number, now: Date): Promise<QueryJob[]> {
    const rows = await tx.query<Sql>(
      `with picked as materialized (
         select q.tenant_id, q.id from machvon.bi_query_run q where q.mode = 'ASYNC_JOB' and q.status = 'QUEUED' order by q.created_at, q.id limit $1::int for update skip locked
       )
       update machvon.bi_query_run r set status = 'RUNNING', started_at = $2::timestamptz
         from picked p where r.tenant_id = p.tenant_id and r.id = p.id
        returning r.id, r.requested_by, r.metric_version_ids, r.as_of_period, r.dataset_version_id, r.scope_hash, r.cache_key, r.query_spec, r.estimated_cost, r.created_at`,
      [limit, now.toISOString()],
    );
    return rows
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id.localeCompare(b.id))
      .map((row) => ({
        id: row.id,
        requestedBy: row.requested_by,
        metricVersionIds: row.metric_version_ids,
        asOfPeriod: row.as_of_period,
        datasetVersionId: row.dataset_version_id,
        scopeHash: row.scope_hash,
        cacheKey: row.cache_key,
        spec: row.query_spec,
        estimatedCost: Number(row.estimated_cost),
      }));
  }

  /** Ends a job that is RUNNING: how long it took, its rows and its answer (kept until `resultExpiresAt`), or why it did not end well. */
  async finish(tx: TenantTx, id: string, outcome: QueryJobOutcome): Promise<void> {
    const kept = outcome.status === 'COMPLETED' && outcome.result !== undefined;
    const updated = await tx.query<{ id: string }>(
      `update machvon.bi_query_run set status = $2, duration_ms = $3::int, row_count = $4::int, cost_units = $4::numeric, error_code = $5, finished_at = $6::timestamptz,
              result = $7::jsonb, result_expires_at = $8::timestamptz
        where id = $1::uuid and status = 'RUNNING' returning id`,
      [
        id,
        outcome.status,
        outcome.durationMs,
        outcome.rowCount,
        outcome.errorCode,
        outcome.now.toISOString(),
        kept ? JSON.stringify(outcome.result) : null,
        kept ? (outcome.resultExpiresAt ?? outcome.now).toISOString() : null,
      ],
    );
    if (updated[0] === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'run');
  }

  /** Takes the answers that were kept past their time away (the run stays in the log without them). */
  async purge(tx: TenantTx, now: Date, limit: number): Promise<number> {
    const rows = await tx.query<{ id: string }>(
      `update machvon.bi_query_run set result = null, result_expires_at = null
        where (tenant_id, id) in (select tenant_id, id from machvon.bi_query_run where result is not null and result_expires_at <= $1::timestamptz order by result_expires_at limit $2::int for update skip locked)
        returning id`,
      [now.toISOString(), limit],
    );
    return rows.length;
  }

  /** One run of the log, with who asked it (the caller decides whose it may be shown to). */
  async find(tx: TenantTx, id: string): Promise<QueryRunLine | undefined> {
    const rows = await tx.query<Sql>(
      `select id, requested_by, metric_version_ids, as_of_period, dataset_version_id, mode, status, served_from_cache, duration_ms, row_count, cost_units, estimated_cost, error_code, created_at, finished_at
         from machvon.bi_query_run where id = $1::uuid`,
      [id],
    );
    return rows[0] === undefined ? undefined : lineOf(rows[0]);
  }

  /** The log, newest first, a page at a time. The filters are checked here: an unknown status or a malformed id is 422 naming the field. */
  async list(tx: TenantTx, filter: QueryRunFilter): Promise<{ items: QueryRunLine[]; next: string | null }> {
    if (filter.status !== undefined && !(QUERY_RUN_STATUSES as readonly string[]).includes(filter.status)) throw invalid('status');
    if (filter.requestedBy !== undefined && !UUID.test(filter.requestedBy)) throw invalid('requested_by');
    if (filter.asOfPeriod !== undefined && (filter.asOfPeriod.length < 4 || filter.asOfPeriod.length > 20)) throw invalid('as_of_period');
    const params: unknown[] = [];
    const conditions: string[] = [];
    const bind = (value: unknown, cast = ''): string => {
      params.push(value);
      return `$${params.length}${cast}`;
    };
    if (filter.status !== undefined) conditions.push(`status = ${bind(filter.status)}`);
    if (filter.requestedBy !== undefined) conditions.push(`requested_by = ${bind(filter.requestedBy, '::uuid')}`);
    if (filter.asOfPeriod !== undefined) conditions.push(`as_of_period = ${bind(filter.asOfPeriod)}`);
    if (filter.cursor !== undefined) {
      const [at, id] = Buffer.from(filter.cursor, 'base64url').toString('utf8').split('|');
      if (at === undefined || id === undefined || Number.isNaN(Date.parse(at)) || !UUID.test(id)) throw invalid('cursor');
      conditions.push(`(created_at, id) < (${bind(at, '::timestamptz')}, ${bind(id, '::uuid')})`);
    }
    const rows = await tx.query<Sql>(
      `select id, requested_by, metric_version_ids, as_of_period, dataset_version_id, mode, status, served_from_cache, duration_ms, row_count, cost_units, estimated_cost, error_code, created_at, finished_at, created_at::text as created_raw
         from machvon.bi_query_run ${conditions.length === 0 ? '' : `where ${conditions.join(' and ')}`}
        order by created_at desc, id desc limit ${bind(filter.limit + 1, '::int')}`,
      params,
    );
    const page = rows.slice(0, filter.limit);
    const last = page[page.length - 1];
    // The cursor keeps the time as the database wrote it (microseconds): through a date of the language two runs of the same millisecond would be passed over or told twice.
    return { items: page.map(lineOf), next: rows.length > filter.limit && last !== undefined ? Buffer.from(`${last.created_raw}|${last.id}`, 'utf8').toString('base64url') : null };
  }
}

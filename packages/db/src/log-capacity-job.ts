import { randomUUID } from 'node:crypto';
import { CAPACITY_CLASSES, NOOP_METRICS, capacityKindOf, evaluateCapacity, planArchive, sha256Hex, technicalCutoff } from '@machvon/kernel';
import type { CapacityClass, CapacityState, LogCapPolicy, LogReading, MetricsSink, TechnicalClass, TenantContext } from '@machvon/kernel';
import { AuditWriter } from './audit-writer.ts';
import { LogCapacityStore } from './log-capacity-store.ts';
import type { LogCapacityPolicyRow } from './log-capacity-store.ts';
import { RetentionPolicyStore } from './retention-policy-store.ts';
import type { RetentionPolicyRow } from './retention-policy-store.ts';
import type { TenantDatabase, TenantTx } from './tenant-database.ts';

/** Gauges of the last run, by record class and tenant: 1 while the class stands at or above the warning share of its cap, 1 while it is over its cap and the run could not bring it back (rules in alerts/rules). */
export const LOG_CAPACITY_NEAR_METRIC = 'log_capacity_near';
export const LOG_CAPACITY_EXCEEDED_METRIC = 'log_capacity_exceeded';
export const LOG_ARCHIVED_METRIC = 'log_archived_rows';

const DAY_MS = 86_400_000;
/** The metadata of an inbox event stays two years, as in the retention run. */
const INBOX_METADATA_DAYS = 730;
/** Rows read to estimate the size of a class that is bigger than this. */
const SAMPLE_ROWS = 50_000;
const ARCHIVE_BATCH_ROWS = 20_000;
const ARCHIVE_KIND = 'log_archive';
const ARCHIVE_TYPE = 'application/x-ndjson';

/** Where an archive file is kept: the object store the API serves (`FileService.storeGenerated`). */
export interface LogArchiveSink {
  storeGenerated(tenant: TenantContext, kind: string, id: string, bytes: Uint8Array, contentType: string): Promise<string>;
  remove?(tenant: TenantContext, key: string): Promise<boolean>;
}

interface TechnicalSource {
  table: string;
  /** The rows the retention run may remove, with the cutoff as `$1`; a cap may remove no others. */
  eligible: string;
  /** Orders the rows from the oldest. */
  age: string;
  /** Excludes the rows a legal hold contains. */
  held: string;
}

const heldFilter = (type: string, id: string): string => `not machvon.legal_hold_blocks(${type}, ${id})`;

const TECHNICAL_SOURCES: Readonly<Record<TechnicalClass, TechnicalSource>> = {
  idempotency_record: { table: 'idempotency_record', eligible: 'created_at < $1::timestamptz and expires_at <= now()', age: 'created_at', held: heldFilter('resource_type', 'resource_id') },
  outbox_event: { table: 'outbox_event', eligible: "status = 'PUBLISHED' and published_at < $1::timestamptz", age: 'published_at', held: heldFilter('aggregate_type', 'aggregate_id') },
  integration_event_inbox: {
    table: 'integration_event_inbox',
    eligible: "status in ('PROCESSED', 'DEAD') and payload_reference is null and received_at < $1::timestamptz",
    age: 'received_at',
    held: heldFilter("'integration_event_inbox'", 'null::uuid'),
  },
  user_session: { table: 'user_session', eligible: 'coalesce(revoked_at, last_seen_at) < $1::timestamptz', age: 'coalesce(revoked_at, last_seen_at)', held: heldFilter("'user_session'", 'null::uuid') },
  delivery_attempt: { table: 'delivery_attempt', eligible: 'created_at < $1::timestamptz', age: 'created_at', held: heldFilter("'delivery_attempt'", 'null::uuid') },
};

const MONITOR_TABLES: Readonly<Record<'audit_event' | 'audit_event_detail', string>> = { audit_event: 'audit_event', audit_event_detail: 'audit_event_detail' };

export interface LogCapacityRunResult {
  /** The state of each class after the run. */
  states: Record<string, CapacityState>;
  /** Rows archived and then removed, per class. */
  archived: Record<string, number>;
  /** Classes over their cap that the run could not bring back (monitor-only, or nothing old enough to remove). */
  exceeded: string[];
  /** Classes at or above the warning share of their cap after the run. */
  near: string[];
}

export interface LogCapacityJobOptions {
  metrics?: MetricsSink;
  /** Without a sink nothing is ever removed: a class over its cap stays over it and the alert says so. */
  archives?: LogArchiveSink;
}

/** The cutoff before which a row of a technical class may go: the retention rule of the class, a permanent policy giving way to the platform minimum (the cap is a later, audited decision of the tenant and the archive keeps the rows). */
function cutoffOf(recordClass: TechnicalClass, policy: RetentionPolicyRow | undefined, now: Date): Date {
  const finite = policy === undefined || policy.retentionBasis === 'PERMANENT' ? undefined : { years: policy.retentionYears ?? undefined, permanent: false };
  const base = technicalCutoff(recordClass, recordClass === 'idempotency_record' ? undefined : finite, now) as Date;
  if (recordClass !== 'integration_event_inbox') return base;
  const days = Math.max(INBOX_METADATA_DAYS, (finite?.years ?? 0) * 365);
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * The nightly measure of the log classes of a tenant and, for a technical class over its cap, archive-then-purge (HT.06, ENT-4e). Each class runs in a transaction of its own.
 * A technical class is archived into a hashed JSONL file and only then are exactly those rows removed, never a row younger than the retention rule and never a row a legal hold contains.
 * The audit trail and its detail records are measured and alerted, never removed: business evidence is not deleted by a job (BR-ADM-11).
 */
export class LogCapacityJob {
  private readonly store = new LogCapacityStore();
  private readonly retention = new RetentionPolicyStore();
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;
  private readonly archives: LogArchiveSink | undefined;
  private readonly database: TenantDatabase;

  constructor(database: TenantDatabase, options: LogCapacityJobOptions = {}) {
    this.database = database;
    this.audit = new AuditWriter(database);
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.archives = options.archives;
  }

  async run(ctx: TenantContext, now: Date = new Date()): Promise<LogCapacityRunResult> {
    const result: LogCapacityRunResult = { states: {}, archived: {}, exceeded: [], near: [] };
    const failed: string[] = [];
    const { caps, retention } = await this.database.withTenant(ctx, async (tx) => ({
      caps: new Map((await this.store.policies(tx)).filter((policy) => policy.active).map((policy) => [policy.recordClass, policy])),
      retention: await this.retention.published(tx),
    }));
    for (const recordClass of CAPACITY_CLASSES) {
      try {
        await this.database.withTenant(ctx, (tx) => this.one(tx, ctx, recordClass, caps.get(recordClass), retention.get(recordClass), now, result));
      } catch {
        failed.push(recordClass);
      }
    }
    if (failed.length > 0) throw new LogCapacityRunFailed(failed);
    return result;
  }

  private async one(tx: TenantTx, ctx: TenantContext, recordClass: CapacityClass, cap: LogCapacityPolicyRow | undefined, retention: RetentionPolicyRow | undefined, now: Date, result: LogCapacityRunResult): Promise<void> {
    const labels = { record_class: recordClass, tenant_id: ctx.tenantId };
    let reading = await this.measure(tx, recordClass, retention, now);
    const policy: LogCapPolicy | undefined = cap === undefined ? undefined : { recordClass, maxRows: cap.maxRows, maxBytes: cap.maxBytes, warnPct: cap.warnPct };
    if (policy !== undefined) {
      const plan = planArchive(policy, reading);
      if (plan.action === 'ARCHIVE_THEN_PURGE' && this.archives !== undefined && capacityKindOf(recordClass) === 'TECHNICAL') {
        const rows = await this.archiveAndPurge(tx, ctx, recordClass as TechnicalClass, cutoffOf(recordClass as TechnicalClass, retention, now), plan.rows, cap?.reason ?? '');
        if (rows > 0) {
          result.archived[recordClass] = rows;
          this.metrics.gauge(LOG_ARCHIVED_METRIC, rows, labels);
          reading = await this.measure(tx, recordClass, retention, now);
        }
      }
    }
    const evaluation = policy === undefined ? undefined : evaluateCapacity(policy, reading);
    const state: CapacityState = evaluation?.state ?? 'UNCAPPED';
    result.states[recordClass] = state;
    // Still over the cap after the run: it could not bring the class back (monitor-only, no sink, or nothing old enough to remove).
    const exceeded = state === 'OVER';
    if (exceeded) result.exceeded.push(recordClass);
    if (state === 'NEAR' || state === 'OVER') result.near.push(recordClass);
    this.metrics.gauge(LOG_CAPACITY_NEAR_METRIC, state === 'NEAR' || state === 'OVER' ? 1 : 0, labels);
    this.metrics.gauge(LOG_CAPACITY_EXCEEDED_METRIC, exceeded ? 1 : 0, labels);
    await tx.query(
      `insert into machvon.log_capacity_reading (tenant_id, record_class, row_count, byte_count, bytes_estimated, eligible_rows, protected_rows, state, measured_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2::bigint, $3::bigint, $4, $5::bigint, $6::bigint, $7, now())
       on conflict (tenant_id, record_class) do update set row_count = excluded.row_count, byte_count = excluded.byte_count, bytes_estimated = excluded.bytes_estimated,
         eligible_rows = excluded.eligible_rows, protected_rows = excluded.protected_rows, state = excluded.state, measured_at = excluded.measured_at`,
      [recordClass, reading.rows, reading.bytes, reading.bytesEstimated, reading.eligibleRows, reading.protectedRows, state],
    );
  }

  /** Rows, bytes (sampled above a size), the rows a cap may remove and the rows the platform period protects. */
  private async measure(tx: TenantTx, recordClass: CapacityClass, retention: RetentionPolicyRow | undefined, now: Date): Promise<LogReading> {
    const technical = capacityKindOf(recordClass) === 'TECHNICAL' ? TECHNICAL_SOURCES[recordClass as TechnicalClass] : undefined;
    const table = technical?.table ?? MONITOR_TABLES[recordClass as 'audit_event' | 'audit_event_detail'];
    const [count] = await tx.query<{ n: string }>(`select count(*)::text as n from machvon.${table}`);
    const rows = Number(count?.n ?? 0);
    const [sample] = await tx.query<{ bytes: string; n: string }>(`select coalesce(sum(pg_column_size(s)), 0)::text as bytes, count(*)::text as n from (select * from machvon.${table} limit ${SAMPLE_ROWS}) s`);
    const sampled = Number(sample?.n ?? 0);
    const estimated = rows > sampled && sampled > 0;
    const bytes = estimated ? Math.round((Number(sample?.bytes ?? 0) * rows) / sampled) : Number(sample?.bytes ?? 0);
    let eligibleRows = 0;
    // A policy that keeps the class for good leaves nothing for a cap to remove (the retention rule is the stricter one).
    if (technical !== undefined && retention?.retentionBasis !== 'PERMANENT') {
      const cutoff = cutoffOf(recordClass as TechnicalClass, retention, now);
      const [eligible] = await tx.query<{ n: string }>(`select count(*)::text as n from machvon.${technical.table} where ${technical.eligible} and ${technical.held}`, [cutoff.toISOString()]);
      eligibleRows = Number(eligible?.n ?? 0);
    }
    return { recordClass, rows, bytes, bytesEstimated: estimated, eligibleRows, protectedRows: Math.max(0, rows - eligibleRows) };
  }

  /**
   * Reads the oldest eligible rows under a lock, writes them to a file, records the batch, removes exactly those rows and marks the batch PURGED, in one transaction. A failure of the file
   * leaves every row in place; a failure after the file leaves the file as an orphan, which is removed when the sink can.
   */
  private async archiveAndPurge(tx: TenantTx, ctx: TenantContext, recordClass: TechnicalClass, cutoff: Date, wanted: number, reason: string): Promise<number> {
    const sink = this.archives as LogArchiveSink;
    const source = TECHNICAL_SOURCES[recordClass];
    const limit = Math.min(wanted, ARCHIVE_BATCH_ROWS);
    const doomed = await tx.query<{ c: string; row: Record<string, unknown>; at: string }>(
      `select t.ctid::text as c, to_jsonb(t) as row, (${source.age})::text as at from machvon.${source.table} t
        where ${source.eligible} and ${source.held} order by ${source.age}, t.ctid limit $2 for update of t`,
      [cutoff.toISOString(), limit],
    );
    if (doomed.length === 0) return 0;
    const text = `${doomed.map((item) => JSON.stringify(item.row)).join('\n')}\n`;
    const bytes = Buffer.from(text, 'utf8');
    const batchId = randomUUID();
    const key = await sink.storeGenerated(ctx, ARCHIVE_KIND, batchId, bytes, ARCHIVE_TYPE);
    try {
      await tx.query(
        `insert into machvon.log_archive_batch (tenant_id, id, record_class, status, row_count, byte_count, oldest_at, newest_at, file_key, file_sha256, cap_reason)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, 'ARCHIVED', $3::bigint, $4::bigint, $5::timestamptz, $6::timestamptz, $7, $8, $9)`,
        [batchId, recordClass, doomed.length, bytes.length, doomed[0]?.at ?? null, doomed[doomed.length - 1]?.at ?? null, key, sha256Hex(text), reason || 'cap'],
      );
      const removed = await tx.query(`delete from machvon.${source.table} where ctid = any($1::tid[]) returning 1`, [doomed.map((item) => item.c)]);
      if (removed.length !== doomed.length) throw new Error('the rows removed are not the rows archived');
      await tx.query("update machvon.log_archive_batch set status = 'PURGED', purged_at = now(), purged_rows = $2::bigint where id = $1::uuid", [batchId, removed.length]);
      const correlation = randomUUID();
      await this.audit.recordInTx(tx, ctx.membershipId, {
        action: 'log_capacity.archived',
        resourceType: 'log_archive_batch',
        resourceId: batchId,
        diff: { record_class: recordClass, rows: removed.length, bytes: bytes.length, file_sha256: sha256Hex(text), cutoff: cutoff.toISOString() },
        correlationId: correlation,
        requestId: correlation,
        classification: 'INTERNAL',
      });
      return removed.length;
    } catch (error) {
      if (sink.remove !== undefined) await sink.remove(ctx, key).catch(() => false);
      throw error;
    }
  }
}

/** One or more classes failed in a run; the others were still processed. Names the classes only, never a message. */
export class LogCapacityRunFailed extends Error {
  readonly classes: readonly string[];

  constructor(classes: readonly string[]) {
    super(`log capacity failed for: ${classes.join(', ')}`);
    this.name = 'LogCapacityRunFailed';
    this.classes = classes;
  }
}

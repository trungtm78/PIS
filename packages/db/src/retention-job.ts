import { randomUUID } from 'node:crypto';
import { NOOP_METRICS, TECHNICAL_CLASSES, addYears, parseObjectKey, recordKindOf, technicalCutoff, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink, TechnicalClass, TenantContext } from '@machvon/kernel';
import { AuditWriter } from './audit-writer.ts';
import { RetentionPolicyStore } from './retention-policy-store.ts';
import type { RetentionPolicyRow } from './retention-policy-store.ts';
import { BUSINESS_SOURCES } from './retention-sources.ts';
import type { TenantDatabase, TenantTx } from './tenant-database.ts';

const DAY_MS = 86_400_000;
/** The metadata of an inbox event stays two years: the key that rejects a repeated delivery outlives the payload (BR-ADM-11). */
const INBOX_METADATA_DAYS = 730;
const BATCH_ROWS = 5000;
const MAX_BATCHES = 20;
const CANDIDATES_PER_CLASS = 1000;

/** Gauges of the last run of a tenant, by record class: the rows removed, the records listed for review and those a hold kept off. */
export const RETENTION_PURGED_METRIC = 'retention_purged_rows';
export const RETENTION_LISTED_METRIC = 'retention_review_listed_rows';
export const RETENTION_HELD_METRIC = 'retention_skipped_held_rows';
export const RETENTION_PENDING_GAUGE = 'retention_review_pending_gauge';
export const RETENTION_PAYLOAD_FAILED_METRIC = 'retention_payload_remove_failed_total';

/** Removes the stored file a reference names; false when there was none. The reference of an inbox payload is a key of the object store. */
export interface PayloadRemover {
  remove(tenant: TenantContext, key: string): Promise<boolean>;
}

export interface RetentionRunResult {
  /** Rows removed (or payloads emptied) per technical class. */
  purged: Record<string, number>;
  /** Items put on the review list per business class. */
  listed: Record<string, number>;
  /** Records skipped because a legal hold contains them, per class. */
  skippedHeld: Record<string, number>;
  /** Business classes that have a policy in force but no records the job can read yet (`class` or `class:basis`). */
  noSource: string[];
  /** Items waiting for a decision after this run. */
  pending: number;
}

/** One or more classes failed in a run; the others were still processed. Names the classes only, never a message. */
export class RetentionRunFailed extends Error {
  readonly classes: readonly string[];

  constructor(classes: readonly string[]) {
    super(`retention failed for: ${classes.join(', ')}`);
    this.name = 'RetentionRunFailed';
    this.classes = classes;
  }
}

export interface RetentionJobOptions {
  metrics?: MetricsSink;
  /** Removes the payload files of purged inbox events; without it a payload is emptied only when it names no stored file. */
  payloads?: PayloadRemover;
}

const heldFilter = (type: string, id: string): string => `not machvon.legal_hold_blocks(${type}, ${id})`;

/**
 * The daily retention run of one tenant (ST-ADM-017, ADM 3.12, BR-ADM-11). Technical classes are removed once they have outlived their
 * period (the platform period, or the years of the tenant's policy when longer); a record a legal hold contains is never touched.
 * Business classes are never removed: a record whose period has run out is put on the review list once, for a person to decide.
 * Each class runs in a transaction of its own, so one failing class does not stop the others; the run then fails naming the classes.
 */
export class RetentionJob {
  private readonly policies = new RetentionPolicyStore();
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;
  private readonly payloads: PayloadRemover | undefined;
  private readonly database: TenantDatabase;

  constructor(database: TenantDatabase, options: RetentionJobOptions = {}) {
    this.database = database;
    this.audit = new AuditWriter(database);
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.payloads = options.payloads;
  }

  async run(ctx: TenantContext, now: Date = new Date()): Promise<RetentionRunResult> {
    const result: RetentionRunResult = { purged: {}, listed: {}, skippedHeld: {}, noSource: [], pending: 0 };
    const failed: string[] = [];
    const inPolicy = await this.database.withTenant(ctx, (tx) => this.policies.published(tx));
    const attempt = async (name: string, work: (tx: TenantTx) => Promise<void>): Promise<void> => {
      try {
        await this.database.withTenant(ctx, work);
      } catch {
        failed.push(name);
      }
    };

    for (const recordClass of TECHNICAL_CLASSES) {
      const policy = inPolicy.get(recordClass);
      const cutoff = technicalCutoff(recordClass, recordClass === 'idempotency_record' ? undefined : policyOf(policy), now);
      if (cutoff === undefined) continue;
      await attempt(recordClass, async (tx) => {
        const purged = await this.purge(tx, ctx, recordClass, cutoff, policy, now);
        if (purged > 0) {
          result.purged[recordClass] = purged;
          this.metrics.gauge(RETENTION_PURGED_METRIC, purged, { record_class: recordClass, tenant_id: ctx.tenantId });
          await this.record(tx, ctx, 'retention.purged', { record_class: recordClass, rows: purged, cutoff: cutoff.toISOString() });
        }
      });
    }

    const today = vietnamDateOf(now);
    for (const [recordClass, policy] of inPolicy) {
      if (recordKindOf(recordClass) !== 'BUSINESS' || policy.retentionBasis === 'PERMANENT' || policy.retentionYears === null) continue;
      const source = BUSINESS_SOURCES[recordClass];
      const sql = source?.candidates(policy.retentionBasis);
      if (source === undefined || sql === undefined) {
        result.noSource.push(source === undefined ? recordClass : `${recordClass}:${policy.retentionBasis}`);
        continue;
      }
      await attempt(recordClass, async (tx) => {
        const outcome = await this.list(tx, recordClass, policy, { resourceType: source.resourceType, candidates: sql, heldSql: source.heldSql }, today);
        if (outcome.skippedHeld > 0) {
          result.skippedHeld[recordClass] = outcome.skippedHeld;
          this.metrics.gauge(RETENTION_HELD_METRIC, outcome.skippedHeld, { record_class: recordClass, tenant_id: ctx.tenantId });
        }
        if (outcome.listed > 0) {
          result.listed[recordClass] = outcome.listed;
          this.metrics.gauge(RETENTION_LISTED_METRIC, outcome.listed, { record_class: recordClass, tenant_id: ctx.tenantId });
          await this.record(tx, ctx, 'retention.review_listed', { record_class: recordClass, items: outcome.listed, policy_id: policy.id, skipped_held: outcome.skippedHeld });
        }
      });
    }

    await attempt('pending', async (tx) => {
      const [row] = await tx.query<{ n: string }>('select count(*)::text as n from machvon.retention_review_item');
      result.pending = Number(row?.n ?? 0);
    });
    if (failed.length > 0) throw new RetentionRunFailed(failed);
    return result;
  }

  private async record(tx: TenantTx, ctx: TenantContext, action: string, diff: Record<string, unknown>): Promise<void> {
    const correlation = randomUUID();
    await this.audit.recordInTx(tx, ctx.membershipId, {
      action,
      resourceType: 'data_retention_policy',
      resourceId: ctx.tenantId,
      diff,
      correlationId: correlation,
      requestId: correlation,
      classification: 'INTERNAL',
    });
  }

  /** Removes what a technical class has outlived, a batch at a time, and returns how many rows went. */
  private async purge(tx: TenantTx, ctx: TenantContext, recordClass: TechnicalClass, cutoff: Date, policy: RetentionPolicyRow | undefined, now: Date): Promise<number> {
    switch (recordClass) {
      case 'idempotency_record':
        // The hourly job removes a key when it expires (at most 7 days after it was made); this is its safety net, and a longer policy cannot keep a key that is no longer honoured.
        return this.deleteBatches(
          tx,
          `delete from machvon.idempotency_record using (select ctid as c from machvon.idempotency_record
             where created_at < $1::timestamptz and expires_at <= now() and ${heldFilter('resource_type', 'resource_id')} limit $2) doomed
           where idempotency_record.ctid = doomed.c returning 1`,
          cutoff,
        );
      case 'outbox_event':
        return this.deleteBatches(
          tx,
          `delete from machvon.outbox_event using (select ctid as c from machvon.outbox_event
             where status = 'PUBLISHED' and published_at < $1::timestamptz and ${heldFilter('aggregate_type', 'aggregate_id')} limit $2) doomed
           where outbox_event.ctid = doomed.c returning 1`,
          cutoff,
        );
      case 'user_session':
        return this.deleteBatches(
          tx,
          `delete from machvon.user_session using (select ctid as c from machvon.user_session
             where coalesce(revoked_at, last_seen_at) < $1::timestamptz and ${heldFilter("'user_session'", 'null::uuid')} limit $2) doomed
           where user_session.ctid = doomed.c returning 1`,
          cutoff,
        );
      case 'delivery_attempt':
        return this.deleteBatches(
          tx,
          `delete from machvon.delivery_attempt using (select ctid as c from machvon.delivery_attempt
             where created_at < $1::timestamptz and ${heldFilter("'delivery_attempt'", 'null::uuid')} limit $2) doomed
           where delivery_attempt.ctid = doomed.c returning 1`,
          cutoff,
        );
      case 'integration_event_inbox': {
        const payloads = await this.emptyPayloads(tx, ctx, cutoff);
        const metadataCutoff = new Date(now.getTime() - Math.max(INBOX_METADATA_DAYS, (policy?.retentionYears ?? 0) * 365) * DAY_MS);
        const metadata = await this.deleteBatches(
          tx,
          `delete from machvon.integration_event_inbox using (select ctid as c from machvon.integration_event_inbox
             where status in ('PROCESSED', 'DEAD') and payload_reference is null and received_at < $1::timestamptz and ${heldFilter("'integration_event_inbox'", 'null::uuid')} limit $2) doomed
           where integration_event_inbox.ctid = doomed.c returning 1`,
          metadataCutoff,
        );
        return payloads + metadata;
      }
    }
  }

  private async deleteBatches(tx: TenantTx, sql: string, cutoff: Date): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const rows = await tx.query(sql, [cutoff.toISOString(), BATCH_ROWS]);
      total += rows.length;
      if (rows.length < BATCH_ROWS) break;
    }
    return total;
  }

  /**
   * Empties the payload of the events that finished (processed, or dead) and are older than the cutoff: the stored file goes first, then the
   * reference, so a failure to remove the file leaves the event as it was for the next run. A tenant hold keeps every payload.
   */
  private async emptyPayloads(tx: TenantTx, ctx: TenantContext, cutoff: Date): Promise<number> {
    const candidates = await tx.query<{ id: string; payload_reference: string }>(
      `select id, payload_reference from machvon.integration_event_inbox
        where status in ('PROCESSED', 'DEAD') and payload_reference is not null and received_at < $1::timestamptz
          and ${heldFilter("'integration_event_inbox'", 'null::uuid')}
        order by received_at, id limit $2`,
      [cutoff.toISOString(), BATCH_ROWS],
    );
    let emptied = 0;
    for (const candidate of candidates) {
      if (this.payloads !== undefined && parseObjectKey(candidate.payload_reference) !== undefined) {
        try {
          await this.payloads.remove(ctx, candidate.payload_reference);
        } catch {
          this.metrics.increment(RETENTION_PAYLOAD_FAILED_METRIC, { tenant_id: ctx.tenantId });
          continue;
        }
      }
      await tx.query("update machvon.integration_event_inbox set payload_reference = null, payload_purged_at = now() where id = $1::uuid", [candidate.id]);
      emptied += 1;
    }
    return emptied;
  }

  /** Puts the records of a class whose period has run out on the review list, once, and counts those a hold keeps off. */
  private async list(
    tx: TenantTx,
    recordClass: string,
    policy: RetentionPolicyRow,
    source: { resourceType: string; candidates: string; heldSql: string | undefined },
    today: string,
  ): Promise<{ listed: number; skippedHeld: number }> {
    const years = policy.retentionYears as number;
    const due = await tx.query<{ id: string; basis_date: string }>(
      `select c.id, c.basis_date::text as basis_date
         from (${source.candidates}) c
        where (c.basis_date + make_interval(years => $1::int))::date <= $2::date
          and not exists (select 1 from machvon.retention_review_item i where i.record_class = $3 and i.resource_id = c.id)
        order by c.basis_date, c.id
        limit $4`,
      [years, today, recordClass, CANDIDATES_PER_CLASS],
    );
    let listed = 0;
    let skippedHeld = 0;
    for (const record of due) {
      const held =
        source.heldSql === undefined
          ? (await tx.query<{ held: boolean }>('select machvon.legal_hold_blocks($1::text, $2::uuid) as held', [source.resourceType, record.id]))[0]?.held === true
          : (await tx.query<{ held: boolean }>(source.heldSql, [record.id]))[0]?.held === true;
      if (held) {
        skippedHeld += 1;
        continue;
      }
      await tx.query(
        `insert into machvon.retention_review_item (tenant_id, id, record_class, resource_type, resource_id, policy_id, basis_date, due_on, end_action)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3::uuid, $4::uuid, $5::date, $6::date, $7)
         on conflict (tenant_id, record_class, resource_id) do nothing`,
        [recordClass, source.resourceType, record.id, policy.id, record.basis_date, addYears(record.basis_date, years), policy.endAction],
      );
      listed += 1;
    }
    return { listed, skippedHeld };
  }
}

function policyOf(policy: RetentionPolicyRow | undefined): { years: number | undefined; permanent: boolean } | undefined {
  if (policy === undefined) return undefined;
  return { years: policy.retentionYears ?? undefined, permanent: policy.retentionBasis === 'PERMANENT' };
}

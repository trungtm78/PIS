import { itemKey } from '@machvon/kernel';
import type { ObservationDecision, ObservedItem } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/** What the pass knows about an item it produced: the columns the observation keeps current. */
export interface ObservedMeta {
  kind: string;
  alertTypeCode: string | null;
  severity: string;
  causeKey: string | null;
}

export interface ApplyResult {
  opened: number;
  touched: number;
  reopened: number;
  closed: number;
  /** Open items whose source did not answer: nothing was said about them. */
  unknown: number;
}

export interface ClosureRow {
  id: string;
  source: string;
  sourceId: string;
  kind: string;
  alertTypeCode: string | null;
  severity: string;
  state: 'OPEN' | 'RESOLVED_BY_SYSTEM';
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  reopenCount: number;
  lastReopenedAt: string | null;
  decisionsBeforeClose: number | null;
}

export interface ClosureFilter {
  state?: 'OPEN' | 'RESOLVED_BY_SYSTEM' | undefined;
  /** Only the items the system closed with no decision of any person. */
  withoutRecord?: boolean | undefined;
  /** Only the items that were reopened at least once. */
  reopened?: boolean | undefined;
  alertTypeCode?: string | undefined;
  limit: number;
  /** The keyset: the `(sort time, id)` of the last row of the previous page. */
  after?: { at: string; id: string } | undefined;
}

export interface ClosureSummary {
  from: string;
  to: string;
  openNow: number;
  closedBySystem: number;
  reopened: number;
  closedWithoutRecord: number;
  /** Median hours from first seen to closed, over the items closed in the period; null when none closed. */
  medianHoursOpen: number | null;
  byType: Array<{ alertTypeCode: string; closed: number; reopened: number; withoutRecord: number }>;
}

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const CHUNK = 500;

interface Row {
  id: string;
  source: string;
  source_id: string;
  kind: string;
  alert_type_code: string | null;
  severity: string;
  state: 'OPEN' | 'RESOLVED_BY_SYSTEM';
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
  reopen_count: number;
  last_reopened_at: string | null;
  decisions_before_close: number | null;
}

const COLUMNS = `o.id, o.source, o.source_id, o.kind, o.alert_type_code, o.severity, o.state, ${ISO('o.first_seen_at')} as first_seen_at, ${ISO('o.last_seen_at')} as last_seen_at, ${ISO('o.closed_at')} as closed_at,
  o.reopen_count, ${ISO('o.last_reopened_at')} as last_reopened_at, o.decisions_before_close`;

const toRow = (row: Row): ClosureRow => ({
  id: row.id,
  source: row.source,
  sourceId: row.source_id,
  kind: row.kind,
  alertTypeCode: row.alert_type_code,
  severity: row.severity,
  state: row.state,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
  closedAt: row.closed_at,
  reopenCount: row.reopen_count,
  lastReopenedAt: row.last_reopened_at,
  decisionsBeforeClose: row.decisions_before_close,
});

const chunks = <T>(list: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < list.length; at += CHUNK) out.push(list.slice(at, at + CHUNK));
  return out;
};

/**
 * What the alert centre has seen and when it stopped seeing it (G2-8). The pass decides (kernel `observationDecision`); this store writes the decision: each change is one row of `alert_observation_event` keyed by the pass,
 * so a pass that runs twice records each change once, and the counters of the observation move only when the event is new.
 */
export class AlertObservationStore {
  /** Everything the store knows (the state of each item), for a pass to compare with what it produced. */
  async known(tx: TenantTx): Promise<ObservedItem[]> {
    const rows = await tx.query<{ source: string; source_id: string; state: 'OPEN' | 'RESOLVED_BY_SYSTEM' }>('select source, source_id, state from machvon.alert_observation order by source, source_id');
    return rows.map((row) => ({ source: row.source, sourceId: row.source_id, state: row.state }));
  }

  /** How many decisions of people (claims, assignments, snoozes, pauses) each item has: 0 is an item nobody touched. */
  async decisionCounts(tx: TenantTx, items: ReadonlyArray<{ source: string; sourceId: string }>): Promise<Map<string, number>> {
    const counts = new Map<string, number>(items.map((item) => [itemKey(item.source, item.sourceId), 0]));
    for (const part of chunks(items)) {
      const rows = await tx.query<{ source: string; source_id: string; n: string }>(
        `select w.source, w.source_id, count(*)::text as n from machvon.work_action w
          where (w.source, w.source_id) in (select * from unnest($1::text[], $2::text[])) group by w.source, w.source_id`,
        [part.map((item) => item.source), part.map((item) => item.sourceId)],
      );
      for (const row of rows) counts.set(itemKey(row.source, row.source_id), Number(row.n));
    }
    return counts;
  }

  /** Writes the decision of one pass. `meta` has the current facts of every produced item; `passKey` names the pass (the day and the half hour, for example). */
  async apply(tx: TenantTx, decision: ObservationDecision, meta: ReadonlyMap<string, ObservedMeta>, now: Date, passKey: string): Promise<ApplyResult> {
    const result: ApplyResult = { opened: 0, touched: 0, reopened: 0, closed: 0, unknown: decision.unknown.length };
    const at = now.toISOString();
    const metaOf = (item: { source: string; sourceId: string }): ObservedMeta => meta.get(itemKey(item.source, item.sourceId)) ?? { kind: item.source, alertTypeCode: null, severity: 'ACTION', causeKey: null };
    for (const part of chunks(decision.open)) {
      const values = part.map(metaOf);
      const inserted = await tx.query<{ id: string }>(
        `insert into machvon.alert_observation (tenant_id, source, source_id, kind, alert_type_code, severity, cause_key, first_seen_at, last_seen_at)
         select nullif(current_setting('app.tenant_id', true), '')::uuid, v.source, v.source_id, v.kind, v.type_code, v.severity, v.cause_key, $7::timestamptz, $7::timestamptz
           from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) as v(source, source_id, kind, type_code, severity, cause_key)
         on conflict (tenant_id, source, source_id) do nothing returning id`,
        [part.map((item) => item.source), part.map((item) => item.sourceId), values.map((m) => m.kind), values.map((m) => m.alertTypeCode), values.map((m) => m.severity), values.map((m) => m.causeKey), at],
      );
      result.opened += inserted.length;
      await this.events(tx, inserted.map((row) => row.id), 'OPENED', at, passKey);
    }
    for (const part of chunks(decision.touch)) {
      const values = part.map(metaOf);
      await tx.query(
        `update machvon.alert_observation o set last_seen_at = $7::timestamptz, kind = v.kind, alert_type_code = v.type_code, severity = v.severity, cause_key = v.cause_key
           from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) as v(source, source_id, kind, type_code, severity, cause_key)
          where o.source = v.source and o.source_id = v.source_id and o.state = 'OPEN'`,
        [part.map((item) => item.source), part.map((item) => item.sourceId), values.map((m) => m.kind), values.map((m) => m.alertTypeCode), values.map((m) => m.severity), values.map((m) => m.causeKey), at],
      );
      result.touched += part.length;
    }
    for (const part of chunks(decision.reopen)) {
      const values = part.map(metaOf);
      const reopened = await tx.query<{ id: string }>(
        `update machvon.alert_observation o set state = 'OPEN', closed_at = null, decisions_before_close = null, last_seen_at = $7::timestamptz, last_reopened_at = $7::timestamptz, reopen_count = o.reopen_count + 1, version = o.version + 1,
                kind = v.kind, alert_type_code = v.type_code, severity = v.severity, cause_key = v.cause_key
           from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) as v(source, source_id, kind, type_code, severity, cause_key)
          where o.source = v.source and o.source_id = v.source_id and o.state = 'RESOLVED_BY_SYSTEM' returning o.id`,
        [part.map((item) => item.source), part.map((item) => item.sourceId), values.map((m) => m.kind), values.map((m) => m.alertTypeCode), values.map((m) => m.severity), values.map((m) => m.causeKey), at],
      );
      result.reopened += reopened.length;
      await this.events(tx, reopened.map((row) => row.id), 'REOPENED', at, passKey);
    }
    if (decision.close.length > 0) {
      const counts = await this.decisionCounts(tx, decision.close);
      for (const part of chunks(decision.close)) {
        const closed = await tx.query<{ id: string }>(
          `update machvon.alert_observation o set state = 'RESOLVED_BY_SYSTEM', closed_at = $4::timestamptz, decisions_before_close = v.decisions, version = o.version + 1
             from unnest($1::text[], $2::text[], $3::int[]) as v(source, source_id, decisions)
            where o.source = v.source and o.source_id = v.source_id and o.state = 'OPEN' returning o.id`,
          [part.map((item) => item.source), part.map((item) => item.sourceId), part.map((item) => counts.get(itemKey(item.source, item.sourceId)) ?? 0), at],
        );
        result.closed += closed.length;
        await this.events(tx, closed.map((row) => row.id), 'CLOSED', at, passKey);
      }
    }
    return result;
  }

  private async events(tx: TenantTx, ids: readonly string[], type: 'OPENED' | 'CLOSED' | 'REOPENED', at: string, passKey: string): Promise<void> {
    for (const part of chunks(ids)) {
      await tx.query(
        `insert into machvon.alert_observation_event (tenant_id, observation_id, event_type, occurred_at, pass_key)
         select nullif(current_setting('app.tenant_id', true), '')::uuid, v.id, $2, $3::timestamptz, $4 from unnest($1::uuid[]) as v(id)
         on conflict (tenant_id, observation_id, pass_key, event_type) do nothing`,
        [part, type, at, passKey],
      );
    }
  }

  /** The items of the report, newest change first; the keyset is (time of the last change, id). */
  async list(tx: TenantTx, filter: ClosureFilter): Promise<ClosureRow[]> {
    const params: unknown[] = [];
    const add = (value: unknown): string => `$${params.push(value)}`;
    const where: string[] = [];
    if (filter.state !== undefined) where.push(`o.state = ${add(filter.state)}`);
    if (filter.withoutRecord === true) where.push(`o.state = 'RESOLVED_BY_SYSTEM' and o.decisions_before_close = 0`);
    if (filter.reopened === true) where.push('o.reopen_count > 0');
    if (filter.alertTypeCode !== undefined) where.push(`o.alert_type_code = ${add(filter.alertTypeCode)}`);
    const sort = 'coalesce(o.closed_at, o.last_seen_at)';
    if (filter.after !== undefined) {
      where.push(`(${sort}, o.id) < (${add(filter.after.at)}::timestamptz, ${add(filter.after.id)}::uuid)`);
    }
    const limit = add(filter.limit);
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from machvon.alert_observation o ${where.length === 0 ? '' : `where ${where.join(' and ')}`} order by ${sort} desc, o.id desc limit ${limit}`,
      params,
    );
    return rows.map(toRow);
  }

  /** The figures of the closing of alerts over a period of days (inclusive of the first, exclusive of the last): measured from the events, never from a counter. */
  async summary(tx: TenantTx, from: string, to: string): Promise<ClosureSummary> {
    const [totals] = await tx.query<{ open_now: string; closed: string; reopened: string; without_record: string; median_hours: string | null }>(
      `select (select count(*) from machvon.alert_observation where state = 'OPEN')::text as open_now,
              (select count(*) from machvon.alert_observation_event where event_type = 'CLOSED' and occurred_at >= $1::date and occurred_at < $2::date)::text as closed,
              (select count(*) from machvon.alert_observation_event where event_type = 'REOPENED' and occurred_at >= $1::date and occurred_at < $2::date)::text as reopened,
              (select count(*) from machvon.alert_observation where state = 'RESOLVED_BY_SYSTEM' and decisions_before_close = 0 and closed_at >= $1::date and closed_at < $2::date)::text as without_record,
              (select (percentile_cont(0.5) within group (order by extract(epoch from (closed_at - first_seen_at)) / 3600))::text from machvon.alert_observation where state = 'RESOLVED_BY_SYSTEM' and closed_at >= $1::date and closed_at < $2::date) as median_hours`,
      [from, to],
    );
    const types = await tx.query<{ code: string; closed: string; reopened: string; without_record: string }>(
      `select coalesce(o.alert_type_code, o.kind) as code,
              count(*) filter (where e.event_type = 'CLOSED')::text as closed,
              count(*) filter (where e.event_type = 'REOPENED')::text as reopened,
              count(*) filter (where e.event_type = 'CLOSED' and o.decisions_before_close = 0)::text as without_record
         from machvon.alert_observation_event e join machvon.alert_observation o on o.tenant_id = e.tenant_id and o.id = e.observation_id
        where e.event_type in ('CLOSED', 'REOPENED') and e.occurred_at >= $1::date and e.occurred_at < $2::date
        group by 1 order by 2 desc, 1`,
      [from, to],
    );
    const t = totals as { open_now: string; closed: string; reopened: string; without_record: string; median_hours: string | null };
    return {
      from,
      to,
      openNow: Number(t.open_now),
      closedBySystem: Number(t.closed),
      reopened: Number(t.reopened),
      closedWithoutRecord: Number(t.without_record),
      medianHoursOpen: t.median_hours === null ? null : Math.round(Number(t.median_hours) * 10) / 10,
      byType: types.map((row) => ({ alertTypeCode: row.code, closed: Number(row.closed), reopened: Number(row.reopened), withoutRecord: Number(row.without_record) })),
    };
  }

  /** The first time each item was seen, for the items asked about (the flood rules count what is new). */
  async firstSeen(tx: TenantTx, items: ReadonlyArray<{ source: string; sourceId: string }>): Promise<Map<string, string>> {
    const seen = new Map<string, string>();
    for (const part of chunks(items)) {
      const rows = await tx.query<{ source: string; source_id: string; first_seen_at: string }>(
        `select o.source, o.source_id, ${ISO('o.first_seen_at')} as first_seen_at from machvon.alert_observation o
          where (o.source, o.source_id) in (select * from unnest($1::text[], $2::text[]))`,
        [part.map((item) => item.source), part.map((item) => item.sourceId)],
      );
      for (const row of rows) seen.set(itemKey(row.source, row.source_id), row.first_seen_at);
    }
    return seen;
  }
}

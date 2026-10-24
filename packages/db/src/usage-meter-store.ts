import { DomainError, usageMeterOf, usageWindowOf } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export interface RecordUsageInput {
  meter: string;
  externalEventKey: string;
  /** A positive decimal of at most six places, as text. */
  quantity: string;
  unit?: string | undefined;
  occurredAt: Date;
  sourceReference: string;
  /** The clock of the caller: an event cannot have happened after it (plus the skew that is allowed). */
  now: Date;
}

export interface RecordedUsage {
  eventId: string;
  /** True when the event key was already recorded: the answer is the first event and nothing was added. */
  replayed: boolean;
  /** The counter the event fed and its window, with what the counter holds now. */
  counter: string;
  windowStart: Date;
  windowEnd: Date;
  used: string;
}

export interface UsageEventRow {
  id: string;
  meter: string;
  externalEventKey: string;
  quantity: string;
  unit: string;
  occurredAt: Date;
  sourceReference: string;
  recordedAt: Date;
}

export interface UsageCounterRow {
  counter: string;
  windowStart: Date;
  windowEnd: Date;
  used: string;
}

export interface ListUsageEventsInput {
  meter?: string | undefined;
  from?: Date | undefined;
  until?: Date | undefined;
  limit: number;
  /** The last event of the page before. */
  after?: { occurredAt: Date; id: string } | undefined;
}

interface EventDbRow {
  id: string;
  meter: string;
  external_event_key: string;
  quantity: string;
  unit: string;
  occurred_at: Date;
  source_reference: string;
  recorded_at: Date;
}

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const EVENT_COLUMNS = 'id, meter, external_event_key, trim_scale(quantity)::text as quantity, unit, occurred_at, source_reference, recorded_at';
const QUANTITY_PATTERN = /^[0-9]{1,18}(\.[0-9]{1,6})?$/;
const MAX_KEY = 200;
const MAX_SOURCE = 500;
/** The clock of a sender may run ahead of ours by this much; an event further ahead has not happened. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

const INSERT_EVENT_SQL = `insert into machvon.usage_meter_event (tenant_id, id, meter, external_event_key, quantity, occurred_at, source_reference, unit)
  values (${TENANT}, gen_random_uuid(), $1, $2, $3::numeric, $4, $5, $6)
  on conflict (tenant_id, meter, external_event_key) do nothing
  returning id`;
const FIND_EVENT_SQL = 'select id from machvon.usage_meter_event where meter = $1 and external_event_key = $2';
const ADD_SQL = `insert into machvon.usage_counter (tenant_id, id, feature_code, window_start, window_end, used_value)
  values (${TENANT}, gen_random_uuid(), $1, $2, $3, $4::numeric)
  on conflict (tenant_id, feature_code, window_start)
  do update set used_value = usage_counter.used_value + excluded.used_value, version = usage_counter.version + 1
  returning trim_scale(used_value)::text as used`;
const SUBTRACT_SQL = `update machvon.usage_counter set used_value = used_value - $3::numeric, version = version + 1
  where feature_code = $1 and window_start = $2
  returning trim_scale(used_value)::text as used`;
const USED_SQL = 'select trim_scale(used_value)::text as used from machvon.usage_counter where feature_code = $1 and window_start = $2';
const HELD_SQL = 'select used_value >= $3::numeric as enough from machvon.usage_counter where feature_code = $1 and window_start = $2 for update';
const COUNTERS_AT_SQL = `select feature_code, window_start, window_end, trim_scale(used_value)::text as used from machvon.usage_counter
  where window_start <= $1 and $1 < window_end order by feature_code`;
const LIST_SQL = `select ${EVENT_COLUMNS} from machvon.usage_meter_event
  where ($1::text is null or meter = $1)
    and ($2::timestamptz is null or occurred_at >= $2)
    and ($3::timestamptz is null or occurred_at < $3)
    and ($4::uuid is null or (occurred_at, id) < (select a.occurred_at, a.id from machvon.usage_meter_event a where a.id = $4::uuid))
  order by occurred_at desc, id desc
  limit $5`;
const GET_SQL = `select ${EVENT_COLUMNS} from machvon.usage_meter_event where id = $1::uuid`;

const eventOf = (row: EventDbRow): UsageEventRow => ({
  id: row.id,
  meter: row.meter,
  externalEventKey: row.external_event_key,
  quantity: row.quantity,
  unit: row.unit,
  occurredAt: row.occurred_at,
  sourceReference: row.source_reference,
  recordedAt: row.recorded_at,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/**
 * Usage events and the counters they feed (ST-SAS-010, SAS.md BR-SAS-09 and BR-SAS-15). An event is insert-only (V1481), and the same
 * `external_event_key` of a meter is one event however often and however many at once it is sent: the unique key decides, the first
 * writer adds to the counter and every other gets the first event back, so the counter is never fed twice by one event. A counter is
 * kept per calendar month (UTC) of the time the event happened; its row is locked by the update that adds to it, so concurrent events
 * of one counter add up without loss. A mistake is taken back by an event of the correction meter, which subtracts from the counter
 * and can never take it below zero.
 */
export class UsageMeterStore {
  async record(tx: TenantTx, input: RecordUsageInput): Promise<RecordedUsage> {
    const meter = usageMeterOf(input.meter);
    if (meter === undefined) throw new DomainError('METER_UNKNOWN', 422, 'meter');
    const key = input.externalEventKey.trim();
    if (key === '' || key.length > MAX_KEY) throw invalid('external_event_key');
    const source = input.sourceReference.trim();
    if (source === '' || source.length > MAX_SOURCE) throw invalid('source_reference');
    if (!QUANTITY_PATTERN.test(input.quantity) || Number(input.quantity) === 0) throw invalid('quantity');
    if (input.unit !== undefined && input.unit !== meter.unit) throw invalid('unit');
    if (input.occurredAt.getTime() > input.now.getTime() + MAX_CLOCK_SKEW_MS) throw invalid('occurred_at');

    const window = usageWindowOf(input.occurredAt);
    const inserted = await tx.query<{ id: string }>(INSERT_EVENT_SQL, [meter.code, key, input.quantity, input.occurredAt, source, meter.unit]);
    const first = inserted[0];
    if (first === undefined) {
      // The key was recorded before (or by a writer that has just committed): the answer is that event and the counter keeps what it has.
      const [existing] = await tx.query<{ id: string }>(FIND_EVENT_SQL, [meter.code, key]);
      if (existing === undefined) throw new Error('the usage event that holds the key was not found');
      const [counters] = await tx.query<{ used: string }>(USED_SQL, [meter.counter, window.start]);
      return { eventId: existing.id, replayed: true, counter: meter.counter, windowStart: window.start, windowEnd: window.end, used: counters?.used ?? '0' };
    }
    const used = meter.direction === 'ADD' ? await this.add(tx, meter.counter, window, input.quantity) : await this.subtract(tx, meter.counter, window.start, input.quantity);
    return { eventId: first.id, replayed: false, counter: meter.counter, windowStart: window.start, windowEnd: window.end, used };
  }

  /** The counters whose window holds `at`, by counter. */
  async countersAt(tx: TenantTx, at: Date): Promise<UsageCounterRow[]> {
    const rows = await tx.query<{ feature_code: string; window_start: Date; window_end: Date; used: string }>(COUNTERS_AT_SQL, [at]);
    return rows.map((row) => ({ counter: row.feature_code, windowStart: row.window_start, windowEnd: row.window_end, used: row.used }));
  }

  /** Events, the latest to happen first; the order is total (a time, then the id), so a keyset page never repeats or skips one. */
  async listEvents(tx: TenantTx, input: ListUsageEventsInput): Promise<UsageEventRow[]> {
    const rows = await tx.query<EventDbRow>(LIST_SQL, [input.meter ?? null, input.from ?? null, input.until ?? null, input.after?.id ?? null, input.limit]);
    return rows.map(eventOf);
  }

  async readEvent(tx: TenantTx, id: string): Promise<UsageEventRow | undefined> {
    const [row] = await tx.query<EventDbRow>(GET_SQL, [id]);
    return row === undefined ? undefined : eventOf(row);
  }

  private async add(tx: TenantTx, counter: string, window: { start: Date; end: Date }, quantity: string): Promise<string> {
    const [row] = await tx.query<{ used: string }>(ADD_SQL, [counter, window.start, window.end, quantity]);
    if (row === undefined) throw new Error('the counter that was fed was not returned');
    return row.used;
  }

  private async subtract(tx: TenantTx, counter: string, windowStart: Date, quantity: string): Promise<string> {
    // A correction can only take away what the counter holds: nothing to correct, or more than it holds, is a mistake of the correction itself.
    const [held] = await tx.query<{ enough: boolean }>(HELD_SQL, [counter, windowStart, quantity]);
    if (held?.enough !== true) throw invalid('quantity');
    const [row] = await tx.query<{ used: string }>(SUBTRACT_SQL, [counter, windowStart, quantity]);
    if (row === undefined) throw new Error('the counter that was corrected was not returned');
    return row.used;
  }
}

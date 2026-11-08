import type { ReminderKind } from '@machvon/kernel';
import { actionKey } from './home-work-action-store.ts';
import type { WorkSeverity } from './home-work-rules.ts';
import type { TenantTx } from './tenant-database.ts';

export type ReminderAudience = 'OWNER' | 'NEXT_LEVEL';

/** One reminder, or one notice to the next level, as the alert centre records it (G2-4, G2-1, G2-2). */
export interface ReminderRecord {
  source: string;
  sourceId: string;
  kind: ReminderKind;
  audience: ReminderAudience;
  /** The owner the reminder is for, when it is known (always for a reminder). */
  recipient: string | null;
  severity: WorkSeverity;
  ordinal: number;
  /** The one reminder of a series: recording it twice records it once. */
  seriesKey: string;
  /** When the cadence made it due. */
  dueAt: Date;
  cadenceWorkingHours: number | null;
  policyVersion: string;
  /** The decision it follows from (the last allowed snooze). */
  actionId?: string | undefined;
}

export interface ReminderSummary {
  sent: number;
  lastAt: string | null;
}

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const CHUNK = 1000;

/** The reminder series key of an item, a person and the number of the reminder. */
export const reminderSeriesKey = (source: string, sourceId: string, recipient: string, ordinal: number): string => `REMINDER:${source}:${sourceId}:${recipient.toLowerCase()}:${ordinal}`.slice(0, 200);

/**
 * Every reminder the alert centre makes is a row of `work_reminder` (append-only), so that it can be counted against the cap of the policy, shown on the item and explained afterwards. The row and the event that carries
 * it are written by the same transaction; `series_key` makes a pass that runs twice, or two that run at once, record a reminder once.
 */
export class HomeWorkReminderStore {
  /** Records a reminder; `created` is false when the series already had it (the pass is idempotent). */
  async record(tx: TenantTx, input: ReminderRecord): Promise<{ id: string; created: boolean }> {
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.work_reminder (tenant_id, source, source_id, kind, audience, recipient_membership_id, severity, ordinal, series_key, due_at, cadence_working_hours, policy_version, action_id)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5::uuid, $6, $7::int, $8, $9::timestamptz, $10::int, $11, $12::uuid)
       on conflict (tenant_id, series_key) do nothing
       returning id`,
      [input.source, input.sourceId, input.kind, input.audience, input.recipient, input.severity, input.ordinal, input.seriesKey, input.dueAt.toISOString(), input.cadenceWorkingHours, input.policyVersion, input.actionId ?? null],
    );
    if (inserted[0] !== undefined) return { id: inserted[0].id, created: true };
    const [existing] = await tx.query<{ id: string }>('select id from machvon.work_reminder where series_key = $1', [input.seriesKey]);
    return { id: (existing as { id: string }).id, created: false };
  }

  /** How many reminders each item has had for one person, and when the last was made. An item with none is not in the map. */
  async summary(tx: TenantTx, items: ReadonlyArray<{ source: string; sourceId: string }>, recipient: string): Promise<Map<string, ReminderSummary>> {
    const summary = new Map<string, ReminderSummary>();
    for (let from = 0; from < items.length; from += CHUNK) {
      const chunk = items.slice(from, from + CHUNK);
      const rows = await tx.query<{ source: string; source_id: string; sent: string; last_at: string }>(
        `select r.source, r.source_id, count(*)::text as sent, ${ISO('max(r.created_at)')} as last_at
           from machvon.work_reminder r
           join unnest($1::text[], $2::text[]) as k (source, source_id) on k.source = r.source and k.source_id = r.source_id
          where r.kind = 'REMINDER' and r.recipient_membership_id = $3::uuid
          group by r.source, r.source_id`,
        [chunk.map((item) => item.source), chunk.map((item) => item.sourceId), recipient.toLowerCase()],
      );
      for (const row of rows) summary.set(actionKey(row.source, row.source_id), { sent: Number(row.sent), lastAt: row.last_at });
    }
    return summary;
  }

  /** The notices to the next level an item has had, newest first (what the item shows as "told to the level above"). */
  async notices(tx: TenantTx, items: ReadonlyArray<{ source: string; sourceId: string }>): Promise<Map<string, Array<{ kind: ReminderKind; at: string }>>> {
    const notices = new Map<string, Array<{ kind: ReminderKind; at: string }>>();
    for (let from = 0; from < items.length; from += CHUNK) {
      const chunk = items.slice(from, from + CHUNK);
      const rows = await tx.query<{ source: string; source_id: string; kind: ReminderKind; at: string }>(
        `select r.source, r.source_id, r.kind, ${ISO('r.created_at')} as at
           from machvon.work_reminder r
           join unnest($1::text[], $2::text[]) as k (source, source_id) on k.source = r.source and k.source_id = r.source_id
          where r.audience = 'NEXT_LEVEL'
          order by r.created_at desc, r.id`,
        [chunk.map((item) => item.source), chunk.map((item) => item.sourceId)],
      );
      for (const row of rows) {
        const key = actionKey(row.source, row.source_id);
        notices.set(key, [...(notices.get(key) ?? []), { kind: row.kind, at: row.at }]);
      }
    }
    return notices;
  }
}

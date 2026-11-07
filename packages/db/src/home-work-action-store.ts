import { furtherLifecycle } from './home-work-rules.ts';
import type { WorkLifecycle, WorkSource } from './home-work-rules.ts';
import type { TenantTx } from './tenant-database.ts';

export type WorkActionKind = 'CLAIM' | 'ASSIGN' | 'SNOOZE';

export interface WorkActionInput {
  source: WorkSource;
  sourceId: string;
  action: WorkActionKind;
  actor: string;
  assignee?: string | undefined;
  dueOn?: string | undefined;
  snoozeUntil?: string | undefined;
  reason?: string | undefined;
}

/** What people decided about an item, as the list shows it to one reader. */
export interface WorkActionState {
  claimedBy: { id: string; name: string; at: string } | null;
  assignee: { id: string; name: string; dueOn: string | null } | null;
  /** When an item that somebody put off comes back, while that is still in the future (for any reader). */
  snoozedUntil: string | null;
  /** The reader put it off themselves, and it has not come back yet: it is not on their list. */
  hiddenForReader: boolean;
  lifecycle: WorkLifecycle;
}

export const NO_ACTION_STATE: WorkActionState = { claimedBy: null, assignee: null, snoozedUntil: null, hiddenForReader: false, lifecycle: 'NEW' };

export const actionKey = (source: string, sourceId: string): string => `${source}:${sourceId}`;

interface ActionSql {
  source: string;
  source_id: string;
  action: WorkActionKind;
  actor_membership_id: string;
  assignee_membership_id: string | null;
  due_on: string | null;
  snooze_until: string | null;
  created_at: string;
  actor_name: string | null;
  assignee_name: string | null;
}

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const CHUNK = 1000;

/**
 * What people did about the items of the alert centre (claim, assign, snooze): one row for each decision, appended and never changed (`machvon.work_action`). The state of an item is the latest decision of each kind; the
 * items themselves are read from the tables of the modules by `HomeWorkStore`, which joins this state onto them.
 */
export class HomeWorkActionStore {
  /** Appends a decision in the transaction of the caller; the command writes its audit row and its event in the same one. */
  async record(tx: TenantTx, input: WorkActionInput): Promise<{ id: string; createdAt: string }> {
    const [row] = await tx.query<{ id: string; created_at: string }>(
      `insert into machvon.work_action (tenant_id, source, source_id, action, actor_membership_id, assignee_membership_id, due_on, snooze_until, reason)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4::uuid, $5::uuid, $6::date, $7::timestamptz, $8)
       returning id, ${ISO('created_at')} as created_at`,
      [input.source, input.sourceId, input.action, input.actor, input.assignee ?? null, input.dueOn ?? null, input.snoozeUntil ?? null, input.reason ?? null],
    );
    return { id: (row as { id: string }).id, createdAt: (row as { created_at: string }).created_at };
  }

  /** The state of each item, for the reader who asks; an item nobody did anything about is not in the map. */
  async stateOf(tx: TenantTx, items: ReadonlyArray<{ source: string; sourceId: string }>, reader: string, now: Date): Promise<Map<string, WorkActionState>> {
    const states = new Map<string, WorkActionState>();
    for (let from = 0; from < items.length; from += CHUNK) {
      const chunk = items.slice(from, from + CHUNK);
      const rows = await tx.query<ActionSql>(
        `select a.source, a.source_id, a.action, a.actor_membership_id, a.assignee_membership_id, a.due_on::text as due_on, ${ISO('a.snooze_until')} as snooze_until, ${ISO('a.created_at')} as created_at,
                ad.display_name as actor_name, sd.display_name as assignee_name
           from machvon.work_action a
           join unnest($1::text[], $2::text[]) as k (source, source_id) on k.source = a.source and k.source_id = a.source_id
           left join machvon.tenant_user_directory ad on ad.tenant_id = a.tenant_id and ad.membership_id = a.actor_membership_id
           left join machvon.tenant_user_directory sd on sd.tenant_id = a.tenant_id and sd.membership_id = a.assignee_membership_id
          order by a.created_at, a.id`,
        [chunk.map((item) => item.source), chunk.map((item) => item.sourceId)],
      );
      for (const row of rows) {
        const key = actionKey(row.source, row.source_id);
        const state = states.get(key) ?? { ...NO_ACTION_STATE };
        if (row.action === 'CLAIM') {
          state.claimedBy = { id: row.actor_membership_id, name: row.actor_name ?? '', at: row.created_at };
          state.lifecycle = furtherLifecycle(state.lifecycle, 'CLAIMED');
        } else if (row.action === 'ASSIGN' && row.assignee_membership_id !== null) {
          state.assignee = { id: row.assignee_membership_id, name: row.assignee_name ?? '', dueOn: row.due_on };
          state.lifecycle = furtherLifecycle(state.lifecycle, 'IN_PROGRESS');
        } else if (row.action === 'SNOOZE' && row.snooze_until !== null) {
          const future = Date.parse(row.snooze_until) > now.getTime();
          // The latest decision of a reader about their own list wins over an older one; what another person put off is shown but does not hide the item.
          if (row.actor_membership_id.toLowerCase() === reader.toLowerCase()) {
            state.hiddenForReader = future;
            if (future) state.snoozedUntil = row.snooze_until;
            else if (state.snoozedUntil !== null) state.snoozedUntil = null;
          } else if (future) state.snoozedUntil = row.snooze_until;
        }
        states.set(key, state);
      }
    }
    return states;
  }
}

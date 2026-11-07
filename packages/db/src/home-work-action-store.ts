import type { PauseSpan } from '@machvon/kernel';
import { furtherLifecycle } from './home-work-rules.ts';
import type { WorkLifecycle, WorkSource } from './home-work-rules.ts';
import type { TenantTx } from './tenant-database.ts';

export type WorkActionKind = 'CLAIM' | 'ASSIGN' | 'SNOOZE' | 'PAUSE_CLOCK' | 'RESUME_CLOCK';

export interface WorkActionInput {
  source: WorkSource;
  sourceId: string;
  action: WorkActionKind;
  actor: string;
  assignee?: string | undefined;
  dueOn?: string | undefined;
  snoozeUntil?: string | undefined;
  /** The words of the person (the note of a snooze, the reason of a pause, the plan of a claim). */
  reason?: string | undefined;
  /** G2-1, G2-2: the reason code from the policy, the one who allowed a pause, when a pause lasts until, which snooze of the series this is, whether it was the last allowed, and the version of the rule that decided. */
  reasonCode?: string | undefined;
  allowedBy?: string | undefined;
  pausedUntil?: string | undefined;
  snoozeOrdinal?: number | undefined;
  snoozeFinal?: boolean | undefined;
  policyVersion?: string | undefined;
}

/** What a person said when they put an item off: who, until when, why, which one of the series, and the rule that allowed it. */
export interface SnoozeDetail {
  id: string;
  by: { id: string; name: string };
  until: string;
  at: string;
  reasonCode: string | null;
  note: string | null;
  ordinal: number | null;
  final: boolean;
  policyVersion: string | null;
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
  /** The latest postponement that still holds, by whoever made it. */
  snooze: SnoozeDetail | null;
  /** How many postponements in a row the item has: a claim or a handover (by anyone) starts the count again. */
  consecutiveSnoozes: number;
  /** The first and the latest moment somebody took the item up; a re-claim moves the latest one and starts the no-progress count again. */
  firstClaimAt: string | null;
  lastClaimAt: string | null;
  /** The pauses of its clocks, oldest first. */
  pauses: PauseSpan[];
}

export const NO_ACTION_STATE: WorkActionState = { claimedBy: null, assignee: null, snoozedUntil: null, hiddenForReader: false, lifecycle: 'NEW', snooze: null, consecutiveSnoozes: 0, firstClaimAt: null, lastClaimAt: null, pauses: [] };
/** A fresh state: the shared one is never given out, so that a reader that changes it cannot change what the next one gets. */
export const freshActionState = (): WorkActionState => ({ ...NO_ACTION_STATE, pauses: [] });

export const actionKey = (source: string, sourceId: string): string => `${source}:${sourceId}`;

interface ActionSql {
  id: string;
  source: string;
  source_id: string;
  action: WorkActionKind;
  actor_membership_id: string;
  assignee_membership_id: string | null;
  allowed_by_membership_id: string | null;
  due_on: string | null;
  snooze_until: string | null;
  paused_until: string | null;
  reason: string | null;
  reason_code: string | null;
  snooze_ordinal: number | null;
  snooze_final: boolean | null;
  policy_version: string | null;
  created_at: string;
  actor_name: string | null;
  assignee_name: string | null;
  allowed_by_name: string | null;
}

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const CHUNK = 1000;

/**
 * What people did about the items of the alert centre (claim, assign, snooze, pause and resume the clocks): one row for each decision, appended and never changed (`machvon.work_action`). The state of an item is the
 * latest decision of each kind; the items themselves are read from the tables of the modules by `HomeWorkStore`, which joins this state onto them.
 */
export class HomeWorkActionStore {
  /** Appends a decision in the transaction of the caller; the command writes its audit row and its event in the same one. */
  async record(tx: TenantTx, input: WorkActionInput): Promise<{ id: string; createdAt: string }> {
    const [row] = await tx.query<{ id: string; created_at: string }>(
      `insert into machvon.work_action (tenant_id, source, source_id, action, actor_membership_id, assignee_membership_id, due_on, snooze_until, reason, reason_code, allowed_by_membership_id, paused_until, snooze_ordinal, snooze_final, policy_version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4::uuid, $5::uuid, $6::date, $7::timestamptz, $8, $9, $10::uuid, $11::timestamptz, $12::int, $13::boolean, $14)
       returning id, ${ISO('created_at')} as created_at`,
      [
        input.source,
        input.sourceId,
        input.action,
        input.actor,
        input.assignee ?? null,
        input.dueOn ?? null,
        input.snoozeUntil ?? null,
        input.reason ?? null,
        input.reasonCode ?? null,
        input.allowedBy ?? null,
        input.pausedUntil ?? null,
        input.snoozeOrdinal ?? null,
        input.snoozeFinal ?? null,
        input.policyVersion ?? null,
      ],
    );
    return { id: (row as { id: string }).id, createdAt: (row as { created_at: string }).created_at };
  }

  /** The state of each item, for the reader who asks; an item nobody did anything about is not in the map. */
  async stateOf(tx: TenantTx, items: ReadonlyArray<{ source: string; sourceId: string }>, reader: string, now: Date): Promise<Map<string, WorkActionState>> {
    const states = new Map<string, WorkActionState>();
    for (let from = 0; from < items.length; from += CHUNK) {
      const chunk = items.slice(from, from + CHUNK);
      const rows = await tx.query<ActionSql>(
        `select a.id, a.source, a.source_id, a.action, a.actor_membership_id, a.assignee_membership_id, a.allowed_by_membership_id, a.due_on::text as due_on, ${ISO('a.snooze_until')} as snooze_until,
                ${ISO('a.paused_until')} as paused_until, a.reason, a.reason_code, a.snooze_ordinal, a.snooze_final, a.policy_version, ${ISO('a.created_at')} as created_at,
                ad.display_name as actor_name, sd.display_name as assignee_name, ld.display_name as allowed_by_name
           from machvon.work_action a
           join unnest($1::text[], $2::text[]) as k (source, source_id) on k.source = a.source and k.source_id = a.source_id
           left join machvon.tenant_user_directory ad on ad.tenant_id = a.tenant_id and ad.membership_id = a.actor_membership_id
           left join machvon.tenant_user_directory sd on sd.tenant_id = a.tenant_id and sd.membership_id = a.assignee_membership_id
           left join machvon.tenant_user_directory ld on ld.tenant_id = a.tenant_id and ld.membership_id = a.allowed_by_membership_id
          order by a.created_at, a.id`,
        [chunk.map((item) => item.source), chunk.map((item) => item.sourceId)],
      );
      for (const row of rows) {
        const key = actionKey(row.source, row.source_id);
        const state = states.get(key) ?? freshActionState();
        fold(state, row, reader, now);
        states.set(key, state);
      }
    }
    return states;
  }
}

/** Applies one decision, in the order they were made, to the state of its item. */
function fold(state: WorkActionState, row: ActionSql, reader: string, now: Date): void {
  if (row.action === 'CLAIM') {
    state.claimedBy = { id: row.actor_membership_id, name: row.actor_name ?? '', at: row.created_at };
    state.lifecycle = furtherLifecycle(state.lifecycle, 'CLAIMED');
    state.firstClaimAt ??= row.created_at;
    state.lastClaimAt = row.created_at;
    state.consecutiveSnoozes = 0;
  } else if (row.action === 'ASSIGN' && row.assignee_membership_id !== null) {
    state.assignee = { id: row.assignee_membership_id, name: row.assignee_name ?? '', dueOn: row.due_on };
    state.lifecycle = furtherLifecycle(state.lifecycle, 'IN_PROGRESS');
    state.consecutiveSnoozes = 0;
  } else if (row.action === 'SNOOZE' && row.snooze_until !== null) {
    state.consecutiveSnoozes += 1;
    const future = Date.parse(row.snooze_until) > now.getTime();
    if (future) {
      state.snooze = {
        id: row.id,
        by: { id: row.actor_membership_id, name: row.actor_name ?? '' },
        until: row.snooze_until,
        at: row.created_at,
        reasonCode: row.reason_code,
        note: row.reason,
        ordinal: row.snooze_ordinal,
        final: row.snooze_final === true,
        policyVersion: row.policy_version,
      };
    } else if (state.snooze !== null && Date.parse(state.snooze.until) <= now.getTime()) state.snooze = null;
    // The latest decision of a reader about their own list wins over an older one; what another person put off is shown but does not hide the item.
    if (row.actor_membership_id.toLowerCase() === reader.toLowerCase()) {
      state.hiddenForReader = future;
      if (future) state.snoozedUntil = row.snooze_until;
      else if (state.snoozedUntil !== null) state.snoozedUntil = null;
    } else if (future) state.snoozedUntil = row.snooze_until;
  } else if (row.action === 'PAUSE_CLOCK' && row.paused_until !== null) {
    state.pauses.push({
      from: row.created_at,
      until: row.paused_until,
      resumedAt: null,
      reasonCode: row.reason_code ?? '',
      reason: row.reason ?? '',
      allowedBy: row.allowed_by_membership_id === null ? null : { id: row.allowed_by_membership_id, name: row.allowed_by_name ?? '' },
      by: { id: row.actor_membership_id, name: row.actor_name ?? '' },
    });
  } else if (row.action === 'RESUME_CLOCK') {
    // A resume ends the latest pause that is still holding at that moment.
    for (let index = state.pauses.length - 1; index >= 0; index -= 1) {
      const span = state.pauses[index] as PauseSpan;
      if (span.resumedAt === null && Date.parse(span.until) > Date.parse(row.created_at)) {
        span.resumedAt = row.created_at;
        break;
      }
    }
  }
}

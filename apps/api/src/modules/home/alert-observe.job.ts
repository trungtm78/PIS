import { randomUUID } from 'node:crypto';
import { AlertFloodStore, AlertObservationStore, HomeWorkStore, WORKER_MEMBERSHIP_ID, WORK_SOURCES, alertTypeCodeOf, enqueueOutbox, loadAccessIn } from '@machvon/db';
import type { ObservedMeta, TenantDatabase, TenantTx, WorkRow, WorkSource } from '@machvon/db';
import { NOOP_METRICS, floodProtects, groupForFlood, itemKey, observationDecision, vietnamDateOf } from '@machvon/kernel';
import type { FloodItem, MetricsSink, TenantContext } from '@machvon/kernel';
import { canReadScope, workScopes } from './work-scope';

export const ALERT_CLOSED_METRIC = 'home_alert_closed_by_system_total';
export const ALERT_REOPENED_METRIC = 'home_alert_reopened_total';
export const ALERT_STORM_METRIC = 'home_alert_storm_started_total';
const MEMBER_SAVEPOINT = 'home_alert_observe_member';
const MEMBER_LIMIT = 5000;
/** The pass is keyed by the day and the half hour, so a pass that runs twice in a slot records each change once. */
const SLOT_MINUTES = 30;

export interface AlertObserveDeps {
  metrics?: MetricsSink;
}

export interface AlertObserveResult {
  members: number;
  items: number;
  opened: number;
  closed: number;
  reopened: number;
  /** Open items whose source did not answer in the pass: nothing was said about them. */
  unknown: number;
  /** A list of a person could not be read: the pass does not close anything (it cannot tell a cleared item from one that a failed list hid). */
  incomplete: boolean;
  stormsStarted: number;
  stormsEnded: number;
}

/** The key of the slot a pass runs in. */
export const passKeyOf = (now: Date): string => `${now.toISOString().slice(0, 10)}T${String(now.getUTCHours()).padStart(2, '0')}:${String(Math.floor(now.getUTCMinutes() / SLOT_MINUTES) * SLOT_MINUTES).padStart(2, '0')}`;

/**
 * The job `alert-observe` (G2-8 and G2-11, every 15 minutes) for the tenant of the transaction: it reads the list of every person who may read the alert centre (their own list, snoozed items included, and the whole scope of the
 * ones who read it), records every item it sees, closes with RESOLVED_BY_SYSTEM an item that was seen before and is not produced any more (only when every source answered for every list: a source that fails for even one
 * person closes nothing, and neither does a list that could not be read), opens it again when its condition returns, and looks at the number of new alerts of each person to start or end their storm. The pass is idempotent
 * by its slot.
 */
export async function runAlertObservation(database: TenantDatabase, tenant: TenantContext, now: Date, deps: AlertObserveDeps = {}): Promise<AlertObserveResult> {
  return database.withTenant(tenant, (tx) => alertObservationPass(tx, tenant, now, deps));
}

export async function alertObservationPass(tx: TenantTx, tenant: TenantContext, now: Date, deps: AlertObserveDeps = {}): Promise<AlertObserveResult> {
  const metrics = deps.metrics ?? NOOP_METRICS;
  const work = new HomeWorkStore();
  const observations = new AlertObservationStore();
  const floods = new AlertFloodStore();
  const today = vietnamDateOf(now);
  const result: AlertObserveResult = { members: 0, items: 0, opened: 0, closed: 0, reopened: 0, unknown: 0, incomplete: false, stormsStarted: 0, stormsEnded: 0 };
  const members = await tx.query<{ id: string }>(
    `select m.id from machvon.membership m where m.status = 'Active' and m.valid_from <= $1::timestamptz and (m.valid_until is null or m.valid_until > $1::timestamptz) order by m.id limit ${MEMBER_LIMIT}`,
    [now.toISOString()],
  );
  const produced = new Map<string, { source: string; sourceId: string }>();
  const meta = new Map<string, ObservedMeta>();
  const failed = new Set<string>();
  const lists = new Map<string, WorkRow[]>();
  for (const member of members) {
    const access = await loadAccessIn(tx, member.id);
    if (!access.membershipActive || !canReadScope(access, now)) continue;
    result.members += 1;
    await tx.query(`savepoint ${MEMBER_SAVEPOINT}`);
    try {
      for (const view of ['mine', 'scope'] as const) {
        // The whole scope is read only by the people who read it; their own list is read by everybody.
        if (view === 'scope' && !canReadScope(access, now)) continue;
        const collected = await work.collect(tx, { membershipId: member.id, now, today, view, mode: 'count', includeHidden: true, ...workScopes(access, now) });
        for (const name of collected.unavailableSources) failed.add(name);
        for (const row of collected.rows) {
          const key = itemKey(row.source, row.id);
          produced.set(key, { source: row.source, sourceId: row.id });
          meta.set(key, { kind: row.kind, alertTypeCode: alertTypeCodeOf(row), severity: row.severity, causeKey: (row as WorkRow & { causeKey?: string | null }).causeKey ?? null });
          if (view === 'mine') lists.set(member.id, [...(lists.get(member.id) ?? []), row]);
        }
      }
      await tx.query(`release savepoint ${MEMBER_SAVEPOINT}`);
    } catch {
      await tx.query(`rollback to savepoint ${MEMBER_SAVEPOINT}`);
      await tx.query(`release savepoint ${MEMBER_SAVEPOINT}`);
      result.incomplete = true;
    }
  }
  result.items = produced.size;
  // Nobody read, or a list failed: say nothing about what is no longer there (the items that are there are still recorded).
  const answered = result.incomplete || result.members === 0 ? new Set<string>() : new Set<string>((WORK_SOURCES as readonly WorkSource[]).filter((source) => !failed.has(source)));
  const known = await observations.known(tx);
  const decision = observationDecision({ produced: [...produced.values()], known, answeredSources: answered, failedSources: failed });
  const applied = await observations.apply(tx, decision, meta, now, passKeyOf(now));
  result.opened = applied.opened;
  result.closed = applied.closed;
  result.reopened = applied.reopened;
  result.unknown = applied.unknown;
  for (let n = 0; n < applied.closed; n += 1) metrics.increment(ALERT_CLOSED_METRIC);
  for (let n = 0; n < applied.reopened; n += 1) metrics.increment(ALERT_REOPENED_METRIC);
  if (applied.reopened > 0) await announceReopened(tx, tenant, decision.reopen, now);
  // The storm of each person, from the number of their alerts that are new in the window of the rule.
  const reading = await floods.policy(tx, today);
  const windowStart = now.getTime() - reading.policy.window_minutes * 60_000;
  const dayStart = new Date(`${today}T00:00:00+07:00`).getTime();
  for (const [memberId, rows] of lists) {
    const firstSeen = await observations.firstSeen(tx, rows.map((row) => ({ source: row.source, sourceId: row.id })));
    const items: FloodItem[] = rows.map((row) => {
      const seen = firstSeen.get(itemKey(row.source, row.id));
      return { source: row.source, id: row.id, severity: row.severity, causeKey: (row as WorkRow & { causeKey?: string | null }).causeKey ?? null, projectCode: row.subtitle, isNew: seen === undefined || Date.parse(seen) >= windowStart };
    });
    const newInWindow = items.filter((item) => item.isNew).length;
    const newToday = rows.filter((row) => {
      const seen = firstSeen.get(itemKey(row.source, row.id));
      return seen === undefined || Date.parse(seen) >= dayStart;
    }).length;
    const storm = await floods.current(tx, memberId);
    const grouped = groupForFlood(items, reading.policy, floodProtects(storm, newToday, reading.policy)).groups.reduce((sum, group) => sum + group.count, 0);
    const observed = await floods.observe(tx, memberId, { newInWindow, grouped, now, reading });
    if (observed.change === 'STARTED') {
      result.stormsStarted += 1;
      metrics.increment(ALERT_STORM_METRIC);
    } else if (observed.change === 'ENDED') result.stormsEnded += 1;
  }
  return result;
}

/** One event for an alert whose condition came back after the system closed it: whoever follows it can tell the owner. It names the item, never words. */
async function announceReopened(tx: TenantTx, tenant: TenantContext, items: ReadonlyArray<{ source: string; sourceId: string }>, now: Date): Promise<void> {
  const correlationId = randomUUID();
  for (const item of items.slice(0, 200)) {
    await enqueueOutbox(tx, {
      aggregateType: 'work_item',
      aggregateId: randomUUID(),
      aggregateVersion: 1,
      type: 'home.alert_reopened.v1',
      schemaVersion: 1,
      payload: { tenant_id: tenant.tenantId, actor_id: WORKER_MEMBERSHIP_ID, occurred_at: now.toISOString(), source: item.source, source_id: item.sourceId },
      eventKey: `alert_reopened:${item.source}:${item.sourceId}:${passKeyOf(now)}`.slice(0, 200),
      correlationId,
    });
  }
}

import { randomUUID } from 'node:crypto';
import { AlertFloodStore, AlertLadderStore, HomeWorkStore, PermissiveAlertProfile, WORKER_MEMBERSHIP_ID, alertTypeCodeOf, enqueueOutbox, loadAccessIn } from '@machvon/db';
import type { AlertProfilePort, LadderRunRow, TenantDatabase, TenantTx, WorkRow } from '@machvon/db';
import { NOOP_METRICS, assertLadderPayload, ladderEventType, nextLadderMove, vietnamDateOf } from '@machvon/kernel';
import type { LadderChannel, LadderMove, LadderSeverity, MetricsSink, TenantContext } from '@machvon/kernel';
import { canReadScope, workScopes } from './work-scope';

export const ALERT_LADDER_RUNG_METRIC = 'home_alert_ladder_rung_total';
export const ALERT_LADDER_ESCALATED_METRIC = 'home_alert_ladder_escalated_total';
export const ALERT_LADDER_PROFILE_FAILED_METRIC = 'home_alert_ladder_profile_failed_total';
const MEMBER_SAVEPOINT = 'home_alert_ladder_member';
const MEMBER_LIMIT = 5000;
/** The most rungs one run is moved by in one pass (a ladder has at most five): a loop that does not end is a defect, not a long ladder. */
const MAX_STEPS = 6;
/** The link of a message of the ladder: the alert centre inside the application, which needs a login; the message never carries the item or an amount. */
export const LADDER_DEEP_LINK = '/home/home-02';
const RECEIPT_GRACE_HOURS = 72;
const RECEIPT_BATCH = 200;
export const ESCALATED_EVENT = 'home.alert_ladder_escalated.v1';

export interface AlertLadderDeps {
  metrics?: MetricsSink;
  /** The notification profile of a person (GOV-9a plugs in here); the default lets every rung go. */
  profile?: AlertProfilePort;
}

export interface AlertLadderResult {
  members: number;
  started: number;
  sent: number;
  suppressed: number;
  escalated: number;
  finished: number;
  receiptsMoved: number;
  /** A profile that failed: the rung went on as if allowed (an urgent alert is not held back by a broken profile). */
  profileFailures: number;
  failed: number;
}

/**
 * The job `alert-ladder` (G2-6, every 5 minutes) for the tenant of the transaction: for each person who may read the alert centre it starts the ladder of each new item whose severity has external rungs (urgent first; during a
 * storm only the urgent ones start a ladder), reads back the receipts of the rungs already sent, and moves each ladder whose time has come by the kernel's `nextLadderMove`: the next rung (an event of the outbox that the
 * notification workflows of the tenant carry, written in the same transaction as the row), a wait, the hand-off to the escalation, or the end (a receipt of the wanted kind, a person on the item, the condition cleared, out of
 * rungs, out of time). A source that could not be read never ends a ladder as "cleared". A pass run twice sends nothing twice: a rung is one row and one event key.
 */
export async function runAlertLadders(database: TenantDatabase, tenant: TenantContext, now: Date, deps: AlertLadderDeps = {}): Promise<AlertLadderResult> {
  return database.withTenant(tenant, (tx) => alertLadderPass(tx, tenant, now, deps));
}

export async function alertLadderPass(tx: TenantTx, tenant: TenantContext, now: Date, deps: AlertLadderDeps = {}): Promise<AlertLadderResult> {
  const metrics = deps.metrics ?? NOOP_METRICS;
  const profile = deps.profile ?? new PermissiveAlertProfile();
  const store = new AlertLadderStore();
  const work = new HomeWorkStore();
  const floods = new AlertFloodStore();
  const today = vietnamDateOf(now);
  const result: AlertLadderResult = { members: 0, started: 0, sent: 0, suppressed: 0, escalated: 0, finished: 0, receiptsMoved: 0, profileFailures: 0, failed: 0 };
  for (const runId of await store.pendingReceipts(tx, now, RECEIPT_GRACE_HOURS, RECEIPT_BATCH)) result.receiptsMoved += await store.syncReceipts(tx, runId, now);
  const policies = new Map<LadderSeverity, Awaited<ReturnType<AlertLadderStore['policy']>>>();
  for (const severity of ['URGENT', 'ACTION', 'WATCH'] as const) policies.set(severity, await store.policy(tx, severity, today));
  const members = await tx.query<{ id: string }>(
    `select m.id from machvon.membership m where m.status = 'Active' and m.valid_from <= $1::timestamptz and (m.valid_until is null or m.valid_until > $1::timestamptz) order by m.id limit ${MEMBER_LIMIT}`,
    [now.toISOString()],
  );
  for (const member of members) {
    const access = await loadAccessIn(tx, member.id);
    if (!access.membershipActive || !canReadScope(access, now)) continue;
    result.members += 1;
    await tx.query(`savepoint ${MEMBER_SAVEPOINT}`);
    try {
      const collected = await work.collect(tx, { membershipId: member.id, now, today, view: 'mine', mode: 'count', includeHidden: true, ...workScopes(access, now) });
      const rows = new Map<string, WorkRow>(collected.rows.map((row) => [`${row.source}\u0000${row.id}`, row]));
      const unavailable = new Set<string>(collected.unavailableSources);
      const storm = await floods.current(tx, member.id);
      // Start: a new item (nobody on it, not put off) whose severity has more than the inbox.
      for (const row of rows.values()) {
        const reading = policies.get(row.severity as LadderSeverity);
        if (reading === undefined || reading.policy.rungs.length < 2 || row.lifecycle !== 'NEW' || row.snoozedUntil !== null) continue;
        if (storm.active && row.severity !== 'URGENT') continue;
        const run = await store.start(tx, { source: row.source, sourceId: row.id, recipient: member.id, severity: row.severity as LadderSeverity, alertTypeCode: alertTypeCodeOf(row), reading, now });
        if (run !== undefined) result.started += 1;
      }
      for (const run of await store.activeOf(tx, member.id)) {
        if (Date.parse(run.nextAt) > now.getTime()) continue;
        const row = rows.get(`${run.source}\u0000${run.sourceId}`);
        // A source that could not be read does not say the item is gone: the ladder waits for the next pass.
        if (row === undefined && unavailable.has(run.source)) continue;
        await advance(tx, tenant, store, profile, metrics, result, run, row, member.id, now);
      }
      await tx.query(`release savepoint ${MEMBER_SAVEPOINT}`);
    } catch {
      await tx.query(`rollback to savepoint ${MEMBER_SAVEPOINT}`);
      await tx.query(`release savepoint ${MEMBER_SAVEPOINT}`);
      result.failed += 1;
    }
  }
  return result;
}

async function advance(tx: TenantTx, tenant: TenantContext, store: AlertLadderStore, profile: AlertProfilePort, metrics: MetricsSink, result: AlertLadderResult, run: LadderRunRow, row: WorkRow | undefined, recipient: string, now: Date): Promise<void> {
  await store.syncReceipts(tx, run.id, now);
  const cleared = row === undefined;
  const acted = row !== undefined && (row.lifecycle !== 'NEW' || row.claimedBy !== null || row.assignee !== null);
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const rungs = await store.rungs(tx, run.id);
    const move: LadderMove = nextLadderMove({ policy: run.policy, rungs: AlertLadderStore.records(rungs), now, startedAt: run.startedAt, acted, cleared, escalated: run.escalatedAt !== null });
    if (move.kind === 'WAIT') {
      await store.schedule(tx, run.id, new Date(move.until));
      return;
    }
    if (move.kind === 'SEND_RUNG') {
      const spec = run.policy.rungs[move.index];
      if (spec === undefined) return;
      const decision = await decide(profile, tx, result, metrics, { recipient, channel: spec.channel, severity: run.severity, overdueToClaim: false, now });
      if (decision.kind === 'DEFER') {
        await store.schedule(tx, run.id, decision.until);
        return;
      }
      if (decision.kind === 'SUPPRESS') {
        await store.recordRung(tx, { runId: run.id, index: move.index, channel: spec.channel, now, outboxEventId: null, eventKey: null, suppressed: decision.reason });
        result.suppressed += 1;
        continue;
      }
      const recorded = await store.recordRung(tx, { runId: run.id, index: move.index, channel: spec.channel, now, outboxEventId: null, eventKey: `alert_ladder:${run.id}:${move.index}`, suppressed: null });
      if (recorded.created) {
        const eventId = await emitRung(tx, tenant, run, recorded.id, spec.channel, recipient, now);
        await tx.query('update machvon.alert_ladder_rung set outbox_event_id = $2::uuid where id = $1::uuid', [recorded.id, eventId]);
        result.sent += 1;
        metrics.increment(ALERT_LADDER_RUNG_METRIC, { channel: spec.channel });
      }
      await store.schedule(tx, run.id, new Date(now.getTime() + spec.wait_minutes * 60_000));
      return;
    }
    if (move.kind === 'ESCALATE') {
      await store.finish(tx, run.id, move, now);
      await emitEscalation(tx, tenant, run, recipient, now);
      result.escalated += 1;
      result.finished += 1;
      metrics.increment(ALERT_LADDER_ESCALATED_METRIC);
      return;
    }
    await store.finish(tx, run.id, move, now);
    result.finished += 1;
    return;
  }
}

/** The profile of the person says what to do with a rung; a profile that fails lets the rung go and is counted. */
async function decide(profile: AlertProfilePort, tx: TenantTx, result: AlertLadderResult, metrics: MetricsSink, question: Parameters<AlertProfilePort['decide']>[1]): ReturnType<AlertProfilePort['decide']> {
  if (question.channel === 'IN_APP') return { kind: 'ALLOW' };
  await tx.query('savepoint alert_ladder_profile');
  try {
    const decision = await profile.decide(tx, question);
    await tx.query('release savepoint alert_ladder_profile');
    return decision;
  } catch {
    await tx.query('rollback to savepoint alert_ladder_profile');
    await tx.query('release savepoint alert_ladder_profile');
    result.profileFailures += 1;
    metrics.increment(ALERT_LADDER_PROFILE_FAILED_METRIC);
    return { kind: 'ALLOW' };
  }
}

/** The event that carries a rung into the notification workflows: the kind of alert, its severity and a link inside the application; the kernel refuses a payload that would carry anything else (an amount, a name). */
async function emitRung(tx: TenantTx, tenant: TenantContext, run: LadderRunRow, rungId: string, channel: LadderChannel, recipient: string, now: Date): Promise<string> {
  const payload = assertLadderPayload({ alertType: run.alertTypeCode ?? run.source, severity: run.severity, deepLink: LADDER_DEEP_LINK });
  const event = await enqueueOutbox(tx, {
    aggregateType: 'alert_ladder_run',
    aggregateId: run.id,
    aggregateVersion: 1,
    type: ladderEventType(channel),
    schemaVersion: 1,
    payload: {
      tenant_id: tenant.tenantId,
      actor_id: WORKER_MEMBERSHIP_ID,
      occurred_at: now.toISOString(),
      run_id: run.id,
      rung_id: rungId,
      alert_type: payload.alertType,
      severity: payload.severity,
      deep_link: payload.deepLink,
      notification: { recipients: [recipient], deepLink: payload.deepLink },
    },
    eventKey: `alert_ladder:${run.id}:${channel}`,
    correlationId: randomUUID(),
  });
  return event.id;
}

/** The hand-off at the end of the ladder: the escalation (lane GOV-9a) hears of an alert that nobody took up and no channel reached. It names the run and the item, never words. */
async function emitEscalation(tx: TenantTx, tenant: TenantContext, run: LadderRunRow, recipient: string, now: Date): Promise<void> {
  await enqueueOutbox(tx, {
    aggregateType: 'alert_ladder_run',
    aggregateId: run.id,
    aggregateVersion: 2,
    type: ESCALATED_EVENT,
    schemaVersion: 1,
    payload: { tenant_id: tenant.tenantId, actor_id: WORKER_MEMBERSHIP_ID, occurred_at: now.toISOString(), run_id: run.id, source: run.source, source_id: run.sourceId, recipient_membership_id: recipient, severity: run.severity },
    eventKey: `alert_ladder_escalated:${run.id}`,
    correlationId: randomUUID(),
  });
}


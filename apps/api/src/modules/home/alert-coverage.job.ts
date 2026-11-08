import { randomUUID } from 'node:crypto';
import { AlertCoverStore, AlertEscalationStore, AlertGapStore, AlertGovernancePolicyReader, AlertProfileStore, AlertTraceStore, DoaMatrixStore, HomeWorkCalendars, WORKER_MEMBERSHIP_ID, WORK_CALENDAR_CODE, enqueueOutbox } from '@machvon/db';
import type { GapDesired, GapRecord, TenantDatabase, TenantTx, WorkSource } from '@machvon/db';
import { NOOP_METRICS, detectCoverageGaps, evaluateEscalation, gapKey, positionCoverage, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink, TenantContext } from '@machvon/kernel';
import { AlertNotifier } from './alert-notice';
import { sendUp } from './alert-escalation.job';
import type { Cached } from './alert-escalation.job';

export const ALERT_COVERAGE_METRIC = 'home_alert_coverage_gap_total';
export const GAP_RESOURCE_TYPE = 'alert_routing_gap';
export const GAP_OPENED_EVENT = 'home.alert_gap_opened.v1';
export const GAP_CLOSED_EVENT = 'home.alert_gap_closed.v1';

export interface AlertCoverageDeps {
  metrics?: MetricsSink;
}

export interface AlertCoverageResult {
  /** The gaps in force after the pass, by kind. */
  gaps: number;
  opened: number;
  closed: number;
  /** Items of people who left that were sent up to the leadership of the place they worked in. */
  rerouted: number;
}

/**
 * The job `alert-coverage` (G2-7; every 15 minutes) for the tenant of the transaction. It finds where an alert has nobody to receive it and keeps the gaps in line with what it finds: a person who is away with no cover for all sources in force past the
 * working-hours allowance of the policy (ABSENT_NO_COVER), an absence that starts soon with no cover proposed (ABSENCE_STARTING_UNCOVERED), an owner who left with open items (OWNER_INACTIVE), a position of leadership with nobody present and no cover
 * (POSITION_UNCOVERED). A gap is opened once and closed when the cause is gone, so the time to reroute is measured; the people who manage covers see an open gap as an alert of the alert centre (the source COVERAGE). The open items of a person who left
 * climb at once to the leadership of the place they worked in (the orphan step of the escalation), with a row and an event; they are never left on a list nobody reads. Every row has a series key, so the pass run twice records each once.
 */
export async function runAlertCoverage(database: TenantDatabase, tenant: TenantContext, now: Date, deps: AlertCoverageDeps = {}): Promise<AlertCoverageResult> {
  return database.withTenant(tenant, (tx) => alertCoveragePass(tx, tenant, now, deps));
}

export async function alertCoveragePass(tx: TenantTx, tenant: TenantContext, now: Date, deps: AlertCoverageDeps = {}): Promise<AlertCoverageResult> {
  const metrics = deps.metrics ?? NOOP_METRICS;
  const today = vietnamDateOf(now);
  const covers = new AlertCoverStore();
  const trace = new AlertTraceStore();
  const gaps = new AlertGapStore();
  const escalations = new AlertEscalationStore();
  const profiles = new AlertProfileStore();
  const policies = await new AlertGovernancePolicyReader().read(tx, today);
  const calendars = await new HomeWorkCalendars().load(tx, WORK_CALENDAR_CODE, now);
  const facts = await covers.absenceFacts(tx, now);
  const edges = await covers.liveEdges(tx, now);
  const spans = facts.map((fact) => ({ membershipId: fact.membershipId, from: fact.from, until: fact.until }));
  const result: AlertCoverageResult = { gaps: 0, opened: 0, closed: 0, rerouted: 0 };
  const desired: GapDesired[] = [];

  const unitOf = new Map<string, string | null>();
  const detected = detectCoverageGaps({ now, policy: policies.absence, absences: facts, covers: edges, calendars });
  const people = [...new Set(detected.map((gap) => gap.membershipId))];
  if (people.length > 0) {
    const rows = await tx.query<{ id: string; organization_id: string | null }>('select id, organization_id from machvon.membership where id = any($1::uuid[])', [people]);
    for (const row of rows) unitOf.set(row.id, row.organization_id);
  }
  for (const gap of detected) {
    const open = gap.kind === 'ABSENT_NO_COVER' ? (await trace.openOf(tx, gap.membershipId)).length : 0;
    desired.push({ kind: gap.kind, subjectKey: gapKey(gap.kind, gap.absenceId), membershipId: gap.membershipId, unitId: unitOf.get(gap.membershipId) ?? null, absenceId: gap.absenceId, itemCount: open });
  }

  // The owners who left and still hold open items: nobody's list shows them.
  const left = await trace.openOfInactiveOwners(tx, now);
  const byOwner = new Map<string, typeof left>();
  for (const item of left) byOwner.set(item.ownerId as string, [...(byOwner.get(item.ownerId as string) ?? []), item]);
  for (const [ownerId, items] of byOwner) desired.push({ kind: 'OWNER_INACTIVE', subjectKey: gapKey('OWNER_INACTIVE', ownerId), membershipId: ownerId, unitId: items[0]?.unitId ?? null, absenceId: null, itemCount: items.length });

  // The positions of leadership with nobody present and no cover in force.
  const holders = await covers.positionHolders(tx, now, policies.absence.position_min_rank, policies.escalation.admin_fallback_min_rank);
  for (const position of positionCoverage(holders, policies.absence).positions) {
    if (position.state === 'UNCOVERED') desired.push({ kind: 'POSITION_UNCOVERED', subjectKey: gapKey('POSITION_UNCOVERED', position.key), membershipId: null, unitId: position.unitId, absenceId: null, itemCount: 0 });
  }

  const kinds = ['ABSENT_NO_COVER', 'ABSENCE_STARTING_UNCOVERED', 'OWNER_INACTIVE', 'POSITION_UNCOVERED'] as const;
  const reasonOf = (open: GapRecord): 'COVERED' | 'BACK' | 'RESOLVED' | 'ABSENCE_ENDED' => {
    if (open.kind === 'OWNER_INACTIVE' || open.kind === 'POSITION_UNCOVERED') return 'RESOLVED';
    return facts.some((fact) => fact.id === open.absenceId) ? 'COVERED' : 'ABSENCE_ENDED';
  };
  const synced = await gaps.sync(tx, kinds, desired, now, reasonOf);
  result.opened = synced.opened.length;
  result.closed = synced.closed.length;
  result.gaps = desired.length;
  for (const gap of synced.opened) {
    metrics.increment(ALERT_COVERAGE_METRIC);
    await announce(tx, tenant, now, GAP_OPENED_EVENT, gap.id, { kind: gap.kind, membership_id: gap.membershipId, unit_id: gap.unitId, absence_id: gap.absenceId, item_count: gap.itemCount });
  }
  for (const gap of synced.closed) await announce(tx, tenant, now, GAP_CLOSED_EVENT, gap.id, { kind: gap.kind, membership_id: gap.membershipId, absence_id: gap.absenceId, reason: gap.closeReason });

  // The items of the people who left go up at once, to the leadership of the place they worked in.
  if (left.length > 0) {
    const notifier = new AlertNotifier(tx, tenant, policies.notify, now, profiles);
    const doa = new DoaMatrixStore();
    const cached: Cached = { candidates: new Map(), floors: new Map() };
    const inactive = new Set(byOwner.keys());
    const desiredGaps = new Map<string, GapDesired>();
    const scratch = { members: 0, items: 0, escalations: 0, promotions: 0, notices: 0, released: 0, digests: 0, cleared: 0, failed: 0 };
    const leftKeys = left.map((item) => ({ source: item.source, sourceId: item.sourceId }));
    const climbs = await escalations.climbOf(tx, leftKeys);
    const occurrences = await trace.occurrences(tx, leftKeys);
    for (const item of left) {
      const owner = await escalations.ownerOf(tx, item.ownerId as string, now);
      if (owner === undefined) continue;
      const evaluation = evaluateEscalation({ severity: item.severity, now, lifecycle: 'NEW', clocks: null, paused: false, snoozedUntil: null, orphaned: { since: now }, acknowledged: [], policy: policies.escalation, calendars });
      result.rerouted += await sendUp({
        tx,
        tenant,
        now,
        row: { source: item.source as WorkSource, id: item.sourceId, occurrence: occurrences.get(`${item.source}:${item.sourceId}`) ?? 0, severity: item.severity, title: item.title, subtitle: item.subtitle, dueOn: item.dueOn, target: item.target, claimBreached: false, quietBypass: false },
        member: item.ownerId as string,
        owner,
        evaluation,
        recorded: climbs.get(`${item.source}:${item.sourceId}`)?.levels ?? new Set<number>(),
        escalations,
        trace,
        covers: { edges, spans, inactive },
        policies,
        notifier,
        cached,
        doa,
        desiredGaps,
        metrics,
        result: scratch,
      });
    }
  }
  return result;
}

async function announce(tx: TenantTx, tenant: TenantContext, now: Date, type: string, id: string, facts: Record<string, unknown>): Promise<void> {
  await enqueueOutbox(tx, {
    aggregateType: GAP_RESOURCE_TYPE,
    aggregateId: id,
    aggregateVersion: 1,
    type,
    schemaVersion: 1,
    payload: { tenant_id: tenant.tenantId, actor_id: WORKER_MEMBERSHIP_ID, occurred_at: now.toISOString(), gap_id: id, ...facts },
    eventKey: `${type}:${id}`,
    correlationId: randomUUID(),
  });
}

import { randomUUID } from 'node:crypto';
import {
  AlertCoverStore,
  AlertEscalationStore,
  AlertGapStore,
  AlertGovernancePolicyReader,
  AlertProfileStore,
  AlertTraceStore,
  DoaMatrixStore,
  HomeWorkCalendars,
  HomeWorkStore,
  WORKER_MEMBERSHIP_ID,
  WORK_CALENDAR_CODE,
  enqueueOutbox,
  loadAccessIn,
} from '@machvon/db';
import type { GapDesired, TenantDatabase, TenantTx, TraceObservation, WorkRow } from '@machvon/db';
import { DomainError, NOOP_METRICS, escalationSeriesKey, evaluateEscalation, evaluatePromotion, levelsToRecord, promotionSeriesKey, resolveEscalationRecipients, routeAlert, vietnamDateOf } from '@machvon/kernel';
import type { EscalationCandidate, EscalationEvaluation, MetricsSink, TenantContext } from '@machvon/kernel';
import { AlertNotifier, digestRowsOf } from './alert-notice';
import { coveredWork } from './alert-cover-view';
import { canReadScope, workScopes } from './work-scope';

export const ALERT_ESCALATION_METRIC = 'home_alert_escalation_total';
export const ALERT_PROMOTION_METRIC = 'home_alert_promotion_total';
export const ESCALATION_RESOURCE_TYPE = 'alert_escalation';
export const ESCALATION_EVENT = 'home.alert_escalated.v1';
export const PROMOTION_EVENT = 'home.alert_promoted.v1';
const MEMBER_SAVEPOINT = 'home_alert_escalation_member';
const MEMBER_LIMIT = 5000;
/** The reminders made in the last two days are planned for; an older one that was never planned is not told of any more. */
const REMINDER_LOOKBACK_MS = 2 * 86_400_000;

export interface AlertEscalationDeps {
  metrics?: MetricsSink;
}

export interface AlertEscalationResult {
  members: number;
  items: number;
  escalations: number;
  promotions: number;
  notices: number;
  released: number;
  digests: number;
  cleared: number;
  /** The people whose list could not be read this pass: they are named by the count, and the next pass tries again. */
  failed: number;
}

/**
 * The job `alert-escalation` (G2-3, G2-5, G2-10; every 15 minutes) for the tenant of the transaction. For each person who may read the alert centre it reads their list as they see it, and: writes what it saw to the trace of the items
 * (the source of the health indicators); sends each item that nobody acts on up its chain (functional or hierarchical levels, counted in working hours by the engine of the clocks, to the people who hold the levels, or to their deputies when
 * they are away) with a row and an event for each; raises an item that was only to be watched and aged untouched; decides how each person is told (the bell is the list; push, SMS and Zalo keep their quiet hours, the cap, the threshold and the
 * consent; the rest is digested) and sends the notices that were held once the quiet hours are over; and composes the morning digest when the person's own time has come. An item whose owner is away with nobody to cover climbs at once. Every row
 * has a series key, so the pass run twice, or by two processes, records each once; no event carries a word of any person.
 */
export async function runAlertEscalation(database: TenantDatabase, tenant: TenantContext, now: Date, deps: AlertEscalationDeps = {}): Promise<AlertEscalationResult> {
  return database.withTenant(tenant, (tx) => alertEscalationPass(tx, tenant, now, deps));
}

export interface Cached {
  candidates: Map<string, EscalationCandidate[]>;
  floors: Map<string, number>;
}

async function approvalFloor(tx: TenantTx, doa: DoaMatrixStore, taskId: string, now: Date): Promise<number> {
  const rows = await tx.query<{ document_type: string; amount: string | null; unit_id: string }>(
    `select i.document_type, i.amount_vnd::text as amount, i.unit_id from machvon.approval_task a join machvon.workflow_instance i on i.tenant_id = a.tenant_id and i.id = a.workflow_instance_id where a.id = $1::uuid`,
    [taskId],
  );
  const instance = rows[0];
  if (instance === undefined) return 0;
  try {
    const resolution = await doa.resolve(tx, { documentType: instance.document_type, amountVnd: instance.amount ?? '0', unitId: instance.unit_id, businessDate: vietnamDateOf(now) });
    const role = await tx.query<{ rank: number }>('select rank from machvon.role_definition where id = $1::uuid', [resolution.approverRoleId]);
    return role[0]?.rank ?? 0;
  } catch (failure) {
    // No rule of authority for this kind of approval: nothing says who must decide it, so no rank is asked for.
    if (failure instanceof DomainError && failure.code === 'DOA_RULE_NOT_FOUND') return 0;
    throw failure;
  }
}

export async function alertEscalationPass(tx: TenantTx, tenant: TenantContext, now: Date, deps: AlertEscalationDeps = {}): Promise<AlertEscalationResult> {
  const metrics = deps.metrics ?? NOOP_METRICS;
  const today = vietnamDateOf(now);
  const work = new HomeWorkStore();
  const trace = new AlertTraceStore();
  const gaps = new AlertGapStore();
  const escalations = new AlertEscalationStore();
  const covers = new AlertCoverStore();
  const profiles = new AlertProfileStore();
  const doa = new DoaMatrixStore();
  const policies = await new AlertGovernancePolicyReader().read(tx, today);
  const calendars = await new HomeWorkCalendars().load(tx, WORK_CALENDAR_CODE, now);
  const spans = await covers.absenceSpans(tx, now);
  const edges = await covers.liveEdges(tx, now);
  const inactive = await covers.inactiveAmong(tx, edges.map((edge) => edge.deputyId), now);
  const notifier = new AlertNotifier(tx, tenant, policies.notify, now, profiles);
  const cached: Cached = { candidates: new Map(), floors: new Map() };
  const desiredGaps = new Map<string, GapDesired>();
  const readers: Array<{ membershipId: string; unavailable: string[] }> = [];
  const result: AlertEscalationResult = { members: 0, items: 0, escalations: 0, promotions: 0, notices: 0, released: 0, digests: 0, cleared: 0, failed: 0 };
  const members = await tx.query<{ id: string; organization_id: string }>(
    `select m.id, m.organization_id from machvon.membership m where m.status = 'Active' and m.valid_from <= $1::timestamptz and (m.valid_until is null or m.valid_until > $1::timestamptz) order by m.id limit ${MEMBER_LIMIT}`,
    [now.toISOString()],
  );

  for (const member of members) {
    const access = await loadAccessIn(tx, member.id);
    if (!access.membershipActive || !canReadScope(access, now)) continue;
    result.members += 1;
    await tx.query(`savepoint ${MEMBER_SAVEPOINT}`);
    try {
      const scopes = workScopes(access, now);
      const collected = await work.collect(tx, { membershipId: member.id, now, today, view: 'mine', mode: 'rows', includeHidden: true, ...scopes });
      // What was derived for the person from the governance of the alerts (what was sent up to them, the gaps) is not an alert of theirs to measure or to send up again.
      const own = collected.rows.filter((row) => row.source !== 'ESCALATION' && row.source !== 'COVERAGE');
      const keys = own.map((row) => ({ source: row.source, sourceId: row.id }));
      const known = await trace.knownKeys(tx, keys);
      const climbs = await escalations.climbOf(tx, keys);
      const policy = policies.escalation;
      await trace.observe(
        tx,
        member.id,
        member.organization_id,
        own.map((row): TraceObservation => ({
          source: row.source,
          sourceId: row.id,
          kind: row.kind,
          typeCode: row.alertType?.code ?? row.kind,
          title: row.title,
          subtitle: row.subtitle,
          dueOn: row.dueOn,
          target: row.target,
          severity: row.severity,
          lifecycle: row.lifecycle === 'RESOLVED' ? 'IN_PROGRESS' : row.lifecycle,
          startedAt: row.startedAt === null ? now : new Date(row.startedAt),
          firstClaimAt: row.firstClaimAt === null ? null : new Date(row.firstClaimAt),
          dueAt: row.clocks?.resolve?.due_at === undefined ? null : new Date(row.clocks.resolve.due_at),
          claimDueAt: row.clocks?.claim?.due_at === undefined ? null : new Date(row.clocks.claim.due_at),
          snoozeCount: row.consecutiveSnoozes,
          levelsConfigured: policy.steps[row.severity].length,
          pauses: row.pauses.map((span) => ({ from: span.from, until: span.resumedAt ?? span.until })),
          resolved: row.lifecycle === 'RESOLVED',
        })),
        now,
      );
      result.items += own.length;
      const firstSeen = await trace.firstSeenOf(tx, member.id);
      const owner = await escalations.ownerOf(tx, member.id, now);
      for (const row of own) {
        if (row.lifecycle === 'RESOLVED') continue;
        const key = `${row.source}:${row.id}`;
        const climb = climbs.get(key);
        const route = routeAlert({ owner: member.id, source: row.source, now, policy: policies.absence, absences: spans, covers: edges, inactive });
        const evaluation = evaluateEscalation({
          severity: row.severity,
          now,
          lifecycle: row.lifecycle,
          clocks: row.clocks,
          paused: row.clocks?.paused != null,
          snoozedUntil: row.snoozedUntil === null ? null : new Date(row.snoozedUntil),
          orphaned: route.via === 'ORPHAN' ? { since: now } : null,
          acknowledged: climb?.acknowledged ?? [],
          policy,
          calendars,
        });
        if (owner !== undefined && evaluation.reached > 0) {
          result.escalations += await sendUp({ tx, tenant, now, row: { source: row.source, id: row.id, severity: row.severity, title: row.title, subtitle: row.subtitle, dueOn: row.dueOn, target: row.target, claimBreached: row.clocks?.claim?.state === 'BREACHED', quietBypass: row.alertType?.quietBypass === true }, member: member.id, owner, evaluation, recorded: climb?.levels ?? new Set<number>(), escalations, trace, covers: { edges, spans, inactive }, policies, notifier, cached, doa, desiredGaps, metrics, result });
        }
        // An item that was only to be watched and stayed untouched is raised one step.
        const promotion = evaluatePromotion({
          severity: row.severity,
          now,
          since: new Date(row.startedAt ?? firstSeen.get(key) ?? now.toISOString()),
          lifecycle: row.lifecycle,
          snoozedUntil: row.snoozedUntil === null ? null : new Date(row.snoozedUntil),
          paused: row.clocks?.paused != null,
          policy,
          calendars,
        });
        if (promotion.promote && climb?.promoted !== true) {
          const recorded = await escalations.record(tx, {
            source: row.source,
            sourceId: row.id,
            level: 0,
            kind: 'PROMOTION',
            trigger: 'WATCH_AGED',
            recipientId: null,
            ownerId: member.id,
            routedVia: 'NONE',
            coverId: null,
            severity: 'ACTION',
            fromSeverity: 'WATCH',
            itemTitle: row.title,
            itemSubtitle: row.subtitle,
            itemDueOn: row.dueOn,
            target: row.target,
            reachedAt: new Date(promotion.since),
            policyVersion: policies.versions.escalation,
            seriesKey: promotionSeriesKey(row.source, row.id),
          });
          if (recorded.created) {
            result.promotions += 1;
            await trace.noteEscalation(tx, row.source, row.id, 0, true);
            await announce(tx, tenant, now, PROMOTION_EVENT, recorded.id, { source: row.source, source_id: row.id, from_severity: 'WATCH', to_severity: 'ACTION', reason_code: promotion.reasonCode, owner_membership_id: member.id });
            metrics.increment(ALERT_PROMOTION_METRIC);
          }
        }
        // A new item is told to the person it goes to now (the deputy when the owner is away); an orphan is told by its escalation instead.
        if (!known.has(key) && row.lifecycle === 'NEW' && route.recipient !== null) {
          result.notices += await notifier.notify({
            recipientId: route.recipient,
            occasion: 'NEW_ITEM',
            severity: row.severity,
            source: row.source,
            sourceId: row.id,
            claimBreached: row.clocks?.claim?.state === 'BREACHED',
            typeMayBreakQuiet: row.alertType?.quietBypass === true,
            key,
          });
        }
      }
      // The morning card: the person's own work, and what they hold as a deputy.
      const covered = await coveredWork(tx, work, { deputyId: member.id, now, today, edges, spans, unitScope: scopes.unitScope, projectScope: scopes.projectScope, holds: scopes.holds, mode: 'rows' });
      const digest = await notifier.digestIfDue(member.id, digestRowsOf([...collected.rows, ...covered.rows], firstSeen), today);
      if (digest !== null) result.digests += 1;
      readers.push({ membershipId: member.id, unavailable: collected.unavailableSources });
      await tx.query(`release savepoint ${MEMBER_SAVEPOINT}`);
    } catch {
      await tx.query(`rollback to savepoint ${MEMBER_SAVEPOINT}`);
      await tx.query(`release savepoint ${MEMBER_SAVEPOINT}`);
      result.failed += 1;
    }
  }

  // The reminders that were made and not yet told, and the notices that were held for the quiet hours and may go now.
  for (const reminder of await profiles.unplannedReminders(tx, new Date(now.getTime() - REMINDER_LOOKBACK_MS))) {
    result.notices += await notifier.notify({ recipientId: reminder.recipientId, occasion: 'REMINDER', severity: reminder.severity, source: reminder.source, sourceId: reminder.sourceId, claimBreached: false, typeMayBreakQuiet: false, key: reminder.id });
  }
  for (const held of await profiles.heldDue(tx, now)) if (await notifier.release(held)) result.released += 1;

  result.cleared = await trace.clearUnseen(tx, now, readers, now);
  await escalations.closeOfClosedItems(tx, now);
  await gaps.sync(tx, ['NO_LEADER', 'FUNCTION_VACANT'], [...desiredGaps.values()], now, () => 'RESOLVED');
  return result;
}

/** What an escalation needs to know of an item: where it is, how it is shown, how urgent it is, and whether nobody took it up in time and its type may break the quiet hours. */
export type ItemFacts = Pick<WorkRow, 'source' | 'id' | 'severity' | 'title' | 'subtitle' | 'dueOn' | 'target'> & { claimBreached: boolean; quietBypass: boolean };

export interface SendUp {
  tx: TenantTx;
  tenant: TenantContext;
  now: Date;
  row: ItemFacts;
  member: string;
  owner: NonNullable<Awaited<ReturnType<AlertEscalationStore['ownerOf']>>>;
  evaluation: EscalationEvaluation;
  recorded: ReadonlySet<number>;
  escalations: AlertEscalationStore;
  trace: AlertTraceStore;
  covers: { edges: Parameters<typeof routeAlert>[0]['covers']; spans: Parameters<typeof routeAlert>[0]['absences']; inactive: ReadonlySet<string> };
  policies: Awaited<ReturnType<AlertGovernancePolicyReader['read']>>;
  notifier: AlertNotifier;
  cached: Cached;
  doa: DoaMatrixStore;
  desiredGaps: Map<string, GapDesired>;
  metrics: MetricsSink;
  result: AlertEscalationResult;
}

/** Records the levels an item has reached and nobody was told of yet, and notes the gaps the choice of recipients found for the levels it has reached; returns how many levels were recorded. */
export async function sendUp(input: SendUp): Promise<number> {
  const { tx, row, evaluation, escalations, policies } = input;
  const candidates = await candidatesOf(input);
  const floor = row.source === 'APPROVAL' ? await floorOf(input) : 0;
  const pending = new Set(levelsToRecord(evaluation, input.recorded).map((level) => level.level));
  const trigger = [...evaluation.triggers].sort((left, right) => left.since.localeCompare(right.since))[0]?.trigger ?? 'OVERDUE';
  let recordedLevels = 0;
  for (const level of evaluation.levels) {
    if (!level.reached) continue;
    const target = resolveEscalationRecipients(level.step, { membershipId: input.member, rank: input.owner.rank }, candidates, policies.escalation, { minRank: floor });
    if (target.gap !== null) {
      const kind = target.gap;
      const subject = kind === 'FUNCTION_VACANT' ? `${level.step.function_role ?? ''}@${input.owner.unitId ?? ''}` : `${input.owner.unitId ?? input.member}`;
      const subjectKey = `GAP:${kind}:${subject}`.slice(0, 200);
      const known = input.desiredGaps.get(subjectKey);
      input.desiredGaps.set(subjectKey, known === undefined ? { kind, subjectKey, membershipId: null, unitId: input.owner.unitId, absenceId: null, itemCount: 1 } : { ...known, itemCount: known.itemCount + 1 });
    }
    if (!pending.has(level.level)) continue;
    let delivered = 0;
    for (const recipient of target.recipients) {
      // A leader who is away is replaced by the deputy who covers them; with nobody to cover them the level goes to the others of its tier.
      const routed = routeAlert({ owner: recipient, source: 'ESCALATION', now: input.now, policy: policies.absence, absences: input.covers.spans, covers: input.covers.edges, inactive: input.covers.inactive });
      if (routed.recipient === null) continue;
      const recorded = await escalations.record(tx, {
        source: row.source,
        sourceId: row.id,
        level: level.level,
        kind: level.step.kind,
        trigger,
        recipientId: routed.recipient,
        ownerId: input.member,
        routedVia: routed.via === 'DEPUTY' ? 'DEPUTY' : target.via,
        coverId: routed.coverId,
        severity: row.severity,
        fromSeverity: null,
        itemTitle: row.title,
        itemSubtitle: row.subtitle,
        itemDueOn: row.dueOn,
        target: row.target,
        reachedAt: new Date(level.reachedAt ?? input.now.toISOString()),
        policyVersion: policies.versions.escalation,
        seriesKey: escalationSeriesKey(row.source, row.id, level.level, routed.recipient),
      });
      delivered += 1;
      if (!recorded.created) continue;
      recordedLevels += 1;
      await input.trace.noteEscalation(tx, row.source, row.id, level.level, false);
      await announce(tx, input.tenant, input.now, ESCALATION_EVENT, recorded.id, {
        source: row.source,
        source_id: row.id,
        level: level.level,
        kind: level.step.kind,
        trigger,
        severity: row.severity,
        recipient_membership_id: routed.recipient,
        owner_membership_id: input.member,
        routed_via: routed.via === 'DEPUTY' ? 'DEPUTY' : target.via,
      });
      input.metrics.increment(ALERT_ESCALATION_METRIC);
      input.result.notices += await input.notifier.notify({
        recipientId: routed.recipient,
        occasion: 'ESCALATION',
        severity: row.severity,
        source: row.source,
        sourceId: row.id,
        claimBreached: row.claimBreached,
        typeMayBreakQuiet: row.quietBypass,
        key: `${row.source}:${row.id}:${level.level}:${routed.recipient}`,
      });
    }
    // A level nobody could receive is not recorded, so the next pass tries it again; the gap says why.
    if (delivered === 0) {
      const subjectKey = `GAP:NO_LEADER:${input.owner.unitId ?? input.member}`;
      const known = input.desiredGaps.get(subjectKey);
      input.desiredGaps.set(subjectKey, known === undefined ? { kind: 'NO_LEADER', subjectKey, membershipId: null, unitId: input.owner.unitId, absenceId: null, itemCount: 1 } : { ...known, itemCount: known.itemCount + 1 });
    }
  }
  return recordedLevels;
}

async function candidatesOf(input: SendUp): Promise<EscalationCandidate[]> {
  const key = `${input.owner.unitId ?? ''}|${input.owner.unitPath}`;
  const found = input.cached.candidates.get(key);
  if (found !== undefined) return found;
  const loaded = await input.escalations.candidatesFor(input.tx, input.owner.unitPath, input.owner.unitId, input.now);
  input.cached.candidates.set(key, loaded);
  return loaded;
}

async function floorOf(input: SendUp): Promise<number> {
  const found = input.cached.floors.get(input.row.id);
  if (found !== undefined) return found;
  const floor = await approvalFloor(input.tx, input.doa, input.row.id, input.now);
  input.cached.floors.set(input.row.id, floor);
  return floor;
}

/** The event that carries a level or a promotion, in the transaction that recorded it; it names the item, the level and the people, never a word of anyone. */
async function announce(tx: TenantTx, tenant: TenantContext, now: Date, type: string, id: string, facts: Record<string, unknown>): Promise<void> {
  await enqueueOutbox(tx, {
    aggregateType: ESCALATION_RESOURCE_TYPE,
    aggregateId: id,
    aggregateVersion: 1,
    type,
    schemaVersion: 1,
    payload: { tenant_id: tenant.tenantId, actor_id: WORKER_MEMBERSHIP_ID, occurred_at: now.toISOString(), escalation_id: id, ...facts },
    eventKey: `alert_escalation:${id}`,
    correlationId: randomUUID(),
  });
}

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { AlertCoverStore } from '../src/alert-cover-store';
import { AlertEscalationStore } from '../src/alert-escalation-store';
import { AlertGovernancePolicyReader } from '../src/alert-governance-policy';
import { AlertProfileStore } from '../src/alert-profile-store';
import { AlertGapStore, AlertTraceStore } from '../src/alert-trace-store';
import type { TraceObservation } from '../src/alert-trace-store';
import { HomeAlertSources, applyPromotions, overlayEscalation } from '../src/home-alert-sources';
import { DEFAULT_SEVERITY_RULES } from '../src/home-work-rules';
import { HomeWorkStore } from '../src/home-work-store';
import type { ScopeBuilder } from '../src/scope-version';
import { ACTOR, AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, roleId, unitId } from './support/authz-fixtures';
import { emptyAlertProfile, escalationPolicyDefaults } from '@machvon/kernel';

const harness = new AuthzHarness();
const trace = new AlertTraceStore();
const gaps = new AlertGapStore();
const escalations = new AlertEscalationStore();
const covers = new AlertCoverStore();
const profiles = new AlertProfileStore();
const policies = new AlertGovernancePolicyReader();
const sources = new HomeAlertSources();

const ROOT = 1;
const NORTH = 2;
const SOUTH = 3;
const LEADER = 1; // leadership of the whole tenant (rank 60), in the root
const OFFICER = 2; // a specialist of the north (rank 40)
const AUDITOR = 3; // an auditor of the whole tenant (rank 25)
const NORTH_LEADER = 4; // leadership of the north subtree (rank 60), in the north
const GONE = 5; // left: membership ended
const DEPUTY = 6; // a specialist of the north, a peer of the officer
const ADMIN = 7; // an administrator of the tenant (rank 90)
const T0 = new Date('2027-10-15T03:00:00Z');
const T1 = new Date('2027-10-15T03:15:00Z');
const T2 = new Date('2027-10-15T03:30:00Z');
const EVERYTHING: ScopeBuilder = () => ({ sql: 'true', params: [] });

const as = <T>(work: (tx: Parameters<Parameters<typeof harness.tenants.withTenant>[1]>[0]) => Promise<T>, tenant = TENANT_A, member = LEADER): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);

async function admin(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

const observation = (over: Partial<TraceObservation> = {}): TraceObservation => ({
  source: 'ISSUE',
  sourceId: randomUUID(),
  kind: 'ISSUE_SLA_BREACH',
  typeCode: 'ISSUE_SLA_BREACH',
  title: 'Late issue',
  subtitle: 'Project',
  dueOn: '2027-10-14',
  target: { screen: 'ISS-09', id: 'item-1' },
  severity: 'ACTION',
  lifecycle: 'NEW',
  startedAt: new Date('2027-10-14T01:00:00Z'),
  firstClaimAt: null,
  dueAt: null,
  claimDueAt: null,
  snoozeCount: 0,
  levelsConfigured: 2,
  pauses: [],
  resolved: false,
  ...over,
});

const traceRow = async (source: string, sourceId: string): Promise<Record<string, unknown>> => {
  const rows = await harness.owner<Record<string, unknown>>(TENANT_A, [['select * from machvon.alert_item_trace where source = $1 and source_id = $2', [source, sourceId]]]);
  return rows[0] as Record<string, unknown>;
};

/** The stores of the governance of the alert system: the trace of the items, the levels of escalation, absences and covers, the profile and the log of notices, the gaps in coverage (lane GOV-9a). */
describe('the stores of the governance of the alert system', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: NORTH, path: `/${unitId(ROOT)}/${unitId(NORTH)}/`, parent: ROOT },
        { n: SOUTH, path: `/${unitId(ROOT)}/${unitId(SOUTH)}/`, parent: ROOT },
      ]);
      await harness.seedMembership(tenant, LEADER, ROOT);
      await harness.seedMembership(tenant, OFFICER, NORTH);
      await harness.seedMembership(tenant, AUDITOR, ROOT);
      await harness.seedMembership(tenant, NORTH_LEADER, NORTH);
      await harness.seedMembership(tenant, GONE, NORTH, { status: 'Ended' });
      await harness.seedMembership(tenant, DEPUTY, NORTH);
      await harness.seedMembership(tenant, ADMIN, ROOT);
      await harness.seedRole(tenant, 1, 'LEADER', [], 60);
      await harness.seedRole(tenant, 2, 'SPECIALIST', [], 40);
      await harness.seedRole(tenant, 3, 'AUDITOR', [], 25);
      await harness.owner(tenant, [["insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, is_system, status, created_by) values ($1, $2, 'TENANT_ADMIN', 'TENANT_ADMIN', '{}', 90, true, 'Active', $3)", [tenant, roleId(4), ACTOR]]]);
      await harness.seedGrants(tenant, [
        { n: 1, member: LEADER, role: 1, kind: 'TENANT' },
        { n: 2, member: OFFICER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
        { n: 3, member: AUDITOR, role: 3, kind: 'TENANT' },
        { n: 4, member: NORTH_LEADER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
        { n: 5, member: DEPUTY, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
        { n: 6, member: ADMIN, role: 4, kind: 'TENANT' },
        { n: 7, member: GONE, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
      ]);
    }
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  });

  describe('the trace of the items', () => {
    const first = observation({ source: 'PERMIT', kind: 'PERMIT_EXPIRY', typeCode: 'PERMIT_EXPIRING', severity: 'WATCH' });
    const second = observation({ source: 'ISSUE' });

    it('writes an item the first time a pass sees it and keeps when it first saw it and when it began', async () => {
      await as((tx) => trace.observe(tx, memberId(OFFICER), unitId(NORTH), [first, second], T0));
      const row = await traceRow('PERMIT', first.sourceId);
      expect(row).toMatchObject({ state: 'OPEN', severity: 'WATCH', severity_first: 'WATCH', reopen_count: 0, owner_membership_id: memberId(OFFICER), owner_unit_id: unitId(NORTH), levels_configured: 2 });
      expect((row.first_seen_at as Date).toISOString()).toBe(T0.toISOString());
      expect((row.started_at as Date).toISOString()).toBe('2027-10-14T01:00:00.000Z');
      expect((await as((tx) => trace.lastPassAt(tx)))?.toISOString()).toBe(T0.toISOString());
    });

    it('refreshes an item that is seen again, and moves the day it last changed only when something changed', async () => {
      await as((tx) => trace.observe(tx, memberId(OFFICER), unitId(NORTH), [first], T1));
      let row = await traceRow('PERMIT', first.sourceId);
      expect((row.last_seen_at as Date).toISOString()).toBe(T1.toISOString());
      expect((row.last_change_at as Date).toISOString()).toBe(T0.toISOString());
      const claimed = { ...first, lifecycle: 'CLAIMED' as const, firstClaimAt: new Date('2027-10-15T03:20:00Z'), snoozeCount: 1 };
      await as((tx) => trace.observe(tx, memberId(OFFICER), unitId(NORTH), [claimed], T2));
      row = await traceRow('PERMIT', first.sourceId);
      expect(row).toMatchObject({ lifecycle: 'CLAIMED', snooze_count: 1 });
      expect((row.first_claim_at as Date).toISOString()).toBe('2027-10-15T03:20:00.000Z');
      expect((row.last_change_at as Date).toISOString()).toBe(T2.toISOString());
      // A later claim never moves the first one.
      await as((tx) => trace.observe(tx, memberId(OFFICER), unitId(NORTH), [{ ...claimed, firstClaimAt: new Date('2027-10-16T03:20:00Z') }], new Date('2027-10-15T04:00:00Z')));
      expect(((await traceRow('PERMIT', first.sourceId)).first_claim_at as Date).toISOString()).toBe('2027-10-15T03:20:00.000Z');
    });

    it('closes an item as RESOLVED when it says it is done, as CLEARED when it is gone while its source could be read, and never when the source could not be read', async () => {
      const done = observation({ resolved: true });
      const gone = observation({ source: 'GUARANTEE', kind: 'GUARANTEE_EXPIRING', typeCode: 'GUARANTEE' });
      const unread = observation({ source: 'SITE_DIARY', kind: 'SITE_DIARY_MISSING', typeCode: 'SITE_DIARY' });
      await as((tx) => trace.observe(tx, memberId(DEPUTY), unitId(NORTH), [done, gone, unread], T0));
      expect(await traceRow('ISSUE', done.sourceId)).toMatchObject({ state: 'RESOLVED' });
      // The next pass sees nothing of the deputy's list; the diary source could not be read.
      const cleared = await as((tx) => trace.clearUnseen(tx, T1, [{ membershipId: memberId(DEPUTY), unavailable: ['SITE_DIARY'] }], T1));
      expect(cleared).toBe(1);
      expect(await traceRow('GUARANTEE', gone.sourceId)).toMatchObject({ state: 'CLEARED' });
      expect(await traceRow('SITE_DIARY', unread.sourceId)).toMatchObject({ state: 'OPEN' });
      // A person whose list was not read in the pass keeps their items open.
      expect(await as((tx) => trace.clearUnseen(tx, T2, [], T2))).toBe(0);
    });

    it('opens an item again, and counts it, when it comes back after it was closed', async () => {
      const item = observation({ source: 'GUARANTEE', kind: 'GUARANTEE_EXPIRING', typeCode: 'GUARANTEE' });
      await as((tx) => trace.observe(tx, memberId(DEPUTY), unitId(NORTH), [item], T0));
      await as((tx) => trace.clearUnseen(tx, T1, [{ membershipId: memberId(DEPUTY), unavailable: [] }], T1));
      expect(await traceRow('GUARANTEE', item.sourceId)).toMatchObject({ state: 'CLEARED' });
      await as((tx) => trace.observe(tx, memberId(DEPUTY), unitId(NORTH), [item], T2));
      expect(await traceRow('GUARANTEE', item.sourceId)).toMatchObject({ state: 'OPEN', reopen_count: 1, closed_at: null });
    });

    it('lists the open items of the people who left, and gives the items of a window to the health page', async () => {
      const orphan = observation({ source: 'EXPLANATION', kind: 'EXPLANATION', typeCode: 'EXPLANATION' });
      await as((tx) => trace.observe(tx, memberId(GONE), unitId(NORTH), [orphan], T0));
      const left = await as((tx) => trace.openOfInactiveOwners(tx, T2));
      expect(left.map((row) => [row.ownerId, row.unitId, row.title])).toEqual([[memberId(GONE), unitId(NORTH), 'Late issue']]);
      const items = await as((tx) => trace.forHealth(tx, new Date('2027-10-15T00:00:00Z'), new Date('2027-10-16T00:00:00Z'), null));
      expect(items.length).toBeGreaterThanOrEqual(5);
      expect(items.every((item) => item.pauses.length === 0)).toBe(true);
      const north = await as((tx) => trace.forHealth(tx, new Date('2027-10-15T00:00:00Z'), new Date('2027-10-16T00:00:00Z'), unitId(SOUTH)));
      expect(north).toEqual([]);
      // Another tenant sees nothing of it.
      expect(await as((tx) => trace.forHealth(tx, new Date('2027-10-15T00:00:00Z'), new Date('2027-10-16T00:00:00Z'), null), TENANT_B)).toEqual([]);
      expect(await as((tx) => trace.lastPassAt(tx), TENANT_B)).toBeNull();
    });

    it('is never deleted by the application, and its facts are checked by the table', async () => {
      await expect(as((tx) => tx.query(`delete from machvon.alert_item_trace where source = 'PERMIT'`))).rejects.toThrow(/permission denied/);
      await expect(as((tx) => tx.query(`update machvon.alert_item_trace set state = 'CLEARED' where source = 'PERMIT' and state = 'OPEN'`))).rejects.toThrow(/alert_item_trace_closed_chk/);
    });
  });

  describe('the levels of escalation', () => {
    const base = (over: Record<string, unknown> = {}): Parameters<AlertEscalationStore['record']>[1] => ({
      source: 'ISSUE',
      sourceId: randomUUID(),
      occurrence: 0,
      level: 1,
      kind: 'HIERARCHICAL',
      trigger: 'NOT_CLAIMED',
      recipientId: memberId(NORTH_LEADER),
      ownerId: memberId(OFFICER),
      routedVia: 'PRIMARY',
      coverId: null,
      severity: 'ACTION',
      fromSeverity: null,
      itemTitle: 'Late issue',
      itemSubtitle: 'Project',
      itemDueOn: '2027-10-14',
      target: { screen: 'ISS-09', id: 'item-1' },
      reachedAt: T0,
      policyVersion: 'builtin',
      seriesKey: `ESCALATION:${randomUUID()}`,
      ...over,
    });

    it('records a level once for a series, and reads what is recorded of the climb of an item', async () => {
      const row = base();
      const one = await as((tx) => escalations.record(tx, row));
      const two = await as((tx) => escalations.record(tx, row));
      expect([one.created, two.created, two.id]).toEqual([true, false, one.id]);
      await as((tx) => escalations.record(tx, base({ sourceId: row.sourceId, level: 2, kind: 'FUNCTIONAL', recipientId: memberId(AUDITOR), seriesKey: `ESCALATION:${randomUUID()}` })));
      const climb = await as((tx) => escalations.climbOf(tx, [{ source: 'ISSUE', sourceId: row.sourceId }]));
      expect(climb.get(`ISSUE:${row.sourceId}`)).toMatchObject({ max: 2, promoted: false });
      expect([...(climb.get(`ISSUE:${row.sourceId}`)?.levels ?? [])].sort()).toEqual([1, 2]);
    });

    it('lets the recipient acknowledge once, refuses another person, and a closed row is final', async () => {
      const row = base();
      const { id } = await as((tx) => escalations.record(tx, row));
      await expect(as((tx) => escalations.acknowledge(tx, id, memberId(LEADER), T1))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      const acked = await as((tx) => escalations.acknowledge(tx, id, memberId(NORTH_LEADER), T1));
      expect(acked.record).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedAt: T1.toISOString() });
      await expect(as((tx) => escalations.acknowledge(tx, id, memberId(NORTH_LEADER), T2))).rejects.toMatchObject({ code: 'ALERT_ESCALATION_STATE_INVALID' });
      const climb = await as((tx) => escalations.climbOf(tx, [{ source: 'ISSUE', sourceId: row.sourceId }]));
      expect(climb.get(`ISSUE:${row.sourceId}`)?.acknowledged).toEqual([{ level: 1, ackedAt: T1 }]);
      expect(await as((tx) => escalations.closeItem(tx, 'ISSUE', row.sourceId, 'RESOLVED', T2))).toBe(1);
      expect(await as((tx) => escalations.closeItem(tx, 'ISSUE', row.sourceId, 'RESOLVED', T2))).toBe(0);
      await expect(as((tx) => tx.query(`update machvon.alert_escalation set status = 'OPEN', closed_at = null, close_reason = null where id = $1`, [id]))).rejects.toThrow(/final/);
      await expect(as((tx) => tx.query(`update machvon.alert_escalation set item_title = 'changed' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
      await expect(as((tx) => tx.query('delete from machvon.alert_escalation where id = $1', [id]))).rejects.toThrow(/permission denied/);
    });

    it('counts the levels of an item that came back after it was closed as its own: the old levels and promotion do not suppress the new ones', async () => {
      const item = observation({ source: 'ADVANCE', kind: 'ADVANCE_OVERDUE', typeCode: 'ADVANCE' });
      await as((tx) => trace.observe(tx, memberId(OFFICER), unitId(NORTH), [item], T0));
      await as((tx) => escalations.record(tx, base({ source: 'ADVANCE', sourceId: item.sourceId, seriesKey: `ESCALATION:ADVANCE:${item.sourceId}:1:x` })));
      await as((tx) => escalations.record(tx, base({ source: 'ADVANCE', sourceId: item.sourceId, level: 0, kind: 'PROMOTION', trigger: 'WATCH_AGED', recipientId: null, routedVia: 'NONE', fromSeverity: 'WATCH', seriesKey: `PROMOTION:ADVANCE:${item.sourceId}` })));
      const key = `ADVANCE:${item.sourceId}`;
      let climb = (await as((tx) => escalations.climbOf(tx, [{ source: 'ADVANCE', sourceId: item.sourceId }]))).get(key);
      expect(climb).toMatchObject({ max: 1, promoted: true });
      // The condition clears and comes back under the same id: a second occurrence.
      await as((tx) => trace.observe(tx, memberId(OFFICER), unitId(NORTH), [{ ...item, resolved: true }], T1));
      await as((tx) => trace.observe(tx, memberId(OFFICER), unitId(NORTH), [item], T2));
      expect((await as((tx) => trace.occurrences(tx, [{ source: 'ADVANCE', sourceId: item.sourceId }]))).get(key)).toBe(1);
      climb = (await as((tx) => escalations.climbOf(tx, [{ source: 'ADVANCE', sourceId: item.sourceId }]))).get(key);
      expect(climb).toBeUndefined();
      // The new occurrence records its own level, with a key of its own, and sees only that.
      await as((tx) => escalations.record(tx, base({ source: 'ADVANCE', sourceId: item.sourceId, occurrence: 1, seriesKey: `ESCALATION:ADVANCE:${item.sourceId}:o1:1:x` })));
      climb = (await as((tx) => escalations.climbOf(tx, [{ source: 'ADVANCE', sourceId: item.sourceId }]))).get(key);
      expect(climb).toMatchObject({ max: 1, promoted: false });
      const rows = [{ source: 'ADVANCE', id: item.sourceId, severity: 'WATCH' as const }];
      await as((tx) => applyPromotions(tx, rows));
      expect(rows[0]?.severity).toBe('WATCH');
    });

    it('refuses by the table a level with no recipient and a promotion with one', async () => {
      await expect(as((tx) => escalations.record(tx, base({ recipientId: null, seriesKey: `ESCALATION:${randomUUID()}` })))).rejects.toThrow(/alert_escalation_shape_chk/);
      await expect(as((tx) => escalations.record(tx, base({ level: 0, kind: 'PROMOTION', trigger: 'WATCH_AGED', routedVia: 'NONE', fromSeverity: 'WATCH', seriesKey: `PROMOTION:${randomUUID()}` })))).rejects.toThrow(/alert_escalation_shape_chk/);
    });

    it('closes the open rows of the items that are closed in the trace', async () => {
      const item = observation({ source: 'ADVANCE', kind: 'ADVANCE_OVERDUE', typeCode: 'ADVANCE' });
      await as((tx) => trace.observe(tx, memberId(OFFICER), unitId(NORTH), [item], T0));
      await as((tx) => escalations.record(tx, base({ source: 'ADVANCE', sourceId: item.sourceId })));
      expect(await as((tx) => escalations.closeOfClosedItems(tx, T1))).toBe(0);
      await as((tx) => trace.observe(tx, memberId(OFFICER), unitId(NORTH), [{ ...item, resolved: true }], T1));
      expect(await as((tx) => escalations.closeOfClosedItems(tx, T2))).toBe(1);
      const rows = await harness.owner<{ status: string; close_reason: string }>(TENANT_A, [['select status, close_reason from machvon.alert_escalation where source_id = $1', [item.sourceId]]]);
      expect(rows).toEqual([{ status: 'CLOSED', close_reason: 'RESOLVED' }]);
    });

    it('finds who could receive a level: the people whose grants reach the place of the owner, how near their unit is, and their rank', async () => {
      const owner = await as((tx) => escalations.ownerOf(tx, memberId(OFFICER), T0));
      expect(owner).toMatchObject({ rank: 40, unitId: unitId(NORTH) });
      const candidates = await as((tx) => escalations.candidatesFor(tx, owner?.unitPath ?? '/', owner?.unitId ?? null, T0));
      const byMember = new Map(candidates.map((candidate) => [candidate.membershipId, candidate]));
      // The leader of the north is in the unit of the owner (two segments shared), the leader of the tenant in the root (one), the auditor and the administrator in the root too.
      expect(byMember.get(memberId(NORTH_LEADER))).toMatchObject({ rank: 60, unitDepth: 2, roleCodes: ['LEADER'] });
      expect(byMember.get(memberId(LEADER))).toMatchObject({ rank: 60, unitDepth: 1 });
      expect(byMember.get(memberId(AUDITOR))).toMatchObject({ rank: 25, roleCodes: ['AUDITOR'] });
      expect(byMember.get(memberId(ADMIN))).toMatchObject({ rank: 90 });
      // The person who left holds a grant, and is not a candidate; a grant of the north does not reach the south.
      expect(byMember.has(memberId(GONE))).toBe(false);
      const south = await as((tx) => escalations.candidatesFor(tx, `/${unitId(ROOT)}/${unitId(SOUTH)}/`, unitId(SOUTH), T0));
      expect(south.some((candidate) => candidate.membershipId === memberId(NORTH_LEADER))).toBe(false);
      expect(south.some((candidate) => candidate.membershipId === memberId(LEADER))).toBe(true);
    });

    it('shows to the recipient what was sent up to them as an item of the alert centre, and to nobody else', async () => {
      const row = base({ sourceId: randomUUID(), recipientId: memberId(NORTH_LEADER), severity: 'URGENT', itemTitle: 'Guarantee ends', target: { screen: 'CTR-05', id: 'g-1' } });
      const { id } = await as((tx) => escalations.record(tx, row));
      const context = (member: number, view: 'mine' | 'scope') => ({ tx: undefined as never, membershipId: memberId(member), now: T0, today: '2027-10-15', view, unitScope: EVERYTHING, projectScope: EVERYTHING, rules: undefined as never, counting: false });
      const rules = DEFAULT_SEVERITY_RULES;
      const mine = await as(async (tx) => sources.escalated({ ...context(NORTH_LEADER, 'mine'), tx, rules }), TENANT_A, NORTH_LEADER);
      const found = mine.find((item) => item.id === id);
      expect(found).toMatchObject({ kind: 'ESCALATED_ITEM', source: 'ESCALATION', severity: 'URGENT', lifecycle: 'NEW', target: { screen: 'CTR-05', id: 'g-1' } });
      expect(found?.title).toContain('Guarantee ends');
      expect(found?.consequence).not.toBeNull();
      expect((await as(async (tx) => sources.escalated({ ...context(OFFICER, 'mine'), tx, rules }), TENANT_A, OFFICER)).some((item) => item.id === id)).toBe(false);
      expect(await as(async (tx) => sources.escalated({ ...context(NORTH_LEADER, 'scope'), tx, rules }), TENANT_A, NORTH_LEADER)).toEqual([]);
      await as((tx) => escalations.acknowledge(tx, id, memberId(NORTH_LEADER), T1));
      const after = await as(async (tx) => sources.escalated({ ...context(NORTH_LEADER, 'mine'), tx, rules }), TENANT_A, NORTH_LEADER);
      expect(after.find((item) => item.id === id)).toMatchObject({ lifecycle: 'CLAIMED', status: 'ACKNOWLEDGED' });
    });

    it('raises an item that was only to be watched when a promotion is recorded for it, and not another', async () => {
      const watched = randomUUID();
      const other = randomUUID();
      const rows = [
        { source: 'PERMIT', id: watched, severity: 'WATCH' as const },
        { source: 'PERMIT', id: other, severity: 'WATCH' as const },
        { source: 'PERMIT', id: randomUUID(), severity: 'ACTION' as const },
      ];
      await as((tx) =>
        escalations.record(tx, base({ source: 'PERMIT', sourceId: watched, level: 0, kind: 'PROMOTION', trigger: 'WATCH_AGED', recipientId: null, routedVia: 'NONE', severity: 'ACTION', fromSeverity: 'WATCH', seriesKey: `PROMOTION:PERMIT:${watched}` })),
      );
      await as((tx) => applyPromotions(tx, rows));
      expect(rows.map((row) => [row.severity, (row as { promotedFrom?: string }).promotedFrom])).toEqual([['ACTION', 'WATCH'], ['WATCH', undefined], ['ACTION', undefined]]);
      expect((await as((tx) => escalations.climbOf(tx, [{ source: 'PERMIT', sourceId: watched }]))).get(`PERMIT:${watched}`)).toMatchObject({ promoted: true, max: 0 });
    });

    it('shows the chain on the card of an item that is going up, and leaves the item the chain does not concern', () => {
      const policy = escalationPolicyDefaults();
      const card = (id: string): Parameters<typeof overlayEscalation>[0][number] => ({
        source: 'ISSUE',
        id,
        severity: 'URGENT',
        lifecycle: 'NEW',
        snoozedUntil: null,
        clocks: { claim: { state: 'BREACHED', started_at: null, due_at: '2027-10-15T02:00:00.000Z', met_at: null }, resolve: null, needsReclaim: null, paused: null },
        escalation: null,
      });
      const going = card('a');
      const quiet = { ...card('b'), clocks: { claim: { state: 'RUNNING', started_at: null, due_at: '2027-10-16T02:00:00.000Z', met_at: null }, resolve: null, needsReclaim: null, paused: null }, escalation: { level: 1, of: 2, nextAt: null, chain: ['own'] } };
      const watch = { ...card('c'), severity: 'WATCH' as const };
      overlayEscalation([going, quiet, watch], { policy, climbs: new Map(), calendars: undefined, now: T0 });
      expect(going.escalation).toMatchObject({ level: 2, of: 4 });
      expect(going.escalation?.chain).toHaveLength(4);
      expect(quiet.escalation).toEqual({ level: 1, of: 2, nextAt: null, chain: ['own'] });
      expect(watch.escalation).toBeNull();
    });
  });

  describe('absences and covers', () => {
    const from = new Date('2027-10-18T00:00:00Z');
    const until = new Date('2027-10-22T00:00:00Z');
    const declare = (member: number, over: Record<string, unknown> = {}) =>
      as((tx) => covers.declareAbsence(tx, { membershipId: memberId(member), kind: 'LEAVE', from, until, reason: 'Annual leave', declaredBy: memberId(member), ...over }), TENANT_A, member);

    it('declares an absence once for a window: an overlap for the same person is refused', async () => {
      const absence = await declare(OFFICER);
      expect(absence).toMatchObject({ status: 'DECLARED', membershipId: memberId(OFFICER), kind: 'LEAVE', version: 1, unitId: unitId(NORTH), reason: 'Annual leave' });
      await expect(declare(OFFICER, { from: new Date('2027-10-20T00:00:00Z'), until: new Date('2027-10-25T00:00:00Z') })).rejects.toMatchObject({ code: 'ALERT_ABSENCE_OVERLAP', status: 409 });
      expect((await declare(OFFICER, { from: new Date('2027-10-22T00:00:00Z'), until: new Date('2027-10-25T00:00:00Z') })).id).not.toBe(absence.id);
      await expect(declare(DEPUTY, { until: from })).rejects.toThrow(/alert_absence_window_chk/);
    });

    it('proposes a cover that waits, is allowed by a third person only, and is revoked by the absent person or the deputy', async () => {
      const absence = await declare(NORTH_LEADER);
      const cover = await as((tx) => covers.proposeCover(tx, { absence, deputyId: memberId(LEADER), from, until, scopeKind: 'ALL', sources: [], requestedBy: memberId(NORTH_LEADER) }));
      expect(cover).toMatchObject({ status: 'PENDING', absentId: memberId(NORTH_LEADER), deputyId: memberId(LEADER), scopeKind: 'ALL', sources: [], version: 1 });
      // The person who proposed it, the absent person and the deputy cannot allow it.
      for (const actor of [NORTH_LEADER, LEADER]) {
        await expect(as((tx) => covers.moveCover(tx, cover.id, 1, 'APPROVE', { actor: memberId(actor), note: undefined, now: T0 }))).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      }
      await expect(as((tx) => covers.moveCover(tx, cover.id, 7, 'APPROVE', { actor: memberId(ADMIN), note: undefined, now: T0 }))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      const allowed = await as((tx) => covers.moveCover(tx, cover.id, 1, 'APPROVE', { actor: memberId(ADMIN), note: 'Agreed', now: T0 }));
      expect(allowed).toMatchObject({ before: 'PENDING', cover: { status: 'APPROVED', decidedBy: memberId(ADMIN), decisionNote: 'Agreed', version: 2 } });
      await expect(as((tx) => covers.moveCover(tx, cover.id, 2, 'APPROVE', { actor: memberId(ADMIN), note: undefined, now: T0 }))).rejects.toMatchObject({ code: 'ALERT_COVER_STATE_INVALID' });
      const revoked = await as((tx) => covers.moveCover(tx, cover.id, 2, 'REVOKE', { actor: memberId(LEADER), note: 'Handed back', now: T1 }));
      expect(revoked.cover).toMatchObject({ status: 'REVOKED', revokedBy: memberId(LEADER), revokeReason: 'Handed back' });
      await expect(as((tx) => covers.moveCover(tx, cover.id, 3, 'REVOKE', { actor: memberId(LEADER), note: undefined, now: T1 }))).rejects.toMatchObject({ code: 'ALERT_COVER_STATE_INVALID' });
    });

    it('keeps by the table that nobody covers themselves, that the one who allows is a third person, and that facts never change', async () => {
      const absence = await declare(DEPUTY, { from: new Date('2027-11-01T00:00:00Z'), until: new Date('2027-11-05T00:00:00Z') });
      await expect(as((tx) => covers.proposeCover(tx, { absence, deputyId: memberId(DEPUTY), from: new Date('2027-11-01T00:00:00Z'), until: new Date('2027-11-05T00:00:00Z'), scopeKind: 'ALL', sources: [], requestedBy: memberId(DEPUTY) }))).rejects.toThrow(/alert_absence_cover_people_chk/);
      await expect(as((tx) => covers.proposeCover(tx, { absence, deputyId: memberId(OFFICER), from: new Date('2027-11-01T00:00:00Z'), until: new Date('2027-11-05T00:00:00Z'), scopeKind: 'SOURCES', sources: [], requestedBy: memberId(DEPUTY) }))).rejects.toThrow(/alert_absence_cover_scope_chk/);
      const cover = await as((tx) => covers.proposeCover(tx, { absence, deputyId: memberId(OFFICER), from: new Date('2027-11-01T00:00:00Z'), until: new Date('2027-11-05T00:00:00Z'), scopeKind: 'SOURCES', sources: ['ISSUE', 'PERMIT'], requestedBy: memberId(DEPUTY) }));
      expect(cover.sources).toEqual(['ISSUE', 'PERMIT']);
      await expect(harness.owner(TENANT_A, [[`update machvon.alert_absence_cover set deputy_membership_id = $2 where id = $1`, [cover.id, memberId(LEADER)]]])).rejects.toThrow(/facts of a cover never change/);
      await expect(harness.owner(TENANT_A, [[`update machvon.alert_absence_cover set status = 'APPROVED', decided_by = $2, decided_at = now(), version = 2 where id = $1`, [cover.id, memberId(DEPUTY)]]])).rejects.toThrow(/alert_absence_cover_third_chk/);
      await expect(as((tx) => tx.query('delete from machvon.alert_absence_cover where id = $1', [cover.id]))).rejects.toThrow(/permission denied/);
    });

    it('lets only one of two decisions on the same version of a cover win, whatever the order they reach the database in', async () => {
      const absence = await declare(OFFICER, { from: new Date('2028-02-01T00:00:00Z'), until: new Date('2028-02-10T00:00:00Z') });
      const cover = await as((tx) => covers.proposeCover(tx, { absence, deputyId: memberId(DEPUTY), from: new Date('2028-02-01T00:00:00Z'), until: new Date('2028-02-05T00:00:00Z'), scopeKind: 'ALL', sources: [], requestedBy: memberId(OFFICER) }));
      const decide = (move: 'APPROVE' | 'REJECT') => as((tx) => covers.moveCover(tx, cover.id, 1, move, { actor: memberId(ADMIN), note: undefined, now: T0 }));
      const settled = await Promise.allSettled([decide('APPROVE'), decide('REJECT')]);
      expect(settled.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
      const lost = settled.find((one) => one.status === 'rejected') as PromiseRejectedResult;
      expect(['VERSION_CONFLICT', 'ALERT_COVER_STATE_INVALID']).toContain((lost.reason as { code: string }).code);
      expect((await as((tx) => covers.findCover(tx, cover.id)))?.version).toBe(2);
    });

    it('ends an absence early or withdraws it, revoking the covers that are still live, and refuses it twice or on a stale version', async () => {
      const absence = await declare(AUDITOR, { from: new Date('2027-12-01T00:00:00Z'), until: new Date('2027-12-10T00:00:00Z') });
      const cover = await as((tx) => covers.proposeCover(tx, { absence, deputyId: memberId(LEADER), from: new Date('2027-12-01T00:00:00Z'), until: new Date('2027-12-05T00:00:00Z'), scopeKind: 'ALL', sources: [], requestedBy: memberId(AUDITOR) }));
      await expect(as((tx) => covers.endAbsence(tx, absence.id, 4, { actor: memberId(AUDITOR), status: 'CANCELLED', reason: 'Plans changed', now: T0 }))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      const done = await as((tx) => covers.endAbsence(tx, absence.id, 1, { actor: memberId(AUDITOR), status: 'CANCELLED', reason: 'Plans changed', now: T0 }));
      expect(done.absence).toMatchObject({ status: 'CANCELLED', endReason: 'Plans changed', version: 2 });
      expect(done.revokedCovers).toEqual([cover.id]);
      expect((await as((tx) => covers.findCover(tx, cover.id)))?.status).toBe('REVOKED');
      await expect(as((tx) => covers.endAbsence(tx, absence.id, 2, { actor: memberId(AUDITOR), status: 'ENDED', reason: 'Back', now: T1 }))).rejects.toMatchObject({ code: 'ALERT_ABSENCE_STATE_INVALID' });
      await expect(as((tx) => covers.endAbsence(tx, randomUUID(), 1, { actor: memberId(AUDITOR), status: 'ENDED', reason: 'Back', now: T1 }))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('lists absences by the scope of the reader and gives the rules their facts: spans, live covers, ranks, who left, who holds a position', async () => {
      const current = await as((tx) => covers.listAbsences(tx, { unitScope: EVERYTHING, state: 'current', now: T0 }));
      expect(current.length).toBeGreaterThanOrEqual(3);
      expect(await as((tx) => covers.listAbsences(tx, { unitScope: () => ({ sql: 'false', params: [] }), state: 'all', now: T0 }))).toEqual([]);
      expect((await as((tx) => covers.listAbsences(tx, { unitScope: EVERYTHING, state: 'current', now: T0, membershipId: memberId(OFFICER) }))).every((absence) => absence.membershipId === memberId(OFFICER))).toBe(true);
      expect(await as((tx) => covers.listAbsences(tx, { unitScope: EVERYTHING, state: 'current', now: T0 }), TENANT_B)).toEqual([]);
      const facts = await as((tx) => covers.personFacts(tx, [memberId(LEADER), memberId(GONE), memberId(ADMIN), randomUUID()], T0));
      expect([...facts.values()].map((fact) => [fact.rank, fact.active]).sort()).toEqual([[0, false], [60, false], [60, true], [90, true]].sort());
      expect([...(await as((tx) => covers.inactiveAmong(tx, [memberId(LEADER), memberId(GONE)], T0)))]).toEqual([memberId(GONE)]);
      const holders = await as((tx) => covers.positionHolders(tx, T0, 60, 90));
      expect(holders.filter((holder) => holder.roleCode === 'LEADER').map((holder) => [holder.membershipId, holder.present]).sort()).toEqual(
        [[memberId(LEADER), true], [memberId(NORTH_LEADER), true], [memberId(GONE), false]].sort(),
      );
      expect(holders.some((holder) => holder.roleCode === 'TENANT_ADMIN')).toBe(false);
      const spans = await as((tx) => covers.absenceSpans(tx, T0));
      expect(spans.some((span) => span.membershipId === memberId(OFFICER))).toBe(true);
      expect((await as((tx) => covers.pendingCovers(tx, EVERYTHING))).every((cover) => cover.status === 'PENDING')).toBe(true);
    });
  });

  describe('the profile and the log of notices', () => {
    it('is replaced whole under its version: version 0 until it is saved, 409 on a stale one, and the quiet hours of NOT-03 are read beside it', async () => {
      const empty = await as((tx) => profiles.get(tx, memberId(OFFICER)), TENANT_A, OFFICER);
      expect(empty).toMatchObject({ version: 0, ownQuiet: null, profile: emptyAlertProfile() });
      const saved = { ...emptyAlertProfile(), channels: { URGENT: ['IN_APP', 'PUSH', 'SMS'] }, quiet: { from: '22:00', to: '06:00', weekends: false, timeZone: 'Asia/Ho_Chi_Minh' }, digest_at: '08:00', push_min_severity: 'URGENT' as const, push_cap_per_day: 3, group_same_root: false };
      expect(await as((tx) => profiles.put(tx, memberId(OFFICER), saved, 0), TENANT_A, OFFICER)).toBe(1);
      await expect(as((tx) => profiles.put(tx, memberId(OFFICER), saved, 0), TENANT_A, OFFICER)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      const read = await as((tx) => profiles.get(tx, memberId(OFFICER)), TENANT_A, OFFICER);
      expect(read).toMatchObject({ version: 1, profile: { channels: { URGENT: ['IN_APP', 'PUSH', 'SMS'] }, quiet: { from: '22:00', to: '06:00', weekends: false }, digest_at: '08:00', push_min_severity: 'URGENT', push_cap_per_day: 3, group_same_root: false, digest_enabled: true } });
      expect(await as((tx) => profiles.put(tx, memberId(OFFICER), { ...saved, quiet: null, push_cap_per_day: null }, 1), TENANT_A, OFFICER)).toBe(2);
      expect((await as((tx) => profiles.get(tx, memberId(OFFICER)), TENANT_A, OFFICER)).profile).toMatchObject({ quiet: null, push_cap_per_day: null });
      await admin([[`insert into machvon.notification_preference_profile (tenant_id, membership_id, quiet_start, quiet_end, time_zone) values ($1, $2, '20:00', '07:00', 'Asia/Ho_Chi_Minh')`, [TENANT_A, memberId(DEPUTY)]]]);
      expect((await as((tx) => profiles.get(tx, memberId(DEPUTY)), TENANT_A, DEPUTY)).ownQuiet).toEqual({ from: '20:00', to: '07:00', timeZone: 'Asia/Ho_Chi_Minh' });
      // A person's profile is theirs: another tenant has none.
      expect((await as((tx) => profiles.get(tx, memberId(OFFICER)), TENANT_B, OFFICER)).version).toBe(0);
    });

    it('refuses by the table a quiet window that is half given, and a cap beyond a hundred', async () => {
      await expect(as((tx) => tx.query(`update machvon.alert_notification_profile set quiet_from = '22:00' where membership_id = $1`, [memberId(OFFICER)]), TENANT_A, OFFICER)).rejects.toThrow(/alert_notification_profile_quiet_chk|check/);
      await expect(as((tx) => tx.query(`update machvon.alert_notification_profile set push_cap_per_day = 101 where membership_id = $1`, [memberId(OFFICER)]), TENANT_A, OFFICER)).rejects.toThrow(/check/);
    });

    it('records a decision once for a series, counts the interrupting notices of a day, and keeps ids and decisions only', async () => {
      const entry = (over: Record<string, unknown> = {}): Parameters<AlertProfileStore['record']>[1] => ({
        recipientId: memberId(OFFICER),
        occasion: 'NEW_ITEM',
        severity: 'URGENT',
        source: 'ISSUE',
        sourceId: randomUUID(),
        channel: 'PUSH',
        decision: 'SEND_NOW',
        holdUntil: null,
        bypass: null,
        inQuiet: false,
        localDay: '2027-10-15',
        seriesKey: `NOTICE:${randomUUID()}`,
        ...over,
      });
      const first = entry();
      expect(await as((tx) => profiles.record(tx, first))).toBe(true);
      expect(await as((tx) => profiles.record(tx, first))).toBe(false);
      await as((tx) => profiles.record(tx, entry({ severity: 'ACTION', decision: 'SEND_GROUPED' })));
      await as((tx) => profiles.record(tx, entry({ decision: 'HOLD_QUIET', holdUntil: T2 })));
      await as((tx) => profiles.record(tx, entry({ channel: 'EMAIL', decision: 'SEND_NOW' })));
      await as((tx) => profiles.record(tx, entry({ localDay: '2027-10-14' })));
      expect(await as((tx) => profiles.countsOf(tx, memberId(OFFICER), '2027-10-15', new Date()))).toEqual({ sentToday: 2, urgentThisHour: 1 });
      expect((await as((tx) => profiles.countsOf(tx, memberId(OFFICER), '2027-10-15', new Date(Date.now() + 1000)))).sentToday).toBe(2);
      // An urgent notice in the quiet hours carries the allowance that let it, or the table refuses it.
      await expect(as((tx) => profiles.record(tx, entry({ inQuiet: true })))).rejects.toThrow(/alert_notification_log_quiet_chk/);
      expect(await as((tx) => profiles.record(tx, entry({ inQuiet: true, bypass: 'URGENT_UNCLAIMED' })))).toBe(true);
      await expect(as((tx) => tx.query(`update machvon.alert_notification_log set decision = 'SEND_NOW'`))).rejects.toThrow(/permission denied/);
      await expect(as((tx) => tx.query('delete from machvon.alert_notification_log'))).rejects.toThrow(/permission denied/);
      const month = await as((tx) => profiles.forHealth(tx, new Date('2000-01-01T00:00:00Z'), new Date('2999-01-01T00:00:00Z')));
      expect(month.length).toBeGreaterThanOrEqual(6);
      expect(await as((tx) => profiles.forHealth(tx, new Date('2000-01-01T00:00:00Z'), new Date('2999-01-01T00:00:00Z')), TENANT_B)).toEqual([]);
      expect(await as((tx) => profiles.lastDigestAt(tx, memberId(OFFICER)))).toBeNull();
      await as((tx) => profiles.record(tx, entry({ occasion: 'DIGEST', channel: 'DIGEST', decision: 'DIGEST', source: null, sourceId: null, severity: 'ACTION' })));
      expect(await as((tx) => profiles.lastDigestAt(tx, memberId(OFFICER)))).not.toBeNull();
    });

    it('knows no consent for a person who gave none', async () => {
      expect(await as((tx) => profiles.consentOf(tx, memberId(ADMIN)))).toEqual({});
    });
  });

  describe('the gaps in coverage', () => {
    const gap = (key: string, over: Record<string, unknown> = {}): Parameters<AlertGapStore['sync']>[2][number] => ({ kind: 'ABSENT_NO_COVER', subjectKey: key, membershipId: memberId(OFFICER), unitId: unitId(NORTH), absenceId: null, itemCount: 2, ...over });

    it('opens a gap once, refreshes its count, and closes it with the reason when the pass no longer finds it', async () => {
      const kinds = ['ABSENT_NO_COVER', 'OWNER_INACTIVE'] as const;
      const one = await as((tx) => gaps.sync(tx, kinds, [gap('GAP:A'), gap('GAP:B', { kind: 'OWNER_INACTIVE' })], T0, () => 'COVERED'));
      expect(one.opened.map((open) => open.subjectKey).sort()).toEqual(['GAP:A', 'GAP:B']);
      const again = await as((tx) => gaps.sync(tx, kinds, [gap('GAP:A', { itemCount: 5 }), gap('GAP:B', { kind: 'OWNER_INACTIVE' })], T1, () => 'COVERED'));
      expect(again.opened).toEqual([]);
      expect((await as((tx) => gaps.list(tx, { open: true, kinds }))).find((open) => open.subjectKey === 'GAP:A')?.itemCount).toBe(5);
      const closed = await as((tx) => gaps.sync(tx, kinds, [gap('GAP:A', { itemCount: 5 })], T2, (open) => (open.kind === 'OWNER_INACTIVE' ? 'RESOLVED' : 'COVERED')));
      expect(closed.closed).toMatchObject([{ subjectKey: 'GAP:B', closeReason: 'RESOLVED' }]);
      expect((await as((tx) => gaps.list(tx, { open: false, kinds }))).map((row) => row.subjectKey)).toEqual(['GAP:B']);
      // Another kind that this pass did not look at is left as it is.
      await as((tx) => gaps.sync(tx, ['NO_LEADER'], [gap('GAP:C', { kind: 'NO_LEADER' })], T0, () => 'COVERED'));
      await as((tx) => gaps.sync(tx, kinds, [], T2, () => 'BACK'));
      expect((await as((tx) => gaps.list(tx, { open: true }))).map((row) => row.subjectKey)).toEqual(['GAP:C']);
    });

    it('gives the health page the gaps that leave an alert with nobody, open or closed in the window', async () => {
      const found = await as((tx) => gaps.forHealth(tx, new Date('2027-10-15T00:00:00Z'), new Date('2027-10-16T00:00:00Z')));
      expect(found.map((row) => row.kind).sort()).toEqual(['ABSENT_NO_COVER', 'NO_LEADER', 'OWNER_INACTIVE']);
      expect(await as((tx) => gaps.forHealth(tx, new Date('2027-10-15T00:00:00Z'), new Date('2027-10-16T00:00:00Z')), TENANT_B)).toEqual([]);
    });

    it('shows a gap to the people whose unit scope reaches the person and who hold the permission to manage covers, and to nobody else', async () => {
      await as((tx) => gaps.sync(tx, ['ABSENT_NO_COVER'], [gap('GAP:D', { absenceId: null })], T0, () => 'COVERED'));
      const rules = DEFAULT_SEVERITY_RULES;
      const context = (holds: boolean, scope: ScopeBuilder) => ({ membershipId: memberId(LEADER), now: T2, today: '2027-10-15', view: 'mine' as const, unitScope: scope, projectScope: EVERYTHING, rules, counting: false, holds: () => holds });
      const seen = await as(async (tx) => sources.coverageGaps({ ...context(true, EVERYTHING), tx }));
      const item = seen.find((row) => row.status === 'ABSENT_NO_COVER');
      expect(item).toMatchObject({ kind: 'COVERAGE_GAP', source: 'COVERAGE', severity: 'ACTION', target: { screen: 'ADM-25' } });
      expect(item?.consequence).not.toBeNull();
      expect(await as(async (tx) => sources.coverageGaps({ ...context(false, EVERYTHING), tx }))).toEqual([]);
      expect(await as(async (tx) => sources.coverageGaps({ ...context(true, () => ({ sql: 'false', params: [] })), tx }))).toEqual([]);
    });
  });

  describe('the policies and the alert centre', () => {
    it('reads the four policies of the governance of the alert system through the port: the built-in default, flagged unverified', async () => {
      const read = await as((tx) => policies.read(tx, '2027-10-15'));
      expect(read.versions).toEqual({ escalation: 'builtin', absence: 'builtin', notify: 'builtin', health: 'builtin' });
      expect(read.unverified).toEqual({ escalation: true, absence: true, notify: true, health: true });
      expect(read.escalation.steps.URGENT).toHaveLength(3);
    });

    it('reads the two new sources through HomeWorkStore, in the counts as well as in the rows, and names them when they cannot be read', async () => {
      const work = new HomeWorkStore();
      const row = await as((tx) =>
        escalations.record(tx, {
          source: 'ISSUE', sourceId: randomUUID(), occurrence: 0, level: 1, kind: 'FUNCTIONAL', trigger: 'OVERDUE', recipientId: memberId(AUDITOR), ownerId: memberId(OFFICER), routedVia: 'PRIMARY', coverId: null, severity: 'ACTION', fromSeverity: null,
          itemTitle: 'Overdue issue', itemSubtitle: null, itemDueOn: null, target: { screen: 'ISS-09', id: 'x' }, reachedAt: T0, policyVersion: 'builtin', seriesKey: `ESCALATION:${randomUUID()}`,
        }),
      );
      const holds = (): boolean => false;
      for (const mode of ['rows', 'count'] as const) {
        const collected = await as((tx) => work.collect(tx, { membershipId: memberId(AUDITOR), now: T0, today: '2027-10-15', unitScope: EVERYTHING, projectScope: EVERYTHING, mode, holds }), TENANT_A, AUDITOR);
        expect(collected.rows.find((found) => found.id === row.id)).toMatchObject({ kind: 'ESCALATED_ITEM', source: 'ESCALATION' });
        expect(collected.unavailableSources).not.toContain('ESCALATION');
        expect(collected.unavailableSources).not.toContain('COVERAGE');
      }
    });
  });
});

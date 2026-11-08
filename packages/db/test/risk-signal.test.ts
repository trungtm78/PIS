import { randomUUID } from 'node:crypto';
import { AuditWriter } from '../src/audit-writer';
import { WORKER_MEMBERSHIP_ID } from '../src/consumer-inbox';
import { RISK_ALERT_RAISED_EVENT, RISK_SIGNAL_SCORED_EVENT, RiskRescoreJob } from '../src/risk-rescore-job';
import { RiskSignalReader } from '../src/risk-signal-reader';
import { RiskSignalStore } from '../src/risk-signal-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';
import { DEPARTMENT, PROVINCE, everything, nothing, seedAs, seedBidPackage, seedMilestone } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const store = new RiskSignalStore();
const OFFICER = 1;
const OTHER = 2;
const NOW = new Date('2026-11-08T03:00:00Z');
const TODAY = '2026-11-08';
const LATER = new Date('2026-11-09T03:00:00Z');

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = OFFICER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const asWorker = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, WORKER_MEMBERSHIP_ID), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const job = (): RiskRescoreJob => new RiskRescoreJob(new AuditWriter(harness.tenants));
const rescore = (now = NOW, tenant = TENANT_A) => asWorker((tx) => job().run(tx, WORKER_MEMBERSHIP_ID, now), tenant);
const scopes = { act: everything, read: everything };

interface Refusal {
  code: string;
  status: number;
  detail?: string;
  extensions?: Record<string, unknown>;
}

async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return String((error as { message?: string }).message);
  }
  throw new Error('expected the database to refuse');
}

let counter = 0;
async function lateMilestone(projectId: string, planned: string, status = 'PLANNED', actual: string | null = null): Promise<string> {
  const milestoneId = randomUUID();
  counter += 1;
  await seedAs(harness, [
    [
      `insert into machvon.project_milestone (tenant_id, id, project_id, code, name, baseline_date, planned_date, actual_date, status, created_by, updated_by)
       values ($1, $2, $3, $4, 'Handover of the site', $5::date, $5::date, $6::date, $7, $8, $8)`,
      [TENANT_A, milestoneId, projectId, `MS-${counter}`, planned, actual, status, memberId(OFFICER)],
    ],
  ]);
  return milestoneId;
}

const lineOf = async (projectId: string, kind: string) => (await owner<{ id: string; status: string; likelihood: number; impact: number; score: number; version: string; evidence: Record<string, unknown>; rule_version: string; rule_unverified: boolean }>(
  `select id, status, likelihood::int as likelihood, impact::int as impact, score::int as score, version::text as version, evidence, rule_version, rule_unverified from machvon.project_risk_signal where project_id = $1 and signal_kind = $2`,
  [projectId, kind],
))[0];
const historyOf = (subjectColumn: 'signal_id' | 'risk_id', subject: string) =>
  owner<{ source: string; likelihood: number; impact: number; score: number; prior_score: number | null; status: string | null; scored_on: string }>(
    `select source, likelihood::int as likelihood, impact::int as impact, score::int as score, prior_score::int as prior_score, status, scored_on::text as scored_on from machvon.project_risk_score_history where ${subjectColumn} = $1 order by scored_at, id`,
    [subject],
  );
const alertsOf = (projectId: string) =>
  owner<{ id: string; alert_type: string; subject_kind: string; status: string; score: number; prior_score: number; threshold: number; rule_version: string; version: string; raised_on: string; resolved_on: string | null }>(
    `select id, alert_type, subject_kind, status, score::int as score, prior_score::int as prior_score, threshold, rule_version, version::text as version, raised_on::text as raised_on, resolved_on::text as resolved_on from machvon.project_risk_alert where project_id = $1 order by raised_at, id`,
    [projectId],
  );
const eventsOf = (aggregateId: string, type: string) => owner<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [aggregateId, type]);
const auditOf = (resourceId: string, action: string) => owner<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at', [resourceId, action]);

let categoryId: string | undefined;
/** One group of risks of the master data, so that a risk can name it (the register of PRJ-16 asks for it). */
async function category(): Promise<string> {
  if (categoryId !== undefined) return categoryId;
  const recordId = randomUUID();
  const versionId = randomUUID();
  await seedAs(harness, [
    [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'RISK_CATEGORY', 'SCHEDULE', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(OFFICER)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, 'RISK_CATEGORY', 'SCHEDULE', 1, 'Schedule', '{}'::jsonb, date '2020-01-01', 'EFFECTIVE', $3, now(), $4, $4)`,
      [TENANT_A, versionId, recordId, memberId(OFFICER)],
    ],
  ]);
  categoryId = versionId;
  return versionId;
}

async function registerRisk(projectId: string, likelihood: number, impact: number): Promise<string> {
  const riskId = randomUUID();
  const categoryVersion = await category();
  counter += 1;
  // Through the owner connection, not the seeding one: the trigger that writes the history of the score must fire.
  await owner(
    `insert into machvon.project_risk (tenant_id, id, project_id, code, category_master_version_id, title, description, likelihood, impact, owner_membership_id, mitigation, due_date, status, created_by, updated_by)
     values ($1, $2, $3, $4, $5, 'Site access delayed', 'Households have not received compensation', $6, $7, $8, 'Weekly meetings with households', '2026-12-31', 'OPEN', $8, $8)`,
    [TENANT_A, riskId, projectId, `RK-${counter}`, categoryVersion, likelihood, impact, memberId(OFFICER)],
  );
  return riskId;
}

describe('the risk register scored from live signals (MR.02, G1-14)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: `/${unitId(PROVINCE)}/` },
        { n: DEPARTMENT, path: `/${unitId(PROVINCE)}/${unitId(DEPARTMENT)}/`, parent: PROVINCE },
      ]);
      for (const member of [OFFICER, OTHER]) await harness.seedMembership(tenant, member, PROVINCE);
    }
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('opens a line for a signal that is active, with the evidence, the history, the audit row and the event, and alerts when the score starts critical', async () => {
    const seeded = await seedBidPackage(harness);
    await lateMilestone(seeded.projectId, '2026-10-01');
    const result = await rescore();
    expect(result.ruleVersion).toBe('built-in:1');
    expect(result.ruleUnverified).toBe(true);
    expect(result.opened).toBeGreaterThanOrEqual(1);

    const line = await lineOf(seeded.projectId, 'SCHEDULE_DELAY');
    expect(line).toMatchObject({ status: 'ACTIVE', likelihood: 4, impact: 4, score: 16, version: '1', rule_version: 'built-in:1', rule_unverified: true });
    expect(line?.evidence).toMatchObject({ indicators: { MILESTONE_SLIP_DAYS: 38 }, unknown: ['SPI_SHORTFALL_PCT'] });
    const history = await historyOf('signal_id', line?.id ?? '');
    expect(history).toEqual([{ source: 'JOB', likelihood: 4, impact: 4, score: 16, prior_score: null, status: 'ACTIVE', scored_on: TODAY }]);
    expect(await auditOf(line?.id ?? '', 'project.risk_signal_scored')).toHaveLength(1);
    expect((await eventsOf(line?.id ?? '', RISK_SIGNAL_SCORED_EVENT))[0]?.payload).toMatchObject({ project_id: seeded.projectId, signal_kind: 'SCHEDULE_DELAY', move: 'OPEN', score: 16, severity: 'CRITICAL', rule_version: 'built-in:1' });

    const alerts = await alertsOf(seeded.projectId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ alert_type: 'RISK_SCORE_CRITICAL', subject_kind: 'SIGNAL', status: 'OPEN', score: 16, prior_score: 0, threshold: 15, rule_version: 'built-in:1' });
    expect((await eventsOf(alerts[0]?.id ?? '', RISK_ALERT_RAISED_EVENT))[0]?.payload).toMatchObject({ alert_type: 'RISK_SCORE_CRITICAL', score: 16 });
  });

  it('writes nothing the second time: the same pass, run again or by two runners at once, changes no line, no history and no alert', async () => {
    const seeded = await seedBidPackage(harness);
    await lateMilestone(seeded.projectId, '2026-10-01');
    await rescore();
    const before = await lineOf(seeded.projectId, 'SCHEDULE_DELAY');
    const alertsBefore = await alertsOf(seeded.projectId);
    await Promise.all([rescore(), rescore(LATER)]);
    const after = await lineOf(seeded.projectId, 'SCHEDULE_DELAY');
    expect(after?.version).toBe(before?.version);
    expect(await historyOf('signal_id', before?.id ?? '')).toHaveLength(1);
    expect(await alertsOf(seeded.projectId)).toEqual(alertsBefore);
    expect(await auditOf(before?.id ?? '', 'project.risk_signal_scored')).toHaveLength(1);
    // The day it was looked at moves on, with no new version.
    const days = await owner<{ last: string }>('select last_scored_on::text as last from machvon.project_risk_signal where id = $1', [before?.id]);
    expect(['2026-11-08', '2026-11-09']).toContain(days[0]?.last);
  });

  it('re-scores a line whose signal moved, keeps the history in order, and raises the jump alert for a rise by the points of the rule', async () => {
    const seeded = await seedBidPackage(harness);
    const milestone = await lateMilestone(seeded.projectId, '2026-10-30');
    await rescore();
    const first = await lineOf(seeded.projectId, 'SCHEDULE_DELAY');
    expect(first).toMatchObject({ likelihood: 2, score: 8, version: '1' });
    expect(await alertsOf(seeded.projectId)).toHaveLength(0);

    await owner(`update machvon.project_milestone set planned_date = '2026-10-05' where id = $1`, [milestone]);
    await rescore(LATER);
    const second = await lineOf(seeded.projectId, 'SCHEDULE_DELAY');
    // 35 days late on the 9th of November: likelihood 4, impact 4, score 16.
    expect(second).toMatchObject({ likelihood: 4, score: 16, version: '2' });
    const history = await historyOf('signal_id', first?.id ?? '');
    expect(history.map((row) => [row.score, row.prior_score])).toEqual([
      [8, null],
      [16, 8],
    ]);
    const alerts = await alertsOf(seeded.projectId);
    expect(alerts.map((alert) => alert.alert_type).sort()).toEqual(['RISK_SCORE_CRITICAL', 'RISK_SCORE_JUMP']);
    expect(alerts.find((alert) => alert.alert_type === 'RISK_SCORE_JUMP')).toMatchObject({ score: 16, prior_score: 8, threshold: 6 });
    expect(alerts.find((alert) => alert.alert_type === 'RISK_SCORE_CRITICAL')).toMatchObject({ prior_score: 8, threshold: 15 });
  });

  it('clears a line when the signal falls, ends the standing critical alert the same day, and does not raise it again until the score crosses again', async () => {
    const seeded = await seedBidPackage(harness);
    const milestone = await lateMilestone(seeded.projectId, '2026-10-01');
    await rescore();
    const line = await lineOf(seeded.projectId, 'SCHEDULE_DELAY');
    expect(await alertsOf(seeded.projectId)).toHaveLength(1);

    await owner(`update machvon.project_milestone set status = 'DONE', actual_date = '2026-11-08' where id = $1`, [milestone]);
    const done = await rescore(LATER);
    expect(done.cleared).toBeGreaterThanOrEqual(1);
    const cleared = await lineOf(seeded.projectId, 'SCHEDULE_DELAY');
    expect(cleared).toMatchObject({ status: 'CLEARED', likelihood: 1, version: '2' });
    const history = await historyOf('signal_id', line?.id ?? '');
    expect(history.map((row) => [row.status, row.score])).toEqual([
      ['ACTIVE', 16],
      ['CLEARED', 4],
    ]);
    const alerts = await alertsOf(seeded.projectId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ status: 'RESOLVED', resolved_on: '2026-11-09' });
    expect(done.alertsResolved).toBeGreaterThanOrEqual(1);

    // The signal comes back: the line is open again (the same row, one more version) and the alert is a new one.
    // A milestone that is done is never changed (the database keeps it): the signal comes back with a new one that is late.
    await lateMilestone(seeded.projectId, '2026-10-10', 'DELAYED');
    await rescore(new Date('2026-11-10T03:00:00Z'));
    const again = await lineOf(seeded.projectId, 'SCHEDULE_DELAY');
    expect(again).toMatchObject({ id: line?.id, status: 'ACTIVE', version: '3' });
    const raised = await alertsOf(seeded.projectId);
    expect(raised).toHaveLength(2);
    expect(raised.map((alert) => alert.status)).toEqual(['RESOLVED', 'OPEN']);
  });

  it('never turns what it could not know into a zero: no milestone, no baseline and no schedule give no line, and a tenant without the claim register has no count of claims', async () => {
    const seeded = await seedBidPackage(harness);
    await rescore();
    expect(await lineOf(seeded.projectId, 'SCHEDULE_DELAY')).toBeUndefined();
    expect(await lineOf(seeded.projectId, 'FUNDING_GAP')).toBeUndefined();
    expect(await lineOf(seeded.projectId, 'CLAIM_EARLY_WARNING')).toBeUndefined();
    const read = await as((tx) => new RiskSignalReader().read(tx, [{ id: seeded.projectId, code: seeded.projectCode, status: 'IMPLEMENTATION', projectGroup: 'B' }], TODAY));
    const readings = read.get(seeded.projectId)?.readings;
    expect(readings?.MILESTONE_SLIP_DAYS).toBeNull();
    expect(readings?.SPI_SHORTFALL_PCT).toBeNull();
    expect(readings?.FUNDING_GAP_PCT).toBeNull();
    expect(readings?.PROCUREMENT_SLIP_DAYS).toBeNull();
    expect(readings?.PAYMENT_BLOCKED_DRAFTS).toBe(0);
    expect(readings?.EARLY_WARNINGS_HIGH).toBe(0);
    expect(read.get(seeded.projectId)?.facts).toMatchObject({ claim_register: false });
  });

  it('scores the delay of the procurement milestones of the packages of the project', async () => {
    const seeded = await seedBidPackage(harness);
    await seedMilestone(harness, seeded.packageId, 'BID_OPENING', { planned: '2026-10-20T03:00:00Z' });
    await rescore();
    const line = await lineOf(seeded.projectId, 'PROCUREMENT_DELAY');
    expect(line).toMatchObject({ status: 'ACTIVE', likelihood: 3, impact: 3, score: 9 });
    expect(line?.evidence).toMatchObject({ indicators: { PROCUREMENT_SLIP_DAYS: 19 } });
  });

  it('gives a risk that people wrote a row of history whenever its score moves, and the same alert at the critical line', async () => {
    const seeded = await seedBidPackage(harness);
    const riskId = await registerRisk(seeded.projectId, 5, 4);
    const history = await historyOf('risk_id', riskId);
    expect(history).toEqual([{ source: 'MANUAL', likelihood: 5, impact: 4, score: 20, prior_score: null, status: 'OPEN', scored_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
    await owner('update machvon.project_risk set likelihood = 3, version = version + 1 where id = $1', [riskId]);
    await owner('update machvon.project_risk set title = $2 where id = $1', [riskId, 'Site access still delayed']);
    expect((await historyOf('risk_id', riskId)).map((row) => [row.score, row.prior_score])).toEqual([
      [20, null],
      [12, 20],
    ]);
    await owner('update machvon.project_risk set likelihood = 5, version = version + 1 where id = $1', [riskId]);
    const done = await rescore();
    expect(done.alertsRaised).toBeGreaterThanOrEqual(1);
    const alerts = await alertsOf(seeded.projectId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ alert_type: 'RISK_SCORE_CRITICAL', subject_kind: 'REGISTER', status: 'OPEN', score: 20, prior_score: 12 });
    // Lowered, it ends the alert.
    await owner('update machvon.project_risk set likelihood = 2, version = version + 1 where id = $1', [riskId]);
    await rescore(LATER);
    expect((await alertsOf(seeded.projectId))[0]).toMatchObject({ status: 'RESOLVED', resolved_on: '2026-11-09' });
  });

  it('keeps the history append-only and a resolved alert final, in the database', async () => {
    const seeded = await seedBidPackage(harness);
    await lateMilestone(seeded.projectId, '2026-10-01');
    await rescore();
    const line = await lineOf(seeded.projectId, 'SCHEDULE_DELAY');
    expect(await databaseRefusal(owner('update machvon.project_risk_score_history set likelihood = 1 where signal_id = $1', [line?.id]))).toContain('append-only');
    expect(await databaseRefusal(owner('delete from machvon.project_risk_score_history where signal_id = $1', [line?.id]))).toContain('append-only');
    const alert = (await alertsOf(seeded.projectId))[0];
    expect(await databaseRefusal(owner('update machvon.project_risk_alert set score = 3 where id = $1', [alert?.id]))).toContain('never changes');
    expect(await databaseRefusal(owner('delete from machvon.project_risk_alert where id = $1', [alert?.id]))).toContain('append-only');
    expect(await databaseRefusal(owner('update machvon.project_risk_signal set likelihood = 9 where id = $1', [line?.id]))).toBeTruthy();
    expect(await databaseRefusal(owner("update machvon.project_risk_signal set status = 'CLEARED', cleared_on = '2026-11-08' where id = $1", [line?.id]))).toBeTruthy();
  });

  describe('the board, the project view and the alerts', () => {
    it('lists the lines and the risks of the register in the scope of the reader, highest first, with the trend and the standing alert', async () => {
      const seeded = await seedBidPackage(harness);
      const milestone = await lateMilestone(seeded.projectId, '2026-10-30');
      await registerRisk(seeded.projectId, 2, 2);
      await rescore();
      await owner(`update machvon.project_milestone set planned_date = '2026-10-05' where id = $1`, [milestone]);
      await rescore(LATER);
      const board = await as((tx) => store.board(tx, everything, { kind: undefined, level: undefined, limit: 500, after: undefined }));
      const mine = board.items.filter((item) => item.projectId === seeded.projectId);
      expect(mine.map((item) => [item.origin, item.score])).toEqual([
        ['SIGNAL', 16],
        ['REGISTER', 4],
      ]);
      expect(mine[0]).toMatchObject({ level: 'CRITICAL', previousScore: 8, trend: 'UP', alertOpen: true, kind: 'SCHEDULE_DELAY', ruleUnverified: true });
      expect(mine[1]).toMatchObject({ level: 'LOW', trend: 'NEW', alertOpen: false, kind: 'REGISTER' });
      expect(board.counts.total).toBeGreaterThanOrEqual(2);
      expect(board.counts.critical).toBeGreaterThanOrEqual(1);
      expect(board.counts.openAlerts).toBeGreaterThanOrEqual(1);

      const critical = await as((tx) => store.board(tx, everything, { kind: undefined, level: 'CRITICAL', limit: 500, after: undefined }));
      expect(critical.items.every((item) => item.score >= 15)).toBe(true);
      const onlyRegister = await as((tx) => store.board(tx, everything, { kind: 'REGISTER', level: undefined, limit: 500, after: undefined }));
      expect(onlyRegister.items.every((item) => item.origin === 'REGISTER')).toBe(true);
      expect((await as((tx) => store.board(tx, nothing, { kind: undefined, level: undefined, limit: 50, after: undefined }))).items).toEqual([]);
    });

    it('pages by the rank key without repeating or losing an item', async () => {
      const first = await as((tx) => store.board(tx, everything, { kind: undefined, level: undefined, limit: 2, after: undefined }));
      expect(first.items).toHaveLength(2);
      const last = first.items[1];
      const second = await as((tx) => store.board(tx, everything, { kind: undefined, level: undefined, limit: 2, after: { code: last?.rankKey ?? '', id: last?.id ?? '' } }));
      const ids = [...first.items, ...second.items].map((item) => `${item.origin}:${item.id}`);
      expect(new Set(ids).size).toBe(ids.length);
      expect((second.items[0]?.rankKey ?? '') > (last?.rankKey ?? '')).toBe(true);
    });

    it('shows the history of a project newest first with its lines and alerts, and does not find a project out of sight', async () => {
      const seeded = await seedBidPackage(harness);
      await lateMilestone(seeded.projectId, '2026-10-01');
      await registerRisk(seeded.projectId, 4, 4);
      await rescore();
      const view = await as((tx) => store.projectView(tx, everything, seeded.projectId));
      expect(view.project.code).toBe(seeded.projectCode);
      expect(view.lines.map((line) => line.signalKind)).toEqual(['SCHEDULE_DELAY']);
      expect(view.history.map((row) => row.subjectKind).sort()).toEqual(['REGISTER', 'SIGNAL']);
      expect(view.alerts.length).toBeGreaterThanOrEqual(1);
      expect((await refusal(as((tx) => store.projectView(tx, nothing, seeded.projectId)))).code).toBe('RESOURCE_NOT_FOUND');
      expect((await refusal(as((tx) => store.projectView(tx, everything, randomUUID())))).status).toBe(404);
    });

    it('keeps the tenants apart: another tenant sees none of the lines, the history or the alerts', async () => {
      const board = await as((tx) => store.board(tx, everything, { kind: undefined, level: undefined, limit: 50, after: undefined }), OFFICER, TENANT_B);
      expect(board.items).toEqual([]);
      expect(board.counts).toEqual({ total: 0, critical: 0, medium: 0, low: 0, openAlerts: 0 });
      expect(await as((tx) => store.listAlerts(tx, everything, {}, 50), OFFICER, TENANT_B)).toEqual([]);
      const inB = await owner<{ count: string }>('select count(*)::text as count from machvon.project_risk_signal', [], TENANT_B);
      expect(inB[0]?.count).toBe('0');
    });

    it('acknowledges an alert with a note once, under the version the caller saw, and refuses the rest', async () => {
      const seeded = await seedBidPackage(harness);
      await lateMilestone(seeded.projectId, '2026-10-01');
      await rescore();
      const alert = (await alertsOf(seeded.projectId))[0];
      const request = { alertId: alert?.id ?? '', expectedVersion: Number(alert?.version), note: 'Seen; the site handover is being brought forward', actor: memberId(OTHER), scopes };
      expect((await refusal(as((tx) => store.acknowledge(tx, { ...request, expectedVersion: 9 }), OTHER))).code).toBe('VERSION_CONFLICT');
      expect((await refusal(as((tx) => store.acknowledge(tx, { ...request, note: '   ' }), OTHER))).detail).toBe('note');
      expect((await refusal(as((tx) => store.acknowledge(tx, { ...request, scopes: { act: nothing, read: nothing } }), OTHER))).status).toBe(404);
      expect((await refusal(as((tx) => store.acknowledge(tx, { ...request, scopes: { act: nothing, read: everything } }), OTHER))).code).toBe('SCOPE_DENIED');
      const done = await as((tx) => store.acknowledge(tx, request), OTHER);
      expect(done).toMatchObject({ status: 'ACKNOWLEDGED', version: 2, acknowledgeNote: 'Seen; the site handover is being brought forward', projectCode: seeded.projectCode });
      expect((await refusal(as((tx) => store.acknowledge(tx, { ...request, expectedVersion: 2 }), OTHER))).code).toBe('RISK_ALERT_STATE_INVALID');
      const listed = await as((tx) => store.listAlerts(tx, everything, { status: 'ACKNOWLEDGED', projectId: seeded.projectId }, 10));
      expect(listed).toHaveLength(1);
      expect(listed[0]?.acknowledgedAt).not.toBeNull();
      // A second pass does not raise the alert again while the score stays above the line.
      await rescore(LATER);
      expect(await alertsOf(seeded.projectId)).toHaveLength(1);
    });
  });
});

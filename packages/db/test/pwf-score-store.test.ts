import { randomUUID } from 'node:crypto';
import { pwfKpi, vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { PrjProjectStore } from '../src/prj-project-store';
import { PwfKpiStore } from '../src/pwf-kpi-store';
import { verifySnapshot } from '../src/pwf-score-compute';
import { factsOf, loadTaskBundles, readingOf } from '../src/pwf-score-facts';
import type { TaskBundle } from '../src/pwf-score-facts';
import { PwfScoreAdjustmentStore } from '../src/pwf-score-adjustment-store';
import { WORKER_MEMBERSHIP_ID } from '../src/consumer-inbox';
import { PwfScoreMaintenanceJob } from '../src/pwf-score-job';
import { AuditWriter } from '../src/audit-writer';
import { PwfScoreReads } from '../src/pwf-score-reads';
import type { Viewer } from '../src/pwf-score-reads';
import { PwfScoreStore } from '../src/pwf-score-store';
import { NO_SCORE_SCOPE, SYSTEM_SCORE_SCOPE, withScoreScope } from '../src/pwf-score-support';
import { PwfWorkflowStore } from '../src/pwf-workflow-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

jest.setTimeout(300_000);

const harness = new AuthzHarness();
const projects = new PrjProjectStore();
const workflows = new PwfWorkflowStore();
const kpis = new PwfKpiStore();
const scores = new PwfScoreStore();
const reads = new PwfScoreReads();
const adjustments = new PwfScoreAdjustmentStore();

const MANAGER = 1;
const WORKER = 2;
const CHECKER = 3;
const OTHER = 4;
const OUTSIDER = 5;
const HR = 6;
const RETIRING = 7;
const PROVINCE = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const SIBLING = 4;
const TODAY = vietnamDateOf(new Date());
/** The days of the tests are fixed in 2025 and 2024 (calendars of Monday to Friday are published for them), so that no weekday moves with the clock. */
const Y = 2025;
const Q = {
  DRAFT: { from: `${Y}-01-01`, to: `${Y}-03-31` },
  SHARES: { from: `${Y}-04-01`, to: `${Y}-06-30` },
  LOCK: { from: `${Y}-07-01`, to: `${Y}-09-30` },
  GAMING: { from: `${Y}-10-01`, to: `${Y}-12-31` },
  RACE: { from: `${Y - 1}-01-01`, to: `${Y - 1}-03-31` },
} as const;
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
const scopes = { act: everything, read: everything };
const DEPT = unitId(DEPARTMENT);

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MANAGER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [["select set_config('app.scope_units', '*', false)"], [sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const sqlState = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? '';
  }
  throw new Error('expected the database to refuse');
};

const TESTFLOW = {
  name: 'Test flow',
  phases: [{ code: 'P1', name: 'Phase one', gates: [] }],
  tasks: [
    {
      code: 'TA', name: 'Task A', phase: 'P1', kind: 'TASK', duration_working_days: 3, required: true, responsible_role: 'WORKER_ROLE', approver_role: 'CHECKER_ROLE', priority: 'HIGH', predecessors: [],
      legal_doc_types: [], form_templates: [], checklist: [], kpi_codes: [], when: [],
    },
  ],
};

let counter = 0;
let areaVersion = '';

async function seedArea(tenant: string): Promise<string> {
  const recordId = randomUUID();
  const versionId = randomUUID();
  await harness.owner(tenant, [
    [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', $3, 'EFFECTIVE', $4, $4)`, [tenant, recordId, `AREA-${tenant.slice(-1)}`, memberId(MANAGER)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, 'AREA', $3, 1, 'Area', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $4, now(), $5, $5)`,
      [tenant, versionId, `AREA-${tenant.slice(-1)}`, recordId, memberId(MANAGER)],
    ],
  ]);
  return versionId;
}

/** A workflow of a project of the department: the tasks are seeded next to it by hand, with the dates the test needs. */
async function workflow(): Promise<{ id: string; projectId: string }> {
  counter += 1;
  const code = `SC-${counter}-${randomUUID().slice(0, 6)}`;
  const created = await as((tx) => projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: DEPT, areaMasterVersionId: areaVersion, totalInvestmentVnd: '500000000000' }, memberId(MANAGER), TODAY));
  await owner('update machvon.project set status = $2, project_group = $3 where id = $1::uuid', [created.id, 'IMPLEMENTATION', 'B']);
  const started = await as((tx) => workflows.start(tx, { projectId: created.id, templateCode: 'SCOREFLOW', plannedStartDate: `${Y}-01-06`, facts: { project_group: 'B' }, actor: memberId(MANAGER), scopes, now: new Date() }));
  // The first baseline of the workflow was taken before the period.
  await owner('update machvon.project_workflow_baseline set taken_at = $2::timestamptz where workflow_id = $1::uuid and version = 1', [started.id, `${Y}-01-06T03:00:00Z`]);
  return { id: started.id, projectId: created.id };
}

interface TaskSeed {
  status?: string;
  baselineFinish: string | null;
  baselineStart?: string;
  actualStart?: string | null;
  actualFinish?: string | null;
  cancelledBy?: number;
  cancelledAt?: string;
  priority?: string;
  days?: number;
  returns?: number;
  own?: boolean;
  createdAt?: string;
  estimate?: number;
  actual?: number;
  phase?: string;
}

async function seedTask(wf: { id: string; projectId: string }, code: string, seed: TaskSeed): Promise<string> {
  const status = seed.status ?? 'DONE';
  const rows = await owner<{ id: string }>(
    `insert into machvon.project_task (tenant_id, workflow_id, project_id, task_code, name, phase_code, sort_order, kind, required, responsible_role, priority, duration_working_days, own_task, status, tracked,
        baseline_start, baseline_finish, planned_start, planned_finish, actual_start, actual_finish, return_count, cancelled_by, cancelled_at, estimate_vnd, actual_vnd, created_at, created_by, updated_by)
     values ($1, $2::uuid, $3::uuid, $4, $5, $6, 900, 'TASK', false, 'WORKER_ROLE', $7, $8, $9, $10, true, $11::date, $12::date, $11::date, $12::date, $13::date, $14::date, $15, $16::uuid, $17::timestamptz, $18, $19,
        coalesce($20::timestamptz, now()), $21::uuid, $21::uuid) returning id`,
    [
      TENANT_A, wf.id, wf.projectId, code, `Task ${code}`, seed.phase ?? 'P1', seed.priority ?? 'NORMAL', seed.days ?? 10, seed.own ?? true, status,
      seed.baselineStart ?? seed.baselineFinish, seed.baselineFinish, seed.actualStart === undefined ? (status === 'NOT_STARTED' ? null : (seed.baselineStart ?? seed.baselineFinish)) : seed.actualStart,
      seed.actualFinish === undefined ? (status === 'DONE' ? seed.baselineFinish : null) : seed.actualFinish, seed.returns ?? 0, seed.cancelledBy === undefined ? null : memberId(seed.cancelledBy), seed.cancelledAt ?? null,
      seed.estimate ?? null, seed.actual ?? null, seed.createdAt ?? null, memberId(MANAGER),
    ],
  );
  const id = (rows[0] as { id: string }).id;
  // A task sent back has an entry of the log for every return, on the day it happened: the counts of a period are read from the log, never from the present counter.
  for (let n = 0; n < (seed.returns ?? 0); n += 1) await logReturn(wf.id, id, `${seed.baselineStart ?? seed.baselineFinish}T03:00:00Z`);
  return id;
}

const logReturn = (workflowId: string, taskId: string, at: string): Promise<unknown> =>
  owner("insert into machvon.project_task_log (tenant_id, workflow_id, task_id, kind, at, actor, subject) values ($1, $2::uuid, $3::uuid, 'RETURNED', $4::timestamptz, $5::uuid, '{}'::jsonb)", [TENANT_A, workflowId, taskId, at, memberId(MANAGER)]);

const hold = (taskId: string, who: number, over: { role?: string; from?: string; to?: string | null; share?: number } = {}): Promise<unknown> =>
  owner(
    `insert into machvon.project_task_assignment (tenant_id, task_id, membership_id, role, valid_from, valid_to, share_pct, reason, assigned_by) values ($1, $2::uuid, $3::uuid, $4, $5::date, $6::date, $7, 'Held for the test', $8::uuid)`,
    [TENANT_A, taskId, memberId(who), over.role ?? 'RESPONSIBLE', over.from ?? '2020-01-01', over.to === undefined ? null : over.to, over.share ?? 100, memberId(MANAGER)],
  );

const compute = (quarter: { from: string; to: string }, over: Partial<Parameters<PwfScoreStore['compute']>[1]> = {}, member = MANAGER) =>
  as((tx) => scores.compute(tx, { scopeUnitId: DEPT, periodFrom: quarter.from, periodTo: quarter.to, policyCode: 'TESTPOL', actor: memberId(member), units: '*', now: new Date(), ...over }), member);
const lockIt = (periodId: string, version: number, over: Partial<Parameters<PwfScoreStore['lock']>[1]> = {}) =>
  as((tx) => scores.lock(tx, { periodId, expectedVersion: version, actor: memberId(MANAGER), units: '*', now: new Date(), ...over }));

const viewer = (member: number, over: Partial<Viewer> = {}): Viewer => ({ membershipId: memberId(member), readUnits: '', adjustUnits: '', reviewUnits: '', today: TODAY, ...over });
const lineOf = async (periodId: string, member: number): Promise<{ id: string; version: number; score_computed: string | null; score_adjusted: string | null; state: string }> =>
  (await owner<{ id: string; version: number; score_computed: string | null; score_adjusted: string | null; state: string }>('select id, version, score_computed::text, score_adjusted::text, state from machvon.staff_score_line where period_id = $1::uuid and membership_id = $2::uuid', [periodId, memberId(member)]))[0] as never;

describe('the KPIs of the tasks and the scores of the staff (PWF-3: results, periods, lock, privacy, adjustments, responses, anti-gaming)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: ELSEWHERE, path: '/u3/' },
        { n: SIBLING, path: '/u1/u4/', parent: PROVINCE },
      ]);
      await harness.seedMembership(tenant, MANAGER, PROVINCE);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: '00000000-0000-4000-8000-000000000000', scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, '00000000-0000-4000-8000-000000000000', TODAY));
    }
    for (const n of [WORKER, CHECKER, OTHER]) await harness.seedMembership(TENANT_A, n, DEPARTMENT);
    await harness.seedMembership(TENANT_A, OUTSIDER, SIBLING);
    await harness.seedMembership(TENANT_A, HR, PROVINCE);
    await harness.seedMembership(TENANT_A, RETIRING, PROVINCE);
    areaVersion = await seedArea(TENANT_A);
    await harness.owner(
      TENANT_A,
      [Y - 2, Y - 1, Y, Y + 1].map((year): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
        [TENANT_A, year, memberId(MANAGER)],
      ]),
    );
    const rule = (type: string, code: string, params: unknown): Promise<unknown> =>
      owner(
        `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
         values ($1, $2, $3, 1, 'APPROVED', $4::jsonb, date '2020-01-01', 'A rule for the tests', $5, $6, now(), $7, now())`,
        [TENANT_A, type, code, JSON.stringify(params), memberId(MANAGER), memberId(WORKER), memberId(CHECKER)],
      );
    await rule('PROJECT_WORKFLOW_TEMPLATE', 'SCOREFLOW', TESTFLOW);
    await rule('STAFF_SCORING_POLICY', 'TESTPOL', { ...pwfKpi.DEFAULT_STAFF_SCORING_PARAMS, min_rated_tasks: 1, min_effective_weight: 0.5 });
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the results of the KPIs of a task (BR-PWF-30 to 33)', () => {
    it('UAT-PWF-KPI-01: writes one result for each KPI of the set of a done task, with the value, the score, the weight and the hash of the facts read, and the score of the task follows the formulas', async () => {
      const wf = await workflow();
      const task = await seedTask(wf, 'K1', { baselineFinish: `${Y}-02-14`, actualFinish: `${Y}-02-21`, estimate: 1_000_000, actual: 1_100_000 });
      const summary = await as((tx) => kpis.record(tx, [task], new Date()));
      expect(summary).toEqual({ tasks: 1, written: 6, unchanged: 0 });
      const heads = (await as((tx) => kpis.heads(tx, [task]))).get(task) ?? [];
      const byCode = Object.fromEntries(heads.map((row) => [row.kpiCode, row]));
      expect(byCode.PWF_TASK_DEVIATION_DAYS).toMatchObject({ operation: 'DAYS_DEVIATION', state: 'OK', value: 5, score: 50, weight: 40 });
      expect(byCode.PWF_ON_TIME_RATE).toMatchObject({ state: 'OK', value: 0, score: 0 });
      expect(byCode.PWF_AMOUNT_VARIANCE_PCT).toMatchObject({ state: 'OK', value: 10, score: 50 });
      expect(byCode.PWF_RETURN_COUNT).toMatchObject({ value: 0, score: 100 });
      expect(byCode.PWF_EVIDENCE_COMPLETENESS).toMatchObject({ state: 'NOT_APPLICABLE', value: null, score: null });
      expect(byCode.PWF_RESCHEDULE_COUNT).toMatchObject({ value: 0, score: 100 });
      expect(heads.every((row) => /^[0-9a-f]{64}$/.test(row.inputsHash) && row.kpiSetVersion === 0)).toBe(true);
      expect(byCode.PWF_TASK_DEVIATION_DAYS?.inputs).toMatchObject({ operation: 'DAYS_DEVIATION', as_of: `${Y}-02-21`, facts: { baselineDueFirst: `${Y}-02-14`, actualFinish: `${Y}-02-21` } });
      const taskScore = pwfKpi.taskScoreOf(heads.map((row) => ({ kpiCode: row.kpiCode, operation: row.operation, state: row.state, value: row.value, score: row.score, weight: row.weight, inputsHash: row.inputsHash })));
      expect(taskScore.score).toBe(44.44);
      expect(taskScore.leftOut).toEqual([{ kpiCode: 'PWF_EVIDENCE_COMPLETENESS', reason: 'NOT_APPLICABLE' }]);
    });

    it('is idempotent, and a correction of the facts is a NEW result that names the old one: the old row is never edited or removed', async () => {
      const wf = await workflow();
      const task = await seedTask(wf, 'K2', { baselineFinish: `${Y}-02-14`, actualFinish: `${Y}-02-14`, estimate: 1_000_000, actual: 1_000_000 });
      await as((tx) => kpis.record(tx, [task], new Date()));
      expect(await as((tx) => kpis.record(tx, [task], new Date()))).toEqual({ tasks: 1, written: 0, unchanged: 6 });
      const [before] = await owner<{ id: string }>("select id from machvon.task_kpi_result where task_id = $1::uuid and kpi_code = 'PWF_AMOUNT_VARIANCE_PCT'", [task]);
      await owner('update machvon.project_task set actual_vnd = 1300000 where id = $1::uuid', [task]);
      expect(await as((tx) => kpis.record(tx, [task], new Date()))).toEqual({ tasks: 1, written: 1, unchanged: 5 });
      const rows = await owner<{ supersedes_id: string | null; value: string }>("select supersedes_id, value::text from machvon.task_kpi_result where task_id = $1::uuid and kpi_code = 'PWF_AMOUNT_VARIANCE_PCT' order by computed_at", [task]);
      expect(rows.map((row) => [row.supersedes_id, Number(row.value)])).toEqual([[null, 0], [before?.id, 30]]);
      const head = ((await as((tx) => kpis.heads(tx, [task]))).get(task) ?? []).find((row) => row.kpiCode === 'PWF_AMOUNT_VARIANCE_PCT');
      expect(head).toMatchObject({ value: 30, supersedesId: before?.id });
      expect(await sqlState(as((tx) => tx.query('update machvon.task_kpi_result set score = 0 where task_id = $1::uuid', [task])))).toBe('42501');
      expect(await sqlState(as((tx) => tx.query('delete from machvon.task_kpi_result where task_id = $1::uuid', [task])))).toBe('42501');
      // One row replaces another once: a second successor of the same row is refused by the unique index.
      expect(
        await sqlState(
          owner(
            `insert into machvon.task_kpi_result (tenant_id, task_id, workflow_id, kpi_code, operation, kpi_set_code, kpi_set_version, state, value, score, weight, as_of, inputs_hash, inputs, supersedes_id)
             select tenant_id, task_id, workflow_id, kpi_code, operation, kpi_set_code, kpi_set_version, state, value, score, weight, as_of, inputs_hash, inputs, id from machvon.task_kpi_result where id = $1::uuid`,
            [before?.id],
          ),
        ),
      ).toBe('23505');
    });

    it('reads again only the tasks that moved: a task is pending until its results were evaluated at its version', async () => {
      const wf = await workflow();
      const task = await seedTask(wf, 'K3', { baselineFinish: `${Y}-02-14`, actualFinish: `${Y}-02-14` });
      expect(await as((tx) => kpis.pendingTaskIds(tx, 1000))).toContain(task);
      await as((tx) => kpis.record(tx, [task], new Date()));
      expect(await as((tx) => kpis.pendingTaskIds(tx, 1000))).not.toContain(task);
      await owner('update machvon.project_task set version = version + 1 where id = $1::uuid', [task]);
      expect(await as((tx) => kpis.pendingTaskIds(tx, 1000))).toContain(task);
    });
  });

  describe('the draft of a period (BR-PWF-34 to 37)', () => {
    it('computes the score of a person from the tasks they held, in a draft that is computed again to the same hash, and refuses what overlaps, what does not fit the policy and what is out of the reach', async () => {
      const wf = await workflow();
      const task = await seedTask(wf, 'D1', { baselineFinish: `${Y}-02-14`, actualFinish: `${Y}-02-21`, estimate: 1_000_000, actual: 1_100_000 });
      await hold(task, WORKER);
      const first = await compute(Q.DRAFT);
      expect(first).toMatchObject({ created: true, ratedCount: 1, smallSampleCount: 0, notRatedCount: 2, signalCount: 0, period: { status: 'DRAFT', periodKind: 'QUARTER', policyCode: 'TESTPOL' } });
      expect(await lineOf(first.period.id, WORKER)).toMatchObject({ score_computed: '44.44', score_adjusted: '44.44', state: 'RATED' });
      const again = await compute(Q.DRAFT);
      expect(again).toMatchObject({ created: false, previewHash: first.previewHash });
      expect(again.period.version).toBe(first.period.version + 1);
      expect(await refusal(compute({ from: `${Y}-02-01`, to: `${Y}-02-28` }))).toMatchObject({ code: 'STAFF_SCORE_PERIOD_OVERLAP', status: 409 });
      expect(await refusal(compute({ from: `${Y - 2}-02-01`, to: `${Y - 2}-02-20` }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
      expect(await refusal(compute(Q.DRAFT, { units: unitId(ELSEWHERE) }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(compute(Q.RACE, { policyCode: 'NOPOL' }))).toMatchObject({ code: 'GOVERNANCE_RULE_NOT_FOUND' });
    });

    it('splits a task between the people who held it by the days of each interval and their shares, and a change of hands does not give the task to the new holder (BR-PWF-34)', async () => {
      const wf = await workflow();
      const task = await seedTask(wf, 'S1', { baselineStart: `${Y}-05-05`, baselineFinish: `${Y}-05-30`, actualStart: `${Y}-05-05`, actualFinish: `${Y}-05-30`, days: 20 });
      await hold(task, WORKER, { from: `${Y}-05-05`, to: `${Y}-05-16` });
      await hold(task, OTHER, { from: `${Y}-05-19` });
      await hold(task, CHECKER, { role: 'CONSULTED', from: `${Y}-05-05`, share: 50 });
      const preview = await compute(Q.SHARES);
      const parts = await owner<{ member: string; contributions: Array<{ fraction: number; weight: number; spans: unknown[] }> }>('select membership_id as member, contributions from machvon.staff_score_line where period_id = $1::uuid', [preview.period.id]);
      const fractionOf = (who: number): number | undefined => parts.find((row) => row.member === memberId(who))?.contributions[0]?.fraction;
      expect(fractionOf(WORKER)).toBe(0.5);
      expect(fractionOf(OTHER)).toBe(0.5);
      // A consulted person holds half the task over the whole window, with the factor 0.2.
      expect(fractionOf(CHECKER)).toBe(0.1);
      expect(parts.find((row) => row.member === memberId(WORKER))?.contributions[0]?.spans).toEqual([{ role: 'RESPONSIBLE', valid_from: `${Y}-05-05`, valid_to: `${Y}-05-16`, share_pct: 100 }]);
      // The ledger refuses a second holder of the same role in the same days.
      const clash = await sqlState(owner(`insert into machvon.project_task_assignment (tenant_id, task_id, membership_id, role, valid_from, share_pct, reason, assigned_by) values ($1, $2::uuid, $3::uuid, 'RESPONSIBLE', $4::date, 100, 'Held for the test', $5::uuid)`, [TENANT_A, task, memberId(OTHER), `${Y}-05-20`, memberId(MANAGER)]));
      expect(clash).toBe('23P01');
    });
  });

  describe('the lock of a period, its snapshot and who may read the scores (BR-PWF-39, 40, R33)', () => {
    let periodId = '';
    let version = 0;
    let workerLine = '';
    let otherLine = '';
    let wf: { id: string; projectId: string };
    let late = '';

    beforeAll(async () => {
      wf = await workflow();
      const onTime = await seedTask(wf, 'L1', { baselineFinish: `${Y}-08-15`, actualFinish: `${Y}-08-15` });
      late = await seedTask(wf, 'L2', { baselineFinish: `${Y}-08-15`, actualFinish: `${Y}-08-22` });
      const other = await seedTask(wf, 'L3', { baselineFinish: `${Y}-08-15`, actualFinish: `${Y}-08-15`, returns: 1 });
      await hold(onTime, WORKER);
      await hold(late, WORKER);
      await hold(other, OTHER);
      const draft = await compute(Q.LOCK);
      periodId = draft.period.id;
      version = draft.period.version;
    });

    it('locks the period: the snapshot and its hash are written, the lines are the figures of the snapshot, and a period that is not a draft is not locked again', async () => {
      expect(await refusal(lockIt(periodId, version + 5))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      const locked = await lockIt(periodId, version);
      expect(locked).toMatchObject({ fromStatus: 'DRAFT', status: 'LOCKED', version: version + 1 });
      const [row] = await owner<{ status: string; snapshot_hash: string; locked_by: string; response_until: string; summary: { people: number; rated: number } }>(
        'select status, snapshot_hash, locked_by, response_until::text, summary from machvon.staff_score_period where id = $1::uuid',
        [periodId],
      );
      expect(row).toMatchObject({ status: 'LOCKED', locked_by: memberId(MANAGER), summary: { people: 3, rated: 2 } });
      expect(row?.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.response_until).toBe(new Date(Date.parse(`${TODAY}T00:00:00Z`) + 10 * 86_400_000).toISOString().slice(0, 10));
      version += 1;
      workerLine = (await lineOf(periodId, WORKER)).id;
      otherLine = (await lineOf(periodId, OTHER)).id;
      expect(await lineOf(periodId, WORKER)).toMatchObject({ score_computed: '71.88', state: 'RATED' });
      expect(await lineOf(periodId, OTHER)).toMatchObject({ score_computed: '97.50' });
      expect(await refusal(lockIt(periodId, version))).toMatchObject({ code: 'STAFF_SCORE_PERIOD_LOCKED', status: 409 });
      expect(await refusal(compute(Q.LOCK))).toMatchObject({ code: 'STAFF_SCORE_PERIOD_LOCKED', status: 409 });
    });

    it('UAT-PWF-LCK-01: computes the lines of the locked period again from its snapshot to the same hash, and a later change of the ledger, the baseline or a result does not move the period', async () => {
      expect(await as((tx) => scores.verify(tx, periodId))).toEqual({ reproducible: true, hashMatches: true, figuresMatch: true });
      const before = await owner('select score_computed, contributions from machvon.staff_score_line where period_id = $1::uuid order by id', [periodId]);
      await hold(late, CHECKER, { from: `${Y}-08-18`, role: 'ACCOUNTABLE' });
      await owner('update machvon.project_task set actual_vnd = 5, estimate_vnd = 1 where id = $1::uuid', [late]);
      await as((tx) => kpis.record(tx, [late], new Date()));
      await owner('insert into machvon.project_workflow_baseline (tenant_id, workflow_id, version, reason, planned_start, planned_finish, schedule_version, taken_by, approved_by) values ($1, $2::uuid, 2, $3, $4::date, $5::date, 1, $6::uuid, $7::uuid)', [TENANT_A, wf.id, 'A later baseline for the test', `${Y}-01-06`, `${Y}-12-31`, memberId(MANAGER), memberId(CHECKER)]);
      expect(await owner('select score_computed, contributions from machvon.staff_score_line where period_id = $1::uuid order by id', [periodId])).toEqual(before);
      expect(await as((tx) => scores.verify(tx, periodId))).toEqual({ reproducible: true, hashMatches: true, figuresMatch: true });
      // The tampered snapshot is no longer the one the hash was taken of.
      const tampered = await owner<{ snapshot: Record<string, unknown> }>('select snapshot from machvon.staff_score_period where id = $1::uuid', [periodId]);
      const copy = JSON.parse(JSON.stringify(tampered[0]?.snapshot)) as { lines: Array<{ score_computed: number }> };
      copy.lines[0]!.score_computed += 1;
      const policy = pwfKpi.parseStaffScoringPolicy({ ...pwfKpi.DEFAULT_STAFF_SCORING_PARAMS, min_rated_tasks: 1, min_effective_weight: 0.5 });
      const [{ snapshot_hash: hash }] = (await owner<{ snapshot_hash: string }>('select snapshot_hash from machvon.staff_score_period where id = $1::uuid', [periodId])) as [{ snapshot_hash: string }];
      expect(verifySnapshot(copy as never, hash, policy, undefined)).toMatchObject({ reproducible: false });
    });

    it('UAT-PWF-SEC-02, UAT-PWF-SEC-03, UAT-PWF-SEC-04: shows a line to the person it is about, to the units that may read it and to the whole tenant: any other, in the same tenant or not, sees nothing and the database itself answers nothing without a reach (R33)', async () => {
      const count = (units: string, subject: string, tenant = TENANT_A): Promise<number> =>
        as((tx) => withScoreScope(tx, { units, subject }, async () => Number((await tx.query<{ n: string }>('select count(*)::text as n from machvon.staff_score_line where period_id = $1::uuid', [periodId]))[0]?.n)), MANAGER, tenant);
      expect(await count('', '')).toBe(0);
      expect(await count('', memberId(WORKER))).toBe(1);
      expect(await count(unitId(SIBLING), memberId(OUTSIDER))).toBe(0);
      expect(await count(DEPT, '')).toBe(3);
      expect(await count(`${unitId(SIBLING)},${DEPT}`, '')).toBe(3);
      expect(await count('*', '')).toBe(3);
      expect(await count('*', '', TENANT_B)).toBe(0);
      expect(await sqlState(as((tx) => tx.query("insert into machvon.staff_score_signal (tenant_id, period_id, membership_id, unit_id_at_period, code) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, 'CANCELLED_SHARE_HIGH')", [periodId, memberId(WORKER), DEPT])))).toBe('42501');
      // The way the application reads: the person, a former manager (no reach left), a manager of a sibling unit, a manager of the unit, the human resources.
      const readLine = (v: Viewer, id = workerLine, projects: ScopeBuilder = everything) => as((tx) => reads.line(tx, v, id, projects));
      expect(await readLine(viewer(WORKER))).toMatchObject({ scoreComputed: 71.88, isSubject: true, canRespond: true, canRequestAdjustment: false, periodStatus: 'LOCKED' });
      expect(await refusal(readLine(viewer(OTHER)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(readLine(viewer(MANAGER, { readUnits: '' })))).toMatchObject({ status: 404 });
      expect(await refusal(readLine(viewer(MANAGER, { readUnits: unitId(SIBLING) })))).toMatchObject({ status: 404 });
      expect(await readLine(viewer(MANAGER, { readUnits: DEPT, adjustUnits: DEPT }))).toMatchObject({ isSubject: false, canRequestAdjustment: true, canRespond: false });
      expect(await readLine(viewer(HR, { readUnits: '*' }), otherLine)).toMatchObject({ scoreComputed: 97.5 });
      // The source authorisation: a reader who may not read the project of a task sees the points and not the task; the person sees their own tasks whatever the project scope says.
      const restricted = await readLine(viewer(MANAGER, { readUnits: DEPT }), workerLine, nothing);
      expect(restricted.contributions.every((one) => one.taskId === null && one.name === '')).toBe(true);
      expect((await readLine(viewer(MANAGER, { readUnits: DEPT }), workerLine, everything)).contributions.every((one) => one.taskId !== null && one.name.startsWith('Task'))).toBe(true);
      expect((await readLine(viewer(WORKER), workerLine, nothing)).contributions.every((one) => one.taskId !== null)).toBe(true);
      // The lists: the unit, the person, and the former manager who has no reach left.
      expect((await as((tx) => reads.lines(tx, { units: DEPT, subject: '' }, periodId, {}, { limit: 10 }))).total).toBe(3);
      expect(await refusal(as((tx) => reads.lines(tx, NO_SCORE_SCOPE, periodId, {}, { limit: 10 })))).toMatchObject({ status: 404 });
      expect(await refusal(as((tx) => reads.lines(tx, { units: unitId(SIBLING), subject: '' }, periodId, {}, { limit: 10 })))).toMatchObject({ status: 404 });
      const mine = await as((tx) => reads.mine(tx, memberId(WORKER), { limit: 10 }));
      expect(mine.items.map((one) => [one.period.id, one.line.id])).toEqual([[periodId, workerLine]]);
      expect((await as((tx) => reads.mine(tx, memberId(OUTSIDER), { limit: 10 }))).items).toEqual([]);
      // The comparison of periods is the person's own, or the reader's.
      const comparison = await as((tx) => reads.compare(tx, viewer(WORKER), memberId(WORKER), {}));
      expect(comparison.points.map((one) => one.periodId)).toContain(periodId);
      expect(await refusal(as((tx) => reads.compare(tx, viewer(OTHER), memberId(WORKER), {})))).toMatchObject({ status: 404 });
    });

    it('UAT-PWF-STA-03: keeps the computed score of a locked line and the snapshot out of the reach of the application: only the adjusted score moves, by an approved adjustment', async () => {
      expect(await sqlState(as((tx) => withScoreScope(tx, { units: '*', subject: '' }, () => tx.query('update machvon.staff_score_line set score_computed = 100 where id = $1::uuid', [workerLine]))))).toBe('42501');
      expect(await sqlState(as((tx) => withScoreScope(tx, { units: '*', subject: '' }, () => tx.query('delete from machvon.staff_score_line where id = $1::uuid', [workerLine]))))).toBe('42501');
      expect(await sqlState(as((tx) => tx.query("update machvon.staff_score_period set snapshot_hash = repeat('a', 64) where id = $1::uuid", [periodId])))).toBe('42501');
      expect(await sqlState(as((tx) => tx.query("update machvon.staff_score_period set status = 'DRAFT' where id = $1::uuid", [periodId])))).toBe('42501');
      expect(await sqlState(as((tx) => tx.query('delete from machvon.staff_score_period where id = $1::uuid', [periodId])))).toBe('42501');
    });

    describe('adjustments (BR-PWF-38)', () => {
      const request = (points: number, over: { reason?: string; actor?: number; units?: string; line?: string } = {}) =>
        as((tx) => adjustments.request(tx, { lineId: over.line ?? workerLine, points, reason: over.reason ?? 'The task was late because the other agency answered late.', actor: memberId(over.actor ?? MANAGER), units: over.units ?? DEPT }), over.actor ?? MANAGER);
      const decide = (id: string, expected: number, decision: 'APPROVE' | 'REJECT', actor: number, units = DEPT) =>
        as((tx) => adjustments.decide(tx, { adjustmentId: id, expectedVersion: expected, decision, note: 'Decided after reading the evidence', actor: memberId(actor), units }), actor);

      it('UAT-PWF-BND-10, UAT-PWF-SEC-08: asks inside the bounds with a reason, and refuses the person scored, too many points, a short reason, a unit out of reach and a line with no score', async () => {
        expect(await refusal(request(5, { actor: WORKER }))).toMatchObject({ code: 'STAFF_SCORE_ADJUSTMENT_INVALID', status: 422, detail: 'requestedBy' });
        expect(await refusal(request(11))).toMatchObject({ code: 'STAFF_SCORE_ADJUSTMENT_INVALID', detail: 'points' });
        expect(await refusal(request(0))).toMatchObject({ code: 'STAFF_SCORE_ADJUSTMENT_INVALID', detail: 'points' });
        expect(await refusal(request(5, { reason: 'too short' }))).toMatchObject({ code: 'STAFF_SCORE_ADJUSTMENT_INVALID', detail: 'reason' });
        expect(await refusal(request(5, { units: unitId(SIBLING) }))).toMatchObject({ status: 404 });
        const asked = await request(5);
        expect(asked).toMatchObject({ status: 'REQUESTED', version: 1 });
        const [row] = await owner<{ requested_by: string; subject_membership_id: string; status: string }>('select requested_by, subject_membership_id, status from machvon.staff_score_adjustment where id = $1::uuid', [asked.id]);
        expect(row).toEqual({ requested_by: memberId(MANAGER), subject_membership_id: memberId(WORKER), status: 'REQUESTED' });
      });

      it('is decided by a second person who is neither the one who asked nor the person scored, in the version the screen read, once', async () => {
        const [open] = await owner<{ id: string }>("select id from machvon.staff_score_adjustment where line_id = $1::uuid and status = 'REQUESTED'", [workerLine]);
        const id = open?.id as string;
        expect(await refusal(decide(id, 1, 'APPROVE', MANAGER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
        expect(await refusal(decide(id, 1, 'APPROVE', WORKER))).toMatchObject({ code: 'STAFF_SCORE_ADJUSTMENT_INVALID', detail: 'approvedBy' });
        expect(await refusal(decide(id, 9, 'APPROVE', CHECKER))).toMatchObject({ code: 'VERSION_CONFLICT' });
        expect(await refusal(decide(id, 1, 'APPROVE', CHECKER, unitId(SIBLING)))).toMatchObject({ status: 404 });
        const done = await decide(id, 1, 'APPROVE', CHECKER);
        expect(done).toMatchObject({ status: 'APPROVED', fromStatus: 'REQUESTED', version: 2 });
        // Both scores are kept: the computed score is the same, the adjusted score moved by the points.
        expect(await lineOf(periodId, WORKER)).toMatchObject({ score_computed: '71.88', score_adjusted: '76.88' });
        expect(await refusal(decide(id, 2, 'APPROVE', CHECKER))).toMatchObject({ code: 'STAFF_SCORE_ADJUSTMENT_INVALID', detail: 'status' });
        const detail = await as((tx) => reads.line(tx, viewer(WORKER), workerLine, everything));
        expect(detail).toMatchObject({ scoreComputed: 71.88, scoreAdjusted: 76.88 });
        expect(detail.adjustments.map((one) => [one.points, one.status])).toEqual([[5, 'APPROVED']]);
      });

      it('never lets the approved adjustments add up past the bounds of the policy of the period', async () => {
        expect(await refusal(request(6))).toMatchObject({ code: 'STAFF_SCORE_ADJUSTMENT_INVALID', detail: 'points' });
        const second = await request(5);
        const third = await request(-3, { reason: 'A correction of the earlier adjustment, after review.' });
        const approved = await decide(second.id, 1, 'APPROVE', CHECKER);
        expect(approved.status).toBe('APPROVED');
        expect(await lineOf(periodId, WORKER)).toMatchObject({ score_adjusted: '81.88' });
        expect(await refusal(decide(third.id, 1, 'REJECT', MANAGER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
        expect((await decide(third.id, 1, 'REJECT', CHECKER)).status).toBe('REJECTED');
        expect(await lineOf(periodId, WORKER)).toMatchObject({ score_adjusted: '81.88' });
        // 10 points are used: nothing more fits.
        expect(await refusal(request(1))).toMatchObject({ detail: 'points' });
        expect(await sqlState(as((tx) => withScoreScope(tx, { units: '*', subject: '' }, () => tx.query("update machvon.staff_score_adjustment set points = 1 where id = $1::uuid", [second.id]))))).toBe('42501');
      });

      it('UAT-PWF-CON-03: takes the lock of the period: an adjustment that races the lock of a draft finds the period either still a draft (409) or locked and keeps a consistent period either way', async () => {
        const raceWf = await workflow();
        const task = await seedTask(raceWf, 'R1', { baselineFinish: `${Y - 1}-02-16`, actualFinish: `${Y - 1}-02-23` });
        await hold(task, WORKER);
        const draft = await compute(Q.RACE);
        const draftLine = (await lineOf(draft.period.id, WORKER)).id;
        const outcomes = await Promise.allSettled([lockIt(draft.period.id, draft.period.version), request(5, { line: draftLine })]);
        const lockOutcome = outcomes[0];
        expect(lockOutcome.status).toBe('fulfilled');
        const second = outcomes[1];
        if (second.status === 'rejected') expect(['STAFF_SCORE_PERIOD_LOCKED', 'RESOURCE_NOT_FOUND']).toContain((second.reason as { code: string }).code);
        const adjustmentRows = await owner<{ id: string }>('select a.id from machvon.staff_score_adjustment a join machvon.staff_score_line l on l.id = a.line_id where l.period_id = $1::uuid', [draft.period.id]);
        expect(adjustmentRows.length).toBe(second.status === 'fulfilled' ? 1 : 0);
        expect(await as((tx) => scores.verify(tx, draft.period.id))).toMatchObject({ reproducible: true });
        expect((await owner<{ status: string }>('select status from machvon.staff_score_period where id = $1::uuid', [draft.period.id]))[0]?.status).toBe('LOCKED');
      });

      it('refuses an adjustment on a draft period', async () => {
        const wf2 = await workflow();
        const t = await seedTask(wf2, 'R2', { baselineFinish: `${Y - 2}-02-15`, actualFinish: `${Y - 2}-02-15` });
        await hold(t, WORKER);
        const draft = await compute({ from: `${Y - 2}-01-01`, to: `${Y - 2}-03-31` });
        const line = (await lineOf(draft.period.id, WORKER)).id;
        expect(await refusal(request(3, { line }))).toMatchObject({ code: 'STAFF_SCORE_PERIOD_LOCKED', status: 409 });
      });
    });

    describe('responses and the end of the window (BR-PWF-39, R43)', () => {
      const respond = (line: string, actor: number, body = 'The delay came from the agency; here is the letter I sent them.') => as((tx) => adjustments.submit(tx, { lineId: line, body, actor: memberId(actor), today: TODAY }), actor);
      const handle = (id: string, expected: number, actor: number, over: Record<string, unknown> = {}) =>
        as((tx) => adjustments.handle(tx, { responseId: id, expectedVersion: expected, outcome: 'KEEP', conclusion: 'The score stands: the letter is dated after the due day.', actor: memberId(actor), units: DEPT, ...over }), actor);
      const officialize = (version: number, actor = HR) => as((tx) => scores.officialize(tx, { periodId, expectedVersion: version, actor: memberId(actor), units: '*', now: new Date() }), actor);
      const periodVersion = async (): Promise<number> => Number((await owner<{ version: number }>('select version from machvon.staff_score_period where id = $1::uuid', [periodId]))[0]?.version);
      let responseId = '';

      it('does not make a period official while its window is open and nobody answered', async () => {
        expect(await refusal(officialize(await periodVersion()))).toMatchObject({ code: 'STAFF_SCORE_PERIOD_LOCKED', status: 409, extensions: { reason: 'WINDOW_OPEN' } });
      });

      it('lets only the person scored answer, inside the window, in words, a few times, and never hands the answer to the person themselves', async () => {
        expect(await refusal(respond(workerLine, OTHER))).toMatchObject({ status: 404 });
        expect(await refusal(respond(workerLine, WORKER, 'too short'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
        const answered = await respond(workerLine, WORKER);
        responseId = answered.id;
        expect(answered).toMatchObject({ status: 'OPEN', subject: memberId(WORKER) });
        await owner("update machvon.staff_score_period set response_until = date '2000-01-01' where id = $1::uuid", [periodId]);
        expect(await refusal(respond(workerLine, WORKER))).toMatchObject({ code: 'STAFF_SCORE_RESPONSE_WINDOW_CLOSED', status: 409 });
        await owner("update machvon.staff_score_period set response_until = $2::date where id = $1::uuid", [periodId, new Date(Date.now() + 86_400_000 * 5).toISOString().slice(0, 10)]);
        const detail = await as((tx) => reads.line(tx, viewer(WORKER), workerLine, everything));
        expect(detail.responses.map((one) => [one.status, one.body.startsWith('The delay')])).toEqual([['OPEN', true]]);
        expect(detail.canRespond).toBe(true);
        expect(await refusal(handle(responseId, detail.version, WORKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      });

      it('does not make the period official while a response is open, and handles it by someone else: keep the score, or ask for an adjustment that a third person decides', async () => {
        expect(await refusal(officialize(await periodVersion()))).toMatchObject({ code: 'STAFF_SCORE_PERIOD_LOCKED', extensions: { reason: 'RESPONSES_OPEN' } });
        const line = await as((tx) => reads.line(tx, viewer(WORKER), workerLine, everything));
        expect(await refusal(handle(responseId, line.version + 4, CHECKER))).toMatchObject({ code: 'VERSION_CONFLICT' });
        expect(await refusal(handle(responseId, line.version, CHECKER, { units: unitId(SIBLING) }))).toMatchObject({ status: 404 });
        expect(await refusal(handle(responseId, line.version, CHECKER, { outcome: 'ADJUST' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'adjustment_points' });
        const handled = await handle(responseId, line.version, CHECKER);
        expect(handled).toMatchObject({ status: 'HANDLED', adjustmentId: null });
        expect((await as((tx) => reads.line(tx, viewer(WORKER), workerLine, everything))).responses[0]).toMatchObject({ status: 'HANDLED', handledBy: memberId(CHECKER), conclusion: expect.stringContaining('score stands') });
        const next = await respond(otherLine, OTHER, 'I was not given the evidence of the return of my task.');
        const after = await as((tx) => reads.line(tx, viewer(OTHER), otherLine, everything));
        const adjusted = await handle(next.id, after.version, CHECKER, { outcome: 'ADJUST', conclusion: 'The return was a fault of the reviewer: adjust.', adjustment: { points: 2, reason: 'The return of the task was the reviewer and not the person.' } });
        expect(adjusted.adjustmentId).not.toBeNull();
        const [row] = await owner<{ requested_by: string; status: string; response_id: string }>('select requested_by, status, response_id from machvon.staff_score_adjustment where id = $1::uuid', [adjusted.adjustmentId]);
        expect(row).toEqual({ requested_by: memberId(CHECKER), status: 'REQUESTED', response_id: next.id });
      });

      it('makes the period official once every response is handled, and then nobody answers any more', async () => {
        const version = await periodVersion();
        const done = await officialize(version);
        expect(done).toMatchObject({ fromStatus: 'LOCKED', status: 'OFFICIAL', facts: { reason: 'ALL_HANDLED' } });
        expect(await refusal(officialize(version + 1))).toMatchObject({ code: 'STAFF_SCORE_PERIOD_LOCKED' });
        expect(await refusal(respond(workerLine, WORKER))).toMatchObject({ code: 'STAFF_SCORE_RESPONSE_WINDOW_CLOSED' });
        expect((await as((tx) => reads.line(tx, viewer(WORKER), workerLine, everything))).canRespond).toBe(false);
        // An official period still takes an adjustment that was asked for (the second approver is neither maker nor subject).
        const [open] = await owner<{ id: string }>("select id from machvon.staff_score_adjustment where line_id = $1::uuid and status = 'REQUESTED'", [otherLine]);
        expect((await as((tx) => adjustments.decide(tx, { adjustmentId: open?.id as string, expectedVersion: 1, decision: 'APPROVE', actor: memberId(MANAGER), units: DEPT }), MANAGER)).status).toBe('APPROVED');
        expect(await lineOf(periodId, OTHER)).toMatchObject({ score_computed: '97.50', score_adjusted: '99.50' });
      });

      it('applies the end of a workflow of the approval engine: upheld, returned or kept, with the reason; never for the person scored and never twice', async () => {
        const wf2 = await workflow();
        const t = await seedTask(wf2, 'W1', { baselineFinish: `${Y - 2}-02-15`, actualFinish: `${Y - 2}-02-15` });
        await hold(t, WORKER);
        const quarter = { from: `${Y - 2}-01-01`, to: `${Y - 2}-03-31` };
        const draft = await compute(quarter);
        await lockIt(draft.period.id, draft.period.version);
        const line = (await lineOf(draft.period.id, WORKER)).id;
        const sent = await respond(line, WORKER, 'Please look at my task again: it was done on the due day.');
        const apply = (outcome: 'UPHELD' | 'RETURNED' | 'KEPT', actor: number) => as((tx) => adjustments.applyWorkflowDecision(tx, { responseId: sent.id, outcome, conclusion: 'Decided by the reviewers of the unit.', actor: memberId(actor) }), actor);
        expect(await apply('UPHELD', WORKER)).toBeUndefined();
        expect(await apply('UPHELD', CHECKER)).toMatchObject({ status: 'HANDLED' });
        expect(await apply('KEPT', CHECKER)).toBeUndefined();
        expect((await owner<{ outcome: string; handled_by: string }>('select outcome, handled_by from machvon.staff_score_response where id = $1::uuid', [sent.id]))[0]).toEqual({ outcome: 'UPHELD', handled_by: memberId(CHECKER) });
        expect(await as((tx) => adjustments.applyWorkflowDecision(tx, { responseId: randomUUID(), outcome: 'KEPT', conclusion: 'x', actor: memberId(CHECKER) }))).toBeUndefined();
      });
    });

    describe('the end of the retention (BR-PWF-42)', () => {
      it('UAT-PWF-RET-01: anonymises an official period: the person, the words and the tasks are gone, the hash and the figures without a name stay, and no read finds the line any more', async () => {
        // Before its retention has ended nobody can erase it, whoever calls: the function judges the deadline itself.
        expect(await as((tx) => scores.expire(tx, periodId))).toBe(false);
        expect((await owner<{ erased_at: string | null }>('select erased_at::text from machvon.staff_score_period where id = $1::uuid', [periodId]))[0]?.erased_at).toBeNull();
        await owner("update machvon.staff_score_period set snapshot = jsonb_set(snapshot, '{policy,params,retention_months}', '12'::jsonb) where id = $1::uuid", [periodId]);
        const held = await owner('select 1 from machvon.staff_score_response r join machvon.staff_score_line l on l.tenant_id = r.tenant_id and l.id = r.line_id where l.period_id = $1::uuid', [periodId]);
        expect(held.length).toBeGreaterThan(0);
        expect(await as((tx) => scores.expire(tx, periodId))).toBe(true);
        // Nothing that could put a person back together with a score is left: no line, no response, no adjustment, no signal of the period, and the approval instance that was started for a response points at nothing.
        const left = (table: string, column = 'period_id'): Promise<unknown[]> => owner(`select 1 from machvon.${table} where ${column} = $1::uuid`, [periodId]);
        expect(await left('staff_score_line')).toHaveLength(0);
        expect(await left('staff_score_signal')).toHaveLength(0);
        expect((await owner('select 1 from machvon.staff_score_response r where r.line_id = $1::uuid or r.line_id = $2::uuid', [workerLine, otherLine])).length).toBe(0);
        expect((await owner('select 1 from machvon.staff_score_adjustment a where a.line_id = $1::uuid or a.line_id = $2::uuid', [workerLine, otherLine])).length).toBe(0);
        const [period] = await owner<{ snapshot: unknown; snapshot_hash: string; erased_at: string | null; summary: { people: number } }>('select snapshot, snapshot_hash, erased_at::text, summary from machvon.staff_score_period where id = $1::uuid', [periodId]);
        expect(period).toMatchObject({ snapshot: { erased: true }, summary: { people: 3 } });
        expect(period?.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(period)).not.toContain(memberId(WORKER));
        expect(await refusal(as((tx) => reads.line(tx, viewer(WORKER, { readUnits: '*' }), workerLine, everything)))).toMatchObject({ status: 404 });
        expect(await refusal(as((tx) => scores.verify(tx, periodId)))).toMatchObject({ status: 404 });
        expect(await as((tx) => scores.expire(tx, periodId))).toBe(false);
        expect(await as((tx) => scores.expiredPeriodIds(tx, new Date()))).not.toContain(periodId);
      });

      it('finds the periods whose policy kept the data long enough and leaves the others', async () => {
        const wf2 = await workflow();
        const t = await seedTask(wf2, 'E1', { baselineFinish: `${Y - 2}-11-14`, actualFinish: `${Y - 2}-11-14` });
        await hold(t, WORKER);
        const quarter = { from: `${Y - 2}-10-01`, to: `${Y - 2}-12-31` };
        const draft = await compute(quarter);
        const locked = await lockIt(draft.period.id, draft.period.version);
        await owner("update machvon.staff_score_period set status = 'OFFICIAL', official_at = now(), official_by = $2::uuid where id = $1::uuid", [draft.period.id, memberId(HR)]);
        expect(locked.status).toBe('LOCKED');
        expect(await as((tx) => scores.expiredPeriodIds(tx, new Date(`${Y + 4}-06-01T00:00:00Z`)))).toContain(draft.period.id);
        expect(await as((tx) => scores.expiredPeriodIds(tx, new Date(`${Y}-06-01T00:00:00Z`)))).not.toContain(draft.period.id);
      });
    });
  });

  describe('the edges of a period (BR-PWF-36, 38, 39, UAT-PWF-14, BND-13, NEG-09, NEG-10)', () => {
    it('UAT-PWF-14, UAT-PWF-BND-13: has a score and the raw numbers for a small sample and no rating, and a person with nothing to score is NOT_RATED, never NaN', async () => {
      const wf = await workflow();
      const small = await seedTask(wf, 'M1', { baselineFinish: `${Y - 2}-05-15`, actualFinish: `${Y - 2}-05-15` });
      await hold(small, WORKER);
      const cancelled = await seedTask(wf, 'M2', { status: 'CANCELLED', baselineFinish: `${Y - 2}-05-20`, actualFinish: null, cancelledBy: CHECKER, cancelledAt: `${Y - 2}-05-20T03:00:00Z` });
      await hold(cancelled, OTHER);
      const preview = await compute({ from: `${Y - 2}-04-01`, to: `${Y - 2}-06-30` }, { policyCode: 'DEFAULT' });
      expect(preview).toMatchObject({ ratedCount: 0, smallSampleCount: 1, notRatedCount: 2 });
      expect(await lineOf(preview.period.id, WORKER)).toMatchObject({ state: 'SMALL_SAMPLE', score_computed: '100.00', score_adjusted: '100.00' });
      expect(await lineOf(preview.period.id, OTHER)).toMatchObject({ state: 'NOT_RATED', score_computed: null, score_adjusted: null });
      const [worker] = await owner<{ rating: string | null; rated_task_count: number }>('select rating, rated_task_count from machvon.staff_score_line where period_id = $1::uuid and membership_id = $2::uuid', [preview.period.id, memberId(WORKER)]);
      expect(worker).toEqual({ rating: null, rated_task_count: 1 });
      const compared = await as((tx) => reads.compare(tx, viewer(MANAGER, { readUnits: '*' }), memberId(WORKER), {}));
      expect(compared.points.every((one) => one.state === 'SMALL_SAMPLE' || one.state === 'RATED')).toBe(true);
    });

    it('refuses to compute or lock a period of a unit whose subtree the caller does not manage whole (403 SCOPE_DENIED)', async () => {
      const quarter = { from: `${Y - 5}-04-01`, to: `${Y - 5}-06-30` };
      expect(await refusal(compute(quarter, { scopeUnitId: unitId(PROVINCE), units: unitId(PROVINCE) }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      const draft = await compute(quarter, { scopeUnitId: unitId(PROVINCE) });
      expect(await refusal(lockIt(draft.period.id, draft.period.version, { units: unitId(PROVINCE) }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect((await lockIt(draft.period.id, draft.period.version, { units: `${unitId(PROVINCE)},${DEPT},${unitId(SIBLING)}` })).status).toBe('LOCKED');
    });

    it('makes the results of a closed task stale when an outside delay is approved after they were recorded, so the penalty is not kept', async () => {
      const wf = await workflow();
      const task = await seedTask(wf, 'X1', { baselineFinish: `${Y - 1}-08-12`, baselineStart: `${Y - 1}-08-01`, actualStart: `${Y - 1}-08-01`, actualFinish: `${Y - 1}-08-19`, estimate: 1, actual: 1 });
      await as((tx) => kpis.record(tx, [task], new Date()));
      expect(await as((tx) => kpis.pendingTaskIds(tx, 1000))).not.toContain(task);
      const before = ((await as((tx) => kpis.heads(tx, [task]))).get(task) ?? []).find((row) => row.kpiCode === 'PWF_TASK_DEVIATION_DAYS');
      expect(before?.value).toBe(5);
      await owner("insert into machvon.project_task_exception (tenant_id, task_id, kind, valid_from, valid_to, reason, status, requested_by, decided_by, decided_at) values ($1, $2::uuid, 'EXTERNAL_DELAY', $3::date, $4::date, 'The agency answered late and the letter proves it.', 'APPROVED', $5::uuid, $6::uuid, now())", [TENANT_A, task, `${Y - 1}-08-13`, `${Y - 1}-08-16`, memberId(WORKER), memberId(CHECKER)]);
      expect(await as((tx) => kpis.pendingTaskIds(tx, 1000))).toContain(task);
      await as((tx) => kpis.record(tx, [task], new Date()));
      const after = ((await as((tx) => kpis.heads(tx, [task]))).get(task) ?? []).find((row) => row.kpiCode === 'PWF_TASK_DEVIATION_DAYS');
      expect(after?.value).toBeLessThan(5);
      expect(after?.supersedesId).toBe(before?.id);
    });

    it('scores a task that was handed in for approval inside the period although its baseline falls after it', async () => {
      const wf = await workflow();
      const task = await seedTask(wf, 'AW1', { status: 'AWAITING_APPROVAL', baselineFinish: `${Y - 1}-09-30`, baselineStart: `${Y - 1}-04-02`, actualStart: `${Y - 1}-04-02`, actualFinish: null });
      await owner("update machvon.project_task set completion_requested_at = $2::timestamptz, completion_requested_by = $3::uuid where id = $1::uuid", [task, `${Y - 1}-05-06T03:00:00Z`, memberId(WORKER)]);
      await hold(task, WORKER);
      const preview = await compute({ from: `${Y - 1}-04-01`, to: `${Y - 1}-06-30` });
      expect(preview.ratedCount + preview.smallSampleCount).toBe(1);
    });

    it('UAT-PWF-NEG-09: refuses shares that add up to more than the whole of a task (422 STAFF_SCORE_SHARE_INVALID) instead of scoring them', async () => {
      const wf = await workflow();
      const task = await seedTask(wf, 'H1', { baselineFinish: `${Y - 2}-08-15`, actualFinish: `${Y - 2}-08-15` });
      await hold(task, WORKER, { share: 70 });
      await hold(task, OTHER, { share: 70 });
      expect(await refusal(compute({ from: `${Y - 2}-07-01`, to: `${Y - 2}-09-30` }))).toMatchObject({ code: 'STAFF_SCORE_SHARE_INVALID', status: 422 });
      // Once the second holder's interval ends before the task began, the shares fit and the period is scored.
      await owner("update machvon.project_task_assignment set valid_to = date '2020-01-02' where task_id = $1::uuid and membership_id = $2::uuid", [task, memberId(OTHER)]);
      expect(await compute({ from: `${Y - 2}-07-01`, to: `${Y - 2}-09-30` })).toMatchObject({ created: true, period: { status: 'DRAFT' } });
    });

    it('UAT-PWF-NEG-10: says CALENDAR_UNAVAILABLE for a task counted in a year with no published calendar and never makes up the days', async () => {
      const wf = await workflow();
      const task = await seedTask(wf, 'C1', { baselineFinish: '2022-08-12', baselineStart: '2022-08-01', actualStart: '2022-08-01', actualFinish: '2022-08-19' });
      await as((tx) => kpis.record(tx, [task], new Date()));
      const heads = (await as((tx) => kpis.heads(tx, [task]))).get(task) ?? [];
      const deviation = heads.find((row) => row.kpiCode === 'PWF_TASK_DEVIATION_DAYS');
      expect(deviation).toMatchObject({ state: 'MISSING_FACT', value: null, score: null });
      expect((deviation?.inputs.calendars as Array<{ year: number }>).map((one) => one.year)).not.toContain(2022);
      expect(heads.find((row) => row.kpiCode === 'PWF_RETURN_COUNT')).toMatchObject({ state: 'OK', score: 100 });
    });

    it('UAT-PWF-BND-15: takes a response on the last day of the window and not on the day after, and refuses 19 characters where 20 are taken', async () => {
      const wf = await workflow();
      const task = await seedTask(wf, 'B1', { baselineFinish: `${Y - 3}-02-14`, actualFinish: `${Y - 3}-02-14` });
      await hold(task, WORKER);
      await harness.owner(TENANT_A, [[`insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at) values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`, [TENANT_A, Y - 3, memberId(MANAGER)]]]);
      const preview = await compute({ from: `${Y - 3}-01-01`, to: `${Y - 3}-03-31` });
      await lockIt(preview.period.id, preview.period.version);
      const line = (await lineOf(preview.period.id, WORKER)).id;
      const send = (body: string, today: string) => as((tx) => adjustments.submit(tx, { lineId: line, body, actor: memberId(WORKER), today }), WORKER);
      const until = (await owner<{ d: string }>('select response_until::text as d from machvon.staff_score_period where id = $1::uuid', [preview.period.id]))[0]?.d as string;
      const dayAfter = new Date(Date.parse(`${until}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      expect(await refusal(send('x'.repeat(19), until))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
      expect(await refusal(send('x'.repeat(20), dayAfter))).toMatchObject({ code: 'STAFF_SCORE_RESPONSE_WINDOW_CLOSED', status: 409 });
      expect((await send('x'.repeat(20), until)).status).toBe('OPEN');
    });

    it('UAT-PWF-STA-03: never goes back: an official period is not a locked one again, and a locked one is not a draft', async () => {
      const wf = await workflow();
      const task = await seedTask(wf, 'O1', { baselineFinish: `${Y - 3}-08-15`, actualFinish: `${Y - 3}-08-15` });
      await hold(task, WORKER);
      const preview = await compute({ from: `${Y - 3}-07-01`, to: `${Y - 3}-09-30` });
      await lockIt(preview.period.id, preview.period.version);
      await owner("update machvon.staff_score_period set status = 'OFFICIAL', official_at = now(), official_by = $2::uuid where id = $1::uuid", [preview.period.id, memberId(HR)]);
      expect(await sqlState(as((tx) => tx.query("update machvon.staff_score_period set status = 'LOCKED', official_at = null, official_by = null where id = $1::uuid", [preview.period.id])))).toBe('42501');
      expect(await sqlState(as((tx) => tx.query("update machvon.staff_score_period set status = 'DRAFT' where id = $1::uuid", [preview.period.id])))).toBe('42501');
      const current = Number((await owner<{ version: number }>('select version from machvon.staff_score_period where id = $1::uuid', [preview.period.id]))[0]?.version);
      expect(await refusal(as((tx) => scores.lock(tx, { periodId: preview.period.id, expectedVersion: current, actor: memberId(MANAGER), units: '*', now: new Date() })))).toMatchObject({ code: 'STAFF_SCORE_PERIOD_LOCKED' });
    });
  });

  describe('the maintenance job (PWF 9: incremental, idempotent)', () => {
    it('writes the results of the tasks that closed, makes official the period whose window ended, anonymises the one whose retention ended, and does nothing the second time', async () => {
      const wf = await workflow();
      const task = await seedTask(wf, 'J1', { baselineFinish: `${Y - 3}-05-13`, actualFinish: `${Y - 3}-05-13` });
      await hold(task, WORKER);
      const job = new PwfScoreMaintenanceJob(new AuditWriter(harness.tenants));
      // The job runs as the worker of the platform, which has no membership row: officialization must not depend on a human actor (V3035).
      const run = () => harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) => job.run(tx, WORKER_MEMBERSHIP_ID, new Date()));
      const first = await run();
      expect(first.tasks).toBeGreaterThanOrEqual(1);
      expect(first.results).toBeGreaterThanOrEqual(6);
      expect(await run()).toMatchObject({ tasks: 0, results: 0, officialized: 0, expired: 0 });
      const preview = await compute({ from: `${Y - 3}-04-01`, to: `${Y - 3}-06-30` });
      await lockIt(preview.period.id, preview.period.version);
      // The worker of the platform has no membership, so it cannot be written as an actor column; it is the system, which only a locked period made official may carry (V3035). Nobody else who is not a membership of the tenant may be named either.
      expect(await sqlState(owner('update machvon.staff_score_period set updated_by = $2::uuid where id = $1::uuid', [preview.period.id, WORKER_MEMBERSHIP_ID]))).toBe('23503');
      expect(await sqlState(owner('update machvon.staff_score_period set updated_by = $2::uuid where id = $1::uuid', [preview.period.id, randomUUID()]))).toBe('23503');
      expect(await sqlState(owner('update machvon.staff_score_period set updated_by = null, updated_by_system = true where id = $1::uuid', [preview.period.id]))).toBe('23514');
      expect(await sqlState(owner("update machvon.staff_score_period set official_by_system = true where id = $1::uuid", [preview.period.id]))).toBe('23514');
      // Inside the window nothing happens; once the window has ended the period is official and its event and audit row are written.
      expect((await run()).officialized).toBe(0);
      await owner("update machvon.staff_score_period set locked_at = now() - interval '30 days' where id = $1::uuid", [preview.period.id]);
      const ended = await run();
      expect(ended.officialized).toBe(1);
      expect((await owner<{ status: string }>('select status from machvon.staff_score_period where id = $1::uuid', [preview.period.id]))[0]?.status).toBe('OFFICIAL');
      expect((await owner('select official_by, official_by_system, updated_by, updated_by_system from machvon.staff_score_period where id = $1::uuid', [preview.period.id]))[0]).toEqual({ official_by: null, official_by_system: true, updated_by: null, updated_by_system: true });
      expect((await owner('select 1 from machvon.audit_event where action = $1 and resource_id = $2::uuid', ['score.period_officialized', preview.period.id])).length).toBe(1);
      expect((await owner('select 1 from machvon.outbox_event where aggregate_id = $1::uuid and type = $2', [preview.period.id, 'pwf.score.period.officialized.v1'])).length).toBe(1);
      await owner("update machvon.staff_score_period set snapshot = jsonb_set(snapshot, '{policy,params,retention_months}', '12'::jsonb) where id = $1::uuid", [preview.period.id]);
      expect((await run()).expired).toBe(1);
      expect((await owner<{ erased_at: string | null }>('select erased_at::text from machvon.staff_score_period where id = $1::uuid', [preview.period.id]))[0]?.erased_at).not.toBeNull();
      expect(await run()).toMatchObject({ officialized: 0, expired: 0 });
    });

    it('keeps the membership that made a period official: it can be neither deleted nor have its key changed (V3035), and the period names either that membership or the system, never both', async () => {
      const wf = await workflow();
      const task = await seedTask(wf, 'AC1', { baselineFinish: `${Y - 4}-02-13`, actualFinish: `${Y - 4}-02-13` });
      await hold(task, WORKER);
      const draft = await compute({ from: `${Y - 4}-01-01`, to: `${Y - 4}-03-31` });
      await lockIt(draft.period.id, draft.period.version);
      await owner("update machvon.staff_score_period set status = 'OFFICIAL', official_at = now(), official_by = $2::uuid where id = $1::uuid", [draft.period.id, memberId(RETIRING)]);
      const refused = async (sql: string): Promise<{ code: string; constraint: string }> => {
        try {
          await owner(sql, [memberId(RETIRING)]);
        } catch (error) {
          const e = error as { code?: string; constraint?: string };
          return { code: e.code ?? '', constraint: e.constraint ?? '' };
        }
        throw new Error('expected the database to refuse');
      };
      // The reference is a declarative foreign key of the tenant: a delete or a change of the key is refused, with no window between a check and the change.
      expect(await refused('delete from machvon.membership where id = $1::uuid')).toEqual({ code: '23503', constraint: expect.stringMatching(/staff_score_period.*(official_by|updated_by)/) });
      expect((await refused("update machvon.membership set id = gen_random_uuid() where id = $1::uuid")).code).toBe('23503');
      expect((await owner('select count(*)::int as n from machvon.membership where id = $1::uuid', [memberId(RETIRING)]))[0]).toEqual({ n: 1 });
      // The human and the system are exclusive.
      expect(await sqlState(owner('update machvon.staff_score_period set official_by_system = true where id = $1::uuid', [draft.period.id]))).toBe('23514');
    });

    it('cleans a period that V3033 already marked erased while its lines, responses, signals and approval links were retained (an upgrade), without judging the retention again', async () => {
      const wf = await workflow();
      const task = await seedTask(wf, 'U1', { baselineFinish: `${Y - 3}-11-13`, actualFinish: `${Y - 3}-11-13` });
      await hold(task, WORKER);
      const draft = await compute({ from: `${Y - 3}-10-01`, to: `${Y - 3}-12-31` });
      await lockIt(draft.period.id, draft.period.version);
      const id = draft.period.id;
      const line = (await lineOf(id, WORKER)).id;
      const answered = await as((tx) => adjustments.submit(tx, { lineId: line, body: 'The delay came from the agency; here is the letter I sent them.', actor: memberId(WORKER), today: TODAY }), WORKER);
      await owner("update machvon.staff_score_period set status = 'OFFICIAL', official_at = now(), official_by = $2::uuid where id = $1::uuid", [id, memberId(HR)]);
      // The state V3033 left behind: the person, the words and the tasks blanked and the period marked erased, but every row, the approval link of the response and the unit of each line still there.
      await owner('update machvon.staff_score_response set approval_instance_id = gen_random_uuid() where id = $1::uuid', [answered.id]);
      await owner("update machvon.staff_score_response set subject_membership_id = null, body = '[erased]', conclusion = null where line_id = $1::uuid", [line]);
      await owner("update machvon.staff_score_line set membership_id = null, contributions = '[]'::jsonb, excluded = '[]'::jsonb, erased_at = now() where period_id = $1::uuid", [id]);
      await owner("update machvon.staff_score_signal set membership_id = null, task_codes = '[]'::jsonb where period_id = $1::uuid", [id]);
      await owner(`update machvon.staff_score_period set snapshot = '{"erased": true}'::jsonb, erased_at = now() - interval '1 day' where id = $1::uuid`, [id]);
      const rows = async (): Promise<number> => Number((await owner<{ n: number }>(
        `select (select count(*) from machvon.staff_score_line where period_id = $1::uuid) + (select count(*) from machvon.staff_score_signal where period_id = $1::uuid)
              + (select count(*) from machvon.staff_score_response where line_id = $2::uuid) as n`, [id, line]))[0]?.n);
      expect(await rows()).toBeGreaterThan(1);
      // The period is still inside its retention by the clock of the policy, yet it is picked and cleaned: its erasure was decided already.
      expect(await as((tx) => scores.expiredPeriodIds(tx, new Date()))).toContain(id);
      expect(await as((tx) => scores.expiredPeriodIds(tx, new Date()), MANAGER, TENANT_B)).not.toContain(id);
      expect(await as((tx) => scores.expire(tx, id), MANAGER, TENANT_B)).toBe(false);
      expect(await rows()).toBeGreaterThan(1);
      expect(await as((tx) => scores.expire(tx, id))).toBe(true);
      expect(await rows()).toBe(0);
      const [period] = await owner<{ snapshot: unknown; erased_at: string | null; summary: { people: number } }>('select snapshot, erased_at::text, summary from machvon.staff_score_period where id = $1::uuid', [id]);
      expect(period).toMatchObject({ snapshot: { erased: true }, summary: { people: expect.any(Number) } });
      expect(period?.erased_at).not.toBeNull();
      expect(await as((tx) => scores.expire(tx, id))).toBe(false);
      expect(await as((tx) => scores.expiredPeriodIds(tx, new Date()))).not.toContain(id);
    });
  });

  describe('a past period is read as it stood then (R34)', () => {
    const QUARTER = { from: `${Y - 1}-10-01`, to: `${Y - 1}-12-31` };
    const factsAt = (id: string, cutoff: string) =>
      as((tx) =>
        withScoreScope(tx, SYSTEM_SCORE_SCOPE, async () => {
          const bundle = (await loadTaskBundles(tx, [id])).get(id) as TaskBundle;
          return factsOf(bundle, readingOf(bundle.row, cutoff, bundle.history), cutoff);
        }),
      );

    it('takes the returns, the evidence, the reschedules and the baseline of a task as of the end of the period: what happens in the next quarter cannot change the inputs, the hash or the lock', async () => {
      const wf = await workflow();
      const [stored] = await owner<{ template: typeof TESTFLOW }>('select template from machvon.project_workflow where id = $1::uuid', [wf.id]);
      const template = JSON.parse(JSON.stringify(stored?.template)) as typeof TESTFLOW;
      // The tasks of the test are not the one the workflow made on start: TZ asks for two items, TY for none.
      const base = template.tasks[0] as (typeof TESTFLOW.tasks)[number];
      template.tasks.push(
        { ...base, code: 'TZ', checklist: [{ code: 'CHK1', name: 'First', required: true, evidence_kinds: [] }, { code: 'CHK2', name: 'Second', required: true, evidence_kinds: [] }] } as never,
        { ...base, code: 'TY' },
      );
      await owner('update machvon.project_workflow set template = $2::jsonb where id = $1::uuid', [wf.id, JSON.stringify(template)]);
      // TZ: closed inside the quarter; TY: still open at the end of it and done in January.
      const closed = await seedTask(wf, 'TZ', { baselineFinish: `${Y - 1}-11-14`, actualFinish: `${Y - 1}-11-14`, baselineStart: `${Y - 1}-11-03`, returns: 1 });
      await hold(closed, WORKER);
      const open = await seedTask(wf, 'TY', { baselineFinish: `${Y - 1}-12-15`, baselineStart: `${Y - 1}-12-01`, actualStart: `${Y - 1}-12-01`, actualFinish: `${Y}-01-20`, returns: 1 });
      await hold(open, OTHER);
      const done = (taskId: string, code: string, at: string) =>
        owner("insert into machvon.project_task_checklist_item (tenant_id, task_id, item_code, name, required, evidence_kinds, done, done_by, done_at) values ($1, $2::uuid, $3, $3, true, '{}', true, $4::uuid, $5::timestamptz)", [TENANT_A, taskId, code, memberId(WORKER), at]);
      await done(closed, 'CHK1', `${Y - 1}-11-12T03:00:00Z`);
      await owner('update machvon.project_task set return_count = 1 where id = any($1::uuid[])', [[closed, open]]);
      const before = { closed: await factsAt(closed, QUARTER.to), open: await factsAt(open, QUARTER.to) };
      expect(before.closed).toMatchObject({ returnCount: 1, requiredEvidence: 2, providedEvidence: 1, rescheduleCount: 0, baselineDueCurrent: `${Y - 1}-11-14` });
      expect(before.open).toMatchObject({ returnCount: 1 });
      const draft = await compute(QUARTER);

      // The next quarter: a second return, the second item done and evidence attached, a decided move of the schedule and a later baseline. Each raises the present counters of the task.
      await logReturn(wf.id, closed, `${Y}-01-10T03:00:00Z`);
      await logReturn(wf.id, open, `${Y}-01-10T03:00:00Z`);
      await done(closed, 'CHK2', `${Y}-01-12T03:00:00Z`);
      await owner("insert into machvon.project_task_evidence (tenant_id, task_id, item_code, evidence_kind, external_ref, attached_by, attached_at) values ($1, $2::uuid, 'CHK2', 'NOTE', 'ref', $3::uuid, $4::timestamptz)", [TENANT_A, closed, memberId(WORKER), `${Y}-01-13T03:00:00Z`]);
      await owner(
        "insert into machvon.project_reschedule_proposal (tenant_id, workflow_id, status, base_version, base_schedule_version, input, preview, input_hash, result_hash, reason, proposed_by, proposed_at, decided_by, decided_at, decision_note) values ($1, $2::uuid, 'APPROVED', 1, 1, '{}'::jsonb, $3::jsonb, repeat('a', 64), repeat('b', 64), 'A later move of the schedule in the next quarter', $4::uuid, $5::timestamptz, $6::uuid, $5::timestamptz, 'Approved later')",
        [TENANT_A, wf.id, JSON.stringify({ changes: [{ code: 'TZ', finishShiftDays: 3 }, { code: 'TY', finishShiftDays: 2 }] }), memberId(MANAGER), `${Y}-01-15T03:00:00Z`, memberId(CHECKER)],
      );
      const later = await owner<{ id: string }>('insert into machvon.project_workflow_baseline (tenant_id, workflow_id, version, reason, planned_start, planned_finish, schedule_version, taken_by, taken_at, approved_by) values ($1, $2::uuid, 2, $3, $4::date, $5::date, 1, $6::uuid, $7::timestamptz, $8::uuid) returning id', [TENANT_A, wf.id, 'A later baseline for the test', `${Y - 1}-10-01`, `${Y}-03-31`, memberId(MANAGER), `${Y}-01-20T03:00:00Z`, memberId(CHECKER)]);
      await owner('insert into machvon.project_task_baseline (tenant_id, baseline_id, task_id, start_day, finish_day) values ($1, $2::uuid, $3::uuid, $4::date, $5::date)', [TENANT_A, later[0]?.id, closed, `${Y - 1}-11-03`, `${Y}-01-30`]);
      await owner('update machvon.project_task set return_count = 2, reschedule_count = 1, version = version + 1 where id = any($1::uuid[])', [[closed, open]]);

      // The inputs of the period are the same as before; the later quarter, read at its own end, does see the later records.
      expect({ closed: await factsAt(closed, QUARTER.to), open: await factsAt(open, QUARTER.to) }).toEqual(before);
      expect(await factsAt(open, `${Y}-01-31`)).toMatchObject({ returnCount: 2, rescheduleCount: 1 });
      const again = await compute(QUARTER);
      expect(again.previewHash).toBe(draft.previewHash);
      const locked = await lockIt(again.period.id, again.period.version);
      expect(locked.facts.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(await as((tx) => scores.verify(tx, again.period.id))).toEqual({ reproducible: true, hashMatches: true, figuresMatch: true });
    });

    it('reads a task awaiting approval on the last day as awaiting although it was sent back the next month: the score and the hash of the period do not move, and the task stays a candidate', async () => {
      const wf = await workflow();
      const lastDay = `${Y - 1}-09-30`;
      // Due after the period, so only its standing at the end of the period makes it a candidate; handed in for approval on the last day.
      const task = await seedTask(wf, 'RQ1', { status: 'AWAITING_APPROVAL', baselineFinish: `${Y - 1}-10-20`, baselineStart: `${Y - 1}-09-01`, actualStart: `${Y - 1}-09-01`, actualFinish: null });
      await owner('update machvon.project_task set completion_requested_at = $2::timestamptz, completion_requested_by = $3::uuid where id = $1::uuid', [task, `${lastDay}T10:00:00Z`, memberId(WORKER)]);
      await owner("insert into machvon.project_task_log (tenant_id, workflow_id, task_id, kind, at, actor, subject) values ($1, $2::uuid, $3::uuid, 'COMPLETE_REQUESTED', $4::timestamptz, $5::uuid, '{}'::jsonb)", [TENANT_A, wf.id, task, `${lastDay}T10:00:00Z`, memberId(WORKER)]);
      await hold(task, WORKER);
      const quarter = { from: `${Y - 1}-07-01`, to: lastDay };
      const figures = async (periodId: string): Promise<unknown> => (await owner('select contributions, excluded, score_computed::text, state, rated_task_count from machvon.staff_score_line where period_id = $1::uuid and membership_id = $2::uuid', [periodId, memberId(WORKER)]))[0];
      const before = await compute(quarter);
      const worker = (await figures(before.period.id)) as { contributions: Array<{ task_code: string }> };
      expect(worker.contributions.map((one) => one.task_code)).toContain('RQ1');
      const factsBefore = await factsAt(task, lastDay);
      expect(factsBefore).toMatchObject({ status: 'DONE', actualFinish: lastDay });

      // The next month the approver sends it back: the status and the request of the task are cleared, and the log has the return.
      await owner('update machvon.project_task set status = $2, actual_finish = null, completion_requested_at = null, completion_requested_by = null, return_count = 1 where id = $1::uuid', [task, 'IN_PROGRESS']);
      await logReturn(wf.id, task, `${Y - 1}-10-06T03:00:00Z`);

      expect(await factsAt(task, lastDay)).toEqual(factsBefore);
      const again = await compute(quarter);
      expect(again.previewHash).toBe(before.previewHash);
      expect(await figures(again.period.id)).toEqual(worker);
      expect(await factsAt(task, `${Y - 1}-10-31`)).toMatchObject({ status: 'IN_PROGRESS' });
      const locked = await lockIt(again.period.id, again.period.version);
      expect(locked.facts.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(await as((tx) => scores.verify(tx, again.period.id))).toEqual({ reproducible: true, hashMatches: true, figuresMatch: true });
    });

    it('does not count a task as done at the end of the period when its finish was only declared after it: a request sent back before the end and made again later', async () => {
      const wf = await workflow();
      const task = await seedTask(wf, 'RQ2', { status: 'DONE', baselineFinish: `${Y - 1}-09-20`, baselineStart: `${Y - 1}-09-01`, actualStart: `${Y - 1}-09-01`, actualFinish: `${Y - 1}-09-29` });
      await owner("insert into machvon.project_task_log (tenant_id, workflow_id, task_id, kind, at, actor, subject) values ($1, $2::uuid, $3::uuid, 'COMPLETE_REQUESTED', $4::timestamptz, $5::uuid, '{}'::jsonb)", [TENANT_A, wf.id, task, `${Y - 1}-09-25T03:00:00Z`, memberId(WORKER)]);
      await logReturn(wf.id, task, `${Y - 1}-09-28T03:00:00Z`);
      await owner("insert into machvon.project_task_log (tenant_id, workflow_id, task_id, kind, at, actor, subject) values ($1, $2::uuid, $3::uuid, 'COMPLETE_REQUESTED', $4::timestamptz, $5::uuid, '{}'::jsonb)", [TENANT_A, wf.id, task, `${Y - 1}-10-02T03:00:00Z`, memberId(WORKER)]);
      // The row says done on 29 September, but the request that holds was made in October: at the end of September the task was in progress.
      expect(await factsAt(task, `${Y - 1}-09-30`)).toMatchObject({ status: 'IN_PROGRESS', actualFinish: null });
      expect(await factsAt(task, `${Y - 1}-10-31`)).toMatchObject({ status: 'DONE', actualFinish: `${Y - 1}-09-29` });
    });

  });

  describe('the anti-gaming set (BR-PWF-37, R34)', () => {
    it('UAT-PWF-SEC-10: keeps a task out of reach of deletion and of a new baseline, counts a cancellation the person approved themselves as a miss and one a second person approved as nothing, and raises signals that never change a score', async () => {
      const wf = await workflow();
      const base = { own: true } as const;
      const good = await seedTask(wf, 'G0', { baselineFinish: `${Y}-11-07`, actualFinish: `${Y}-11-07`, ...base });
      await hold(good, WORKER, { from: `${Y}-10-01` });
      // Three small pieces added after the first baseline was taken, in one phase (a split).
      for (const code of ['G1', 'G2', 'G3']) {
        const piece = await seedTask(wf, code, { baselineFinish: `${Y}-11-07`, actualFinish: `${Y}-11-07`, days: 1, phase: 'PX', createdAt: `${Y}-11-05T03:00:00Z`, ...base });
        await hold(piece, WORKER, { from: `${Y}-10-01` });
      }
      const selfCancelled = await seedTask(wf, 'G4', { status: 'CANCELLED', baselineFinish: `${Y}-11-12`, actualFinish: null, cancelledBy: WORKER, cancelledAt: `${Y}-11-12T03:00:00Z`, ...base });
      await hold(selfCancelled, WORKER, { from: `${Y}-10-01` });
      const approvedCancel = await seedTask(wf, 'G5', { status: 'CANCELLED', baselineFinish: `${Y}-11-13`, actualFinish: null, cancelledBy: CHECKER, cancelledAt: `${Y}-11-13T03:00:00Z`, ...base });
      await hold(approvedCancel, WORKER, { from: `${Y}-10-01` });
      // A task handed over three days before its due day and finished late by the next holder.
      const selfCancelledToo = await seedTask(wf, 'G7', { status: 'CANCELLED', baselineFinish: `${Y}-11-14`, actualFinish: null, cancelledBy: WORKER, cancelledAt: `${Y}-11-14T03:00:00Z`, ...base });
      await hold(selfCancelledToo, WORKER, { from: `${Y}-10-01` });
      const handed = await seedTask(wf, 'G6', { baselineFinish: `${Y}-11-20`, actualFinish: `${Y}-11-28`, ...base });
      await hold(handed, OTHER, { from: `${Y}-10-01`, to: `${Y}-11-17` });
      await hold(handed, WORKER, { from: `${Y}-11-18` });
      expect(await sqlState(as((tx) => tx.query('delete from machvon.project_task where id = $1::uuid', [good])))).toBe('42501');
      expect(await sqlState(as((tx) => tx.query("update machvon.project_task set baseline_finish = date '2025-12-30' where id = $1::uuid", [handed])))).toBe('42501');
      const draft = await compute(Q.GAMING);
      const worker = await owner<{ contributions: Array<{ task_code: string; score: number; fraction: number }>; excluded: Array<{ task_code: string; reason: string }>; score_computed: string }>(
        'select contributions, excluded, score_computed::text from machvon.staff_score_line where period_id = $1::uuid and membership_id = $2::uuid',
        [draft.period.id, memberId(WORKER)],
      );
      const line = worker[0] as NonNullable<(typeof worker)[number]>;
      expect(line.contributions.find((one) => one.task_code === 'G4')).toMatchObject({ score: 0 });
      expect(line.excluded).toContainEqual({ task_id: expect.any(String), task_code: 'G5', reason: 'CANCELLED_APPROVED' });
      const signalsOf = async (member: number): Promise<string[]> =>
        (await as((tx) => reads.signals(tx, '*', memberId(HR), draft.period.id, { limit: 50 }))).items.find((one) => one.membershipId === memberId(member))?.flags.map((flag) => flag.code) ?? [];
      expect(await signalsOf(WORKER)).toEqual(['CANCELLED_SHARE_HIGH', 'TASKS_SPLIT_AFTER_BASELINE']);
      expect(await signalsOf(OTHER)).toEqual(['ASSIGNEE_CHANGED_NEAR_DUE']);
      // A baseline moved inside the period is a signal for everyone on the workflow; the score is the same because it is measured against the first one.
      await owner('insert into machvon.project_workflow_baseline (tenant_id, workflow_id, version, reason, planned_start, planned_finish, schedule_version, taken_by, taken_at, approved_by) values ($1, $2::uuid, 2, $3, $4::date, $5::date, 1, $6::uuid, $7::timestamptz, $8::uuid)', [TENANT_A, wf.id, 'A later baseline for the test', `${Y}-01-06`, `${Y}-12-31`, memberId(MANAGER), `${Y}-11-10T03:00:00Z`, memberId(CHECKER)]);
      const again = await compute(Q.GAMING);
      expect(again.previewHash).not.toBe(draft.previewHash);
      expect((await lineOf(draft.period.id, WORKER)).score_computed).toBe(line.score_computed);
      expect(await signalsOf(WORKER)).toEqual(['BASELINE_REVISED_IN_PERIOD', 'CANCELLED_SHARE_HIGH', 'TASKS_SPLIT_AFTER_BASELINE']);
      expect(await signalsOf(OTHER)).toEqual(['ASSIGNEE_CHANGED_NEAR_DUE', 'BASELINE_REVISED_IN_PERIOD']);
      // The signals are for the reviewer of the unit only: the person scored and a reader of another unit see none of them.
      expect((await as((tx) => reads.signals(tx, unitId(SIBLING), memberId(HR), draft.period.id, { limit: 50 }))).items).toEqual([]);
      expect((await as((tx) => reads.signals(tx, '', memberId(HR), draft.period.id, { limit: 50 }))).items).toEqual([]);
      const own = await as((tx) => withScoreScope(tx, { units: '', subject: memberId(WORKER) }, () => tx.query('select 1 from machvon.staff_score_signal')));
      expect(own).toEqual([]);
      const hrLine = (await lineOf(draft.period.id, WORKER)).id;
      const seen = await as((tx) => reads.line(tx, viewer(HR, { readUnits: '*', reviewUnits: '*' }), hrLine, everything));
      expect(seen.flags.map((flag) => flag.code)).toEqual(['BASELINE_REVISED_IN_PERIOD', 'CANCELLED_SHARE_HIGH', 'TASKS_SPLIT_AFTER_BASELINE']);
      expect((await as((tx) => reads.line(tx, viewer(HR, { readUnits: '*' }), hrLine, everything))).flags).toEqual([]);
    });
  });
});

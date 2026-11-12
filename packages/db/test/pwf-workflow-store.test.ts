import { randomUUID } from 'node:crypto';
import { pwfSchedule, pwfWorkflow, vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { GovernanceRuleStore } from '../src/governance-rule-store';
import { PrjAppraisalStore } from '../src/prj-appraisal-store';
import { PrjProjectStore } from '../src/prj-project-store';
import { PLAN_PUBLISHED_EVENT } from '../src/prj-stage-machine';
import { PrjStageStore } from '../src/prj-stage-store';
import type { ProjectLessonsPort } from '../src/prj-stage-store';
import { SqlProjectWorkflowGate } from '../src/pwf-gate';
import { PwfDeadlineReads } from '../src/pwf-deadline-reads';
import { PwfRescheduleStore } from '../src/pwf-reschedule-store';
import { pinPublishedCalendars } from '../src/pwf-schedule-support';
import { PwfTaskReads } from '../src/pwf-task-reads';
import { PwfTaskStore } from '../src/pwf-task-store';
import { PwfWorkflowReads } from '../src/pwf-workflow-reads';
import { PwfWorkflowStore } from '../src/pwf-workflow-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

jest.setTimeout(300_000);

const harness = new AuthzHarness();
const projects = new PrjProjectStore();
const workflows = new PwfWorkflowStore();
const tasks = new PwfTaskStore();
const reschedules = new PwfRescheduleStore();
const reads = new PwfWorkflowReads();
const taskReads = new PwfTaskReads();
const deadlines = new PwfDeadlineReads();
const gate = new SqlProjectWorkflowGate();

const MANAGER = 1;
const WORKER = 2;
const CHECKER = 3;
const OTHER = 4;
const PROVINCE = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const WORKER_ID = '00000000-0000-4000-8000-000000000000';
const TODAY = vietnamDateOf(new Date());
const YEAR = Number(TODAY.slice(0, 4));
const START = `${YEAR}-11-02`;
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
const scopes = { act: everything, read: everything };

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MANAGER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const now = (): Date => new Date();

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

/** Two phases: the first keeps the submission to appraisal and the publication of the capital plan closed until A and its milestone are done, the second keeps the completion of the project closed until C is done. */
const TESTFLOW = {
  name: 'Test flow',
  phases: [
    { code: 'P1', name: 'Phase one', gates: ['submitProjectForAppraisal', 'capital.plan_published.v1'] },
    { code: 'P2', name: 'Phase two', gates: ['completeProject'] },
  ],
  tasks: [
    {
      code: 'TA', name: 'Task A', phase: 'P1', kind: 'TASK', duration_working_days: 3, required: true, responsible_role: 'WORKER_ROLE', approver_role: 'CHECKER_ROLE', priority: 'HIGH', predecessors: [],
      legal_doc_types: ['FEASIBILITY_REPORT'], form_templates: [], checklist: [{ code: 'DOSSIER', name: 'Dossier', required: true, evidence_kinds: ['DOCUMENT'] }], kpi_codes: [], when: [],
    },
    {
      code: 'MS_A', name: 'Milestone A', phase: 'P1', kind: 'MILESTONE', duration_working_days: 0, required: true, responsible_role: 'WORKER_ROLE', priority: 'NORMAL', predecessors: [{ task: 'TA', kind: 'FS', lag_working_days: 0 }],
      legal_doc_types: [], form_templates: [], checklist: [], kpi_codes: [], when: [],
    },
    {
      code: 'TC', name: 'Task C', phase: 'P2', kind: 'TASK', duration_working_days: 5, required: true, responsible_role: 'WORKER_ROLE', priority: 'NORMAL', predecessors: [{ task: 'MS_A', kind: 'FS', lag_working_days: 0 }],
      legal_doc_types: [], form_templates: [], checklist: [], kpi_codes: [], when: [],
    },
    {
      code: 'TD', name: 'Task D', phase: 'P2', kind: 'TASK', duration_working_days: 2, required: false, responsible_role: 'WORKER_ROLE', priority: 'LOW', predecessors: [{ task: 'TA', kind: 'SS', lag_working_days: 1 }],
      legal_doc_types: [], form_templates: [], checklist: [], kpi_codes: [], when: [{ field: 'project_group', in: ['A'] }],
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

async function project(options: { status?: string; group?: string | null; unit?: number } = {}): Promise<{ id: string; code: string; version: number }> {
  counter += 1;
  const code = `PW-${counter}-${randomUUID().slice(0, 6)}`;
  const created = await as((tx) => projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(options.unit ?? DEPARTMENT), areaMasterVersionId: areaVersion, totalInvestmentVnd: '500000000000' }, memberId(MANAGER), TODAY));
  await owner('update machvon.project set status = $2, project_group = $3 where id = $1::uuid', [created.id, options.status ?? 'CONCEPT', options.group === undefined ? 'B' : options.group]);
  return { id: created.id, code, version: 1 };
}

async function document(): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'A paper', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
    [TENANT_A, id, `QD-${id.slice(0, 8)}/2026`, memberId(MANAGER)],
  );
  return id;
}

const start = (projectId: string, over: Partial<Parameters<PwfWorkflowStore['start']>[1]> = {}, member = MANAGER) =>
  as((tx) => workflows.start(tx, { projectId, templateCode: 'TESTFLOW', plannedStartDate: START, facts: { project_group: 'B' }, actor: memberId(member), scopes, now: now(), ...over }), member);

const taskOf = async (workflowId: string, code: string): Promise<Record<string, unknown>> => (await owner<{ j: Record<string, unknown> }>('select to_jsonb(t) as j from machvon.project_task t where workflow_id = $1::uuid and task_code = $2', [workflowId, code]))[0]?.j as Record<string, unknown>;
const assign = (taskId: string, who: number, role = 'RESPONSIBLE', over: Record<string, unknown> = {}, member = MANAGER) =>
  as((tx) => tasks.assign(tx, { taskId, actor: memberId(member), scopes, today: TODAY, input: { membershipId: memberId(who), role, validFrom: '2020-01-01', sharePct: 100, reason: 'Assigned for the test', ...over } }), member);
const begin = async (workflowId: string, code: string, who = WORKER, extra: Record<string, unknown> = {}) => {
  const t = await taskOf(workflowId, code);
  return as((tx) => tasks.start(tx, { taskId: t.id as string, expectedVersion: Number(t.version), actor: memberId(who), scopes, today: TODAY, ...extra }), who);
};
const attach = async (workflowId: string, code: string, input: Record<string, unknown>, who = WORKER) => {
  const t = await taskOf(workflowId, code);
  return as((tx) => tasks.attachEvidence(tx, { taskId: t.id as string, actor: memberId(who), scopes, today: TODAY, input: input as never }), who);
};
const finish = async (workflowId: string, code: string, extra: Record<string, unknown> = {}, who = WORKER) => {
  const t = await taskOf(workflowId, code);
  return as((tx) => tasks.complete(tx, { taskId: t.id as string, expectedVersion: Number(t.version), actor: memberId(who), scopes, today: TODAY, ...extra }), who);
};

/** Walks A to done: evidence, checklist, completion by the worker, approval by the checker. */
async function doneA(workflowId: string): Promise<void> {
  const a = await taskOf(workflowId, 'TA');
  await assign(a.id as string, WORKER);
  await begin(workflowId, 'TA');
  const paper = await document();
  await attach(workflowId, 'TA', { evidenceKind: 'DOCUMENT', itemCode: 'DOSSIER', documentId: paper, legalDocType: 'FEASIBILITY_REPORT' });
  const current = await taskOf(workflowId, 'TA');
  await as((tx) => tasks.completeChecklistItem(tx, { taskId: a.id as string, expectedVersion: Number(current.version), actor: memberId(WORKER), scopes, today: TODAY, itemCode: 'DOSSIER' }), WORKER);
  await finish(workflowId, 'TA');
  const t = await taskOf(workflowId, 'TA');
  await as((tx) => tasks.approveCompletion(tx, { taskId: a.id as string, expectedVersion: Number(t.version), actor: memberId(CHECKER), scopes, today: TODAY }), CHECKER);
}

describe('the workflow of a project (PWF-1: start, adopt, tasks, gate, reschedule)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: ELSEWHERE, path: '/u3/' },
      ]);
      await harness.seedMembership(tenant, MANAGER, PROVINCE);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER_ID, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER_ID, TODAY));
    }
    for (const n of [WORKER, CHECKER, OTHER]) await harness.seedMembership(TENANT_A, n, DEPARTMENT);
    areaVersion = await seedArea(TENANT_A);
    // The working calendar: Monday to Friday, no holidays, for the years a test can reach.
    await harness.owner(
      TENANT_A,
      [YEAR - 1, YEAR, YEAR + 1, YEAR + 2].map((year): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
        [TENANT_A, year, memberId(MANAGER)],
      ]),
    );
    await owner(
      `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
       values ($1, 'PROJECT_WORKFLOW_TEMPLATE', 'TESTFLOW', 1, 'APPROVED', $2::jsonb, date '2020-01-01', 'A template for the tests', $3, $4, now(), $5, now())`,
      [TENANT_A, JSON.stringify(TESTFLOW), memberId(MANAGER), memberId(WORKER), memberId(CHECKER)],
    );
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the template through the governance store (PROJECT_WORKFLOW_TEMPLATE, maker is not checker)', () => {
    it('drafts, submits and approves a template by two other people, and refuses an approval by its maker or its submitter', async () => {
      const store = new GovernanceRuleStore();
      const draft = await as((tx) => store.create(tx, { type: 'PROJECT_WORKFLOW_TEMPLATE', code: 'TESTGOV', params: TESTFLOW, effectiveFrom: TODAY, effectiveTo: null, reason: 'A template written for the test', unitId: null }, memberId(MANAGER)));
      const submitted = await as((tx) => store.submit(tx, draft.id, draft.rowVersion, memberId(WORKER)), WORKER);
      expect((await refusal(as((tx) => store.approve(tx, draft.id, submitted.rowVersion, memberId(MANAGER)), MANAGER))).status).toBe(403);
      expect((await refusal(as((tx) => store.approve(tx, draft.id, submitted.rowVersion, memberId(WORKER)), WORKER))).status).toBe(403);
      const approved = await as((tx) => store.approve(tx, draft.id, submitted.rowVersion, memberId(CHECKER)), CHECKER);
      expect(approved.row.status).toBe('APPROVED');
    });

    it('refuses a template with a loop of dependencies when it is drafted, naming the type', async () => {
      const store = new GovernanceRuleStore();
      const loop = { ...TESTFLOW, tasks: [{ ...TESTFLOW.tasks[0], predecessors: [{ task: 'TC', kind: 'FS', lag_working_days: 0 }] }, ...TESTFLOW.tasks.slice(1)] };
      const failure = await refusal(as((tx) => store.create(tx, { type: 'PROJECT_WORKFLOW_TEMPLATE', code: 'TESTLOOP', params: loop, effectiveFrom: TODAY, effectiveTo: null, reason: 'A template with a loop', unitId: null }, memberId(MANAGER))));
      expect(failure.status).toBe(422);
    });
  });

  describe('startProjectWorkflow (F2)', () => {
    it('freezes the template with its hash, makes the tasks, links and checklists, publishes schedule 1 with the first baseline, and the schedule is the kernel one', async () => {
      const p = await project();
      const done = await start(p.id);
      expect(done).toMatchObject({ status: 'ACTIVE', scheduleVersion: 1, templateCode: 'TESTFLOW', templateRuleVersion: 1, taskCount: 4 });
      const [wf] = await owner<{ template_hash: string; template: unknown; schedule_version: number; planned_start_date: string; facts: Record<string, string> }>('select template_hash, template, schedule_version, planned_start_date::text as planned_start_date, facts from machvon.project_workflow where id = $1::uuid', [done.id]);
      expect(wf?.template_hash).toBe(pwfWorkflow.templateHash(pwfWorkflow.parseProjectWorkflowTemplate(TESTFLOW)));
      expect(wf?.facts).toEqual({ project_group: 'B' });
      expect(wf?.planned_start_date).toBe(START);
      const rows = (await owner<{ j: Record<string, unknown> }>('select to_jsonb(t) as j from machvon.project_task t where workflow_id = $1::uuid order by sort_order', [done.id])).map((one) => one.j);
      expect(rows.map((r) => [r.task_code, r.excluded, r.status])).toEqual([['TA', false, 'NOT_STARTED'], ['MS_A', false, 'NOT_STARTED'], ['TC', false, 'NOT_STARTED'], ['TD', true, 'NOT_STARTED']]);
      expect(rows[0]?.planned_start).toBeTruthy();
      expect(rows.every((r) => r.baseline_start === r.planned_start || r.excluded)).toBe(true);
      expect((await owner('select 1 from machvon.project_task_dependency where workflow_id = $1::uuid', [done.id])).length).toBe(3);
      expect((await owner('select 1 from machvon.project_task_checklist_item where task_id = $1::uuid', [rows[0]?.id])).length).toBe(1);
      const versions = await owner<{ version: number; kind: string }>('select version, kind from machvon.project_schedule_version where workflow_id = $1::uuid', [done.id]);
      expect(versions).toEqual([{ version: 1, kind: 'INITIAL' }]);
      expect((await owner('select 1 from machvon.project_workflow_baseline where workflow_id = $1::uuid and version = 1', [done.id])).length).toBe(1);
      expect((await owner<{ planned_start_date: string }>('select planned_start_date::text as planned_start_date from machvon.project where id = $1::uuid', [p.id]))[0]?.planned_start_date).toBe(START);
      // The same input through the pure scheduler gives the same days.
      const expected = pwfSchedule.scheduleProject({ tasks: pwfSchedule.tasksFromTemplate(pwfWorkflow.parseProjectWorkflowTemplate(TESTFLOW), { project_group: 'B' }), plannedStart: START, calendars: await calendarsOf() });
      for (const one of expected.tasks) expect(rows.find((r) => r.task_code === one.code)?.planned_finish).toBe(one.finish);
      expect((await owner('select 1 from machvon.project_task_log where workflow_id = $1::uuid and kind = $2', [done.id, 'WORKFLOW_STARTED'])).length).toBe(1);
    });

    it('UAT-PWF-NEG-01: is one workflow per project (409 PWF_WORKFLOW_EXISTS), needs a template (404) and a project in scope (404 outside, 403 when only readable)', async () => {
      const p = await project();
      await start(p.id);
      expect((await refusal(start(p.id))).code).toBe('PWF_WORKFLOW_EXISTS');
      expect((await refusal(start((await project()).id, { templateCode: 'NO_SUCH_TEMPLATE' }))).code).toBe('PWF_TEMPLATE_NOT_FOUND');
      const hidden = await project();
      expect(await refusal(start(hidden.id, { scopes: { act: nothing, read: nothing } }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(start(hidden.id, { scopes: { act: nothing, read: everything } }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
    });

    it('asks for a fact a branch reads and never guesses it (422 PWF_FACTS_REQUIRED), and leaves out the branch the facts do not give', async () => {
      const p = await project({ group: null });
      expect(await refusal(start(p.id, { facts: {} }))).toMatchObject({ code: 'PWF_FACTS_REQUIRED', status: 422 });
      const started = await start(p.id, { facts: { project_group: 'C' } });
      expect((await taskOf(started.id, 'TD')).excluded).toBe(true);
      const included = await start((await project()).id, { facts: { project_group: 'A' } });
      expect((await taskOf(included.id, 'TD')).excluded).toBe(false);
    });

    it('says CALENDAR_UNAVAILABLE for a task in a year with no calendar and never makes up a day', async () => {
      const p = await project();
      const far = await start(p.id, { plannedStartDate: `${YEAR + 6}-03-02` });
      const rows = await owner<{ task_code: string; state: string; planned_start: string | null; missing_year: number | null }>('select task_code, state, planned_start::text as planned_start, missing_year from machvon.project_task where workflow_id = $1::uuid and not excluded', [far.id]);
      expect(rows.every((r) => r.state === 'CALENDAR_UNAVAILABLE' && r.planned_start === null && r.missing_year === YEAR + 6)).toBe(true);
    });

    it('keeps the workflow of a project as it was frozen when the template is approved again later (BR-PWF-02)', async () => {
      const p = await project();
      const first = await start(p.id);
      const store = new GovernanceRuleStore();
      const changed = { ...TESTFLOW, tasks: TESTFLOW.tasks.map((one) => (one.code === 'TC' ? { ...one, duration_working_days: 9 } : one)) };
      const draft = await as((tx) => store.create(tx, { type: 'PROJECT_WORKFLOW_TEMPLATE', code: 'TESTFLOW', params: changed, effectiveFrom: TODAY, effectiveTo: null, reason: 'A longer task C for the test', unitId: null }, memberId(MANAGER)));
      const submitted = await as((tx) => store.submit(tx, draft.id, draft.rowVersion, memberId(WORKER)), WORKER);
      await as((tx) => store.approve(tx, draft.id, submitted.rowVersion, memberId(CHECKER)), CHECKER);
      expect((await taskOf(first.id, 'TC')).duration_working_days).toBe(5);
      const second = await start((await project()).id);
      expect(second.templateRuleVersion).toBe(2);
      expect((await taskOf(second.id, 'TC')).duration_working_days).toBe(9);
      expect(second.templateHash).not.toBe(first.templateHash);
    });
  });

  describe('adoptProjectWorkflow (F3, R36)', () => {
    const adopt = (projectId: string, over: Record<string, unknown> = {}, dryRun = true) =>
      as((tx) => workflows.adopt(tx, { projectId, templateCode: 'TESTFLOW', plannedStartDate: `${YEAR}-09-01`, effectiveDate: `${YEAR}-10-15`, dryRun, facts: { project_group: 'B' }, actor: memberId(MANAGER), scopes, now: now(), ...over } as never));

    it('previews the adoption without writing anything, and says which tasks need a decision', async () => {
      const p = await project({ status: 'IMPLEMENTATION' });
      const preview = await adopt(p.id);
      expect(preview).toMatchObject({ dryRun: true, applied: false, workflow: null });
      expect(preview.tasks.filter((one) => one.needsDecision).map((one) => one.taskCode)).toEqual(['TA', 'MS_A', 'TC']);
      expect((await owner('select 1 from machvon.project_workflow where project_id = $1::uuid', [p.id])).length).toBe(0);
      expect((await owner('select 1 from machvon.project_task_log where task_id is null and kind = $1 and workflow_id in (select id from machvon.project_workflow where project_id = $2::uuid)', ['ADOPTED', p.id])).length).toBe(0);
    });

    it('tells in the dry run what apply would refuse for the evidence of a task taken in as done', async () => {
      const p = await project({ status: 'IMPLEMENTATION' });
      const preview = await as((tx) => workflows.adopt(tx, { projectId: p.id, templateCode: 'TESTFLOW', plannedStartDate: `${YEAR}-09-01`, effectiveDate: `${YEAR}-10-15`, dryRun: true, facts: { project_group: 'B' }, actor: memberId(MANAGER), scopes, now: now(), pastTasks: [{ taskCode: 'TA', treatment: 'DONE', evidence: [] }, { taskCode: 'MS_A', treatment: 'NOT_TRACKED' }, { taskCode: 'TC', treatment: 'NOT_TRACKED' }] }));
      expect(preview.findings).toContainEqual({ code: 'EVIDENCE_MISSING', task: 'TA' });
    });

    it('UAT-PWF-NEG-07: refuses to apply while a past task is undecided (422 PWF_ADOPT_INVALID), then applies: not tracked, done with evidence, in progress', async () => {
      const p = await project({ status: 'IMPLEMENTATION' });
      expect(await refusal(adopt(p.id, {}, false))).toMatchObject({ code: 'PWF_ADOPT_INVALID', status: 422 });
      const paper = await document();
      const applied = await adopt(
        p.id,
        {
          pastTasks: [
            { taskCode: 'TA', treatment: 'DONE', actualStart: `${YEAR}-09-01`, actualFinish: `${YEAR}-09-03`, evidence: [{ evidenceKind: 'DOCUMENT', documentId: paper, legalDocType: 'FEASIBILITY_REPORT' }] },
            { taskCode: 'MS_A', treatment: 'NOT_TRACKED' },
          ],
          inProgressTasks: [{ taskCode: 'TC', actualStart: `${YEAR}-10-12`, remainingWorkingDays: 3 }],
        },
        false,
      );
      expect(applied).toMatchObject({ applied: true });
      const id = applied.workflow?.id as string;
      expect(await taskOf(id, 'TA')).toMatchObject({ status: 'DONE', tracked: true });
      expect(await taskOf(id, 'MS_A')).toMatchObject({ tracked: false });
      // A past task taken in without its real dates ends where the plan put it: the schedule that was published is the one that is kept.
      const plain = await taskOf(id, 'MS_A');
      expect(plain.actual_finish).toBe(plain.planned_finish);
      expect(await taskOf(id, 'TC')).toMatchObject({ status: 'IN_PROGRESS', remaining_working_days: 3 });
      expect((await owner<{ adopted_on: string }>('select adopted_on::text as adopted_on from machvon.project_workflow where id = $1::uuid', [id]))[0]?.adopted_on).toBe(`${YEAR}-10-15`);
      expect((await owner<{ kind: string }>('select kind from machvon.project_schedule_version where workflow_id = $1::uuid', [id]))[0]?.kind).toBe('ADOPTION');
      // A done task needs the evidence of its types.
      const q = await project({ status: 'IMPLEMENTATION' });
      expect(await refusal(adopt(q.id, { pastTasks: [{ taskCode: 'TA', treatment: 'DONE', evidence: [] }, { taskCode: 'MS_A', treatment: 'NOT_TRACKED' }] }, false))).toMatchObject({ code: 'PWF_ADOPT_INVALID', status: 422 });
    });
  });

  describe('the tasks (F4, F5)', () => {
    it('blocks the completion that lacks evidence with the list of blockers, then completes with approval by another person, who is none of the makers', async () => {
      const p = await project();
      const wf = await start(p.id);
      const a = await taskOf(wf.id, 'TA');
      expect(await refusal(begin(wf.id, 'TA'))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      await assign(a.id as string, WORKER);
      await begin(wf.id, 'TA');
      const blocked = await refusal(finish(wf.id, 'TA'));
      expect(blocked).toMatchObject({ code: 'PWF_TASK_COMPLETION_BLOCKED', status: 422 });
      expect((blocked.extensions?.blockers as Array<{ code: string }>).map((one) => one.code).sort()).toEqual(['CHECKLIST_ITEM_OPEN', 'LEGAL_DOC_MISSING']);
      expect(await refusal(attach(wf.id, 'TA', { evidenceKind: 'DOCUMENT', legalDocType: 'NO_SUCH_TYPE', externalRef: 'x' }))).toMatchObject({ code: 'LEGAL_DOC_TYPE_UNKNOWN' });
      await attach(wf.id, 'TA', { evidenceKind: 'DOCUMENT', itemCode: 'DOSSIER', documentId: await document(), legalDocType: 'FEASIBILITY_REPORT' });
      const t = await taskOf(wf.id, 'TA');
      await as((tx) => tasks.completeChecklistItem(tx, { taskId: a.id as string, expectedVersion: Number(t.version), actor: memberId(WORKER), scopes, today: TODAY, itemCode: 'DOSSIER' }), WORKER);
      const requested = await finish(wf.id, 'TA');
      expect(requested.status).toBe('AWAITING_APPROVAL');
      const waiting = await taskOf(wf.id, 'TA');
      const approve = (who: number) => as((tx) => tasks.approveCompletion(tx, { taskId: a.id as string, expectedVersion: Number(waiting.version), actor: memberId(who), scopes, today: TODAY }), who);
      expect((await refusal(approve(WORKER))).code).toBe('SELF_APPROVAL_DENIED');
      const done = await approve(CHECKER);
      expect(done.status).toBe('DONE');
      expect(await taskOf(wf.id, 'TA')).toMatchObject({ status: 'DONE', approved_by: memberId(CHECKER) });
      // The milestone after A is a row of the project milestones (R28), still planned.
      const ms = await taskOf(wf.id, 'MS_A');
      expect(ms.milestone_id).toBeTruthy();
      // The task was approved after its planned day, so the milestone moved later with the schedule: a counted move of a date, and the baseline day is the first schedule's.
      const [milestone] = await owner<{ code: string; status: string; planned_date: string; baseline_date: string }>('select code, status, planned_date::text, baseline_date::text from machvon.project_milestone where id = $1::uuid', [ms.milestone_id]);
      expect(milestone).toMatchObject({ code: 'MS_A', planned_date: ms.planned_finish, baseline_date: ms.baseline_finish });
    });

    it('returns a task for work with a reason (the number of returns grows) and refuses a stale version', async () => {
      const wf = await start((await project()).id);
      const a = await taskOf(wf.id, 'TA');
      await assign(a.id as string, WORKER);
      await begin(wf.id, 'TA');
      await attach(wf.id, 'TA', { evidenceKind: 'DOCUMENT', itemCode: 'DOSSIER', documentId: await document(), legalDocType: 'FEASIBILITY_REPORT' });
      const t = await taskOf(wf.id, 'TA');
      await as((tx) => tasks.completeChecklistItem(tx, { taskId: a.id as string, expectedVersion: Number(t.version), actor: memberId(WORKER), scopes, today: TODAY, itemCode: 'DOSSIER' }), WORKER);
      await finish(wf.id, 'TA');
      const waiting = await taskOf(wf.id, 'TA');
      const ret = (reason: string, version = Number(waiting.version)) => as((tx) => tasks.returnTask(tx, { taskId: a.id as string, expectedVersion: version, actor: memberId(CHECKER), scopes, today: TODAY, reason }), CHECKER);
      expect((await refusal(ret('too short'))).code).toBe('VALIDATION_FAILED');
      expect((await refusal(ret('The dossier lacks the signature page of the investor', 1))).code).toBe('VERSION_CONFLICT');
      await ret('The dossier lacks the signature page of the investor');
      expect(await taskOf(wf.id, 'TA')).toMatchObject({ status: 'IN_PROGRESS', return_count: 1 });
    });

    it('UAT-PWF-NEG-04: pauses and cancels only by an exception that another person decides; a waiver covers what is missing but never the rule of the approver', async () => {
      const wf = await start((await project()).id);
      const c = await taskOf(wf.id, 'TC');
      await assign(c.id as string, WORKER);
      await begin(wf.id, 'TC', WORKER, { earlyStartReason: 'The site crew is free and the design is signed', mayStartEarly: true });
      const asked = await as((tx) => tasks.requestException(tx, { taskId: c.id as string, actor: memberId(WORKER), scopes, today: TODAY, kind: 'PAUSE', reason: 'Waiting for the site to be handed over' }), WORKER);
      const decide = (id: string, who: number, version = 1, decision = 'APPROVE') => as((tx) => tasks.decideException(tx, { exceptionId: id, expectedVersion: version, decision, actor: memberId(who), scopes, today: TODAY }), who);
      expect((await refusal(decide(asked.exceptionId, WORKER))).code).toBe('SELF_APPROVAL_DENIED');
      expect((await decide(asked.exceptionId, CHECKER)).status).toBe('ON_HOLD');
      expect((await refusal(decide(asked.exceptionId, OTHER, 2))).code).toBe('PWF_EXCEPTION_INVALID');
      const held = await taskOf(wf.id, 'TC');
      await as((tx) => tasks.resume(tx, { taskId: c.id as string, expectedVersion: Number(held.version), actor: memberId(WORKER), scopes, today: TODAY }), WORKER);
      expect((await owner<{ valid_to: string | null }>('select valid_to::text as valid_to from machvon.project_task_exception where id = $1::uuid', [asked.exceptionId]))[0]?.valid_to).toBe(TODAY);
      // A task nobody may cancel alone: asked, then decided by another.
      const cancel = await as((tx) => tasks.requestException(tx, { taskId: c.id as string, actor: memberId(WORKER), scopes, today: TODAY, kind: 'CANCEL_TASK', reason: 'The work is no longer needed after the redesign' }), WORKER);
      expect((await decide(cancel.exceptionId, CHECKER)).status).toBe('CANCELLED');
      expect(await taskOf(wf.id, 'TC')).toMatchObject({ status: 'CANCELLED', cancelled_by: memberId(CHECKER) });
      expect((await refusal(as((tx) => tasks.requestException(tx, { taskId: c.id as string, actor: memberId(WORKER), scopes, today: TODAY, kind: 'PAUSE', reason: 'A pause of a task that is cancelled' }), WORKER))).code).toBe('PWF_TASK_STATE_INVALID');
    });

    it('UAT-PWF-SEC-06: lets an approved waiver cover a missing document, and the waiver is used up', async () => {
      const wf = await start((await project()).id);
      const a = await taskOf(wf.id, 'TA');
      await assign(a.id as string, WORKER);
      await begin(wf.id, 'TA');
      const asked = await as((tx) => tasks.requestException(tx, { taskId: a.id as string, actor: memberId(WORKER), scopes, today: TODAY, kind: 'WAIVE_REQUIREMENT', items: ['FEASIBILITY_REPORT', 'DOSSIER'], reason: 'The report was issued on paper only and is not scanned yet' }), WORKER);
      await as((tx) => tasks.decideException(tx, { exceptionId: asked.exceptionId, expectedVersion: 1, decision: 'APPROVE', actor: memberId(CHECKER), scopes, today: TODAY }), CHECKER);
      const requested = await finish(wf.id, 'TA', { exceptionId: asked.exceptionId });
      expect(requested.status).toBe('AWAITING_APPROVAL');
      expect((await owner<{ status: string }>('select status from machvon.project_task_exception where id = $1::uuid', [asked.exceptionId]))[0]?.status).toBe('USED');
      // The waiver never covers the approver: the one who worked cannot approve.
      const waiting = await taskOf(wf.id, 'TA');
      expect((await refusal(as((tx) => tasks.approveCompletion(tx, { taskId: a.id as string, expectedVersion: Number(waiting.version), actor: memberId(WORKER), scopes, today: TODAY }), WORKER))).code).toBe('SELF_APPROVAL_DENIED');
    });

    it('a waiver covers only the requirements it names: the missing document still blocks the completion', async () => {
      const wf = await start((await project()).id);
      const a = await taskOf(wf.id, 'TA');
      await assign(a.id as string, WORKER);
      await begin(wf.id, 'TA');
      const asked = await as((tx) => tasks.requestException(tx, { taskId: a.id as string, actor: memberId(WORKER), scopes, today: TODAY, kind: 'WAIVE_REQUIREMENT', items: ['DOSSIER'], reason: 'The dossier is kept by the investor and is not scanned yet' }), WORKER);
      await as((tx) => tasks.decideException(tx, { exceptionId: asked.exceptionId, expectedVersion: 1, decision: 'APPROVE', actor: memberId(CHECKER), scopes, today: TODAY }), CHECKER);
      const blocked = await refusal(finish(wf.id, 'TA', { exceptionId: asked.exceptionId }));
      expect(blocked).toMatchObject({ code: 'PWF_TASK_COMPLETION_BLOCKED' });
      expect((blocked.extensions?.blockers as Array<{ code: string; subject: string }>).map((one) => one.subject)).toEqual(['FEASIBILITY_REPORT']);
    });

    it('UAT-PWF-NEG-03: starts a task whose predecessor is not done only with a reason of 20 characters, and records that it started early', async () => {
      const wf = await start((await project()).id);
      const c = await taskOf(wf.id, 'TC');
      await assign(c.id as string, WORKER);
      const early = (reason?: string, mayStartEarly = true) => as((tx) => tasks.start(tx, { taskId: c.id as string, expectedVersion: Number(c.version), actor: memberId(WORKER), scopes, today: TODAY, mayStartEarly, ...(reason === undefined ? {} : { earlyStartReason: reason }) }), WORKER);
      expect(await refusal(early())).toMatchObject({ code: 'PWF_TASK_STATE_INVALID', status: 409 });
      expect((await refusal(early('too short'))).code).toBe('VALIDATION_FAILED');
      // Whoever holds the task is not the one who may start it early: that is for a manager of the project.
      expect(await refusal(early('The site crew is free and the design is signed', false))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect((await early('The site crew is free and the design is signed')).status).toBe('IN_PROGRESS');
      expect((await taskOf(wf.id, 'TC')).early_start_reason).toBeTruthy();
    });
  });

  describe('the ledger of assignments (R34, BR-PWF-34)', () => {
    it('hands over the line written for the leader in charge to the next person of the role, by closing its open period, and counts the workload by the period of each line', async () => {
      const p = await project();
      await owner(
        `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, status, created_by, updated_by) values ($1, gen_random_uuid(), $2, $3, 'LEADER_IN_CHARGE', date '2026-01-01', 'ACTIVE', $4, $4)`,
        [TENANT_A, p.id, memberId(OTHER), memberId(MANAGER)],
      );
      const wf = await start(p.id);
      const a = await taskOf(wf.id, 'TA');
      const lines = () => owner<{ membership_id: string; valid_to: string | null }>('select membership_id, valid_to::text as valid_to from machvon.project_task_assignment where task_id = $1::uuid order by valid_from', [a.id]);
      expect((await lines()).map((one) => [one.membership_id, one.valid_to])).toEqual([[memberId(OTHER), null]]);
      await assign(a.id as string, WORKER, 'RESPONSIBLE', { validFrom: TODAY });
      expect((await lines()).map((one) => [one.membership_id, one.valid_to === null])).toEqual([[memberId(OTHER), false], [memberId(WORKER), true]]);
      // A line that a manager wrote is handed over in the same way: the next person closes its open period the day before.
      await assign(a.id as string, CHECKER, 'RESPONSIBLE', { validFrom: `${YEAR + 1}-06-01` });
      expect((await lines()).map((one) => [one.membership_id, one.valid_to])).toEqual([[memberId(OTHER), expect.any(String)], [memberId(WORKER), `${YEAR + 1}-05-31`], [memberId(CHECKER), null]]);
      // The person who held it before is no longer the one who works on it.
      expect(await refusal(begin(wf.id, 'TA', OTHER))).toMatchObject({ code: 'SCOPE_DENIED' });
      expect((await begin(wf.id, 'TA', WORKER)).status).toBe('IN_PROGRESS');
      const load = (await as((tx) => deadlines.workload(tx, everything, {}, { weeks: 4 }, now()))) as { people: Array<{ membership_id: string; open_tasks: number }> };
      expect(load.people.find((one) => one.membership_id === memberId(WORKER))?.open_tasks).toBeGreaterThan(0);
    });

    it('adds only: the same person twice in a role over the same days is refused, and the shares of one role add up to 100 at most', async () => {
      const wf = await start((await project()).id);
      const a = await taskOf(wf.id, 'TA');
      await assign(a.id as string, WORKER, 'RESPONSIBLE', { sharePct: 60, validFrom: '2026-01-01', validTo: '2026-06-30' });
      expect(await refusal(assign(a.id as string, WORKER, 'RESPONSIBLE', { sharePct: 20, validFrom: '2026-03-01', validTo: '2026-04-30' }))).toMatchObject({ code: 'PWF_ASSIGNMENT_INVALID', status: 422 });
      expect(await refusal(assign(a.id as string, OTHER, 'RESPONSIBLE', { sharePct: 50, validFrom: '2026-03-01', validTo: '2026-04-30' }))).toMatchObject({ code: 'PWF_ASSIGNMENT_INVALID', detail: 'share_pct' });
      await assign(a.id as string, OTHER, 'RESPONSIBLE', { sharePct: 40, validFrom: '2026-03-01', validTo: '2026-04-30' });
      await assign(a.id as string, OTHER, 'RESPONSIBLE', { sharePct: 100, validFrom: '2026-07-01' });
      expect(await sqlState(as((tx) => tx.query('update machvon.project_task_assignment set share_pct = 1 where task_id = $1::uuid', [a.id])))).toBe('42501');
      expect(await sqlState(as((tx) => tx.query('delete from machvon.project_task_assignment where task_id = $1::uuid', [a.id])))).toBe('42501');
    });

    it('keeps the log append-only: nobody edits or removes a row, and a started workflow cannot be deleted', async () => {
      const wf = await start((await project()).id);
      expect(await sqlState(as((tx) => tx.query('update machvon.project_task_log set reason = $2 where workflow_id = $1::uuid', [wf.id, 'edited'])))).toBe('42501');
      expect(await sqlState(as((tx) => tx.query('delete from machvon.project_task_log where workflow_id = $1::uuid', [wf.id])))).toBe('42501');
      expect(await sqlState(as((tx) => tx.query('delete from machvon.project_workflow where id = $1::uuid', [wf.id])))).toBe('42501');
      expect(await sqlState(as((tx) => tx.query('update machvon.project_task set baseline_finish = baseline_finish + 1 where workflow_id = $1::uuid and baseline_finish is not null', [wf.id])))).toBe('42501');
    });
  });

  describe('the gate of the stage commands (R29, BR-PWF-13)', () => {
    const lessons: ProjectLessonsPort = { gate: async () => ({ met: true, reason: 'APPROVED_LESSONS', required: 1, approved: 1 }) };
    const stage = new PrjStageStore(undefined, { openObligations: async () => ({ committedVnd: '0', disbursedVnd: '0', activeReservations: 0 }) }, lessons);
    const appraisal = new PrjAppraisalStore();

    it('UAT-PWF-REG-02: keeps a project that has no workflow as it was (the gate says nothing)', async () => {
      const p = await project();
      expect(await as((tx) => gate.assess(tx, p.id, 'submitProjectForAppraisal'))).toBeUndefined();
      await as((tx) => gate.assert(tx, p.id, 'submitProjectForAppraisal'));
    });

    it('refuses submitProjectForAppraisal in the same transaction with the tasks that are missing, and lets it through once they are done', async () => {
      const p = await project({ status: 'CONCEPT' });
      const wf = await start(p.id);
      const proposal = await document();
      const submit = () => as((tx) => appraisal.submit(tx, { projectId: p.id, expectedVersion: 1, actor: memberId(MANAGER), scopes, input: { reason: 'Send it for appraisal', policyProposalDocumentId: proposal }, today: TODAY } as never));
      const failure = await refusal(submit());
      expect(failure).toMatchObject({ code: 'PWF_GATE_CLOSED', status: 422 });
      expect((failure.extensions?.missing as Array<{ task: string }>).map((one) => one.task)).toEqual(['TA', 'MS_A']);
      expect((await owner<{ status: string }>('select status from machvon.project where id = $1::uuid', [p.id]))[0]?.status).toBe('CONCEPT');
      await doneA(wf.id);
      const ms = await taskOf(wf.id, 'MS_A');
      await assign(ms.id as string, WORKER);
      await begin(wf.id, 'MS_A');
      await finish(wf.id, 'MS_A');
      expect((await submit()).to).toBe('APPRAISAL');
      expect((await owner<{ status: string }>('select status from machvon.project_milestone where id = $1::uuid', [(await taskOf(wf.id, 'MS_A')).milestone_id]))[0]?.status).toBe('DONE');
    });

    it('refuses a stage command (completeProject) until the required task of the gated phase is done, and an approved cancellation by another person opens it', async () => {
      const p = await project({ status: 'IMPLEMENTATION' });
      const wf = await start(p.id);
      const decision = await document();
      const complete = () =>
        as((tx) => stage.transition(tx, { command: 'completeProject', projectId: p.id, expectedVersion: 1, actor: memberId(MANAGER), scopes, input: { reason: 'The works are finished', decisionDocumentId: decision }, today: TODAY }));
      expect(await refusal(complete())).toMatchObject({ code: 'PWF_GATE_CLOSED', status: 422, extensions: { target: 'completeProject' } });
      const c = await taskOf(wf.id, 'TC');
      await assign(c.id as string, WORKER);
      const asked = await as((tx) => tasks.requestException(tx, { taskId: c.id as string, actor: memberId(WORKER), scopes, today: TODAY, kind: 'CANCEL_TASK', reason: 'The works of C are moved into another project' }), WORKER);
      await as((tx) => tasks.decideException(tx, { exceptionId: asked.exceptionId, expectedVersion: 1, decision: 'APPROVE', actor: memberId(CHECKER), scopes, today: TODAY }), CHECKER);
      const outcome = await as((tx) => gate.assess(tx, p.id, 'completeProject'));
      expect(outcome).toMatchObject({ gated: true, open: true });
      // The gate is open: the command runs, in the same transaction, and moves the project.
      expect((await complete()).to).toBe('COMPLETED');
    });

    it('makes the workflow follow the legal stage: on hold while the project is suspended (and no task moves), active again on resume, cancelled with the project', async () => {
      const p = await project({ status: 'IMPLEMENTATION' });
      const wf = await start(p.id);
      const decision = await document();
      const move = (command: 'suspendProject' | 'resumeProject' | 'cancelProject', projectId: string, version: number) =>
        as((tx) => stage.transition(tx, { command, projectId, expectedVersion: version, actor: memberId(MANAGER), scopes, input: { reason: 'Moved by the test', decisionDocumentId: decision }, today: TODAY }));
      const statusOf = async (workflowId: string): Promise<string | undefined> => (await owner<{ status: string }>('select status from machvon.project_workflow where id = $1::uuid', [workflowId]))[0]?.status;
      const a = await taskOf(wf.id, 'TA');
      await assign(a.id as string, WORKER);
      await move('suspendProject', p.id, 1);
      expect(await statusOf(wf.id)).toBe('ON_HOLD');
      expect(await refusal(begin(wf.id, 'TA'))).toMatchObject({ code: 'PWF_TASK_STATE_INVALID', status: 409 });
      await move('resumeProject', p.id, 2);
      expect(await statusOf(wf.id)).toBe('ACTIVE');
      expect((await begin(wf.id, 'TA')).status).toBe('IN_PROGRESS');
      const early = await project({ status: 'CONCEPT' });
      const other = await start(early.id);
      await move('cancelProject', early.id, 1);
      expect(await statusOf(other.id)).toBe('CANCELLED');
    });

    it('keeps the project in the pipeline when the event of the plan is gated, and reports the refusal with the missing tasks', async () => {
      const p = await project({ status: 'PIPELINE' });
      await start(p.id);
      const planId = randomUUID();
      const proposal = await document();
      await owner(
        `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, decision_document_id, effective_at, created_by, updated_by)
         values ($1, $2, $3, 'ANNUAL', 2026, 2026, 2026, $4, 1, 'PUBLISHED', $5, now(), $6, $6)`,
        [TENANT_A, planId, `CP-${planId.slice(0, 8)}`, unitId(PROVINCE), proposal, memberId(MANAGER)],
      );
      const versionId = randomUUID();
      await harness.owner(TENANT_A, [
        [`insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at, capital_plan_id, created_by, updated_by) values ($1, $2, $3, 2026, 1, $4, 'APPROVED', now(), $5, $6, $6)`, [TENANT_A, versionId, p.id, randomUUID(), planId, memberId(MANAGER)]],
        [`insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, created_by, updated_by) values ($1, $2, $3, $4, 'CURRENT_YEAR', 2026, 1000::numeric, 0, $5, $6, $6)`, [TENANT_A, randomUUID(), versionId, areaVersion, p.id, memberId(MANAGER)]],
      ]);
      const outcome = await as((tx) => stage.budgetFromPublishedPlanGated(tx, { capitalPlanId: planId, projectIds: [p.id], eventId: randomUUID(), actor: memberId(MANAGER) }));
      expect(outcome.changes).toEqual([]);
      expect(outcome.refused.map((one) => [one.projectId, one.outcome.target, one.outcome.missing.map((m) => m.task)])).toEqual([[p.id, PLAN_PUBLISHED_EVENT, ['TA', 'MS_A']]]);
      expect((await owner<{ status: string }>('select status from machvon.project where id = $1::uuid', [p.id]))[0]?.status).toBe('PIPELINE');
    });
  });

  describe('moving the schedule (F6, BR-PWF-08, 28)', () => {
    const propose = (projectId: string, version: number, input: Record<string, unknown>, member = MANAGER) =>
      as((tx) => reschedules.propose(tx, { projectId, expectedVersion: version, input: { reason: 'The start of the project is moved by two weeks', ...input } as never, actor: memberId(member), scopes, now: now() }), member);
    const decide = (proposalId: string, version: number, member: number, decision = 'APPROVE') => as((tx) => reschedules.decide(tx, { proposalId, expectedVersion: version, decision, actor: memberId(member), scopes, now: now() }), member);

    it('UAT-PWF-NEG-05: previews on what is not done with the baseline untouched, is decided by another person, and publishes schedule 2 atomically', async () => {
      const p = await project();
      const wf = await start(p.id);
      const before = await taskOf(wf.id, 'TC');
      const proposal = await propose(p.id, wf.version, { plannedStartDate: `${YEAR}-11-16` });
      expect(proposal).toMatchObject({ status: 'PROPOSED', baseVersion: wf.version });
      expect(proposal.preview.changes.length).toBeGreaterThan(0);
      expect(await refusal(propose(p.id, wf.version, { plannedStartDate: `${YEAR}-11-23` }))).toMatchObject({ code: 'PWF_RESCHEDULE_PENDING_EXISTS', status: 409 });
      expect((await refusal(decide(proposal.id, wf.version, MANAGER))).code).toBe('SELF_APPROVAL_DENIED');
      const done = await decide(proposal.id, wf.version, CHECKER);
      expect(done.scheduleVersion).toBe(2);
      const after = await taskOf(wf.id, 'TC');
      expect(after.planned_start).not.toBe(before.planned_start);
      expect(after.baseline_start).toBe(before.baseline_start);
      expect(after.baseline_finish).toBe(before.baseline_finish);
      expect(Number(after.reschedule_count)).toBe(1);
      const published = await owner<{ version: number; kind: string; approved_by: string; proposed_by: string }>('select version, kind, approved_by, proposed_by from machvon.project_schedule_version where workflow_id = $1::uuid order by version', [wf.id]);
      expect(published.map((one) => [one.version, one.kind])).toEqual([[1, 'INITIAL'], [2, 'RESCHEDULE']]);
      expect(published[1]).toMatchObject({ approved_by: memberId(CHECKER), proposed_by: memberId(MANAGER) });
      // Decided once: the second decision is a conflict, not a second publication.
      expect((await refusal(decide(proposal.id, wf.version, OTHER))).code).toBe('PWF_SCHEDULE_VERSION_CONFLICT');
      expect((await owner('select 1 from machvon.project_schedule_version where workflow_id = $1::uuid', [wf.id])).length).toBe(2);
    });

    it('UAT-PWF-CON-01: lets two approvers race for one proposal: one publishes, the other gets 409 PWF_SCHEDULE_VERSION_CONFLICT', async () => {
      const p = await project();
      const wf = await start(p.id);
      const proposal = await propose(p.id, wf.version, { plannedStartDate: `${YEAR}-11-23` });
      const results = await Promise.allSettled([decide(proposal.id, wf.version, CHECKER), decide(proposal.id, wf.version, OTHER)]);
      expect(results.filter((one) => one.status === 'fulfilled').length).toBe(1);
      const rejected = results.find((one) => one.status === 'rejected') as PromiseRejectedResult;
      expect((rejected.reason as { code: string }).code).toBe('PWF_SCHEDULE_VERSION_CONFLICT');
      expect((await owner('select 1 from machvon.project_schedule_version where workflow_id = $1::uuid', [wf.id])).length).toBe(2);
    });

    it('supersedes a proposal the schedule has outrun, and a proposal can be rejected without publishing', async () => {
      const p = await project();
      const wf = await start(p.id);
      const first = await propose(p.id, wf.version, { plannedStartDate: `${YEAR}-11-16` });
      await decide(first.id, wf.version, CHECKER, 'REJECT');
      expect((await owner<{ status: string }>('select status from machvon.project_reschedule_proposal where id = $1::uuid', [first.id]))[0]?.status).toBe('REJECTED');
      expect((await owner('select 1 from machvon.project_schedule_version where workflow_id = $1::uuid', [wf.id])).length).toBe(1);
      const second = await propose(p.id, wf.version, { plannedStartDate: `${YEAR}-11-16` });
      const third = await propose(p.id, wf.version, { plannedStartDate: `${YEAR}-11-16` }).catch((error) => error as { code: string });
      expect((third as { code: string }).code).toBe('PWF_RESCHEDULE_PENDING_EXISTS');
      await decide(second.id, wf.version, CHECKER);
      // A new publication supersedes whatever waits: propose again on the new version, move the schedule by progress, and the proposal is outrun.
      const fresh = await owner<{ version: number }>('select version from machvon.project_workflow where id = $1::uuid', [wf.id]);
      const waiting = await propose(p.id, Number(fresh[0]?.version), { plannedStartDate: `${YEAR}-12-07` });
      await doneA(wf.id);
      expect((await refusal(decide(waiting.id, Number(fresh[0]?.version), OTHER))).code).toBe('PWF_SCHEDULE_VERSION_CONFLICT');
    });

    it('writes the links of the added tasks after all of them (a task may follow one added later), lets the added tasks be completed, and serializes completions that publish the schedule', async () => {
      const p = await project();
      const wf = await start(p.id);
      const proposal = await propose(p.id, wf.version, {
        overrides: {
          add: [
            { code: 'OWN_AA', name: 'Added first', phase: 'P1', kind: 'TASK', durationWorkingDays: 2, predecessors: [{ task: 'OWN_BB', kind: 'FS', lagWorkingDays: 0 }] },
            { code: 'OWN_BB', name: 'Added second', phase: 'P1', kind: 'TASK', durationWorkingDays: 2 },
            { code: 'OWN_CC', name: 'Added third', phase: 'P1', kind: 'TASK', durationWorkingDays: 1 },
          ],
        },
      });
      await decide(proposal.id, wf.version, CHECKER);
      expect((await owner('select 1 from machvon.project_task_dependency where workflow_id = $1::uuid and task_id = $2::uuid', [wf.id, (await taskOf(wf.id, 'OWN_AA')).id])).length).toBe(1);
      for (const code of ['OWN_BB', 'OWN_CC']) {
        await assign((await taskOf(wf.id, code)).id as string, WORKER);
        await begin(wf.id, code);
      }
      const results = await Promise.allSettled([finish(wf.id, 'OWN_BB'), finish(wf.id, 'OWN_CC')]);
      expect(results.map((one) => one.status)).toEqual(['fulfilled', 'fulfilled']);
      expect((await taskOf(wf.id, 'OWN_BB')).status).toBe('DONE');
      // The answer carries the version the task has after the schedule it published wrote its days on it.
      for (const [code, result] of [['OWN_BB', results[0]], ['OWN_CC', results[1]]] as const) expect((result as PromiseFulfilledResult<{ version: number }>).value.version).toBe(Number((await taskOf(wf.id, code)).version));
      const versions = await owner<{ version: number }>('select version from machvon.project_schedule_version where workflow_id = $1::uuid order by version', [wf.id]);
      expect(versions.map((one) => one.version)).toEqual(versions.map((_, index) => index + 1));
    });

    it('cancels the milestone of a milestone task that an approved override removed, so nothing counts it late', async () => {
      const p = await project();
      const wf = await start(p.id);
      const milestoneId = (await taskOf(wf.id, 'MS_A')).milestone_id as string;
      expect((await owner<{ status: string }>('select status from machvon.project_milestone where id = $1::uuid', [milestoneId]))[0]?.status).toBe('PLANNED');
      const proposal = await propose(p.id, wf.version, { overrides: { remove: ['MS_A'] } });
      await decide(proposal.id, wf.version, CHECKER);
      expect((await owner<{ status: string }>('select status from machvon.project_milestone where id = $1::uuid', [milestoneId]))[0]?.status).toBe('CANCELLED');
    });

    it('does not keep a gate closed for a required task that an approved override removed', async () => {
      const p = await project();
      const wf = await start(p.id);
      const before = await as((tx) => gate.assess(tx, p.id, 'completeProject'));
      expect(before).toMatchObject({ gated: true, open: false });
      const proposal = await propose(p.id, wf.version, { overrides: { remove: ['TC'] } });
      await decide(proposal.id, wf.version, CHECKER);
      expect(await as((tx) => gate.assess(tx, p.id, 'completeProject'))).toMatchObject({ gated: true, open: true, missing: [] });
    });

    it('adds a task of the project and changes a duration through the overrides, written only when the proposal is approved', async () => {
      const p = await project();
      const wf = await start(p.id);
      const proposal = await propose(p.id, wf.version, {
        overrides: { add: [{ code: 'OWN_SURVEY', name: 'Extra survey', phase: 'P1', kind: 'TASK', durationWorkingDays: 4, predecessors: [{ task: 'TA', kind: 'FS', lagWorkingDays: 0 }] }], change: [{ taskCode: 'TC', durationWorkingDays: 8 }] },
      });
      expect((await owner('select 1 from machvon.project_task where workflow_id = $1::uuid and task_code = $2', [wf.id, 'OWN_SURVEY'])).length).toBe(0);
      await decide(proposal.id, wf.version, CHECKER);
      expect(await taskOf(wf.id, 'OWN_SURVEY')).toMatchObject({ own_task: true, duration_working_days: 4 });
      expect((await taskOf(wf.id, 'TC')).duration_working_days).toBe(8);
      expect((await owner('select 1 from machvon.project_task_dependency where workflow_id = $1::uuid and task_id = $2::uuid', [wf.id, (await taskOf(wf.id, 'OWN_SURVEY')).id])).length).toBe(1);
    });
  });

  describe('one authoritative schedule (R28)', () => {
    it('links a milestone the project already has without moving its day or its baseline, and later schedules move it as a counted move of a date', async () => {
      const p = await project();
      const milestoneId = randomUUID();
      await owner(
        `insert into machvon.project_milestone (tenant_id, id, project_id, code, name, baseline_date, planned_date, status, created_by, updated_by)
         values ($1, $2, $3, 'MS_A', 'Existing milestone', $4::date, $4::date, 'PLANNED', $5, $5)`,
        [TENANT_A, milestoneId, p.id, `${YEAR + 1}-01-15`, memberId(MANAGER)],
      );
      const before = await owner('select id, code, baseline_date::text, planned_date::text, status, version from machvon.project_milestone where project_id = $1::uuid', [p.id]);
      const wf = await start(p.id);
      expect(await owner('select id, code, baseline_date::text, planned_date::text, status, version from machvon.project_milestone where project_id = $1::uuid', [p.id])).toEqual(before);
      expect((await taskOf(wf.id, 'MS_A')).milestone_id).toBe(milestoneId);
      expect((await owner('select 1 from machvon.project_milestone where project_id = $1::uuid', [p.id])).length).toBe(1);
      const proposal = await as((tx) => reschedules.propose(tx, { projectId: p.id, expectedVersion: wf.version, input: { reason: 'The start of the project is moved by two weeks', plannedStartDate: `${YEAR}-11-16` }, actor: memberId(MANAGER), scopes, now: now() }));
      await as((tx) => reschedules.decide(tx, { proposalId: proposal.id, expectedVersion: wf.version, decision: 'APPROVE', actor: memberId(CHECKER), scopes, now: now() }), CHECKER);
      const [moved] = await owner<{ planned_date: string; baseline_date: string; status: string }>('select planned_date::text, baseline_date::text, status from machvon.project_milestone where id = $1::uuid', [milestoneId]);
      expect(moved?.baseline_date).toBe(`${YEAR + 1}-01-15`);
      expect(moved?.planned_date).toBe((await taskOf(wf.id, 'MS_A')).planned_finish);
    });
  });

  describe('the reads', () => {
    it('shows the workflow with phases, official colours, gates and exact counts, and a task in full with what the caller may do', async () => {
      const p = await project();
      const wf = await start(p.id);
      const detail = (await as((tx) => reads.detail(tx, everything, p.id, now(), { manage: true, proposeReschedule: true, work: true, approve: true, assign: true }))) as Record<string, unknown>;
      expect(detail).toMatchObject({ template_code: 'TESTFLOW', status: 'ACTIVE', unverified: false, open_phase: 'P1', schedule_version: 1 });
      expect((detail.phases as Array<{ code: string; required_total: number }>).map((one) => [one.code, one.required_total])).toEqual([['P1', 2], ['P2', 1]]);
      expect((detail.gates as Array<{ target: string; open: boolean; missing_count: number }>).find((one) => one.target === 'completeProject')).toMatchObject({ open: false, missing_count: 1 });
      const page = await as((tx) => reads.listTasks(tx, everything, p.id, { phase: 'P1' }, { limit: 1 }, now()));
      expect(page.total).toBe(2);
      expect(page.items.length).toBe(1);
      expect(page.next).not.toBeNull();
      const schedule = (await as((tx) => reads.schedule(tx, everything, p.id))) as { schedule_version: number; tasks: Array<{ task_code: string; start: string | null }> };
      expect(schedule.schedule_version).toBe(1);
      expect(schedule.tasks.find((one) => one.task_code === 'TA')?.start).toBe(START);
      const a = await taskOf(wf.id, 'TA');
      const full = (await as((tx) => taskReads.task(tx, everything, a.id as string, now(), memberId(WORKER), { manage: false, proposeReschedule: false, work: true, approve: false, assign: false }), WORKER)) as Record<string, unknown>;
      expect(full).toMatchObject({ task_code: 'TA', can_start: false, can_assign: false });
      expect((full.completion as { ok: boolean }).ok).toBe(false);
      expect(await refusal(as((tx) => reads.detail(tx, nothing, p.id, now(), { manage: false, proposeReschedule: false, work: false, approve: false, assign: false })))).toMatchObject({ status: 404 });
    });

    it('does not show a project of another tenant (404)', async () => {
      const p = await project();
      await start(p.id);
      expect((await refusal(as((tx) => reads.detail(tx, everything, p.id, now(), { manage: false, proposeReschedule: false, work: false, approve: false, assign: false }), MANAGER, TENANT_B))).status).toBe(404);
    });
  });
});

const calendarsOf = (): Promise<Awaited<ReturnType<typeof pinPublishedCalendars>>> => as((tx) => pinPublishedCalendars(tx, YEAR));

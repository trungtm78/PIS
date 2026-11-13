import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ProjectTaskController, ProjectTaskReadsController } from '../../src/modules/pwf/task.controller';
import { ProjectWorkflowController, ProjectWorkflowReadsController } from '../../src/modules/pwf/workflow.controller';
import { ProjectController, ProjectReadsController } from '../../src/modules/prj/project.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

/** PWF-4 over HTTP: the kind of workflow chosen when a project is registered (one transaction), the suggestion of the rule with the preview of the schedule, and the steps, legal grounds and checklists in the reads. */

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const YEAR = Number(TODAY.slice(0, 4));
const START = `${YEAR}-11-02`;
const MANAGER = 1; // registers projects and manages workflows over the tenant
const CHECKER = 2;
const READER = 3; // pwf.read only
const REGISTRAR = 4; // project.create and pwf.read, but not pwf.workflow.manage
const NOBODY = 5;
const B_MANAGER = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const WORKER_SYSTEM = '00000000-0000-4000-8000-000000000000';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const cite = (document: string, article?: string) => ({ document, ...(article === undefined ? {} : { article }), verification: 'UNVERIFIED' });
const one = (code: string, phase: string, step: string, extra: Record<string, unknown> = {}) => ({
  code,
  name: `Task ${code}`,
  phase,
  step,
  kind: 'TASK',
  duration_working_days: 2,
  required: true,
  responsible_role: 'WORKER_ROLE',
  approver_role: null,
  priority: 'NORMAL',
  predecessors: [],
  legal_doc_types: [],
  form_templates: [],
  checklist: [],
  kpi_codes: [],
  when: [],
  ...extra,
});

/** Two phases, three steps; TD is only in a project of group A. */
const PROCESS = {
  name: 'Quy trình thử',
  project_type: null,
  phases: [
    { code: 'P1', name: 'Chuẩn bị', gates: [] },
    { code: 'P2', name: 'Thực hiện', gates: [] },
  ],
  steps: [
    { code: 'S_PREPARE', name: 'Lập hồ sơ', phase: 'P1', responsible_role: 'LEAD_ROLE', legal_basis: [cite('LAW_58_2024_QH15')] },
    { code: 'S_REVIEW', name: 'Thẩm định', phase: 'P1' },
    { code: 'S_BUILD', name: 'Thi công', phase: 'P2' },
  ],
  tasks: [
    one('TA', 'P1', 'S_PREPARE', { legal_basis: [cite('DECREE_85_2025_ND_CP', 'Điều 22')], checklist: [{ code: 'DOSSIER', name: 'Hồ sơ đầy đủ', required: true, evidence_kinds: ['DOCUMENT'] }, { code: 'NOTE', name: 'Đã ghi chú', required: false, evidence_kinds: [] }] }),
    one('TB', 'P1', 'S_REVIEW', { predecessors: [{ task: 'TA', kind: 'FS', lag_working_days: 0 }] }),
    one('TC', 'P2', 'S_BUILD', { predecessors: [{ task: 'TB', kind: 'FS', lag_working_days: 0 }] }),
    one('TD', 'P2', 'S_BUILD', { predecessors: [{ task: 'TC', kind: 'FS', lag_working_days: 0 }], when: [{ field: 'project_group', in: ['A'] }] }),
  ],
};

describe('the processing workflow of a project over HTTP (PWF-4)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let areaVersion = '';
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const codeOf = (): string => {
    counter += 1;
    return `PRC-${counter}-${randomUUID().slice(0, 6)}`;
  };
  const register = (code: string, workflow: Record<string, unknown> | undefined, member = MANAGER, key?: string): Promise<Reply> =>
    call('POST', '/projects', {
      member,
      body: { code, name: 'Dự án trường tiểu học Tân Phú', owner_unit_id: unitId(DEPARTMENT), area_master_version_id: areaVersion, total_investment_vnd: '500000000000', ...(workflow === undefined ? {} : { workflow }) },
      ...(key === undefined ? {} : { key }),
    });
  const projectsOf = (code: string) => rows<{ id: string }>('select id from machvon.project where code = $1', [code]);
  const suggestion = (query: string, member = MANAGER, tenantId?: string): Promise<Reply> => call('GET', `/project-workflow/suggestion?${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER_SYSTEM, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER_SYSTEM, TODAY));
    }
    for (const n of [MANAGER, CHECKER, READER, REGISTRAR, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MANAGER, ROOT);
    const all = ['project.create', 'project.read', 'pwf.template.manage', 'pwf.workflow.manage', 'pwf.workflow.adopt', 'pwf.read', 'pwf.task.work', 'pwf.task.approve', 'pwf.task.assign'];
    await harness.seedRole(TENANT_A, 1, 'PWF_MANAGER', all, 40);
    await harness.seedRole(TENANT_A, 3, 'PWF_READER', ['pwf.read'], 10);
    await harness.seedRole(TENANT_A, 4, 'PRJ_REGISTRAR', ['project.create', 'project.read', 'pwf.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'PWF_MANAGER', all, 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: REGISTRAR, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MANAGER, role: 1, kind: 'TENANT' }]);
    const recordId = randomUUID();
    areaVersion = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'TINH-Q', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(MANAGER)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, valid_until, status, master_record_id, published_at, created_by, updated_by) values ($1, $2, 'AREA', 'TINH-Q', 1, 'TINH-Q', '{}'::jsonb, '2020-01-01', null, 'EFFECTIVE', $3, now(), $4, $4)`,
        [TENANT_A, areaVersion, recordId, memberId(MANAGER)],
      ],
    ]);
    await harness.owner(
      TENANT_A,
      [YEAR - 1, YEAR, YEAR + 1, YEAR + 2].map((year): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
        [TENANT_A, year, memberId(MANAGER)],
      ]),
    );
    const approved = (type: string, code: string, params: unknown): [string, unknown[]] => [
      `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
       values ($1, $2, $3, 1, 'APPROVED', $4::jsonb, date '2020-01-01', 'A rule for the tests', $5, $6, now(), $7, now())`,
      [TENANT_A, type, code, JSON.stringify(params), memberId(MANAGER), memberId(READER), memberId(CHECKER)],
    ];
    await harness.owner(TENANT_A, [
      approved('PROJECT_WORKFLOW_TEMPLATE', 'PROCESS', PROCESS),
      // The tenant's own rule: a project of group A or B takes PROCESS; everything else the construction workflow.
      approved('PROJECT_WORKFLOW_ASSIGNMENT', 'DEFAULT', { lines: [{ code: 'GROUP_AB', priority: 10, template_code: 'PROCESS', when: [{ field: 'project_group', in: ['A', 'B'] }] }], default_template_code: 'PUBLIC_REPAIR' }),
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ProjectController, ProjectReadsController, ProjectWorkflowController, ProjectWorkflowReadsController, ProjectTaskController, ProjectTaskReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('suggestProjectWorkflow', () => {
    it('suggests the template of the rule for the facts of the form, lists the templates and previews the schedule from the planned start', async () => {
      const reply = await suggestion(`owner_unit_id=${unitId(DEPARTMENT)}&project_group=B&planned_start_date=${START}`);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ suggested_template_code: 'PROCESS', basis: 'RULE', line: 'GROUP_AB', rule: { version: 1, unverified: false, unit_id: null }, facts: { project_group: 'B' }, can_start: true, unknown_templates: [] });
      expect((reply.json.candidates as Array<{ template_code: string }>).map((item) => item.template_code)).toEqual(['PROCESS', 'PUBLIC_REPAIR']);
      expect((reply.json.templates as Array<{ code: string }>).map((item) => item.code)).toEqual(expect.arrayContaining(['PROCESS', 'PUBLIC_INVESTMENT', 'PUBLIC_PROCUREMENT', 'PUBLIC_REPAIR']));
      expect((reply.json.templates as Array<Record<string, unknown>>).find((item) => item.code === 'PROCESS')).toMatchObject({ phase_count: 2, step_count: 3, task_count: 4, fact_fields: ['project_group'], unverified: false });
      const preview = reply.json.preview as Record<string, unknown>;
      // Group B leaves TD out: three tasks of two working days each, from a Monday.
      expect(preview).toMatchObject({ template_code: 'PROCESS', template_version: 1, planned_start_date: START, project_start: START, total_working_days: 6, standard_working_days: 6, phase_count: 2, step_count: 3, task_count: 3, excluded_tasks: ['TD'], missing_facts: [] });
      expect((preview.steps as Array<Record<string, unknown>>).map((step) => [step.code, step.duration_working_days, step.task_count, step.start])).toEqual([['S_PREPARE', 2, 1, START], ['S_REVIEW', 2, 1, expect.any(String)], ['S_BUILD', 2, 1, expect.any(String)]]);
      expect(typeof preview.project_finish).toBe('string');
    });

    it('previews the template the person is choosing instead, and does not guess a schedule while a fact a branch reads is unknown', async () => {
      const chosen = await suggestion(`owner_unit_id=${unitId(DEPARTMENT)}&project_group=A&template_code=PROCESS&planned_start_date=${START}`);
      expect(chosen.json.preview).toMatchObject({ total_working_days: 8, task_count: 4, excluded_tasks: [] });
      const unknown = await suggestion(`owner_unit_id=${unitId(DEPARTMENT)}&template_code=PROCESS&planned_start_date=${START}`);
      expect(unknown.json).toMatchObject({ suggested_template_code: 'PUBLIC_REPAIR', basis: 'DEFAULT' });
      expect(unknown.json.preview).toMatchObject({ template_code: 'PROCESS', missing_facts: ['project_group'], total_working_days: null, project_finish: null, step_count: 3 });
      expect((await suggestion(`owner_unit_id=${unitId(DEPARTMENT)}&project_group=B`)).json.preview).toBeNull();
      expect((await suggestion(`template_code=NO_SUCH_ONE&planned_start_date=${START}`)).json.code).toBe('PWF_TEMPLATE_NOT_FOUND');
    });

    it('says a year without a published calendar instead of a finish day', async () => {
      const far = await suggestion(`owner_unit_id=${unitId(DEPARTMENT)}&project_group=B&planned_start_date=${YEAR + 2}-12-30`);
      expect(far.json.preview).toMatchObject({ project_finish: null, total_working_days: null });
      expect(((far.json.preview as { findings: Array<{ code: string }> }).findings ?? []).map((finding) => finding.code)).toContain('CALENDAR_UNAVAILABLE');
    });

    it('is a read of pwf.read: a reader sees it without the right to start, a caller without the permission is refused, and a project of another tenant does not exist', async () => {
      expect((await suggestion(`owner_unit_id=${unitId(DEPARTMENT)}&project_group=B`, READER)).json).toMatchObject({ suggested_template_code: 'PROCESS', can_start: false });
      expect((await suggestion('project_group=B', NOBODY)).status).toBe(403);
      const made = await register(codeOf(), undefined);
      expect((await suggestion(`project_id=${made.json.resource_id as string}`, B_MANAGER, TENANT_B)).status).toBe(404);
      expect((await suggestion('project_id=not-an-id')).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await suggestion('project_group=B%3Bdrop')).json).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('reads the group, the type and the unit of a project that exists (PWF-05)', async () => {
      const made = await register(codeOf(), undefined);
      const id = made.json.resource_id as string;
      await rows('update machvon.project set project_group = $2 where id = $1::uuid', [id, 'A']);
      expect((await suggestion(`project_id=${id}&planned_start_date=${START}`)).json).toMatchObject({ suggested_template_code: 'PROCESS', line: 'GROUP_AB', facts: { project_group: 'A' }, can_start: true, preview: { task_count: 4 } });
    });
  });

  describe('createProject with the kind of workflow (one transaction)', () => {
    it('AC-ST-PWF-024-1: registers the project and starts the workflow the rule names, once per idempotency key, with the audit rows and the events of both', async () => {
      const code = codeOf();
      const key = `register-with-workflow-${randomUUID()}`;
      const first = await register(code, { planned_start_date: START, facts: { project_group: 'B' } }, MANAGER, key);
      expect(first).toMatchObject({ status: 200, json: { status: 'CONCEPT' } });
      expect(await register(code, { planned_start_date: START, facts: { project_group: 'B' } }, MANAGER, key)).toEqual(first);
      const id = first.json.resource_id as string;
      const workflows = await rows<{ id: string; template_code: string; planned_start_date: string; selection: Record<string, unknown>; facts: Record<string, unknown> }>(
        'select id, template_code, planned_start_date::text as planned_start_date, selection, facts from machvon.project_workflow where project_id = $1::uuid',
        [id],
      );
      expect(workflows).toHaveLength(1);
      expect(workflows[0]).toMatchObject({ template_code: 'PROCESS', planned_start_date: START, facts: { project_group: 'B' }, selection: { mode: 'AUTO', suggested_template_code: 'PROCESS', basis: 'RULE', line: 'GROUP_AB', rule_version: 1 } });
      expect((await rows('select 1 from machvon.project_task where project_id = $1::uuid', [id])).length).toBe(4);
      expect((await rows<{ planned_start_date: string }>('select planned_start_date::text as planned_start_date from machvon.project where id = $1::uuid', [id]))[0]?.planned_start_date).toBe(START);
      expect((await rows('select 1 from machvon.audit_event where resource_id = $1 and action = $2', [id, 'project.created'])).length).toBe(1);
      const [audit] = await rows<{ diff: Record<string, unknown> }>('select safe_diff as diff from machvon.audit_event where resource_id = $1 and action = $2', [workflows[0]?.id, 'workflow.started']);
      expect(audit?.diff).toMatchObject({ project_id: id, template_code: 'PROCESS', selection_mode: 'AUTO', suggested_template_code: 'PROCESS', assignment_rule_version: 1 });
      const [event] = await rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [workflows[0]?.id, 'pwf.workflow.started.v1']);
      expect(event?.payload).toMatchObject({ project_id: id, template_code: 'PROCESS', selection_mode: 'AUTO' });
      expect((await rows('select 1 from machvon.outbox_event where aggregate_id = $1 and type = $2', [id, 'project.created.v1'])).length).toBe(1);
    });

    it('AC-ST-PWF-024-2: takes another template than the rule suggests only with a reason, and registers nothing when the reason is missing', async () => {
      const code = codeOf();
      const refused = await register(code, { template_code: 'PUBLIC_REPAIR', planned_start_date: START, facts: { project_group: 'B' } });
      expect(refused).toMatchObject({ status: 422, json: { code: 'PWF_SELECTION_REASON_REQUIRED' } });
      expect(await projectsOf(code)).toHaveLength(0);
      const done = await register(code, { template_code: 'PUBLIC_REPAIR', planned_start_date: START, facts: { project_group: 'B' }, selection_reason: 'Dự án sửa chữa theo quyết định của chủ đầu tư' });
      expect(done.status).toBe(200);
      const [workflow] = await rows<{ id: string; selection: Record<string, unknown> }>('select id, selection from machvon.project_workflow where project_id = $1::uuid', [done.json.resource_id]);
      expect(workflow?.selection).toMatchObject({ mode: 'OVERRIDE', chosen_template_code: 'PUBLIC_REPAIR', suggested_template_code: 'PROCESS', reason: 'Dự án sửa chữa theo quyết định của chủ đầu tư' });
      const [audit] = await rows<{ reason: string | null }>('select reason from machvon.audit_event where resource_id = $1 and action = $2', [workflow?.id, 'workflow.started']);
      expect(audit?.reason).toBe('Dự án sửa chữa theo quyết định của chủ đầu tư');
    });

    it('registers nothing when the workflow cannot start: a fact a branch reads is missing, the template does not exist, or the caller may not start workflows', async () => {
      const facts = codeOf();
      expect(await register(facts, { template_code: 'PUBLIC_INVESTMENT', planned_start_date: START, selection_reason: 'Chọn tay khi chưa biết nguồn vốn của dự án' })).toMatchObject({ status: 422, json: { code: 'PWF_FACTS_REQUIRED' } });
      expect(await projectsOf(facts)).toHaveLength(0);
      const missing = codeOf();
      expect(await register(missing, { template_code: 'NO_SUCH_ONE', planned_start_date: START, selection_reason: 'Mẫu riêng của đơn vị chưa được duyệt' })).toMatchObject({ status: 404, json: { code: 'PWF_TEMPLATE_NOT_FOUND' } });
      expect(await projectsOf(missing)).toHaveLength(0);
      const denied = codeOf();
      expect((await register(denied, { planned_start_date: START, facts: { project_group: 'B' } }, REGISTRAR)).status).toBe(403);
      expect(await projectsOf(denied)).toHaveLength(0);
      const bad = codeOf();
      expect((await register(bad, { planned_start_date: 'tomorrow' })).status).toBeGreaterThanOrEqual(400);
      expect(await projectsOf(bad)).toHaveLength(0);
    });

    it('AC-ST-PWF-024-3: still registers a project without a workflow, for anyone who may register projects, and the workflow starts later by the same rule', async () => {
      const code = codeOf();
      const made = await register(code, undefined, REGISTRAR);
      expect(made.status).toBe(200);
      const id = made.json.resource_id as string;
      expect((await rows('select 1 from machvon.project_workflow where project_id = $1::uuid', [id])).length).toBe(0);
      await rows('update machvon.project set project_group = $2 where id = $1::uuid', [id, 'B']);
      const started = await call('POST', `/projects/${id}/workflow`, { member: MANAGER, body: { planned_start_date: START } });
      expect(started).toMatchObject({ status: 200, json: { status: 'ACTIVE' } });
      const [workflow] = await rows<{ template_code: string; selection: Record<string, unknown> }>('select template_code, selection from machvon.project_workflow where project_id = $1::uuid', [id]);
      expect(workflow).toMatchObject({ template_code: 'PROCESS', selection: { mode: 'AUTO' } });
    });
  });

  describe('the reads: phase, step, task, checklist, legal grounds', () => {
    it('shows the workflow in three tiers with the selection, and the task with its step, its checklist and the legal grounds of both', async () => {
      const made = await register(codeOf(), { planned_start_date: START, facts: { project_group: 'A' } });
      const id = made.json.resource_id as string;
      const seen = await call('GET', `/projects/${id}/workflow`, { member: READER });
      expect(seen.status).toBe(200);
      expect(seen.json).toMatchObject({ template_code: 'PROCESS', standard_working_days: 8, lapsed_legal_documents: [], selection: { mode: 'AUTO', chosen_template_code: 'PROCESS' } });
      const steps = seen.json.steps as Array<Record<string, unknown>>;
      expect(steps.map((step) => [step.phase_code, step.code, step.name, step.status, step.task_total, step.checklist_total, step.standard_working_days])).toEqual([
        ['P1', 'S_PREPARE', 'Lập hồ sơ', 'NOT_STARTED', 1, 2, 2],
        ['P1', 'S_REVIEW', 'Thẩm định', 'NOT_STARTED', 1, 0, 2],
        ['P2', 'S_BUILD', 'Thi công', 'NOT_STARTED', 2, 0, 4],
      ]);
      expect((steps[0]?.legal_basis as Array<Record<string, unknown>>)[0]).toMatchObject({ document_code: 'LAW_58_2024_QH15', number: '58/2024/QH15', state: 'IN_FORCE', verification: 'UNVERIFIED' });
      const tasks = seen.json.tasks as Array<Record<string, unknown>>;
      expect(tasks.map((task) => [task.task_code, task.step_code, task.checklist_total])).toEqual([['TA', 'S_PREPARE', 2], ['TB', 'S_REVIEW', 0], ['TC', 'S_BUILD', 0], ['TD', 'S_BUILD', 0]]);
      const task = await call('GET', `/project-tasks/${tasks[0]?.id as string}`, { member: READER });
      expect(task.json).toMatchObject({ step: { code: 'S_PREPARE', name: 'Lập hồ sơ', phase_code: 'P1', order: 1, implicit: false, responsible_role: 'LEAD_ROLE' }, form_templates: [] });
      expect((task.json.checklist as Array<Record<string, unknown>>).map((item) => [item.item_code, item.required, item.done])).toEqual([['DOSSIER', true, false], ['NOTE', false, false]]);
      expect(task.json.legal_basis).toEqual([expect.objectContaining({ document_code: 'DECREE_85_2025_ND_CP', article: 'Điều 22', number: '85/2025/NĐ-CP', state: 'IN_FORCE' })]);
      expect((task.json.step_legal_basis as unknown[]).length).toBe(1);
    });
  });

  describe('the checks of a template (legal grounds and form revisions)', () => {
    it('AC-ST-PWF-022-3: accepts a template in three tiers, refuses a document the catalogue does not have and a pinned revision that is not approved, and warns of a document that was replaced', async () => {
      expect((await call('POST', '/project-workflow/templates/validate', { member: MANAGER, body: PROCESS })).json).toMatchObject({ valid: true, findings: [], task_count: 4, phase_count: 2 });
      const withBasis = (basis: unknown[]) => ({ ...PROCESS, steps: [{ ...PROCESS.steps[0], legal_basis: basis }, ...PROCESS.steps.slice(1)] });
      const unknown = await call('POST', '/project-workflow/templates/validate', { member: MANAGER, body: withBasis([cite('NO_SUCH_DOCUMENT')]) });
      expect(unknown.json).toMatchObject({ valid: false, findings: [{ code: 'LEGAL_DOCUMENT_UNKNOWN', path: 'steps[0].legal_basis[0].document', severity: 'ERROR' }] });
      const lapsed = await call('POST', '/project-workflow/templates/validate', { member: MANAGER, body: withBasis([cite('DECREE_24_2024_ND_CP')]) });
      expect(lapsed.json).toMatchObject({ valid: true, findings: [{ code: 'LEGAL_BASIS_LAPSED', path: 'steps[0].legal_basis[0].document', severity: 'WARNING', detail: 'DECREE_214_2025_ND_CP' }] });
      const pinned = { ...PROCESS, tasks: [{ ...PROCESS.tasks[0], form_templates: ['FORM_X'], form_policies: [{ form: 'FORM_X', policy: 'PINNED', revision: 3 }] }, ...PROCESS.tasks.slice(1)] };
      expect((await call('POST', '/project-workflow/templates/validate', { member: MANAGER, body: pinned })).json).toMatchObject({ valid: false, findings: [{ code: 'FORM_REVISION_UNKNOWN', path: 'tasks[0].form_policies[0].revision', severity: 'ERROR' }] });
      const noStep = { ...PROCESS, tasks: [{ ...PROCESS.tasks[0], step: null }, ...PROCESS.tasks.slice(1)] };
      expect((await call('POST', '/project-workflow/templates/validate', { member: MANAGER, body: noStep })).json).toMatchObject({ valid: false });
      // A warning never stops the preview of the schedule.
      expect((await call('POST', '/project-workflow/templates/preview', { member: MANAGER, body: { params: withBasis([cite('DECREE_24_2024_ND_CP')]), planned_start_date: START, facts: { project_group: 'B' } } })).status).toBe(200);
    });
  });
});

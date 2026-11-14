import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { ND30_A4_STANDARD, loadErrorRegistry, signTenantContext, validateRuleParams, vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { pwfModule } from '../../src/modules/pwf';
import { PwfDeadlineReadsController } from '../../src/modules/pwf/deadline.controller';
import { ProjectRescheduleController } from '../../src/modules/pwf/reschedule.controller';
import { ProjectTaskController, ProjectTaskReadsController } from '../../src/modules/pwf/task.controller';
import { ProjectWorkflowController, ProjectWorkflowReadsController } from '../../src/modules/pwf/workflow.controller';
import { ProjectController, ProjectReadsController } from '../../src/modules/prj/project.controller';
import { PlanPublishedConsumer } from '../../src/modules/prj/plan-published.consumer';
import { ProjectLifecycleReadsController, ProjectStageController } from '../../src/modules/prj/stage.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const YEAR = Number(TODAY.slice(0, 4));
const START = `${YEAR}-11-02`;
const MANAGER = 1; // every pwf permission and the stage commands over the tenant
const WORKER = 2; // pwf.read, pwf.task.work
const CHECKER = 3; // pwf.read, pwf.task.approve, pwf.schedule.approve
const READER = 4; // pwf.read only
const NOBODY = 5;
const B_MANAGER = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const WORKER_SYSTEM = '00000000-0000-4000-8000-000000000000';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const TEMPLATE = {
  name: 'API flow',
  project_type: null,
  phases: [
    { code: 'P1', name: 'Phase one', gates: ['completeProject'] },
    { code: 'P2', name: 'Phase two', gates: [] },
  ],
  tasks: [
    { code: 'TA', name: 'Task A', phase: 'P1', kind: 'TASK', duration_working_days: 3, required: true, responsible_role: 'WORKER_ROLE', approver_role: 'CHECKER_ROLE', priority: 'HIGH', predecessors: [], legal_doc_types: ['FEASIBILITY_REPORT'], form_templates: [], checklist: [], kpi_codes: [], when: [] },
    { code: 'MS_A', name: 'Milestone A', phase: 'P2', kind: 'MILESTONE', duration_working_days: 0, required: false, responsible_role: 'WORKER_ROLE', approver_role: null, priority: 'NORMAL', predecessors: [{ task: 'TA', kind: 'FS', lag_working_days: 0 }], legal_doc_types: [], form_templates: [], checklist: [], kpi_codes: [], when: [] },
  ],
};

describe('the workflow of a project over HTTP (PWF-1)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let areaVersion = '';
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function project(status = 'CONCEPT'): Promise<string> {
    counter += 1;
    const made = await call('POST', '/projects', { member: MANAGER, body: { code: `PWF-${counter}-${randomUUID().slice(0, 6)}`, name: 'Dự án cầu Thủ Thiêm 4', owner_unit_id: unitId(DEPARTMENT), area_master_version_id: areaVersion, total_investment_vnd: '500000000000' } });
    expect(made.status).toBe(200);
    const id = made.json.resource_id as string;
    await rows('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [id, status, 'B', String(9000000 + counter)]);
    return id;
  }

  const startFlow = (projectId: string, member = MANAGER, key?: string): Promise<Reply> =>
    call('POST', `/projects/${projectId}/workflow`, { member, body: { template_code: 'APIFLOW', planned_start_date: START, facts: { project_group: 'B' } }, ...(key === undefined ? {} : { key }) });
  const detail = (projectId: string, member = MANAGER, tenantId?: string): Promise<Reply> => call('GET', `/projects/${projectId}/workflow`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const taskOf = async (workflowId: string, code: string): Promise<{ id: string; version: number }> => {
    const [one] = await rows<{ id: string; version: number }>('select id, version from machvon.project_task where workflow_id = $1::uuid and task_code = $2', [workflowId, code]);
    return one as { id: string; version: number };
  };
  const paper = async (): Promise<string> => {
    const id = randomUUID();
    await rows(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'A paper', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`, [TENANT_A, id, `QD-${id.slice(0, 8)}/2026`, memberId(MANAGER)]);
    return id;
  };

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER_SYSTEM, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER_SYSTEM, TODAY));
    }
    for (const n of [MANAGER, WORKER, CHECKER, READER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MANAGER, ROOT);
    const all = ['project.create', 'project.read', 'pwf.template.manage', 'pwf.workflow.manage', 'pwf.workflow.adopt', 'pwf.read', 'pwf.task.work', 'pwf.task.approve', 'pwf.task.assign', 'pwf.schedule.propose', 'pwf.schedule.approve', 'project.stage.complete', 'project.stage.implement'];
    await harness.seedRole(TENANT_A, 1, 'PWF_MANAGER', all, 40);
    await harness.seedRole(TENANT_A, 2, 'PWF_WORKER', ['pwf.read', 'pwf.task.work'], 20);
    await harness.seedRole(TENANT_A, 3, 'PWF_CHECKER', ['pwf.read', 'pwf.task.approve', 'pwf.schedule.approve'], 20);
    await harness.seedRole(TENANT_A, 4, 'PWF_READER', ['pwf.read'], 10);
    await harness.seedRole(TENANT_B, 1, 'PWF_MANAGER', all, 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: WORKER, role: 2, kind: 'TENANT' },
      { n: 3, member: CHECKER, role: 3, kind: 'TENANT' },
      { n: 4, member: READER, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MANAGER, role: 1, kind: 'TENANT' }]);
    const recordId = randomUUID();
    areaVersion = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'TINH-P', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(MANAGER)]],
      [`insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, valid_until, status, master_record_id, published_at, created_by, updated_by) values ($1, $2, 'AREA', 'TINH-P', 1, 'TINH-P', '{}'::jsonb, '2020-01-01', null, 'EFFECTIVE', $3, now(), $4, $4)`, [TENANT_A, areaVersion, recordId, memberId(MANAGER)]],
    ]);
    await harness.owner(
      TENANT_A,
      [YEAR - 1, YEAR, YEAR + 1, YEAR + 2].map((year): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
        [TENANT_A, year, memberId(MANAGER)],
      ]),
    );
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
         values ($1, 'PROJECT_WORKFLOW_TEMPLATE', 'APIFLOW', 1, 'APPROVED', $2::jsonb, date '2020-01-01', 'A template for the tests', $3, $4, now(), $5, now())`,
        [TENANT_A, JSON.stringify(TEMPLATE), memberId(MANAGER), memberId(WORKER), memberId(CHECKER)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ProjectController, ProjectReadsController, ProjectStageController, ProjectLifecycleReadsController, ProjectWorkflowController, ProjectWorkflowReadsController, ProjectTaskController, ProjectTaskReadsController, ProjectRescheduleController, PwfDeadlineReadsController],
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

  it('is registered in the module of PWF', () => {
    expect(pwfModule.controllers).toEqual(expect.arrayContaining([ProjectWorkflowController, ProjectWorkflowReadsController, ProjectTaskController, ProjectTaskReadsController, ProjectRescheduleController, PwfDeadlineReadsController]));
  });

  describe('the templates', () => {
    it('validates a template with its findings and quality flags, and refuses a loop with the field', async () => {
      const ok = await call('POST', '/project-workflow/templates/validate', { member: MANAGER, body: TEMPLATE });
      expect(ok).toMatchObject({ status: 200, json: { valid: true, task_count: 2, phase_count: 2, longest_chain: 2 } });
      const loop = { ...TEMPLATE, tasks: [{ ...TEMPLATE.tasks[0], predecessors: [{ task: 'MS_A', kind: 'FS', lag_working_days: 0 }] }, TEMPLATE.tasks[1]] };
      const bad = await call('POST', '/project-workflow/templates/validate', { member: MANAGER, body: loop });
      expect(bad.json.valid).toBe(false);
      expect((bad.json.findings as Array<{ code: string }>)[0]?.code).toBe('PWF_DEPENDENCY_CYCLE');
    });

    it('previews the schedule of a template from a start day, with the tasks, the critical path and the calendar versions', async () => {
      const preview = await call('POST', '/project-workflow/templates/preview', { member: MANAGER, body: { params: TEMPLATE, planned_start_date: START } });
      expect(preview.status).toBe(200);
      expect((preview.json.tasks as Array<{ task_code: string; start: string }>).find((one) => one.task_code === 'TA')?.start).toBe(START);
      expect(preview.json.critical_path).toContain('TA');
      expect((preview.json.calendar_versions as unknown[]).length).toBeGreaterThan(0);
    });

    it('A2: previews a template as the store keeps it, where a task without an approver has no approver_role at all (the template in force a screen sends back)', async () => {
      const stored = { ...TEMPLATE, tasks: TEMPLATE.tasks.map(({ approver_role: approver, ...task }) => (approver === null ? task : { ...task, approver_role: approver })) };
      expect(stored.tasks[1]).not.toHaveProperty('approver_role');
      const preview = await call('POST', '/project-workflow/templates/preview', { member: MANAGER, body: { params: stored, planned_start_date: START } });
      expect(preview.status).toBe(200);
      expect((preview.json.tasks as unknown[]).length).toBe(2);
      expect((await call('POST', '/project-workflow/templates/validate', { member: MANAGER, body: stored })).json).toMatchObject({ valid: true });
    });

    it('A4: a task names its forms by the code of the document store (hyphens); a code the store does not have is a warning that never blocks', async () => {
      const layout = randomUUID();
      await rows(
        `insert into machvon.document_layout_profile (tenant_id, id, profile_code, revision, margins_mm, element_styles, signature_layout, number_field_layout, watermark_policy, legal_basis, effective_from, status, created_by, updated_by)
         values ($1, $2, 'PWF5', 1, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, '{}'::jsonb, 'A basis', '2020-01-01', 'PUBLISHED', $3, $3)`,
        [TENANT_A, layout, memberId(MANAGER), JSON.stringify(ND30_A4_STANDARD.marginsMm), JSON.stringify(ND30_A4_STANDARD.elementStyles), JSON.stringify(ND30_A4_STANDARD.signatureLayout), JSON.stringify(ND30_A4_STANDARD.numberFieldLayout)],
      );
      await rows(
        `insert into machvon.document_template (tenant_id, id, template_code, revision, group_code, doc_type_code, title, layout_profile_id, body_blocks, placeholder_schema, legal_basis, watermark_text, content_sha256, effective_from, status, created_by, updated_by)
         values ($1, gen_random_uuid(), 'DOC-QD-PHE-DUYET-DU-AN', 1, 'DECISION', 'QD', 'Quyết định phê duyệt dự án', $2, '[]'::jsonb, '{}'::jsonb, 'A basis', 'UNCONFIRMED', repeat('a', 64), date '2020-01-01', 'PUBLISHED', $3, $3)`,
        [TENANT_A, layout, memberId(MANAGER)],
      );
      const withForms = (forms: string[]): typeof TEMPLATE => ({ ...TEMPLATE, tasks: [{ ...TEMPLATE.tasks[0]!, form_templates: forms }, TEMPLATE.tasks[1]!] }) as typeof TEMPLATE;
      const known = await call('POST', '/project-workflow/templates/validate', { member: MANAGER, body: withForms(['DOC-QD-PHE-DUYET-DU-AN']) });
      expect(known.json).toMatchObject({ valid: true, findings: [] });
      const unknown = await call('POST', '/project-workflow/templates/validate', { member: MANAGER, body: withForms(['DOC-QD-PHE-DUYET-DU-AN', 'DOC-KHONG-CO']) });
      expect(unknown.json.valid).toBe(true);
      expect(unknown.json.findings).toEqual([{ code: 'FORM_TEMPLATE_UNKNOWN', path: 'tasks[0].form_templates[1]', severity: 'WARNING', detail: 'DOC-KHONG-CO' }]);
      // What is not a code of the document store is refused by the contract before anything is read.
      expect((await call('POST', '/project-workflow/templates/validate', { member: MANAGER, body: withForms(['doc qd']) })).status).toBe(422);
      expect((await call('POST', '/project-workflow/templates/preview', { member: MANAGER, body: { params: withForms(['DOC-QD-PHE-DUYET-DU-AN']), planned_start_date: START } })).status).toBe(200);
    });

    it('keeps the template commands for pwf.template.manage', async () => {
      expect((await call('POST', '/project-workflow/templates/validate', { member: READER, body: TEMPLATE })).status).toBe(403);
    });
  });

  describe('startProjectWorkflow, the reads and the permissions', () => {
    it('UAT-PWF-IDM-01: starts the workflow once per key, audits it, announces it, shows it to a reader and refuses a second one', async () => {
      const id = await project();
      const first = await startFlow(id, MANAGER, 'start-workflow-once-for-this-key');
      expect(first).toMatchObject({ status: 200, json: { status: 'ACTIVE', resource_version: 2 } });
      expect(await startFlow(id, MANAGER, 'start-workflow-once-for-this-key')).toEqual(first);
      const workflowId = first.json.resource_id as string;
      expect((await rows('select 1 from machvon.audit_event where resource_id = $1 and action = $2', [workflowId, 'workflow.started'])).length).toBe(1);
      const [event] = await rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [workflowId, 'pwf.workflow.started.v1']);
      expect(event?.payload).toMatchObject({ project_id: id, template_code: 'APIFLOW' });
      const seen = await detail(id, READER);
      expect(seen).toMatchObject({ status: 200, json: { template_code: 'APIFLOW', status: 'ACTIVE', can_manage: false, open_phase: 'P1' } });
      expect((seen.json.tasks as unknown[]).length).toBe(2);
      expect((await startFlow(id)).json.code).toBe('PWF_WORKFLOW_EXISTS');
      expect((await startFlow(await project(), READER)).status).toBe(403);
      const tasks = await call('GET', `/projects/${id}/workflow/tasks?limit=1`, { member: READER });
      expect(tasks.json).toMatchObject({ total: 2 });
      expect((tasks.json.items as unknown[]).length).toBe(1);
      expect(typeof tasks.json.next_cursor).toBe('string');
      const schedule = await call('GET', `/projects/${id}/workflow/schedule`, { member: READER });
      expect(schedule.json).toMatchObject({ schedule_version: 1, workflow_id: workflowId });
    });

    it('UAT-PWF-SEC-01: does not show the workflow to a caller without pwf.read, nor to another tenant (404)', async () => {
      const id = await project();
      await startFlow(id);
      expect((await detail(id, NOBODY)).status).toBe(403);
      expect((await detail(id, B_MANAGER, TENANT_B)).status).toBe(404);
    });
  });

  describe('adoptProjectWorkflow (F3, R36)', () => {
    const adopt = (projectId: string, body: Record<string, unknown>, member = MANAGER): Promise<Reply> =>
      call('POST', `/projects/${projectId}/workflow/adopt`, { member, body: { template_code: 'APIFLOW', planned_start_date: START, effective_date: START, facts: { project_group: 'B' }, ...body } });

    it('A1: a dry run answers the plan, writes no workflow and leaves an audit row of the preview; applying it then makes the workflow', async () => {
      const id = await project('IMPLEMENTATION');
      const tried = await adopt(id, { dry_run: true });
      expect(tried).toMatchObject({ status: 200, json: { dry_run: true, applied: false, workflow_id: null, template_code: 'APIFLOW', effective_date: START } });
      expect((tried.json.tasks as unknown[]).length).toBe(2);
      expect((await rows('select 1 from machvon.project_workflow where project_id = $1::uuid', [id])).length).toBe(0);
      const previews = await rows<{ diff: Record<string, unknown> }>('select safe_diff as diff from machvon.audit_event where resource_id = $1 and action = $2', [id, 'workflow.adoption_previewed']);
      expect(previews.length).toBe(1);
      expect(previews[0]?.diff).toMatchObject({ template_code: 'APIFLOW', effective_date: START, task_count: 2 });
      expect((await rows('select 1 from machvon.outbox_event where type = $1 and payload ->> $2 = $3', ['pwf.workflow.adopted.v1', 'project_id', id])).length).toBe(0);

      const applied = await adopt(id, { dry_run: false });
      expect(applied).toMatchObject({ status: 200, json: { dry_run: false, applied: true, template_code: 'APIFLOW' } });
      const workflowId = applied.json.workflow_id as string;
      expect((await rows('select 1 from machvon.audit_event where resource_id = $1 and action = $2', [workflowId, 'workflow.adopted'])).length).toBe(1);
      expect((await detail(id)).json).toMatchObject({ status: 'ACTIVE', template_code: 'APIFLOW' });
    });

    it('A1: a dry run names the past tasks that need a decision, and applying without deciding them is refused', async () => {
      const id = await project('IMPLEMENTATION');
      const late = `${YEAR}-12-21`;
      const tried = await adopt(id, { dry_run: true, effective_date: late });
      expect(tried.status).toBe(200);
      expect((tried.json.findings as Array<{ code: string; task: string }>).some((one) => one.code === 'PAST_TASK_UNDECIDED' && one.task === 'TA')).toBe(true);
      expect((await adopt(id, { dry_run: false, effective_date: late })).json.code).toBe('PWF_ADOPT_INVALID');
    });

    it('A1: a dry run is for who may adopt: a reader is refused', async () => {
      const id = await project('IMPLEMENTATION');
      expect((await adopt(id, { dry_run: true }, READER)).status).toBe(403);
    });
  });

  describe('the work on a task, and the gate on the stage commands (R29)', () => {
    it('UAT-PWF-CON-02: lets two people start the workflow of one project at once: one workflow, the other gets PWF_WORKFLOW_EXISTS', async () => {
      const id = await project();
      const results = await Promise.all([startFlow(id), startFlow(id)]);
      expect(results.map((one) => one.status).sort()).toEqual([200, 409]);
      expect(results.find((one) => one.status === 409)?.json.code).toBe('PWF_WORKFLOW_EXISTS');
      expect((await rows('select 1 from machvon.project_workflow where project_id = $1::uuid', [id])).length).toBe(1);
    });

    it('UAT-PWF-CON-04: blocks a completion without a legal document with the blockers, refuses the maker as approver, and opens the gate of completeProject only when A is done', async () => {
      const id = await project('IMPLEMENTATION');
      const workflowId = (await startFlow(id)).json.resource_id as string;
      const a = await taskOf(workflowId, 'TA');
      expect((await call('POST', `/project-tasks/${a.id}/start`, { member: WORKER, ifMatch: `"${a.version}"` })).json.code).toBe('SCOPE_DENIED');
      const assigned = await call('POST', `/project-tasks/${a.id}/assignments`, { member: MANAGER, body: { membership_id: memberId(WORKER), role: 'RESPONSIBLE', valid_from: '2020-01-01', share_pct: 100, reason: 'Assigned for the test' } });
      expect(assigned.status).toBe(200);
      const started = await call('POST', `/project-tasks/${a.id}/start`, { member: WORKER, ifMatch: `"${a.version}"` });
      expect(started).toMatchObject({ status: 200, json: { status: 'IN_PROGRESS' } });
      const version = started.json.resource_version as number;
      const blocked = await call('POST', `/project-tasks/${a.id}/complete`, { member: WORKER, ifMatch: `"${version}"` });
      expect(blocked).toMatchObject({ status: 422, json: { code: 'PWF_TASK_COMPLETION_BLOCKED' } });
      expect(JSON.stringify(blocked.json)).toContain('LEGAL_DOC_MISSING');
      expect((await call('POST', `/project-tasks/${a.id}/complete`, { member: WORKER, ifMatch: `"${version + 5}"` })).json.code).toBe('VERSION_CONFLICT');
      const evidence = await call('POST', `/project-tasks/${a.id}/evidence`, { member: WORKER, body: { evidence_kind: 'DOCUMENT', document_id: await paper(), legal_doc_type: 'FEASIBILITY_REPORT' } });
      expect(evidence.status).toBe(200);
      const requested = await call('POST', `/project-tasks/${a.id}/complete`, { member: WORKER, ifMatch: `"${version}"` });
      expect(requested).toMatchObject({ status: 200, json: { status: 'AWAITING_APPROVAL' } });
      const waiting = requested.json.resource_version as number;
      expect((await call('POST', `/project-tasks/${a.id}/approve-completion`, { member: WORKER, ifMatch: `"${waiting}"`, body: { decision: 'APPROVE' } })).status).toBe(403);
      // The stage command is kept closed by the gate while A is not done, in the same transaction as the command.
      const complete = (ifMatch: string) => call('POST', `/projects/${id}/completion`, { member: MANAGER, ifMatch, body: { reason: 'The works are finished', decision_document_id: undefined } });
      const closed = await complete('"1"');
      expect(closed.status).toBe(422);
      const approved = await call('POST', `/project-tasks/${a.id}/approve-completion`, { member: CHECKER, ifMatch: `"${waiting}"`, body: { decision: 'APPROVE' } });
      expect(approved).toMatchObject({ status: 200, json: { status: 'DONE' } });
      const gate = await call('GET', `/projects/${id}/workflow/gates/completeProject`, { member: READER });
      expect(gate.json).toMatchObject({ target: 'completeProject', gated: true, open: true, missing: [] });
      const events = await rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by type', [a.id]);
      expect(events.map((one) => one.type)).toEqual(expect.arrayContaining(['pwf.task.started.v1', 'pwf.task.completed.v1', 'pwf.task.approved.v1']));
    });

    it('keeps a stage command closed with 422 PWF_GATE_CLOSED and the missing tasks while a required task of the phase is open', async () => {
      const id = await project('IMPLEMENTATION');
      await startFlow(id);
      const closed = await call('POST', `/projects/${id}/completion`, { member: MANAGER, ifMatch: '"1"', body: { reason: 'The works are finished' } });
      // The command guards (the decision document) come first; the gate answers once they hold.
      expect([422]).toContain(closed.status);
      const withDocument = await call('POST', `/projects/${id}/completion`, { member: MANAGER, ifMatch: '"1"', body: { reason: 'The works are finished', decision_document_id: await paper() } });
      expect(withDocument).toMatchObject({ status: 422, json: { code: 'PWF_GATE_CLOSED' } });
      expect(JSON.stringify(withDocument.json)).toContain('TA');
      expect((await rows<{ status: string }>('select status from machvon.project where id = $1::uuid', [id]))[0]?.status).toBe('IMPLEMENTATION');
    });
  });

  describe('B15: how a gate stands for the reader', () => {
    it('says NOT_DUE for the closed gate of a phase the project has not reached, CLOSED for the gate of the phase it is in, and keeps refusing the command either way', async () => {
      const staged = {
        ...TEMPLATE,
        name: 'Gate flow',
        phases: [
          { code: 'P1', name: 'Phase one', gates: ['startProjectImplementation'] },
          { code: 'P2', name: 'Phase two', gates: ['closeProject'] },
        ],
        tasks: [
          { ...TEMPLATE.tasks[0]!, approver_role: null, legal_doc_types: [] },
          { ...TEMPLATE.tasks[0]!, code: 'TB', name: 'Task B', phase: 'P2', approver_role: null, legal_doc_types: [], predecessors: [{ task: 'TA', kind: 'FS', lag_working_days: 0 }] },
        ],
      };
      await harness.owner(TENANT_A, [
        [
          `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
           values ($1, 'PROJECT_WORKFLOW_TEMPLATE', 'GATEFLOW', 1, 'APPROVED', $2::jsonb, date '2020-01-01', 'A template for the gates', $3, $4, now(), $5, now())`,
          [TENANT_A, JSON.stringify(staged), memberId(MANAGER), memberId(WORKER), memberId(CHECKER)],
        ],
      ]);
      const id = await project();
      const started = await call('POST', `/projects/${id}/workflow`, { member: MANAGER, body: { template_code: 'GATEFLOW', planned_start_date: START, facts: { project_group: 'B' }, selection_reason: 'The gates of this project are the ones of GATEFLOW' } });
      expect(started.status).toBe(200);
      const seen = await detail(id, READER);
      expect(seen.json.gates).toEqual([
        { target: 'startProjectImplementation', open: false, missing_count: 1, standing: 'CLOSED', phases: ['P1'] },
        { target: 'closeProject', open: false, missing_count: 1, standing: 'NOT_DUE', phases: ['P2'] },
      ]);
      const ahead = await call('GET', `/projects/${id}/workflow/gates/closeProject`, { member: READER });
      expect(ahead.json).toMatchObject({ target: 'closeProject', gated: true, open: false, standing: 'NOT_DUE', phases: ['P2'] });
      expect((ahead.json.missing as unknown[]).length).toBe(1);
      expect((await call('GET', `/projects/${id}/workflow/gates/startProjectImplementation`, { member: READER })).json).toMatchObject({ open: false, standing: 'CLOSED', phases: ['P1'] });
      expect((await call('GET', `/projects/${id}/workflow/gates/suspendProject`, { member: READER })).json).toMatchObject({ gated: false, open: true, standing: 'UNGATED', phases: [] });
    });
  });

  describe('moving the schedule over HTTP, and the board', () => {
    it('proposes, previews and is decided by another person with the version of the workflow; the second decision is a conflict', async () => {
      const id = await project();
      const started = await startFlow(id);
      const proposed = await call('POST', `/projects/${id}/workflow/reschedules`, { member: MANAGER, ifMatch: `"${started.json.resource_version}"`, body: { planned_start_date: `${YEAR}-11-16`, reason: 'The start of the project is moved by two weeks' } });
      expect(proposed).toMatchObject({ status: 200, json: { status: 'PROPOSED', base_version: started.json.resource_version } });
      const proposalId = proposed.json.proposal_id as string;
      // A6: the workflow names the one proposal that waits, so the screen of the decision opens it by itself.
      expect((await detail(id, CHECKER)).json.pending_reschedule).toMatchObject({ proposal_id: proposalId, base_version: started.json.resource_version, proposed_by: memberId(MANAGER) });
      // The second person reads the stored proposal before deciding it; a caller without pwf.read and another tenant do not.
      const stored = await call('GET', `/project-reschedules/${proposalId}`, { member: CHECKER });
      expect(stored).toMatchObject({ status: 200, json: { proposal_id: proposalId, status: 'PROPOSED', base_version: started.json.resource_version } });
      expect((stored.json.changes as unknown[]).length).toBeGreaterThan(0);
      expect((await call('GET', `/project-reschedules/${proposalId}`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/project-reschedules/${proposalId}`, { member: B_MANAGER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('POST', `/project-reschedules/${proposalId}/decide`, { member: MANAGER, ifMatch: `"${started.json.resource_version}"`, body: { decision: 'APPROVE' } })).status).toBe(403);
      const decided = await call('POST', `/project-reschedules/${proposalId}/decide`, { member: CHECKER, ifMatch: `"${started.json.resource_version}"`, body: { decision: 'APPROVE' } });
      expect(decided).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
      expect((await call('POST', `/project-reschedules/${proposalId}/decide`, { member: CHECKER, ifMatch: `"${started.json.resource_version}"`, body: { decision: 'APPROVE' } })).json.code).toBe('PWF_SCHEDULE_VERSION_CONFLICT');
      expect((await detail(id)).json).toMatchObject({ schedule_version: 2, pending_reschedule: null });
    });

    it('UAT-PWF-BRD-01: shows the portfolio board with exact totals by official colour, the month calendar, the next milestones and the load by person', async () => {
      const board = await call('GET', '/pwf/deadlines?limit=1', { member: READER });
      expect(board.status).toBe(200);
      expect(board.json).toMatchObject({ official_only: true, shown: 1 });
      expect(board.json.total as number).toBeGreaterThan(1);
      expect(board.json.truncated).toBe(true);
      const counts = board.json.counts_by_band as Record<string, number>;
      expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(board.json.total);
      expect((await call('GET', '/pwf/deadlines?band=NOT_A_BAND', { member: READER })).status).toBe(422);
      expect((await call('GET', `/pwf/deadlines/calendar?month=${START.slice(0, 7)}`, { member: READER })).json).toHaveProperty('days');
      expect((await call('GET', '/pwf/milestones/upcoming?days=400', { member: READER })).status).toBe(422);
      expect((await call('GET', '/pwf/milestones/upcoming?days=60', { member: READER })).status).toBe(200);
      expect((await call('GET', '/pwf/workload?weeks=4', { member: READER })).json).toMatchObject({ display_only: true });
    });
  });

  // The cases of docs/uat/pwf/uat.json that had no script: each test carries the id of its case and asserts what the case expects (the values come from the case, not from the code).
  describe('the UAT cases of PWF measured over HTTP (docs/uat/pwf/uat.json)', () => {
    type Task = Record<string, unknown>;
    const task = (code: string, extra: Record<string, unknown> = {}): Task => ({ code, name: `Việc ${code}`, phase: 'P1', kind: 'TASK', duration_working_days: 3, required: true, responsible_role: 'WORKER_ROLE', approver_role: null, priority: 'NORMAL', predecessors: [], legal_doc_types: [], form_templates: [], checklist: [], kpi_codes: [], when: [], ...extra });
    const after = (code: string, lag = 0): Array<Record<string, unknown>> => [{ task: code, kind: 'FS', lag_working_days: lag }];
    const template = (name: string, tasks: Task[], phases: Array<Record<string, unknown>> = [{ code: 'P1', name: 'Giai đoạn một', gates: [] }]): Record<string, unknown> => ({ name, project_type: null, phases, tasks });
    const seedTemplate = async (code: string, params: Record<string, unknown>, version = 1, from = '2020-01-01'): Promise<void> => {
      await harness.owner(TENANT_A, [
        [
          `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
           values ($1, 'PROJECT_WORKFLOW_TEMPLATE', $2, $3, 'APPROVED', $4::jsonb, $5::date, 'A template of the UAT cases', $6, $7, now(), $8, now())`,
          [TENANT_A, code, version, JSON.stringify(params), from, memberId(MANAGER), memberId(WORKER), memberId(CHECKER)],
        ],
      ]);
    };
    const begin = (projectId: string, code: string, start = START): Promise<Reply> =>
      call('POST', `/projects/${projectId}/workflow`, { member: MANAGER, body: { template_code: code, planned_start_date: start, facts: { project_group: 'B' }, selection_reason: 'Mẫu của ca nghiệm thu được chọn cho dự án này' } });
    const assign = (taskId: string, member: number, share = 100, range: { from?: string; to?: string | null } = {}): Promise<Reply> =>
      call('POST', `/project-tasks/${taskId}/assignments`, { member: MANAGER, body: { membership_id: memberId(member), role: 'RESPONSIBLE', valid_from: range.from ?? '2020-01-01', ...(range.to === undefined ? {} : { valid_to: range.to }), share_pct: share, reason: 'Phân công cho ca nghiệm thu' } });
    const versionOf = async (taskId: string): Promise<number> => (await rows<{ version: number }>('select version from machvon.project_task where id = $1::uuid', [taskId]))[0]!.version;
    const statusOf = async (taskId: string): Promise<string> => (await rows<{ status: string }>('select status from machvon.project_task where id = $1::uuid', [taskId]))[0]!.status;
    const returnsOf = async (taskId: string): Promise<number> => (await rows<{ n: number }>('select return_count as n from machvon.project_task where id = $1::uuid', [taskId]))[0]!.n;
    const act = async (taskId: string, verb: string, member: number, body: Record<string, unknown> = {}): Promise<Reply> => call('POST', `/project-tasks/${taskId}/${verb}`, { member, ifMatch: `"${await versionOf(taskId)}"`, body });
    const tasksOf = async (projectId: string): Promise<Array<Record<string, unknown>>> => (await detail(projectId)).json.tasks as Array<Record<string, unknown>>;
    const byCode = (list: Array<Record<string, unknown>>, code: string): Record<string, unknown> => list.find((one) => one.task_code === code) as Record<string, unknown>;
    /** Decides an exception under its own version (the command is versioned). */
    const decide = async (exceptionId: string, member: number): Promise<Reply> => {
      const [stored] = await rows<{ version: number }>('select version from machvon.project_task_exception where id = $1::uuid', [exceptionId]);
      return call('POST', `/project-task-exceptions/${exceptionId}/decide`, { member, ifMatch: `"${stored?.version}"`, body: { decision: 'APPROVE' } });
    };
    /** Brings the task `taskCode` of a workflow to DONE by the worker (a task without approver ends at its completion). */
    const done = async (workflowId: string, taskCode: string): Promise<string> => {
      const one = await taskOf(workflowId, taskCode);
      expect((await assign(one.id, WORKER)).status).toBe(200);
      expect((await act(one.id, 'start', WORKER)).status).toBe(200);
      expect(await act(one.id, 'complete', WORKER)).toMatchObject({ status: 200, json: { status: 'DONE' } });
      return one.id;
    };
    /** The paper and the checklist item the task TA of UATFIVE asks for. */
    const papers = async (taskId: string): Promise<void> => {
      expect((await call('POST', `/project-tasks/${taskId}/evidence`, { member: WORKER, body: { evidence_kind: 'DOCUMENT', document_id: await paper(), legal_doc_type: 'FEASIBILITY_REPORT' } })).status).toBe(200);
      const note = await call('POST', `/project-tasks/${taskId}/evidence`, { member: WORKER, body: { evidence_kind: 'DOCUMENT', item_code: 'KS_HIEN_TRUONG', document_id: await paper(), note: 'Biên bản khảo sát hiện trường ngày 03/11' } });
      expect(note.status).toBe(200);
      const ticked = await act(taskId, 'checklist/KS_HIEN_TRUONG/complete', WORKER, {});
      expect(ticked.status).toBe(200);
    };

    beforeAll(async () => {
      // A (3 days) then B (5 days) and C (2 days) side by side, the milestone M after them; X belongs to the branch of group A only.
      await seedTemplate(
        'UATHAND',
        template('Bảng tay', [
          task('TA'),
          task('TB', { duration_working_days: 5, predecessors: after('TA') }),
          task('TC', { duration_working_days: 2, predecessors: after('TA') }),
          task('TX', { duration_working_days: 4, predecessors: after('TA'), when: [{ field: 'project_group', in: ['A'] }] }),
          task('TM', { kind: 'MILESTONE', duration_working_days: 0, predecessors: [...after('TB'), ...after('TC'), ...after('TX')] }),
        ]),
      );
      await seedTemplate('UATPAIR', template('Hai việc', [task('TA'), task('TB', { duration_working_days: 5, predecessors: after('TA', 2) })]));
      await seedTemplate('UATGATE', template('Cổng', [task('TA'), task('TB')], [{ code: 'P1', name: 'Giai đoạn một', gates: ['capital.plan_published.v1', 'startProjectImplementation'] }]));
      await seedTemplate('UATFIVE', template('Hồ sơ', [task('TA', { approver_role: 'CHECKER_ROLE', legal_doc_types: ['FEASIBILITY_REPORT'], checklist: [{ code: 'KS_HIEN_TRUONG', name: 'Khảo sát hiện trường', required: true, evidence_kinds: ['DOCUMENT'] }] })]));
      await seedTemplate('UATMILE', template('Mốc đầu', [task('TA'), task('M0', { kind: 'MILESTONE', duration_working_days: 0, required: false })]));
      await seedTemplate('UATLOAD', template('Tải', [task('TA', { duration_working_days: 5 }), task('TB', { duration_working_days: 4 })]));
    });

    it('UAT-PWF-01: a template with a loop A -> B -> A is refused at the predecessors of the task; without the loop it has no finding and previews a day for every task; a project keeps the hash of the version it started on', async () => {
      const pair = template('Mẫu soạn', [task('TA'), task('TB', { predecessors: after('TA') })]);
      const loop = template('Mẫu soạn', [task('TA', { predecessors: after('TB') }), task('TB', { predecessors: after('TA') })]);
      const refused = await call('POST', '/project-workflow/templates/validate', { member: MANAGER, body: loop });
      expect(refused.json.valid).toBe(false);
      const findings = refused.json.findings as Array<{ code: string; path: string; severity: string; detail: string }>;
      expect(findings.filter((one) => one.severity === 'ERROR').map((one) => one.code)).toEqual(['PWF_DEPENDENCY_CYCLE']);
      // Saving the same params as a rule is refused by the check of the rule, naming the same field.
      expect(() => validateRuleParams('PROJECT_WORKFLOW_TEMPLATE', loop)).toThrow(expect.objectContaining({ code: 'GOVERNANCE_RULE_PARAMS_INVALID', detail: expect.stringMatching(/^tasks\[[01]\]\.predecessors$/) }));
      // The preview of a template with the loop answers the code of the loop itself.
      expect(await call('POST', '/project-workflow/templates/preview', { member: MANAGER, body: { params: loop, planned_start_date: '2026-11-02' } })).toMatchObject({ status: 422, json: { code: 'PWF_DEPENDENCY_CYCLE' } });
      // The refusal names the field that closes the loop: the predecessors of a task of the loop.
      expect(findings.filter((one) => one.severity === 'ERROR').map((one) => one.path)).toEqual([expect.stringMatching(/^tasks\[[01]\]\.predecessors/)]);
      const ok = await call('POST', '/project-workflow/templates/validate', { member: MANAGER, body: pair });
      expect(ok.json).toMatchObject({ valid: true, findings: [] });
      expect(Array.isArray(ok.json.quality_flags)).toBe(true);
      const preview = await call('POST', '/project-workflow/templates/preview', { member: MANAGER, body: { params: pair, planned_start_date: '2026-11-02' } });
      expect(preview.status).toBe(200);
      const previewed = preview.json.tasks as Array<{ task_code: string; start: string | null; finish: string | null }>;
      expect(previewed.map((one) => one.task_code).sort()).toEqual(['TA', 'TB']);
      for (const one of previewed) expect([one.start, one.finish].every((day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day)))).toBe(true);
      // A project that runs keeps the frozen template: a second approved version of the rule changes neither its version nor its hash.
      await seedTemplate('UATFROZEN', pair);
      const id = await project();
      expect((await begin(id, 'UATFROZEN')).status).toBe(200);
      const before = (await detail(id)).json;
      expect(before.template_hash).toMatch(/^[0-9a-f]{64}$/);
      await rows("update machvon.governance_rule set effective_to = date '2026-12-01' where rule_type = 'PROJECT_WORKFLOW_TEMPLATE' and code = 'UATFROZEN' and version = 1");
      await seedTemplate('UATFROZEN', template('Mẫu soạn bản hai', [task('TA'), task('TB', { duration_working_days: 9, predecessors: after('TA') })]), 2, '2026-12-01');
      expect((await detail(id)).json).toMatchObject({ template_rule_version: 1, template_hash: before.template_hash });
    });

    it('UAT-PWF-02: starting from 2026-11-02 gives each task the start, the due day and the float of the hand table, keeps the branch that does not apply as EXCLUDED, and writes schedule version 1 with its baseline and the hash of the frozen template', async () => {
      const id = await project();
      const started = await begin(id, 'UATHAND', '2026-11-02');
      expect(started.status).toBe(200);
      const workflowId = started.json.resource_id as string;
      const tasks = await tasksOf(id);
      // By hand on a Monday-to-Friday calendar: A 02..04 Nov, B 05..11 Nov, C 05..06 Nov (3 working days of float), the milestone when B ends.
      expect(byCode(tasks, 'TA')).toMatchObject({ planned_start: '2026-11-02', planned_finish: '2026-11-04', total_float: 0, critical: true });
      expect(byCode(tasks, 'TB')).toMatchObject({ planned_start: '2026-11-05', planned_finish: '2026-11-11', total_float: 0, critical: true });
      expect(byCode(tasks, 'TC')).toMatchObject({ planned_start: '2026-11-05', planned_finish: '2026-11-06', total_float: 3, critical: false });
      expect(byCode(tasks, 'TX')).toMatchObject({ excluded: true });
      const schedule = (await call('GET', `/projects/${id}/workflow/schedule`, { member: READER })).json;
      expect(schedule).toMatchObject({ schedule_version: 1, project_start: '2026-11-02', project_finish: '2026-11-11' });
      expect(schedule.excluded_tasks).toEqual(['TX']);
      // The longest chain is the critical one: A, B and the milestone after it; C has float and is not on it.
      const critical = schedule.critical_path as string[];
      expect(critical.filter((code) => ['TA', 'TB', 'TM'].includes(code))).toEqual(['TA', 'TB', 'TM']);
      expect(critical).not.toContain('TC');
      for (const one of tasks.filter((entry) => entry.excluded !== true)) expect(one.baseline_finish).toBe(one.planned_finish);
      expect((await detail(id)).json.template_hash).toMatch(/^[0-9a-f]{64}$/);
      expect((await rows<{ version: number }>('select version from machvon.project_schedule_version where workflow_id = $1::uuid', [workflowId])).map((one) => one.version)).toEqual([1]);
    });

    it('UAT-PWF-05: a completion without the legal paper and the checklist item is blocked with each blocker; with both it waits for approval; a return counts and needs a reason; another person approves and the maker never does', async () => {
      const id = await project();
      const five = await begin(id, 'UATFIVE');

      expect(five).toMatchObject({ status: 200 });
      const workflowId = five.json.resource_id as string;
      const a = await taskOf(workflowId, 'TA');
      expect((await assign(a.id, WORKER)).status).toBe(200);
      expect((await act(a.id, 'start', WORKER)).json.status).toBe('IN_PROGRESS');
      const blocked = await act(a.id, 'complete', WORKER);
      expect(blocked).toMatchObject({ status: 422, json: { code: 'PWF_TASK_COMPLETION_BLOCKED' } });
      const blockers = JSON.stringify(blocked.json);
      for (const named of ['LEGAL_DOC_MISSING', 'FEASIBILITY_REPORT', 'CHECKLIST_ITEM_OPEN', 'KS_HIEN_TRUONG']) expect(blockers).toContain(named);
      await papers(a.id);
      expect((await act(a.id, 'complete', WORKER)).json).toMatchObject({ status: 'AWAITING_APPROVAL' });
      // A return needs its reason, and counts.
      const unreasoned = await act(a.id, 'return', CHECKER, {});
      expect([400, 422]).toContain(unreasoned.status);
      expect(JSON.stringify(unreasoned.json)).toContain('reason');
      expect(await returnsOf(a.id)).toBe(0);
      expect((await act(a.id, 'return', CHECKER, { reason: 'Thiếu chữ ký của tư vấn nhé' })).status).toBe(200);
      expect(await returnsOf(a.id)).toBe(1);
      expect((await act(a.id, 'complete', WORKER)).json).toMatchObject({ status: 'AWAITING_APPROVAL' });
      // The maker never approves their own completion, whatever permission they hold: the worker has none, the manager has it and made the task.
      expect((await act(a.id, 'approve-completion', WORKER, { decision: 'APPROVE' })).status).toBe(403);
      expect(await statusOf(a.id)).toBe('AWAITING_APPROVAL');
      expect(await act(a.id, 'approve-completion', CHECKER, { decision: 'APPROVE' })).toMatchObject({ status: 200, json: { status: 'DONE' } });
      const seen = (await call('GET', `/project-tasks/${a.id}`, { member: READER })).json;
      expect(seen).toMatchObject({ status: 'DONE', return_count: 1 });
      // A task that is done has no colour any more: its alert is closed.
      expect((seen.band as { band: string }).band).toBe('NONE');
    });

    it('UAT-PWF-06: startProjectImplementation on a project whose workflow gates it is 422 PWF_GATE_CLOSED with the two missing tasks and the legal state stays; the event capital.plan_published.v1 moves nothing and leaves pwf.gate.refused.v1; once both tasks are done the command succeeds; a project without a workflow is never gated', async () => {
      const id = await project('BUDGETED');
      const workflowId = (await begin(id, 'UATGATE')).json.resource_id as string;
      const preview = (await call('GET', `/projects/${id}/workflow/gates/startProjectImplementation`, { member: READER })).json;
      expect(preview).toMatchObject({ target: 'startProjectImplementation', gated: true, open: false });
      const missing = preview.missing as Array<{ task: string; reason: string }>;
      expect(missing.map((one) => one.task).sort()).toEqual(['TA', 'TB']);
      for (const one of missing) expect(one.reason).toBe('NOT_DONE');
      const projectRow = async (projectId: string): Promise<{ status: string; version: number }> => (await rows<{ status: string; version: number }>('select status, version from machvon.project where id = $1::uuid', [projectId]))[0]!;
      const implement = async (projectId: string): Promise<Reply> => call('POST', `/projects/${projectId}/implementation-start`, { member: MANAGER, ifMatch: `"${(await projectRow(projectId)).version}"`, body: { reason: 'Khởi công theo quyết định đầu tư', investment_decision_document_id: await paper() } });
      const closed = await implement(id);
      expect(closed).toMatchObject({ status: 422, json: { code: 'PWF_GATE_CLOSED' } });
      for (const code of ['TA', 'TB']) expect(JSON.stringify(closed.json)).toContain(code);
      expect(JSON.stringify(closed.json)).toContain('NOT_DONE');
      expect((await projectRow(id)).status).toBe('BUDGETED');

      // The system event the same phase gates: a project of the pipeline with a funded line in the published plan stays where it is, and the refusal is announced with the tasks that are missing.
      const waiting = await project('PIPELINE');
      const waitingFlow = (await begin(waiting, 'UATGATE')).json.resource_id as string;
      const planId = randomUUID();
      const planVersion = randomUUID();
      const lineId = randomUUID();
      await harness.owner(TENANT_A, [
        [
          `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, decision_document_id, effective_at, created_by, updated_by)
           values ($1, $2, $3, 'ANNUAL', 2026, 2026, 2026, $4, 1, 'PUBLISHED', $5, now(), $6, $6)`,
          [TENANT_A, planId, `CP-UAT-${planId.slice(0, 6)}`, unitId(ROOT), await paper(), memberId(MANAGER)],
        ],
        [
          `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at, capital_plan_id, created_by, updated_by)
           values ($1, $2, $3, 2026, 1, $4, 'APPROVED', now(), $5, $6, $6)`,
          [TENANT_A, planVersion, waiting, randomUUID(), planId, memberId(MANAGER)],
        ],
        [
          `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, created_by, updated_by)
           values ($1, $2, $3, $4, 'CURRENT_YEAR', 2026, 1000000, 0, $5, $6, $6)`,
          [TENANT_A, lineId, planVersion, areaVersion, waiting, memberId(MANAGER)],
        ],
        [`insert into machvon.allocation_balance (tenant_id, id, allocation_line_id, allocated_vnd, committed_vnd, disbursed_vnd) values ($1, $2, $3, 1000000, 0, 0)`, [TENANT_A, randomUUID(), lineId]],
      ]);
      const relayKey = randomBytes(32);
      const delivery: OutboxDelivery = {
        id: randomUUID(),
        tenantId: TENANT_A,
        tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_SYSTEM, scopeVersion: 0 }, relayKey),
        type: 'capital.plan_published.v1',
        schemaVersion: 1,
        aggregateType: 'capital_plan',
        aggregateId: planId,
        aggregateVersion: 1,
        payload: { tenant_id: TENANT_A, capital_plan_id: planId, revision: 1, plan_year: 2026, effective_at: new Date().toISOString(), decision_document_id: randomUUID(), project_ids: [waiting] },
        eventKey: `capital_plan:${planId}:1`,
        correlationId: randomUUID(),
        attempts: 0,
      };
      const consumer = new PlanPublishedConsumer({ database: harness.tenants as TenantDatabase, security: { signingKey: relayKey } });
      expect(await consumer.handle(delivery)).toBe('processed');
      expect((await projectRow(waiting)).status).toBe('PIPELINE');
      const refused = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where aggregate_id = $1 and type = 'pwf.gate.refused.v1'`, [waiting]);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.payload).toMatchObject({ project_id: waiting, workflow_id: waitingFlow, target: 'capital.plan_published.v1' });
      expect((refused[0]?.payload.missing as Array<{ task: string }>).map((one) => one.task).sort()).toEqual(['TA', 'TB']);
      // The event delivered again announces nothing twice.
      expect(await consumer.handle(delivery)).toBe('duplicate');
      expect((await rows(`select 1 from machvon.outbox_event where aggregate_id = $1 and type = 'pwf.gate.refused.v1'`, [waiting])).length).toBe(1);

      await done(workflowId, 'TA');
      await done(workflowId, 'TB');
      expect((await call('GET', `/projects/${id}/workflow/gates/startProjectImplementation`, { member: READER })).json).toMatchObject({ open: true, missing: [] });
      expect(await implement(id)).toMatchObject({ status: 200, json: { status: 'IMPLEMENTATION' } });
      // The same command on a project that has no workflow runs as it did before PWF: no gate is evaluated, and no task log says a gate was checked.
      const plain = await project('BUDGETED');
      expect(await implement(plain)).toMatchObject({ status: 200, json: { status: 'IMPLEMENTATION' } });
      expect((await call('GET', `/projects/${plain}/workflow`, { member: READER })).status).toBe(404);
      expect((await rows('select 1 from machvon.project_task_log l join machvon.project_task t on t.id = l.task_id where t.project_id = $1::uuid', [plain])).length).toBe(0);
    });

    it('UAT-PWF-07: a reschedule keeps the real days of the task that is done and plans the rest again; the proposer cannot approve it (SELF_APPROVAL_DENIED); once another person approves, the schedule is version 2 with both hashes and the baseline is still the first one', async () => {
      const id = await project();
      const workflowId = (await begin(id, 'UATPAIR', '2026-11-02')).json.resource_id as string;
      const doneId = await done(workflowId, 'TA');
      const [actual] = await rows<{ start: string; finish: string }>('select actual_start::text as start, actual_finish::text as finish from machvon.project_task where id = $1::uuid', [doneId]);
      const before = await tasksOf(id);
      const version = (await detail(id)).json.version as number;
      const scheduleBefore = (await detail(id)).json.schedule_version as number;
      const proposed = await call('POST', `/projects/${id}/workflow/reschedules`, { member: MANAGER, ifMatch: `"${version}"`, body: { planned_start_date: '2026-11-09', reason: 'Lùi ngày bắt đầu năm ngày làm việc vì chưa giao mặt bằng' } });
      expect(proposed).toMatchObject({ status: 200, json: { status: 'PROPOSED' } });
      const previewTasks = (proposed.json.schedule as { tasks: Array<Record<string, unknown>> }).tasks;
      expect(byCode(previewTasks, 'TA')).toMatchObject({ state: 'COMPLETED', start: actual?.start, finish: actual?.finish });
      expect(byCode(previewTasks, 'TB').state).toBe('SCHEDULED');
      expect(proposed.json.input_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(proposed.json.result_hash).toMatch(/^[0-9a-f]{64}$/);
      const proposalId = proposed.json.proposal_id as string;
      const self = await call('POST', `/project-reschedules/${proposalId}/decide`, { member: MANAGER, ifMatch: `"${version}"`, body: { decision: 'APPROVE' } });
      expect(self).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await call('GET', `/project-reschedules/${proposalId}`, { member: CHECKER })).json.status).toBe('PROPOSED');
      expect(await call('POST', `/project-reschedules/${proposalId}/decide`, { member: CHECKER, ifMatch: `"${version}"`, body: { decision: 'APPROVE' } })).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
      // The schedule was version 1 when the workflow started; the progress of the task that is done published its own version, and the approval publishes exactly one more.
      expect((await detail(id)).json.schedule_version).toBe(scheduleBefore + 1);
      const published = await rows<{ version: number; kind: string }>('select version, kind from machvon.project_schedule_version where workflow_id = $1::uuid order by version', [workflowId]);
      expect(published.map((one) => one.version)).toEqual(Array.from({ length: scheduleBefore + 1 }, (_, index) => index + 1));
      expect(published.filter((one) => !['INITIAL', 'ADOPTION', 'PROGRESS'].includes(one.kind)).length).toBe(1);
      // The baseline is the first one: the baseline day of B did not move with the schedule.
      const b = (await call('GET', `/project-tasks/${(await taskOf(workflowId, 'TB')).id}`, { member: READER })).json;
      expect(b.baseline_finish).toBe(byCode(before, 'TB').baseline_finish);
      expect(b.reschedule_count).toBe(1);
      // The variance is counted from that first baseline: B is planned later than its baseline day by the working days the start moved.
      expect(String(b.planned_finish) > String(b.baseline_finish)).toBe(true);
      expect(b.finish_variance_days).toBe(Math.round((Date.parse(String(b.planned_finish)) - Date.parse(String(b.baseline_finish))) / 86_400_000));
      expect(b.finish_variance_days as number).toBeGreaterThan(0);
    });

    it('UAT-PWF-BND-08: the shares of one role on a task may add up to 100 and not to 101, a second range of the same person that overlaps is refused, a share outside 1..100 is refused, and the ledger is only added to', async () => {
      const id = await project();
      const workflowId = (await begin(id, 'UATPAIR')).json.resource_id as string;
      const t = await taskOf(workflowId, 'TA');
      const range = { from: '2026-11-02', to: '2026-12-31' };
      expect((await assign(t.id, WORKER, 60, range)).status).toBe(200);
      expect((await assign(t.id, CHECKER, 40, range)).status).toBe(200);
      expect((await assign(t.id, READER, 1, range)).json.code).toBe('PWF_ASSIGNMENT_INVALID');
      const overlap = await assign(t.id, WORKER, 10, { from: '2026-12-01', to: '2026-12-31' });
      expect(overlap.status).toBeGreaterThanOrEqual(400);
      expect(overlap.status).toBeLessThan(500);
      for (const share of [0, 101]) expect((await assign(t.id, NOBODY, share, { from: '2027-01-04', to: '2027-01-29' })).status).toBe(422);
      const kept = await rows<{ share: number }>('select share_pct as share from machvon.project_task_assignment where task_id = $1::uuid order by share_pct', [t.id]);
      expect(kept.map((one) => one.share)).toEqual([40, 60]);
      // Only added to: a row of the ledger cannot be rewritten or removed in place, even by a direct write.
      const asApplication = (sql: string): Promise<unknown> => harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(MANAGER), scopeVersion: 1 }, (tx) => tx.query(sql, [t.id]));
      await expect(asApplication('update machvon.project_task_assignment set share_pct = 1 where task_id = $1::uuid')).rejects.toThrow();
      await expect(asApplication('delete from machvon.project_task_assignment where task_id = $1::uuid')).rejects.toThrow();
      expect((await rows<{ share: number }>('select share_pct as share from machvon.project_task_assignment where task_id = $1::uuid order by share_pct', [t.id])).map((one) => one.share)).toEqual([40, 60]);
    });

    it('UAT-PWF-BND-09: a return or a pause with a reason of 19 characters is refused with 422 naming reason, and with exactly 20 characters it is taken and the return counts', async () => {
      const id = await project();
      const workflowId = (await begin(id, 'UATFIVE')).json.resource_id as string;
      const a = await taskOf(workflowId, 'TA');
      await assign(a.id, WORKER);
      await act(a.id, 'start', WORKER);
      const nineteen = 'Thiếu chữ ký tư vấn';
      const twenty = 'Thiếu chữ ký tư vấn.';
      expect([nineteen.length, twenty.length]).toEqual([19, 20]);
      await papers(a.id);
      expect((await act(a.id, 'complete', WORKER)).json.status).toBe('AWAITING_APPROVAL');
      const short = await act(a.id, 'return', CHECKER, { reason: nineteen });
      expect(short).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(JSON.stringify(short.json)).toContain('reason');
      expect(await returnsOf(a.id)).toBe(0);
      expect((await act(a.id, 'return', CHECKER, { reason: twenty })).status).toBe(200);
      expect(await returnsOf(a.id)).toBe(1);
      const shortPause = await call('POST', `/project-tasks/${a.id}/exceptions`, { member: WORKER, body: { kind: 'PAUSE', reason: nineteen } });
      expect(shortPause.status).toBe(422);
      expect(['VALIDATION_FAILED', 'PWF_EXCEPTION_INVALID']).toContain(shortPause.json.code);
      expect(JSON.stringify(shortPause.json)).toContain('reason');
      expect((await call('POST', `/project-tasks/${a.id}/exceptions`, { member: WORKER, body: { kind: 'PAUSE', reason: twenty } })).status).toBe(200);
    });

    it('UAT-PWF-BND-12: a template of 400 tasks, 12 phases and 20 links on one task is valid; 401 tasks, 13 phases or 21 links are refused naming the limit; a chain longer than 100 tasks is named; a task longer than 44 working days is only a quality flag', async () => {
      const phases = (count: number): Array<Record<string, unknown>> => Array.from({ length: count }, (_, index) => ({ code: `PH${index + 1}`, name: `Giai đoạn ${index + 1}`, gates: [] }));
      const code = (index: number): string => `T${String(index).padStart(3, '0')}`;
      // Chains of `chain` tasks (never longer than 100); the last task hangs on the heads of `links` chains.
      const sized = (count: number, phaseCount: number, links: number, chain: number): Record<string, unknown> => ({
        name: 'Mẫu theo kích thước',
        project_type: null,
        phases: phases(phaseCount),
        tasks: Array.from({ length: count }, (_, index) =>
          // Only what the contract requires of a task, so that 400 of them stay under the size a request body may have in the test application.
          ({
            code: code(index),
            name: 'V',
            phase: `PH${(index % phaseCount) + 1}`,
            kind: 'TASK',
            duration_working_days: 1,
            required: true,
            responsible_role: 'WORKER_ROLE',
            priority: 'NORMAL',
            predecessors: index === count - 1 ? Array.from({ length: links }, (_unused, link) => ({ task: code(link * chain), kind: 'SS', lag_working_days: 0 })) : index % chain === 0 ? [] : after(code(index - 1)),
          }),
        ),
      });
      const validate = (body: Record<string, unknown>): Promise<Reply> => call('POST', '/project-workflow/templates/validate', { member: MANAGER, body });
      const refused = (reply: Reply): boolean => reply.status === 422 || reply.json.valid === false;
      const atLimit = await validate(sized(400, 12, 20, 1));

      expect(atLimit.json).toMatchObject({ valid: true, task_count: 400, phase_count: 12 });
      const tooManyTasks = await validate(sized(401, 12, 20, 1));
      expect(refused(tooManyTasks)).toBe(true);
      expect(JSON.stringify(tooManyTasks.json)).toMatch(/400|tasks/);
      const tooManyPhases = await validate(sized(400, 13, 20, 1));
      expect(refused(tooManyPhases)).toBe(true);
      expect(JSON.stringify(tooManyPhases.json)).toMatch(/phases/);
      const tooManyLinks = await validate(sized(400, 12, 21, 1));
      expect(refused(tooManyLinks)).toBe(true);
      expect(JSON.stringify(tooManyLinks.json)).toMatch(/predecessors/);
      const longChain = await validate(sized(102, 1, 0, 102));
      expect(refused(longChain)).toBe(true);
      expect(JSON.stringify(longChain.json)).toMatch(/100|chain/i);
      const longTask = await validate(template('Việc dài', [task('TA', { duration_working_days: 45 })]));
      expect(longTask.json).toMatchObject({ valid: true, findings: [] });
      expect((longTask.json.quality_flags as Array<{ task: string }>).some((flag) => flag.task === 'TA')).toBe(true);
      expect((await validate(template('Việc vừa', [task('TA', { duration_working_days: 44 })]))).json.quality_flags).toEqual([]);
    });

    it('UAT-PWF-BND-14: a planned start on Saturday 2026-11-14 puts the first task and the milestone without predecessor on Monday 2026-11-16, and no task before the planned start', async () => {
      const id = await project();
      expect((await begin(id, 'UATMILE', '2026-11-14')).status).toBe(200);
      const tasks = await tasksOf(id);
      expect(byCode(tasks, 'TA').planned_start).toBe('2026-11-16');
      expect(byCode(tasks, 'M0').planned_start).toBe('2026-11-16');
      for (const one of tasks) expect(String(one.planned_start) >= '2026-11-14').toBe(true);
    });

    it('UAT-PWF-STA-01: a task that is DONE takes no command: start, complete, return, pause and cancel are PWF_TASK_STATE_INVALID, it stays DONE and its log gets no row', async () => {
      const id = await project();
      const workflowId = (await begin(id, 'UATPAIR')).json.resource_id as string;
      const taskId = await done(workflowId, 'TA');
      const log = async (): Promise<number> => Number((await rows<{ n: string }>('select count(*) as n from machvon.project_task_log where task_id = $1::uuid', [taskId]))[0]!.n);
      const before = await log();
      const replies = [
        await act(taskId, 'start', WORKER),
        await act(taskId, 'complete', WORKER),
        await act(taskId, 'return', CHECKER, { reason: 'Trả lại việc đã xong để làm lại' }),
        await call('POST', `/project-tasks/${taskId}/exceptions`, { member: WORKER, body: { kind: 'PAUSE', reason: 'Tạm dừng việc đã xong để chờ ý kiến' } }),
        await call('POST', `/project-tasks/${taskId}/exceptions`, { member: WORKER, body: { kind: 'CANCEL_TASK', reason: 'Hủy việc đã xong vì không còn cần nữa' } }),
      ];
      expect(replies.map((one) => one.json.code)).toEqual(Array.from({ length: 5 }, () => 'PWF_TASK_STATE_INVALID'));
      expect(await statusOf(taskId)).toBe('DONE');
      expect(await log()).toBe(before);
    });

    it('UAT-PWF-STA-02: a cancelled task and a task of an excluded branch take no command (PWF_TASK_STATE_INVALID); the cancelled one is kept as a node of no length, so what follows it keeps its lag', async () => {
      const id = await project();
      const workflowId = (await begin(id, 'UATPAIR', '2026-11-02')).json.resource_id as string;
      const a = await taskOf(workflowId, 'TA');
      await assign(a.id, WORKER);
      const asked = await call('POST', `/project-tasks/${a.id}/exceptions`, { member: WORKER, body: { kind: 'CANCEL_TASK', reason: 'Việc không còn cần sau khi đổi phương án' } });
      expect(asked.status).toBe(200);
      expect((await decide(asked.json.resource_id as string, CHECKER)).status).toBe(200);
      expect(await statusOf(a.id)).toBe('CANCELLED');
      expect((await act(a.id, 'start', WORKER)).json.code).toBe('PWF_TASK_STATE_INVALID');
      expect((await act(a.id, 'resume', WORKER)).json.code).toBe('PWF_TASK_STATE_INVALID');
      expect((await rows('select 1 from machvon.project_task where id = $1::uuid', [a.id])).length).toBe(1);
      const scheduled = (await call('GET', `/projects/${id}/workflow/schedule`, { member: READER })).json.tasks as Array<Record<string, unknown>>;
      // The cancelled task is a node of no length: it has no days and no float of its own, and B still follows it by its link (2 working days after the node, never before).
      expect(byCode(scheduled, 'TA')).toMatchObject({ state: 'PASS_THROUGH', start: null, finish: null, total_float: null });
      expect(byCode(scheduled, 'TB').state).toBe('SCHEDULED');
      expect(String(byCode(scheduled, 'TB').start) >= '2026-11-04').toBe(true);
      const hand = await project();
      const handFlow = (await begin(hand, 'UATHAND')).json.resource_id as string;
      const x = await taskOf(handFlow, 'TX');
      await assign(x.id, WORKER);
      expect((await act(x.id, 'start', WORKER)).json.code).toBe('PWF_TASK_STATE_INVALID');
    });

    it('UAT-PWF-SEC-07: who proposed a reschedule or asked for an exception cannot decide it (403 SELF_APPROVAL_DENIED, nothing changes); another person can; the tables refuse a row decided by its requester even on a direct write', async () => {
      const id = await project();
      const workflowId = (await begin(id, 'UATPAIR')).json.resource_id as string;
      const version = (await detail(id)).json.version as number;
      const proposed = await call('POST', `/projects/${id}/workflow/reschedules`, { member: MANAGER, ifMatch: `"${version}"`, body: { planned_start_date: '2026-11-09', reason: 'Lùi ngày bắt đầu một tuần theo đề nghị của chủ đầu tư' } });
      const proposalId = proposed.json.proposal_id as string;
      expect(await call('POST', `/project-reschedules/${proposalId}/decide`, { member: MANAGER, ifMatch: `"${version}"`, body: { decision: 'APPROVE' } })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await call('GET', `/project-reschedules/${proposalId}`, { member: CHECKER })).json.status).toBe('PROPOSED');
      // The database holds the rule as well: a row decided by the one who asked is refused whoever writes it.
      await expect(rows(`update machvon.project_reschedule_proposal set status = 'APPROVED', decided_by = proposed_by, decided_at = now() where id = $1::uuid`, [proposalId])).rejects.toThrow();
      expect(await call('POST', `/project-reschedules/${proposalId}/decide`, { member: CHECKER, ifMatch: `"${version}"`, body: { decision: 'APPROVE' } })).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
      const a = await taskOf(workflowId, 'TA');
      await assign(a.id, MANAGER);
      expect((await act(a.id, 'start', MANAGER)).status).toBe(200);
      const asked = await call('POST', `/project-tasks/${a.id}/exceptions`, { member: MANAGER, body: { kind: 'PAUSE', reason: 'Tạm dừng chờ bàn giao mặt bằng đợt hai' } });
      expect(asked.status).toBe(200);
      const exceptionId = asked.json.resource_id as string;
      expect(await decide(exceptionId, MANAGER)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      const standing = async (): Promise<string> => (await rows<{ status: string }>('select status from machvon.project_task_exception where id = $1::uuid', [exceptionId]))[0]!.status;
      const requested = await standing();
      await expect(rows(`update machvon.project_task_exception set status = 'APPROVED', decided_by = requested_by, decided_at = now() where id = $1::uuid`, [exceptionId])).rejects.toThrow();
      expect(await standing()).toBe(requested);
      expect((await decide(exceptionId, CHECKER)).status).toBe(200);
      expect(await standing()).toBe('APPROVED');
    });

    it('UAT-PWF-SEC-09: a leader who only reads gets 403 on every write and can_manage false; a person outside the assignment ledger is refused; a write without Idempotency-Key is refused; the assigned worker with a key succeeds', async () => {
      const id = await project();
      const workflowId = (await begin(id, 'UATPAIR')).json.resource_id as string;
      const a = await taskOf(workflowId, 'TA');
      expect((await assign(a.id, WORKER)).status).toBe(200);
      const leader = [
        await act(a.id, 'start', READER),
        await act(a.id, 'complete', READER),
        await call('POST', `/project-tasks/${a.id}/assignments`, { member: READER, body: { membership_id: memberId(READER), role: 'RESPONSIBLE', valid_from: '2020-01-01', share_pct: 100, reason: 'Tự phân công cho mình' } }),
        await call('POST', `/projects/${await project()}/workflow`, { member: READER, body: { template_code: 'UATPAIR', planned_start_date: START, facts: { project_group: 'B' } } }),
      ];
      expect(leader.map((one) => one.status)).toEqual([403, 403, 403, 403]);
      expect((await detail(id, READER)).json).toMatchObject({ can_manage: false, can_propose_reschedule: false });
      // The manager holds pwf.task.work but is not in the ledger of the task.
      const outsider = await act(a.id, 'start', MANAGER);
      expect([403, 404]).toContain(outsider.status);
      expect(await statusOf(a.id)).toBe('NOT_STARTED');
      const noKey = await fetch(`${app.baseUrl}/project-tasks/${a.id}/start`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(WORKER), 'content-type': 'application/json', 'if-match': `"${await versionOf(a.id)}"` }, body: '{}' });
      expect(noKey.status).toBeGreaterThanOrEqual(400);
      expect(noKey.status).toBeLessThan(500);
      expect(JSON.stringify(await noKey.json())).toMatch(/idempotency/i);
      expect(await statusOf(a.id)).toBe('NOT_STARTED');
      expect(await act(a.id, 'start', WORKER)).toMatchObject({ status: 200, json: { status: 'IN_PROGRESS' } });
    });

    it('UAT-PWF-WRK-01: the load of a person is 2 open tasks and 7 planned working days left (5 at 100 percent and 4 at 50 percent) spread over the weeks, display only: reading it changes no schedule and no assignment', async () => {
      const id = await project();
      const workflowId = (await begin(id, 'UATLOAD', '2026-11-02')).json.resource_id as string;
      const [a, b] = [await taskOf(workflowId, 'TA'), await taskOf(workflowId, 'TB')];
      // A person nobody else assigns in this file, so the figures are the ones of these two tasks.
      expect((await assign(a.id, NOBODY, 100)).status).toBe(200);
      expect((await assign(b.id, NOBODY, 50)).status).toBe(200);
      const snapshot = (): Promise<object[]> => rows('select task_code, planned_start, planned_finish, version from machvon.project_task where workflow_id = $1::uuid order by task_code', [workflowId]);
      const before = await snapshot();
      const load = (await call('GET', '/pwf/workload?from=2026-11-02&weeks=2', { member: READER })).json;
      expect(load.display_only).toBe(true);
      expect((load.weeks as unknown[]).length).toBe(2);
      const person = (load.people as Array<{ membership_id: string; open_tasks: number; weekly_planned_working_days: number[] }>).find((one) => one.membership_id === memberId(NOBODY));
      expect(person?.open_tasks).toBe(2);
      expect(person?.weekly_planned_working_days.reduce((sum, days) => sum + days, 0)).toBe(7);
      expect(await snapshot()).toEqual(before);
      expect((await rows('select 1 from machvon.project_task_assignment where task_id in ($1::uuid, $2::uuid)', [a.id, b.id])).length).toBe(2);
    });
  });
});

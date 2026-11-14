import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { ND30_A4_STANDARD, loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
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
    const all = ['project.create', 'project.read', 'pwf.template.manage', 'pwf.workflow.manage', 'pwf.workflow.adopt', 'pwf.read', 'pwf.task.work', 'pwf.task.approve', 'pwf.task.assign', 'pwf.schedule.propose', 'pwf.schedule.approve', 'project.stage.complete'];
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
      expect((bad.json.findings as Array<{ code: string }>)[0]?.code).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
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
});

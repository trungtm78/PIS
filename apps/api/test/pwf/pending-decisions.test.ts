import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, HomeWorkStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { MyPendingDecisionsController } from '../../src/modules/adm/approval.controller';
import { APPROVAL_FINAL_COMMANDS, FinalCommandRegistry } from '../../src/modules/adm/approval.service';
import { workScopes } from '../../src/modules/home/work-scope';
import { SYSTEM_ROLES } from '@machvon/db';
import { pwfModule } from '../../src/modules/pwf';
import { PwfPreferenceController } from '../../src/modules/pwf/preference.controller';
import { PwfPendingDecisionsBinding } from '../../src/modules/pwf/pending-decisions.binding';
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
const OUTSIDE_CHECKER = 6; // the rights of the checker, over a unit that owns no project
const SIBLING = 3;
const STAFFER = 7; // only the role STAFF_MEMBER of the system, on the department
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

describe('the unified approval inbox reads what waits in PWF for the reader (PWF 20.9)', () => {
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
        { n: SIBLING, path: `/${unitId(ROOT)}/${unitId(SIBLING)}/`, parent: ROOT },
      ]);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER_SYSTEM, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER_SYSTEM, TODAY));
    }
    for (const n of [MANAGER, WORKER, CHECKER, READER, NOBODY, OUTSIDE_CHECKER, STAFFER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MANAGER, ROOT);
    const all = ['session.self', 'project.create', 'project.read', 'pwf.template.manage', 'pwf.workflow.manage', 'pwf.workflow.adopt', 'pwf.read', 'pwf.task.work', 'pwf.task.approve', 'pwf.task.assign', 'pwf.schedule.propose', 'pwf.schedule.approve', 'project.stage.complete', 'project.stage.implement'];
    await harness.seedRole(TENANT_A, 1, 'PWF_MANAGER', all, 40);
    await harness.seedRole(TENANT_A, 2, 'PWF_WORKER', ['session.self', 'pwf.read', 'pwf.task.work'], 20);
    await harness.seedRole(TENANT_A, 3, 'PWF_CHECKER', ['session.self', 'pwf.read', 'pwf.task.approve', 'pwf.schedule.approve'], 20);
    await harness.seedRole(TENANT_A, 4, 'PWF_READER', ['session.self', 'pwf.read'], 10);
    await harness.seedRole(TENANT_B, 1, 'PWF_MANAGER', all, 40);
    await harness.seedRole(TENANT_A, 6, 'STAFF_MEMBER', SYSTEM_ROLES.find((role) => role.code === 'STAFF_MEMBER')?.permissions ?? [], 6);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: WORKER, role: 2, kind: 'TENANT' },
      { n: 3, member: CHECKER, role: 3, kind: 'TENANT' },
      { n: 4, member: READER, role: 4, kind: 'TENANT' },
      { n: 5, member: OUTSIDE_CHECKER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(SIBLING)] },
      { n: 6, member: STAFFER, role: 6, kind: 'UNIT_ONLY', refs: [unitId(DEPARTMENT)] },
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
      controllers: [ProjectController, ProjectReadsController, ProjectStageController, ProjectLifecycleReadsController, ProjectWorkflowController, ProjectWorkflowReadsController, ProjectTaskController, ProjectTaskReadsController, ProjectRescheduleController, PwfDeadlineReadsController, PwfPreferenceController, MyPendingDecisionsController],
      providers: [
        { provide: APPROVAL_FINAL_COMMANDS, useValue: new FinalCommandRegistry() },
        PwfPendingDecisionsBinding,
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  type Item = { id: string; kind: string; version: number; resource: { type: string; id: string }; initiator: { name: string | null }; due_at: string | null; overdue: boolean; summary: { kind: string; project: { id: string; code: string } | null; body: string | null; facts: Array<{ code: string; value: unknown }>; target: { screen: string; id: string } }; actions: Array<{ decision: string; operation_id: string; reason_required: boolean }> };
  const inbox = async (member: number, tenantId?: string): Promise<Item[]> => {
    const reply = await call('GET', '/me/pending-decisions', { member, ...(tenantId === undefined ? {} : { tenantId }) });
    expect(reply.status).toBe(200);
    expect(reply.json.unavailable_sources).toEqual([]);
    return reply.json.items as Item[];
  };
  const of = (items: Item[], resourceId: string): Item | undefined => items.find((one) => one.resource.id === resourceId);

  /** A task of a new project that the worker did and whose completion waits for a second person. */
  async function awaitingCompletion(): Promise<{ projectId: string; taskId: string; version: number }> {
    const projectId = await project('IMPLEMENTATION');
    const workflowId = (await startFlow(projectId)).json.resource_id as string;
    const a = await taskOf(workflowId, 'TA');
    expect((await call('POST', `/project-tasks/${a.id}/assignments`, { member: MANAGER, body: { membership_id: memberId(WORKER), role: 'RESPONSIBLE', valid_from: '2020-01-01', share_pct: 100, reason: 'Assigned for the test' } })).status).toBe(200);
    const started = await call('POST', `/project-tasks/${a.id}/start`, { member: WORKER, ifMatch: `"${a.version}"` });
    expect((await call('POST', `/project-tasks/${a.id}/evidence`, { member: WORKER, body: { evidence_kind: 'DOCUMENT', document_id: await paper(), legal_doc_type: 'FEASIBILITY_REPORT' } })).status).toBe(200);
    const requested = await call('POST', `/project-tasks/${a.id}/complete`, { member: WORKER, ifMatch: `"${started.json.resource_version}"` });
    expect(requested).toMatchObject({ status: 200, json: { status: 'AWAITING_APPROVAL' } });
    return { projectId, taskId: a.id, version: requested.json.resource_version as number };
  }

  it('is registered in the module of PWF and answers nothing to a person who decides nothing', async () => {
    expect(pwfModule.providers).toContain(PwfPendingDecisionsBinding);
    // A person with no grant at all is refused at the door, like every read of one's own.
    expect((await call('GET', '/me/pending-decisions', { member: NOBODY })).status).toBe(403);
    expect(await inbox(READER)).toEqual([]);
  });

  it('lists the completion of a task for a second person in the scope of pwf.task.approve, never for a maker, another unit or another tenant; the command it names decides it once', async () => {
    const { projectId, taskId, version } = await awaitingCompletion();
    const item = of(await inbox(CHECKER), taskId);
    expect(item).toMatchObject({ id: `pwf.task.completion:${taskId}`, kind: 'pwf.task.completion', version, resource: { type: 'project_task', id: taskId }, due_at: null, overdue: false, summary: { kind: 'pwf.task.completion', project: { id: projectId }, target: { screen: 'PWF-04', id: taskId } } });
    expect(item?.summary.facts).toEqual(expect.arrayContaining([{ code: 'TASK', value: 'Task A' }]));
    expect(item?.summary.facts.find((fact) => fact.code === 'DUE_DATE')?.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(item?.actions.map((one) => [one.decision, one.operation_id, one.reason_required])).toEqual([['approve', 'approveProjectTaskCompletion', false], ['return', 'returnProjectTask', true]]);
    // The manager holds the permission and did no work on the task: it waits for them too. The worker made it; the reader and the checker of another unit may not decide it.
    expect(of(await inbox(MANAGER), taskId)).toBeDefined();
    for (const member of [WORKER, READER, OUTSIDE_CHECKER]) expect(of(await inbox(member), taskId)).toBeUndefined();
    expect(await inbox(B_MANAGER, TENANT_B)).toEqual([]);
    // What the list hides the command refuses (IDOR): the maker, and the checker whose unit does not own the project.
    expect((await call('POST', `/project-tasks/${taskId}/approve-completion`, { member: WORKER, ifMatch: `"${version}"`, body: { decision: 'APPROVE' } })).status).toBe(403);
    expect([403, 404]).toContain((await call('POST', `/project-tasks/${taskId}/approve-completion`, { member: OUTSIDE_CHECKER, ifMatch: `"${version}"`, body: { decision: 'APPROVE' } })).status);
    // Decided through the command of PWF itself, under the version of the item; a repeat of the same request is the same answer and one audit row.
    const key = `key-${randomUUID()}`;
    const send = () => call('POST', `/project-tasks/${taskId}/approve-completion`, { member: CHECKER, ifMatch: `"${item?.version}"`, body: { decision: 'APPROVE', note: 'Read and agreed' }, key });
    const first = await send();
    expect(first).toMatchObject({ status: 200, json: { status: 'DONE' } });
    expect((await send()).json).toEqual(first.json);
    expect((await rows("select 1 from machvon.audit_event where resource_id = $1 and action = 'task.approved'", [taskId])).length).toBe(1);
    expect(of(await inbox(CHECKER), taskId)).toBeUndefined();
  });

  it('gives a person who holds only the role of the staff something to read: their own tasks and the inbox, and no right over the work of others (lane fix12)', async () => {
    const { taskId, version } = await awaitingCompletion();
    // The home of an officer reads the tasks given to the person and the records that wait for their decision; neither is refused to the base role of the staff.
    expect((await call('GET', '/me/project-tasks', { member: STAFFER })).status).toBe(200);
    expect(await inbox(STAFFER)).toEqual([]);
    // What it does not carry: reading the board of everybody's deadlines, deciding a completion, or taking up a task nobody gave them.
    expect((await call('GET', '/pwf/deadlines?limit=1', { member: STAFFER })).status).toBe(403);
    expect((await call('POST', `/project-tasks/${taskId}/approve-completion`, { member: STAFFER, ifMatch: `"${version}"`, body: { decision: 'APPROVE' } })).status).toBe(403);
    const fresh = await taskOf((await startFlow(await project('IMPLEMENTATION'))).json.resource_id as string, 'TA');
    expect((await call('POST', `/project-tasks/${fresh.id}/start`, { member: STAFFER, ifMatch: `"${fresh.version}"` })).status).toBe(403);
  });

  it('sends a completion back through returnProjectTask, and the item leaves the inbox', async () => {
    const { taskId, version } = await awaitingCompletion();
    expect(of(await inbox(CHECKER), taskId)).toBeDefined();
    expect((await call('POST', `/project-tasks/${taskId}/return`, { member: CHECKER, ifMatch: `"${version}"`, body: { reason: 'The report lacks the signature of the consultant' } })).status).toBe(200);
    expect(of(await inbox(CHECKER), taskId)).toBeUndefined();
  });

  it('lists an exception of a task for the one who may decide it and not for the one who asked', async () => {
    const projectId = await project('IMPLEMENTATION');
    const workflowId = (await startFlow(projectId)).json.resource_id as string;
    const a = await taskOf(workflowId, 'TA');
    const reason = 'The report is replaced by the decision of the province, attached to the file';
    const asked = await call('POST', `/project-tasks/${a.id}/exceptions`, { member: MANAGER, body: { kind: 'WAIVE_REQUIREMENT', items: ['FEASIBILITY_REPORT'], valid_from: TODAY, reason } });
    expect(asked.status).toBe(200);
    const exceptionId = asked.json.resource_id as string;
    const item = of(await inbox(CHECKER), exceptionId);
    expect(item).toMatchObject({ kind: 'pwf.task.exception', version: 1, resource: { type: 'project_task_exception', id: exceptionId }, summary: { project: { id: projectId }, body: reason, target: { screen: 'PWF-04', id: a.id } } });
    expect(item?.summary.facts).toEqual(expect.arrayContaining([{ code: 'TASK', value: 'Task A' }, { code: 'EXCEPTION_KIND', value: 'WAIVE_REQUIREMENT' }, { code: 'WAIVED_ITEMS', value: 1 }]));
    expect(item?.actions.map((one) => [one.decision, one.operation_id])).toEqual([['approve', 'decideProjectTaskException'], ['reject', 'decideProjectTaskException']]);
    for (const member of [MANAGER, WORKER, OUTSIDE_CHECKER]) expect(of(await inbox(member), exceptionId)).toBeUndefined();
    expect((await call('POST', `/project-task-exceptions/${exceptionId}/decide`, { member: MANAGER, ifMatch: '"1"', body: { decision: 'APPROVE' } })).json.code).toBe('SELF_APPROVAL_DENIED');
    expect((await call('POST', `/project-task-exceptions/${exceptionId}/decide`, { member: CHECKER, ifMatch: `"${item?.version}"`, body: { decision: 'REJECT', note: 'Not a reason to stop' } })).status).toBe(200);
    expect(of(await inbox(CHECKER), exceptionId)).toBeUndefined();
  });

  it('lists a proposal of a new schedule under the version of the workflow it was made on, for the one who may decide it and not for the proposer', async () => {
    const projectId = await project();
    const started = await startFlow(projectId);
    const reason = 'The start of the project is moved by two weeks';
    const proposed = await call('POST', `/projects/${projectId}/workflow/reschedules`, { member: MANAGER, ifMatch: `"${started.json.resource_version}"`, body: { planned_start_date: `${YEAR}-11-16`, reason } });
    const proposalId = proposed.json.proposal_id as string;
    const item = of(await inbox(CHECKER), proposalId);
    expect(item).toMatchObject({ kind: 'pwf.reschedule', version: started.json.resource_version, resource: { type: 'project_reschedule_proposal', id: proposalId }, summary: { project: { id: projectId }, body: reason, target: { screen: 'PWF-06', id: projectId } } });
    expect(item?.summary.facts.map((fact) => fact.code)).toEqual(expect.arrayContaining(['PROPOSED_FINISH', 'FINISH_SHIFT_DAYS', 'CHANGED_TASKS']));
    expect(item?.actions.map((one) => [one.decision, one.operation_id])).toEqual([['approve', 'decideProjectReschedule'], ['reject', 'decideProjectReschedule']]);
    for (const member of [MANAGER, WORKER, READER, OUTSIDE_CHECKER]) expect(of(await inbox(member), proposalId)).toBeUndefined();
    expect((await call('POST', `/project-reschedules/${proposalId}/decide`, { member: CHECKER, ifMatch: `"${item?.version}"`, body: { decision: 'APPROVE' } })).json).toMatchObject({ status: 'APPROVED' });
    expect(of(await inbox(CHECKER), proposalId)).toBeUndefined();
  });

  it('counts the decision among the approvals that wait for the person in the alert centre, with no day and never for the maker', async () => {
    const { taskId } = await awaitingCompletion();
    const tenants = harness.tenants as TenantDatabase;
    const work = async (member: number) => {
      const context = { tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 };
      const access = await new EffectiveAccessStore(tenants, new InMemoryAuthzCache()).load(context);
      const now = new Date();
      const collected = await tenants.withTenant(context, (tx) => new HomeWorkStore().collect(tx, { membershipId: context.membershipId, now, today: TODAY, view: 'mine', mode: 'count', ...workScopes(access, now) }));
      return collected.rows.filter((row) => row.id === `pwf.task.completion:${taskId}`);
    };
    expect(await work(CHECKER)).toEqual([expect.objectContaining({ kind: 'APPROVAL', source: 'APPROVAL', dueOn: null, title: 'Task A: chờ bạn duyệt hoàn thành', target: { screen: 'PWF-04', id: taskId } })]);
    expect(await work(WORKER)).toEqual([]);
    expect(await work(OUTSIDE_CHECKER)).toEqual([]);
  });

  it('names a source that fails instead of showing an empty inbox, and keeps the other sources', async () => {
    const registry = new FinalCommandRegistry();
    registry.registerPendingSource('BROKEN', (tx) => tx.query('select 1 from machvon.no_such_table').then(() => []));
    registry.registerPendingSource('WORKS', () => Promise.resolve([]));
    const found = await (harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: memberId(CHECKER), scopeVersion: 1 }, (tx) => registry.pendingOf(tx, { membershipId: memberId(CHECKER), access: { grants: [] } as never, now: new Date() }));
    expect(found).toEqual({ items: [], unavailableSources: ['BROKEN'], truncated: false });
  });
});

import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ProjectRescheduleController } from '../../src/modules/pwf/reschedule.controller';
import { ProjectTaskController, ProjectTaskReadsController } from '../../src/modules/pwf/task.controller';
import { ProjectWorkflowController, ProjectWorkflowReadsController } from '../../src/modules/pwf/workflow.controller';
import { ProjectController, ProjectReadsController } from '../../src/modules/prj/project.controller';
import { AuthzHarness, TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

/**
 * PWF-5 over HTTP (docs PWF 22.4, R72): a reschedule proposal extends the limit of tasks (`extensions`), the caps are told in the refusal, the preview says which task is EXTENDED and which is CASCADED, the approval spends the
 * caps and the reads tell what is used; a raise through `overrides.change` of a task with an extension rule is refused.
 */

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const YEAR = Number(TODAY.slice(0, 4));
const MANAGER = 1;
const WORKER = 2;
const CHECKER = 3;
const ROOT = 1;
const DEPARTMENT = 2;
const WORKER_SYSTEM = '00000000-0000-4000-8000-000000000000';
const REASON = 'Thẩm định cần thêm thời gian so với thời hạn của mẫu quy trình';

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const worked = (day: string): boolean => ![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
const workingDayAfter = (from: string, count: number): string => {
  let cursor = from;
  for (let left = count; left > 0; ) {
    cursor = addDays(cursor, 1);
    if (worked(cursor)) left -= 1;
  }
  return cursor;
};
const rolled = (day: string): string => (worked(day) ? day : rolled(addDays(day, 1)));
const START = workingDayAfter(TODAY, 2);

const plain = (code: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  code,
  name: `Task ${code}`,
  phase: 'P1',
  kind: 'TASK',
  duration_working_days: 3,
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
  ...over,
});

/** TA: at most two extensions and five working days in all; TB follows it and has no rule; TC forbids extensions; CAL is ten calendar days with at most thirty more. */
const TEMPLATE = {
  name: 'Extension flow over HTTP',
  project_type: null,
  phases: [{ code: 'P1', name: 'Phase one', gates: [] }],
  tasks: [
    plain('TA', { extension: { allowed: true, max_times: 2, max_value: 5, unit: 'WORKING_DAY' } }),
    plain('TB', { predecessors: [{ task: 'TA', kind: 'FS', lag_working_days: 0 }] }),
    plain('TC', { extension: { allowed: false, unit: 'WORKING_DAY' } }),
    plain('CAL', { duration_working_days: 8, duration: { value: 10, unit: 'CALENDAR_DAY', roll_to_working_day: true }, extension: { allowed: true, max_value: 30, unit: 'CALENDAR_DAY' } }),
  ],
};

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Flow {
  projectId: string;
  version: number;
  ids: Record<string, string>;
}

describe('extending the limit of a task over HTTP (PWF-5, R72)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let areaVersion = '';

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, member: number, body?: unknown, ifMatch?: number): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (ifMatch !== undefined) headers['if-match'] = `"${ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  async function started(): Promise<Flow> {
    const made = await call('POST', '/projects', MANAGER, { code: `PWX-${randomUUID().slice(0, 6)}`, name: 'Dự án đường vành đai 3', owner_unit_id: unitId(DEPARTMENT), area_master_version_id: areaVersion, total_investment_vnd: '500000000000' });
    expect(made.status).toBe(200);
    const projectId = made.json.resource_id as string;
    await harness.owner(TENANT_A, [[`update machvon.project set status = 'CONCEPT', project_group = 'B' where id = $1::uuid`, [projectId]]]);
    const flow = await call('POST', `/projects/${projectId}/workflow`, MANAGER, { template_code: 'EXTAPI', planned_start_date: START, facts: { project_group: 'B' } });
    expect(flow.status).toBe(200);
    const rows = await harness.owner<{ id: string; task_code: string }>(TENANT_A, [['select id, task_code from machvon.project_task where project_id = $1::uuid', [projectId]]]);
    return { projectId, version: Number(flow.json.resource_version), ids: Object.fromEntries(rows.map((row) => [row.task_code, row.id])) };
  }

  const versionOf = async (flow: Flow): Promise<number> => Number((await harness.owner<{ version: number }>(TENANT_A, [['select version from machvon.project_workflow where project_id = $1::uuid', [flow.projectId]]]))[0]?.version);
  const propose = (flow: Flow, body: Record<string, unknown>): Promise<Reply> => call('POST', `/projects/${flow.projectId}/workflow/reschedules`, MANAGER, { reason: REASON, ...body }, flow.version);
  const decide = (flow: Flow, proposalId: string, decision = 'APPROVE'): Promise<Reply> => call('POST', `/project-reschedules/${proposalId}/decide`, CHECKER, { decision }, flow.version);

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
    ]);
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_SYSTEM, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER_SYSTEM, TODAY));
    for (const n of [MANAGER, WORKER, CHECKER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PWF_MANAGER', ['project.create', 'project.read', 'pwf.workflow.manage', 'pwf.read', 'pwf.task.work', 'pwf.task.assign', 'pwf.schedule.propose'], 40);
    await harness.seedRole(TENANT_A, 3, 'PWF_CHECKER', ['pwf.read', 'pwf.schedule.approve'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 3, member: CHECKER, role: 3, kind: 'TENANT' },
    ]);
    const recordId = randomUUID();
    areaVersion = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'TINH-X', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(MANAGER)]],
      [`insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, valid_until, status, master_record_id, published_at, created_by, updated_by) values ($1, $2, 'AREA', 'TINH-X', 1, 'TINH-X', '{}'::jsonb, '2020-01-01', null, 'EFFECTIVE', $3, now(), $4, $4)`, [TENANT_A, areaVersion, recordId, memberId(MANAGER)]],
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
         values ($1, 'PROJECT_WORKFLOW_TEMPLATE', 'EXTAPI', 1, 'APPROVED', $2::jsonb, date '2020-01-01', 'A template for the tests', $3, $4, now(), $5, now())`,
        [TENANT_A, JSON.stringify(TEMPLATE), memberId(MANAGER), memberId(WORKER), memberId(CHECKER)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ProjectController, ProjectReadsController, ProjectWorkflowController, ProjectWorkflowReadsController, ProjectTaskController, ProjectTaskReadsController, ProjectRescheduleController],
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

  it('proposes extensions, shows EXTENDED and CASCADED in the preview and in the stored proposal, and after the approval the reads tell the limit and what is used of the caps', async () => {
    const flow = await started();
    const proposed = await propose(flow, { extensions: [{ task_code: 'TA', add_value: 2 }, { task_code: 'CAL', add_value: 4 }] });
    expect(proposed.status).toBe(200);
    const lines = [
      { task_code: 'TA', add_value: 2, unit: 'WORKING_DAY' },
      { task_code: 'CAL', add_value: 4, unit: 'CALENDAR_DAY' },
    ];
    expect(proposed.json.extensions).toEqual(lines);
    const causes = (reply: Reply): Record<string, unknown> => Object.fromEntries((reply.json.changes as Array<{ task_code: string; cause?: string }>).filter((one) => one.cause !== undefined).map((one) => [one.task_code, one.cause]));
    expect(causes(proposed)).toEqual({ TA: 'EXTENDED', TB: 'CASCADED', CAL: 'EXTENDED' });
    // The fields of a change that were there keep their meaning.
    expect((proposed.json.changes as Array<Record<string, unknown>>).find((one) => one.task_code === 'TB')).toMatchObject({ start_shift_days: 2, finish_shift_days: 2, state_changed: false });
    const proposalId = proposed.json.proposal_id as string;
    const stored = await call('GET', `/project-reschedules/${proposalId}`, CHECKER);
    expect(stored.status).toBe(200);
    expect(stored.json).toMatchObject({ status: 'PROPOSED', extensions: lines });
    expect(causes(stored)).toEqual({ TA: 'EXTENDED', TB: 'CASCADED', CAL: 'EXTENDED' });
    // Nothing is spent while the proposal waits.
    expect((await call('GET', `/project-tasks/${flow.ids.TA}`, MANAGER)).json).toMatchObject({ duration_working_days: 3, extension: { allowed: true, max_times: 2, max_value: 5, unit: 'WORKING_DAY', times_used: 0, value_used: 0 } });

    expect(await decide(flow, proposalId)).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
    const a = await call('GET', `/project-tasks/${flow.ids.TA}`, MANAGER);
    expect(a.json).toMatchObject({ duration_working_days: 5, planned_finish: workingDayAfter(START, 4), extension: { allowed: true, max_times: 2, max_value: 5, unit: 'WORKING_DAY', times_used: 1, value_used: 2 } });
    const b = await call('GET', `/project-tasks/${flow.ids.TB}`, MANAGER);
    expect(b.json).toMatchObject({ duration_working_days: 3, planned_start: workingDayAfter(START, 5) });
    expect('extension' in b.json).toBe(false);
    const cal = await call('GET', `/project-tasks/${flow.ids.CAL}`, MANAGER);
    expect(cal.json).toMatchObject({ duration: { value: 14, unit: 'CALENDAR_DAY', roll_to_working_day: true }, duration_working_days: 10, planned_finish: rolled(addDays(START, 13)), extension: { max_times: null, max_value: 30, times_used: 1, value_used: 4 } });
    type Item = { task_code: string; extension?: Record<string, unknown> };
    const workflow = await call('GET', `/projects/${flow.projectId}/workflow`, MANAGER);
    expect(workflow.status).toBe(200);
    expect(Object.fromEntries((workflow.json.tasks as Item[]).map((one) => [one.task_code, one.extension?.times_used]))).toEqual({ TA: 1, TB: undefined, TC: 0, CAL: 1 });
    const list = await call('GET', `/projects/${flow.projectId}/workflow/tasks?limit=50`, MANAGER);
    expect(list.status).toBe(200);
    expect((list.json.items as Item[]).find((one) => one.task_code === 'TC')?.extension).toEqual({ allowed: false, max_times: null, max_value: null, unit: 'WORKING_DAY', times_used: 0, value_used: 0 });
  });

  it('answers 422 with the code and the details: the cap exceeded, a task that may not be extended, a raise through `change`, a limit in calendar days changed in working days', async () => {
    const flow = await started();
    const over = await propose(flow, { extensions: [{ task_code: 'TA', add_value: 3 }, { task_code: 'TA', add_value: 3 }] });
    expect(over).toMatchObject({ status: 422, json: { code: 'PWF_EXTENSION_LIMIT_EXCEEDED', task_code: 'TA', limit: 'VALUE', used: 0, asked: 6, max: 5 } });
    const times = await propose(flow, { extensions: [{ task_code: 'TA', add_value: 1 }, { task_code: 'TA', add_value: 1 }, { task_code: 'TA', add_value: 1 }] });
    expect(times).toMatchObject({ status: 422, json: { code: 'PWF_EXTENSION_LIMIT_EXCEEDED', task_code: 'TA', limit: 'TIMES', used: 0, asked: 3, max: 2 } });
    expect(await propose(flow, { extensions: [{ task_code: 'TB', add_value: 1 }] })).toMatchObject({ status: 422, json: { code: 'PWF_EXTENSION_NOT_ALLOWED', task_code: 'TB' } });
    expect(await propose(flow, { extensions: [{ task_code: 'TC', add_value: 1 }] })).toMatchObject({ status: 422, json: { code: 'PWF_EXTENSION_NOT_ALLOWED', task_code: 'TC' } });
    expect(await propose(flow, { extensions: [{ task_code: 'ZZ', add_value: 1 }] })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'extensions[0].task_code' } });
    expect(await propose(flow, { overrides: { change: [{ task_code: 'TA', duration_working_days: 4 }] } })).toMatchObject({ status: 422, json: { code: 'PWF_EXTENSION_REQUIRED', task_code: 'TA' } });
    expect(await propose(flow, { overrides: { change: [{ task_code: 'TC', duration_working_days: 4 }] } })).toMatchObject({ status: 422, json: { code: 'PWF_EXTENSION_REQUIRED', task_code: 'TC', extension_allowed: false } });
    expect(await propose(flow, { overrides: { change: [{ task_code: 'CAL', duration_value: 12 }] } })).toMatchObject({ status: 422, json: { code: 'PWF_EXTENSION_REQUIRED', task_code: 'CAL' } });
    expect(await propose(flow, { overrides: { change: [{ task_code: 'CAL', duration_working_days: 6 }] } })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'overrides.change[0].duration_working_days' } });
    // The request is checked by the contract before the store: a line that adds nothing is not a request.
    expect((await propose(flow, { extensions: [{ task_code: 'TA', add_value: 0 }] })).status).toBeGreaterThanOrEqual(400);
    expect((await harness.owner(TENANT_A, [['select 1 from machvon.project_reschedule_proposal pr join machvon.project_workflow w on w.id = pr.workflow_id where w.project_id = $1::uuid', [flow.projectId]]])).length).toBe(0);

    // Lowering is an ordinary change, in the unit of the task.
    const lower = await propose(flow, { overrides: { change: [{ task_code: 'TA', duration_working_days: 2 }, { task_code: 'CAL', duration_value: 7 }] } });
    expect(lower.status).toBe(200);
    expect(await decide(flow, lower.json.proposal_id as string)).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
    expect((await call('GET', `/project-tasks/${flow.ids.CAL}`, MANAGER)).json).toMatchObject({ duration: { value: 7 }, duration_working_days: 5, planned_finish: rolled(addDays(START, 6)), extension: { times_used: 0, value_used: 0 } });
    expect((await call('GET', `/project-tasks/${flow.ids.TA}`, MANAGER)).json).toMatchObject({ duration_working_days: 2, extension: { times_used: 0, value_used: 0 } });
  });

  it('tells the approver why a proposal whose cap was spent since cannot be applied (409, nothing applied, still PROPOSED), and a rejection closes it without spending', async () => {
    const flow = await started();
    const proposed = await propose(flow, { extensions: [{ task_code: 'TA', add_value: 2 }] });
    expect(proposed.status).toBe(200);
    const proposalId = proposed.json.proposal_id as string;
    await harness.owner(TENANT_A, [['update machvon.project_task set extension_value_used = 4 where id = $1::uuid', [flow.ids.TA]]]);
    const refused = await decide(flow, proposalId);
    expect(refused).toMatchObject({ status: 409, json: { code: 'PWF_SCHEDULE_VERSION_CONFLICT', reason: 'EXTENSION_REFUSED', extension_code: 'PWF_EXTENSION_LIMIT_EXCEEDED', task_code: 'TA', limit: 'VALUE', used: 4, asked: 2, max: 5 } });
    expect((await call('GET', `/project-reschedules/${proposalId}`, CHECKER)).json.status).toBe('PROPOSED');
    expect((await call('GET', `/project-tasks/${flow.ids.TA}`, MANAGER)).json).toMatchObject({ duration_working_days: 3, planned_finish: workingDayAfter(START, 2), extension: { times_used: 0, value_used: 4 } });
    expect(await decide(flow, proposalId, 'REJECT')).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
    expect((await call('GET', `/project-tasks/${flow.ids.TA}`, MANAGER)).json).toMatchObject({ duration_working_days: 3, extension: { times_used: 0, value_used: 4 } });
  });

  it('adds up the approved extensions across proposals, lets exactly one of two approvals sent at once win, and refuses a task that is done', async () => {
    const flow = await started();
    const first = await propose(flow, { extensions: [{ task_code: 'TA', add_value: 2 }] });
    expect(first.status).toBe(200);
    const approvals = await Promise.all([decide(flow, first.json.proposal_id as string), decide(flow, first.json.proposal_id as string)]);
    expect(approvals.map((one) => one.status).sort()).toEqual([200, 409]);
    expect((await call('GET', `/project-tasks/${flow.ids.TA}`, MANAGER)).json).toMatchObject({ duration_working_days: 5, extension: { times_used: 1, value_used: 2 } });
    expect((await harness.owner(TENANT_A, [[`select 1 from machvon.project_task_log where task_id = $1::uuid and kind = 'TASK_EXTENDED'`, [flow.ids.TA]]])).length).toBe(1);

    // The second proposal is judged on what the first one spent: two of five days are used.
    const next = { ...flow, version: await versionOf(flow) };
    expect(await propose(next, { extensions: [{ task_code: 'TA', add_value: 4 }] })).toMatchObject({ status: 422, json: { code: 'PWF_EXTENSION_LIMIT_EXCEEDED', task_code: 'TA', limit: 'VALUE', used: 2, asked: 4, max: 5 } });
    const second = await propose(next, { extensions: [{ task_code: 'TA', add_value: 3 }] });
    expect(second.status).toBe(200);
    expect(await decide(next, second.json.proposal_id as string)).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
    expect((await call('GET', `/project-tasks/${flow.ids.TA}`, MANAGER)).json).toMatchObject({ duration_working_days: 8, planned_finish: workingDayAfter(START, 7), extension: { times_used: 2, value_used: 5 } });
    // The task behind it only followed: it has no rule and no counters of its own moved.
    expect((await harness.owner<{ t: number; v: number }>(TENANT_A, [['select extension_times_used as t, extension_value_used as v from machvon.project_task where id = $1::uuid', [flow.ids.TB]]]))[0]).toEqual({ t: 0, v: 0 });

    await harness.owner(TENANT_A, [[`update machvon.project_task set status = 'DONE', actual_start = $2::date, actual_finish = $2::date where id = $1::uuid`, [flow.ids.CAL, TODAY]]]);
    const last = { ...flow, version: await versionOf(flow) };
    expect(await propose(last, { extensions: [{ task_code: 'CAL', add_value: 1 }] })).toMatchObject({ status: 422, json: { code: 'PWF_EXTENSION_TASK_CLOSED', task_code: 'CAL' } });
  });
});

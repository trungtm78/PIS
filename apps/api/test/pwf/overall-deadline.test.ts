import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { MyWorkController } from '../../src/modules/home/my-work.controller';
import { ProjectTaskController, ProjectTaskReadsController } from '../../src/modules/pwf/task.controller';
import { ProjectWorkflowController, ProjectWorkflowReadsController } from '../../src/modules/pwf/workflow.controller';
import { ProjectController, ProjectReadsController } from '../../src/modules/prj/project.controller';
import { AuthzHarness, TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

/**
 * The deadline of the whole file over HTTP (docs PWF 22.2, 22.6, 22.8): the workflow of a project answers `overall_deadline` with the colour of the task the frozen template marks, the task rows say which one it is, and the
 * alert centre tells the one who answers for the project while that colour is yellow or red.
 */

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const YEAR = Number(TODAY.slice(0, 4));
const MANAGER = 1;
const WORKER = 2;
const CHECKER = 3;
const LEADER = 4;
const ROOT = 1;
const DEPARTMENT = 2;
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';

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
/** The workflow starts two working days from today: a task of three working days is due four working days from today. */
const START = workingDayAfter(TODAY, 2);
const DUE = workingDayAfter(TODAY, 4);

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
const TEMPLATE = {
  name: 'Overall deadline over HTTP',
  project_type: null,
  phases: [{ code: 'P1', name: 'Phase one', gates: [] }],
  tasks: [plain('OTHER'), plain('DEADLINE', { bands: { green_days: 10, yellow_days: 7, red_days: 4 } })],
  overall_deadline_task: 'DEADLINE',
};

interface Reply {
  status: number;
  json: Record<string, unknown>;
}
type Row = Record<string, unknown> & { task_code: string };

describe('the deadline of the whole file over HTTP (PWF 22.2, 22.6)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let projectId = '';
  let workflowId = '';
  let deadlineId = '';

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: string, url: string, member: number, body?: unknown): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const alertsOf = async (member: number, view = 'mine'): Promise<Array<Record<string, unknown>>> => {
    const reply = await call('GET', `/home/my-work?limit=100&view=${view}`, member);
    expect(reply.status).toBe(200);
    return (reply.json.items as Array<Record<string, unknown>>).filter((item) => item.kind === 'PWF_OVERALL_DEADLINE_AT_RISK');
  };

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
    ]);
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: SYSTEM_ACTOR, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, SYSTEM_ACTOR, TODAY));
    for (const n of [MANAGER, WORKER, CHECKER, LEADER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PWF_MANAGER', ['project.create', 'project.read', 'pwf.workflow.manage', 'pwf.read', 'pwf.task.work', 'pwf.task.assign', 'home.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'PWF_READER', ['project.read', 'pwf.read', 'home.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: LEADER, role: 2, kind: 'TENANT' },
      { n: 3, member: WORKER, role: 2, kind: 'TENANT' },
    ]);
    const recordId = randomUUID();
    const areaVersion = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'TINH-B', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(MANAGER)]],
      [`insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, valid_until, status, master_record_id, published_at, created_by, updated_by) values ($1, $2, 'AREA', 'TINH-B', 1, 'TINH-B', '{}'::jsonb, '2020-01-01', null, 'EFFECTIVE', $3, now(), $4, $4)`, [TENANT_A, areaVersion, recordId, memberId(MANAGER)]],
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
         values ($1, 'PROJECT_WORKFLOW_TEMPLATE', 'OVERALLAPI', 1, 'APPROVED', $2::jsonb, date '2020-01-01', 'A template for the tests', $3, $4, now(), $5, now())`,
        [TENANT_A, JSON.stringify(TEMPLATE), memberId(MANAGER), memberId(WORKER), memberId(CHECKER)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ProjectController, ProjectReadsController, ProjectWorkflowController, ProjectWorkflowReadsController, ProjectTaskController, ProjectTaskReadsController, MyWorkController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
    const made = await call('POST', '/projects', MANAGER, { code: `POD-${randomUUID().slice(0, 6)}`, name: 'Dự án cầu Rạch Miễu 3', owner_unit_id: unitId(DEPARTMENT), area_master_version_id: areaVersion, total_investment_vnd: '500000000000' });
    expect(made.status).toBe(200);
    projectId = made.json.resource_id as string;
    await harness.owner(TENANT_A, [
      [`update machvon.project set status = 'CONCEPT', project_group = 'B' where id = $1::uuid`, [projectId]],
      [
        `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, status, created_by, updated_by)
         values ($1, gen_random_uuid(), $2::uuid, $3::uuid, 'LEADER_IN_CHARGE', date '2020-01-01', 'ACTIVE', $4::uuid, $4::uuid)`,
        [TENANT_A, projectId, memberId(LEADER), memberId(MANAGER)],
      ],
    ]);
    const flow = await call('POST', `/projects/${projectId}/workflow`, MANAGER, { template_code: 'OVERALLAPI', planned_start_date: START, facts: { project_group: 'B' } });
    expect(flow.status).toBe(200);
    workflowId = flow.json.resource_id as string;
    const rows = await harness.owner<{ id: string }>(TENANT_A, [[`select id from machvon.project_task where project_id = $1::uuid and task_code = 'DEADLINE'`, [projectId]]]);
    deadlineId = rows[0]?.id as string;
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('answers the deadline of the whole file with the colour of the marked task, marks that task in the workflow and in the list, and alerts the one who answers for the project until the task is done', async () => {
    const workflow = await call('GET', `/projects/${projectId}/workflow`, MANAGER);
    expect(workflow.status).toBe(200);
    expect(workflow.json.overall_deadline).toEqual({ task_id: deadlineId, task_code: 'DEADLINE', task_name: 'Task DEADLINE', due_on: DUE, band: 'RED', band_tier: 'STEP', remaining_days: 4 });
    const tasks = workflow.json.tasks as Row[];
    const row = tasks.find((one) => one.task_code === 'DEADLINE') as Row & { band: { band: string; remaining_days: number }; band_tier: string; planned_finish: string };
    expect({ band: row.band.band, tier: row.band_tier, left: row.band.remaining_days, due: row.planned_finish }).toEqual({ band: 'RED', tier: 'STEP', left: 4, due: DUE });
    expect(tasks.map((one) => [one.task_code, one.is_overall_deadline]).sort()).toEqual([['DEADLINE', true], ['OTHER', false]]);

    const list = await call('GET', `/projects/${projectId}/workflow/tasks?limit=50`, MANAGER);
    expect(list.status).toBe(200);
    const listed = list.json.items as Array<Row & { band: { band: string } }>;
    expect(listed.map((one) => [one.task_code, one.is_overall_deadline]).sort()).toEqual([['DEADLINE', true], ['OTHER', false]]);
    expect(listed.find((one) => one.task_code === 'DEADLINE')?.band.band).toBe('RED');
    const full = await call('GET', `/project-tasks/${deadlineId}`, MANAGER);
    expect(full.json).toMatchObject({ band: { band: 'RED', remaining_days: 4 }, band_tier: 'STEP' });

    // The alert centre: the work of the one who answers for the project, one item for the workflow, red is to be acted on.
    const mine = await alertsOf(LEADER);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'PWF_OVERALL_DEADLINE_AT_RISK', source: 'PROJECT_TASK', severity: 'ACTION', title: 'Hạn chung của hồ sơ: còn 4 ngày làm việc' });
    expect(JSON.stringify(mine[0])).toContain(`${workflowId}:overall`);
    expect(await alertsOf(WORKER)).toEqual([]);
    expect(await alertsOf(MANAGER, 'scope')).toHaveLength(1);

    // The task is done: no alert for anyone, and the deadline of the whole file has no colour.
    await harness.owner(TENANT_A, [[`update machvon.project_task set status = 'DONE', actual_start = $2::date, actual_finish = $2::date where id = $1::uuid`, [deadlineId, TODAY]]]);
    expect(await alertsOf(LEADER)).toEqual([]);
    expect(await alertsOf(MANAGER, 'scope')).toEqual([]);
    const after = await call('GET', `/projects/${projectId}/workflow`, MANAGER);
    expect(after.json.overall_deadline).toMatchObject({ task_code: 'DEADLINE', band: 'NONE', band_tier: 'STEP' });
  });
});

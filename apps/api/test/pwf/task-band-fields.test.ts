import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { PwfDeadlineReadsController } from '../../src/modules/pwf/deadline.controller';
import { PwfPreferenceController } from '../../src/modules/pwf/preference.controller';
import { ProjectTaskController, ProjectTaskReadsController } from '../../src/modules/pwf/task.controller';
import { ProjectWorkflowController, ProjectWorkflowReadsController } from '../../src/modules/pwf/workflow.controller';
import { ProjectController, ProjectReadsController } from '../../src/modules/prj/project.controller';
import { AuthzHarness, TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

/**
 * PWF-5 over HTTP (docs PWF 22.5, R73): the task list, the task in full, the workflow, "my tasks" and the deadline board say the tier and the ladder of the official colour, the limit of the task in its own unit and the working days
 * it covers; the fields that were there keep their meaning; twins with one day and two ladders keep their own colours on every read.
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
const STEP_LADDER = { green_days: 10, yellow_days: 7, red_days: 4 };
const SYSTEM_LADDER = { green_days: 5, yellow_days: 2, red_days: 0 };

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
  name: 'Band flow over HTTP',
  project_type: null,
  phases: [{ code: 'P1', name: 'Phase one', gates: [] }],
  tasks: [plain('STEP', { bands: STEP_LADDER }), plain('POLICY'), plain('CALENDAR', { duration_working_days: 8, duration: { value: 10, unit: 'CALENDAR_DAY', roll_to_working_day: true } })],
};

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Explained {
  band_tier?: string;
  band_thresholds?: unknown;
  duration?: unknown;
  effective_working_days?: number | null;
}

describe('the tier, the ladder and the limit of a task over HTTP (PWF-5, R73)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let projectId = '';
  const ids: Record<string, string> = {};

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, member: number, body?: unknown): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
    ]);
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_SYSTEM, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER_SYSTEM, TODAY));
    for (const n of [MANAGER, WORKER, CHECKER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PWF_MANAGER', ['project.create', 'project.read', 'pwf.workflow.manage', 'pwf.read', 'pwf.task.work', 'pwf.task.assign'], 40);
    await harness.seedRole(TENANT_A, 2, 'PWF_WORKER', ['pwf.read', 'pwf.task.work'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: WORKER, role: 2, kind: 'TENANT' },
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
         values ($1, 'PROJECT_WORKFLOW_TEMPLATE', 'BANDAPI', 1, 'APPROVED', $2::jsonb, date '2020-01-01', 'A template for the tests', $3, $4, now(), $5, now())`,
        [TENANT_A, JSON.stringify(TEMPLATE), memberId(MANAGER), memberId(WORKER), memberId(CHECKER)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ProjectController, ProjectReadsController, ProjectWorkflowController, ProjectWorkflowReadsController, ProjectTaskController, ProjectTaskReadsController, PwfDeadlineReadsController, PwfPreferenceController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
    const made = await call('POST', '/projects', MANAGER, { code: `PWB-${randomUUID().slice(0, 6)}`, name: 'Dự án cầu Thủ Thiêm 4', owner_unit_id: unitId(DEPARTMENT), area_master_version_id: areaVersion, total_investment_vnd: '500000000000' });
    expect(made.status).toBe(200);
    projectId = made.json.resource_id as string;
    await harness.owner(TENANT_A, [[`update machvon.project set status = 'CONCEPT', project_group = 'B' where id = $1::uuid`, [projectId]]]);
    const flow = await call('POST', `/projects/${projectId}/workflow`, MANAGER, { template_code: 'BANDAPI', planned_start_date: START, facts: { project_group: 'B' } });
    expect(flow.status).toBe(200);
    const rows = await harness.owner<{ id: string; task_code: string }>(TENANT_A, [['select id, task_code from machvon.project_task where project_id = $1::uuid', [projectId]]]);
    for (const row of rows) ids[row.task_code] = row.id;
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.project_task_assignment (tenant_id, id, task_id, membership_id, role, valid_from, share_pct, reason, assigned_by)
         select $1, gen_random_uuid(), t.id, $2, 'RESPONSIBLE', date '2020-01-01', 100, 'Given by the test', $3 from machvon.project_task t where t.project_id = $4::uuid`,
        [TENANT_A, memberId(WORKER), memberId(MANAGER), projectId],
      ],
    ]);
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('says the same colour, tier and ladder of a task in the list, the workflow, the task, my tasks and the board, and keeps the fields that were there', async () => {
    const expected: Record<string, { band: string; tier: string; thresholds: unknown }> = {
      STEP: { band: 'RED', tier: 'STEP', thresholds: STEP_LADDER },
      POLICY: { band: 'GREEN', tier: 'SYSTEM', thresholds: SYSTEM_LADDER },
    };
    type Item = Explained & { id?: string; task_id?: string; task_code: string; band?: { band: string; remaining_days: number | null; unit: string }; official_band?: { band: string } };
    const seen = (items: Item[]): Record<string, { band: string; tier: string; thresholds: unknown }> =>
      Object.fromEntries(items.filter((item) => expected[item.task_code] !== undefined).map((item) => [item.task_code, { band: (item.band ?? item.official_band)?.band ?? '', tier: item.band_tier ?? '', thresholds: item.band_thresholds }]));

    const list = await call('GET', `/projects/${projectId}/workflow/tasks?limit=50`, MANAGER);
    expect(list.status).toBe(200);
    const listed = list.json.items as Item[];
    expect(seen(listed)).toEqual(expected);
    // What old readers read is still there, with its meaning: the band with its days left in working days, and the nominal working days of the limit.
    const step = listed.find((item) => item.task_code === 'STEP') as Item;
    expect(step.band).toMatchObject({ band: 'RED', remaining_days: 4, unit: 'WORKING' });
    expect(step).toMatchObject({ duration: null, effective_working_days: 3 });
    const calendar = listed.find((item) => item.task_code === 'CALENDAR') as Item;
    expect(calendar.duration).toEqual({ value: 10, unit: 'CALENDAR_DAY', roll_to_working_day: true });
    expect([7, 8]).toContain(calendar.effective_working_days);

    const workflow = await call('GET', `/projects/${projectId}/workflow`, MANAGER);
    expect(workflow.status).toBe(200);
    expect(seen(workflow.json.tasks as Item[])).toEqual(expected);
    expect(workflow.json.counts_by_band).toMatchObject({ RED: 1 });

    for (const code of Object.keys(expected)) {
      const one = await call('GET', `/project-tasks/${ids[code]}`, MANAGER);
      expect(one.status).toBe(200);
      expect(seen([one.json as unknown as Item])).toEqual({ [code]: expected[code] });
    }
    const full = await call('GET', `/project-tasks/${ids.CALENDAR}`, MANAGER);
    expect(full.json).toMatchObject({ duration: { value: 10, unit: 'CALENDAR_DAY', roll_to_working_day: true }, duration_working_days: 8, effective_working_days: calendar.effective_working_days });

    const mine = await call('GET', '/me/project-tasks?limit=50', WORKER);
    expect(mine.status).toBe(200);
    expect(seen(mine.json.items as Item[])).toEqual(expected);
    expect(mine.json.counts_by_band).toMatchObject({ RED: 1 });
    const mineRed = await call('GET', '/me/project-tasks?limit=50&band=RED', WORKER);
    expect((mineRed.json.items as Item[]).map((item) => item.task_code)).toEqual(['STEP']);
    expect(mineRed.json.total).toBe(1);

    const board = await call('GET', `/pwf/deadlines?limit=50&project_id=${projectId}`, MANAGER);
    expect(board.status).toBe(200);
    expect(seen(board.json.items as Item[])).toEqual(expected);
    expect(board.json.counts_by_band).toMatchObject({ RED: 1 });
    // The twins share their day, kind, priority, phase and unit: the colour filter of the board keeps the one whose own colour it is.
    const red = await call('GET', `/pwf/deadlines?limit=50&project_id=${projectId}&band=RED`, MANAGER);
    expect((red.json.items as Item[]).map((item) => item.task_code)).toEqual(['STEP']);
    expect(red.json.total).toBe(1);
    const green = await call('GET', `/pwf/deadlines?limit=50&project_id=${projectId}&band=GREEN`, MANAGER);
    expect((green.json.items as Item[]).map((item) => item.task_code)).toEqual(['POLICY']);
    expect(green.json.total).toBe(1);
  });
});

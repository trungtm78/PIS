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
import { AuthzHarness, TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

/**
 * The preview of a workflow template as the one owner of the dates of the chart (docs PWF 22.2 R56, R58, R59, 22.6 R74, 22.8): the limit and the working days of each task, the ladder of its colours with its tier and the days
 * each colour starts on, why a task has no date, the deadline of the whole file, the span of each step and the calendars used. `PROVISIONAL` counts a year nobody published on its latest draft and says so; a real start never
 * does. The preview stores nothing.
 *
 * The calendars of the test: 2031 and 2032 published (Monday to Friday); 2032 also has a later DRAFT revision that works Saturdays (never used: a published year is counted on what is published); 2033 has two drafts and no
 * published version (the latest works Saturdays); 2034 has nothing.
 */

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const MANAGER = 1;
const WORKER = 2;
const CHECKER = 3;
const ROOT = 1;
const DEPARTMENT = 2;
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';

const WEEKDAYS = [1, 2, 3, 4, 5];
const WITH_SATURDAY = [1, 2, 3, 4, 5, 6];
const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const isoWeekday = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
/** Whether a day is worked on the calendars a mode counts on: the drafts of 2033 work Saturdays. */
const worked = (day: string, provisional: boolean): boolean => (provisional && day.startsWith('2033') ? WITH_SATURDAY : WEEKDAYS).includes(isoWeekday(day));
/** The first day a deadline is at most `line` working days away (the days after it up to and including the deadline); the day after the deadline for a line of -1. */
const zoneFrom = (due: string, line: number, provisional = false): string => {
  if (line < 0) return addDays(due, 1);
  let day = due;
  for (let seen = 0; ; day = addDays(day, -1)) {
    if (worked(day, provisional)) seen += 1;
    if (seen > line) return day;
  }
};
const zonesOf = (due: string, ladder: { green_days: number | null; yellow_days: number; red_days: number }, provisional = false): Record<string, string | null> => ({
  green_from: ladder.green_days === null ? null : zoneFrom(due, ladder.green_days, provisional),
  yellow_from: zoneFrom(due, ladder.yellow_days, provisional),
  red_from: zoneFrom(due, ladder.red_days, provisional),
});

const STEP_LADDER = { green_days: 10, yellow_days: 5, red_days: 2 };
const OPEN_LADDER = { yellow_days: 3, red_days: -1 };
const SYSTEM_LADDER = { green_days: 5, yellow_days: 2, red_days: 0 };
const POLICY_LADDER = { green_days: 8, yellow_days: 4, red_days: 1 };
const OVERRIDE_LADDER = { green_days: 40, yellow_days: 20, red_days: 10 };

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
const after = (task: string): Array<Record<string, unknown>> => [{ task, kind: 'FS', lag_working_days: 0 }];

/**
 * T_STEP (five working days, a ladder of its own) then T_POLICY (three, HIGH priority) in phase P1; T_CAL (ten calendar days), T_MONTH (two months, the deadline of the whole file, a ladder without a green line) and T_LONG (three
 * hundred working days) in P2; T_BRANCH only in a project of group A, alone in P3.
 */
const TEMPLATE = {
  name: 'Preview flow',
  project_type: null,
  phases: [
    { code: 'P1', name: 'Phase one', gates: [] },
    { code: 'P2', name: 'Phase two', gates: [] },
    { code: 'P3', name: 'Phase three', gates: [] },
  ],
  tasks: [
    plain('T_STEP', { duration_working_days: 5, bands: STEP_LADDER }),
    plain('T_POLICY', { priority: 'HIGH', predecessors: after('T_STEP') }),
    plain('T_CAL', { phase: 'P2', duration_working_days: 8, duration: { value: 10, unit: 'CALENDAR_DAY', roll_to_working_day: true }, predecessors: after('T_POLICY') }),
    plain('T_MONTH', { phase: 'P2', duration_working_days: 44, duration: { value: 2, unit: 'MONTH', roll_to_working_day: true }, bands: OPEN_LADDER, predecessors: after('T_CAL') }),
    plain('T_LONG', { phase: 'P2', duration_working_days: 300, predecessors: after('T_MONTH') }),
    plain('T_BRANCH', { phase: 'P3', when: [{ field: 'project_group', in: ['A'] }] }),
  ],
  overall_deadline_task: 'T_MONTH',
};

interface Reply {
  status: number;
  json: Record<string, unknown>;
}
type Row = Record<string, unknown> & { task_code: string };

describe('the preview of a workflow template owns the dates of the chart (R56, R74)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let areaVersion = '';

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: string, url: string, member: number, body?: unknown): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const preview = (body: Record<string, unknown>, params: unknown = TEMPLATE): Promise<Reply> => call('POST', '/project-workflow/templates/preview', MANAGER, { params, facts: { project_group: 'B' }, ...body });
  const tasksOf = (reply: Reply): Record<string, Row> => Object.fromEntries((reply.json.tasks as Row[]).map((one) => [one.task_code, one]));
  const stepsOf = (reply: Reply): Record<string, Record<string, unknown>> => Object.fromEntries((reply.json.steps as Array<Record<string, unknown>>).map((one) => [one.step_code as string, one]));
  const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

  const calendar = (year: number, revision: number, days: number[], status: 'Published' | 'Draft'): [string, unknown[]] => [
    `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
     values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, $3, $4::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', $5, $6, case when $5 = 'Draft' then null else $6::uuid end, case when $5 = 'Draft' then null else now() end)`,
    [TENANT_A, year, revision, JSON.stringify(days), status, memberId(MANAGER)],
  ];

  /** The rows a preview must never touch, counted and summed up: the calendars, the rules, the projects and everything of their workflows. */
  const footprint = async (): Promise<unknown> =>
    (
      await owner<{ j: unknown }>(
        `select jsonb_build_object(
           'calendars', (select jsonb_agg(jsonb_build_array(year, revision, status, version) order by year, revision) from machvon.work_calendar_version where tenant_id = $1),
           'rules', (select jsonb_agg(jsonb_build_array(rule_type, code, version, status, row_version) order by rule_type, code, version) from machvon.governance_rule where tenant_id = $1),
           'projects', (select count(*) from machvon.project where tenant_id = $1),
           'workflows', (select coalesce(sum(version), 0) from machvon.project_workflow where tenant_id = $1),
           'tasks', (select coalesce(sum(version), 0) from machvon.project_task where tenant_id = $1),
           'schedules', (select count(*) from machvon.project_schedule_version where tenant_id = $1)) as j`,
        [TENANT_A],
      )
    )[0]?.j;

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
    ]);
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: SYSTEM_ACTOR, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, SYSTEM_ACTOR, TODAY));
    for (const n of [MANAGER, WORKER, CHECKER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PWF_MANAGER', ['project.create', 'project.read', 'pwf.workflow.manage', 'pwf.template.manage', 'pwf.read', 'pwf.task.work', 'pwf.task.assign'], 40);
    await harness.seedGrants(TENANT_A, [{ n: 1, member: MANAGER, role: 1, kind: 'TENANT' }]);
    const recordId = randomUUID();
    areaVersion = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'TINH-B', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(MANAGER)]],
      [`insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, valid_until, status, master_record_id, published_at, created_by, updated_by) values ($1, $2, 'AREA', 'TINH-B', 1, 'TINH-B', '{}'::jsonb, '2020-01-01', null, 'EFFECTIVE', $3, now(), $4, $4)`, [TENANT_A, areaVersion, recordId, memberId(MANAGER)]],
    ]);
    await harness.owner(TENANT_A, [
      calendar(2031, 1, WEEKDAYS, 'Published'),
      calendar(2032, 1, WEEKDAYS, 'Published'),
      calendar(2032, 2, WITH_SATURDAY, 'Draft'),
      calendar(2033, 1, WEEKDAYS, 'Draft'),
      calendar(2033, 2, WITH_SATURDAY, 'Draft'),
    ]);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
         values ($1, 'PROJECT_WORKFLOW_TEMPLATE', 'PREVIEWAPI', 1, 'APPROVED', $2::jsonb, date '2020-01-01', 'A template for the tests', $3, $4, now(), $5, now())`,
        [TENANT_A, JSON.stringify(TEMPLATE), memberId(MANAGER), memberId(WORKER), memberId(CHECKER)],
      ],
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

  it('answers the limit, the working days, the ladder with its tier, the zones, the steps, the deadline of the whole file and the calendars; a cut branch says NOT_IN_PROJECT; nothing is stored', async () => {
    const before = await footprint();
    // 3 March 2031 is a Monday; everything up to the two months lies in 2031 and the long task ends in 2032, both published.
    const reply = await preview({ planned_start_date: '2031-03-03' });
    expect(reply.status).toBe(200);
    const tasks = tasksOf(reply);

    // What the preview always said is still said, with its meaning.
    expect(reply.json).toMatchObject({ planned_start_date: '2031-03-03', project_start: '2031-03-03', excluded_tasks: ['T_BRANCH'], calendar_versions: [{ year: 2031, version: 1 }, { year: 2032, version: 1 }] });
    expect(tasks.T_STEP).toMatchObject({ kind: 'TASK', state: 'SCHEDULED', start: '2031-03-03', finish: '2031-03-07', missing_year: null });

    // The mode and where each year came from.
    expect(reply.json).toMatchObject({ calendar_mode: 'PUBLISHED', provisional: false });
    expect(reply.json.calendars).toEqual([{ year: 2031, version: 1, status: 'PUBLISHED' }, { year: 2032, version: 1, status: 'PUBLISHED' }]);

    // A task with a ladder of its own: tier STEP, and the zones are that ladder counted back from its finish (Friday 7 March).
    expect(tasks.T_STEP).toMatchObject({ duration: null, effective_working_days: 5, provisional: false, band_tier: 'STEP', band_thresholds: STEP_LADDER, undated_reason: null, is_overall_deadline: false });
    expect(tasks.T_STEP?.band_zones).toEqual({ green_from: '2031-02-21', yellow_from: '2031-02-28', red_from: '2031-03-05' });
    expect(tasks.T_STEP?.band_zones).toEqual(zonesOf('2031-03-07', STEP_LADDER));
    // A task without one follows what is in force today: nobody approved a policy, so the default of the source (SYSTEM).
    expect(tasks.T_POLICY).toMatchObject({ start: '2031-03-10', finish: '2031-03-12', effective_working_days: 3, band_tier: 'SYSTEM', band_thresholds: SYSTEM_LADDER });
    expect(tasks.T_POLICY?.band_zones).toEqual(zonesOf('2031-03-12', SYSTEM_LADDER));
    expect(tasks.T_POLICY?.band_zones).toEqual({ green_from: '2031-03-05', yellow_from: '2031-03-10', red_from: '2031-03-12' });

    // Ten calendar days from Thursday 13 March end on Saturday 22 March and roll to Monday 24; two months from Tuesday 25 March end on Sunday 25 May and roll to Monday 26.
    expect(tasks.T_CAL).toMatchObject({ start: '2031-03-13', finish: '2031-03-24', duration: { value: 10, unit: 'CALENDAR_DAY', roll_to_working_day: true }, effective_working_days: 8, band_tier: 'SYSTEM' });
    expect(tasks.T_MONTH).toMatchObject({ start: '2031-03-25', finish: '2031-05-26', duration: { value: 2, unit: 'MONTH', roll_to_working_day: true }, effective_working_days: 45, band_tier: 'STEP', is_overall_deadline: true });
    // A ladder without a green line has no green day; a red line of -1 starts the day after the deadline.
    expect(tasks.T_MONTH?.band_thresholds).toEqual({ green_days: null, yellow_days: 3, red_days: -1 });
    expect(tasks.T_MONTH?.band_zones).toEqual({ green_from: null, yellow_from: '2031-05-21', red_from: '2031-05-27' });

    // The deadline of the whole file is the finish of the task the template marks, with the zones of that very task.
    expect(reply.json.overall_deadline).toEqual({ task_code: 'T_MONTH', finish: '2031-05-26', state: 'SCHEDULED', provisional: false, band_zones: tasks.T_MONTH?.band_zones });

    // The branch the sample facts leave out has no date and says why.
    expect(tasks.T_BRANCH).toMatchObject({ state: 'PASS_THROUGH', start: null, finish: null, effective_working_days: null, band_zones: null, undated_reason: { code: 'NOT_IN_PROJECT' }, provisional: false });

    // The steps (one per phase here): start, finish and working days read from their tasks.
    const steps = stepsOf(reply);
    expect(steps.P1).toEqual({ step_code: 'P1', phase_code: 'P1', name: 'Phase one', start: '2031-03-03', finish: '2031-03-12', working_days: 8, task_count: 2, provisional: false, undated_reason: null });
    expect(steps.P2).toMatchObject({ start: '2031-03-13', finish: tasks.T_LONG?.finish, working_days: 8 + 45 + 300, task_count: 3, provisional: false, undated_reason: null });
    expect(steps.P3).toEqual({ step_code: 'P3', phase_code: 'P3', name: 'Phase three', start: null, finish: null, working_days: null, task_count: 0, provisional: false, undated_reason: { code: 'NOT_IN_PROJECT' } });

    // With the facts that keep the branch it is dated; with the deadline on the cut branch the file has no deadline (no other task stands in).
    const kept = await preview({ planned_start_date: '2031-03-03', facts: { project_group: 'A' } });
    expect(tasksOf(kept).T_BRANCH).toMatchObject({ state: 'SCHEDULED', start: '2031-03-03', undated_reason: null });
    const cut = await preview({ planned_start_date: '2031-03-03' }, { ...TEMPLATE, overall_deadline_task: 'T_BRANCH' });
    expect(cut.json.overall_deadline).toBeNull();
    expect(tasksOf(cut).T_BRANCH).toMatchObject({ is_overall_deadline: true, undated_reason: { code: 'NOT_IN_PROJECT' } });
    const none = await preview({ planned_start_date: '2031-03-03' }, { ...TEMPLATE, overall_deadline_task: undefined });
    expect(none.json.overall_deadline).toBeNull();

    expect(await footprint()).toEqual(before);
  });

  it('PUBLISHED is what the preview always was: the default, with the same schedule and hash, and a year nobody published has no date and names the year', async () => {
    // 20 December 2032 is a Monday: the first two tasks end in 2032, the calendar-day task starts on 30 December and would end in 2033.
    const byDefault = await preview({ planned_start_date: '2032-12-20' });
    const published = await preview({ planned_start_date: '2032-12-20', calendar_mode: 'PUBLISHED' });
    expect(byDefault.status).toBe(200);
    const strip = (json: Record<string, unknown>): Record<string, unknown> => ({ ...json, as_of: null });
    expect(strip(published.json)).toEqual(strip(byDefault.json));
    expect(published.json).toMatchObject({ calendar_mode: 'PUBLISHED', provisional: false, project_finish: null, calendar_versions: [{ year: 2032, version: 1 }] });
    // The draft revision 2 of 2032 is not what 2032 is counted on.
    expect(published.json.calendars).toEqual([{ year: 2032, version: 1, status: 'PUBLISHED' }]);
    const tasks = tasksOf(published);
    expect(tasks.T_STEP).toMatchObject({ start: '2032-12-20', finish: '2032-12-24', undated_reason: null, provisional: false });
    expect(tasks.T_POLICY).toMatchObject({ start: '2032-12-27', finish: '2032-12-29', undated_reason: null });
    // R58 "missing calendar": a limit in calendar days or months that reaches a year without a calendar has no date either, never a guessed one.
    for (const code of ['T_CAL', 'T_MONTH', 'T_LONG']) {
      expect(tasks[code]).toMatchObject({ state: 'CALENDAR_UNAVAILABLE', start: null, finish: null, missing_year: 2033, effective_working_days: null, band_zones: null, undated_reason: { code: 'CALENDAR_MISSING', year: 2033 }, provisional: false });
    }
    expect(published.json.overall_deadline).toEqual({ task_code: 'T_MONTH', finish: null, state: 'CALENDAR_UNAVAILABLE', provisional: false, band_zones: null });
    expect(stepsOf(published).P2).toMatchObject({ start: null, finish: null, working_days: null, undated_reason: { code: 'CALENDAR_MISSING', year: 2033 } });
    // Every task without a date says why.
    for (const one of Object.values(tasks)) expect(one.finish === null).toBe(one.undated_reason !== null);
  });

  it('PROVISIONAL counts a year nobody published on its latest draft, flags what it touched, and leaves a year with no draft without a date', async () => {
    const before = await footprint();
    const reply = await preview({ planned_start_date: '2032-12-20', calendar_mode: 'PROVISIONAL' });
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ calendar_mode: 'PROVISIONAL', provisional: true });
    // 2032 on what is published (not on its draft revision 2), 2033 on its LATEST draft (revision 2, not 1).
    expect(reply.json.calendars).toEqual([{ year: 2032, version: 1, status: 'PUBLISHED' }, { year: 2033, version: 2, status: 'DRAFT' }]);
    const tasks = tasksOf(reply);
    // What lies in the published year is the same as in the published mode and is not provisional.
    expect(tasks.T_STEP).toMatchObject({ start: '2032-12-20', finish: '2032-12-24', provisional: false });
    expect(tasks.T_POLICY).toMatchObject({ start: '2032-12-27', finish: '2032-12-29', provisional: false });
    // Ten calendar days from Thursday 30 December end on Saturday 8 January 2033, a working day on the draft (revision 1 would roll it to Monday 10).
    expect(tasks.T_CAL).toMatchObject({ state: 'SCHEDULED', start: '2032-12-30', finish: '2033-01-08', provisional: true, undated_reason: null });
    expect(tasks.T_MONTH).toMatchObject({ state: 'SCHEDULED', start: '2033-01-10', finish: '2033-03-10', provisional: true, is_overall_deadline: true });
    expect(tasks.T_MONTH?.band_zones).toEqual(zonesOf('2033-03-10', { green_days: null, ...OPEN_LADDER }, true));
    // Three hundred working days from 11 March 2033 run past the end of 2033, and 2034 has no calendar at all: no date, and the year is named.
    expect(tasks.T_LONG).toMatchObject({ state: 'CALENDAR_UNAVAILABLE', start: null, finish: null, undated_reason: { code: 'CALENDAR_MISSING', year: 2034 }, band_zones: null });
    expect(reply.json.overall_deadline).toEqual({ task_code: 'T_MONTH', finish: '2033-03-10', state: 'SCHEDULED', provisional: true, band_zones: tasks.T_MONTH?.band_zones });
    const steps = stepsOf(reply);
    expect(steps.P1).toMatchObject({ start: '2032-12-20', finish: '2032-12-29', working_days: 8, provisional: false, undated_reason: null });
    expect(steps.P2).toMatchObject({ start: '2032-12-30', finish: null, working_days: null, provisional: true, undated_reason: { code: 'CALENDAR_MISSING', year: 2034 } });
    for (const one of Object.values(tasks)) expect(one.finish === null).toBe(one.undated_reason !== null);

    // A start inside the draft year: in the published mode nothing has a date; provisionally six working days from Monday 3 January 2033 end on Saturday 8.
    const single = { ...TEMPLATE, phases: [TEMPLATE.phases[0]], overall_deadline_task: undefined, tasks: [plain('T_SIX', { duration_working_days: 6 })] };
    const dark = await preview({ planned_start_date: '2033-01-03' }, single);
    expect(dark.json).toMatchObject({ project_start: null, provisional: false, calendars: [] });
    expect(tasksOf(dark).T_SIX).toMatchObject({ state: 'CALENDAR_UNAVAILABLE', undated_reason: { code: 'CALENDAR_MISSING', year: 2033 } });
    const lit = await preview({ planned_start_date: '2033-01-03', calendar_mode: 'PROVISIONAL' }, single);
    expect(tasksOf(lit).T_SIX).toMatchObject({ state: 'SCHEDULED', start: '2033-01-03', finish: '2033-01-08', provisional: true });
    expect(lit.json.calendars).toEqual([{ year: 2033, version: 2, status: 'DRAFT' }]);
    // With a ladder whose green line is ten working days the zones reach back into December 2032, a published year: both years are named, and the count crosses Saturday 1 January 2033, worked on the draft.
    const reach = await preview({ planned_start_date: '2033-01-03', calendar_mode: 'PROVISIONAL' }, { ...single, tasks: [plain('T_SIX', { duration_working_days: 6, bands: STEP_LADDER })] });
    expect(tasksOf(reach).T_SIX?.band_zones).toEqual({ green_from: '2032-12-28', yellow_from: '2033-01-03', red_from: '2033-01-06' });
    expect(tasksOf(reach).T_SIX?.band_zones).toEqual(zonesOf('2033-01-08', STEP_LADDER, true));
    expect(reach.json.calendars).toEqual([{ year: 2032, version: 1, status: 'PUBLISHED' }, { year: 2033, version: 2, status: 'DRAFT' }]);

    // A mode nobody knows is refused, and nothing was stored by any of it.
    expect((await preview({ planned_start_date: '2033-01-03', calendar_mode: 'DRAFT' })).status).toBeGreaterThanOrEqual(400);
    expect(await footprint()).toEqual(before);
  });

  it('a real start never reads a draft calendar: the task the provisional preview dates is CALENDAR_UNAVAILABLE in the project', async () => {
    const made = await call('POST', '/projects', MANAGER, { code: `PVW-${randomUUID().slice(0, 6)}`, name: 'Dự án đường vành đai 5', owner_unit_id: unitId(DEPARTMENT), area_master_version_id: areaVersion, total_investment_vnd: '500000000000' });
    expect(made.status).toBe(200);
    const projectId = made.json.resource_id as string;
    await owner(`update machvon.project set status = 'CONCEPT', project_group = 'B' where id = $1::uuid`, [projectId]);
    const started = await call('POST', `/projects/${projectId}/workflow`, MANAGER, { template_code: 'PREVIEWAPI', planned_start_date: '2032-12-20', facts: { project_group: 'B' } });
    expect(started.status).toBe(200);
    const rows = await owner<{ task_code: string; state: string; planned_start: string | null; planned_finish: string | null; missing_year: number | null }>(
      'select task_code, state, planned_start::text as planned_start, planned_finish::text as planned_finish, missing_year from machvon.project_task where project_id = $1::uuid',
      [projectId],
    );
    const stored = Object.fromEntries(rows.map((row) => [row.task_code, row]));
    expect(stored.T_POLICY).toMatchObject({ state: 'SCHEDULED', planned_finish: '2032-12-29' });
    for (const code of ['T_CAL', 'T_MONTH', 'T_LONG']) expect(stored[code]).toMatchObject({ state: 'CALENDAR_UNAVAILABLE', planned_finish: null, missing_year: 2033 });
    // The schedule that was published pins 2032 at its published revision and no draft.
    const pins = await owner<{ pins: unknown }>('select v.calendar_versions as pins from machvon.project_schedule_version v join machvon.project_workflow w on w.id = v.workflow_id where w.project_id = $1::uuid', [projectId]);
    expect(pins.map((row) => row.pins)).toEqual([[{ year: 2032, version: 1 }]]);
    // The same template previewed provisionally on the same day dates those tasks: the two answers differ exactly by the draft.
    const provisional = tasksOf(await preview({ planned_start_date: '2032-12-20', calendar_mode: 'PROVISIONAL' }));
    expect(provisional.T_CAL).toMatchObject({ state: 'SCHEDULED', finish: '2033-01-08', provisional: true });
    // And the workflow of the project, read back, still has no day for them.
    const workflow = await call('GET', `/projects/${projectId}/workflow`, MANAGER);
    const read = Object.fromEntries((workflow.json.tasks as Row[]).map((one) => [one.task_code, one]));
    expect(read.T_CAL).toMatchObject({ state: 'CALENDAR_UNAVAILABLE', planned_finish: null });
  });

  it('follows the policy in force today for a task without a ladder of its own: POLICY, and POLICY_OVERRIDE where an override fits', async () => {
    await owner(
      `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
       values ($1, 'DEADLINE_BAND_POLICY', 'PROJECT_TASK', 1, 'APPROVED', $2::jsonb, date '2020-01-01', 'A policy for the tests', $3, $4, now(), $5, now())`,
      [TENANT_A, JSON.stringify({ unit: 'WORKING', ...POLICY_LADDER, overrides: [{ match: { priority: 'HIGH' }, ...OVERRIDE_LADDER }], reminder_days: [5, 2, 0, -1], escalate_after_overdue_days: 3 }), memberId(MANAGER), memberId(WORKER), memberId(CHECKER)],
    );
    const tasks = tasksOf(await preview({ planned_start_date: '2031-03-03' }));
    // The ladder of the step still wins over the policy.
    expect(tasks.T_STEP).toMatchObject({ band_tier: 'STEP', band_thresholds: STEP_LADDER });
    expect(tasks.T_CAL).toMatchObject({ band_tier: 'POLICY', band_thresholds: POLICY_LADDER });
    expect(tasks.T_CAL?.band_zones).toEqual(zonesOf('2031-03-24', POLICY_LADDER));
    expect(tasks.T_CAL?.band_zones).toEqual({ green_from: '2031-03-12', yellow_from: '2031-03-18', red_from: '2031-03-21' });
    expect(tasks.T_POLICY).toMatchObject({ band_tier: 'POLICY_OVERRIDE', band_thresholds: OVERRIDE_LADDER });
    // Forty working days back from 12 March 2031 reach January 2031: still inside the published year.
    expect(tasks.T_POLICY?.band_zones).toEqual(zonesOf('2031-03-12', OVERRIDE_LADDER));
  });
});

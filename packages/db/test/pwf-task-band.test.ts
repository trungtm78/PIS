import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import { HomeWorkStore } from '../src/home-work-store';
import type { WorkInput } from '../src/home-work-store';
import { severityOf } from '../src/home-work-rules';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { PrjProjectStore } from '../src/prj-project-store';
import { PwfDeadlineReads } from '../src/pwf-deadline-reads';
import { PwfMyTaskReads } from '../src/pwf-my-tasks';
import { loadLinks, loadTasks, scheduleTasksOf } from '../src/pwf-schedule-support';
import { PwfTaskReads } from '../src/pwf-task-reads';
import { PwfTaskReminders } from '../src/pwf-task-reminders';
import { PwfTaskStore, refreshSchedule } from '../src/pwf-task-store';
import { PwfWorkflowReads } from '../src/pwf-workflow-reads';
import { PwfWorkflowStore } from '../src/pwf-workflow-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from './support/authz-fixtures';

jest.setTimeout(600_000);

/**
 * PWF-5 (docs PWF 22.5, R58, R59, R73): the ladder and the limit the frozen template gives a task are written on its row when the workflow is made, and ONE resolution colours the task on every surface: the list and the
 * detail of the tasks, "my tasks", the deadline board (its counts and its colour filter), the reminders and the alert centre.
 */

const harness = new AuthzHarness();
const projects = new PrjProjectStore();
const workflows = new PwfWorkflowStore();
const tasks = new PwfTaskStore();
const workflowReads = new PwfWorkflowReads();
const taskReads = new PwfTaskReads();
const myTasks = new PwfMyTaskReads();
const board = new PwfDeadlineReads();
const reminders = new PwfTaskReminders();
const work = new HomeWorkStore();

const MANAGER = 1;
const WORKER = 2;
const CHECKER = 3;
const PROVINCE = 1;
const DEPARTMENT = 2;
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';
const NOW = new Date();
const TODAY = vietnamDateOf(NOW);
const YEAR = Number(TODAY.slice(0, 4));
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const scopes = { act: everything, read: everything };
const CAN = { manage: true, proposeReschedule: true, work: true, approve: true, assign: true };

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** The calendar of the test: Monday to Friday, no holidays. */
const worked = (day: string): boolean => ![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
/** The day that is `count` working days after `from`. */
const workingDayAfter = (from: string, count: number): string => {
  let cursor = from;
  for (let left = count; left > 0; ) {
    cursor = addDays(cursor, 1);
    if (worked(cursor)) left -= 1;
  }
  return cursor;
};
const workedDaysBetween = (from: string, to: string): number => {
  let count = 0;
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) if (worked(cursor)) count += 1;
  return count;
};

/** The workflow starts two working days from today, so a task of three working days is due four working days from today. */
const START = workingDayAfter(TODAY, 2);
const DUE_SOON = workingDayAfter(TODAY, 4);
const STEP_LADDER = { green_days: 10, yellow_days: 7, red_days: 4 };
const FAR_LADDER = { green_days: 30, yellow_days: 2, red_days: 0 };
const SYSTEM_LADDER = { green_days: 5, yellow_days: 2, red_days: 0 };

const plain = (code: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  code,
  name: `Task ${code}`,
  phase: 'P1',
  kind: 'TASK',
  duration_working_days: 3,
  required: true,
  responsible_role: 'WORKER_ROLE',
  priority: 'NORMAL',
  predecessors: [],
  legal_doc_types: [],
  form_templates: [],
  checklist: [],
  kpi_codes: [],
  when: [],
  ...over,
});

/**
 * STEP and POLICY are twins: the same day, kind, priority and phase; only STEP has a ladder of its own. FAR_STEP and FAR_POLICY are twins twenty-two working days away. CALENDAR has a limit of ten calendar days and is the one
 * task of high priority (an override of a policy can match it).
 */
const BANDFLOW = {
  name: 'Band flow',
  phases: [{ code: 'P1', name: 'Phase one', gates: [] }],
  tasks: [
    plain('STEP', { bands: STEP_LADDER }),
    plain('POLICY'),
    plain('FAR_STEP', { duration_working_days: 21, bands: FAR_LADDER }),
    plain('FAR_POLICY', { duration_working_days: 21 }),
    plain('CALENDAR', { priority: 'HIGH', duration_working_days: 8, duration: { value: 10, unit: 'CALENDAR_DAY', roll_to_working_day: true } }),
  ],
};
/** The same tasks with none of the new fields: what every template was before. */
const OLDFLOW = { name: 'Old flow', phases: BANDFLOW.phases, tasks: [plain('STEP'), plain('POLICY')] };

const as = <T>(run: (tx: TenantTx) => Promise<T>, member = MANAGER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), run);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

let areaVersion = '';
let counter = 0;

async function template(code: string, params: unknown): Promise<void> {
  await owner(
    `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
     values ($1, 'PROJECT_WORKFLOW_TEMPLATE', $2, 1, 'APPROVED', $3::jsonb, date '2020-01-01', 'A template for the tests', $4, $5, now(), $6, now())`,
    [TENANT_A, code, JSON.stringify(params), memberId(MANAGER), memberId(WORKER), memberId(CHECKER)],
  );
}

async function policy(params: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  counter += 1;
  await owner(
    `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
     values ($1, $2, 'DEADLINE_BAND_POLICY', 'PROJECT_TASK', $3, 'APPROVED', $4::jsonb, date '2020-01-01', 'A policy for the tests', $5, $6, now(), $7, now())`,
    [TENANT_A, id, counter, JSON.stringify(params), memberId(MANAGER), memberId(WORKER), memberId(CHECKER)],
  );
  return id;
}

interface Started {
  projectId: string;
  workflowId: string;
  ids: Record<string, string>;
}

/** A project of the department with a workflow of the template, every task of it given to the worker. */
async function started(templateCode: string): Promise<Started> {
  counter += 1;
  const code = `PB-${counter}-${randomUUID().slice(0, 6)}`;
  const created = await as((tx) => projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(DEPARTMENT), areaMasterVersionId: areaVersion, totalInvestmentVnd: '500000000000' }, memberId(MANAGER), TODAY));
  await owner(`update machvon.project set status = 'CONCEPT', project_group = 'B' where id = $1::uuid`, [created.id]);
  const workflow = await as((tx) => workflows.start(tx, { projectId: created.id, templateCode, plannedStartDate: START, facts: { project_group: 'B' }, actor: memberId(MANAGER), scopes, now: NOW }));
  const rows = await owner<{ id: string; task_code: string }>('select id, task_code from machvon.project_task where workflow_id = $1::uuid', [workflow.id]);
  for (const row of rows) {
    await as((tx) => tasks.assign(tx, { taskId: row.id, actor: memberId(MANAGER), scopes, today: TODAY, input: { membershipId: memberId(WORKER), role: 'RESPONSIBLE', validFrom: '2020-01-01', sharePct: 100, reason: 'Assigned for the test' } }));
  }
  return { projectId: created.id, workflowId: workflow.id, ids: Object.fromEntries(rows.map((row) => [row.task_code, row.id])) };
}

const stored = async (workflowId: string): Promise<Record<string, Record<string, unknown>>> =>
  Object.fromEntries((await owner<{ j: Record<string, unknown> }>('select to_jsonb(t) as j from machvon.project_task t where workflow_id = $1::uuid', [workflowId])).map((row) => [row.j.task_code as string, row.j]));

interface Colour {
  band: string;
  tier?: string;
  thresholds?: unknown;
}

/** The official colour of each task of the workflow on every surface, on one reading day. */
async function surfaces(flow: Started): Promise<{
  list: Record<string, Colour>;
  detail: Record<string, Colour>;
  workflowCounts: Record<string, number>;
  mine: Record<string, Colour>;
  mineCounts: Record<string, number>;
  board: Record<string, Colour>;
  boardCounts: Record<string, number>;
  boardFilter: (band: string) => Promise<{ codes: string[]; total: number }>;
  mineFilter: (band: string) => Promise<{ codes: string[]; total: number }>;
  listFilter: (band: string) => Promise<string[]>;
  reminderSeverity: Record<string, string>;
  alertSeverity: Record<string, string>;
}> {
  const codeOf = new Map(Object.entries(flow.ids).map(([code, id]) => [id, code] as const));
  const listed = await as((tx) => workflowReads.listTasks(tx, everything, flow.projectId, {}, { limit: 50 }, NOW));
  const list = Object.fromEntries(listed.items.map((item) => [item.task_code, { band: item.band.band, tier: item.band_tier, thresholds: item.band_thresholds }]));
  const detail: Record<string, Colour> = {};
  for (const [code, id] of Object.entries(flow.ids)) {
    const one = (await as((tx) => taskReads.task(tx, everything, id, NOW, memberId(MANAGER), CAN))) as { band: { band: string }; band_tier: string; band_thresholds: unknown };
    detail[code] = { band: one.band.band, tier: one.band_tier, thresholds: one.band_thresholds };
  }
  const whole = (await as((tx) => workflowReads.detail(tx, everything, flow.projectId, NOW, CAN))) as { counts_by_band: Record<string, number> };
  type MinePage = { items: Array<{ task_id: string; official_band: { band: string }; band_tier: string; band_thresholds: unknown }>; total: number; counts_by_band: Record<string, number> };
  const minePage = (filter: Record<string, string> = {}): Promise<MinePage> => as((tx) => myTasks.list(tx, everything, memberId(WORKER), filter, { limit: 50 }, NOW), WORKER) as Promise<MinePage>;
  const own = await minePage();
  type BoardPage = { items: Array<{ task_id: string; band: { band: string }; band_tier: string; band_thresholds: unknown }>; total: number; counts_by_band: Record<string, number> };
  const boardPage = (filter: Record<string, string> = {}): Promise<BoardPage> => as((tx) => board.board(tx, everything, { projectId: flow.projectId, ...filter }, { limit: 50 }, NOW)) as Promise<BoardPage>;
  const onBoard = await boardPage();
  // The reminders are read in a transaction that is rolled back, so the same points can be read again by the next call.
  const notices = await as(async (tx) => {
    await tx.query('savepoint reminders');
    const fired = await reminders.fire(tx, NOW);
    await tx.query('rollback to savepoint reminders');
    return fired;
  });
  const alerts = await as((tx) => work.collect(tx, { membershipId: memberId(WORKER), now: NOW, today: TODAY, unitScope: everything, projectScope: everything, mode: 'rows' } as WorkInput), WORKER);
  const alertRows = alerts.rows.filter((row) => row.source === 'PROJECT_TASK' && (row.kind === 'PWF_TASK_DUE_SOON' || row.kind === 'PWF_TASK_OVERDUE'));
  return {
    list,
    detail,
    workflowCounts: whole.counts_by_band,
    mine: Object.fromEntries(own.items.filter((item) => codeOf.has(item.task_id)).map((item) => [codeOf.get(item.task_id) as string, { band: item.official_band.band, tier: item.band_tier, thresholds: item.band_thresholds }])),
    mineCounts: own.counts_by_band,
    board: Object.fromEntries(onBoard.items.map((item) => [codeOf.get(item.task_id) as string, { band: item.band.band, tier: item.band_tier, thresholds: item.band_thresholds }])),
    boardCounts: onBoard.counts_by_band,
    boardFilter: async (band) => {
      const page = await boardPage({ band });
      return { codes: page.items.map((item) => codeOf.get(item.task_id) as string).sort(), total: page.total };
    },
    mineFilter: async (band) => {
      const page = await minePage({ band });
      return { codes: page.items.filter((item) => codeOf.has(item.task_id)).map((item) => codeOf.get(item.task_id) as string).sort(), total: page.total };
    },
    listFilter: async (band) => (await as((tx) => workflowReads.listTasks(tx, everything, flow.projectId, { band }, { limit: 50 }, NOW))).items.map((item) => item.task_code).sort(),
    reminderSeverity: Object.fromEntries(notices.filter((notice) => codeOf.has(notice.taskId)).map((notice) => [codeOf.get(notice.taskId) as string, notice.severity])),
    alertSeverity: Object.fromEntries(alertRows.filter((row) => codeOf.has(row.id.split(':')[0] as string)).map((row) => [codeOf.get(row.id.split(':')[0] as string) as string, row.severity])),
  };
}

const countOf = (colours: Record<string, Colour>): Record<string, number> => {
  const counts: Record<string, number> = { NONE: 0, GREEN: 0, YELLOW: 0, RED: 0, UNKNOWN: 0 };
  for (const colour of Object.values(colours)) counts[colour.band] = (counts[colour.band] ?? 0) + 1;
  return counts;
};

beforeAll(async () => {
  await harness.start();
  await harness.seedUnits(TENANT_A, [
    { n: PROVINCE, path: '/u1/' },
    { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
  ]);
  await harness.seedMembership(TENANT_A, MANAGER, PROVINCE);
  await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: SYSTEM_ACTOR, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, SYSTEM_ACTOR, TODAY));
  for (const n of [WORKER, CHECKER]) await harness.seedMembership(TENANT_A, n, DEPARTMENT);
  const recordId = randomUUID();
  areaVersion = randomUUID();
  await harness.owner(TENANT_A, [
    [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'AREA-B', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(MANAGER)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, 'AREA', 'AREA-B', 1, 'Area', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $3, now(), $4, $4)`,
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
  await template('BANDFLOW', BANDFLOW);
  await template('OLDFLOW', OLDFLOW);
}, 300_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

describe('what the frozen template writes on the tasks of a project (R58, R59, R73)', () => {
  it('writes the ladder of a task that has one with the tier STEP, the limit of a task in its own unit, and the working days every task covers; a task without the new fields keeps the columns empty', async () => {
    const flow = await started('BANDFLOW');
    const rows = await stored(flow.workflowId);
    expect(rows.STEP).toMatchObject({ band_tier: 'STEP', band_green_days: 10, band_yellow_days: 7, band_red_days: 4, duration_value: null, duration_unit: null, duration_roll: null, effective_working_days: 3, duration_working_days: 3 });
    expect(rows.FAR_STEP).toMatchObject({ band_tier: 'STEP', band_green_days: 30, band_yellow_days: 2, band_red_days: 0, effective_working_days: 21 });
    for (const code of ['POLICY', 'FAR_POLICY', 'CALENDAR']) expect(rows[code]).toMatchObject({ band_tier: null, band_green_days: null, band_yellow_days: null, band_red_days: null });
    expect(rows.POLICY).toMatchObject({ duration_value: null, duration_unit: null, duration_roll: null, effective_working_days: 3 });
    // Nothing of the later pieces is written here: no receiving unit, no extension used.
    for (const row of Object.values(rows)) expect(row).toMatchObject({ receiving_unit_id: null, receiving_units: null, extension_times_used: 0, extension_value_used: 0 });
    expect(rows.STEP?.committed_finish).toBe(DUE_SOON);
    expect(rows.POLICY?.committed_finish).toBe(DUE_SOON);
  });

  it('lays a task of ten calendar days on the calendar: the tenth day (rolled to a working day), the limit as written, and the working days it really covers', async () => {
    const flow = await started('BANDFLOW');
    const rows = await stored(flow.workflowId);
    // The day the task starts counts as the first: ten calendar days end nine days later, and a day nobody works rolls to the next working day.
    let finish = addDays(START, 9);
    while (!worked(finish)) finish = addDays(finish, 1);
    const effective = workedDaysBetween(START, finish);
    expect(rows.CALENDAR).toMatchObject({ duration_value: 10, duration_unit: 'CALENDAR_DAY', duration_roll: true, duration_working_days: 8, planned_start: START, planned_finish: finish, committed_finish: finish, effective_working_days: effective });
    // Seven or eight working days, never the nominal eight by rote.
    expect([7, 8]).toContain(effective);
    // What the scheduler is given again from the rows: the limit in its own unit for this task, and no such key for a task that has none (its input and hash are what they were).
    const again = await as(async (tx) => scheduleTasksOf(await loadTasks(tx, flow.workflowId), await loadLinks(tx, flow.workflowId)));
    expect(again.find((one) => one.code === 'CALENDAR')?.duration).toEqual({ value: 10, unit: 'CALENDAR_DAY', rollToWorkingDay: true });
    expect(Object.keys(again.find((one) => one.code === 'POLICY') ?? {})).not.toContain('duration');
    // A recomputation from progress keeps the day of the calendar and the working days it covers.
    const workflow = (await owner<{ version: number; schedule_version: number; calendar_pins: unknown }>('select version, schedule_version, calendar_pins from machvon.project_workflow where id = $1::uuid', [flow.workflowId]))[0] as { version: number; schedule_version: number; calendar_pins: unknown };
    await as((tx) => refreshSchedule(tx, { id: flow.workflowId, plannedStartDate: START, scheduleVersion: workflow.schedule_version, version: Number(workflow.version), calendarPins: workflow.calendar_pins }, flow.projectId, memberId(MANAGER), TODAY));
    const after = await stored(flow.workflowId);
    expect(after.CALENDAR).toMatchObject({ planned_finish: finish, effective_working_days: effective, duration_value: 10 });
    expect(after.STEP).toMatchObject({ effective_working_days: 3, band_tier: 'STEP' });
    const detail = (await as((tx) => taskReads.task(tx, everything, flow.ids.CALENDAR as string, NOW, memberId(MANAGER), CAN))) as Record<string, unknown>;
    expect(detail).toMatchObject({ duration: { value: 10, unit: 'CALENDAR_DAY', roll_to_working_day: true }, effective_working_days: effective, duration_working_days: 8 });
  });

  it('leaves every new column empty for a workflow of a template that uses none of the new fields, and its reads say no limit of its own', async () => {
    const flow = await started('OLDFLOW');
    const rows = await stored(flow.workflowId);
    for (const row of Object.values(rows)) {
      expect(row).toMatchObject({ band_tier: null, band_green_days: null, band_yellow_days: null, band_red_days: null, duration_value: null, duration_unit: null, duration_roll: null, receiving_unit_id: null, receiving_units: null, extension_times_used: 0, extension_value_used: 0, effective_working_days: 3 });
    }
    const listed = await as((tx) => workflowReads.listTasks(tx, everything, flow.projectId, {}, { limit: 50 }, NOW));
    for (const item of listed.items) expect(item).toMatchObject({ duration: null, effective_working_days: 3, band_tier: 'SYSTEM', band_thresholds: SYSTEM_LADDER });
  });

  it('refuses a change of the frozen ladder by the application, and lets the limit of the task be raised', async () => {
    const flow = await started('BANDFLOW');
    const refused = await as((tx) => tx.query('update machvon.project_task set band_red_days = 0 where id = $1::uuid', [flow.ids.STEP])).then(
      () => '',
      (error: { code?: string }) => error.code ?? '',
    );
    expect(refused).toBe('42501');
    const given = await as((tx) => tx.query(`update machvon.project_task set band_tier = 'STEP', band_yellow_days = 3, band_red_days = 1 where id = $1::uuid`, [flow.ids.POLICY])).then(
      () => '',
      (error: { code?: string }) => error.code ?? '',
    );
    expect(given).toBe('42501');
    await as((tx) => tx.query('update machvon.project_task set duration_value = 12 where id = $1::uuid', [flow.ids.CALENDAR]));
    expect((await stored(flow.workflowId)).CALENDAR).toMatchObject({ duration_value: 12, duration_unit: 'CALENDAR_DAY' });
  });
});

describe('one official colour on every surface (R73)', () => {
  let flow: Started;
  let policyId = '';

  beforeAll(async () => {
    flow = await started('BANDFLOW');
  });

  it('gives a task the same colour, tier and ladder in the list, the detail, my tasks, the board, the reminders and the alert centre; twins with one day and two ladders keep their own colours', async () => {
    const seen = await surfaces(flow);
    // Four working days left: red on the ladder of the step (10, 7, 4), green on the default of the system (5, 2, 0). Twenty-two left: green on the ladder of the far step (30, 2, 0), no colour yet on the default.
    const expected: Record<string, Colour> = {
      STEP: { band: 'RED', tier: 'STEP', thresholds: STEP_LADDER },
      POLICY: { band: 'GREEN', tier: 'SYSTEM', thresholds: SYSTEM_LADDER },
      FAR_STEP: { band: 'GREEN', tier: 'STEP', thresholds: FAR_LADDER },
      FAR_POLICY: { band: 'NONE', tier: 'SYSTEM', thresholds: SYSTEM_LADDER },
    };
    for (const surface of [seen.list, seen.detail, seen.mine, seen.board]) for (const [code, colour] of Object.entries(expected)) expect(surface[code]).toEqual(colour);
    expect(seen.list).toEqual(seen.detail);
    expect(seen.mine).toEqual(seen.list);
    expect(seen.board).toEqual(seen.list);
    // The counts of every surface are the counts of those colours.
    const counts = countOf(seen.list);
    expect(seen.workflowCounts).toEqual(counts);
    expect(seen.boardCounts).toEqual(counts);
    // The worker holds the tasks of the other tests of this file too: the counts of the person cover at least these.
    for (const band of ['RED', 'GREEN', 'NONE']) expect(seen.mineCounts[band]).toBeGreaterThanOrEqual(counts[band] as number);
    // The colour filter keeps the twin whose own colour it is and never the other.
    expect(await seen.boardFilter('RED')).toEqual({ codes: ['STEP'], total: 1 });
    const green = await seen.boardFilter('GREEN');
    expect(green.codes).toContain('POLICY');
    expect(green.codes).toContain('FAR_STEP');
    expect(green.codes).not.toContain('STEP');
    expect(green.total).toBe(counts.GREEN);
    expect((await seen.boardFilter('NONE')).codes).toEqual(['FAR_POLICY'].concat(seen.list.CALENDAR?.band === 'NONE' ? ['CALENDAR'] : []).sort());
    expect(await seen.listFilter('RED')).toEqual(['STEP']);
    const mineRed = await seen.mineFilter('RED');
    expect(mineRed.codes).toEqual(['STEP']);
    const mineGreen = await seen.mineFilter('GREEN');
    expect(mineGreen.codes).toContain('POLICY');
    expect(mineGreen.codes).toContain('FAR_STEP');
    expect(mineGreen.codes).not.toContain('STEP');
    // The reminder of a task is of the level of its official colour: the point "5 days left" of the policy fires for both twins, red for one and green for the other.
    expect(seen.reminderSeverity.STEP).toBe(severityOf('PROJECT_TASK', 'RED'));
    expect(seen.reminderSeverity.POLICY).toBe(severityOf('PROJECT_TASK', 'GREEN'));
    expect(seen.reminderSeverity.STEP).not.toBe(seen.reminderSeverity.POLICY);
    // The alert centre lists what has a colour, by that colour: the far step is listed (green by its own ladder, though no policy reaches that far), its twin is not.
    expect(seen.alertSeverity.STEP).toBe(severityOf('PROJECT_TASK', 'RED'));
    expect(seen.alertSeverity.POLICY).toBe(severityOf('PROJECT_TASK', 'GREEN'));
    expect(seen.alertSeverity.FAR_STEP).toBe(severityOf('PROJECT_TASK', 'GREEN'));
    expect(Object.keys(seen.alertSeverity)).not.toContain('FAR_POLICY');
  });

  it('moves the colour of the task that follows the policy when the policy changes, and never the colour of the task with a ladder of its own', async () => {
    const before = await surfaces(flow);
    policyId = await policy({ unit: 'WORKING', green_days: 8, yellow_days: 4, red_days: 1, overrides: [{ match: { priority: 'HIGH' }, green_days: 40, yellow_days: 20, red_days: 10 }], reminder_days: [5, 2, 0, -1], escalate_after_overdue_days: 3 });
    const after = await surfaces(flow);
    const policyLadder = { green_days: 8, yellow_days: 4, red_days: 1 };
    for (const surface of [after.list, after.detail, after.mine, after.board]) {
      expect(surface.STEP).toEqual(before.list.STEP);
      expect(surface.FAR_STEP).toEqual(before.list.FAR_STEP);
      expect(surface.POLICY).toEqual({ band: 'YELLOW', tier: 'POLICY', thresholds: policyLadder });
      expect(surface.FAR_POLICY).toEqual({ band: 'NONE', tier: 'POLICY', thresholds: policyLadder });
      // The task of high priority follows the override of the policy, and the read says so.
      expect(surface.CALENDAR).toMatchObject({ tier: 'POLICY_OVERRIDE', thresholds: { green_days: 40, yellow_days: 20, red_days: 10 } });
    }
    expect(before.list.POLICY).toEqual({ band: 'GREEN', tier: 'SYSTEM', thresholds: SYSTEM_LADDER });
    expect(after.boardCounts).toEqual(countOf(after.list));
    expect(after.workflowCounts).toEqual(countOf(after.list));
    expect(await after.boardFilter('RED')).toEqual({ codes: ['STEP'].concat(after.list.CALENDAR?.band === 'RED' ? ['CALENDAR'] : []).sort(), total: countOf(after.list).RED });
    expect((await after.boardFilter('YELLOW')).codes).toContain('POLICY');
    expect((await after.mineFilter('YELLOW')).codes).toContain('POLICY');
    expect((await after.mineFilter('RED')).codes).toContain('STEP');
    expect(await after.listFilter('YELLOW')).toEqual(['POLICY'].concat(after.list.CALENDAR?.band === 'YELLOW' ? ['CALENDAR'] : []).sort());
    expect(after.reminderSeverity.STEP).toBe(severityOf('PROJECT_TASK', 'RED'));
    expect(after.alertSeverity.STEP).toBe(severityOf('PROJECT_TASK', 'RED'));
    expect(after.alertSeverity.POLICY).toBe(severityOf('PROJECT_TASK', 'YELLOW'));
    await owner('delete from machvon.governance_rule where id = $1::uuid', [policyId]).catch(() => undefined);
  });
});

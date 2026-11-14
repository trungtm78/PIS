import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { pwfDeadlineBand, vietnamDateOf } from '@machvon/kernel';
import { HomeWorkStore } from '../src/home-work-store';
import type { WorkInput, WorkRow } from '../src/home-work-store';
import { PwfBandPolicies } from '../src/pwf-band-policies';
import { PwfDeadlinePreferenceStore } from '../src/pwf-deadline-preference';
import { PwfMyTaskReads } from '../src/pwf-my-tasks';
import { PwfDeadlineReads } from '../src/pwf-deadline-reads';
import { PwfWorkflowReads } from '../src/pwf-workflow-reads';
import { PwfTaskReminders } from '../src/pwf-task-reminders';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from './support/authz-fixtures';

jest.setTimeout(600_000);

const harness = new AuthzHarness();
const work = new HomeWorkStore();
const preferences = new PwfDeadlinePreferenceStore();
const myTasks = new PwfMyTaskReads();
const board = new PwfDeadlineReads();
const reminders = new PwfTaskReminders();

const MANAGER = 1;
const WORKER = 2;
const PEER = 3;
const ROOT = 1;
const DEPARTMENT = 2;
const SIBLING = 3;
const NOW = new Date();
const TODAY = vietnamDateOf(NOW);
const YEAR = Number(TODAY.slice(0, 4));
const EVERYTHING: ScopeBuilder = () => ({ sql: 'true', params: [] });
const day = (offset: number): string => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

const as = <T>(run: (tx: TenantTx) => Promise<T>, member = WORKER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), run);
const admin = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
const input = (over: Partial<WorkInput> = {}): WorkInput => ({ membershipId: memberId(WORKER), now: NOW, today: TODAY, unitScope: EVERYTHING, projectScope: EVERYTHING, mode: 'rows', ...over });
const collect = (over: Partial<WorkInput> = {}, at = WORKER) => as((tx) => work.collect(tx, input({ membershipId: memberId(at), ...over })), at);
const onlyTasks = (rows: readonly WorkRow[]): WorkRow[] => rows.filter((row) => row.source === 'PROJECT_TASK');

async function seedSql(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

let projectDept = '';
let projectSibling = '';
let workflowDept = '';
let workflowSibling = '';
let counter = 0;

interface TaskOptions {
  kind?: 'TASK' | 'MILESTONE';
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  status?: string;
  excluded?: boolean;
  tracked?: boolean;
  version?: number;
  baseline?: number;
  critical?: boolean;
  float?: number;
  assignee?: number | null;
  role?: 'RESPONSIBLE' | 'ACCOUNTABLE' | 'CONSULTED';
  workflow?: string;
  project?: string;
}

/** A task due `due` days from today (negative: past), given to a person by the ledger. */
async function task(due: number | null, options: TaskOptions = {}): Promise<string> {
  counter += 1;
  const id = randomUUID();
  const finish = due === null ? null : day(due);
  const start = due === null ? null : day(due - 2);
  const kind = options.kind ?? 'TASK';
  const workflow = options.workflow ?? workflowDept;
  const project = options.project ?? projectDept;
  const status = options.status ?? 'NOT_STARTED';
  const baseline = options.baseline === undefined ? due : options.baseline;
  await seedSql([
    [
      `insert into machvon.project_task (tenant_id, id, workflow_id, project_id, task_code, name, phase_code, sort_order, kind, required, responsible_role, priority, duration_working_days, status, excluded, tracked, state,
                                         planned_start, planned_finish, baseline_start, baseline_finish, total_float, critical, schedule_version, actual_start, created_by, updated_by, actual_finish, cancelled_at, committed_start, committed_finish)
       values ($1, $2, $3, $4, $5, $6, 'P1', $7, $8, true, 'ROLE_A', $9, $10, $11, $12, $13, 'SCHEDULED', $14::date, $15::date, $14::date, $16::date, $17, $18, $19, $20::date, $21, $21, $22::date, $23::timestamptz, $14::date, $15::date)`,
      [
        TENANT_A,
        id,
        workflow,
        project,
        `T${String(counter).padStart(4, '0')}`,
        `Task ${counter}`,
        counter,
        kind,
        options.priority ?? 'NORMAL',
        kind === 'MILESTONE' ? 0 : 2,
        status,
        options.excluded ?? false,
        options.tracked ?? true,
        start,
        finish,
        baseline === null ? null : day(baseline),
        options.float ?? null,
        options.critical ?? false,
        options.version ?? 1,
        status === 'NOT_STARTED' || status === 'CANCELLED' ? null : day(-5),
        memberId(MANAGER),
        status === 'DONE' ? day(-1) : null,
        status === 'CANCELLED' ? NOW.toISOString() : null,
      ],
    ],
  ]);
  const assignee = options.assignee === undefined ? WORKER : options.assignee;
  if (assignee !== null) {
    await seedSql([
      [
        `insert into machvon.project_task_assignment (tenant_id, task_id, membership_id, role, valid_from, share_pct, reason, assigned_by) values ($1, $2, $3, $4, $5::date, 100, 'Given by the test', $6)`,
        [TENANT_A, id, memberId(assignee), options.role ?? 'RESPONSIBLE', day(-60), memberId(MANAGER)],
      ],
    ]);
  }
  return id;
}

async function approvedRule(params: Record<string, unknown>, unit: string | null = null): Promise<string> {
  const id = randomUUID();
  await admin(
    `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at, unit_id)
     values ($1, $2, 'DEADLINE_BAND_POLICY', 'PROJECT_TASK', $3, 'APPROVED', $4::jsonb, date '2020-01-01', 'A policy for the tests', $5, $6, now(), $7, now(), $8)`,
    [TENANT_A, id, 1 + counter, JSON.stringify(params), memberId(MANAGER), memberId(WORKER), memberId(PEER), unit],
  );
  counter += 1;
  return id;
}
const retire = (id: string): Promise<void> => seedSql([['delete from machvon.governance_rule where id = $1::uuid', [id]]]);
const calendars = (sql: string, params: unknown[] = []): Promise<void> => seedSql([[sql, params]]);

async function clearTasks(): Promise<void> {
  await calendars('delete from machvon.alert_notification_profile');
  await admin('delete from machvon.project_task_reminder');
  await admin('delete from machvon.project_task_assignment');
  await admin('delete from machvon.project_task');
}

const LADDER = (green: number | null, yellow: number, red: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  unit: 'WORKING',
  ...(green === null ? {} : { green_days: green }),
  yellow_days: yellow,
  red_days: red,
  overrides: [],
  reminder_days: [5, 2, 0, -1],
  escalate_after_overdue_days: 3,
  ...extra,
});

beforeAll(async () => {
  await harness.start();
  await harness.seedUnits(TENANT_A, [
    { n: ROOT, path: '/u1/' },
    { n: DEPARTMENT, path: '/u1/u2/', parent: ROOT },
    { n: SIBLING, path: '/u1/u3/', parent: ROOT },
  ]);
  await harness.seedMembership(TENANT_A, MANAGER, ROOT);
  await harness.seedMembership(TENANT_A, WORKER, DEPARTMENT);
  await harness.seedMembership(TENANT_A, PEER, SIBLING);
  // Every day is a working day, so that the days left of a task are the days of the calendar and a case reads at a glance.
  await admin(
    `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
     select $1, gen_random_uuid(), 'WORKDAY_VN', y, 1, '[1,2,3,4,5,6,7]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $2, $2, now() from generate_series($3::int, $4::int) y`,
    [TENANT_A, memberId(MANAGER), YEAR - 1, YEAR + 2],
  );
  projectDept = randomUUID();
  projectSibling = randomUUID();
  workflowDept = randomUUID();
  workflowSibling = randomUUID();
  for (const [project, workflow, unit, code] of [
    [projectDept, workflowDept, DEPARTMENT, 'D'],
    [projectSibling, workflowSibling, SIBLING, 'S'],
  ] as const) {
    await seedSql([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group, planned_start_date)
         values ($1, $2, $3, 'Project ' || $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B', date '${YEAR}-01-05')`,
        [TENANT_A, project, `PRJ-${code}`, unitId(unit), randomUUID()],
      ],
      [
        `insert into machvon.project_workflow (tenant_id, id, project_id, template_code, template_rule_version, template_hash, template, planned_start_date, schedule_version, created_by, updated_by)
         values ($1, $2, $3, 'BANDS', 0, repeat('a', 64), '{}'::jsonb, date '${YEAR}-01-05', 1, $4, $4)`,
        [TENANT_A, workflow, project, memberId(MANAGER)],
      ],
    ]);
  }
}, 300_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(clearTasks);

/**
 * The tasks of a workflow as a source of the alert centre (PWF-2, R30, R40): the colour is the official one, the days are working days, the read is direct, and nothing a person sets for themselves changes what the alert centre says.
 */
describe('the source PROJECT_TASK of the alert centre', () => {
  it('lists a task by its official colour with the severity of its facet and the identity task and version, and nothing farther than the green line', async () => {
    const ids = {
      far: await task(6),
      green: await task(5),
      yellow: await task(2),
      red: await task(0),
      late: await task(-1),
      later: await task(-3),
    };
    await task(1, { assignee: PEER });
    const rows = onlyTasks((await collect()).rows);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(rows.map((row) => row.id).sort()).toEqual([`${ids.green}:1`, `${ids.yellow}:1`, `${ids.red}:1`, `${ids.late}:1`, `${ids.later}:1`].sort());
    expect(byId.has(`${ids.far}:1`)).toBe(false);
    const read = (key: keyof typeof ids): [string, string] => [byId.get(`${ids[key]}:1`)?.kind ?? '', byId.get(`${ids[key]}:1`)?.severity ?? ''];
    expect(read('green')).toEqual(['PWF_TASK_DUE_SOON', 'WATCH']);
    expect(read('yellow')).toEqual(['PWF_TASK_DUE_SOON', 'WATCH']);
    expect(read('red')).toEqual(['PWF_TASK_DUE_SOON', 'ACTION']);
    expect(read('late')).toEqual(['PWF_TASK_OVERDUE', 'ACTION']);
    // Three days past its day, the rule says it goes up.
    expect(read('later')).toEqual(['PWF_TASK_OVERDUE', 'URGENT']);
    const first = byId.get(`${ids.green}:1`) as WorkRow;
    expect(first.source).toBe('PROJECT_TASK');
    expect(first.target).toEqual({ screen: 'PWF-04', id: ids.green });
    expect(first.dueOn).toBe(day(5));
    expect(first.alertType?.owner).toBe('TASK_ASSIGNEE');
    expect(first.consequence).toContain('đỏ');
    // The words a phone shows (owner review of 14/11/2026): a short title of the NAME of the task and what its deadline says, the name of the project on the second line, and no code of a task, a phase or a project in either.
    const words = (key: keyof typeof ids): [string, string | null] => [(byId.get(`${ids[key]}:1`)?.title ?? '').replace(/^Task \d+/, 'Task'), byId.get(`${ids[key]}:1`)?.subtitle ?? null];
    expect(words('green')[0]).toBe('Task: còn 5 ngày làm việc');
    expect(words('red')[0]).toBe('Task: đến hạn hôm nay');
    expect(words('late')[0]).toBe('Task: quá hạn 1 ngày làm việc');
    expect(words('later')[0]).toBe('Task: quá hạn 3 ngày làm việc, đã báo cấp quản lý');
    expect(words('green')[1]).toMatch(/^Project PRJ-/);
    for (const row of rows) expect(`${row.title} ${row.subtitle}`).not.toMatch(/T\d{4}|P1/);
    expect(first.lifecycle).toBe('NEW');
    // The points of the rule remind, not the cadence of the severity: the item never says a reminder is due by the cadence.
    expect(rows.filter((row) => row.kind !== 'PWF_MILESTONE_AT_RISK').every((row) => row.reminders?.due === false && row.reminders.nextAt === null)).toBe(true);
  });

  it('gives a task the reader answers for or does, never one of somebody else; the view scope has them all', async () => {
    const mine = await task(1);
    const peers = await task(1, { assignee: PEER });
    const accountable = await task(1, { assignee: WORKER, role: 'ACCOUNTABLE' });
    const consulted = await task(1, { assignee: WORKER, role: 'CONSULTED' });
    const ids = (await collect()).rows.filter((row) => row.source === 'PROJECT_TASK').map((row) => row.id.split(':')[0]);
    expect(ids.sort()).toEqual([mine, accountable].sort());
    expect(ids).not.toContain(peers);
    expect(ids).not.toContain(consulted);
    const everyone = onlyTasks((await collect({ view: 'scope' }, MANAGER)).rows).map((row) => row.id.split(':')[0]);
    expect(everyone.sort()).toEqual([mine, peers, accountable, consulted].sort());
  });

  it('does not list a task that is done, cancelled, on hold, waiting for approval, left out, not tracked or in a workflow that is not running', async () => {
    await task(0, { status: 'DONE' });
    await task(0, { status: 'CANCELLED' });
    await task(0, { status: 'ON_HOLD' });
    await task(0, { status: 'AWAITING_APPROVAL' });
    await task(0, { excluded: true });
    await task(0, { tracked: false });
    await task(null);
    expect(onlyTasks((await collect()).rows)).toEqual([]);
    const live = await task(0);
    await admin(`update machvon.project_workflow set status = 'ON_HOLD' where id = $1::uuid`, [workflowDept]);
    expect(onlyTasks((await collect()).rows)).toEqual([]);
    await admin(`update machvon.project_workflow set status = 'ACTIVE' where id = $1::uuid`, [workflowDept]);
    expect(onlyTasks((await collect()).rows).map((row) => row.id)).toEqual([`${live}:1`]);
  });

  it('UAT-PWF-IDM-03: reflects a done, paused, cancelled or moved task in the same read: it leaves the list, or moves to one new item and never doubles; a replay is the same list', async () => {
    const id = await task(2);
    const before = onlyTasks((await collect()).rows);
    expect(before.map((row) => row.id)).toEqual([`${id}:1`]);
    expect(onlyTasks((await collect()).rows).map((row) => row.id)).toEqual([`${id}:1`]);
    // Moved: the days and the version of the schedule change together, as a published schedule writes them.
    await admin(`update machvon.project_task set planned_finish = $2::date, planned_start = $3::date, committed_finish = $2::date, committed_start = $3::date, schedule_version = 2 where id = $1::uuid`, [id, day(4), day(2)]);
    const moved = onlyTasks((await collect()).rows);
    expect(moved.map((row) => [row.id, row.dueOn, row.severity])).toEqual([[`${id}:2`, day(4), 'WATCH']]);
    // Moved out of the window: it leaves.
    await admin(`update machvon.project_task set planned_finish = $2::date, planned_start = $2::date, committed_finish = $2::date, committed_start = $2::date, schedule_version = 3 where id = $1::uuid`, [id, day(30)]);
    expect(onlyTasks((await collect()).rows)).toEqual([]);
    await admin(`update machvon.project_task set planned_finish = $2::date, planned_start = $2::date, committed_finish = $2::date, committed_start = $2::date, schedule_version = 4 where id = $1::uuid`, [id, day(0)]);
    expect(onlyTasks((await collect()).rows).map((row) => row.id)).toEqual([`${id}:4`]);
    for (const status of ['ON_HOLD', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'DONE']) {
      await admin(`update machvon.project_task set status = $2, actual_start = coalesce(actual_start, current_date), actual_finish = case when $2 = 'DONE' then current_date else null end where id = $1::uuid`, [id, status]);
      const listed = onlyTasks((await collect()).rows).map((row) => row.id);
      expect([status, listed]).toEqual([status, status === 'IN_PROGRESS' ? [`${id}:4`] : []]);
    }
  });

  it('counts the days left on the calendar of the tenant: a holiday that is published changes the colour, a year without a calendar gives none', async () => {
    const id = await task(3);
    // 3 days away and every day worked: green; once tomorrow is a holiday the same day is 2 working days away: yellow.
    expect(onlyTasks((await collect()).rows).map((row) => row.severity)).toEqual(['WATCH']);
    expect((await as((tx) => myTasks.list(tx, EVERYTHING, memberId(WORKER), {}, { limit: 10 }, NOW)))).toMatchObject({ items: [{ official_band: { band: 'GREEN', remaining_days: 3 } }] });
    await calendars(`update machvon.work_calendar_version set status = 'Superseded' where year = $1 and calendar_code = 'WORKDAY_VN'`, [Number(day(1).slice(0, 4))]);
    await calendars(
      `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
       values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 2, '[1,2,3,4,5,6,7]'::jsonb, $3::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $4, $4, now())`,
      [TENANT_A, Number(day(1).slice(0, 4)), JSON.stringify([{ date: day(1), name: 'A day off' }]), memberId(MANAGER)],
    );
    expect((await as((tx) => myTasks.list(tx, EVERYTHING, memberId(WORKER), {}, { limit: 10 }, NOW)))).toMatchObject({ items: [{ official_band: { band: 'YELLOW', remaining_days: 2 } }] });
    // No published calendar at all: the days cannot be counted and nothing is guessed (no colour, no item).
    await calendars(`update machvon.work_calendar_version set status = 'Superseded'`);
    expect(onlyTasks((await collect()).rows)).toEqual([]);
    expect((await as((tx) => myTasks.list(tx, EVERYTHING, memberId(WORKER), {}, { limit: 10 }, NOW)))).toMatchObject({ items: [{ task_id: id, official_band: { band: 'UNKNOWN', remaining_days: null, reason: 'CALENDAR_UNAVAILABLE' } }] });
    await calendars(`update machvon.work_calendar_version set status = 'Superseded' where revision = 2`);
    await calendars(`update machvon.work_calendar_version set status = 'Published' where revision = 1 and year = $1`, [Number(day(1).slice(0, 4))]);
    await calendars(`update machvon.work_calendar_version set status = 'Published' where revision = 1 and year <> $1`, [Number(day(1).slice(0, 4))]);
    expect(onlyTasks((await collect()).rows)).toHaveLength(1);
  });

  it('judges a task by the rule of its tenant and, nearer, of the unit of its project; the nearest unit wins and a retired rule goes back to the default', async () => {
    const north = await task(8);
    const south = await task(8, { project: projectSibling, workflow: workflowSibling, assignee: WORKER });
    expect(onlyTasks((await collect()).rows)).toEqual([]);
    const tenantRule = await approvedRule(LADDER(10, 4, 1));
    expect(onlyTasks((await collect()).rows.filter((row) => row.source === 'PROJECT_TASK')).map((row) => row.id.split(':')[0]).sort()).toEqual([north, south].sort());
    const unitRule = await approvedRule(LADDER(3, 1, 0), unitId(DEPARTMENT));
    const afterUnit = onlyTasks((await collect()).rows).map((row) => row.id.split(':')[0]);
    // The unit of the first project has the tighter rule (not in range at 8 days); the sibling unit keeps the tenant's.
    expect(afterUnit).toEqual([south]);
    // The board, the detail of a task and the list of tasks of the project say the same official colour as the alert centre: the rule of the unit of the project, nearest first.
    const onBoard = (await as((tx) => board.board(tx, EVERYTHING, {}, { limit: 20 }, NOW), MANAGER)) as { items: Array<{ task_id: string; band: { band: string } }> };
    expect(onBoard.items.find((one) => one.task_id === north)?.band.band).toBe('NONE');
    expect(onBoard.items.find((one) => one.task_id === south)?.band.band).toBe('GREEN');
    const listed = await as((tx) => new PwfWorkflowReads().listTasks(tx, EVERYTHING, projectDept, {}, { limit: 20 }, NOW), MANAGER);
    expect(listed.items.find((one) => one.id === north)?.band.band).toBe('NONE');
    const set = await as((tx) => new PwfBandPolicies().load(tx, TODAY));
    expect(set.forUnitPath('/u1/u2/')).toMatchObject({ green_days: 3, yellow_days: 1, red_days: 0 });
    expect(set.forUnitPath('/u1/u3/')).toMatchObject({ green_days: 10, yellow_days: 4, red_days: 1 });
    expect(set.forUnitPath(null)).toMatchObject({ green_days: 10 });
    expect(set.widestGreenDays).toBe(10);
    expect(set.versionForUnitPath('/u1/u2/')).toMatch(/^v\d+$/);
    await retire(unitRule);
    await retire(tenantRule);
    const back = await as((tx) => new PwfBandPolicies().load(tx, TODAY));
    expect(back.forUnitPath('/u1/u2/')).toMatchObject({ green_days: 5, yellow_days: 2, red_days: 0 });
    expect(back.versionForUnitPath('/u1/u2/')).toBe('builtin');
  });

  it('uses the override of the rule for a kind, a priority or a phase of task', async () => {
    const critical = await task(7, { priority: 'CRITICAL' });
    await task(7, { priority: 'NORMAL' });
    expect(onlyTasks((await collect()).rows)).toEqual([]);
    const rule = await approvedRule(LADDER(5, 2, 0, { overrides: [{ match: { priority: 'CRITICAL' }, green_days: 10, yellow_days: 4, red_days: 1 }] }));
    expect(onlyTasks((await collect()).rows).map((row) => row.id.split(':')[0])).toEqual([critical]);
    await retire(rule);
  });

  it('lists a milestone whose forecast is past its first baseline (or that is critical with its float spent) for who answers for the project, once for each version of its schedule', async () => {
    await seedSql([
      [
        `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, status, created_by, updated_by)
         values ($1, gen_random_uuid(), $2, $3, 'LEADER_IN_CHARGE', date '${YEAR}-01-01', 'ACTIVE', $3, $3)`,
        [TENANT_A, projectDept, memberId(MANAGER)],
      ],
    ]);
    const slipped = await task(10, { kind: 'MILESTONE', baseline: 4, assignee: null });
    const spent = await task(10, { kind: 'MILESTONE', baseline: 10, critical: true, float: -2, assignee: null, version: 3 });
    await task(10, { kind: 'MILESTONE', baseline: 10, assignee: null });
    await task(10, { kind: 'MILESTONE', baseline: 4, assignee: null, status: 'DONE' });
    const kept = (await collect({}, MANAGER)).rows.filter((row) => row.kind === 'PWF_MILESTONE_AT_RISK');
    expect(kept.map((row) => row.id).sort()).toEqual([`${slipped}:1:risk`, `${spent}:3:risk`].sort());
    expect(kept.every((row) => row.severity === 'ACTION' && row.source === 'PROJECT_TASK')).toBe(true);
    expect(kept.find((row) => row.id === `${slipped}:1:risk`)?.title).toContain('6');
    expect(kept.find((row) => row.id === `${slipped}:1:risk`)?.alertType?.owner).toBe('PROJECT_MANAGER');
    // Somebody who does not answer for the project does not have them in their own list; the view of the scope has them.
    expect((await collect({}, WORKER)).rows.filter((row) => row.kind === 'PWF_MILESTONE_AT_RISK')).toEqual([]);
    expect((await collect({ view: 'scope' }, WORKER)).rows.filter((row) => row.kind === 'PWF_MILESTONE_AT_RISK')).toHaveLength(2);
    // Moved to a new version of the schedule it is one new item, not two.
    await admin(`update machvon.project_task set schedule_version = 2 where id = $1::uuid`, [slipped]);
    expect((await collect({}, MANAGER)).rows.filter((row) => row.kind === 'PWF_MILESTONE_AT_RISK').map((row) => row.id).sort()).toEqual([`${slipped}:2:risk`, `${spent}:3:risk`].sort());
    await admin('delete from machvon.project_accountability');
  });
});

describe('the personal tier (R40): earlier only, and never the official colour', () => {
  it('UAT-PWF-NEG-06: keeps what a person saves, raises a level the official rule has passed and says which, and refuses a later or a disordered ladder', async () => {
    expect(await as((tx) => preferences.read(tx, memberId(WORKER), NOW))).toMatchObject({ version: 0, green_days: null, official: { green_days: 5, yellow_days: 2, red_days: 0 }, clamped: [] });
    const version = await as((tx) => preferences.save(tx, memberId(WORKER), { green_days: 7, yellow_days: 3, red_days: 1, reminder_days: [7, 3] }, 0, NOW));
    expect(version).toBe(1);
    expect(await as((tx) => preferences.read(tx, memberId(WORKER), NOW))).toMatchObject({ version: 1, green_days: 7, yellow_days: 3, red_days: 1, reminder_days: [7, 3], clamped: [] });
    await expect(as((tx) => preferences.save(tx, memberId(WORKER), { green_days: 4, yellow_days: null, red_days: null, reminder_days: [] }, 1, NOW))).rejects.toMatchObject({ code: 'DEADLINE_PERSONAL_NOT_EARLIER', detail: 'green_days' });
    await expect(as((tx) => preferences.save(tx, memberId(WORKER), { green_days: null, yellow_days: 5, red_days: null, reminder_days: [] }, 1, NOW))).rejects.toMatchObject({ code: 'DEADLINE_BAND_THRESHOLDS_INVALID', detail: 'green_days' });
    await expect(as((tx) => preferences.save(tx, memberId(WORKER), { green_days: 8, yellow_days: 3, red_days: 1, reminder_days: [] }, 0, NOW))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    // The tenant tightens its rule after the person saved: the personal level that is now later than it is raised to it and named.
    const rule = await approvedRule(LADDER(9, 4, 1));
    expect(await as((tx) => preferences.read(tx, memberId(WORKER), NOW))).toMatchObject({ official: { green_days: 9 }, clamped: ['green_days', 'yellow_days'], green_days: 7, yellow_days: 3 });
    await retire(rule);
    // Cleared, it is the official line again; the profile of alerts of the person is the same row and keeps its own version.
    expect(await as((tx) => preferences.save(tx, memberId(WORKER), { green_days: null, yellow_days: null, red_days: null, reminder_days: [] }, 1, NOW))).toBe(2);
    expect(await as((tx) => preferences.read(tx, memberId(WORKER), NOW))).toMatchObject({ version: 2, green_days: null, yellow_days: null, red_days: null, reminder_days: [] });
  });

  it('changes the colour of the person in their own list and nothing else: the alert centre, the board and the official colour stay as they were', async () => {
    await task(6);
    await task(3);
    await task(0);
    await task(-4);
    const officialRows = onlyTasks((await collect()).rows).map((row) => [row.id, row.kind, row.severity, row.dueOn, row.title, row.reminders?.due ?? null]);
    const officialBoard = JSON.stringify(((await as((tx) => board.board(tx, EVERYTHING, {}, { limit: 50 }, NOW), MANAGER)) as { items: unknown[]; counts_by_band: unknown }).counts_by_band);
    const officialMine = (await as((tx) => myTasks.list(tx, EVERYTHING, memberId(WORKER), {}, { limit: 20 }, NOW))) as { items: Array<{ official_band: unknown; personal_band: unknown; due_date: string }> };
    expect(officialMine.items.every((one) => one.personal_band === null)).toBe(true);
    await as((tx) => preferences.save(tx, memberId(WORKER), { green_days: 8, yellow_days: 4, red_days: 2, reminder_days: [8] }, 0, NOW));
    expect(onlyTasks((await collect()).rows).map((row) => [row.id, row.kind, row.severity, row.dueOn, row.title, row.reminders?.due ?? null])).toEqual(officialRows);
    expect(JSON.stringify(((await as((tx) => board.board(tx, EVERYTHING, {}, { limit: 50 }, NOW), MANAGER)) as { counts_by_band: unknown }).counts_by_band)).toBe(officialBoard);
    const mine = (await as((tx) => myTasks.list(tx, EVERYTHING, memberId(WORKER), {}, { limit: 20 }, NOW))) as { items: Array<{ due_date: string; official_band: { band: string }; personal_band: { band: string; remaining_days: number } | null }>; total: number };
    // The official colour is what it was for every task; the personal one is only ever earlier, and the real day is always there.
    expect(mine.items.map((one) => one.official_band)).toEqual(officialMine.items.map((one) => one.official_band));
    const rank = { NONE: 0, GREEN: 1, YELLOW: 2, RED: 3, UNKNOWN: -1 } as const;
    for (const one of mine.items) {
      expect(one.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (one.personal_band !== null) expect(rank[one.personal_band.band as keyof typeof rank]).toBeGreaterThanOrEqual(rank[one.official_band.band as keyof typeof rank]);
    }
    const byDay = new Map(mine.items.map((one) => [one.due_date, one]));
    expect(byDay.get(day(6))).toMatchObject({ official_band: { band: 'NONE' }, personal_band: { band: 'GREEN', remaining_days: 6 } });
    expect(byDay.get(day(3))).toMatchObject({ official_band: { band: 'GREEN' }, personal_band: { band: 'YELLOW' } });
    expect(byDay.get(day(0))).toMatchObject({ official_band: { band: 'RED' }, personal_band: { band: 'RED' } });
    // Overdue is red on every ladder: the same colour as the official one.
    expect(byDay.get(day(-4))).toMatchObject({ official_band: { band: 'RED', overdue: true }, personal_band: { band: 'RED', overdue: true } });
  });
});

describe('the first save of a person', () => {
  it('is one winner and one version conflict when two screens save for the first time together', async () => {
    const save = (green: number): Promise<number> => as((tx) => preferences.save(tx, memberId(PEER), { green_days: green, yellow_days: null, red_days: null, reminder_days: [] }, 0, NOW), PEER);
    const settled = await Promise.allSettled([save(7), save(8)]);
    expect(settled.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    const lost = settled.find((one) => one.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});

describe('my tasks, bounded and exact', () => {
  it('pages by cursor without a gap or a repeat, filters by official colour with the exact total, and never shows a task of another person', async () => {
    for (let n = 0; n < 7; n += 1) await task(n - 2);
    await task(1, { assignee: PEER });
    const seen: string[] = [];
    let after: { code: string; id: string } | undefined;
    let total = 0;
    for (let page = 0; page < 5; page += 1) {
      const got = (await as((tx) => myTasks.list(tx, EVERYTHING, memberId(WORKER), {}, { limit: 3, after }, NOW))) as { items: Array<{ task_id: string }>; next: { code: string; id: string } | null; total: number };
      seen.push(...got.items.map((one) => one.task_id));
      total = got.total;
      after = got.next ?? undefined;
      if (after === undefined) break;
    }
    expect(total).toBe(7);
    expect(new Set(seen).size).toBe(7);
    // The counts by official colour are exact whatever the page and the filter (the block of a home screen reads them with a page of three): days -2, -1 and 0 are red, 1 and 2 yellow, 3 and 4 green; two are overdue.
    const small = (await as((tx) => myTasks.list(tx, EVERYTHING, memberId(WORKER), { band: 'GREEN' }, { limit: 1 }, NOW))) as { counts_by_band: Record<string, number>; overdue_count: number; total: number };
    expect(small).toMatchObject({ total: 2, counts_by_band: { RED: 3, YELLOW: 2, GREEN: 2, NONE: 0, UNKNOWN: 0 }, overdue_count: 2 });
    const red = (await as((tx) => myTasks.list(tx, EVERYTHING, memberId(WORKER), { band: 'RED' }, { limit: 10 }, NOW))) as { items: Array<{ official_band: { band: string } }>; total: number };
    expect(red.total).toBe(3);
    expect(red.items.every((one) => one.official_band.band === 'RED')).toBe(true);
    const due = (await as((tx) => myTasks.list(tx, EVERYTHING, memberId(WORKER), { dueBefore: day(0), status: 'NOT_STARTED' }, { limit: 10 }, NOW))) as { total: number };
    expect(due.total).toBe(3);
    // The colour filter pages by the database too: one at a time, the same three, with the exact total on every page.
    const redIds: string[] = [];
    let cursor: { code: string; id: string } | undefined;
    for (let step = 0; step < 5; step += 1) {
      const got = (await as((tx) => myTasks.list(tx, EVERYTHING, memberId(WORKER), { band: 'RED' }, { limit: 1, after: cursor }, NOW))) as { items: Array<{ task_id: string }>; next: { code: string; id: string } | null; total: number };
      expect(got.total).toBe(3);
      redIds.push(...got.items.map((one) => one.task_id));
      cursor = got.next ?? undefined;
      if (cursor === undefined) break;
    }
    expect(new Set(redIds).size).toBe(3);
    expect(((await as((tx) => myTasks.list(tx, EVERYTHING, memberId(WORKER), { band: 'UNKNOWN' }, { limit: 5 }, NOW))) as { total: number; items: unknown[] })).toMatchObject({ total: 0, items: [] });
    await expect(as((tx) => myTasks.list(tx, EVERYTHING, memberId(WORKER), { band: 'PURPLE' }, { limit: 10 }, NOW))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('the multi-point reminders (BR-PWF-24)', () => {
  const fire = (at: Date = NOW) => as((tx) => reminders.fire(tx, at), MANAGER);
  const firedRows = () => admin<{ reminder_day: number; audience: string; membership_id: string | null; notified: boolean; schedule_version: number }>('select reminder_day, audience, membership_id, notified, schedule_version from machvon.project_task_reminder order by reminder_day desc, audience');
  const later = (days: number): Date => new Date(NOW.getTime() + days * 86_400_000);

  it('UAT-PWF-IDM-02: fires each point of the rule once for each task and version, in the cadence of the days left, and is silent on a replay', async () => {
    const id = await task(5);
    const first = await fire();
    expect(first.map((notice) => [notice.point, notice.recipient, notice.audience, notice.sourceId, notice.ordinal, notice.severity])).toEqual([[5, memberId(WORKER), 'OFFICIAL', `${id}:1`, 1, 'WATCH']]);
    expect(await fire()).toEqual([]);
    expect(await fire(later(1))).toEqual([]);
    expect((await fire(later(3))).map((notice) => [notice.point, notice.severity])).toEqual([[2, 'WATCH']]);
    expect((await fire(later(5))).map((notice) => [notice.point, notice.severity])).toEqual([[0, 'ACTION']]);
    expect((await fire(later(6))).map((notice) => [notice.point, notice.severity, notice.remaining])).toEqual([[-1, 'ACTION', -1]]);
    expect(await fire(later(6))).toEqual([]);
    // Nothing more once the last point of the rule is past.
    expect(await fire(later(9))).toEqual([]);
    expect((await firedRows()).map((row) => [row.reminder_day, row.notified])).toEqual([[5, true], [2, true], [0, true], [-1, true]]);
  });

  it('tells a person once, of the nearest point, when several were crossed together, and records the others as not sent', async () => {
    await task(0);
    const notices = await fire();
    expect(notices.map((notice) => notice.point)).toEqual([0]);
    const rows = await firedRows();
    expect(rows.map((row) => [row.reminder_day, row.notified])).toEqual([[5, false], [2, false], [0, true]]);
  });

  it('gives a task that is moved to a new version its points again, and drops a task that is done, on hold or cancelled', async () => {
    const id = await task(2);
    expect((await fire()).map((notice) => notice.point)).toEqual([2]);
    await admin(`update machvon.project_task set planned_finish = $2::date, committed_finish = $2::date, schedule_version = 2 where id = $1::uuid`, [id, day(1)]);
    expect((await fire()).map((notice) => [notice.point, notice.sourceId])).toEqual([[2, `${id}:2`]]);
    for (const status of ['ON_HOLD', 'DONE', 'CANCELLED']) {
      await admin(`update machvon.project_task set status = $2, actual_start = coalesce(actual_start, current_date), actual_finish = case when $2 = 'DONE' then current_date else null end, cancelled_at = case when $2 = 'CANCELLED' then now() else null end, schedule_version = schedule_version + 1 where id = $1::uuid`, [id, status]);
      expect([status, await fire()]).toEqual([status, []]);
      await admin(`update machvon.project_task set schedule_version = schedule_version + 1 where id = $1::uuid`, [id]).catch(() => undefined);
    }
  });

  it('adds the days a person asked for, to that person only and only the ones the rule does not already have, and never later than the official last point', async () => {
    await as((tx) => preferences.save(tx, memberId(WORKER), { green_days: null, yellow_days: null, red_days: null, reminder_days: [8, 5, 1] }, 0, NOW));
    const id = await task(8);
    await task(8, { assignee: PEER });
    const notices = await fire();
    expect(notices.map((notice) => [notice.audience, notice.recipient, notice.point, notice.ordinal])).toEqual([['PERSONAL', memberId(WORKER), 8, 101]]);
    expect(notices[0]?.sourceId).toBe(`${id}:1`);
    // 5 is a point of the rule too: the person has it once, from the rule.
    const atFive = await fire(later(3));
    expect(atFive.map((notice) => [notice.audience, notice.point])).toEqual(expect.arrayContaining([['OFFICIAL', 5]]));
    expect(atFive.filter((notice) => notice.point === 5)).toHaveLength(2);
    expect(atFive.filter((notice) => notice.audience === 'PERSONAL')).toEqual([]);
    const rows = await firedRows();
    expect(rows.filter((row) => row.audience === 'PERSONAL').map((row) => row.reminder_day)).toEqual([8]);
  });

  it('tells a person once, of the nearest point of the rule and of their own days together, and records the other crossed points as not sent', async () => {
    await as((tx) => preferences.save(tx, memberId(WORKER), { green_days: null, yellow_days: null, red_days: null, reminder_days: [3] }, 0, NOW));
    const id = await task(2);
    const notices = await fire();
    // The rule's points of 5 and 2 and the person's own 3 are all crossed together: one notice, the nearest (2, the rule's).
    expect(notices.map((notice) => [notice.audience, notice.point, notice.sourceId])).toEqual([['OFFICIAL', 2, `${id}:1`]]);
    expect((await firedRows()).map((row) => [row.audience, row.reminder_day, row.notified]).sort()).toEqual([['OFFICIAL', 2, true], ['OFFICIAL', 5, false], ['PERSONAL', 3, false]].sort());
    expect(await fire()).toEqual([]);
  });

  it('reads a window of many tasks page by page to its end, so none is skipped behind the first rows', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 7; n += 1) ids.push(await task(5));
    const notices = await as((tx) => new PwfTaskReminders(undefined, 3).fire(tx, NOW), MANAGER);
    expect(notices.map((notice) => notice.taskId).sort()).toEqual([...ids].sort());
    expect((await firedRows()).length).toBe(7);
  });

  it('tells nobody who the caller says may not be told, and does not spend the point on them', async () => {
    await task(5);
    const nobody = await as((tx) => reminders.fire(tx, NOW, () => Promise.resolve(false)), MANAGER);
    expect(nobody).toEqual([]);
    expect(await firedRows()).toEqual([]);
    expect((await fire()).map((notice) => notice.point)).toEqual([5]);
  });

  it('does not make up a reminder for a task whose calendar is not published', async () => {
    await task(1);
    await calendars(`update machvon.work_calendar_version set status = 'Superseded'`);
    expect(await fire()).toEqual([]);
    await calendars(`update machvon.work_calendar_version set status = 'Published' where revision = 1`);
    expect((await fire()).length).toBeGreaterThan(0);
  });

  it('looks back as far as the lowest point of the rules goes, whatever the calendar', async () => {
    const rule = await approvedRule(LADDER(5, 2, 0, { reminder_days: [5, 2, 0, -30] }));
    await task(-30);
    // Far beyond the lowest point and the catch-up days: it has had its last point long ago and is not looked at.
    await task(-80);
    const notices = await fire();
    expect(notices.map((notice) => notice.point)).toEqual([-30]);
    await retire(rule);
  });

  it('catches up on the points a missed pass owed to a task already past its last point', async () => {
    await task(-3);
    expect((await fire()).map((notice) => notice.point)).toEqual([-1]);
  });

  it('refuses a second row of the same point (the key of the reminder) and never changes one', async () => {
    const id = await task(5);
    await fire();
    await expect(admin(`insert into machvon.project_task_reminder (tenant_id, task_id, schedule_version, reminder_day, audience, remaining_days, fired_on) values ($1, $2::uuid, 1, 5, 'OFFICIAL', 5, $3::date)`, [TENANT_A, id, TODAY])).rejects.toThrow();
    await expect(as((tx) => tx.query('update machvon.project_task_reminder set notified = false'), MANAGER)).rejects.toThrow();
  });
});

/**
 * The reads are bounded (R35) and the totals are exact: a person with more tasks in the alert window than the alert centre keeps per source is told the list is cut, while their list of tasks and the board say exactly how many there are.
 */
describe('exact totals where the alert centre is cut', () => {
  it('cuts the alert centre at the limit of a source and says so, while my tasks and the board count every one', async () => {
    const LIMIT = 2000;
    const EXTRA = 25;
    await seedSql([
      [
        `insert into machvon.project_task (tenant_id, id, workflow_id, project_id, task_code, name, phase_code, sort_order, kind, required, responsible_role, priority, duration_working_days, status, state, planned_start, planned_finish, committed_start, committed_finish, schedule_version, created_by, updated_by)
         select $1, gen_random_uuid(), $2, $3, 'B' || lpad(n::text, 5, '0'), 'Bulk ' || n, 'P1', n, 'TASK', true, 'ROLE_A', 'NORMAL', 1, 'NOT_STARTED', 'SCHEDULED', current_date + (n % 5), current_date + (n % 5), current_date + (n % 5), current_date + (n % 5), 1, $4, $4 from generate_series(1, $5::int) n`,
        [TENANT_A, workflowDept, projectDept, memberId(MANAGER), LIMIT + EXTRA],
      ],
      [
        `insert into machvon.project_task_assignment (tenant_id, task_id, membership_id, role, valid_from, share_pct, reason, assigned_by)
         select $1, t.id, $2, 'RESPONSIBLE', current_date - 60, 100, 'Given by the test', $3 from machvon.project_task t where t.task_code like 'B%'`,
        [TENANT_A, memberId(WORKER), memberId(MANAGER)],
      ],
    ]);
    const cut = await collect({ mode: 'count' });
    expect(cut.truncated).toBe(true);
    expect(onlyTasks(cut.rows)).toHaveLength(LIMIT);
    const mine = (await as((tx) => myTasks.list(tx, EVERYTHING, memberId(WORKER), {}, { limit: 5 }, NOW))) as { total: number };
    expect(mine.total).toBe(LIMIT + EXTRA);
    const portfolio = (await as((tx) => board.board(tx, EVERYTHING, {}, { limit: 5 }, NOW), MANAGER)) as { total: number; truncated: boolean; shown: number; counts_by_band: Record<string, number> };
    expect(portfolio.total).toBe(LIMIT + EXTRA);
    expect(portfolio.shown).toBe(5);
    expect(portfolio.truncated).toBe(true);
    expect(Object.values(portfolio.counts_by_band).reduce((sum, value) => sum + value, 0)).toBe(LIMIT + EXTRA);
    // Tasks whose days cannot be counted (no calendar) fill a whole chunk and are dropped: the read goes on behind them and does not claim the list is cut.
    await calendars(`update machvon.work_calendar_version set status = 'Superseded' where revision = 1`);
    const blind = await collect({ mode: 'count' });
    // What is due today needs no day counted (no days to count: 0), and is still listed; everything that needs the calendar is dropped, and what is left is not cut.
    expect(onlyTasks(blind.rows).length).toBeGreaterThan(0);
    expect(onlyTasks(blind.rows).every((row) => row.dueOn === TODAY)).toBe(true);
    expect(blind.truncated).toBe(false);
    expect(blind.unavailableSources).not.toContain('PROJECT_TASK');
    await calendars(`update machvon.work_calendar_version set status = 'Published' where revision = 1`);
    expect(pwfDeadlineBand.BAND_COLORS).toHaveLength(3);
  });
});

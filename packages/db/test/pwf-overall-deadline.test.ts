import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import { HomeWorkStore } from '../src/home-work-store';
import type { WorkInput } from '../src/home-work-store';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { PrjProjectStore } from '../src/prj-project-store';
import { PwfDeadlineReads } from '../src/pwf-deadline-reads';
import { PwfTaskReads } from '../src/pwf-task-reads';
import { PwfWorkflowReads } from '../src/pwf-workflow-reads';
import { PwfWorkflowStore } from '../src/pwf-workflow-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from './support/authz-fixtures';

jest.setTimeout(600_000);

/**
 * The deadline of the whole file of a real project (docs PWF 22.2 "Hạn chung của hồ sơ", 22.6, 22.8): the official finish of the task the frozen template marks, with the official colour of that very task on every read, and
 * one alert per running workflow for the one who answers for the project while that colour is yellow or red.
 */

const harness = new AuthzHarness();
const projects = new PrjProjectStore();
const workflows = new PwfWorkflowStore();
const workflowReads = new PwfWorkflowReads();
const taskReads = new PwfTaskReads();
const board = new PwfDeadlineReads();
const work = new HomeWorkStore();

const MANAGER = 1;
const WORKER = 2;
const CHECKER = 3;
const LEADER = 4;
const PROVINCE = 1;
const DEPARTMENT = 2;
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';
const NOW = new Date();
const TODAY = vietnamDateOf(NOW);
const YEAR = Number(TODAY.slice(0, 4));
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
const scopes = { act: everything, read: everything };
const CAN = { manage: true, proposeReschedule: true, work: true, approve: true, assign: true };

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
/** The workflow starts two working days from today, so a task of three working days is due four working days from today. */
const START = workingDayAfter(TODAY, 2);
const DUE_SOON = workingDayAfter(TODAY, 4);

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
const flowOf = (name: string, deadline: Record<string, unknown>, marked: string | null = 'DEADLINE'): Record<string, unknown> => ({
  name,
  phases: [{ code: 'P1', name: 'Phase one', gates: [] }],
  tasks: [plain('OTHER'), plain('DEADLINE', deadline)],
  ...(marked === null ? {} : { overall_deadline_task: marked }),
});

/** Four working days are left on the deadline: red on a ladder (10, 7, 4), yellow on (10, 7, 2), green on (10, 3, 1), and green on the default of the system (5, 2, 0). */
const TEMPLATES: Record<string, Record<string, unknown>> = {
  OVERRED: flowOf('Red deadline', { bands: { green_days: 10, yellow_days: 7, red_days: 4 } }),
  OVERYELLOW: flowOf('Yellow deadline', { bands: { green_days: 10, yellow_days: 7, red_days: 2 } }),
  OVERGREEN: flowOf('Green deadline', { bands: { green_days: 10, yellow_days: 3, red_days: 1 } }),
  OVERSYSTEM: flowOf('Deadline on the policy', {}),
  // The marked task belongs to a branch a project of group B does not have.
  OVERCUT: flowOf('Deadline on a cut branch', { bands: { green_days: 10, yellow_days: 7, red_days: 4 }, when: [{ field: 'project_group', in: ['A'] }] }),
  OVERNONE: flowOf('No deadline of the whole file', { bands: { green_days: 10, yellow_days: 7, red_days: 4 } }, null),
};

const as = <T>(run: (tx: TenantTx) => Promise<T>, member = MANAGER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), run);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

let areaVersion = '';
let counter = 0;

interface Started {
  projectId: string;
  projectName: string;
  workflowId: string;
  ids: Record<string, string>;
}

/** A project of the department, led by LEADER, with a workflow of the template. */
async function started(templateCode: string): Promise<Started> {
  counter += 1;
  const code = `PO-${counter}-${randomUUID().slice(0, 6)}`;
  const created = await as((tx) => projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(DEPARTMENT), areaMasterVersionId: areaVersion, totalInvestmentVnd: '500000000000' }, memberId(MANAGER), TODAY));
  await owner(`update machvon.project set status = 'CONCEPT', project_group = 'B' where id = $1::uuid`, [created.id]);
  await owner(
    `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, status, created_by, updated_by)
     values ($1, gen_random_uuid(), $2::uuid, $3::uuid, 'LEADER_IN_CHARGE', date '2020-01-01', 'ACTIVE', $4::uuid, $4::uuid)`,
    [TENANT_A, created.id, memberId(LEADER), memberId(MANAGER)],
  );
  const workflow = await as((tx) => workflows.start(tx, { projectId: created.id, templateCode, plannedStartDate: START, facts: { project_group: 'B' }, actor: memberId(MANAGER), scopes, now: NOW }));
  const rows = await owner<{ id: string; task_code: string }>('select id, task_code from machvon.project_task where workflow_id = $1::uuid', [workflow.id]);
  return { projectId: created.id, projectName: `Project ${code}`, workflowId: workflow.id, ids: Object.fromEntries(rows.map((row) => [row.task_code, row.id])) };
}

interface Overall {
  task_id: string;
  task_code: string;
  task_name: string;
  due_on: string | null;
  band: string;
  band_tier: string | null;
  remaining_days: number | null;
}
type Detail = { overall_deadline: Overall | null; tasks: Array<{ id: string; task_code: string; is_overall_deadline?: boolean; planned_finish: string | null; band: { band: string; remaining_days: number | null }; band_tier?: string }> };
const detailOf = (flow: Started): Promise<Detail> => as((tx) => workflowReads.detail(tx, everything, flow.projectId, NOW, CAN)) as unknown as Promise<Detail>;

const input = (member: number, over: Partial<WorkInput> = {}): WorkInput => ({ membershipId: memberId(member), now: NOW, today: TODAY, unitScope: everything, projectScope: everything, mode: 'rows', ...over });
/** The alerts of the deadline of the whole file a person sees, among the workflows of this test. */
const alerts = async (member: number, over: Partial<WorkInput> = {}) => (await as((tx) => work.collect(tx, input(member, over)), member)).rows.filter((row) => row.kind === 'PWF_OVERALL_DEADLINE_AT_RISK');
const alertOf = async (flow: Started, member: number = LEADER, over: Partial<WorkInput> = {}) => (await alerts(member, over)).filter((row) => row.id === `${flow.workflowId}:overall`);

beforeAll(async () => {
  await harness.start();
  await harness.seedUnits(TENANT_A, [
    { n: PROVINCE, path: '/u1/' },
    { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
  ]);
  await harness.seedMembership(TENANT_A, MANAGER, PROVINCE);
  await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: SYSTEM_ACTOR, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, SYSTEM_ACTOR, TODAY));
  for (const n of [WORKER, CHECKER, LEADER]) await harness.seedMembership(TENANT_A, n, DEPARTMENT);
  const recordId = randomUUID();
  areaVersion = randomUUID();
  await harness.owner(TENANT_A, [
    [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'AREA-O', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(MANAGER)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, 'AREA', 'AREA-O', 1, 'Area', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $3, now(), $4, $4)`,
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
  for (const [code, params] of Object.entries(TEMPLATES)) {
    await owner(
      `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
       values ($1, 'PROJECT_WORKFLOW_TEMPLATE', $2, 1, 'APPROVED', $3::jsonb, date '2020-01-01', 'A template for the tests', $4, $5, now(), $6, now())`,
      [TENANT_A, code, JSON.stringify(params), memberId(MANAGER), memberId(WORKER), memberId(CHECKER)],
    );
  }
});

afterAll(async () => {
  await harness.stop();
}, 60_000);

describe('the deadline of the whole file of a project (PWF 22.2)', () => {
  it('is the official finish of the task the frozen template marks, with the colour, the tier and the days left of that very task on every read', async () => {
    const flow = await started('OVERRED');
    // The database writes the code of the marked task beside the frozen template, in the insert that starts the workflow.
    expect(await owner('select overall_deadline_task from machvon.project_workflow where id = $1::uuid', [flow.workflowId])).toEqual([{ overall_deadline_task: 'DEADLINE' }]);

    const detail = await detailOf(flow);
    expect(detail.overall_deadline).toEqual({ task_id: flow.ids.DEADLINE, task_code: 'DEADLINE', task_name: 'Task DEADLINE', due_on: DUE_SOON, band: 'RED', band_tier: 'STEP', remaining_days: 4 });
    const overall = detail.overall_deadline as Overall;
    // The row of that task in the same answer, in the list, in full and on the deadline board: one colour everywhere.
    const row = detail.tasks.find((one) => one.task_code === 'DEADLINE');
    expect({ due: row?.planned_finish, band: row?.band.band, tier: row?.band_tier, left: row?.band.remaining_days }).toEqual({ due: overall.due_on, band: overall.band, tier: overall.band_tier, left: overall.remaining_days });
    expect(detail.tasks.map((one) => [one.task_code, one.is_overall_deadline]).sort()).toEqual([['DEADLINE', true], ['OTHER', false]]);
    const listed = await as((tx) => workflowReads.listTasks(tx, everything, flow.projectId, {}, { limit: 50 }, NOW));
    const item = listed.items.find((one) => one.task_code === 'DEADLINE');
    expect({ due: item?.planned_finish, band: item?.band.band, tier: item?.band_tier, left: item?.band.remaining_days }).toEqual({ due: overall.due_on, band: overall.band, tier: overall.band_tier, left: overall.remaining_days });
    expect(listed.items.map((one) => [one.task_code, one.is_overall_deadline]).sort()).toEqual([['DEADLINE', true], ['OTHER', false]]);
    const full = (await as((tx) => taskReads.task(tx, everything, flow.ids.DEADLINE as string, NOW, memberId(MANAGER), CAN))) as { band: { band: string; remaining_days: number | null }; band_tier: string };
    expect({ band: full.band.band, tier: full.band_tier, left: full.band.remaining_days }).toEqual({ band: overall.band, tier: overall.band_tier, left: overall.remaining_days });
    const onBoard = (await as((tx) => board.board(tx, everything, { projectId: flow.projectId }, { limit: 50 }, NOW))) as { items: Array<{ task_id: string; band: { band: string }; band_tier: string }> };
    expect(onBoard.items.find((one) => one.task_id === flow.ids.DEADLINE)).toMatchObject({ band: { band: overall.band }, band_tier: overall.band_tier });
  });

  it('follows the policy when the marked task has no ladder of its own, and is null when the template marks no task or the project does not have the marked task', async () => {
    const system = await detailOf(await started('OVERSYSTEM'));
    expect(system.overall_deadline).toMatchObject({ task_code: 'DEADLINE', due_on: DUE_SOON, band: 'GREEN', band_tier: 'SYSTEM', remaining_days: 4 });
    expect(system.tasks.find((one) => one.task_code === 'DEADLINE')).toMatchObject({ band: { band: 'GREEN' }, band_tier: 'SYSTEM' });

    const none = await started('OVERNONE');
    expect((await detailOf(none)).overall_deadline).toBeNull();
    expect((await detailOf(none)).tasks.every((one) => one.is_overall_deadline === false)).toBe(true);
    expect(await owner('select overall_deadline_task from machvon.project_workflow where id = $1::uuid', [none.workflowId])).toEqual([{ overall_deadline_task: null }]);

    // The branch of the marked task was cut for this project: no deadline of the whole file, no other task stands in, and no alert.
    const cut = await started('OVERCUT');
    const detail = await detailOf(cut);
    expect(detail.overall_deadline).toBeNull();
    expect(await owner('select excluded from machvon.project_task where id = $1::uuid', [cut.ids.DEADLINE])).toEqual([{ excluded: true }]);
    expect(await alertOf(cut)).toEqual([]);
    expect(await alertOf(cut, MANAGER, { view: 'scope' })).toEqual([]);
    expect(await alertOf(none, MANAGER, { view: 'scope' })).toEqual([]);
  });
});

describe('the alert of the deadline of the whole file (PWF 22.6)', () => {
  it('tells the one who answers for the project when the colour is yellow (to watch) or red (to act on), one item per workflow, and nothing while it is green', async () => {
    const red = await started('OVERRED');
    const yellow = await started('OVERYELLOW');
    const green = await started('OVERGREEN');
    const system = await started('OVERSYSTEM');

    const mine = await alertOf(red);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      source: 'PROJECT_TASK',
      kind: 'PWF_OVERALL_DEADLINE_AT_RISK',
      severity: 'ACTION',
      status: 'DUE_TODAY',
      dueOn: DUE_SOON,
      title: 'Hạn chung của hồ sơ: còn 4 ngày làm việc',
      target: { screen: 'PWF-03', id: red.projectId },
    });
    expect(mine[0]?.subtitle).toContain(red.projectName);
    expect(mine[0]?.subtitle).toContain('Task DEADLINE');
    expect(mine[0]?.consequence).toBeTruthy();
    // The colour of the alert is the colour of the task on the reads.
    expect((await detailOf(red)).overall_deadline?.band).toBe('RED');
    expect((await alertOf(yellow))[0]).toMatchObject({ severity: 'WATCH', status: 'AT_RISK', dueOn: DUE_SOON });
    expect((await detailOf(yellow)).overall_deadline).toMatchObject({ band: 'YELLOW', band_tier: 'STEP' });
    // Green (by its own ladder, or by the default of the system) is no alert.
    expect((await detailOf(green)).overall_deadline?.band).toBe('GREEN');
    expect(await alertOf(green)).toEqual([]);
    expect(await alertOf(system)).toEqual([]);

    // It is the work of the one who answers for the project: the leader sees it as theirs; a colleague does not; whoever may read the project sees it in the view of the scope, and nobody outside what they may read.
    expect(await alertOf(red, WORKER)).toEqual([]);
    expect(await alertOf(red, MANAGER, { view: 'scope' })).toHaveLength(1);
    expect(await alertOf(red, MANAGER, { view: 'scope', projectScope: nothing })).toEqual([]);
    expect(await alertOf(red, LEADER, { projectScope: nothing })).toEqual([]);
    // One item per workflow.
    const all = await alerts(MANAGER, { view: 'scope' });
    expect(new Set(all.map((row) => row.id)).size).toBe(all.length);
    expect(all.filter((row) => [red, yellow, green, system].some((flow) => row.id === `${flow.workflowId}:overall`)).map((row) => row.id).sort()).toEqual([`${red.workflowId}:overall`, `${yellow.workflowId}:overall`].sort());
  });

  it('goes past its day as a task does, and leaves the list when the task is done, when the workflow is paused, and when the day moves back into green', async () => {
    const flow = await started('OVERRED');
    expect(await alertOf(flow)).toHaveLength(1);
    // The official day is moved a long way out: beyond the green line of the task there is no colour and no alert.
    await owner(`update machvon.project_task set committed_finish = $2::date where id = $1::uuid`, [flow.ids.DEADLINE, workingDayAfter(TODAY, 40)]);
    expect((await detailOf(flow)).overall_deadline?.band).toBe('NONE');
    expect(await alertOf(flow)).toEqual([]);
    // The day has passed: overdue, to be acted on, in the words of a deadline that is past.
    const past = addDays(TODAY, -7);
    await owner(`update machvon.project_task set committed_start = $2::date - 3, committed_finish = $2::date where id = $1::uuid`, [flow.ids.DEADLINE, past]);
    const overdue = await alertOf(flow);
    expect(overdue[0]).toMatchObject({ status: 'OVERDUE', dueOn: past });
    expect(['ACTION', 'URGENT']).toContain(overdue[0]?.severity);
    expect(overdue[0]?.title).toMatch(/^Hạn chung của hồ sơ: quá hạn \d+ ngày làm việc$/);
    expect((await detailOf(flow)).overall_deadline?.band).toBe('RED');
    // A paused workflow tells nothing; running again it tells it again.
    await owner(`update machvon.project_workflow set status = 'ON_HOLD' where id = $1::uuid`, [flow.workflowId]);
    expect(await alertOf(flow)).toEqual([]);
    await owner(`update machvon.project_workflow set status = 'ACTIVE' where id = $1::uuid`, [flow.workflowId]);
    expect(await alertOf(flow)).toHaveLength(1);
    // The task is done: the alert is gone for everyone, and the deadline of the whole file has no colour any more.
    await owner(`update machvon.project_task set status = 'DONE', actual_start = $2::date, actual_finish = $2::date where id = $1::uuid`, [flow.ids.DEADLINE, TODAY]);
    expect(await alertOf(flow)).toEqual([]);
    expect(await alertOf(flow, MANAGER, { view: 'scope' })).toEqual([]);
    expect((await detailOf(flow)).overall_deadline).toMatchObject({ task_code: 'DEADLINE', band: 'NONE' });
  });
});

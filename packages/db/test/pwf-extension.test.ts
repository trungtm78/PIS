import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { PrjProjectStore } from '../src/prj-project-store';
import { PwfRescheduleStore } from '../src/pwf-reschedule-store';
import type { ProposalView, RescheduleInput } from '../src/pwf-reschedule-store';
import { PwfTaskReads } from '../src/pwf-task-reads';
import { PwfWorkflowReads } from '../src/pwf-workflow-reads';
import { PwfWorkflowStore } from '../src/pwf-workflow-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from './support/authz-fixtures';

jest.setTimeout(600_000);

/**
 * PWF-5 (docs PWF 22.4, R72): a reschedule proposal extends the limit of tasks in their own unit; the caps of the frozen template are judged on the whole proposal when it is made and again when it is approved, and only the
 * approval spends them, with the publication. A task that merely follows is CASCADED and keeps its counters; a raise through `overrides.change` of a task that has an extension rule is refused.
 */

const harness = new AuthzHarness();
const projects = new PrjProjectStore();
const workflows = new PwfWorkflowStore();
const reschedules = new PwfRescheduleStore();
const taskReads = new PwfTaskReads();
const workflowReads = new PwfWorkflowReads();

const MANAGER = 1;
const WORKER = 2;
const CHECKER = 3;
const OTHER = 4;
const PROVINCE = 1;
const DEPARTMENT = 2;
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';
const NOW = new Date();
const TODAY = vietnamDateOf(NOW);
const YEAR = Number(TODAY.slice(0, 4));
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const scopes = { act: everything, read: everything };
const CAN = { manage: true, proposeReschedule: true, work: true, approve: true, assign: true };
const REASON = 'The appraisal needs more time than the template gave it';

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** The calendar of the test: Monday to Friday, no holidays. */
const worked = (day: string): boolean => ![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
const workingDayAfter = (from: string, count: number): string => {
  let cursor = from;
  for (let left = count; left > 0; ) {
    cursor = addDays(cursor, 1);
    if (worked(cursor)) left -= 1;
  }
  return cursor;
};
/** A last day nobody works rolls to the next working day. */
const rolled = (day: string): string => (worked(day) ? day : rolled(addDays(day, 1)));
/** The same day of the month `months` later, the last day of a shorter month. */
const addMonths = (day: string, months: number): string => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
};

/** The workflow starts two working days from today: every task without a predecessor starts that day. */
const START = workingDayAfter(TODAY, 2);

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
 * A: three working days, at most two extensions and five days in all; B follows A and says nothing of extensions (the task of every template before R72); C forbids extensions; D may be extended without a cap; W has a limit
 * of five working days written as a `duration`; CAL is ten calendar days (at most thirty more), MON one month (no cap); CALP is ten calendar days and says nothing of extensions.
 */
const EXTFLOW = {
  name: 'Extension flow',
  phases: [{ code: 'P1', name: 'Phase one', gates: [] }],
  tasks: [
    plain('TA', { extension: { allowed: true, max_times: 2, max_value: 5, unit: 'WORKING_DAY' } }),
    plain('TB', { predecessors: [{ task: 'TA', kind: 'FS', lag_working_days: 0 }] }),
    plain('TC', { extension: { allowed: false, unit: 'WORKING_DAY' } }),
    plain('TD', { extension: { allowed: true, unit: 'WORKING_DAY' } }),
    plain('TW', { duration_working_days: 5, duration: { value: 5, unit: 'WORKING_DAY', roll_to_working_day: true }, extension: { allowed: true, max_times: 3, unit: 'WORKING_DAY' } }),
    plain('CAL', { duration_working_days: 8, duration: { value: 10, unit: 'CALENDAR_DAY', roll_to_working_day: true }, extension: { allowed: true, max_value: 30, unit: 'CALENDAR_DAY' } }),
    plain('MON', { duration_working_days: 22, duration: { value: 1, unit: 'MONTH', roll_to_working_day: true }, extension: { allowed: true, unit: 'MONTH' } }),
    plain('CALP', { duration_working_days: 8, duration: { value: 10, unit: 'CALENDAR_DAY', roll_to_working_day: true } }),
  ],
};

const as = <T>(run: (tx: TenantTx) => Promise<T>, member = MANAGER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), run);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

let areaVersion = '';
let counter = 0;

interface Started {
  projectId: string;
  workflowId: string;
  ids: Record<string, string>;
}

async function started(): Promise<Started> {
  counter += 1;
  const code = `PX-${counter}-${randomUUID().slice(0, 6)}`;
  const created = await as((tx) => projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(DEPARTMENT), areaMasterVersionId: areaVersion, totalInvestmentVnd: '500000000000' }, memberId(MANAGER), TODAY));
  await owner(`update machvon.project set status = 'CONCEPT', project_group = 'B' where id = $1::uuid`, [created.id]);
  const workflow = await as((tx) => workflows.start(tx, { projectId: created.id, templateCode: 'EXTFLOW', plannedStartDate: START, facts: { project_group: 'B' }, actor: memberId(MANAGER), scopes, now: NOW }));
  const rows = await owner<{ id: string; task_code: string }>('select id, task_code from machvon.project_task where workflow_id = $1::uuid', [workflow.id]);
  return { projectId: created.id, workflowId: workflow.id, ids: Object.fromEntries(rows.map((row) => [row.task_code, row.id])) };
}

type Stored = Record<string, unknown>;
const taskOf = async (flow: Started, code: string): Promise<Stored> =>
  (await owner<{ j: Stored }>('select to_jsonb(t) as j from machvon.project_task t where workflow_id = $1::uuid and task_code = $2', [flow.workflowId, code]))[0]?.j as Stored;
const usedOf = async (flow: Started, code: string): Promise<[number, number]> => {
  const row = await taskOf(flow, code);
  return [Number(row.extension_times_used), Number(row.extension_value_used)];
};
const versionOf = async (flow: Started): Promise<number> => Number((await owner<{ version: number }>('select version from machvon.project_workflow where id = $1::uuid', [flow.workflowId]))[0]?.version);
const schedulesOf = async (flow: Started): Promise<number> => (await owner('select 1 from machvon.project_schedule_version where workflow_id = $1::uuid', [flow.workflowId])).length;
const proposalsOf = async (flow: Started): Promise<string[]> => (await owner<{ status: string }>('select status from machvon.project_reschedule_proposal where workflow_id = $1::uuid order by proposed_at', [flow.workflowId])).map((one) => one.status);

type Input = Omit<RescheduleInput, 'reason'>;
const propose = async (flow: Started, input: Input, member = MANAGER): Promise<ProposalView> => {
  const version = await versionOf(flow);
  return as((tx) => reschedules.propose(tx, { projectId: flow.projectId, expectedVersion: version, input: { reason: REASON, ...input }, actor: memberId(member), scopes, now: NOW }), member);
};
const decide = (proposal: ProposalView, member = CHECKER, decision = 'APPROVE') =>
  as((tx) => reschedules.decide(tx, { proposalId: proposal.id, expectedVersion: proposal.baseVersion, decision, actor: memberId(member), scopes, now: NOW }), member);
const approved = async (flow: Started, input: Input): Promise<ProposalView> => {
  const proposal = await propose(flow, input);
  await decide(proposal);
  return proposal;
};

interface Refusal {
  code: string;
  status: number;
  detail?: string;
  extensions?: Record<string, unknown>;
}
const refusal = (attempt: Promise<unknown>): Promise<Refusal> =>
  attempt.then(
    () => {
      throw new Error('a refusal was expected');
    },
    (error: Refusal) => error,
  );
const causeOf = (proposal: ProposalView, code: string): string | undefined => proposal.preview.changes.find((one) => one.code === code)?.cause;

beforeAll(async () => {
  await harness.start();
  await harness.seedUnits(TENANT_A, [
    { n: PROVINCE, path: '/u1/' },
    { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
  ]);
  await harness.seedMembership(TENANT_A, MANAGER, PROVINCE);
  await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: SYSTEM_ACTOR, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, SYSTEM_ACTOR, TODAY));
  for (const n of [WORKER, CHECKER, OTHER]) await harness.seedMembership(TENANT_A, n, DEPARTMENT);
  const recordId = randomUUID();
  areaVersion = randomUUID();
  await harness.owner(TENANT_A, [
    [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'AREA-X', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(MANAGER)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, 'AREA', 'AREA-X', 1, 'Area', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $3, now(), $4, $4)`,
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
  await owner(
    `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
     values ($1, 'PROJECT_WORKFLOW_TEMPLATE', 'EXTFLOW', 1, 'APPROVED', $2::jsonb, date '2020-01-01', 'A template for the tests', $3, $4, now(), $5, now())`,
    [TENANT_A, JSON.stringify(EXTFLOW), memberId(MANAGER), memberId(WORKER), memberId(CHECKER)],
  );
}, 300_000);

afterAll(async () => {
  await harness.stop();
});

describe('extending the limit of a task through a reschedule proposal (PWF 22.4, R72)', () => {
  it('an extension within the caps moves the limit, the days and the counters only when it is approved; the task that follows is CASCADED and keeps its counters; the frozen template stays', async () => {
    const flow = await started();
    const frozen = await owner<{ template: string; template_hash: string }>('select template::text as template, template_hash from machvon.project_workflow where id = $1::uuid', [flow.workflowId]);
    const before = { a: await taskOf(flow, 'TA'), b: await taskOf(flow, 'TB') };
    expect(before.a).toMatchObject({ duration_working_days: 3, committed_start: START, committed_finish: workingDayAfter(START, 2), extension_times_used: 0, extension_value_used: 0 });
    expect(before.b).toMatchObject({ committed_start: workingDayAfter(START, 3) });

    const proposal = await propose(flow, { extensions: [{ taskCode: 'TA', addValue: 2 }] });
    expect(proposal.extensions).toEqual([{ taskCode: 'TA', addValue: 2, unit: 'WORKING_DAY' }]);
    expect(proposal.preview.changes.find((one) => one.code === 'TA')).toMatchObject({ startShiftDays: 0, finishShiftDays: 2, cause: 'EXTENDED' });
    expect(proposal.preview.changes.find((one) => one.code === 'TB')).toMatchObject({ startShiftDays: 2, finishShiftDays: 2, cause: 'CASCADED' });
    // The tasks that do not move are not listed, so nothing else has a cause.
    expect(proposal.preview.changes.filter((one) => one.cause !== undefined).map((one) => one.code).sort()).toEqual(['TA', 'TB']);
    // While the proposal waits nothing is spent and nothing moves.
    expect(await taskOf(flow, 'TA')).toMatchObject({ duration_working_days: 3, committed_finish: before.a.committed_finish, extension_times_used: 0, extension_value_used: 0 });
    expect((await as((tx) => reschedules.read(tx, everything, proposal.id))).extensions).toEqual([{ taskCode: 'TA', addValue: 2, unit: 'WORKING_DAY' }]);

    const done = await decide(proposal);
    expect(done.scheduleVersion).toBe(2);
    expect(await taskOf(flow, 'TA')).toMatchObject({ duration_working_days: 5, duration_value: null, committed_start: START, committed_finish: workingDayAfter(START, 4), extension_times_used: 1, extension_value_used: 2, effective_working_days: 5 });
    // The successor moved by the same two working days, with the limit and the counters it had.
    expect(await taskOf(flow, 'TB')).toMatchObject({ duration_working_days: 3, committed_start: workingDayAfter(START, 5), committed_finish: workingDayAfter(START, 7), extension_times_used: 0, extension_value_used: 0 });
    for (const code of ['TC', 'TD', 'TW', 'CAL', 'MON', 'CALP']) expect(await usedOf(flow, code)).toEqual([0, 0]);
    // The published version keeps the cause of each move; the log of the extended task alone keeps the extension.
    const [version] = await owner<{ changes: Array<{ code: string; cause?: string }> }>('select changes from machvon.project_schedule_version where workflow_id = $1::uuid and version = 2', [flow.workflowId]);
    expect(Object.fromEntries((version?.changes ?? []).filter((one) => one.cause !== undefined).map((one) => [one.code, one.cause]))).toEqual({ TA: 'EXTENDED', TB: 'CASCADED' });
    const log = await owner<{ task_id: string; subject: Record<string, unknown> }>(`select task_id, subject from machvon.project_task_log where workflow_id = $1::uuid and kind = 'TASK_EXTENDED'`, [flow.workflowId]);
    expect(log.map((one) => one.task_id)).toEqual([flow.ids.TA]);
    expect(log[0]?.subject).toMatchObject({ proposal_id: proposal.id, task_code: 'TA', lines: 1, add_value: 2, unit: 'WORKING_DAY', limit_before: 3, limit_after: 5, times_used: 1, value_used: 2 });
    // The template the workflow froze is what it was.
    expect(await owner('select template::text as template, template_hash from machvon.project_workflow where id = $1::uuid', [flow.workflowId])).toEqual(frozen);

    // The reads tell the rule and what is used of it; a task whose template declares no rule says nothing.
    const used = { allowed: true, max_times: 2, max_value: 5, unit: 'WORKING_DAY', times_used: 1, value_used: 2 };
    const detailOf = (code: string): Promise<Record<string, unknown>> => as((tx) => taskReads.task(tx, everything, flow.ids[code] as string, NOW, memberId(MANAGER), CAN));
    expect((await detailOf('TA')).extension).toEqual(used);
    expect('extension' in (await detailOf('TB'))).toBe(false);
    expect((await detailOf('TC')).extension).toEqual({ allowed: false, max_times: null, max_value: null, unit: 'WORKING_DAY', times_used: 0, value_used: 0 });
    const whole = (await as((tx) => workflowReads.detail(tx, everything, flow.projectId, NOW, CAN))) as { tasks: Array<Record<string, unknown>> };
    expect(whole.tasks.find((one) => one.task_code === 'TA')?.extension).toEqual(used);
    expect('extension' in (whole.tasks.find((one) => one.task_code === 'TB') as object)).toBe(false);
    const listed = await as((tx) => workflowReads.listTasks(tx, everything, flow.projectId, {}, { limit: 50 }, NOW));
    expect(listed.items.find((one) => one.task_code === 'CAL')?.extension).toEqual({ allowed: true, max_times: null, max_value: 30, unit: 'CALENDAR_DAY', times_used: 0, value_used: 0 });
  });

  it('refuses at the proposal an extension over the cap of the value or of the times (422 with the task, the cap, what is used and asked), and keeps no proposal', async () => {
    const flow = await started();
    const value = await refusal(propose(flow, { extensions: [{ taskCode: 'TA', addValue: 6 }] }));
    expect(value).toMatchObject({ code: 'PWF_EXTENSION_LIMIT_EXCEEDED', status: 422, extensions: { task_code: 'TA', limit: 'VALUE', used: 0, asked: 6, max: 5 } });
    const times = await refusal(propose(flow, { extensions: [{ taskCode: 'TA', addValue: 1 }, { taskCode: 'TA', addValue: 1 }, { taskCode: 'TA', addValue: 1 }] }));
    expect(times).toMatchObject({ code: 'PWF_EXTENSION_LIMIT_EXCEEDED', status: 422, extensions: { task_code: 'TA', limit: 'TIMES', used: 0, asked: 3, max: 2 } });
    expect(await proposalsOf(flow)).toEqual([]);
    expect(await usedOf(flow, 'TA')).toEqual([0, 0]);
  });

  it('adds up the approved extensions of a task over the life of the workflow: the second proposal is judged on what the first one spent', async () => {
    const flow = await started();
    await approved(flow, { extensions: [{ taskCode: 'TA', addValue: 2 }] });
    expect(await refusal(propose(flow, { extensions: [{ taskCode: 'TA', addValue: 4 }] }))).toMatchObject({ code: 'PWF_EXTENSION_LIMIT_EXCEEDED', extensions: { task_code: 'TA', limit: 'VALUE', used: 2, asked: 4, max: 5 } });
    await approved(flow, { extensions: [{ taskCode: 'TA', addValue: 3 }] });
    expect(await taskOf(flow, 'TA')).toMatchObject({ duration_working_days: 8, committed_finish: workingDayAfter(START, 7), extension_times_used: 2, extension_value_used: 5 });
    const third = await refusal(propose(flow, { extensions: [{ taskCode: 'TA', addValue: 1 }] }));
    expect(third).toMatchObject({ code: 'PWF_EXTENSION_LIMIT_EXCEEDED', status: 422, extensions: { task_code: 'TA', limit: 'TIMES', used: 2, asked: 1, max: 2 } });
    expect((third.extensions?.refusals as Array<{ limit: string }>).map((one) => one.limit)).toEqual(['TIMES', 'VALUE']);
    expect(await schedulesOf(flow)).toBe(3);
  });

  it('judges a proposal that names several tasks and one task several times as a whole, and extends a limit in calendar days and one in months in their own unit, by the real calendar', async () => {
    const flow = await started();
    expect(await taskOf(flow, 'CAL')).toMatchObject({ duration_value: 10, duration_working_days: 8, committed_finish: rolled(addDays(START, 9)) });
    expect(await taskOf(flow, 'MON')).toMatchObject({ duration_value: 1, duration_working_days: 22, committed_finish: rolled(addMonths(START, 1)) });
    // One line too many for TA refuses the whole proposal: the lines of CAL are not kept either.
    const over = await refusal(propose(flow, { extensions: [{ taskCode: 'CAL', addValue: 4 }, { taskCode: 'TA', addValue: 3 }, { taskCode: 'TA', addValue: 3 }] }));
    expect(over).toMatchObject({ code: 'PWF_EXTENSION_LIMIT_EXCEEDED', extensions: { task_code: 'TA', limit: 'VALUE', used: 0, asked: 6, max: 5 } });
    expect(await proposalsOf(flow)).toEqual([]);

    const proposal = await propose(flow, { extensions: [{ taskCode: 'TA', addValue: 1 }, { taskCode: 'CAL', addValue: 4 }, { taskCode: 'TA', addValue: 2 }, { taskCode: 'MON', addValue: 1 }] });
    expect(proposal.extensions.map((one) => [one.taskCode, one.addValue, one.unit])).toEqual([['TA', 1, 'WORKING_DAY'], ['CAL', 4, 'CALENDAR_DAY'], ['TA', 2, 'WORKING_DAY'], ['MON', 1, 'MONTH']]);
    for (const code of ['TA', 'CAL', 'MON']) expect(causeOf(proposal, code)).toBe('EXTENDED');
    expect(causeOf(proposal, 'TB')).toBe('CASCADED');
    await decide(proposal);
    // Two lines of TA: two times, three days.
    expect(await taskOf(flow, 'TA')).toMatchObject({ duration_working_days: 6, committed_finish: workingDayAfter(START, 5), extension_times_used: 2, extension_value_used: 3 });
    // Fourteen calendar days from the start (the first day counts), rolled to a working day; the nominal working days follow the new limit.
    expect(await taskOf(flow, 'CAL')).toMatchObject({ duration_value: 14, duration_unit: 'CALENDAR_DAY', duration_working_days: 10, committed_start: START, committed_finish: rolled(addDays(START, 13)), extension_times_used: 1, extension_value_used: 4 });
    // Two months from the start: the same day of the month, rolled to a working day.
    expect(await taskOf(flow, 'MON')).toMatchObject({ duration_value: 2, duration_unit: 'MONTH', duration_working_days: 44, committed_start: START, committed_finish: rolled(addMonths(START, 2)), extension_times_used: 1, extension_value_used: 1 });
    expect(await usedOf(flow, 'TB')).toEqual([0, 0]);
    expect(await usedOf(flow, 'CALP')).toEqual([0, 0]);
  });

  it('refuses the approval of a proposal whose cap was spent since it was made: nothing is applied, the approver is told why, the proposal waits for a rejection', async () => {
    const flow = await started();
    const proposal = await propose(flow, { extensions: [{ taskCode: 'TA', addValue: 2 }, { taskCode: 'CAL', addValue: 4 }] });
    // The cap of TA is spent behind the proposal (the workflow itself did not move).
    await owner('update machvon.project_task set extension_times_used = 2 where id = $1::uuid', [flow.ids.TA]);
    const refused = await refusal(decide(proposal));
    expect(refused).toMatchObject({
      code: 'PWF_SCHEDULE_VERSION_CONFLICT',
      status: 409,
      extensions: { reason: 'EXTENSION_REFUSED', extension_code: 'PWF_EXTENSION_LIMIT_EXCEEDED', task_code: 'TA', limit: 'TIMES', used: 2, asked: 1, max: 2 },
    });
    // Not in part either: the line of CAL, which still fits, is not applied.
    expect(await taskOf(flow, 'TA')).toMatchObject({ duration_working_days: 3, committed_finish: workingDayAfter(START, 2), extension_times_used: 2, extension_value_used: 0 });
    expect(await taskOf(flow, 'CAL')).toMatchObject({ duration_value: 10, extension_times_used: 0, extension_value_used: 0 });
    expect(await schedulesOf(flow)).toBe(1);
    expect(await proposalsOf(flow)).toEqual(['PROPOSED']);
    expect((await owner(`select 1 from machvon.project_task_log where workflow_id = $1::uuid and kind = 'TASK_EXTENDED'`, [flow.workflowId])).length).toBe(0);
    // A person closes it.
    await decide(proposal, CHECKER, 'REJECT');
    expect(await proposalsOf(flow)).toEqual(['REJECTED']);
    expect(await usedOf(flow, 'CAL')).toEqual([0, 0]);
  });

  it('lets two approvers race for the same cap: exactly one approval wins and the cap is spent once', async () => {
    const flow = await started();
    const proposal = await propose(flow, { extensions: [{ taskCode: 'TA', addValue: 2 }, { taskCode: 'TA', addValue: 3 }] });
    const results = await Promise.allSettled([decide(proposal, CHECKER), decide(proposal, OTHER)]);
    expect(results.filter((one) => one.status === 'fulfilled').length).toBe(1);
    const lost = results.find((one) => one.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as Refusal).code).toBe('PWF_SCHEDULE_VERSION_CONFLICT');
    expect(await taskOf(flow, 'TA')).toMatchObject({ duration_working_days: 8, extension_times_used: 2, extension_value_used: 5 });
    expect(await schedulesOf(flow)).toBe(2);
    expect((await owner(`select 1 from machvon.project_task_log where workflow_id = $1::uuid and kind = 'TASK_EXTENDED'`, [flow.workflowId])).length).toBe(1);
  });

  it('spends nothing for a proposal that is rejected: the whole cap is still there for the next one', async () => {
    const flow = await started();
    const proposal = await propose(flow, { extensions: [{ taskCode: 'TA', addValue: 5 }] });
    await decide(proposal, CHECKER, 'REJECT');
    expect(await taskOf(flow, 'TA')).toMatchObject({ duration_working_days: 3, committed_finish: workingDayAfter(START, 2), extension_times_used: 0, extension_value_used: 0 });
    expect(await schedulesOf(flow)).toBe(1);
    await approved(flow, { extensions: [{ taskCode: 'TA', addValue: 5 }] });
    expect(await usedOf(flow, 'TA')).toEqual([1, 5]);
  });

  it('has no back door: raising through `change` the limit of a task that has an extension rule is 422 PWF_EXTENSION_REQUIRED, lowering it is an ordinary change that spends nothing', async () => {
    const flow = await started();
    expect(await refusal(propose(flow, { overrides: { change: [{ taskCode: 'TA', durationWorkingDays: 4 }] } }))).toMatchObject({ code: 'PWF_EXTENSION_REQUIRED', status: 422, extensions: { task_code: 'TA', extension_allowed: true } });
    expect(await refusal(propose(flow, { overrides: { change: [{ taskCode: 'TW', durationValue: 9 }] } }))).toMatchObject({ code: 'PWF_EXTENSION_REQUIRED', status: 422, extensions: { task_code: 'TW' } });
    expect(await refusal(propose(flow, { overrides: { change: [{ taskCode: 'TW', durationWorkingDays: 6 }] } }))).toMatchObject({ code: 'PWF_EXTENSION_REQUIRED', extensions: { task_code: 'TW' } });
    expect(await refusal(propose(flow, { overrides: { change: [{ taskCode: 'CAL', durationValue: 12 }] } }))).toMatchObject({ code: 'PWF_EXTENSION_REQUIRED', extensions: { task_code: 'CAL' } });
    // One proposal cannot both extend a task and change its limit.
    expect(await refusal(propose(flow, { extensions: [{ taskCode: 'TA', addValue: 1 }], overrides: { change: [{ taskCode: 'TA', durationWorkingDays: 2 }] } }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'extensions[0].task_code' });
    expect(await proposalsOf(flow)).toEqual([]);

    const lower = await propose(flow, { overrides: { change: [{ taskCode: 'TA', durationWorkingDays: 2 }, { taskCode: 'TW', durationWorkingDays: 3 }, { taskCode: 'CAL', durationValue: 7 }] } });
    // A task the proposal changes itself is neither extended nor cascaded; the one behind it follows.
    expect(causeOf(lower, 'TA')).toBeUndefined();
    expect(causeOf(lower, 'TB')).toBe('CASCADED');
    await decide(lower);
    expect(await taskOf(flow, 'TA')).toMatchObject({ duration_working_days: 2, committed_finish: workingDayAfter(START, 1), extension_times_used: 0, extension_value_used: 0 });
    // A limit written in working days as a `duration` moves with its working days: the scheduler follows it.
    expect(await taskOf(flow, 'TW')).toMatchObject({ duration_working_days: 3, duration_value: 3, committed_finish: workingDayAfter(START, 2), extension_times_used: 0 });
    expect(await taskOf(flow, 'CAL')).toMatchObject({ duration_value: 7, duration_working_days: 5, committed_finish: rolled(addDays(START, 6)), extension_times_used: 0, extension_value_used: 0 });
  });

  it('leaves a task whose template says nothing of extensions as it was: its limit is raised through `change`, and `extensions` for it is 422 PWF_EXTENSION_NOT_ALLOWED', async () => {
    const flow = await started();
    expect(await refusal(propose(flow, { extensions: [{ taskCode: 'TB', addValue: 1 }] }))).toMatchObject({ code: 'PWF_EXTENSION_NOT_ALLOWED', status: 422, extensions: { task_code: 'TB' } });
    await approved(flow, { overrides: { change: [{ taskCode: 'TB', durationWorkingDays: 6 }] } });
    expect(await taskOf(flow, 'TB')).toMatchObject({ duration_working_days: 6, duration_value: null, committed_finish: workingDayAfter(START, 8), extension_times_used: 0, extension_value_used: 0 });
  });

  it('refuses on both paths a task whose rule forbids extensions, and an extension of a task that is done, cancelled or unknown', async () => {
    const flow = await started();
    expect(await refusal(propose(flow, { extensions: [{ taskCode: 'TC', addValue: 1 }] }))).toMatchObject({ code: 'PWF_EXTENSION_NOT_ALLOWED', status: 422, extensions: { task_code: 'TC' } });
    expect(await refusal(propose(flow, { overrides: { change: [{ taskCode: 'TC', durationWorkingDays: 4 }] } }))).toMatchObject({ code: 'PWF_EXTENSION_REQUIRED', status: 422, extensions: { task_code: 'TC', extension_allowed: false } });
    expect(await refusal(propose(flow, { extensions: [{ taskCode: 'ZZ', addValue: 1 }] }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'extensions[0].task_code' });
    expect(await refusal(propose(flow, { extensions: [{ taskCode: 'TD', addValue: 0 }] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'extensions[0].add_value' });
    expect(await refusal(propose(flow, { extensions: Array.from({ length: 101 }, () => ({ taskCode: 'TD', addValue: 1 })) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'extensions' });
    await owner(`update machvon.project_task set status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2::uuid where id = $1::uuid`, [flow.ids.TD, memberId(MANAGER)]);
    expect(await refusal(propose(flow, { extensions: [{ taskCode: 'TD', addValue: 1 }] }))).toMatchObject({ code: 'PWF_EXTENSION_TASK_CLOSED', status: 422, extensions: { task_code: 'TD' } });
    await owner(`update machvon.project_task set status = 'DONE', actual_start = $2::date, actual_finish = $2::date where id = $1::uuid`, [flow.ids.TW, TODAY]);
    expect(await refusal(propose(flow, { extensions: [{ taskCode: 'TW', addValue: 1 }] }))).toMatchObject({ code: 'PWF_EXTENSION_TASK_CLOSED', status: 422, extensions: { task_code: 'TW' } });
    expect(await proposalsOf(flow)).toEqual([]);
  });

  it('changes the limit of a task that has a `duration` in its own unit: `duration_working_days` is refused by name for calendar days, `duration_value` moves the days', async () => {
    const flow = await started();
    expect(await refusal(propose(flow, { overrides: { change: [{ taskCode: 'TA', durationWorkingDays: 2 }, { taskCode: 'CALP', durationWorkingDays: 9 }] } }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'overrides.change[1].duration_working_days' });
    expect(await refusal(propose(flow, { overrides: { change: [{ taskCode: 'MON', durationWorkingDays: 20 }] } }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'overrides.change[0].duration_working_days' });
    expect(await refusal(propose(flow, { overrides: { change: [{ taskCode: 'TB', durationValue: 4 }] } }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'overrides.change[0].duration_value' });
    expect(await refusal(propose(flow, { overrides: { change: [{ taskCode: 'CALP', durationValue: 12, durationWorkingDays: 9 }] } }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'overrides.change[0].duration_working_days' });
    // CALP has no extension rule: raising it through `change` is the old path, now in its own unit.
    await approved(flow, { overrides: { change: [{ taskCode: 'CALP', durationValue: 14 }] } });
    expect(await taskOf(flow, 'CALP')).toMatchObject({ duration_value: 14, duration_unit: 'CALENDAR_DAY', duration_working_days: 10, committed_finish: rolled(addDays(START, 13)), extension_times_used: 0, extension_value_used: 0 });
  });

  it('keeps the counters away from every other write: the application cannot move them outside an approved extension', async () => {
    const flow = await started();
    const direct = await refusal(as((tx) => tx.query('update machvon.project_task set extension_times_used = 1 where id = $1::uuid', [flow.ids.TA])));
    expect(direct.code).toBe('42501');
    expect(await usedOf(flow, 'TA')).toEqual([0, 0]);
  });
});

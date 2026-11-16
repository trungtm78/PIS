import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import { HomeWorkStore } from '../src/home-work-store';
import type { WorkInput } from '../src/home-work-store';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { PrjProjectStore } from '../src/prj-project-store';
import { PwfDeadlineReads } from '../src/pwf-deadline-reads';
import { PwfMyTaskReads } from '../src/pwf-my-tasks';
import { CLAIM_LEAD_REASON, CLAIM_SUPPORT_REASON } from '../src/pwf-task-claim';
import { PwfTaskReads } from '../src/pwf-task-reads';
import { PwfTaskStore } from '../src/pwf-task-store';
import { PwfWorkflowReads } from '../src/pwf-workflow-reads';
import { PwfWorkflowStore } from '../src/pwf-workflow-store';
import type { AdoptOutcome, WorkflowResult } from '../src/pwf-workflow-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from './support/authz-fixtures';

jest.setTimeout(600_000);

/**
 * PWF-5 (docs PWF 22.2 R61): the units that receive the tasks of a project are resolved when its workflow is made. The project answers for its owner, its investor and its decision authority, a `UNIT:` reference for itself, the
 * person who starts the workflow for every other party; nothing is guessed, nothing the project names is replaced, and a workflow of a template that names no unit is made exactly as before.
 */

const harness = new AuthzHarness();
const projects = new PrjProjectStore();
const workflows = new PwfWorkflowStore();
const tasks = new PwfTaskStore();
const workflowReads = new PwfWorkflowReads();
const taskReads = new PwfTaskReads();
const myTasks = new PwfMyTaskReads();
const board = new PwfDeadlineReads();
const work = new HomeWorkStore();

const MANAGER = 1;
const WORKER = 2;
const CHECKER = 3;
/** Of the finance unit and of the appraisal unit, a planner at each. */
const TAKER = 4;
/** A planner over the whole province (a subtree that contains every unit). */
const WIDE = 5;
/** A planner of the department alone. */
const OUTSIDER = 6;
/** Of the finance unit, but an accountant there. */
const ACCOUNTANT = 7;
/** A planner over the whole tenant, of no unit. */
const TENANT_WIDE = 8;
/** An appraiser of the appraisal unit. */
const APPRAISER = 9;
/** Was a planner of the finance unit until yesterday. */
const FORMER = 10;
const PLANNER_ROLE = 1;
const ACCOUNTANT_ROLE = 2;
const APPRAISER_ROLE = 3;
const PROVINCE = 1;
const DEPARTMENT = 2;
const INVESTOR = 3;
const FINANCE = 4;
const APPRAISAL = 5;
const EXPIRED = 6;
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';
const NOW = new Date();
const TODAY = vietnamDateOf(NOW);
const YEAR = Number(TODAY.slice(0, 4));
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const scopes = { act: everything, read: everything };

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const START = addDays(TODAY, 7);

const plain = (code: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  code,
  name: `Task ${code}`,
  phase: 'P1',
  kind: 'TASK',
  duration_working_days: 3,
  required: true,
  responsible_role: 'PMB_PLANNER',
  priority: 'NORMAL',
  predecessors: [],
  legal_doc_types: [],
  form_templates: [],
  checklist: [],
  kpi_codes: [],
  when: [],
  ...over,
});
const line = (unit_ref: string, role: string, part: 'LEAD' | 'SUPPORT'): Record<string, string> => ({ unit_ref, role, part });

/**
 * OWNER is received by the unit that owns the project, INVEST by its investor with the appraiser in support, FIXED by one named unit of the tenant, FINANCE by a party only a person can name, and GROUP_A (a branch of the
 * projects of group A alone) by a party no other task uses.
 */
const UNITFLOW = {
  name: 'Unit flow',
  phases: [{ code: 'P1', name: 'Phase one', gates: [] }],
  parties: [
    { code: 'FINANCE_DEPARTMENT', name: 'Sở Tài chính' },
    { code: 'APPRAISER', name: 'Đơn vị thẩm định' },
    { code: 'GROUP_A_COUNCIL', name: 'Hội đồng nhóm A' },
  ],
  tasks: [
    plain('OWNER', { responsible_units: [line('PROJECT_OWNER', 'PMB_PLANNER', 'LEAD')] }),
    plain('INVEST', { responsible_units: [line('PROJECT_PARTY:APPRAISER', 'DPI_APPRAISER', 'SUPPORT'), line('PROJECT_PARTY:INVESTOR', 'PMB_PLANNER', 'LEAD')] }),
    plain('FIXED', { responsible_units: [line(`UNIT:${unitId(APPRAISAL)}`, 'PMB_PLANNER', 'LEAD')] }),
    plain('FINANCE', { responsible_units: [line('PROJECT_PARTY:FINANCE_DEPARTMENT', 'PMB_PLANNER', 'LEAD')] }),
    plain('GROUP_A', { when: [{ field: 'project_group', in: ['A'] }], responsible_units: [line('PROJECT_PARTY:GROUP_A_COUNCIL', 'PMB_PLANNER', 'LEAD')] }),
    plain('NOBODY'),
  ],
};
/** A template that names a unit of the tenant that is no longer valid. */
const GONEFLOW = { name: 'Gone flow', phases: UNITFLOW.phases, tasks: [plain('GONE', { responsible_units: [line(`UNIT:${unitId(EXPIRED)}`, 'PMB_PLANNER', 'LEAD')] })] };
/** What every template was before: no unit anywhere. */
const OLDFLOW = { name: 'Old flow', phases: UNITFLOW.phases, tasks: [plain('ONE'), plain('TWO')] };

const as = <T>(run: (tx: TenantTx) => Promise<T>, member = MANAGER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), run);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
const refusal = async (work: Promise<unknown>): Promise<{ code?: string; status?: number; field?: string; extensions?: Record<string, unknown> }> => {
  try {
    await work;
  } catch (error) {
    const failed = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: failed.code, status: failed.status, field: failed.detail, extensions: failed.extensions };
  }
  return {};
};

let areaVersion = '';
let counter = 0;

async function template(code: string, params: unknown): Promise<void> {
  await owner(
    `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
     values ($1, 'PROJECT_WORKFLOW_TEMPLATE', $2, 1, 'APPROVED', $3::jsonb, date '2020-01-01', 'A template for the tests', $4, $5, now(), $6, now())`,
    [TENANT_A, code, JSON.stringify(params), memberId(MANAGER), memberId(WORKER), memberId(CHECKER)],
  );
}

/** A project of the department; with `investor` it names its investor. */
async function project(options: { investor?: boolean; group?: string } = {}): Promise<string> {
  counter += 1;
  const code = `PU-${counter}-${randomUUID().slice(0, 6)}`;
  const created = await as((tx) => projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(DEPARTMENT), areaMasterVersionId: areaVersion, totalInvestmentVnd: '500000000000' }, memberId(MANAGER), TODAY));
  await owner(`update machvon.project set status = 'CONCEPT', project_group = $2, investor_unit_id = $3 where id = $1::uuid`, [created.id, options.group ?? 'B', options.investor === false ? null : unitId(INVESTOR)]);
  return created.id;
}

const start = (projectId: string, templateCode: string, units?: Record<string, unknown>, facts: Record<string, string> = {}): Promise<WorkflowResult> =>
  as((tx) => workflows.start(tx, { projectId, templateCode, plannedStartDate: START, facts, ...(units === undefined ? {} : { units }), actor: memberId(MANAGER), scopes, now: NOW }));
const adopt = (projectId: string, templateCode: string, dryRun: boolean, units?: Record<string, unknown>): Promise<AdoptOutcome> =>
  as((tx) => workflows.adopt(tx, { projectId, templateCode, plannedStartDate: START, effectiveDate: TODAY, dryRun, ...(units === undefined ? {} : { units }), actor: memberId(MANAGER), scopes, now: NOW }));

const stored = async (workflowId: string): Promise<Record<string, Record<string, unknown>>> =>
  Object.fromEntries((await owner<{ j: Record<string, unknown> }>('select to_jsonb(t) as j from machvon.project_task t where workflow_id = $1::uuid', [workflowId])).map((row) => [row.j.task_code as string, row.j]));
const selectionOf = async (workflowId: string): Promise<Record<string, unknown>> => (await owner<{ selection: Record<string, unknown> }>('select selection from machvon.project_workflow where id = $1::uuid', [workflowId]))[0]?.selection ?? {};

const FINANCE_REF = 'PROJECT_PARTY:FINANCE_DEPARTMENT';
const APPRAISER_REF = 'PROJECT_PARTY:APPRAISER';
const INVESTOR_REF = 'PROJECT_PARTY:INVESTOR';
const COUNCIL_REF = 'PROJECT_PARTY:GROUP_A_COUNCIL';
const FIXED_REF = `UNIT:${unitId(APPRAISAL)}`;
const CHOSEN = { [FINANCE_REF]: unitId(FINANCE), [APPRAISER_REF]: unitId(APPRAISAL) };

beforeAll(async () => {
  await harness.start();
  await harness.seedUnits(TENANT_A, [
    { n: PROVINCE, path: '/u1/' },
    { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
    { n: INVESTOR, path: '/u1/u3/', parent: PROVINCE },
    { n: FINANCE, path: '/u1/u4/', parent: PROVINCE },
    { n: APPRAISAL, path: '/u1/u5/', parent: PROVINCE },
    { n: EXPIRED, path: '/u1/u6/', parent: PROVINCE },
  ]);
  await owner(`update machvon.organization_unit set valid_until = $2::date - 1 where id = $1::uuid`, [unitId(EXPIRED), TODAY]);
  await harness.seedMembership(TENANT_A, MANAGER, PROVINCE);
  await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: SYSTEM_ACTOR, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, SYSTEM_ACTOR, TODAY));
  for (const n of [WORKER, CHECKER]) await harness.seedMembership(TENANT_A, n, DEPARTMENT);
  const recordId = randomUUID();
  areaVersion = randomUUID();
  await harness.owner(TENANT_A, [
    [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'AREA-U', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(MANAGER)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, 'AREA', 'AREA-U', 1, 'Area', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $3, now(), $4, $4)`,
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
  await template('UNITFLOW', UNITFLOW);
  await template('GONEFLOW', GONEFLOW);
  await template('OLDFLOW', OLDFLOW);
  for (const n of [TAKER, WIDE, OUTSIDER, ACCOUNTANT, TENANT_WIDE, APPRAISER, FORMER]) await harness.seedMembership(TENANT_A, n, DEPARTMENT);
  await harness.seedRole(TENANT_A, PLANNER_ROLE, 'PMB_PLANNER', ['pwf.task.work'], 30);
  await harness.seedRole(TENANT_A, ACCOUNTANT_ROLE, 'PMB_ACCOUNTANT', ['pwf.task.work'], 30);
  await harness.seedRole(TENANT_A, APPRAISER_ROLE, 'DPI_APPRAISER', ['pwf.task.work'], 30);
  await harness.seedGrants(TENANT_A, [
    { n: 1, member: TAKER, role: PLANNER_ROLE, kind: 'UNIT_ONLY', refs: [unitId(FINANCE)] },
    { n: 2, member: TAKER, role: PLANNER_ROLE, kind: 'UNIT_ONLY', refs: [unitId(APPRAISAL)] },
    { n: 3, member: WIDE, role: PLANNER_ROLE, kind: 'UNIT_SUBTREE', refs: [unitId(PROVINCE)] },
    { n: 4, member: OUTSIDER, role: PLANNER_ROLE, kind: 'UNIT_ONLY', refs: [unitId(DEPARTMENT)] },
    { n: 5, member: ACCOUNTANT, role: ACCOUNTANT_ROLE, kind: 'UNIT_ONLY', refs: [unitId(FINANCE)] },
    { n: 6, member: TENANT_WIDE, role: PLANNER_ROLE, kind: 'TENANT' },
    { n: 7, member: APPRAISER, role: APPRAISER_ROLE, kind: 'UNIT_ONLY', refs: [unitId(APPRAISAL)] },
    { n: 8, member: FORMER, role: PLANNER_ROLE, kind: 'UNIT_ONLY', refs: [unitId(FINANCE)], until: new Date(NOW.getTime() - 86_400_000).toISOString() },
  ]);
}, 300_000);

afterAll(async () => {
  await harness.stop();
});

describe('the units of the tasks when a workflow starts (R61)', () => {
  it('writes the leading unit and every unit of each task, and the record of the choice says where each unit came from', async () => {
    const projectId = await project();
    const workflow = await start(projectId, 'UNITFLOW', CHOSEN);
    const rows = await stored(workflow.id);
    expect(rows.OWNER).toMatchObject({ receiving_unit_id: unitId(DEPARTMENT), receiving_units: [{ unit_ref: 'PROJECT_OWNER', unit_id: unitId(DEPARTMENT), role: 'PMB_PLANNER', part: 'LEAD' }] });
    // The leading unit is first whatever the order of the template.
    expect(rows.INVEST).toMatchObject({
      receiving_unit_id: unitId(INVESTOR),
      receiving_units: [
        { unit_ref: INVESTOR_REF, unit_id: unitId(INVESTOR), role: 'PMB_PLANNER', part: 'LEAD' },
        { unit_ref: APPRAISER_REF, unit_id: unitId(APPRAISAL), role: 'DPI_APPRAISER', part: 'SUPPORT' },
      ],
    });
    expect(rows.FIXED).toMatchObject({ receiving_unit_id: unitId(APPRAISAL) });
    expect(rows.FINANCE).toMatchObject({ receiving_unit_id: unitId(FINANCE) });
    // A task without units and a branch the project does not have store nothing.
    expect(rows.NOBODY).toMatchObject({ receiving_unit_id: null, receiving_units: null });
    expect(rows.GROUP_A).toMatchObject({ excluded: true, receiving_unit_id: null, receiving_units: null });
    const units = [
      { unit_ref: 'PROJECT_OWNER', unit_id: unitId(DEPARTMENT), source: 'PROJECT' },
      { unit_ref: APPRAISER_REF, unit_id: unitId(APPRAISAL), source: 'CHOSEN' },
      { unit_ref: INVESTOR_REF, unit_id: unitId(INVESTOR), source: 'PROJECT' },
      { unit_ref: FIXED_REF, unit_id: unitId(APPRAISAL), source: 'TEMPLATE' },
      { unit_ref: FINANCE_REF, unit_id: unitId(FINANCE), source: 'CHOSEN' },
    ];
    expect((await selectionOf(workflow.id)).units).toEqual(units);
    expect(workflow.selection.units).toEqual(units);
  });

  it('refuses a start while a party has no unit, naming the references, and accepts it once they are named; a branch the project does not have asks for nothing', async () => {
    const projectId = await project();
    const refused = await refusal(start(projectId, 'UNITFLOW'));
    expect(refused).toMatchObject({ code: 'PWF_UNIT_UNRESOLVED', status: 422, field: 'units', extensions: { unit_refs: [APPRAISER_REF, FINANCE_REF] } });
    expect(await owner('select id from machvon.project_workflow where project_id = $1::uuid', [projectId])).toEqual([]);
    // Naming one of the two is not enough.
    expect(await refusal(start(projectId, 'UNITFLOW', { [FINANCE_REF]: unitId(FINANCE) }))).toMatchObject({ code: 'PWF_UNIT_UNRESOLVED', extensions: { unit_refs: [APPRAISER_REF] } });
    // The council of group A is a party of a branch this project of group B does not have: nobody is asked for it, and naming it is naming a reference no task uses.
    expect(await refusal(start(projectId, 'UNITFLOW', { ...CHOSEN, [COUNCIL_REF]: unitId(FINANCE) }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, field: 'units' });
    const workflow = await start(projectId, 'UNITFLOW', CHOSEN);
    expect(workflow.taskCount).toBe(6);
    // A project of group A has the branch and is asked for its party.
    const groupA = await project({ group: 'A' });
    expect(await refusal(start(groupA, 'UNITFLOW', CHOSEN))).toMatchObject({ code: 'PWF_UNIT_UNRESOLVED', extensions: { unit_refs: [COUNCIL_REF] } });
    const whole = await start(groupA, 'UNITFLOW', { ...CHOSEN, [COUNCIL_REF]: unitId(PROVINCE) });
    expect((await stored(whole.id)).GROUP_A).toMatchObject({ excluded: false, receiving_unit_id: unitId(PROVINCE) });
  });

  it('lets the person name the investor only while the project names none, and never replace what the project or the template answers', async () => {
    const named = await project();
    for (const ref of ['PROJECT_OWNER', INVESTOR_REF, FIXED_REF]) {
      expect(await refusal(start(named, 'UNITFLOW', { ...CHOSEN, [ref]: unitId(FINANCE) }))).toMatchObject({ code: 'PWF_UNIT_OVERRIDE_DENIED', status: 422, field: 'units', extensions: { unit_refs: [ref] } });
    }
    // Saying again what the project says replaces nothing.
    const same = await start(named, 'UNITFLOW', { ...CHOSEN, [INVESTOR_REF]: unitId(INVESTOR) });
    expect(same.selection.units).toContainEqual({ unit_ref: INVESTOR_REF, unit_id: unitId(INVESTOR), source: 'PROJECT' });
    const unnamed = await project({ investor: false });
    expect(await refusal(start(unnamed, 'UNITFLOW', CHOSEN))).toMatchObject({ code: 'PWF_UNIT_UNRESOLVED', extensions: { unit_refs: [INVESTOR_REF] } });
    const chosen = await start(unnamed, 'UNITFLOW', { ...CHOSEN, [INVESTOR_REF]: unitId(FINANCE) });
    expect(chosen.selection.units).toContainEqual({ unit_ref: INVESTOR_REF, unit_id: unitId(FINANCE), source: 'CHOSEN' });
  });

  it('refuses a unit that is not one of the tenant or is no longer valid, and a key or a value that is not one', async () => {
    const projectId = await project();
    expect(await refusal(start(projectId, 'UNITFLOW', { ...CHOSEN, [FINANCE_REF]: randomUUID() }))).toMatchObject({ code: 'PWF_UNIT_UNKNOWN', status: 422, field: 'units', extensions: { unit_refs: [FINANCE_REF] } });
    expect(await refusal(start(projectId, 'UNITFLOW', { ...CHOSEN, [FINANCE_REF]: unitId(EXPIRED) }))).toMatchObject({ code: 'PWF_UNIT_UNKNOWN', extensions: { unit_refs: [FINANCE_REF] } });
    // A unit the template itself names is judged on the day the workflow is made.
    expect(await refusal(start(projectId, 'GONEFLOW'))).toMatchObject({ code: 'PWF_UNIT_UNKNOWN', extensions: { unit_refs: [`UNIT:${unitId(EXPIRED)}`] } });
    for (const units of [{ ...CHOSEN, [FINANCE_REF]: 'not-a-unit' }, { ...CHOSEN, 'PARTY:finance': unitId(FINANCE) }, { ...CHOSEN, [FINANCE_REF]: 7 }, [unitId(FINANCE)] as unknown as Record<string, unknown>]) {
      expect(await refusal(start(projectId, 'UNITFLOW', units))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, field: 'units' });
    }
    expect(await owner('select id from machvon.project_workflow where project_id = $1::uuid', [projectId])).toEqual([]);
  });

  it('makes the workflow of a template that names no unit exactly as before: no units in the record of the choice, nothing on the tasks, the leader responsible', async () => {
    const projectId = await project();
    const leader = await owner<{ n: number }>(`select count(*)::int as n from machvon.project_accountability where project_id = $1::uuid and accountability_role = 'LEADER_IN_CHARGE' and status = 'ACTIVE'`, [projectId]);
    const workflow = await start(projectId, 'OLDFLOW');
    const selection = await selectionOf(workflow.id);
    expect(Object.keys(selection).sort()).toEqual(['basis', 'chosen_template_code', 'line', 'mode', 'reason', 'rule_id', 'rule_unit_id', 'rule_version', 'suggested_template_code']);
    expect('units' in workflow.selection).toBe(false);
    const rows = await stored(workflow.id);
    for (const row of Object.values(rows)) expect(row).toMatchObject({ receiving_unit_id: null, receiving_units: null });
    const roles = await owner<{ role: string; n: number }>(`select a.role, count(*)::int as n from machvon.project_task_assignment a join machvon.project_task t on t.id = a.task_id where t.workflow_id = $1::uuid group by a.role`, [workflow.id]);
    expect(roles).toEqual(leader[0]?.n === 1 ? [{ role: 'RESPONSIBLE', n: 2 }] : []);
    // An empty `units` is nothing named; a unit named for a template that asks for none is a reference no task uses.
    const empty = await project();
    expect((await start(empty, 'OLDFLOW', {})).taskCount).toBe(2);
    expect(await refusal(start(await project(), 'OLDFLOW', { [FINANCE_REF]: unitId(FINANCE) }))).toMatchObject({ code: 'VALIDATION_FAILED', field: 'units' });
  });

  it('tells a dry run of an adoption which references still ask for a unit, and refuses the adoption itself until they are named', async () => {
    const projectId = await project();
    const preview = await adopt(projectId, 'UNITFLOW', true);
    expect(preview.units.unresolved).toEqual([APPRAISER_REF, FINANCE_REF]);
    expect(preview.units.refs).toEqual([
      { unit_ref: 'PROJECT_OWNER', unit_id: unitId(DEPARTMENT), unit_name: `Unit ${DEPARTMENT}`, source: 'PROJECT', party_name: null },
      { unit_ref: APPRAISER_REF, unit_id: null, unit_name: null, source: 'NONE', party_name: 'Đơn vị thẩm định' },
      { unit_ref: INVESTOR_REF, unit_id: unitId(INVESTOR), unit_name: `Unit ${INVESTOR}`, source: 'PROJECT', party_name: null },
      { unit_ref: FIXED_REF, unit_id: unitId(APPRAISAL), unit_name: `Unit ${APPRAISAL}`, source: 'TEMPLATE', party_name: null },
      { unit_ref: FINANCE_REF, unit_id: null, unit_name: null, source: 'NONE', party_name: 'Sở Tài chính' },
    ]);
    expect('units' in preview.selection).toBe(false);
    const named = await adopt(projectId, 'UNITFLOW', true, CHOSEN);
    expect(named.units.unresolved).toEqual([]);
    expect(named.units.refs.find((one) => one.unit_ref === FINANCE_REF)).toMatchObject({ unit_id: unitId(FINANCE), unit_name: `Unit ${FINANCE}`, source: 'CHOSEN' });
    // What a start refuses for the units a person names, a dry run refuses too.
    expect(await refusal(adopt(projectId, 'UNITFLOW', true, { ...CHOSEN, PROJECT_OWNER: unitId(FINANCE) }))).toMatchObject({ code: 'PWF_UNIT_OVERRIDE_DENIED' });
    expect(await refusal(adopt(projectId, 'UNITFLOW', false))).toMatchObject({ code: 'PWF_UNIT_UNRESOLVED', extensions: { unit_refs: [APPRAISER_REF, FINANCE_REF] } });
    const applied = await adopt(projectId, 'UNITFLOW', false, CHOSEN);
    expect(applied.applied).toBe(true);
    expect(applied.selection.units).toHaveLength(5);
    expect((await stored(applied.workflow?.id as string)).FINANCE).toMatchObject({ receiving_unit_id: unitId(FINANCE) });
    // A template that names no unit tells none.
    expect((await adopt(await project(), 'OLDFLOW', true)).units).toEqual({ refs: [], unresolved: [] });
  });

  it('leaves the task a unit receives without a responsible person: the leader in charge answers for it instead', async () => {
    const projectId = await project();
    await owner(
      `insert into machvon.project_accountability (tenant_id, id, project_id, accountability_role, leader_membership_id, status, valid_from, created_by, updated_by)
       select $1, gen_random_uuid(), $2::uuid, 'LEADER_IN_CHARGE', $3::uuid, 'ACTIVE', date '2020-01-01', $3::uuid, $3::uuid
        where not exists (select 1 from machvon.project_accountability where project_id = $2::uuid and accountability_role = 'LEADER_IN_CHARGE' and status = 'ACTIVE')`,
      [TENANT_A, projectId, memberId(MANAGER)],
    );
    const workflow = await start(projectId, 'UNITFLOW', CHOSEN);
    const held = await owner<{ task_code: string; role: string }>(
      `select t.task_code, a.role from machvon.project_task_assignment a join machvon.project_task t on t.id = a.task_id where t.workflow_id = $1::uuid order by t.task_code`,
      [workflow.id],
    );
    expect(held).toEqual([
      { task_code: 'FINANCE', role: 'ACCOUNTABLE' },
      { task_code: 'FIXED', role: 'ACCOUNTABLE' },
      { task_code: 'INVEST', role: 'ACCOUNTABLE' },
      { task_code: 'NOBODY', role: 'RESPONSIBLE' },
      { task_code: 'OWNER', role: 'ACCOUNTABLE' },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// "Nhận việc" (R71)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface Flow {
  projectId: string;
  workflowId: string;
  ids: Record<string, string>;
}

/** A project with a running workflow of the template with units; with `leader` the manager is its leader in charge (and so answers for every task). */
async function flow(options: { leader?: boolean } = {}): Promise<Flow> {
  const projectId = await project();
  if (options.leader === true) {
    await owner(`update machvon.project_accountability set status = 'ENDED', valid_until = $2::date where project_id = $1::uuid and status = 'ACTIVE' and accountability_role = 'LEADER_IN_CHARGE'`, [projectId, TODAY]);
    await owner(
      `insert into machvon.project_accountability (tenant_id, id, project_id, accountability_role, leader_membership_id, status, valid_from, created_by, updated_by) values ($1, gen_random_uuid(), $2::uuid, 'LEADER_IN_CHARGE', $3::uuid, 'ACTIVE', date '2020-01-01', $3::uuid, $3::uuid)`,
      [TENANT_A, projectId, memberId(MANAGER)],
    );
  }
  const workflow = await start(projectId, 'UNITFLOW', CHOSEN);
  const rows = await owner<{ id: string; task_code: string }>('select id, task_code from machvon.project_task where workflow_id = $1::uuid', [workflow.id]);
  return { projectId, workflowId: workflow.id, ids: Object.fromEntries(rows.map((row) => [row.task_code, row.id])) };
}

const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
const claim = (taskId: string, member: number, over: { part?: string; read?: ScopeBuilder; act?: ScopeBuilder } = {}): ReturnType<PwfTaskStore['claim']> =>
  as((tx) => tasks.claim(tx, { taskId, actor: memberId(member), scopes: { act: over.act ?? everything, read: over.read ?? everything }, today: TODAY, now: new Date(), ...(over.part === undefined ? {} : { part: over.part }) }), member);
const ledger = (taskId: string): Promise<Array<{ membership_id: string; role: string; valid_from: string; valid_to: string | null; share_pct: number; reason: string; assigned_by: string }>> =>
  owner(`select membership_id, role, valid_from::text as valid_from, valid_to::text as valid_to, share_pct, reason, assigned_by from machvon.project_task_assignment where task_id = $1::uuid order by assigned_at, id`, [taskId]);
const CAN = { manage: true, proposeReschedule: true, work: true, approve: true, assign: true };

describe('taking a task for a unit that receives it (R71)', () => {
  it('gives the leading line to a person of the unit who holds its role: RESPONSIBLE from today, a reason of the system, an entry TASK_CLAIMED, the version of the task untouched', async () => {
    const one = await flow();
    const before = await owner<{ version: number }>('select version from machvon.project_task where id = $1::uuid', [one.ids.FINANCE]);
    const done = await claim(one.ids.FINANCE as string, TAKER);
    expect(done).toMatchObject({ id: one.ids.FINANCE, role: 'RESPONSIBLE', status: 'NOT_STARTED', fromStatus: 'NOT_STARTED', version: Number(before[0]?.version), facts: { part: 'LEAD', unit_ref: FINANCE_REF, unit_id: unitId(FINANCE), role: 'RESPONSIBLE' } });
    expect(await ledger(one.ids.FINANCE as string)).toEqual([{ membership_id: memberId(TAKER), role: 'RESPONSIBLE', valid_from: TODAY, valid_to: null, share_pct: 100, reason: CLAIM_LEAD_REASON, assigned_by: memberId(TAKER) }]);
    const log = await owner<{ kind: string; actor: string; reason: string; subject: Record<string, unknown> }>(`select kind, actor, reason, subject from machvon.project_task_log where task_id = $1::uuid`, [one.ids.FINANCE]);
    expect(log).toEqual([
      { kind: 'TASK_CLAIMED', actor: memberId(TAKER), reason: CLAIM_LEAD_REASON, subject: { task_code: 'FINANCE', membership_id: memberId(TAKER), valid_from: TODAY, share_pct: 100, assignment_id: done.assignmentId, role: 'RESPONSIBLE', part: 'LEAD', unit_ref: FINANCE_REF, unit_id: unitId(FINANCE) } },
    ]);
    // The person who took the task may now start it (BR-PWF-09 asks for a line of the ledger, and has one).
    const started = await as((tx) => tasks.start(tx, { taskId: one.ids.FINANCE as string, expectedVersion: Number(before[0]?.version), actor: memberId(TAKER), scopes, today: TODAY }), TAKER);
    expect(started.status).toBe('IN_PROGRESS');
    // A person whose unit is reached through a subtree is of the unit too.
    expect((await claim(one.ids.OWNER as string, WIDE)).role).toBe('RESPONSIBLE');
  });

  it('gives a supporting line CONSULTED, and never the leading line to who holds only the role of the support', async () => {
    const one = await flow();
    // The appraiser holds the role of the supporting line of INVEST, not the one of its leading line (which another unit holds anyway).
    expect(await refusal(claim(one.ids.INVEST as string, APPRAISER, { part: 'LEAD' }))).toMatchObject({ code: 'PWF_CLAIM_NOT_ELIGIBLE', status: 403 });
    const done = await claim(one.ids.INVEST as string, APPRAISER);
    expect(done).toMatchObject({ role: 'CONSULTED', facts: { part: 'SUPPORT', unit_ref: APPRAISER_REF, unit_id: unitId(APPRAISAL) } });
    expect(await ledger(one.ids.INVEST as string)).toEqual([{ membership_id: memberId(APPRAISER), role: 'CONSULTED', valid_from: TODAY, valid_to: null, share_pct: 100, reason: CLAIM_SUPPORT_REASON, assigned_by: memberId(APPRAISER) }]);
    // Being consulted is not doing the task: it is still without a responsible person, and the supporting line is taken.
    expect(await refusal(claim(one.ids.INVEST as string, APPRAISER))).toMatchObject({ code: 'PWF_TASK_ALREADY_CLAIMED', status: 409, extensions: { part: 'SUPPORT' } });
    expect(await refusal(claim(one.ids.INVEST as string, APPRAISER, { part: 'BOTH' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, field: 'part' });
  });

  it('refuses who is not of the unit, who holds the role over the whole tenant only, who is of the unit without the role, and whose grant has ended', async () => {
    const one = await flow();
    const task = one.ids.FINANCE as string;
    expect(await refusal(claim(task, OUTSIDER))).toMatchObject({ code: 'PWF_CLAIM_NOT_ELIGIBLE', status: 403, extensions: { reason: 'NOT_MEMBER' } });
    expect(await refusal(claim(task, TENANT_WIDE))).toMatchObject({ code: 'PWF_CLAIM_NOT_ELIGIBLE', status: 403, extensions: { reason: 'NOT_MEMBER' } });
    expect(await refusal(claim(task, ACCOUNTANT))).toMatchObject({ code: 'PWF_CLAIM_NOT_ELIGIBLE', status: 403, extensions: { reason: 'ROLE_NOT_HELD' } });
    expect(await refusal(claim(task, FORMER))).toMatchObject({ code: 'PWF_CLAIM_NOT_ELIGIBLE', status: 403, extensions: { reason: 'NOT_MEMBER' } });
    // The manager who started the workflow is of no unit by a grant: starting a workflow takes no task.
    expect(await refusal(claim(task, MANAGER))).toMatchObject({ code: 'PWF_CLAIM_NOT_ELIGIBLE', status: 403 });
    expect(await ledger(task)).toEqual([]);
  });

  it('never takes a task from someone: a second claim is 409, whoever asks, and a task the ledger already gave is taken', async () => {
    const one = await flow();
    await claim(one.ids.FINANCE as string, TAKER);
    expect(await refusal(claim(one.ids.FINANCE as string, WIDE))).toMatchObject({ code: 'PWF_TASK_ALREADY_CLAIMED', status: 409, extensions: { part: 'LEAD' } });
    expect(await refusal(claim(one.ids.FINANCE as string, TAKER))).toMatchObject({ code: 'PWF_TASK_ALREADY_CLAIMED', status: 409 });
    // An administrator gave FIXED to somebody from outside its unit, from next week on: the place is taken from then, so nobody claims it today; the log says the person is of none of the units.
    await as((tx) => tasks.assign(tx, { taskId: one.ids.FIXED as string, actor: memberId(MANAGER), scopes, today: TODAY, input: { membershipId: memberId(OUTSIDER), role: 'RESPONSIBLE', validFrom: addDays(TODAY, 7), sharePct: 100, reason: 'Assigned by the manager' } }));
    expect(await refusal(claim(one.ids.FIXED as string, TAKER))).toMatchObject({ code: 'PWF_TASK_ALREADY_CLAIMED', status: 409 });
    const assigned = await owner<{ subject: Record<string, unknown> }>(`select subject from machvon.project_task_log where task_id = $1::uuid and kind = 'ASSIGNED'`, [one.ids.FIXED]);
    expect(assigned[0]?.subject).toMatchObject({ membership_id: memberId(OUTSIDER), outside_receiving_units: true });
    await as((tx) => tasks.assign(tx, { taskId: one.ids.OWNER as string, actor: memberId(MANAGER), scopes, today: TODAY, input: { membershipId: memberId(WIDE), role: 'RESPONSIBLE', validFrom: TODAY, sharePct: 100, reason: 'Assigned by the manager' } }));
    const inside = await owner<{ subject: Record<string, unknown> }>(`select subject from machvon.project_task_log where task_id = $1::uuid and kind = 'ASSIGNED'`, [one.ids.OWNER]);
    expect(inside[0]?.subject).toMatchObject({ outside_receiving_units: false });
    // A task no unit receives says nothing of units in its log.
    await as((tx) => tasks.assign(tx, { taskId: one.ids.NOBODY as string, actor: memberId(MANAGER), scopes, today: TODAY, input: { membershipId: memberId(WIDE), role: 'RESPONSIBLE', validFrom: TODAY, sharePct: 100, reason: 'Assigned by the manager' } }));
    const plainLog = await owner<{ subject: Record<string, unknown> }>(`select subject from machvon.project_task_log where task_id = $1::uuid and kind = 'ASSIGNED'`, [one.ids.NOBODY]);
    expect('outside_receiving_units' in (plainLog[0]?.subject ?? {})).toBe(false);
  });

  it('lets exactly one of two people who claim at the same moment have the task', async () => {
    for (let round = 0; round < 3; round += 1) {
      const one = await flow();
      const task = one.ids.FIXED as string;
      // Two transactions on two connections, started together: the lock of the task puts one behind the other.
      const outcomes = await Promise.allSettled([claim(task, TAKER), claim(task, WIDE)]);
      const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const lost = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]?.reason).toMatchObject({ code: 'PWF_TASK_ALREADY_CLAIMED', status: 409 });
      const held = await ledger(task);
      expect(held).toHaveLength(1);
      expect(held[0]?.role).toBe('RESPONSIBLE');
      expect(await owner(`select id from machvon.project_task_log where task_id = $1::uuid and kind = 'TASK_CLAIMED'`, [task])).toHaveLength(1);
    }
  });

  it('hides the task from a person who cannot read its project, whatever their unit, and refuses a task that is over, has no unit or belongs to a workflow that is not running', async () => {
    const one = await flow();
    // The taker is of the unit and holds the role, and cannot read the project: the task does not exist for them, like a task that is not there.
    expect(await refusal(claim(one.ids.FINANCE as string, TAKER, { read: nothing }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await refusal(claim(randomUUID(), TAKER))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    // Reading without the right to work on tasks there is a refusal, as for every command on a task.
    expect(await refusal(claim(one.ids.FINANCE as string, TAKER, { act: nothing }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
    expect(await ledger(one.ids.FINANCE as string)).toEqual([]);
    expect(await refusal(claim(one.ids.NOBODY as string, TAKER))).toMatchObject({ code: 'PWF_TASK_STATE_INVALID', status: 409, extensions: { reason: 'NO_RECEIVING_UNIT' } });
    expect(await refusal(claim(one.ids.GROUP_A as string, TAKER))).toMatchObject({ code: 'PWF_TASK_STATE_INVALID', status: 409, extensions: { reason: 'TASK_NOT_TRACKED' } });
    await owner(`update machvon.project_task set status = 'IN_PROGRESS', actual_start = $2::date where id = $1::uuid`, [one.ids.OWNER, TODAY]);
    await owner(`update machvon.project_task set status = 'DONE', actual_finish = $2::date where id = $1::uuid`, [one.ids.OWNER, TODAY]);
    expect(await refusal(claim(one.ids.OWNER as string, WIDE))).toMatchObject({ code: 'PWF_TASK_STATE_INVALID', status: 409, extensions: { reason: 'STATUS', task_status: 'DONE' } });
    await owner(`update machvon.project_workflow set status = 'ON_HOLD' where id = $1::uuid`, [one.workflowId]);
    expect(await refusal(claim(one.ids.FINANCE as string, TAKER))).toMatchObject({ code: 'PWF_TASK_STATE_INVALID', status: 409, extensions: { reason: 'WORKFLOW_NOT_ACTIVE' } });
  });

  it('keeps the units of a task as they were resolved: the application cannot change them', async () => {
    const one = await flow();
    const changed = await refusal(as((tx) => tx.query('update machvon.project_task set receiving_unit_id = $2::uuid where id = $1::uuid', [one.ids.FINANCE, unitId(DEPARTMENT)])));
    expect(changed.code).toBe('42501');
  });
});

describe('what the reads say of a task a unit receives (R71)', () => {
  type Item = { task_code?: string; task_id?: string; id?: string; receiving_unit_id?: string; receiving_unit_name?: string | null; receiving_units?: unknown; unclaimed?: boolean; can_claim?: boolean; assignee?: unknown };

  async function surfaces(one: Flow, viewer: number): Promise<{ list: Item; detail: Item; workflow: Item; board: Item; mine: Item | undefined; plain: { list: Item; detail: Item; board: Item } }> {
    const id = one.ids.FINANCE as string;
    const listed = await as((tx) => workflowReads.listTasks(tx, everything, one.projectId, {}, { limit: 50 }, NOW));
    const whole = (await as((tx) => workflowReads.detail(tx, everything, one.projectId, NOW, CAN))) as { tasks: Item[] };
    const onBoard = (await as((tx) => board.board(tx, everything, { projectId: one.projectId }, { limit: 50 }, NOW))) as { items: Item[] };
    const own = (await as((tx) => myTasks.list(tx, everything, memberId(viewer), {}, { limit: 200 }, NOW), viewer)) as { items: Item[] };
    const detail = (await as((tx) => taskReads.task(tx, everything, id, new Date(), memberId(viewer), CAN), viewer)) as Item;
    const plainDetail = (await as((tx) => taskReads.task(tx, everything, one.ids.NOBODY as string, new Date(), memberId(viewer), CAN), viewer)) as Item;
    return {
      list: listed.items.find((item) => item.id === id) as Item,
      detail,
      workflow: whole.tasks.find((item) => item.id === id) as Item,
      board: onBoard.items.find((item) => item.task_id === id) as Item,
      mine: own.items.find((item) => item.task_id === id),
      plain: { list: listed.items.find((item) => item.id === one.ids.NOBODY) as Item, detail: plainDetail, board: onBoard.items.find((item) => item.task_id === one.ids.NOBODY) as Item },
    };
  }

  it('says "nobody has taken it" on every surface until somebody does, offers the button to who may press it, and says nothing of a task no unit receives', async () => {
    const one = await flow({ leader: true });
    const unit = { receiving_unit_id: unitId(FINANCE), receiving_unit_name: `Unit ${FINANCE}`, receiving_units: [{ unit_ref: FINANCE_REF, unit_id: unitId(FINANCE), unit_name: `Unit ${FINANCE}`, role: 'PMB_PLANNER', part: 'LEAD' }] };
    // The leader in charge answers for the task (ACCOUNTABLE), so it is among their tasks, and it still has nobody who does it.
    const before = await surfaces(one, MANAGER);
    for (const item of [before.list, before.detail, before.workflow, before.board, before.mine]) expect(item).toMatchObject({ ...unit, unclaimed: true });
    expect(before.list.assignee).toBeNull();
    // The leader is of no unit of the task: no button for them; the person of the unit has it; a person of another unit or without the role has not.
    expect(before.detail.can_claim).toBe(false);
    const forTaker = (await as((tx) => taskReads.task(tx, everything, one.ids.FINANCE as string, new Date(), memberId(TAKER), CAN), TAKER)) as Item;
    expect(forTaker).toMatchObject({ unclaimed: true, can_claim: true });
    for (const member of [OUTSIDER, ACCOUNTANT, TENANT_WIDE, FORMER]) {
      expect(((await as((tx) => taskReads.task(tx, everything, one.ids.FINANCE as string, new Date(), memberId(member), CAN), member)) as Item).can_claim).toBe(false);
    }
    // Without the right to work on tasks in the project there is no button, whatever the unit.
    expect(((await as((tx) => taskReads.task(tx, everything, one.ids.FINANCE as string, new Date(), memberId(TAKER), { ...CAN, work: false }), TAKER)) as Item).can_claim).toBe(false);
    // A task no unit receives carries none of the fields.
    for (const item of [before.plain.list, before.plain.detail, before.plain.board]) {
      for (const field of ['receiving_unit_id', 'receiving_unit_name', 'receiving_units', 'unclaimed', 'can_claim']) expect(field in item).toBe(false);
    }
    await claim(one.ids.FINANCE as string, TAKER);
    const after = await surfaces(one, MANAGER);
    for (const item of [after.list, after.detail, after.workflow, after.board, after.mine]) expect(item).toMatchObject({ ...unit, unclaimed: false });
    expect(after.list.assignee).toMatchObject({ membership_id: memberId(TAKER) });
    const mine = await surfaces(one, TAKER);
    expect(mine.mine).toMatchObject({ ...unit, unclaimed: false });
    expect(mine.detail.can_claim).toBe(false);
  });

  it('tells the people of the receiving unit, in the alert centre, of a task nobody has taken: to be watched, to be acted on from its planned start, gone once it is taken', async () => {
    const one = await flow();
    const task = one.ids.FINANCE as string;
    const input = (member: number, over: Partial<WorkInput> = {}): WorkInput => ({ membershipId: memberId(member), now: new Date(), today: TODAY, unitScope: everything, projectScope: everything, mode: 'rows', ...over });
    const unclaimed = async (member: number, over: Partial<WorkInput> = {}) => (await as((tx) => work.collect(tx, input(member, over)), member)).rows.filter((row) => row.kind === 'PWF_TASK_UNCLAIMED');
    const mine = (await unclaimed(TAKER)).filter((row) => row.id === `${task}:unclaimed`);
    expect(mine).toHaveLength(1);
    const planned = await owner<{ day: string; name: string }>(`select coalesce(t.committed_start, t.planned_start)::text as day, p.name from machvon.project_task t join machvon.project p on p.id = t.project_id where t.id = $1::uuid`, [task]);
    expect(mine[0]).toMatchObject({ source: 'PROJECT_TASK', severity: 'WATCH', status: 'DUE_SOON', dueOn: planned[0]?.day, target: { screen: 'PWF-04', id: task }, title: 'Task FINANCE: chưa có người nhận', subtitle: `${planned[0]?.name} · đơn vị nhận: Unit ${FINANCE}` });
    expect(mine[0]?.consequence).toBeTruthy();
    // One item per task, and only the tasks a unit receives: the task without a unit and the branch the project does not have are not listed.
    const all = await unclaimed(MANAGER, { view: 'scope' });
    const here = all.filter((row) => Object.values(one.ids).some((id) => row.id === `${id}:unclaimed`)).map((row) => row.id).sort();
    expect(here).toEqual([one.ids.FINANCE, one.ids.FIXED, one.ids.INVEST, one.ids.OWNER].map((id) => `${id}:unclaimed`).sort());
    expect(new Set(all.map((row) => row.id)).size).toBe(all.length);
    // It is the work of the people of the unit that receives the task: the taker is of the finance and the appraisal units, the planner of the province of every unit, the outsider only of the department that owns the project.
    const idsOf = async (member: number): Promise<string[]> => (await unclaimed(member)).filter((row) => Object.values(one.ids).some((id) => row.id === `${id}:unclaimed`)).map((row) => row.id).sort();
    expect(await idsOf(TAKER)).toEqual([one.ids.FINANCE, one.ids.FIXED].map((id) => `${id}:unclaimed`).sort());
    expect(await idsOf(WIDE)).toEqual(here);
    expect(await idsOf(OUTSIDER)).toEqual([`${one.ids.OWNER}:unclaimed`]);
    expect(await idsOf(TENANT_WIDE)).toEqual([]);
    expect(await idsOf(FORMER)).toEqual([]);
    // Being of the unit opens no project: outside what the person may read there is nothing.
    expect((await unclaimed(TAKER, { projectScope: nothing })).filter((row) => row.id === `${task}:unclaimed`)).toEqual([]);
    // From the day the task is planned to start it is to be acted on.
    await owner(`update machvon.project_task set committed_start = $2::date, planned_start = $2::date where id = $1::uuid`, [task, TODAY]);
    const due = (await unclaimed(TAKER)).filter((row) => row.id === `${task}:unclaimed`);
    expect(due[0]).toMatchObject({ severity: 'ACTION', status: 'DUE_TODAY', dueOn: TODAY });
    expect(due[0]?.subtitle).toContain('đã tới ngày bắt đầu');
    // Somebody takes it: the item is gone for everyone, in the same transaction.
    await claim(task, TAKER);
    expect((await unclaimed(TAKER)).filter((row) => row.id === `${task}:unclaimed`)).toEqual([]);
    expect((await unclaimed(MANAGER, { view: 'scope' })).filter((row) => row.id === `${task}:unclaimed`)).toEqual([]);
    // A workflow that is not running tells nothing.
    await owner(`update machvon.project_workflow set status = 'ON_HOLD' where id = $1::uuid`, [one.workflowId]);
    expect((await unclaimed(MANAGER, { view: 'scope' })).filter((row) => Object.values(one.ids).some((id) => row.id === `${id}:unclaimed`))).toEqual([]);
  });
});

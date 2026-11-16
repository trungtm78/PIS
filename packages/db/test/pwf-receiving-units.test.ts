import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { PrjProjectStore } from '../src/prj-project-store';
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

const MANAGER = 1;
const WORKER = 2;
const CHECKER = 3;
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

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
 * PWF-5 over HTTP (docs PWF 22.2 R61, 22.3 R71): a workflow is made only once every party of its template has a unit (`units`), the reads say which unit receives a task and whether nobody has taken it, and "Nhận việc"
 * (`claimProjectTask`) gives the task to a person of the unit who holds the role of its line: once, to one person, and never to somebody who cannot read the project.
 */

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const YEAR = Number(TODAY.slice(0, 4));
const MANAGER = 1;
const CHECKER = 2;
/** Reads every project; a planner of the finance unit. */
const TAKER = 3;
/** Reads every project; a planner over the whole tree of units. */
const WIDE = 4;
/** Reads every project; a planner of the department that owns the project. */
const OUTSIDER = 5;
/** Reads every project; of the finance unit, but an accountant there. */
const ACCOUNTANT = 6;
/** A planner of the finance unit who reads nothing outside it: the project of the department does not exist for them. */
const BLIND = 7;
/** Reads every project; an appraiser of the appraisal unit. */
const APPRAISER = 8;
const ROOT = 1;
const DEPARTMENT = 2;
const FINANCE = 3;
const APPRAISAL = 4;
const SYSTEM = '00000000-0000-4000-8000-000000000000';

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const START = addDays(TODAY, 10);
const FINANCE_REF = 'PROJECT_PARTY:FINANCE_DEPARTMENT';
const APPRAISER_REF = 'PROJECT_PARTY:APPRAISER';
const UNITS = { [FINANCE_REF]: unitId(FINANCE), [APPRAISER_REF]: unitId(APPRAISAL) };

const plain = (code: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  code,
  name: `Task ${code}`,
  phase: 'P1',
  kind: 'TASK',
  duration_working_days: 3,
  required: true,
  responsible_role: 'PMB_PLANNER',
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
const lead = (unit_ref: string): Record<string, string> => ({ unit_ref, role: 'PMB_PLANNER', part: 'LEAD' });

const TEMPLATE = {
  name: 'Unit flow over HTTP',
  project_type: null,
  phases: [{ code: 'P1', name: 'Phase one', gates: [] }],
  parties: [
    { code: 'FINANCE_DEPARTMENT', name: 'Sở Tài chính' },
    { code: 'APPRAISER', name: 'Đơn vị thẩm định' },
  ],
  tasks: [
    plain('FINANCE', { responsible_units: [lead(FINANCE_REF)] }),
    plain('RACE', { responsible_units: [lead(FINANCE_REF)] }),
    plain('OVER', { responsible_units: [lead(FINANCE_REF)] }),
    plain('BOTH', { responsible_units: [lead('PROJECT_OWNER'), { unit_ref: APPRAISER_REF, role: 'DPI_APPRAISER', part: 'SUPPORT' }] }),
    plain('PLAIN'),
  ],
};
const OLD_TEMPLATE = { name: 'Old flow over HTTP', project_type: null, phases: TEMPLATE.phases, tasks: [plain('ONE')] };

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

type Item = { id?: string; task_id?: string; task_code: string; receiving_unit_id?: string; receiving_unit_name?: string | null; receiving_units?: unknown; unclaimed?: boolean; can_claim?: boolean; assignee?: { membership_id: string } | null };

describe('the units of a workflow and "Nhận việc" over HTTP (PWF-5, R61, R71)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let areaVersion = '';
  let projectId = '';
  const ids: Record<string, string> = {};

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

  async function call(method: string, url: string, member: number, body?: unknown, key?: string): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const newProject = async (): Promise<string> => {
    const made = await call('POST', '/projects', MANAGER, { code: `PWU-${randomUUID().slice(0, 6)}`, name: 'Dự án đường vành đai 4', owner_unit_id: unitId(DEPARTMENT), area_master_version_id: areaVersion, total_investment_vnd: '500000000000' });
    expect(made.status).toBe(200);
    const id = made.json.resource_id as string;
    await rows(`update machvon.project set status = 'CONCEPT', project_group = 'B' where id = $1::uuid`, [id]);
    return id;
  };
  const claim = (code: string, member: number, body: Record<string, unknown> = {}, key?: string): Promise<Reply> => call('POST', `/project-tasks/${ids[code]}/claim`, member, body, key);
  const ledger = (code: string): Promise<Array<{ membership_id: string; role: string; share_pct: number; valid_from: string }>> =>
    rows(`select membership_id, role, share_pct, valid_from::text as valid_from from machvon.project_task_assignment where task_id = $1::uuid order by assigned_at, id`, [ids[code]]);

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      { n: FINANCE, path: `/${unitId(ROOT)}/${unitId(FINANCE)}/`, parent: ROOT },
      { n: APPRAISAL, path: `/${unitId(ROOT)}/${unitId(APPRAISAL)}/`, parent: ROOT },
    ]);
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: SYSTEM, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, SYSTEM, TODAY));
    for (const n of [MANAGER, CHECKER, TAKER, WIDE, OUTSIDER, ACCOUNTANT, BLIND, APPRAISER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PWF_MANAGER', ['project.create', 'project.read', 'pwf.workflow.manage', 'pwf.workflow.adopt', 'pwf.read', 'pwf.task.work', 'pwf.task.assign'], 40);
    await harness.seedRole(TENANT_A, 2, 'PWF_READER', ['pwf.read', 'pwf.task.work'], 20);
    await harness.seedRole(TENANT_A, 3, 'PMB_PLANNER', ['pwf.read', 'pwf.task.work'], 20);
    await harness.seedRole(TENANT_A, 4, 'PMB_ACCOUNTANT', ['pwf.read', 'pwf.task.work'], 20);
    await harness.seedRole(TENANT_A, 5, 'DPI_APPRAISER', ['pwf.read', 'pwf.task.work'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      ...[TAKER, WIDE, OUTSIDER, ACCOUNTANT, APPRAISER].map((member, index) => ({ n: 10 + index, member, role: 2, kind: 'TENANT' as const })),
      { n: 20, member: TAKER, role: 3, kind: 'UNIT_ONLY', refs: [unitId(FINANCE)] },
      { n: 21, member: WIDE, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(ROOT)] },
      { n: 22, member: OUTSIDER, role: 3, kind: 'UNIT_ONLY', refs: [unitId(DEPARTMENT)] },
      { n: 23, member: ACCOUNTANT, role: 4, kind: 'UNIT_ONLY', refs: [unitId(FINANCE)] },
      { n: 24, member: BLIND, role: 3, kind: 'UNIT_ONLY', refs: [unitId(FINANCE)] },
      { n: 25, member: APPRAISER, role: 5, kind: 'UNIT_ONLY', refs: [unitId(APPRAISAL)] },
    ]);
    const recordId = randomUUID();
    areaVersion = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'TINH-U', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(MANAGER)]],
      [`insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, valid_until, status, master_record_id, published_at, created_by, updated_by) values ($1, $2, 'AREA', 'TINH-U', 1, 'TINH-U', '{}'::jsonb, '2020-01-01', null, 'EFFECTIVE', $3, now(), $4, $4)`, [TENANT_A, areaVersion, recordId, memberId(MANAGER)]],
    ]);
    await harness.owner(
      TENANT_A,
      [YEAR - 1, YEAR, YEAR + 1, YEAR + 2].map((year): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
        [TENANT_A, year, memberId(MANAGER)],
      ]),
    );
    for (const [code, params] of [['UNITAPI', TEMPLATE], ['OLDAPI', OLD_TEMPLATE]] as const) {
      await rows(
        `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
         values ($1, 'PROJECT_WORKFLOW_TEMPLATE', $2, 1, 'APPROVED', $3::jsonb, date '2020-01-01', 'A template for the tests', $4, $5, now(), $6, now())`,
        [TENANT_A, code, JSON.stringify(params), memberId(MANAGER), memberId(CHECKER), memberId(TAKER)],
      );
    }
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
    projectId = await newProject();
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('previews which parties still ask for a unit, refuses the start until they are named, never lets a unit of the project be replaced, and records the units of the workflow', async () => {
    const suggestion = await call('GET', `/project-workflow/suggestion?project_id=${projectId}&template_code=UNITAPI&planned_start_date=${START}`, MANAGER);
    expect(suggestion.status).toBe(200);
    expect((suggestion.json.preview as { units: unknown }).units).toEqual({
      refs: [
        { unit_ref: FINANCE_REF, unit_id: null, unit_name: null, source: 'NONE', party_name: 'Sở Tài chính' },
        { unit_ref: 'PROJECT_OWNER', unit_id: unitId(DEPARTMENT), unit_name: `Unit ${DEPARTMENT}`, source: 'PROJECT', party_name: null },
        { unit_ref: APPRAISER_REF, unit_id: null, unit_name: null, source: 'NONE', party_name: 'Đơn vị thẩm định' },
      ],
      unresolved: [FINANCE_REF, APPRAISER_REF],
    });
    const dry = await call('POST', `/projects/${projectId}/workflow/adopt`, MANAGER, { template_code: 'UNITAPI', planned_start_date: START, effective_date: TODAY, dry_run: true, facts: { project_group: 'B' } });
    expect(dry.status).toBe(200);
    expect(dry.json.units).toMatchObject({ unresolved: [FINANCE_REF, APPRAISER_REF] });
    expect(dry.json.applied).toBe(false);

    const start = (units?: unknown): Promise<Reply> => call('POST', `/projects/${projectId}/workflow`, MANAGER, { template_code: 'UNITAPI', planned_start_date: START, facts: { project_group: 'B' }, ...(units === undefined ? {} : { units }) });
    expect(await start()).toMatchObject({ status: 422, json: { code: 'PWF_UNIT_UNRESOLVED', detail: 'units', unit_refs: [APPRAISER_REF, FINANCE_REF] } });
    expect(await start({ ...UNITS, PROJECT_OWNER: unitId(FINANCE) })).toMatchObject({ status: 422, json: { code: 'PWF_UNIT_OVERRIDE_DENIED', unit_refs: ['PROJECT_OWNER'] } });
    expect(await start({ ...UNITS, [FINANCE_REF]: randomUUID() })).toMatchObject({ status: 422, json: { code: 'PWF_UNIT_UNKNOWN', unit_refs: [FINANCE_REF] } });
    expect(await start({ ...UNITS, 'PROJECT_PARTY:NOBODY_USES_IT': unitId(FINANCE) })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'units' } });
    const malformed = await start({ ...UNITS, [FINANCE_REF]: 'not-a-unit' });
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(malformed.status).toBeLessThan(500);
    expect(malformed.json.code).toBe('VALIDATION_FAILED');
    expect(await rows('select id from machvon.project_workflow where project_id = $1::uuid', [projectId])).toEqual([]);

    // The manager is the leader in charge of the project: the tasks a unit receives are the leader's to answer for, not to do.
    await rows(`update machvon.project_accountability set status = 'ENDED', valid_until = $2::date where project_id = $1::uuid and status = 'ACTIVE' and accountability_role = 'LEADER_IN_CHARGE'`, [projectId, TODAY]);
    await rows(
      `insert into machvon.project_accountability (tenant_id, id, project_id, accountability_role, leader_membership_id, status, valid_from, created_by, updated_by) values ($1, gen_random_uuid(), $2::uuid, 'LEADER_IN_CHARGE', $3::uuid, 'ACTIVE', date '2020-01-01', $3::uuid, $3::uuid)`,
      [TENANT_A, projectId, memberId(MANAGER)],
    );
    const started = await start(UNITS);
    expect(started.status).toBe(200);
    for (const row of await rows<{ id: string; task_code: string }>('select id, task_code from machvon.project_task where project_id = $1::uuid', [projectId])) ids[row.task_code] = row.id;
    const workflow = await call('GET', `/projects/${projectId}/workflow`, MANAGER);
    expect((workflow.json.selection as { units: unknown }).units).toEqual([
      { unit_ref: FINANCE_REF, unit_id: unitId(FINANCE), source: 'CHOSEN' },
      { unit_ref: 'PROJECT_OWNER', unit_id: unitId(DEPARTMENT), source: 'PROJECT' },
      { unit_ref: APPRAISER_REF, unit_id: unitId(APPRAISAL), source: 'CHOSEN' },
    ]);
  });

  it('registers a project with its workflow only when the units are named, and starts a template without units as it always did', async () => {
    const body = (code: string, workflow: Record<string, unknown>): Record<string, unknown> => ({ code, name: 'Dự án cầu Rạch Miễu 3', owner_unit_id: unitId(DEPARTMENT), area_master_version_id: areaVersion, total_investment_vnd: '500000000000', workflow });
    const refusedCode = `PWR-${randomUUID().slice(0, 6)}`;
    const refused = await call('POST', '/projects', MANAGER, body(refusedCode, { template_code: 'UNITAPI', planned_start_date: START, facts: { project_group: 'B' }, selection_reason: 'The template of the tests is chosen on purpose' }));
    expect(refused).toMatchObject({ status: 422, json: { code: 'PWF_UNIT_UNRESOLVED', unit_refs: [APPRAISER_REF, FINANCE_REF] } });
    // Whatever refuses the workflow refuses the registration: no project is left behind.
    expect(await rows('select id from machvon.project where code = $1', [refusedCode])).toEqual([]);
    const made = await call('POST', '/projects', MANAGER, body(`PWR-${randomUUID().slice(0, 6)}`, { template_code: 'UNITAPI', planned_start_date: START, facts: { project_group: 'B' }, selection_reason: 'The template of the tests is chosen on purpose', units: UNITS }));
    expect(made.status).toBe(200);
    const stored = await rows<{ task_code: string; receiving_unit_id: string | null }>('select task_code, receiving_unit_id from machvon.project_task where project_id = $1::uuid order by task_code', [made.json.resource_id]);
    expect(stored).toEqual([
      { task_code: 'BOTH', receiving_unit_id: unitId(DEPARTMENT) },
      { task_code: 'FINANCE', receiving_unit_id: unitId(FINANCE) },
      { task_code: 'OVER', receiving_unit_id: unitId(FINANCE) },
      { task_code: 'PLAIN', receiving_unit_id: null },
      { task_code: 'RACE', receiving_unit_id: unitId(FINANCE) },
    ]);
    // A template that names no unit: nothing is asked, nothing is recorded, and the reads carry none of the new fields.
    const old = await newProject();
    expect((await call('POST', `/projects/${old}/workflow`, MANAGER, { template_code: 'OLDAPI', planned_start_date: START, facts: { project_group: 'B' } })).status).toBe(200);
    const view = await call('GET', `/projects/${old}/workflow`, MANAGER);
    expect('units' in (view.json.selection as Record<string, unknown>)).toBe(false);
    const task = (view.json.tasks as Item[])[0] as Item;
    for (const field of ['receiving_unit_id', 'receiving_unit_name', 'receiving_units', 'unclaimed']) expect(field in task).toBe(false);
    const dry = await call('POST', `/projects/${await newProject()}/workflow/adopt`, MANAGER, { template_code: 'OLDAPI', planned_start_date: START, effective_date: TODAY, dry_run: true, facts: { project_group: 'B' } });
    expect(dry.json.units).toEqual({ refs: [], unresolved: [] });
  });

  /** The task FINANCE on every read surface, as the manager reads it (the leader in charge: the task is among "my tasks" because they answer for it). */
  async function surfaces(): Promise<Item[]> {
    const pick = (items: unknown): Item => (items as Item[]).find((item) => (item.id ?? item.task_id) === ids.FINANCE) as Item;
    const list = await call('GET', `/projects/${projectId}/workflow/tasks?limit=50`, MANAGER);
    const workflow = await call('GET', `/projects/${projectId}/workflow`, MANAGER);
    const detail = await call('GET', `/project-tasks/${ids.FINANCE}`, MANAGER);
    const mine = await call('GET', '/me/project-tasks?limit=50', MANAGER);
    const board = await call('GET', `/pwf/deadlines?limit=50&project_id=${projectId}`, MANAGER);
    for (const reply of [list, workflow, detail, mine, board]) expect(reply.status).toBe(200);
    return [pick(list.json.items), pick(workflow.json.tasks), detail.json as unknown as Item, pick(mine.json.items), pick(board.json.items)];
  }

  it('says on every read that nobody has taken the task, gives it to the person of the unit who holds the role, once, and then says so everywhere', async () => {
    const unit = { receiving_unit_id: unitId(FINANCE), receiving_unit_name: `Unit ${FINANCE}`, receiving_units: [{ unit_ref: FINANCE_REF, unit_id: unitId(FINANCE), unit_name: `Unit ${FINANCE}`, role: 'PMB_PLANNER', part: 'LEAD' }] };
    for (const item of await surfaces()) expect(item).toMatchObject({ ...unit, unclaimed: true });
    // The button: for the person of the unit with the role, for nobody else.
    expect((await call('GET', `/project-tasks/${ids.FINANCE}`, TAKER)).json).toMatchObject({ can_claim: true, unclaimed: true });
    for (const member of [MANAGER, OUTSIDER, ACCOUNTANT, APPRAISER]) expect((await call('GET', `/project-tasks/${ids.FINANCE}`, member)).json.can_claim).toBe(false);
    const plainTask = (await call('GET', `/project-tasks/${ids.PLAIN}`, TAKER)).json;
    for (const field of ['receiving_unit_id', 'receiving_units', 'unclaimed', 'can_claim']) expect(field in plainTask).toBe(false);

    // Not of the unit, or of the unit without the role of the line: refused, and nothing is written.
    expect(await claim('FINANCE', OUTSIDER)).toMatchObject({ status: 403, json: { code: 'PWF_CLAIM_NOT_ELIGIBLE', reason: 'NOT_MEMBER' } });
    expect(await claim('FINANCE', ACCOUNTANT)).toMatchObject({ status: 403, json: { code: 'PWF_CLAIM_NOT_ELIGIBLE', reason: 'ROLE_NOT_HELD' } });
    expect(await claim('FINANCE', MANAGER)).toMatchObject({ status: 403, json: { code: 'PWF_CLAIM_NOT_ELIGIBLE' } });
    expect((await ledger('FINANCE')).filter((line) => line.role === 'RESPONSIBLE')).toEqual([]);

    const key = `key-${randomUUID()}`;
    const done = await claim('FINANCE', TAKER, {}, key);
    expect(done).toMatchObject({ status: 200, json: { status: 'CLAIMED' } });
    expect((await ledger('FINANCE')).filter((line) => line.role === 'RESPONSIBLE')).toEqual([{ membership_id: memberId(TAKER), role: 'RESPONSIBLE', share_pct: 100, valid_from: TODAY }]);
    // The same request sent again (the same key) is the same answer, not a second claim; a new request is refused: the task is taken.
    expect(await claim('FINANCE', TAKER, {}, key)).toMatchObject({ status: 200, json: { resource_id: done.json.resource_id } });
    expect(await claim('FINANCE', TAKER)).toMatchObject({ status: 409, json: { code: 'PWF_TASK_ALREADY_CLAIMED' } });
    expect(await claim('FINANCE', WIDE)).toMatchObject({ status: 409, json: { code: 'PWF_TASK_ALREADY_CLAIMED' } });
    expect(await rows(`select 1 from machvon.project_task_log where task_id = $1::uuid and kind = 'TASK_CLAIMED'`, [ids.FINANCE])).toHaveLength(1);
    const audited = await rows<{ diff: Record<string, unknown> }>(`select safe_diff as diff from machvon.audit_event where resource_id = $1 and action = 'task.claimed'`, [ids.FINANCE]);
    expect(audited).toHaveLength(1);
    expect(audited[0]?.diff).toMatchObject({ part: 'LEAD', role: 'RESPONSIBLE', unit_id: unitId(FINANCE), project_id: projectId });

    for (const item of await surfaces()) expect(item).toMatchObject({ ...unit, unclaimed: false });
    expect((await surfaces())[0]?.assignee).toMatchObject({ membership_id: memberId(TAKER) });
    expect((await call('GET', `/project-tasks/${ids.FINANCE}`, TAKER)).json).toMatchObject({ can_claim: false, unclaimed: false, can_start: true });
    const mine = await call('GET', '/me/project-tasks?limit=50', TAKER);
    expect((mine.json.items as Item[]).find((item) => item.task_id === ids.FINANCE)).toMatchObject({ ...unit, unclaimed: false });
  });

  it('gives a supporting line CONSULTED and leaves the task without a responsible person', async () => {
    expect(await claim('BOTH', APPRAISER, { part: 'LEAD' })).toMatchObject({ status: 403, json: { code: 'PWF_CLAIM_NOT_ELIGIBLE' } });
    expect(await claim('BOTH', APPRAISER)).toMatchObject({ status: 200, json: { status: 'CLAIMED' } });
    expect((await ledger('BOTH')).filter((line) => line.role !== 'ACCOUNTABLE')).toEqual([{ membership_id: memberId(APPRAISER), role: 'CONSULTED', share_pct: 100, valid_from: TODAY }]);
    expect((await call('GET', `/project-tasks/${ids.BOTH}`, MANAGER)).json).toMatchObject({ unclaimed: true, receiving_unit_id: unitId(DEPARTMENT) });
    // The leading line is still free for a planner of the department that owns the project.
    expect((await claim('BOTH', OUTSIDER)).status).toBe(200);
    expect((await call('GET', `/project-tasks/${ids.BOTH}`, MANAGER)).json).toMatchObject({ unclaimed: false });
    expect((await claim('BOTH', APPRAISER, { part: 'SIDEWAYS' })).status).toBeGreaterThanOrEqual(400);
  });

  it('lets exactly one of two people who press at the same moment have the task', async () => {
    const replies = await Promise.all([claim('RACE', TAKER), claim('RACE', WIDE)]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    expect(replies.find((reply) => reply.status === 409)?.json.code).toBe('PWF_TASK_ALREADY_CLAIMED');
    expect((await ledger('RACE')).filter((line) => line.role === 'RESPONSIBLE')).toHaveLength(1);
  });

  it('answers a person who cannot read the project as if the task were not there, whatever their unit and role, and refuses a task that is over', async () => {
    // A planner of the finance unit who reads nothing of the department: the read and the command both say 404, like for an id that does not exist.
    expect((await call('GET', `/project-tasks/${ids.OVER}`, BLIND)).status).toBe(404);
    const hidden = await claim('OVER', BLIND);
    expect(hidden).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
    const missing = await call('POST', `/project-tasks/${randomUUID()}/claim`, BLIND, {});
    expect(missing).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
    // Nothing in the refusal tells the two apart.
    const shape = (reply: Reply): Record<string, unknown> => ({ ...reply.json, correlation_id: null });
    expect(shape(hidden)).toEqual(shape(missing));
    expect((await ledger('OVER')).filter((line) => line.role === 'RESPONSIBLE')).toEqual([]);
    await rows(`update machvon.project_task set status = 'IN_PROGRESS', actual_start = $2::date where id = $1::uuid`, [ids.OVER, TODAY]);
    await rows(`update machvon.project_task set status = 'DONE', actual_finish = $2::date where id = $1::uuid`, [ids.OVER, TODAY]);
    expect(await claim('OVER', TAKER)).toMatchObject({ status: 409, json: { code: 'PWF_TASK_STATE_INVALID', reason: 'STATUS' } });
    expect(await claim('PLAIN', TAKER)).toMatchObject({ status: 409, json: { code: 'PWF_TASK_STATE_INVALID', reason: 'NO_RECEIVING_UNIT' } });
    expect((await call('GET', `/project-tasks/${ids.OVER}`, MANAGER)).json).toMatchObject({ unclaimed: false, can_claim: false });
  });
});

import { randomUUID } from 'node:crypto';
import { ND30_A4_STANDARD, pwfWorkflow, vietnamDateOf } from '@machvon/kernel';
import { HomeWorkStore } from '../src/home-work-store';
import type { WorkInput } from '../src/home-work-store';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { PrjProjectStore } from '../src/prj-project-store';
import { PwfAssignmentReads } from '../src/pwf-assignment';
import { PwfTaskReads } from '../src/pwf-task-reads';
import { PwfTaskStore } from '../src/pwf-task-store';
import { PwfWorkflowReads } from '../src/pwf-workflow-reads';
import { PwfWorkflowStore } from '../src/pwf-workflow-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from './support/authz-fixtures';

jest.setTimeout(300_000);

/** PWF-4: the processing workflow of a project in three tiers (phase, step, task with its checklist), the legal grounds of steps and tasks, the revision of the forms, and the rule that maps a project to its kind of workflow. */

const harness = new AuthzHarness();
const projects = new PrjProjectStore();
const workflows = new PwfWorkflowStore();
const tasks = new PwfTaskStore();
const reads = new PwfWorkflowReads();
const taskReads = new PwfTaskReads();
const assignment = new PwfAssignmentReads();
const work = new HomeWorkStore();

const MANAGER = 1;
const WORKER = 2;
const CHECKER = 3;
const PROVINCE = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const WORKER_ID = '00000000-0000-4000-8000-000000000000';
const TODAY = vietnamDateOf(new Date());
const YEAR = Number(TODAY.slice(0, 4));
const START = `${YEAR}-11-02`;
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const scopes = { act: everything, read: everything };
const CAN = { manage: true, proposeReschedule: true, work: true, approve: true, assign: true };

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MANAGER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
const now = (): Date => new Date();

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const cite = (document: string, article?: string) => ({ document, ...(article === undefined ? {} : { article }), verification: 'UNVERIFIED' });
const one = (code: string, phase: string, step: string | undefined, extra: Record<string, unknown> = {}) => ({
  code,
  name: `Task ${code}`,
  phase,
  ...(step === undefined ? {} : { step }),
  kind: 'TASK',
  duration_working_days: 2,
  required: true,
  responsible_role: 'WORKER_ROLE',
  priority: 'NORMAL',
  predecessors: [],
  legal_doc_types: [],
  form_templates: [],
  checklist: [],
  kpi_codes: [],
  when: [],
  ...extra,
});
const fs = (task: string) => ({ task, kind: 'FS', lag_working_days: 0 });
const PHASES = [
  { code: 'P1', name: 'Phase one', gates: [] },
  { code: 'P2', name: 'Phase two', gates: [] },
];

/** P1 has the steps S_PREPARE (TA, TB) and S_REVIEW (TC); P2 has S_CLOSE (TD). TA has a checklist of two items (one required) and uses two forms, one of them pinned to revision 1. */
const STEPPED = {
  name: 'Stepped flow',
  project_type: 'STEPPED_KIND',
  phases: PHASES,
  steps: [
    { code: 'S_PREPARE', name: 'Prepare', phase: 'P1', responsible_role: 'LEAD_ROLE', legal_basis: [cite('LAW_58_2024_QH15'), cite('TEST_DECREE_OLD', 'Article 9')] },
    { code: 'S_REVIEW', name: 'Review', phase: 'P1' },
    { code: 'S_CLOSE', name: 'Close', phase: 'P2' },
  ],
  tasks: [
    one('TA', 'P1', 'S_PREPARE', {
      legal_basis: [cite('DECREE_85_2025_ND_CP', 'Article 22')],
      form_templates: ['FORM_LATEST', 'FORM_PINNED'],
      form_policies: [{ form: 'FORM_PINNED', policy: 'PINNED', revision: 1 }],
      checklist: [
        { code: 'DOSSIER', name: 'Dossier complete', required: true, evidence_kinds: ['DOCUMENT'] },
        { code: 'NOTE', name: 'Note taken', required: false, evidence_kinds: [] },
      ],
    }),
    one('TB', 'P1', 'S_PREPARE', { predecessors: [fs('TA')] }),
    one('TC', 'P1', 'S_REVIEW', { predecessors: [fs('TB')] }),
    one('TD', 'P2', 'S_CLOSE', { predecessors: [fs('TC')] }),
  ],
};
const LEGACY = { name: 'Legacy flow', phases: PHASES, tasks: [one('TA', 'P1', undefined), one('TB', 'P2', undefined, { predecessors: [fs('TA')] })] };

let areaVersion = '';
let layoutProfile = '';
let counter = 0;

async function approveRule(type: string, code: string, params: unknown, unit: number | null = null, version = 1, from = '2020-01-01'): Promise<void> {
  await owner(
    `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at, unit_id)
     values ($1, $2, $3, $4, 'APPROVED', $5::jsonb, $10::date, 'A rule for the tests', $6, $7, now(), $8, now(), $9)`,
    [TENANT_A, type, code, version, JSON.stringify(params), memberId(MANAGER), memberId(WORKER), memberId(CHECKER), unit === null ? null : unitId(unit), from],
  );
}

async function project(options: { group?: string | null; unit?: number } = {}): Promise<{ id: string; code: string }> {
  counter += 1;
  const code = `PP-${counter}-${randomUUID().slice(0, 6)}`;
  const created = await as((tx) => projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(options.unit ?? DEPARTMENT), areaMasterVersionId: areaVersion, totalInvestmentVnd: '500000000000' }, memberId(MANAGER), TODAY));
  await owner('update machvon.project set project_group = $2 where id = $1::uuid', [created.id, options.group === undefined ? 'B' : options.group]);
  return { id: created.id, code };
}

async function formRevision(code: string, revision: number, status: string, from: string, until: string | null): Promise<string> {
  const sha = (revision === 1 ? 'a' : 'b').repeat(64);
  await owner(
    `insert into machvon.document_template (tenant_id, id, template_code, revision, group_code, doc_type_code, title, layout_profile_id, body_blocks, placeholder_schema, legal_basis, watermark_text, content_sha256, effective_from, effective_until, status, created_by, updated_by)
     values ($1, gen_random_uuid(), $2, $3, 'OTHER', 'BM', $4, $5, '[]'::jsonb, '{}'::jsonb, 'A basis', 'UNCONFIRMED', $6, $7::date, $8::date, $9, $10, $10)`,
    [TENANT_A, code, revision, `Form ${code} r${revision}`, layoutProfile, sha, from, until, status, memberId(MANAGER)],
  );
  return sha;
}

async function document(): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'A paper', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
    [TENANT_A, id, `QD-${id.slice(0, 8)}/2026`, memberId(MANAGER)],
  );
  return id;
}

const start = (projectId: string, over: Partial<Parameters<PwfWorkflowStore['start']>[1]> = {}) =>
  as((tx) => workflows.start(tx, { projectId, templateCode: 'STEPPED', plannedStartDate: START, actor: memberId(MANAGER), scopes, now: now(), ...over }));
const taskOf = async (workflowId: string, code: string): Promise<Record<string, unknown>> => (await owner<{ j: Record<string, unknown> }>('select to_jsonb(t) as j from machvon.project_task t where workflow_id = $1::uuid and task_code = $2', [workflowId, code]))[0]?.j as Record<string, unknown>;
const detail = (projectId: string): Promise<Record<string, unknown>> => as((tx) => reads.detail(tx, everything, projectId, now(), CAN));
const taskDetail = (taskId: string): Promise<Record<string, unknown>> => as((tx) => taskReads.task(tx, everything, taskId, now(), memberId(WORKER), CAN));

async function working(workflowId: string, code: string): Promise<string> {
  const t = await taskOf(workflowId, code);
  await as((tx) => tasks.assign(tx, { taskId: t.id as string, actor: memberId(MANAGER), scopes, today: TODAY, input: { membershipId: memberId(WORKER), role: 'RESPONSIBLE', validFrom: '2020-01-01', sharePct: 100, reason: 'Assigned for the test' } }));
  const again = await taskOf(workflowId, code);
  await as((tx) => tasks.start(tx, { taskId: t.id as string, expectedVersion: Number(again.version), actor: memberId(WORKER), scopes, today: TODAY }), WORKER);
  return t.id as string;
}
const attach = (taskId: string, input: Record<string, unknown>) => as((tx) => tasks.attachEvidence(tx, { taskId, actor: memberId(WORKER), scopes, today: TODAY, input: input as never }), WORKER);

describe('the processing workflow of a project (PWF-4)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: PROVINCE, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
      { n: ELSEWHERE, path: '/u3/' },
    ]);
    await harness.seedMembership(TENANT_A, MANAGER, PROVINCE);
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_ID, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER_ID, TODAY));
    for (const n of [WORKER, CHECKER]) await harness.seedMembership(TENANT_A, n, DEPARTMENT);
    const recordId = randomUUID();
    areaVersion = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'AREA-P', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(MANAGER)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, 'AREA', 'AREA-P', 1, 'Area', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $3, now(), $4, $4)`,
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
    layoutProfile = randomUUID();
    await owner(
      `insert into machvon.document_layout_profile (tenant_id, id, profile_code, revision, margins_mm, element_styles, signature_layout, number_field_layout, watermark_policy, legal_basis, effective_from, status, created_by, updated_by)
       values ($1, $2, 'TEST', 1, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, '{}'::jsonb, 'A basis', '2020-01-01', 'PUBLISHED', $3, $3)`,
      [TENANT_A, layoutProfile, memberId(MANAGER), JSON.stringify(ND30_A4_STANDARD.marginsMm), JSON.stringify(ND30_A4_STANDARD.elementStyles), JSON.stringify(ND30_A4_STANDARD.signatureLayout), JSON.stringify(ND30_A4_STANDARD.numberFieldLayout)],
    );
    await approveRule('LEGAL_DOCUMENT', 'TEST_DECREE_OLD', { doc_kind: 'DECREE', number: '1/2020/ND-CP', title: 'An old decree', issuer: 'Government', effective_from: '2020-01-01', verification: 'VERIFIED' });
    await approveRule('PROJECT_WORKFLOW_TEMPLATE', 'STEPPED', STEPPED);
    await approveRule('PROJECT_WORKFLOW_TEMPLATE', 'LEGACY', LEGACY);
    await formRevision('FORM_LATEST', 1, 'PUBLISHED', '2020-01-01', null);
    await formRevision('FORM_PINNED', 1, 'PUBLISHED', '2020-01-01', null);
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the rule that maps a project to its kind of workflow (R47)', () => {
    it('suggests by the built-in rule when the tenant approved none, and lists the templates the tenant has', async () => {
      const view = await as((tx) => assignment.suggest(tx, { facts: { project_group: 'B' }, unitId: unitId(DEPARTMENT), asOf: TODAY }));
      expect(view.suggestion).toMatchObject({ templateCode: 'PUBLIC_INVESTMENT', basis: 'DEFAULT', line: null });
      expect(view.rule).toEqual({ ruleId: null, version: 0, unitId: null, unverified: true });
      expect(view.templates.map((item) => item.code)).toEqual(expect.arrayContaining(['PUBLIC_INVESTMENT', 'PUBLIC_PROCUREMENT', 'PUBLIC_REPAIR', 'STEPPED', 'LEGACY']));
      expect(view.templates.find((item) => item.code === 'STEPPED')).toMatchObject({ projectType: 'STEPPED_KIND', phaseCount: 2, stepCount: 3, taskCount: 4, unverified: false, version: 1 });
      expect(view.templates.find((item) => item.code === 'LEGACY')).toMatchObject({ projectType: null, stepCount: 2 });
      expect(view.templates.find((item) => item.code === 'PUBLIC_INVESTMENT')?.factFields).toEqual(['funding_source', 'project_group']);
    });

    it('takes the template whose own project type is the type of the project before the default of the rule', async () => {
      const view = await as((tx) => assignment.suggest(tx, { facts: { project_type: 'STEPPED_KIND' }, asOf: TODAY }));
      expect(view.suggestion).toMatchObject({ templateCode: 'STEPPED', basis: 'PROJECT_TYPE' });
    });

    it('AC-ST-PWF-024-4: reads the rule of the nearest unit before the rule of the tenant, and refuses a fact that is not one', async () => {
      await approveRule('PROJECT_WORKFLOW_ASSIGNMENT', 'DEFAULT', { lines: [{ code: 'GROUP_B', priority: 10, template_code: 'STEPPED', when: [{ field: 'project_group', in: ['B'] }] }], default_template_code: 'LEGACY' }, DEPARTMENT);
      await approveRule('PROJECT_WORKFLOW_ASSIGNMENT', 'DEFAULT', { lines: [] }, ELSEWHERE);
      const department = await as((tx) => assignment.suggest(tx, { facts: { project_group: 'B' }, unitId: unitId(DEPARTMENT), asOf: TODAY }));
      expect(department.suggestion).toMatchObject({ templateCode: 'STEPPED', basis: 'RULE', line: 'GROUP_B' });
      expect(department.rule).toMatchObject({ version: 1, unitId: unitId(DEPARTMENT), unverified: false });
      expect((await as((tx) => assignment.suggest(tx, { facts: { project_group: 'C' }, unitId: unitId(DEPARTMENT), asOf: TODAY }))).suggestion).toMatchObject({ templateCode: 'LEGACY', basis: 'DEFAULT' });
      expect((await as((tx) => assignment.suggest(tx, { facts: { project_group: 'B' }, unitId: unitId(PROVINCE), asOf: TODAY }))).suggestion).toMatchObject({ templateCode: 'PUBLIC_INVESTMENT', basis: 'DEFAULT' });
      expect((await as((tx) => assignment.suggest(tx, { facts: { project_group: 'B' }, unitId: unitId(ELSEWHERE), asOf: TODAY }))).suggestion).toMatchObject({ templateCode: null, basis: 'NONE' });
      expect(await refusal(as((tx) => assignment.suggest(tx, { facts: { project_group: 'B; drop' }, asOf: TODAY })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'facts.project_group' });
      expect(await refusal(as((tx) => assignment.suggest(tx, { facts: {}, unitId: randomUUID(), asOf: TODAY })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'owner_unit_id' });
    });

    it('starts the workflow the rule names when no template is chosen, and writes what was suggested and chosen', async () => {
      const p = await project({ group: 'B' });
      const done = await start(p.id, { templateCode: undefined });
      expect(done).toMatchObject({ templateCode: 'STEPPED', status: 'ACTIVE' });
      expect(done.selection).toMatchObject({ mode: 'AUTO', chosen_template_code: 'STEPPED', suggested_template_code: 'STEPPED', basis: 'RULE', line: 'GROUP_B', rule_version: 1, rule_unit_id: unitId(DEPARTMENT), reason: null });
      const [row] = await owner<{ selection: Record<string, unknown> }>('select selection from machvon.project_workflow where id = $1::uuid', [done.id]);
      expect(row?.selection).toEqual(done.selection);
      const [log] = await owner<{ subject: { selection?: Record<string, unknown> } }>(`select subject from machvon.project_task_log where workflow_id = $1::uuid and kind = 'WORKFLOW_STARTED'`, [done.id]);
      expect(log?.subject.selection).toMatchObject({ mode: 'AUTO', chosen_template_code: 'STEPPED' });
    });

    it('records a choice that agrees with the rule as confirmed, and one against it as an override with its reason', async () => {
      const confirmed = await start((await project({ group: 'B' })).id, { reasonRequired: true });
      expect(confirmed.selection).toMatchObject({ mode: 'CONFIRMED', reason: null });
      const p = await project({ group: 'B' });
      expect(await refusal(start(p.id, { templateCode: 'LEGACY', reasonRequired: true }))).toMatchObject({ code: 'PWF_SELECTION_REASON_REQUIRED', status: 422, detail: 'selection_reason', extensions: { suggested_template_code: 'STEPPED' } });
      expect(await refusal(start(p.id, { templateCode: 'LEGACY', reasonRequired: true, selectionReason: 'short' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'selection_reason' });
      expect((await owner('select 1 from machvon.project_workflow where project_id = $1::uuid', [p.id])).length).toBe(0);
      const overridden = await start(p.id, { templateCode: 'LEGACY', reasonRequired: true, selectionReason: '  The project follows the old procedure by decision  ' });
      expect(overridden.selection).toMatchObject({ mode: 'OVERRIDE', chosen_template_code: 'LEGACY', suggested_template_code: 'STEPPED', reason: 'The project follows the old procedure by decision' });
      const [log] = await owner<{ reason: string | null }>(`select reason from machvon.project_task_log where workflow_id = $1::uuid and kind = 'WORKFLOW_STARTED'`, [overridden.id]);
      expect(log?.reason).toBe('The project follows the old procedure by decision');
      // The command that was there before the rule still takes a template without a reason, and records that it went against the rule.
      const older = await start((await project({ group: 'B' })).id, { templateCode: 'LEGACY' });
      expect(older.selection).toMatchObject({ mode: 'OVERRIDE', reason: null });
    });

    it('never guesses: with no template chosen and none suggested it is 422 PWF_TEMPLATE_NOT_ASSIGNED, and a template chosen by hand is recorded as manual', async () => {
      const p = await project({ group: 'B', unit: ELSEWHERE });
      expect(await refusal(start(p.id, { templateCode: undefined }))).toMatchObject({ code: 'PWF_TEMPLATE_NOT_ASSIGNED', status: 422, detail: 'template_code' });
      expect((await start(p.id, { templateCode: 'STEPPED', reasonRequired: true })).selection).toMatchObject({ mode: 'MANUAL', suggested_template_code: null, basis: 'NONE' });
    });

    it('adopts a running project by the same rule, and says in the dry run which template it would take', async () => {
      const p = await project({ group: 'B' });
      const dry = await as((tx) => workflows.adopt(tx, { projectId: p.id, plannedStartDate: START, effectiveDate: START, dryRun: true, actor: memberId(MANAGER), scopes, now: now() }));
      expect(dry).toMatchObject({ dryRun: true, templateCode: 'STEPPED', selection: { mode: 'AUTO', line: 'GROUP_B' } });
      const applied = await as((tx) => workflows.adopt(tx, { projectId: p.id, plannedStartDate: START, effectiveDate: START, dryRun: false, actor: memberId(MANAGER), scopes, now: now() }));
      expect(applied.workflow?.selection).toMatchObject({ mode: 'AUTO', chosen_template_code: 'STEPPED' });
    });
  });

  describe('phase -> step -> task -> checklist (R44)', () => {
    it('AC-ST-PWF-021-1: shows the steps of each phase with the progress of their tasks and checklists and their standard time, and the step of every task', async () => {
      const p = await project();
      const done = await start(p.id);
      const view = await detail(p.id);
      const steps = view.steps as Array<Record<string, unknown>>;
      expect(steps.map((step) => [step.phase_code, step.code, step.order, step.implicit, step.status, step.standard_working_days, step.task_total, step.checklist_total])).toEqual([
        ['P1', 'S_PREPARE', 1, false, 'NOT_STARTED', 4, 2, 2],
        ['P1', 'S_REVIEW', 2, false, 'NOT_STARTED', 2, 1, 0],
        ['P2', 'S_CLOSE', 1, false, 'NOT_STARTED', 2, 1, 0],
      ]);
      expect(steps[0]).toMatchObject({ responsible_role: 'LEAD_ROLE', planned_start: START, required_total: 2, required_done: 0, checklist_done: 0 });
      expect(view.standard_working_days).toBe(8);
      const items = view.tasks as Array<Record<string, unknown>>;
      expect(items.map((item) => [item.task_code, item.step_code, item.checklist_total, item.checklist_done])).toEqual([['TA', 'S_PREPARE', 2, 0], ['TB', 'S_PREPARE', 0, 0], ['TC', 'S_REVIEW', 0, 0], ['TD', 'S_CLOSE', 0, 0]]);
      // One item of the checklist of TA done: the step is under way and counts it.
      const taskId = await working(done.id, 'TA');
      const current = await taskOf(done.id, 'TA');
      await as((tx) => tasks.completeChecklistItem(tx, { taskId, expectedVersion: Number(current.version), actor: memberId(WORKER), scopes, today: TODAY, itemCode: 'NOTE' }), WORKER);
      const after = ((await detail(p.id)).steps as Array<Record<string, unknown>>)[0];
      expect(after).toMatchObject({ status: 'IN_PROGRESS', checklist_total: 2, checklist_done: 1, task_done: 0 });
      const task = await taskDetail(taskId);
      expect(task.step).toEqual({ code: 'S_PREPARE', name: 'Prepare', phase_code: 'P1', order: 1, implicit: false, responsible_role: 'LEAD_ROLE' });
    });

    it('AC-ST-PWF-021-3: still refuses the completion of a task while a required item of its checklist is open, and not for an optional one', async () => {
      const p = await project();
      const done = await start(p.id);
      const taskId = await working(done.id, 'TA');
      const blocked = (await taskDetail(taskId)).completion as { ok: boolean; blockers: Array<{ code: string; subject: string }> };
      expect(blocked.ok).toBe(false);
      expect(blocked.blockers.map((one) => `${one.code}:${one.subject}`)).toEqual(['CHECKLIST_ITEM_OPEN:DOSSIER', 'FORM_MISSING:FORM_LATEST', 'FORM_MISSING:FORM_PINNED']);
      const t = await taskOf(done.id, 'TA');
      expect(await refusal(as((tx) => tasks.complete(tx, { taskId, expectedVersion: Number(t.version), actor: memberId(WORKER), scopes, today: TODAY }), WORKER))).toMatchObject({ code: 'PWF_TASK_COMPLETION_BLOCKED', status: 422 });
    });

    it('AC-ST-PWF-021-2: gives a workflow of a template without steps one step per phase, and keeps the hash it froze', async () => {
      const p = await project();
      const done = await start(p.id, { templateCode: 'LEGACY' });
      expect(done.templateHash).toBe(pwfWorkflow.templateHash(pwfWorkflow.parseProjectWorkflowTemplate(LEGACY)));
      const [row] = await owner<{ template: Record<string, unknown>; template_hash: string }>('select template, template_hash from machvon.project_workflow where id = $1::uuid', [done.id]);
      expect(Object.keys(row?.template ?? {}).sort()).toEqual(['name', 'phases', 'tasks']);
      expect(pwfWorkflow.templateHash(pwfWorkflow.parseProjectWorkflowTemplate(row?.template))).toBe(row?.template_hash);
      const view = await detail(p.id);
      expect((view.steps as Array<Record<string, unknown>>).map((step) => [step.code, step.name, step.implicit, step.task_total])).toEqual([['P1', 'Phase one', true, 1], ['P2', 'Phase two', true, 1]]);
      expect((view.tasks as Array<Record<string, unknown>>).map((item) => item.step_code)).toEqual(['P1', 'P2']);
      expect(view.lapsed_legal_documents).toEqual([]);
    });
  });

  describe('the legal grounds of a step and of a task (R45)', () => {
    it('AC-ST-PWF-022-1: shows each ground with the document of the catalogue it cites, and tells when a document is replaced after the project froze its template', async () => {
      const p = await project();
      const done = await start(p.id);
      const first = ((await detail(p.id)).steps as Array<{ legal_basis: Array<Record<string, unknown>> }>)[0];
      expect(first?.legal_basis).toEqual([
        expect.objectContaining({ document_code: 'LAW_58_2024_QH15', number: '58/2024/QH15', doc_kind: 'LAW', article: null, verification: 'UNVERIFIED', document_verification: 'UNVERIFIED', state: 'IN_FORCE' }),
        expect.objectContaining({ document_code: 'TEST_DECREE_OLD', number: '1/2020/ND-CP', article: 'Article 9', document_verification: 'VERIFIED', state: 'IN_FORCE', superseded_by: null }),
      ]);
      const ta = await taskOf(done.id, 'TA');
      const task = await taskDetail(ta.id as string);
      expect(task.legal_basis).toEqual([expect.objectContaining({ document_code: 'DECREE_85_2025_ND_CP', article: 'Article 22', state: 'IN_FORCE' })]);
      expect((task.step_legal_basis as unknown[]).length).toBe(2);
      expect((await detail(p.id)).lapsed_legal_documents).toEqual([]);
      // The catalogue learns that the decree was replaced: one approved version of the rule, and the running project says so without being touched.
      await approveRule('LEGAL_DOCUMENT', 'TEST_DECREE_NEW', { doc_kind: 'DECREE', number: '2/2026/ND-CP', title: 'A new decree', issuer: 'Government', effective_from: '2026-01-01', verification: 'VERIFIED' });
      await owner(`update machvon.governance_rule set effective_to = $2::date where tenant_id = $1 and rule_type = 'LEGAL_DOCUMENT' and code = 'TEST_DECREE_OLD' and version = 1`, [TENANT_A, TODAY]);
      await approveRule('LEGAL_DOCUMENT', 'TEST_DECREE_OLD', { doc_kind: 'DECREE', number: '1/2020/ND-CP', title: 'An old decree', issuer: 'Government', effective_from: '2020-01-01', effective_to: '2026-01-01', superseded_by: 'TEST_DECREE_NEW', verification: 'VERIFIED' }, null, 2, TODAY);
      const view = await detail(p.id);
      expect(view.lapsed_legal_documents).toEqual(['TEST_DECREE_OLD']);
      expect((view.steps as Array<{ legal_basis: Array<Record<string, unknown>> }>)[0]?.legal_basis[1]).toMatchObject({ state: 'SUPERSEDED', superseded_by: 'TEST_DECREE_NEW', effective_to: '2026-01-01' });
      const [frozen] = await owner<{ template_hash: string }>('select template_hash from machvon.project_workflow where id = $1::uuid', [done.id]);
      expect(frozen?.template_hash).toBe(done.templateHash);
    });

    it('AC-ST-PWF-022-2: tells the alert centre once per workflow and document that a legal ground lapsed, to whoever reads the project, and nothing while every document is in force', async () => {
      const input = (over: Partial<WorkInput> = {}): WorkInput => ({ membershipId: memberId(MANAGER), now: now(), today: TODAY, unitScope: everything, projectScope: everything, mode: 'rows', view: 'scope', ...over });
      const lapsed = async (over: Partial<WorkInput> = {}) => (await as((tx) => work.collect(tx, input(over)))).rows.filter((row) => row.kind === 'PWF_LEGAL_BASIS_LAPSED');
      // The test before this one replaced TEST_DECREE_OLD: every running workflow of the stepped template cites it on its first step.
      const p = await project();
      const done = await start(p.id);
      const rows = await lapsed();
      const mine = rows.filter((row) => row.id.startsWith(done.id));
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ id: `${done.id}:TEST_DECREE_OLD`, source: 'PROJECT_TASK', severity: 'WATCH', status: 'AT_RISK', target: { screen: 'PWF-03', id: p.id }, dueOn: '2026-01-01' });
      expect(mine[0]?.title).toContain('1/2020/ND-CP');
      expect(mine[0]?.title).toContain(p.code);
      expect(mine[0]?.subtitle).toContain('2/2026/ND-CP');
      expect(mine[0]?.consequence).toBeTruthy();
      // One item per workflow and document, whatever the number of steps and tasks that cite it; a workflow that cites nothing lapsed has none.
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
      // The codes the frozen template cites are kept with the workflow, so the alert reads an index and not the JSON of every workflow.
      expect((await owner<{ cited_legal_documents: string[] | null }>('select cited_legal_documents from machvon.project_workflow where id = $1::uuid', [done.id]))[0]?.cited_legal_documents).toEqual(['LAW_58_2024_QH15', 'TEST_DECREE_OLD', 'DECREE_85_2025_ND_CP']);
      const legacy = await start((await project()).id, { templateCode: 'LEGACY' });
      expect((await lapsed()).some((row) => row.id.startsWith(legacy.id))).toBe(false);
      expect((await owner<{ cited_legal_documents: string[] | null }>('select cited_legal_documents from machvon.project_workflow where id = $1::uuid', [legacy.id]))[0]?.cited_legal_documents).toEqual([]);
      // Out of the scope of the reader there is nothing.
      expect(await lapsed({ projectScope: () => ({ sql: 'false', params: [] }), unitScope: () => ({ sql: 'false', params: [] }) })).toEqual([]);
      // A workflow that is no longer running is not told.
      await owner(`update machvon.project_workflow set status = 'CANCELLED' where id = $1::uuid`, [done.id]);
      expect((await lapsed()).some((row) => row.id.startsWith(done.id))).toBe(false);
    });

    it('shows a ground whose document the catalogue does not have as unknown, never as in force', async () => {
      await approveRule('PROJECT_WORKFLOW_TEMPLATE', 'ORPHAN', { ...LEGACY, steps: [{ code: 'S_ONE', name: 'One', phase: 'P1', legal_basis: [cite('NO_SUCH_DOCUMENT')] }, { code: 'S_TWO', name: 'Two', phase: 'P2' }], tasks: [one('TA', 'P1', 'S_ONE'), one('TB', 'P2', 'S_TWO', { predecessors: [fs('TA')] })] });
      const p = await project();
      await start(p.id, { templateCode: 'ORPHAN' });
      expect(((await detail(p.id)).steps as Array<{ legal_basis: Array<Record<string, unknown>> }>)[0]?.legal_basis[0]).toMatchObject({ document_code: 'NO_SUCH_DOCUMENT', state: 'UNKNOWN', number: null, title: null });
    });
  });

  describe('the revision of a form (R46)', () => {
    it('AC-ST-PWF-023-1, AC-ST-PWF-023-2: records the newest approved revision and its hash with the evidence, and says when the form was revised since', async () => {
      const p = await project();
      const done = await start(p.id);
      const taskId = await working(done.id, 'TA');
      const before = ((await taskDetail(taskId)).form_templates as Array<Record<string, unknown>>).find((form) => form.code === 'FORM_LATEST');
      expect(before).toMatchObject({ policy: 'LATEST_APPROVED', pinned_revision: null, current_revision: 1, current_title: 'Form FORM_LATEST r1', used_revision: null, newer_available: false, satisfied: false });
      const attached = await attach(taskId, { evidenceKind: 'FORM', formTemplateCode: 'FORM_LATEST', documentId: await document() });
      const [row] = await owner<{ form_template_revision: number; form_template_sha256: string }>('select form_template_revision, form_template_sha256::text as form_template_sha256 from machvon.project_task_evidence where id = $1::uuid', [attached.evidenceId]);
      expect(row).toEqual({ form_template_revision: 1, form_template_sha256: 'a'.repeat(64) });
      const [log] = await owner<{ subject: Record<string, unknown> }>(`select subject from machvon.project_task_log where task_id = $1::uuid and kind = 'EVIDENCE_ATTACHED'`, [taskId]);
      expect(log?.subject).toMatchObject({ form_template_code: 'FORM_LATEST', form_template_revision: 1, form_template_sha256: 'a'.repeat(64) });
      // Revision 2 is published today: the evidence keeps revision 1 and the task says a newer one exists.
      await owner(`update machvon.document_template set status = 'SUPERSEDED', effective_until = $2::date where template_code = 'FORM_LATEST' and revision = 1 and tenant_id = $1`, [TENANT_A, TODAY]);
      await formRevision('FORM_LATEST', 2, 'PUBLISHED', TODAY, null);
      const task = await taskDetail(taskId);
      expect((task.form_templates as Array<Record<string, unknown>>).find((form) => form.code === 'FORM_LATEST')).toMatchObject({ current_revision: 2, used_revision: 1, used_sha256: 'a'.repeat(64), newer_available: true, satisfied: true });
      expect((task.evidence as Array<Record<string, unknown>>)[0]).toMatchObject({ form_template_code: 'FORM_LATEST', form_template_revision: 1, form_template_sha256: 'a'.repeat(64) });
      // A form made now is made from revision 2.
      const again = await attach(taskId, { evidenceKind: 'FORM', formTemplateCode: 'FORM_LATEST', externalRef: 'Second copy' });
      expect((await owner<{ form_template_revision: number }>('select form_template_revision from machvon.project_task_evidence where id = $1::uuid', [again.evidenceId]))[0]?.form_template_revision).toBe(2);
      expect(((await taskDetail(taskId)).form_templates as Array<Record<string, unknown>>).find((form) => form.code === 'FORM_LATEST')).toMatchObject({ used_revision: 2, newer_available: false });
    });

    it('AC-ST-PWF-023-3: keeps a pinned form on its revision whatever is published later, and refuses a pin that names no approved revision', async () => {
      await owner(`update machvon.document_template set status = 'SUPERSEDED', effective_until = $2::date where template_code = 'FORM_PINNED' and revision = 1 and tenant_id = $1`, [TENANT_A, TODAY]);
      await formRevision('FORM_PINNED', 2, 'PUBLISHED', TODAY, null);
      const p = await project();
      const done = await start(p.id);
      const taskId = await working(done.id, 'TA');
      const attached = await attach(taskId, { evidenceKind: 'FORM', formTemplateCode: 'FORM_PINNED', externalRef: 'Pinned copy' });
      expect((await owner<{ form_template_revision: number }>('select form_template_revision from machvon.project_task_evidence where id = $1::uuid', [attached.evidenceId]))[0]?.form_template_revision).toBe(1);
      expect(((await taskDetail(taskId)).form_templates as Array<Record<string, unknown>>).find((form) => form.code === 'FORM_PINNED')).toMatchObject({ policy: 'PINNED', pinned_revision: 1, current_revision: 2, used_revision: 1, newer_available: false });
      const pinned = { ...STEPPED, tasks: [{ ...STEPPED.tasks[0], form_policies: [{ form: 'FORM_PINNED', policy: 'PINNED', revision: 7 }] }, ...STEPPED.tasks.slice(1)] };
      await approveRule('PROJECT_WORKFLOW_TEMPLATE', 'PINNED_GONE', pinned);
      const other = await start((await project()).id, { templateCode: 'PINNED_GONE' });
      const otherTask = await working(other.id, 'TA');
      expect(await refusal(attach(otherTask, { evidenceKind: 'FORM', formTemplateCode: 'FORM_PINNED', externalRef: 'No such revision' }))).toMatchObject({ code: 'PWF_FORM_REVISION_UNAVAILABLE', status: 422, extensions: { form_template_code: 'FORM_PINNED', pinned_revision: 7 } });
    });

    it('records no revision for a form the document store has no approved revision of, as evidence always was', async () => {
      await approveRule('PROJECT_WORKFLOW_TEMPLATE', 'LOOSE_FORM', { ...LEGACY, tasks: [one('TA', 'P1', undefined, { form_templates: ['FORM_NOWHERE'] }), one('TB', 'P2', undefined, { predecessors: [fs('TA')] })] });
      const done = await start((await project()).id, { templateCode: 'LOOSE_FORM' });
      const taskId = await working(done.id, 'TA');
      const attached = await attach(taskId, { evidenceKind: 'FORM', formTemplateCode: 'FORM_NOWHERE', externalRef: 'A paper form' });
      expect((await owner<{ form_template_revision: number | null; form_template_sha256: string | null }>('select form_template_revision, form_template_sha256 from machvon.project_task_evidence where id = $1::uuid', [attached.evidenceId]))[0]).toEqual({ form_template_revision: null, form_template_sha256: null });
      expect(((await taskDetail(taskId)).form_templates as Array<Record<string, unknown>>)[0]).toMatchObject({ code: 'FORM_NOWHERE', satisfied: true, current_revision: null, used_revision: null, newer_available: false });
    });

    it('refuses in the database a revision without a form or a hash that is not one', async () => {
      const done = await start((await project()).id);
      const ta = await taskOf(done.id, 'TA');
      const insert = (code: string | null, revision: number | null, sha: string | null) =>
        owner(`insert into machvon.project_task_evidence (tenant_id, id, task_id, evidence_kind, external_ref, form_template_code, form_template_revision, form_template_sha256, attached_by) values ($1, gen_random_uuid(), $2, 'FORM', 'x', $3, $4, $5, $6)`, [TENANT_A, ta.id, code, revision, sha, memberId(WORKER)]);
      await expect(insert(null, 1, 'a'.repeat(64))).rejects.toMatchObject({ code: '23514' });
      await expect(insert('FORM_LATEST', 1, 'not-a-hash')).rejects.toMatchObject({ code: '23514' });
      await expect(insert('FORM_LATEST', 1, null)).rejects.toMatchObject({ code: '23514' });
      await expect(insert('FORM_LATEST', 2, 'b'.repeat(64))).resolves.toBeDefined();
    });
  });
});

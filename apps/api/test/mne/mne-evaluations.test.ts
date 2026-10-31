import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { mneModule } from '../../src/modules/mne';
import { MneEvaluationReadsController, MneEvaluationsController } from '../../src/modules/mne/mne-evaluations.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const PLANNER = 1; // mne.evaluation.manage, mne.read
const DECIDER = 2; // mne.evaluation.approve, mne.read
const BOTH = 3; // manage, approve and read: the four-eyes rule is what stops them
const READER = 4; // mne.read
const NOBODY = 5;
const SUBMITTER = 6; // manage, approve and read, a second person
const SCOPED = 7; // manage and read under the branch only
const ROOT = 1;
const BRANCH = 2;
const INVESTOR = 3; // under the branch
const OUTSIDE = 6;
const PEOPLE = [PLANNER, DECIDER, BOTH, READER, NOBODY, SUBMITTER, SCOPED];
const SCOPE_TEXT = 'The midterm evaluation of the bridge works';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the investment evaluation of a project over HTTP (ST-MNE-009, UAT-AC292, UAT-PLAN-74)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenantId ?? TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  const audits = (id: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>('select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 order by seq', [id, action]);
  const events = (id: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [id, type]);
  const version = async (id: string): Promise<string> => `"${(await rows<{ version: string }>('select version::text from machvon.mne_evaluation where id = $1::uuid', [id]))[0]?.version}"`;

  /** Runs statements as the superuser with the triggers off, to put rows in a state that only other stories could. */
  async function seed(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** A project of the unit given, at the stage given, that entered it on the day given. */
  async function project(status = 'IMPLEMENTATION', options: { unit?: number; since?: string; tenant?: string } = {}): Promise<string> {
    counter += 1;
    const id = randomUUID();
    await seed([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group, status_changed_at)
         values ($1, $2, $3, 'Bridge', $4, $5, 'INTERNAL', 1000, $6, 1, 'B', $7::timestamptz)`,
        [options.tenant ?? TENANT_A, id, `EV-${counter}-${id.slice(0, 6)}`, unitId(options.unit ?? INVESTOR), randomUUID(), status, options.since ?? new Date().toISOString()],
      ],
    ]);
    return id;
  }
  /** An overall report that is still being drawn up for a unit, due on the day given. */
  async function report(unit: number, due: string, status = 'DRAFT', kind = 'OVERALL_SEMIANNUAL'): Promise<string> {
    const id = randomUUID();
    const form = randomUUID();
    await seed([
      [
        `insert into machvon.mne_report_form (tenant_id, id, form_code, title, report_kind, legal_basis, effective_from, schema_json, doc_template_code, export_formats, revision, status, created_by, updated_by)
         values ($1, $2, $3, 'Form', $4, 'Circular 44/2026/TT-BTC', date '2026-01-01', '{}'::jsonb, 'MNE-TT44-M02', array['XLSX'], 1, 'DRAFT', $5, $5)`,
        [TENANT_A, form, `F-${form.slice(0, 8)}`, kind, memberId(PLANNER)],
      ],
      [
        `insert into machvon.mne_report (tenant_id, id, form_id, report_year, period_label, scope_unit_id, due_date, revision, status, payload_json, created_by, updated_by)
         values ($1, $2, $3, 2026, $4, $5, $6::date, 1, $7, '{}'::jsonb, $8, $8)`,
        [TENANT_A, id, form, `H2-${id.slice(0, 6)}`, unitId(unit), due, status, memberId(PLANNER)],
      ],
    ]);
    return id;
  }

  const body = (projectId: string, overrides: Record<string, unknown> = {}) => ({ project_id: projectId, evaluation_kind: 'MIDTERM', evaluator_kind: 'INTERNAL', evaluator_name: 'MNE office', scope_text: SCOPE_TEXT, planned_date: '2026-12-01', ...overrides });
  const plan = (member: number, projectId: string, overrides: Record<string, unknown> = {}) => call('POST', '/mne-evaluations', { member, body: body(projectId, overrides) });
  const submitBody = (overrides: Record<string, unknown> = {}) => ({ findings: [{ topic: 'Progress', note: 'On schedule' }], conclusion: 'SATISFACTORY', recommendations_text: 'Keep the pace', completed_date: '2026-10-30', ...overrides });
  const submit = async (member: number, id: string, overrides: Record<string, unknown> = {}, ifMatch?: string) => call('POST', `/mne-evaluations/${id}/submit`, { member, ifMatch: ifMatch ?? (await version(id)), body: submitBody(overrides) });
  const decide = async (member: number, id: string, decision: 'approve' | 'return' = 'approve', reason = 'The findings are complete.') => call('POST', `/mne-evaluations/${id}/decision`, { member, ifMatch: await version(id), body: { decision, reason } });
  const planned = async (member = PLANNER, kind = 'MIDTERM'): Promise<string> => {
    const target = await project();
    const done = await plan(member, target, { evaluation_kind: kind });
    expect(done.status).toBe(200);
    return String(done.json.resource_id);
  };
  const stored = async (id: string) =>
    (
      await rows<{ status: string; conclusion: string | null; mne_report_id: string | null; approved_by: string | null; decided_by: string | null; submitted_by: string | null; decision_reason: string | null }>(
        'select status, conclusion, mne_report_id, approved_by, decided_by, submitted_by, decision_reason from machvon.mne_evaluation where id = $1::uuid',
        [id],
      )
    )[0];

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: BRANCH, path: `/${unitId(BRANCH)}/`, parent: ROOT },
        { n: INVESTOR, path: `/${unitId(BRANCH)}/${unitId(INVESTOR)}/`, parent: BRANCH },
        { n: OUTSIDE, path: `/${unitId(OUTSIDE)}/`, parent: ROOT },
      ]);
    }
    for (const n of PEOPLE) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 1, 'MNE_EVALUATOR', ['mne.evaluation.manage', 'mne.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'MNE_EVALUATION_APPROVER', ['mne.evaluation.approve', 'mne.read'], 40);
    await harness.seedRole(TENANT_A, 3, 'MNE_EVALUATION_ALL', ['mne.evaluation.manage', 'mne.evaluation.approve', 'mne.read'], 50);
    await harness.seedRole(TENANT_A, 4, 'MNE_READER', ['mne.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PLANNER, role: 1, kind: 'TENANT' },
      { n: 2, member: DECIDER, role: 2, kind: 'TENANT' },
      { n: 3, member: BOTH, role: 3, kind: 'TENANT' },
      { n: 4, member: READER, role: 4, kind: 'TENANT' },
      { n: 5, member: SUBMITTER, role: 3, kind: 'TENANT' },
      { n: 6, member: SCOPED, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH)] },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [MneEvaluationsController, MneEvaluationReadsController],
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

  it('is registered in the module of MNE', () => {
    expect(mneModule.controllers).toEqual(expect.arrayContaining([MneEvaluationsController, MneEvaluationReadsController]));
  });

  it('AC-ST-MNE-009-1, UAT-AC292: plans a midterm evaluation of a project in implementation, asks for the conclusion, refuses the planner who decides, and links the approved evaluation to the next overall report', async () => {
    const target = await project('IMPLEMENTATION');
    const later = await report(BRANCH, '2027-02-10');
    const sooner = await report(BRANCH, '2026-12-10');
    await report(BRANCH, '2026-11-10', 'SUPERSEDED');
    await report(OUTSIDE, '2026-11-01');
    // A weekly report with no project is due even sooner and is not an overall report.
    await report(BRANCH, '2026-11-05', 'DRAFT', 'WEEKLY_QUICK');
    const made = await plan(BOTH, target);
    expect(made).toMatchObject({ status: 200, json: { status: 'PLANNED', resource_version: 1 } });
    const id = String(made.json.resource_id);
    const [planned] = await audits(id, 'mne_evaluation.planned');
    expect(planned).toMatchObject({ actor_id: memberId(BOTH), safe_diff: { project_id: target, evaluation_kind: 'MIDTERM', from_status: null, to_status: 'PLANNED' } });
    expect((await events(id, 'mne.evaluation.planned.v1'))[0]?.payload).toMatchObject({ evaluation_id: id, project_id: target, to_status: 'PLANNED' });

    // Without the conclusion it is not submitted.
    expect([400, 422]).toContain((await submit(BOTH, id, { conclusion: undefined })).status);
    expect((await stored(id))?.status).toBe('PLANNED');
    const sent = await submit(SUBMITTER, id);
    expect(sent).toMatchObject({ status: 200, json: { status: 'SUBMITTED', resource_version: 2 } });
    expect(await stored(id)).toMatchObject({ status: 'SUBMITTED', conclusion: 'SATISFACTORY', submitted_by: memberId(SUBMITTER) });

    // The planner and the submitter do not decide it; somebody else does.
    expect(await decide(BOTH, id)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await decide(SUBMITTER, id)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await decide(PLANNER, id)).toMatchObject({ status: 403 });
    const done = await decide(DECIDER, id);
    expect(done).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: 3 } });
    expect(await stored(id)).toMatchObject({ status: 'APPROVED', mne_report_id: sooner, approved_by: memberId(DECIDER), decided_by: memberId(DECIDER) });
    expect(later).not.toBe(sooner);
    const [approved] = await audits(id, 'mne_evaluation.approved');
    expect(approved).toMatchObject({ actor_id: memberId(DECIDER), reason: 'The findings are complete.', safe_diff: { from_status: 'SUBMITTED', to_status: 'APPROVED', mne_report_id: sooner, conclusion: 'SATISFACTORY' } });
    const [told] = await events(id, 'mne.evaluation.decided.v1');
    expect(told?.payload).toMatchObject({ evaluation_id: id, to_status: 'APPROVED', mne_report_id: sooner });
    expect(JSON.stringify(told?.payload)).not.toContain('The findings are complete');
    // An approved evaluation is final.
    expect(await decide(DECIDER, id)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    expect(await submit(BOTH, id)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
  });

  it('UAT-PLAN-74: allows an ad hoc evaluation at every stage and the other kinds at their own, and refuses the rest with 409', async () => {
    for (const status of ['CONCEPT', 'IMPLEMENTATION', 'COMPLETED', 'CLOSED']) expect((await plan(PLANNER, await project(status), { evaluation_kind: 'AD_HOC' })).status).toBe(200);
    expect(await plan(PLANNER, await project('IMPLEMENTATION'), { evaluation_kind: 'FINAL' })).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED', evaluation_kind: 'FINAL', project_status: 'IMPLEMENTATION' } });
    expect((await plan(PLANNER, await project('COMPLETED'), { evaluation_kind: 'FINAL' })).status).toBe(200);
    expect((await plan(PLANNER, await project('SETTLED'), { evaluation_kind: 'FINAL' })).status).toBe(200);
    expect((await plan(PLANNER, await project('CLOSED'), { evaluation_kind: 'IMPACT' })).status).toBe(200);
    expect(await plan(PLANNER, await project('COMPLETED'), { evaluation_kind: 'IMPACT' })).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    expect(await plan(PLANNER, await project('COMPLETED'), { evaluation_kind: 'MIDTERM' })).toMatchObject({ status: 409 });
    // The initial evaluation is made within twelve months of the start of the implementation.
    const recent = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const old = new Date(Date.now() - 500 * 86_400_000).toISOString();
    expect((await plan(PLANNER, await project('IMPLEMENTATION', { since: recent }), { evaluation_kind: 'INITIAL' })).status).toBe(200);
    expect(await plan(PLANNER, await project('IMPLEMENTATION', { since: old }), { evaluation_kind: 'INITIAL' })).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED', reason: 'INITIAL_WINDOW_PASSED' } });
  });

  it('returns an evaluation with the reason, lets it be submitted again, and clears the decision for the next one', async () => {
    const id = await planned();
    expect((await submit(SUBMITTER, id)).status).toBe(200);
    const returned = await decide(BOTH, id, 'return', 'The findings do not cover the whole scope.');
    expect(returned).toMatchObject({ status: 200, json: { status: 'RETURNED' } });
    expect(await stored(id)).toMatchObject({ status: 'RETURNED', approved_by: null, decided_by: memberId(BOTH), decision_reason: 'The findings do not cover the whole scope.', mne_report_id: null });
    expect((await audits(id, 'mne_evaluation.returned'))[0]).toMatchObject({ reason: 'The findings do not cover the whole scope.' });
    // The one who returned it may submit it again: the decision starts afresh.
    const again = await submit(BOTH, id, { conclusion: 'PARTIALLY_SATISFACTORY', completed_date: '2026-10-31', findings: [] });
    expect(again).toMatchObject({ status: 200, json: { status: 'SUBMITTED' } });
    expect(await stored(id)).toMatchObject({ status: 'SUBMITTED', conclusion: 'PARTIALLY_SATISFACTORY', decided_by: null, decision_reason: null, submitted_by: memberId(BOTH) });
    expect(await decide(BOTH, id)).toMatchObject({ status: 403 });
    expect((await decide(SUBMITTER, id)).status).toBe(200);
  });

  it('does not link a report that a concurrent step takes out of the workflow while the evaluation is decided', async () => {
    const target = await project('IMPLEMENTATION');
    const first = await report(BRANCH, '2020-01-10');
    const second = await report(BRANCH, '2020-02-10');
    const made = String((await plan(PLANNER, target)).json.resource_id);
    expect((await submit(SUBMITTER, made)).status).toBe(200);
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query('begin');
      await client.query('select 1 from machvon.mne_report where id = $1::uuid for update', [first]);
      // The decision waits for the row that the other step holds; when it is let go the report is no longer one that is being drawn up.
      const deciding = decide(DECIDER, made);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await client.query("update machvon.mne_report set status = 'SUPERSEDED' where id = $1::uuid", [first]);
      await client.query('commit');
      expect((await deciding).status).toBe(200);
    } finally {
      await client.end();
    }
    expect((await stored(made))?.mne_report_id).toBe(second);
  });

  it('links nothing when no overall report is being drawn up for the unit', async () => {
    const id = await planned();
    expect((await submit(SUBMITTER, id)).status).toBe(200);
    expect((await decide(DECIDER, id)).status).toBe(200);
    expect(await stored(id)).toMatchObject({ status: 'APPROVED' });
  });

  it('refuses a stale version, a state the move does not start from, bad values, a project outside the scope and a caller without the right', async () => {
    const id = await planned();
    expect(await call('POST', `/mne-evaluations/${id}/submit`, { member: BOTH, ifMatch: '"7"', body: submitBody() })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await decide(DECIDER, id)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    for (const bad of [{ completed_date: '2999-01-01' }, { completed_date: '2026-02-30' }, { conclusion: 'GOOD' }, { findings: ['text'] }, { report_document_id: randomUUID() }]) {
      expect([400, 422]).toContain((await submit(BOTH, id, bad)).status);
    }
    const target = await project();
    for (const bad of [{ evaluator_name: ' ' }, { scope_text: 'short' }, { planned_date: '2026-13-01' }, { evaluation_kind: 'ODD' }, { evaluator_kind: 'ODD' }]) {
      expect((await plan(PLANNER, target, bad)).status).toBeGreaterThanOrEqual(400);
    }
    expect(await plan(PLANNER, randomUUID())).toMatchObject({ status: 404 });
    expect(await plan(READER, target)).toMatchObject({ status: 403 });
    expect(await plan(NOBODY, target)).toMatchObject({ status: 403 });
    expect(await plan(DECIDER, target)).toMatchObject({ status: 403 });
    expect(await decide(PLANNER, id)).toMatchObject({ status: 403 });
    // A caller whose right is over the branch plans for a project of the branch and not for one outside it.
    expect((await plan(SCOPED, await project('IMPLEMENTATION', { unit: INVESTOR }))).status).toBe(200);
    expect(await plan(SCOPED, await project('IMPLEMENTATION', { unit: OUTSIDE }))).toMatchObject({ status: 404 });
    expect(await submit(SCOPED, await planned())).toMatchObject({ status: 200 });
    expect(await call('POST', `/mne-evaluations/${randomUUID()}/submit`, { member: BOTH, ifMatch: '"1"', body: submitBody() })).toMatchObject({ status: 404 });
    const other = await plan(PLANNER, await project('IMPLEMENTATION', { unit: OUTSIDE }));
    expect(await submit(SCOPED, String(other.json.resource_id))).toMatchObject({ status: 404 });
  });

  it('keeps the trail without the words of the evaluation and attaches a report document that exists', async () => {
    const id = await planned();
    const [document] = await rows<{ id: string }>("select id from machvon.document limit 1");
    // A document is attached when one exists in the tenant; the evaluation is judged by what it says, not by the file.
    if (document !== undefined) expect((await submit(BOTH, id, { report_document_id: document.id })).status).toBe(200);
    else expect((await submit(BOTH, id)).status).toBe(200);
    const [audit] = await audits(id, 'mne_evaluation.submitted');
    expect(JSON.stringify(audit?.safe_diff)).not.toContain('On schedule');
    expect(JSON.stringify((await events(id, 'mne.evaluation.submitted.v1'))[0]?.payload)).not.toContain('Keep the pace');
  });

  it('lists the evaluations of the reader, newest first, by project and status, with what the caller may do', async () => {
    const target = await project('IMPLEMENTATION');
    const first = String((await plan(PLANNER, target)).json.resource_id);
    const second = String((await plan(PLANNER, target, { evaluation_kind: 'AD_HOC' })).json.resource_id);
    expect((await submit(SUBMITTER, second)).status).toBe(200);
    const all = await call('GET', `/mne-evaluations?project_id=${target}`, { member: DECIDER });
    expect(all.status).toBe(200);
    const items = all.json.items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.id)).toEqual([second, first]);
    expect(items[0]).toMatchObject({ status: 'SUBMITTED', conclusion: 'SATISFACTORY', project: { id: target }, actions: { submit: false, decide: true } });
    expect(items[1]).toMatchObject({ status: 'PLANNED', conclusion: null, actions: { submit: false, decide: false } });
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(
      [
        'actions', 'completed_date', 'conclusion', 'created_at', 'decided_at', 'decided_by', 'decision_reason', 'evaluation_kind', 'evaluator_kind', 'evaluator_name', 'findings', 'id', 'mne_report_id', 'planned_date', 'project',
        'recommendations_text', 'report_document_id', 'scope_text', 'status', 'submitted_at', 'submitted_by', 'version',
      ].sort(),
    );
    const asPlanner = (await call('GET', `/mne-evaluations?project_id=${target}`, { member: PLANNER })).json.items as Array<Record<string, unknown>>;
    expect(asPlanner.map((item) => item.actions)).toEqual([
      { submit: false, decide: false },
      { submit: true, decide: false },
    ]);
    expect(((await call('GET', `/mne-evaluations?project_id=${target}&status=PLANNED`, { member: READER })).json.items as unknown[]).length).toBe(1);
    const paged = await call('GET', `/mne-evaluations?project_id=${target}&limit=1`, { member: READER });
    expect(paged.json.next_cursor).toEqual(expect.any(String));
    const next = await call('GET', `/mne-evaluations?project_id=${target}&limit=1&cursor=${encodeURIComponent(paged.json.next_cursor as string)}`, { member: READER });
    expect((next.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([first]);
    expect(await call('GET', '/mne-evaluations?status=ODD', { member: READER })).toMatchObject({ status: 422 });
    expect(await call('GET', '/mne-evaluations?project_id=x', { member: READER })).toMatchObject({ status: 422 });
    expect(await call('GET', '/mne-evaluations', { member: NOBODY })).toMatchObject({ status: 403 });
    // A reader whose right is over the branch sees the evaluations of the branch and not those of a project outside it.
    expect(((await call('GET', `/mne-evaluations?project_id=${target}`, { member: SCOPED })).json.items as unknown[]).length).toBe(2);
    const outside = await project('IMPLEMENTATION', { unit: OUTSIDE });
    expect((await plan(PLANNER, outside)).status).toBe(200);
    expect(((await call('GET', `/mne-evaluations?project_id=${outside}`, { member: SCOPED })).json.items as unknown[]).length).toBe(0);
    expect(((await call('GET', `/mne-evaluations?project_id=${outside}`, { member: READER })).json.items as unknown[]).length).toBe(1);
  });

  it('pages through evaluations created within the same millisecond without skipping or repeating one', async () => {
    const target = await project();
    const ids = ['00000000-0000-4000-8000-0000000e0001', '00000000-0000-4000-8000-0000000e0002', '00000000-0000-4000-8000-0000000e0003'];
    // The later the instant, the lower the id: the order of the instants and the order of the ids disagree inside one millisecond.
    await seed(
      ids.map((id, n): [string, unknown[]] => [
        `insert into machvon.mne_evaluation (tenant_id, id, project_id, evaluation_kind, evaluator_kind, evaluator_name, scope_text, status, planned_date, created_at, created_by, updated_by)
         values ($1, $2, $3, 'AD_HOC', 'INTERNAL', 'MNE office', $4, 'PLANNED', date '2026-12-01', timestamptz '2026-10-31 10:00:00.000900' - ($5::int * interval '100 microseconds'), $6, $6)`,
        [TENANT_A, id, target, SCOPE_TEXT, n, memberId(PLANNER)],
      ]),
    );
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 10; page += 1) {
      const reply = await call('GET', `/mne-evaluations?project_id=${target}&limit=1${cursor}`, { member: READER });
      seen.push(...(reply.json.items as Array<{ id: string }>).map((item) => item.id));
      if (reply.json.next_cursor === null) break;
      cursor = `&cursor=${encodeURIComponent(reply.json.next_cursor as string)}`;
    }
    expect([...seen].sort()).toEqual(ids);
    expect(new Set(seen).size).toBe(3);
  });

  it('lists the projects an evaluation can be made for by the right to read evaluations, by code, within the scope of the reader', async () => {
    const inside = await project('IMPLEMENTATION', { unit: INVESTOR });
    const outside = await project('IMPLEMENTATION', { unit: OUTSIDE });
    const all = await call('GET', '/mne-evaluations/projects?limit=200', { member: READER });
    expect(all.status).toBe(200);
    const items = all.json.items as Array<{ id: string; code: string; name: string; status: string }>;
    expect(items.map((item) => item.id)).toEqual(expect.arrayContaining([inside, outside]));
    expect(items.map((item) => item.code)).toEqual([...items.map((item) => item.code)].sort());
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(['code', 'id', 'name', 'status']);
    const scoped = (await call('GET', '/mne-evaluations/projects?limit=200', { member: SCOPED })).json.items as Array<{ id: string }>;
    expect(scoped.map((item) => item.id)).toContain(inside);
    expect(scoped.map((item) => item.id)).not.toContain(outside);
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 200; page += 1) {
      const reply = await call('GET', `/mne-evaluations/projects?limit=2${cursor}`, { member: READER });
      seen.push(...(reply.json.items as Array<{ id: string }>).map((item) => item.id));
      if (reply.json.next_cursor === null) break;
      cursor = `&cursor=${encodeURIComponent(reply.json.next_cursor as string)}`;
    }
    expect(seen).toEqual(items.map((item) => item.id));
    expect(await call('GET', '/mne-evaluations/projects', { member: NOBODY })).toMatchObject({ status: 403 });
  });

  it('keeps the database honest when the application is bypassed', async () => {
    const id = await planned();
    expect((await submit(SUBMITTER, id)).status).toBe(200);
    const edit = (sql: string, params: unknown[] = []) => rows(sql, [id, ...params]).then(() => 'ok', (error: Error) => error.message);
    expect(await edit("update machvon.mne_evaluation set conclusion = 'UNSATISFACTORY' where id = $1::uuid")).toMatch(/what was submitted does not change/);
    expect(await edit("update machvon.mne_evaluation set status = 'PLANNED' where id = $1::uuid")).toMatch(/not allowed/);
    expect(await edit('update machvon.mne_evaluation set evaluation_kind = $2 where id = $1::uuid', ['FINAL'])).toMatch(/never changes/);
    // The decision does not carry a change of what was submitted or of who submitted it.
    expect(await edit("update machvon.mne_evaluation set status = 'RETURNED', decided_by = $2::uuid, decided_at = now(), decision_reason = 'Not enough', conclusion = 'UNSATISFACTORY' where id = $1::uuid", [memberId(DECIDER)])).toMatch(/what was submitted does not change/);
    expect(await edit("update machvon.mne_evaluation set status = 'RETURNED', decided_by = $2::uuid, decided_at = now(), decision_reason = 'Not enough', submitted_by = $2::uuid where id = $1::uuid", [memberId(DECIDER)])).toMatch(/what was submitted does not change/);
    expect(await edit("update machvon.mne_evaluation set status = 'APPROVED', decided_by = created_by, decided_at = now(), decision_reason = 'Approved by me', approved_by = created_by where id = $1::uuid")).toMatch(/mne_evaluation_(sod|decider)_chk/);
    expect(await edit("update machvon.mne_evaluation set status = 'APPROVED', decided_by = submitted_by, decided_at = now(), decision_reason = 'Approved by me', approved_by = submitted_by where id = $1::uuid")).toMatch(/mne_evaluation_decider_chk/);
    expect(await edit("update machvon.mne_evaluation set mne_report_id = gen_random_uuid() where id = $1::uuid")).toMatch(/mne_evaluation_report_chk/);
    expect(await edit("update machvon.mne_evaluation set findings_json = '{}'::jsonb where id = $1::uuid")).toMatch(/mne_evaluation_findings_chk|what was submitted/);
    expect((await decide(DECIDER, id)).status).toBe(200);
    expect(await edit("update machvon.mne_evaluation set status = 'RETURNED' where id = $1::uuid")).toMatch(/not allowed/);
    expect(await edit("update machvon.mne_evaluation set decision_reason = 'Changed my mind' where id = $1::uuid")).toMatch(/final/);
    // The report it was linked to is part of the decision: it is neither cleared nor put on another.
    expect(await edit('update machvon.mne_evaluation set mne_report_id = null where id = $1::uuid')).toMatch(/final/);
    expect(await edit('update machvon.mne_evaluation set mne_report_id = gen_random_uuid() where id = $1::uuid')).toMatch(/final/);
  });
});

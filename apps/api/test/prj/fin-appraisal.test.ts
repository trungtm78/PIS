import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { analyseInvestment, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { prjModule } from '../../src/modules/prj';
import { InvestmentAppraisalController, InvestmentAppraisalReadsController } from '../../src/modules/prj/fin-appraisal.controller';
import { BQL1, CapWorld, ROOT, money } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const OTHER_UNIT = 7;
const MAKER = 12; // project.fin.read, manage, submit, export: opens, edits, computes, submits
const CHECKER = 20; // project.fin.read, approve, export: decides
const READER = 22; // project.fin.read
const SCOPED = 23; // project.fin.read, manage, but only in the unit BQL1
const NOBODY = 24;
const MEMBERS = [MAKER, CHECKER, READER, SCOPED, NOBODY];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const LINES = [{ period: 0, capex: '1000' }, { period: 1, benefit: '300' }, { period: 2, benefit: '400' }, { period: 3, benefit: '500' }, { period: 4, benefit: '600' }];

describe('the investment appraisal over HTTP (lane FIN-1, AI.06: NPV, IRR, payback, TCO by a verified formula module)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let contractor = '';
  let counter = 0;

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>('select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 and outcome = $3 order by occurred_at', [resourceId, action, 'SUCCESS']);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [aggregateId, type]);

  const answered = (...keys: string[]) => keys.map((key) => ({ key, value: 'Theo hồ sơ', unit: 'VND', source_kind: 'DOCUMENT', source: 'Quyết định số 123/QĐ-UBND', owner_id: memberId(MAKER) }));
  const inputs = (over: Record<string, unknown> = {}) => ({
    title: 'Cải tạo hệ thống chiếu sáng',
    period_unit: 'YEAR',
    discount_rate_pct: '10',
    convention: 'END',
    lines: LINES,
    assumptions: answered('HORIZON', 'DISCOUNT_RATE', 'BENEFIT', 'CAPEX'),
    scenarios: [],
    scores: [],
    ...over,
  });

  const open = (body: Record<string, unknown> = {}, member = MAKER) => call('POST', '/investment-appraisals', { member, body: { title: 'Cải tạo hệ thống chiếu sáng', kind: 'FINANCIAL', owner_unit_id: unitId(BQL1), ...body } });
  const edit = (appraisal: string, version: number, body: Record<string, unknown> = inputs(), member = MAKER) => call('POST', `/investment-appraisals/${appraisal}/inputs`, { member, ifMatch: `"${version}"`, body });
  const run = (appraisal: string, version: number, member = MAKER) => call('POST', `/investment-appraisals/${appraisal}/runs`, { member, ifMatch: `"${version}"` });
  const submit = (appraisal: string, version: number, member = MAKER) => call('POST', `/investment-appraisals/${appraisal}/submission`, { member, ifMatch: `"${version}"` });
  const approve = (appraisal: string, version: number, member = CHECKER) => call('POST', `/investment-appraisals/${appraisal}/approval`, { member, ifMatch: `"${version}"`, body: { reason: 'Đã đối chiếu với hồ sơ.' } });
  const read = (appraisal: string, member = MAKER) => call('GET', `/investment-appraisals/${appraisal}`, { member });

  /** A draft with inputs and a result, ready to submit: returns the id and the version after each step. */
  async function computed(over: Record<string, unknown> = {}): Promise<{ id: string; version: number }> {
    const opened = await open();
    expect(opened.status).toBe(200);
    const appraisal = opened.json.resource_id as string;
    const edited = await edit(appraisal, opened.json.resource_version as number, inputs(over));
    expect(edited.status).toBe(200);
    const done = await run(appraisal, edited.json.resource_version as number);
    expect(done.status).toBe(200);
    return { id: appraisal, version: done.json.resource_version as number };
  }

  async function seedContract(): Promise<{ projectId: string; packageId: string; contractId: string }> {
    counter += 1;
    const line = await world.publishedLine({ allocated: money(60), appropriationAmount: money(80) });
    const packageId = randomUUID();
    const contractId = randomUUID();
    await seedAs(harness, [
      [`insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, allocation_line_id) values ($1, $2, $3, $4, 100000000000, 'OPEN', 1, 'AWARDED', $5)`, [TENANT_A, packageId, line.projectId, `PKG-FIN-${counter}`, line.lineId]],
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd, created_by, updated_by, signed_on, effective_from)
         values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', 'ACTIVE', 1, 'Contract', 'CONSTRUCTION', false, true, 10000000000, $7, $7, date '2026-01-01', date '2026-01-02')`,
        [TENANT_A, contractId, line.projectId, packageId, contractor, `HD-FIN-${counter}`, memberId(MAKER)],
      ],
    ]);
    return { projectId: line.projectId, packageId, contractId };
  }

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_UNIT, path: `/${unitId(ROOT)}/${unitId(OTHER_UNIT)}/`, parent: ROOT }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'FIN_MAKER', ['project.fin.read', 'project.fin.manage', 'project.fin.submit', 'project.fin.export'], 30],
      [2, 'FIN_CHECKER', ['project.fin.read', 'project.fin.approve', 'project.fin.export'], 50],
      [3, 'FIN_READER', ['project.fin.read'], 10],
      [4, 'FIN_SCOPED', ['project.fin.read', 'project.fin.manage'], 20],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 90 + n, code, permissions, rank);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 91, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 92, kind: 'TENANT' },
      { n: 3, member: READER, role: 93, kind: 'TENANT' },
      { n: 4, member: SCOPED, role: 94, kind: 'UNIT_SUBTREE', refs: [unitId(BQL1)] },
    ]);
    contractor = await seedContractor(harness);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [InvestmentAppraisalController, InvestmentAppraisalReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  it('is registered in the module of PRJ', () => {
    expect(prjModule.controllers).toEqual(expect.arrayContaining([InvestmentAppraisalController, InvestmentAppraisalReadsController]));
  });

  describe('opening an appraisal', () => {
    it('opens a draft with a code of the year, audits it, replays the same key once, and refuses the unfit and whoever may not', async () => {
      const key = `open-${randomUUID()}`;
      const body = { title: 'Cải tạo hệ thống chiếu sáng', kind: 'FINANCIAL', owner_unit_id: unitId(BQL1) };
      const opened = await call('POST', '/investment-appraisals', { member: MAKER, body, key });
      expect(opened).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1, revision: 1 } });
      expect(opened.json.code).toMatch(/^FIN-\d{4}-\d{4}$/);
      const appraisal = opened.json.resource_id as string;
      expect(await call('POST', '/investment-appraisals', { member: MAKER, body, key })).toMatchObject({ status: 200, json: { resource_id: appraisal, code: opened.json.code } });
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.investment_appraisal where code = $1', [opened.json.code]))[0]?.n).toBe('1');
      expect((await audits(appraisal, 'project.fin_appraisal_created'))[0]).toMatchObject({ actor_id: memberId(MAKER), safe_diff: { kind: 'FINANCIAL', status: 'DRAFT', owner_unit_id: unitId(BQL1) } });
      expect((await events(appraisal, 'project.fin_appraisal_created.v1'))[0]?.payload).toMatchObject({ appraisal_id: appraisal, actor_id: memberId(MAKER) });
      const second = await open({ title: 'Another' });
      expect(second.json.code).not.toBe(opened.json.code);

      expect((await open({ kind: 'MAGIC' })).status).toBeGreaterThanOrEqual(400);
      expect(await open({ owner_unit_id: undefined })).toMatchObject({ status: 422 });
      expect(await open({ discount_rate_pct: '10.00001' })).toMatchObject({ status: 422 });
      // A unit, project, package or contract that is not there for the caller does not exist (no 403 that would say it does).
      expect(await open({ owner_unit_id: randomUUID() })).toMatchObject({ status: 404 });
      expect(await open({ results: { npv: '1000000' } })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect((await open({}, READER)).status).toBe(403);
      expect((await open({}, NOBODY)).status).toBe(403);
      // The scoped officer reaches the unit BQL1 but not the other one: a unit out of reach does not exist.
      expect((await open({}, SCOPED)).status).toBe(200);
      expect((await open({ owner_unit_id: unitId(OTHER_UNIT) }, SCOPED)).status).toBe(404);
    });

    it('takes the unit of the project when it is tied to a project, a package or a contract, and refuses links that do not agree', async () => {
      const linked = await seedContract();
      const byContract = await open({ owner_unit_id: undefined, contract_id: linked.contractId });
      expect(byContract.status).toBe(200);
      const view = await read(byContract.json.resource_id as string);
      expect(view.json).toMatchObject({ project: { id: linked.projectId }, package: { id: linked.packageId }, contract: { id: linked.contractId }, owner_unit: { id: unitId(BQL1) } });
      expect((await open({ owner_unit_id: undefined, package_id: linked.packageId })).status).toBe(200);
      expect((await open({ owner_unit_id: undefined, project_id: linked.projectId })).status).toBe(200);
      expect(await open({ owner_unit_id: unitId(OTHER_UNIT), project_id: linked.projectId })).toMatchObject({ status: 422 });
      const other = await seedContract();
      expect(await open({ owner_unit_id: undefined, contract_id: linked.contractId, project_id: other.projectId })).toMatchObject({ status: 422 });
      expect(await open({ owner_unit_id: undefined, contract_id: randomUUID() })).toMatchObject({ status: 404 });
      const list = await call('GET', `/investment-appraisals?project_id=${linked.projectId}`, { member: READER });
      expect(list.status).toBe(200);
      expect((list.json.items as unknown[]).length).toBe(3);
    });
  });

  describe('the inputs', () => {
    it('replaces the inputs of a draft, refuses a stale version, a bad amount, an owner who is nobody, and a result sent from the outside', async () => {
      const opened = await open();
      const appraisal = opened.json.resource_id as string;
      expect(await edit(appraisal, 9)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      const edited = await edit(appraisal, 1);
      expect(edited).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 2 } });
      const view = await read(appraisal);
      expect(view.json).toMatchObject({ discount_rate_pct: '10', convention: 'END', missing_assumptions: [], required_assumptions: ['HORIZON', 'DISCOUNT_RATE', 'BENEFIT', 'CAPEX'], results: null, results_fresh: false, frozen: false });
      expect((view.json.lines as Array<{ period: number; capex: string }>)[0]).toMatchObject({ period: 0, capex: '1000' });
      expect((view.json.assumptions as Array<{ key: string; owner_name: string | null }>).map((entry) => entry.key)).toEqual(['BENEFIT', 'CAPEX', 'DISCOUNT_RATE', 'HORIZON']);

      const reasonOf = async (body: Record<string, unknown>) => {
        const refused = await edit(appraisal, 2, body);
        return { status: refused.status, field: refused.json.detail, reason: refused.json.reason };
      };
      // The contract refuses what is not a decimal before the formula module sees it; the module refuses the rest (a field named, never a value).
      expect(await reasonOf(inputs({ lines: [{ period: 0, capex: '1e3' }] }))).toMatchObject({ status: 422, field: 'lines.capex' });
      expect(await reasonOf(inputs({ lines: [{ period: 0, capex: '-5' }] }))).toMatchObject({ status: 422, field: 'lines[0].capex', reason: 'MUST_NOT_BE_NEGATIVE' });
      expect(await reasonOf(inputs({ lines: [{ period: 0, capex: '1' }, { period: 0, capex: '2' }] }))).toMatchObject({ status: 422, reason: 'DUPLICATE_PERIOD' });
      expect(await reasonOf(inputs({ discount_rate_pct: '10.5555555' }))).toMatchObject({ status: 422, field: 'discount_rate_pct' });
      expect(await reasonOf(inputs({ scenarios: [{ code: 'BASE', label: 'x', deltas: {} }] }))).toMatchObject({ status: 422, reason: 'DUPLICATE_CODE' });
      expect(await reasonOf(inputs({ assumptions: [{ ...answered('CAPEX')[0], source: ' ' }] }))).toMatchObject({ status: 422, reason: 'EMPTY' });
      expect(await reasonOf(inputs({ assumptions: [{ ...answered('CAPEX')[0], owner_id: randomUUID() }] }))).toMatchObject({ status: 422, reason: 'NOT_A_MEMBER' });
      expect(await reasonOf(inputs({ scores: [{ key: 'urgency', score: 3, evidence: 'x' }] }))).toMatchObject({ status: 422, reason: 'NO_CATEGORY' });
      expect(await edit(appraisal, 2, { ...inputs(), npv: '999999' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await edit(appraisal, 2, { ...inputs(), results: {} })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect((await edit(appraisal, 2, inputs(), READER)).status).toBe(403);
      expect((await edit(appraisal, 2, inputs(), NOBODY)).status).toBe(403);
      expect((await edit(randomUUID(), 1)).status).toBe(404);
      expect((await edit(appraisal, 2, inputs(), SCOPED)).status).toBe(200);
      expect((await audits(appraisal, 'project.fin_appraisal_inputs_updated'))[0]).toMatchObject({ actor_id: memberId(MAKER), safe_diff: { lines: 5, assumptions: 4, scenarios: 0 } });
    });
  });

  describe('the results are the server\'s', () => {
    it('computes with the formula module, keeps the hash and the formula version, and shows a result that no longer matches its inputs as stale', async () => {
      const { id: appraisal, version } = await computed({ scenarios: [{ code: 'ADVERSE', label: 'Bất lợi', deltas: { benefitPct: '-15', capexPct: '15' } }], assumptions: answered('HORIZON', 'DISCOUNT_RATE', 'BENEFIT', 'CAPEX', 'SCENARIO:ADVERSE') });
      const view = await read(appraisal);
      const results = view.json.results as { report: { analysis: { npv: { value: string }; irr: { value: string }; payback: { value: string }; bcr: { value: string }; tco: { value: { nominalTotal: string } } }; scenarios: Array<{ code: string; headline: { npv: string } }>; tornado: Array<{ parameter: string }> } };
      const expected = analyseInvestment({ periodUnit: 'YEAR', discountRatePct: '10', convention: 'END', lines: LINES });
      expect(results.report.analysis.npv.value).toBe(expected.npv.value);
      expect(results.report.analysis.npv.value).toBe('388.77');
      expect(results.report.analysis.irr.value).toBe('24.888336');
      expect(results.report.analysis.payback.value).toBe('2.6000');
      expect(results.report.analysis.bcr.value).toBe('1.3888');
      expect(results.report.analysis.tco.value.nominalTotal).toBe('1000.00');
      expect(results.report.scenarios.map((scenario) => scenario.code)).toEqual(['BASE', 'ADVERSE']);
      expect(Number(results.report.scenarios[1]?.headline.npv)).toBeLessThan(388.77);
      expect(results.report.tornado.length).toBe(7);
      expect(view.json).toMatchObject({ results_fresh: true, frozen: false, formula_version: 'fin-analysis/1.0.0' });
      expect(view.json.result_hash).toMatch(/^[0-9a-f]{64}$/);
      const stored = (await rows<{ result_hash: string; results_inputs_hash: string; computed_by: string }>('select result_hash, results_inputs_hash, computed_by from machvon.investment_appraisal where id = $1::uuid', [appraisal]))[0];
      expect(stored).toMatchObject({ result_hash: view.json.result_hash, computed_by: memberId(MAKER) });
      expect((await audits(appraisal, 'project.fin_appraisal_computed'))[0]?.safe_diff).toMatchObject({ result_hash: view.json.result_hash, formula_version: 'fin-analysis/1.0.0' });

      // The same inputs give the same hash again.
      const again = await run(appraisal, version);
      expect(again.json.result_hash).toBe(view.json.result_hash);

      // An edit leaves the result where it was, but it no longer belongs to the inputs.
      const edited = await edit(appraisal, again.json.resource_version as number, inputs({ discount_rate_pct: '12', scenarios: [{ code: 'ADVERSE', label: 'Bất lợi', deltas: { benefitPct: '-15', capexPct: '15' } }], assumptions: answered('HORIZON', 'DISCOUNT_RATE', 'BENEFIT', 'CAPEX', 'SCENARIO:ADVERSE') }));
      expect(edited.status).toBe(200);
      expect(await read(appraisal)).toMatchObject({ json: { results_fresh: false } });
      expect(await submit(appraisal, edited.json.resource_version as number)).toMatchObject({ status: 409, json: { code: 'APPRAISAL_RESULTS_STALE' } });
      expect((await call('POST', `/investment-appraisals/${appraisal}/export`, { member: MAKER, body: { format: 'CSV' } })).json.code).toBe('APPRAISAL_RESULTS_STALE');
      const recomputed = await run(appraisal, edited.json.resource_version as number);
      expect(recomputed.json.result_hash).not.toBe(view.json.result_hash);
      expect(await read(appraisal)).toMatchObject({ json: { results_fresh: true } });
    });

    it('refuses to compute what has nothing to appraise, and for whoever may not', async () => {
      const opened = await open();
      const appraisal = opened.json.resource_id as string;
      expect(await run(appraisal, 1)).toMatchObject({ status: 422, json: { code: 'APPRAISAL_INPUT_INCOMPLETE' } });
      expect((await run(appraisal, 1, READER)).status).toBe(403);
      expect((await run(appraisal, 1, NOBODY)).status).toBe(403);
      expect((await run(appraisal, 7)).json.code).toBe('VERSION_CONFLICT');
    });
  });

  describe('submitting and approving', () => {
    it('needs every input answered for, then moves to SUBMITTED, and then no one edits it', async () => {
      const opened = await open();
      const appraisal = opened.json.resource_id as string;
      const edited = await edit(appraisal, 1, inputs({ assumptions: answered('HORIZON', 'CAPEX') }));
      const done = await run(appraisal, edited.json.resource_version as number);
      const version = done.json.resource_version as number;
      const missing = await submit(appraisal, version);
      expect(missing).toMatchObject({ status: 422, json: { code: 'APPRAISAL_ASSUMPTION_MISSING', detail: 'DISCOUNT_RATE', missing: ['DISCOUNT_RATE', 'BENEFIT'] } });
      expect((await read(appraisal)).json.missing_assumptions).toEqual(['DISCOUNT_RATE', 'BENEFIT']);

      const fixed = await edit(appraisal, version, inputs());
      const again = await run(appraisal, fixed.json.resource_version as number);
      const submittable = again.json.resource_version as number;
      expect((await submit(appraisal, submittable, READER)).status).toBe(403);
      expect((await submit(appraisal, submittable, CHECKER)).status).toBe(403);
      const submitted = await submit(appraisal, submittable);
      expect(submitted).toMatchObject({ status: 200, json: { status: 'SUBMITTED', resource_version: submittable + 1 } });
      expect((await audits(appraisal, 'project.fin_appraisal_submitted'))[0]).toMatchObject({ actor_id: memberId(MAKER), safe_diff: { status: 'SUBMITTED' } });
      expect((await events(appraisal, 'project.fin_appraisal_submitted.v1')).length).toBe(1);
      const after = submittable + 1;
      expect(await edit(appraisal, after)).toMatchObject({ status: 409, json: { code: 'APPRAISAL_STATE_INVALID' } });
      expect(await run(appraisal, after)).toMatchObject({ status: 409, json: { code: 'APPRAISAL_STATE_INVALID' } });
      expect(await submit(appraisal, after)).toMatchObject({ status: 409, json: { code: 'APPRAISAL_STATE_INVALID' } });
      // The database says the same to anyone who tries around the application.
      await expect(rows("update machvon.investment_appraisal set title = 'x', version = version + 1 where id = $1::uuid", [appraisal])).rejects.toThrow(/submitted appraisal is decided/);
      await expect(rows("delete from machvon.appraisal_cash_line where appraisal_id = $1::uuid", [appraisal])).rejects.toThrow(/only while it is a draft/);
    });

    it('is approved by someone other than who made, edited or submitted it, with the results frozen with their hash and the formula version', async () => {
      const { id: appraisal, version } = await computed();
      const submitted = await submit(appraisal, version);
      const at = submitted.json.resource_version as number;
      const before = await read(appraisal);
      expect(await approve(appraisal, at, MAKER)).toMatchObject({ status: 403 });
      expect(await approve(appraisal, at, READER)).toMatchObject({ status: 403 });
      expect(await approve(appraisal, 99, CHECKER)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      const approved = await approve(appraisal, at);
      expect(approved).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: at + 1, result_hash: before.json.result_hash, formula_version: 'fin-analysis/1.0.0' } });
      const view = await read(appraisal);
      expect(view.json).toMatchObject({ status: 'APPROVED', frozen: true, results_fresh: true, result_hash: before.json.result_hash, approved_by: { id: memberId(CHECKER) }, decision_reason: 'Đã đối chiếu với hồ sơ.' });
      expect(view.json.actions).toMatchObject({ update_inputs: false, run: false, submit: false, approve: false, return: false, export: true, revise: true });
      const frozen = (await rows<{ frozen_result_hash: string; frozen_formula_version: string; has_frozen: boolean }>('select frozen_result_hash, frozen_formula_version, frozen_results is not null as has_frozen from machvon.investment_appraisal where id = $1::uuid', [appraisal]))[0];
      expect(frozen).toMatchObject({ frozen_result_hash: before.json.result_hash, frozen_formula_version: 'fin-analysis/1.0.0', has_frozen: true });
      expect((await audits(appraisal, 'project.fin_appraisal_approved'))[0]).toMatchObject({ actor_id: memberId(CHECKER), reason: 'Đã đối chiếu với hồ sơ.', safe_diff: { result_hash: before.json.result_hash } });
      expect((await events(appraisal, 'project.fin_appraisal_approved.v1')).length).toBe(1);
      expect(await approve(appraisal, at + 1)).toMatchObject({ status: 409, json: { code: 'APPRAISAL_STATE_INVALID' } });

      // Nothing changes an approved appraisal, not even a statement run outside the application.
      for (const statement of ["update machvon.investment_appraisal set title = 'x' where id = $1::uuid", "update machvon.investment_appraisal set frozen_result_hash = repeat('0', 64) where id = $1::uuid", "delete from machvon.investment_appraisal where id = $1::uuid"]) {
        await expect(rows(statement, [appraisal])).rejects.toThrow();
      }
      await expect(rows("update machvon.appraisal_cash_line set capex_vnd = 1 where appraisal_id = $1::uuid", [appraisal])).rejects.toThrow(/only while it is a draft/);
      expect(await edit(appraisal, at + 1)).toMatchObject({ status: 409, json: { code: 'APPRAISAL_STATE_INVALID' } });
    });

    it('refuses an approver who edited the appraisal even if he did not make it, and a stored result that the formula no longer reproduces', async () => {
      const { id: appraisal, version } = await computed();
      // The checker edits the draft (he holds no right to, so the grant is added for this case), then submits it by the maker: he is still an editor.
      await rows("update machvon.investment_appraisal set updated_by = $2::uuid where id = $1::uuid", [appraisal, memberId(CHECKER)]);
      const submitted = await submit(appraisal, version);
      expect(await approve(appraisal, submitted.json.resource_version as number, CHECKER)).toMatchObject({ status: 403 });

      const other = await computed();
      const sent = await submit(other.id, other.version);
      // A formula that changed since the result was stored: the hash it was submitted with is no longer what the inputs give.
      await rows("alter table machvon.investment_appraisal disable trigger investment_appraisal_guard");
      await rows("update machvon.investment_appraisal set result_hash = repeat('f', 64) where id = $1::uuid", [other.id]);
      await rows("alter table machvon.investment_appraisal enable trigger investment_appraisal_guard");
      expect(await approve(other.id, sent.json.resource_version as number)).toMatchObject({ status: 409, json: { code: 'APPRAISAL_RESULTS_STALE' } });
      expect((await read(other.id)).json.status).toBe('SUBMITTED');
    });

    it('is returned to a draft with a reason, edited again, and submitted again', async () => {
      const { id: appraisal, version } = await computed();
      const submitted = await submit(appraisal, version);
      const at = submitted.json.resource_version as number;
      const giveBack = (member: number, body: Record<string, unknown>, ifMatch = `"${at}"`) => call('POST', `/investment-appraisals/${appraisal}/return`, { member, ifMatch, body });
      expect(await giveBack(CHECKER, {})).toMatchObject({ status: 400 });
      expect((await giveBack(READER, { reason: 'No.' })).status).toBe(403);
      expect(await giveBack(CHECKER, { reason: 'Tỷ lệ chiết khấu chưa có căn cứ.' }, '"99"')).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await giveBack(CHECKER, { reason: 'Tỷ lệ chiết khấu chưa có căn cứ.' })).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: at + 1 } });
      expect((await audits(appraisal, 'project.fin_appraisal_returned'))[0]).toMatchObject({ actor_id: memberId(CHECKER), reason: 'Tỷ lệ chiết khấu chưa có căn cứ.' });
      expect(await read(appraisal)).toMatchObject({ json: { status: 'DRAFT', decision_reason: 'Tỷ lệ chiết khấu chưa có căn cứ.', results_fresh: true } });
      expect(await giveBack(CHECKER, { reason: 'Again.' }, `"${at + 1}"`)).toMatchObject({ status: 409, json: { code: 'APPRAISAL_STATE_INVALID' } });
      expect((await edit(appraisal, at + 1, inputs({ discount_rate_pct: '9' }))).status).toBe(200);
    });
  });

  describe('a new version of an approved appraisal', () => {
    it('starts from the inputs of the approved one with the same code, the next revision and no result, and there is only one next version', async () => {
      const { id: appraisal, version } = await computed();
      const submitted = await submit(appraisal, version);
      expect((await approve(appraisal, submitted.json.resource_version as number)).status).toBe(200);
      const original = (await read(appraisal)).json;
      const next = await open({ revise_of: appraisal, owner_unit_id: undefined, title: 'Cải tạo hệ thống chiếu sáng, bản 2' });
      expect(next).toMatchObject({ status: 200, json: { revision: 2, code: original.code, status: 'DRAFT' } });
      const view = (await read(next.json.resource_id as string)).json;
      expect(view).toMatchObject({ code: original.code, revision: 2, supersedes_id: appraisal, status: 'DRAFT', results: null, results_fresh: false, discount_rate_pct: '10', title: 'Cải tạo hệ thống chiếu sáng, bản 2' });
      expect(view.lines).toEqual(original.lines);
      expect((view.assumptions as unknown[]).length).toBe(4);
      expect((await read(appraisal)).json.actions).toMatchObject({ revise: false });
      expect(await open({ revise_of: appraisal, owner_unit_id: undefined })).toMatchObject({ status: 409, json: { code: 'APPRAISAL_STATE_INVALID' } });
      // A draft cannot be revised: only an approved appraisal has a next version.
      expect(await open({ revise_of: next.json.resource_id, owner_unit_id: undefined })).toMatchObject({ status: 409, json: { code: 'APPRAISAL_STATE_INVALID' } });
    });
  });

  describe('the non-financial criteria of a safety, compliance or maintenance project', () => {
    const scores = (value: number) => ['accident_risk_reduction', 'legal_safety_standard', 'people_protected', 'incident_history', 'urgency'].map((key) => ({ key, score: value, evidence: 'Biên bản kiểm tra hiện trạng.' }));

    it('scores with the default weights of the platform and keeps the set that it was scored with, then with the weights a tenant approved', async () => {
      const opened = await open({ kind: 'NON_FINANCIAL', title: 'Gia cố mái dốc' });
      const appraisal = opened.json.resource_id as string;
      expect(await run(appraisal, 1)).toMatchObject({ status: 422, json: { code: 'APPRAISAL_INPUT_INCOMPLETE' } });
      const body = inputs({ lines: [], criteria_category: 'SAFETY', scores: scores(4), assumptions: answered('HORIZON', 'DISCOUNT_RATE') });
      const edited = await edit(appraisal, 1, body);
      expect(edited.status).toBe(200);
      const done = await run(appraisal, edited.json.resource_version as number);
      expect(done.status).toBe(200);
      const view = (await read(appraisal)).json;
      expect(view).toMatchObject({ criteria_category: 'SAFETY', criteria_used: { source: 'DEFAULT', version: 0 }, criteria_in_force: { category: 'SAFETY', source: 'DEFAULT', unverified: true } });
      const results = view.results as { report: unknown; criteria: { weightedScore: string; indexPct: string; lines: unknown[] } };
      expect(results.report).toBeNull();
      expect(results.criteria).toMatchObject({ weightedScore: '4.00', indexPct: '80.00' });
      expect(results.criteria.lines.length).toBe(5);
      expect((await call('GET', '/investment-appraisals?kind=NON_FINANCIAL', { member: READER })).json.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: appraisal, index_pct: '80.00', result_state: 'COMPUTED' })]));

      // A score that is missing, out of the scale or without evidence is refused when the appraisal is computed or edited.
      expect((await edit(appraisal, done.json.resource_version as number, { ...body, scores: scores(6) })).status).toBe(422);
      const partial = await edit(appraisal, done.json.resource_version as number, { ...body, scores: scores(4).slice(0, 3) });
      expect(partial.status).toBe(200);
      expect(await run(appraisal, partial.json.resource_version as number)).toMatchObject({ status: 422, json: { reason: 'MISSING_SCORES' } });

      // The weights a tenant approved (the rule type FIN_CRITERIA of the governance platform) apply to the next computation, and the appraisal records the version it used.
      await rows(
        `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, approved_by, approved_at)
         values ($1, 'FIN_CRITERIA', 'SAFETY', 1, 'APPROVED', $2::jsonb, date '2026-01-01', 'Tenant weights for safety projects', $3::uuid, $3::uuid, $4::uuid, now())`,
        [
          TENANT_A,
          JSON.stringify({ criteria: [{ key: 'accident_risk_reduction', label: 'Giảm tai nạn', weight_pct: '50' }, { key: 'legal_safety_standard', label: 'Quy chuẩn', weight_pct: '20' }, { key: 'people_protected', label: 'Số người', weight_pct: '10' }, { key: 'incident_history', label: 'Sự cố', weight_pct: '10' }, { key: 'urgency', label: 'Khẩn cấp', weight_pct: '10' }] }),
          memberId(MAKER),
          memberId(CHECKER),
        ],
      );
      const weights = ['accident_risk_reduction', 'legal_safety_standard', 'people_protected', 'incident_history', 'urgency'].map((key, index) => ({ key, score: index === 0 ? 5 : 1, evidence: 'Biên bản kiểm tra hiện trạng.' }));
      const rescored = await edit(appraisal, partial.json.resource_version as number, { ...body, scores: weights });
      const second = await run(appraisal, rescored.json.resource_version as number);
      expect(second.status).toBe(200);
      const again = (await read(appraisal)).json;
      expect(again).toMatchObject({ criteria_used: { source: 'RULE', version: 1 } });
      // 50 x 5 + 20 x 1 + 10 x 1 + 10 x 1 + 10 x 1 = 300 -> 3.00 of 5, 60.00%
      expect((again.results as { criteria: { weightedScore: string; indexPct: string } }).criteria).toMatchObject({ weightedScore: '3.00', indexPct: '60.00' });
      expect(await submit(appraisal, second.json.resource_version as number)).toMatchObject({ status: 200, json: { status: 'SUBMITTED' } });
    });
  });

  describe('the file for cross-checking (KT.02)', () => {
    it('exports the formulas, the inputs with their sources and the table of the cash flow as CSV or a workbook, with the hash of the file, and audits who took it', async () => {
      const { id: appraisal, version } = await computed();
      const draft = await call('POST', `/investment-appraisals/${appraisal}/export`, { member: MAKER, body: { format: 'CSV' } });
      expect(draft.status).toBe(200);
      expect(draft.json).toMatchObject({ file_name: expect.stringMatching(/^FIN-\d{4}-\d{4}-v1\.csv$/), status: 'EXPORTED', formula_version: 'fin-analysis/1.0.0' });
      const bytes = Buffer.from(draft.json.content_base64 as string, 'base64');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(draft.json.sha256);
      expect(bytes.length).toBe(draft.json.size_bytes);
      const text = bytes.toString('utf8');
      expect(text.startsWith('﻿')).toBe(true);
      expect(text).toContain('KẾT QUẢ,NPV,Giá trị hiện tại ròng,388.77,VND');
      expect(text).toContain('NPV = Σ CF(t) / (1 + r)^t');
      expect(text).toContain('Quyết định số 123/QĐ-UBND');
      expect(text).toContain(`result_hash,Mã băm kết quả,${draft.json.result_hash as string}`);
      expect(text).toContain('Bản nháp');
      const book = await call('POST', `/investment-appraisals/${appraisal}/export`, { member: MAKER, body: { format: 'XLSX' } });
      expect(book.status).toBe(200);
      expect(Buffer.from(book.json.content_base64 as string, 'base64').subarray(0, 2).toString('latin1')).toBe('PK');
      expect((await audits(appraisal, 'project.fin_appraisal_exported')).map((entry) => entry.safe_diff.format)).toEqual(['CSV', 'XLSX']);
      expect((await audits(appraisal, 'project.fin_appraisal_exported'))[0]).toMatchObject({ actor_id: memberId(MAKER), safe_diff: { sha256: draft.json.sha256, result_hash: draft.json.result_hash } });
      expect((await call('POST', `/investment-appraisals/${appraisal}/export`, { member: READER, body: { format: 'CSV' } })).status).toBe(403);
      expect((await call('POST', `/investment-appraisals/${appraisal}/export`, { member: MAKER, body: { format: 'PDF' } })).status).toBeGreaterThanOrEqual(400);
      expect((await call('POST', `/investment-appraisals/${randomUUID()}/export`, { member: MAKER, body: { format: 'CSV' } })).status).toBe(404);

      // Approved: the file carries the approver and says the result is frozen.
      const submitted = await submit(appraisal, version);
      expect((await approve(appraisal, submitted.json.resource_version as number)).status).toBe(200);
      const frozen = await call('POST', `/investment-appraisals/${appraisal}/export`, { member: CHECKER, body: { format: 'CSV' } });
      const frozenText = Buffer.from(frozen.json.content_base64 as string, 'base64').toString('utf8');
      expect(frozenText).toContain('đã đóng băng khi duyệt');
      expect(frozenText).toContain('approved_by');
      expect(frozenText).not.toContain('Bản nháp');
    });
  });

  describe('reading', () => {
    it('lists in the scope of the caller with filters, tells the buttons a caller may press, and shows an appraisal out of reach as not there', async () => {
      const inOther = await open({ owner_unit_id: unitId(OTHER_UNIT), title: 'Hồ sơ của đơn vị khác' });
      const mine = await open({ title: 'Hồ sơ của đơn vị BQL1 riêng biệt' });
      expect(inOther.status).toBe(200);
      const all = await call('GET', '/investment-appraisals?limit=100', { member: READER });
      expect(all.status).toBe(200);
      const ids = (all.json.items as Array<{ id: string }>).map((item) => item.id);
      expect(ids).toEqual(expect.arrayContaining([inOther.json.resource_id, mine.json.resource_id]));
      expect(all.json).toMatchObject({ total: ids.length, actions: { create: false } });
      const scoped = await call('GET', '/investment-appraisals?limit=100', { member: SCOPED });
      const scopedIds = (scoped.json.items as Array<{ id: string }>).map((item) => item.id);
      expect(scopedIds).toContain(mine.json.resource_id);
      expect(scopedIds).not.toContain(inOther.json.resource_id);
      expect(scoped.json.actions).toMatchObject({ create: true });
      expect((await read(inOther.json.resource_id as string, SCOPED)).status).toBe(404);
      expect((await read(inOther.json.resource_id as string, NOBODY)).status).toBe(403);
      expect((await read(randomUUID(), READER)).status).toBe(404);
      const found = await call('GET', '/investment-appraisals?q=riêng%20biệt&status=DRAFT&kind=FINANCIAL', { member: READER });
      expect((found.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([mine.json.resource_id]);
      expect((await call('GET', '/investment-appraisals?status=NONSENSE', { member: READER })).status).toBe(422);
      expect((await call('GET', '/investment-appraisals?limit=0', { member: READER })).status).toBeGreaterThanOrEqual(400);
      expect((await call('GET', '/investment-appraisals', { member: NOBODY })).status).toBe(403);

      const view = (await read(mine.json.resource_id as string, MAKER)).json;
      expect(view.actions).toMatchObject({ update_inputs: true, run: true, submit: true, approve: false, return: false, export: false, revise: false });
      expect((await read(mine.json.resource_id as string, READER)).json.actions).toMatchObject({ update_inputs: false, run: false, submit: false, approve: false });
    });

    it('shows the approve button to a checker only after the appraisal is submitted, and not to its maker', async () => {
      const { id: appraisal, version } = await computed();
      expect((await read(appraisal, CHECKER)).json.actions).toMatchObject({ approve: false });
      const submitted = await submit(appraisal, version);
      expect(submitted.status).toBe(200);
      expect((await read(appraisal, CHECKER)).json.actions).toMatchObject({ approve: true, return: true });
      expect((await read(appraisal, MAKER)).json.actions).toMatchObject({ approve: false });
    });
  });
});

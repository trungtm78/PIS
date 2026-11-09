import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { fndModule } from '../../src/modules/fnd';
import { EnterpriseSnapshotController } from '../../src/modules/fnd/enterprise-snapshot.controller';
import { FundingFigureController } from '../../src/modules/fnd/figure.controller';
import { FundingFigureReadsController } from '../../src/modules/fnd/figure-reads.controller';
import { FUNDING_PACK_CODE } from '../../src/modules/fnd/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PREPARER = 1; // read and prepare over the tenant
const CHECKER = 2; // read and accept over the tenant
const BOTH = 3; // read, prepare and accept (never on his own batch)
const READER = 4; // read only
const NOBODY = 5;
const UNIT_PREPARER = 6; // read and prepare over the unit tree of the department only
const B_USER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const FAMILY = 0x98;
const PREPARE = ['funding.read', 'funding.figure.prepare'];
const ACCEPT = ['funding.read', 'funding.figure.accept'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the figures of the funding model: batches, acceptance, the board and the history (FND-1, DIS-27 to DIS-29)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let projectId = '';
  let outsideProjectId = '';
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; reason: string | null; actor_id: string }>('select safe_diff, reason, actor_id from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);

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

  const project = async (unit: number): Promise<string> => {
    const created = randomUUID();
    await seed([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Enterprise project', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, created, `FNDAPI-${created.slice(0, 6)}`, unitId(unit), unitId(ROOT), id(FAMILY, 90)],
      ],
    ]);
    return created;
  };

  const estimate = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ project_id: projectId, class_code: 'EQUITY', tier_code: 'ALL', measure: 'DISBURSED', figure_kind: 'ESTIMATE', period_grain: 'MONTH', plan_year: 2026, as_of_date: '2026-03-10', entries: [{ period_ordinal: 3, amount_vnd: '123456789' }], ...over });
  const batchUrl = (batchId: string, tail = ''): string => `/funding-figures/batches/${batchId}${tail}`;

  /** Prepare, hand in and accept a batch by two people; returns the batch id. */
  async function settle(body: Record<string, unknown>, preparer = PREPARER, checker = CHECKER): Promise<string> {
    const drafted = await call('POST', '/funding-figures/batches', { member: preparer, body });
    expect(drafted.status).toBe(200);
    const batchId = drafted.json.resource_id as string;
    const submitted = await call('POST', batchUrl(batchId, '/submission'), { member: preparer, ifMatch: `"${drafted.json.resource_version}"` });
    expect(submitted.status).toBe(200);
    const accepted = await call('POST', batchUrl(batchId, '/acceptance'), { member: checker, ifMatch: `"${submitted.json.resource_version}"` });
    expect(accepted.status).toBe(200);
    return batchId;
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [PREPARER, CHECKER, BOTH, READER, NOBODY, UNIT_PREPARER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_USER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'FND_PREPARER', PREPARE, 40);
    await harness.seedRole(TENANT_A, 2, 'FND_CHECKER', ACCEPT, 40);
    await harness.seedRole(TENANT_A, 3, 'FND_BOTH', [...PREPARE, 'funding.figure.accept'], 50);
    await harness.seedRole(TENANT_A, 4, 'FND_READER', ['funding.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'FND_BOTH', [...PREPARE, 'funding.figure.accept'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PREPARER, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 2, kind: 'TENANT' },
      { n: 3, member: BOTH, role: 3, kind: 'TENANT' },
      { n: 4, member: READER, role: 4, kind: 'TENANT' },
      { n: 5, member: UNIT_PREPARER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_USER, role: 1, kind: 'TENANT' }]);
    projectId = await project(DEPARTMENT);
    outsideProjectId = await project(ROOT);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [FundingFigureController, FundingFigureReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FUNDING_PACK_CODE, useValue: 'ENTERPRISE' },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of FND, which is a module of its own', () => {
    expect(fndModule.code).toBe('FND');
    expect(fndModule.controllers).toEqual([FundingFigureController, FundingFigureReadsController, EnterpriseSnapshotController]);
  });

  describe('getFundingTaxonomy', () => {
    it('says which pack is in force, its classes, measures and ratios, where the numbers come from and what the caller may do; a caller with no right to read is refused', async () => {
      const answer = await call('GET', '/funding-figures/taxonomy', { member: PREPARER });
      expect(answer.status).toBe(200);
      expect(answer.json).toMatchObject({ pack_code: 'ENTERPRISE', version: 0, unverified: true, entry_mode: 'PERIOD_ENTRY', phasing_must_sum: true, actions: { prepare: true, accept: false } });
      expect((answer.json.classes as Array<{ code: string }>).map((one) => one.code)).toEqual(['EQUITY', 'LOAN', 'OTHER']);
      expect((answer.json.ratios as Array<{ code: string }>).map((one) => one.code)).toContain('RATE_YEAR_IN_FORCE');
      expect(answer.json.provenance).toMatchObject({ legal_status: 'UNVERIFIED' });
      expect((await call('GET', '/funding-figures/taxonomy', { member: CHECKER })).json).toMatchObject({ actions: { prepare: false, accept: true } });
      expect((await call('GET', '/funding-figures/taxonomy', { member: NOBODY })).status).toBe(403);
    });
  });

  describe('the batch: prepare, hand in, accept (maker is not checker)', () => {
    it('prepares a draft, audits it and announces it with ids and counts only (never an amount), and refuses a caller who only reads or who holds no right', async () => {
      const drafted = await call('POST', '/funding-figures/batches', { member: PREPARER, body: estimate() });
      expect(drafted.status).toBe(200);
      expect(drafted.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const batchId = drafted.json.resource_id as string;
      const [audit] = await audits(batchId, 'funding.figure_proposed');
      expect(audit?.safe_diff).toMatchObject({ to_status: 'DRAFT', figure_kind: 'ESTIMATE', figure_count: 1, plan_year: 2026 });
      expect(JSON.stringify(audit?.safe_diff)).not.toContain('123456789');
      const [event] = await events(batchId, 'funding.figure_proposed.v1');
      expect(event?.payload).toMatchObject({ batch_id: batchId, status: 'DRAFT', figure_count: 1 });
      expect(JSON.stringify(event?.payload)).not.toContain('123456789');
      expect((await call('POST', '/funding-figures/batches', { member: READER, body: estimate() })).status).toBe(403);
      expect((await call('POST', '/funding-figures/batches', { member: CHECKER, body: estimate() })).status).toBe(403);
      expect((await call('POST', '/funding-figures/batches', { member: NOBODY, body: estimate() })).status).toBe(403);
    });

    it('replays a command under the same key without a second batch, and refuses the same key with another request', async () => {
      const key = `key-${randomUUID()}`;
      const body = estimate({ entries: [{ period_ordinal: 4, amount_vnd: '70' }], as_of_date: '2026-04-10' });
      const first = await call('POST', '/funding-figures/batches', { member: PREPARER, body, key });
      const again = await call('POST', '/funding-figures/batches', { member: PREPARER, body, key });
      expect([first.status, again.status]).toEqual([200, 200]);
      expect(again.json.resource_id).toBe(first.json.resource_id);
      expect(await rows('select 1 from machvon.plan_figure_revision where batch_id = $1::uuid', [first.json.resource_id])).toHaveLength(1);
      const other = await call('POST', '/funding-figures/batches', { member: PREPARER, body: estimate({ entries: [{ period_ordinal: 4, amount_vnd: '71' }] }), key });
      expect([other.status, other.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    });

    it('AC-ST-DIS-026-2 / UAT-PLAN-93: is handed in by the preparer only; accepted by somebody else (403 SELF_APPROVAL_DENIED for the preparer himself); stale versions are 409 VERSION_CONFLICT; a settled batch is 409 FIGURE_STATE_INVALID', async () => {
      const drafted = await call('POST', '/funding-figures/batches', { member: BOTH, body: estimate({ entries: [{ period_ordinal: 5, amount_vnd: '50' }], as_of_date: '2026-05-10' }) });
      const batchId = drafted.json.resource_id as string;
      expect((await call('POST', batchUrl(batchId, '/submission'), { member: PREPARER, ifMatch: '"1"' })).status).toBe(403);
      const stale = await call('POST', batchUrl(batchId, '/submission'), { member: BOTH, ifMatch: '"7"' });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await call('POST', batchUrl(batchId, '/submission'), { member: BOTH, ifMatch: '"1"' })).json).toMatchObject({ status: 'SUBMITTED', resource_version: 2 });
      const self = await call('POST', batchUrl(batchId, '/acceptance'), { member: BOTH, ifMatch: '"2"' });
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await call('POST', batchUrl(batchId, '/acceptance'), { member: PREPARER, ifMatch: '"2"' })).status).toBe(403);
      const accepted = await call('POST', batchUrl(batchId, '/acceptance'), { member: CHECKER, ifMatch: '"2"' });
      expect(accepted.json).toMatchObject({ status: 'ACCEPTED', resource_version: 3 });
      const [audit] = await audits(batchId, 'funding.figure_accepted');
      expect(audit?.safe_diff).toMatchObject({ from_status: 'SUBMITTED', to_status: 'ACCEPTED', conversions: 0 });
      const again = await call('POST', batchUrl(batchId, '/acceptance'), { member: CHECKER, ifMatch: '"3"' });
      expect([again.status, again.json.code]).toEqual([409, 'FIGURE_STATE_INVALID']);
    });

    it('sends a submitted batch back with a reason that is in the audit row only, and lets the preparer withdraw it; the reason must be 10 characters (422)', async () => {
      const drafted = await call('POST', '/funding-figures/batches', { member: PREPARER, body: estimate({ entries: [{ period_ordinal: 6, amount_vnd: '60' }], as_of_date: '2026-06-10' }) });
      const batchId = drafted.json.resource_id as string;
      await call('POST', batchUrl(batchId, '/submission'), { member: PREPARER, ifMatch: '"1"' });
      const short = await call('POST', batchUrl(batchId, '/return'), { member: CHECKER, ifMatch: '"2"', body: { reason: 'short' } });
      expect([short.status, short.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const reason = 'The estimate does not match the monthly plan';
      expect((await call('POST', batchUrl(batchId, '/return'), { member: CHECKER, ifMatch: '"2"', body: { reason } })).json).toMatchObject({ status: 'DRAFT', resource_version: 3 });
      const [audit] = await audits(batchId, 'funding.figure_returned');
      expect(audit?.reason).toBe(reason);
      const [event] = await events(batchId, 'funding.figure_returned.v1');
      expect(JSON.stringify(event?.payload)).not.toContain(reason);
      expect((await call('POST', batchUrl(batchId, '/withdrawal'), { member: PREPARER, ifMatch: '"3"', body: { reason: 'Prepared against the wrong month' } })).json).toMatchObject({ status: 'WITHDRAWN' });
    });
  });

  describe('the identities and the scope', () => {
    it('refuses what the kernel refuses with the code of the spec: quarters that do not add up, an estimate after the actual, a locked period, a class outside the pack', async () => {
      const wrong = await call('POST', '/funding-figures/batches', { member: PREPARER, body: estimate({ figure_kind: 'PLAN_QUARTER', period_grain: 'QUARTER', entries: [1, 2, 3, 4].map((n) => ({ period_ordinal: n, amount_vnd: '10' })) }) });
      expect([wrong.status, wrong.json.code]).toEqual([422, 'PHASING_SUM_MISMATCH']);
      const unknown = await call('POST', '/funding-figures/batches', { member: PREPARER, body: estimate({ class_code: 'CURRENT_YEAR' }) });
      expect([unknown.status, unknown.json.code]).toEqual([422, 'FUNDING_CLASS_UNKNOWN']);
      const negative = await call('POST', '/funding-figures/batches', { member: PREPARER, body: estimate({ figure_kind: 'ACTUAL', entries: [{ period_ordinal: 7, amount_vnd: '-5' }] }) });
      expect([negative.status, negative.json.code]).toEqual([422, 'NEGATIVE_DELTA_EXPLANATION_REQUIRED']);
      await settle(estimate({ figure_kind: 'ACTUAL', entries: [{ period_ordinal: 8, amount_vnd: '80' }], as_of_date: '2026-08-05' }));
      const late = await call('POST', '/funding-figures/batches', { member: PREPARER, body: estimate({ entries: [{ period_ordinal: 8, amount_vnd: '85' }], as_of_date: '2026-08-06' }) });
      expect([late.status, late.json.code]).toEqual([422, 'ESTIMATE_AFTER_ACTUAL']);
      await seed([
        [
          `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, soft_closed_at, locked_at, locked_by, calendar_version_id, created_by, updated_by)
           values ($1, $2, 'M-2026-10', 1, '2026-10-01', '2026-10-31', '2026-11-03', 'ENTERPRISE', 'MONTH', 2026, 'LOCKED', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', $3, $4, $3, $3)`,
          [TENANT_A, randomUUID(), memberId(CHECKER), randomUUID()],
        ],
      ]);
      const locked = await call('POST', '/funding-figures/batches', { member: PREPARER, body: estimate({ figure_kind: 'ACTUAL', entries: [{ period_ordinal: 10, amount_vnd: '100' }], as_of_date: '2026-11-05' }) });
      expect([locked.status, locked.json.code]).toEqual([409, 'FIGURE_PERIOD_LOCKED']);
    });

    it('judges the project against the scope of the caller: a unit grant reaches the projects of its unit tree and nothing else (404)', async () => {
      expect((await call('POST', '/funding-figures/batches', { member: UNIT_PREPARER, body: estimate({ entries: [{ period_ordinal: 9, amount_vnd: '9' }], as_of_date: '2026-09-05' }) })).status).toBe(200);
      const outside = await call('POST', '/funding-figures/batches', { member: UNIT_PREPARER, body: estimate({ project_id: outsideProjectId }) });
      expect([outside.status, outside.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await call('POST', '/funding-figures/batches', { member: UNIT_PREPARER, body: estimate({ project_id: randomUUID() }) })).status).toBe(404);
    });

    it('refuses a malformed body (422 naming the field) and an unknown member of the body (400)', async () => {
      const bad = await call('POST', '/funding-figures/batches', { member: PREPARER, body: estimate({ entries: [{ period_ordinal: 3, amount_vnd: '1.5' }] }) });
      expect([bad.status, bad.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await call('POST', '/funding-figures/batches', { member: PREPARER, body: { ...estimate(), surprise: true } })).status).toBe(400);
    });
  });

  describe('the reads', () => {
    it('lists the batches with what the caller may do with each (the preparer hands in, another person accepts), filtered, and never shows another tenant', async () => {
      const mine = await call('POST', '/funding-figures/batches', { member: PREPARER, body: estimate({ figure_kind: 'ESTIMATE', entries: [{ period_ordinal: 11, amount_vnd: '11' }], as_of_date: '2026-11-05' }) });
      await call('POST', batchUrl(mine.json.resource_id as string, '/submission'), { member: PREPARER, ifMatch: '"1"' });
      const asPreparer = await call('GET', '/funding-figures/batches?status=SUBMITTED', { member: PREPARER });
      const own = (asPreparer.json.items as Array<Record<string, unknown>>).find((one) => one.batch_id === mine.json.resource_id);
      expect(own).toMatchObject({ status: 'SUBMITTED', prepared_by_me: true, actions: { submit: false, withdraw: true, accept: false, return: false } });
      const asChecker = await call('GET', '/funding-figures/batches?status=SUBMITTED', { member: CHECKER });
      const seen = (asChecker.json.items as Array<Record<string, unknown>>).find((one) => one.batch_id === mine.json.resource_id);
      expect(seen).toMatchObject({ prepared_by_me: false, actions: { accept: true, return: true, submit: false, withdraw: false } });
      expect((await call('GET', `/funding-figures/batches/${mine.json.resource_id as string}`, { member: CHECKER })).json).toMatchObject({ batch_id: mine.json.resource_id, entries: [expect.objectContaining({ period_ordinal: 11, amount_vnd: '11' })] });
      expect((await call('GET', `/funding-figures/batches/${mine.json.resource_id as string}`, { member: B_USER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', '/funding-figures/batches', { member: B_USER, tenantId: TENANT_B })).json).toMatchObject({ items: [] });
      expect((await call('GET', '/funding-figures/batches?status=NOPE', { member: PREPARER })).status).toBe(422);
      expect((await call('GET', '/funding-figures/batches?limit=0', { member: PREPARER })).status).toBe(422);
      expect((await call('GET', '/funding-figures/batches', { member: NOBODY })).status).toBe(403);
    });

    it('answers the board with the figures, the indicators with their numerators, denominators and formula codes, and the history of the estimate that became an actual', async () => {
      await seed([
        [`insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, 2026, 1, $4, 'PUBLISHED', '2026-01-10T03:00:00Z')`, [TENANT_A, '00000000-0000-4000-8000-0000000000c1', projectId, randomUUID()]],
        [`insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, budget_level, taxonomy_pack) values ($1, $2, $3, $4, 'EQUITY', 2026, 1000000000, 0, 'ALL', 'ENTERPRISE')`, [TENANT_A, randomUUID(), '00000000-0000-4000-8000-0000000000c1', randomUUID()]],
      ]);
      await settle(estimate({ entries: [{ period_ordinal: 2, amount_vnd: '100000000' }], as_of_date: '2026-02-10' }));
      await settle(estimate({ figure_kind: 'ACTUAL', entries: [{ period_ordinal: 2, amount_vnd: '125000000' }], as_of_date: '2026-03-05' }));
      const board = await call('GET', `/funding-figures/board?project_id=${projectId}&plan_year=2026&period_grain=MONTH&period_ordinal=2&as_of=2026-03-31&measure=DISBURSED`, { member: READER });
      expect(board.status).toBe(200);
      expect(board.json).toMatchObject({ pack_code: 'ENTERPRISE', plan_year: 2026, measure: 'DISBURSED', view: 'AS_REPORTED', as_of: '2026-03-31', unverified: true });
      const projectBlock = (board.json.projects as Array<{ project_id: string; cells: Array<Record<string, unknown>>; rates: Array<Record<string, unknown>> }>)[0];
      expect(projectBlock?.project_id).toBe(projectId);
      expect(projectBlock?.cells.find((cell) => cell.class_code === 'EQUITY')).toMatchObject({ plan_year_vnd: '1000000000', plan_in_force_vnd: '1000000000', actual_vnd: '125000000', cumulative_ytd_vnd: '125000000', estimate_as_reported_vnd: '100000000', estimate_vnd: null });
      expect(projectBlock?.cells.find((cell) => cell.class_code === 'LOAN')).toMatchObject({ plan_year_vnd: null, actual_vnd: null });
      const year = projectBlock?.rates.find((rate) => rate.code === 'RATE_YEAR_IN_FORCE');
      expect(year).toMatchObject({ numerator_vnd: '125000000', denominator_vnd: '1000000000', rate_pct: '12.5000', null_reason: null, formula_code: 'RATE_YEAR_IN_FORCE', pack_code: 'ENTERPRISE', as_of: '2026-03-31' });
      expect(projectBlock?.rates.find((rate) => rate.code === 'ESTIMATE_ACCURACY')).toMatchObject({ rate_pct: '125.0000', numerator_term: 'ACTUAL', denominator_term: 'ESTIMATE_AS_REPORTED' });
      expect(projectBlock?.rates.find((rate) => rate.code === 'RATE_PERIOD')).toMatchObject({ rate_pct: null, null_reason: 'ZERO_DENOMINATOR' });
      expect(((board.json.totals as { money: Array<{ code: string; value_vnd: string | null }> }).money.find((one) => one.code === 'CONVERSION_DELTA'))?.value_vnd).toBe('25000000');
      const history = await call('GET', `/funding-figures/history?project_id=${projectId}&class_code=EQUITY&tier_code=ALL&measure=DISBURSED&period_grain=MONTH&plan_year=2026&period_ordinal=2`, { member: READER });
      expect(history.status).toBe(200);
      const steps = (history.json.history as Array<Record<string, unknown>>).map((one) => [one.figure_kind, one.amount_vnd, one.conversion_delta_vnd]);
      expect(steps).toEqual([['ESTIMATE', '100000000', null], ['ACTUAL', '125000000', '25000000']]);
      const [conversion] = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'funding.estimate_converted' limit 1");
      expect(conversion?.safe_diff).toMatchObject({ conversions: 1, figure_kind: 'ACTUAL' });
    });

    it('refuses a board query that is malformed (422 naming the field), a project out of reach (404) and a caller with no right (403); another tenant sees an empty board', async () => {
      expect((await call('GET', '/funding-figures/board?period_grain=WEEK', { member: READER })).status).toBe(422);
      expect((await call('GET', '/funding-figures/board?period_ordinal=13', { member: READER })).status).toBe(422);
      expect((await call('GET', '/funding-figures/board?view=NOPE', { member: READER })).status).toBe(422);
      expect((await call('GET', '/funding-figures/board?as_of=2026-02-30', { member: READER })).status).toBe(422);
      expect((await call('GET', '/funding-figures/board?measure=OTHER', { member: READER })).status).toBe(422);
      expect((await call('GET', `/funding-figures/board?project_id=${randomUUID()}`, { member: READER })).status).toBe(404);
      expect((await call('GET', '/funding-figures/board', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/funding-figures/board', { member: B_USER, tenantId: TENANT_B })).json).toMatchObject({ projects: [] });
      expect((await call('GET', '/funding-figures/history?project_id=x', { member: READER })).status).toBe(422);
    });
  });
});

import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, PrjProjectStore, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { capModule } from '../../src/modules/cap';
import { CapitalPlanApprovalController } from '../../src/modules/cap/plan-approval.controller';
import { CapitalPlanController, CapitalPlanLinesController } from '../../src/modules/cap/plan.controller';
import { CapitalPlanRevisionController } from '../../src/modules/cap/plan-revision.controller';
import { ScenarioController } from '../../src/modules/cap/scenario.controller';
import { CAP_METRICS } from '../../src/modules/cap/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, id as familyId, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const PLANNER = 2; // drafts, submits and revises the plan
const APPROVER = 3; // approves the plan
const PUBLISHER = 4; // publishes the plan
const RUNNER = 5; // capital.scenario.run on the whole tenant
const PROPOSER = 6; // capital.reallocation.propose on the whole tenant
const READER = 7; // capital.read
const BRANCH_READER = 8; // capital.read on another branch
const BOTH = 9; // runs scenarios and proposes reallocations
const BRANCH_RUNNER = 10; // runs scenarios on another branch only
const NOBODY = 11;
const B_PLANNER = 1; // of tenant B
const ROOT = 1;
const BQL1 = 2;
const ELSEWHERE = 3;
const BILLION = 1_000_000_000;
const TODAY = vietnamDateOf(new Date());
const FAMILY = 0xae;
const READS = ['capital.read', 'plan_version.read', 'allocation_line.read'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface World {
  planId: string;
  planVersion: number;
  year: number;
  /** Project and line of each of the three: A and B draw on the central appropriation, C on the local one. */
  a: { project: string; line: string };
  b: { project: string; line: string };
  c: { project: string; line: string };
  central: string;
  local: string;
  snapshotId: string;
}

/** The simulation of an allocation over HTTP (ST-CAP-013, CAP-09, CAP 3.1 F8, UAT-AC233, UAT-PLAN-65). */
describe('the simulation of an allocation (ST-CAP-013)', () => {
  const harness = new AuthzHarness();
  const projects = new PrjProjectStore();
  let app: RunningApp;
  let counter = 0;
  let yearCounter = 2090;
  const versions: Record<string, string> = {};

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const money = (billions: number): string => String(billions * BILLION);
  const freshYear = (): number => {
    yearCounter -= 1;
    return yearCounter;
  };

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string | number }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const versionOf = (reply: Reply): number => reply.json.resource_version as number;
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

  async function document(): Promise<string> {
    const documentId = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
      [TENANT_A, documentId, `QD-${documentId.slice(0, 8)}`, memberId(PLANNER)],
    );
    return documentId;
  }

  async function appropriation(year: number, amount: string, source: string, level: 'CENTRAL' | 'LOCAL', origin: string): Promise<string> {
    const appropriationId = randomUUID();
    await rows(
      `insert into machvon.appropriation
         (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
       values ($1, $2, $3, $4, $9, $10, $5::numeric, 0, $6, 'Thủ tướng Chính phủ', $4, 1, 'PUBLISHED', $7, $8, $8)`,
      [TENANT_A, appropriationId, source, year, amount, await document(), memberId(APPROVER), memberId(PLANNER), origin, level],
    );
    return appropriationId;
  }

  async function project(): Promise<string> {
    counter += 1;
    const number = counter;
    const code = `RA-${number}-${randomUUID().slice(0, 6)}`;
    const created = await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(PLANNER), scopeVersion: 1 }, (tx) =>
      projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(BQL1), areaMasterVersionId: versions.area as string, totalInvestmentVnd: '500000000000' }, memberId(PLANNER), TODAY),
    );
    await rows('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, 'PIPELINE', 'B', String(7000000 + number)]);
    return created.id;
  }

  async function seedMaster(name: string, masterType: string, attributes: Record<string, unknown>): Promise<string> {
    counter += 1;
    const recordId = randomUUID();
    const versionId = randomUUID();
    const key = `${name}-${counter}`;
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, 'EFFECTIVE', $5, $5)`, [TENANT_A, recordId, masterType, key, memberId(PLANNER)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1, $5, $6::jsonb, '2020-01-01', 'EFFECTIVE', $7, now(), $8, $8)`,
        [TENANT_A, versionId, masterType, key, `Label ${key}`, JSON.stringify(attributes), recordId, memberId(PLANNER)],
      ],
    ]);
    return versionId;
  }

  /** A close snapshot of a period, FROZEN or not, with a line for each project (the basis the proposal quotes). */
  async function snapshot(frozen: boolean, projectIds: string[] = []): Promise<string> {
    counter += 1;
    const periodId = familyId(FAMILY, 1000 + counter);
    const snapshotId = randomUUID();
    await seed([
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2027, 'OPEN', $5, $6, $6)`,
        [TENANT_A, periodId, `RAP-${counter}`, new Date(Date.UTC(2042, 0, 2) + counter * 7 * 86_400_000).toISOString().slice(0, 10), familyId(FAMILY, 40), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', now(), '2027-10-31', '2027-10-31', 'BUILDING', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', $4, $5, $5)`,
        [TENANT_A, snapshotId, periodId, projectIds.length, WORKER_MEMBERSHIP_ID],
      ],
      ...projectIds.map((projectId): [string, unknown[]] => [
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
         values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', 1000, 1000, 120, 'COMPLETE')`,
        [TENANT_A, snapshotId, projectId, unitId(BQL1)],
      ]),
      ...(frozen
        ? ([[`update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('a', 64), frozen_by = $2, frozen_at = now() where id = $1`, [snapshotId, WORKER_MEMBERSHIP_ID]]] as Array<[string, unknown[]]>)
        : []),
    ]);
    return snapshotId;
  }

  /** Takes a plan to PUBLISHED through the three commands. */
  async function carry(planId: string, version: number, effectiveAt: string): Promise<number> {
    const submitted = await call('POST', `/capital-plans/${planId}/submit`, { member: PLANNER, ifMatch: version, body: {} });
    expect(submitted.status).toBe(200);
    const decided = await call('POST', `/capital-plans/${planId}/decision`, { member: APPROVER, ifMatch: versionOf(submitted), body: { decision: 'approve', reason: 'Reviewed against the decision' } });
    expect(decided.status).toBe(200);
    const published = await call('POST', `/plans/${planId}/publish`, { member: PUBLISHER, ifMatch: versionOf(decided), body: { decision_document_id: await document(), effective_at: effectiveAt } });
    expect(published.status).toBe(200);
    return versionOf(published);
  }

  /** A published plan of three projects: A (5 billion) and B (1 billion) on the central appropriation, C (2 billion) on the local one; and a frozen snapshot of them. */
  async function world(): Promise<World> {
    const year = freshYear();
    const central = await appropriation(year, money(50), versions.nstw as string, 'CENTRAL', 'PM_ASSIGNED');
    const local = await appropriation(year, money(50), versions.nsdp as string, 'LOCAL', 'LOCAL_ADDED');
    const [a, b, c] = [await project(), await project(), await project()];
    counter += 1;
    const created = await call('POST', '/capital-plans', {
      member: PLANNER,
      body: { plan_code: `RA-${counter}-${randomUUID().slice(0, 6)}`, plan_kind: 'ANNUAL', plan_year: year, period_from_year: year, period_to_year: year, scope_unit_id: unitId(ROOT) },
    });
    expect(created.status).toBe(200);
    const planId = idOf(created);
    const line = (project_id: string, appropriation_id: string, billions: number) => ({ project_id, appropriation_id, bucket: 'CURRENT_YEAR', source_year: year, amount_vnd: money(billions) });
    const drafted = await call('POST', `/capital-plans/${planId}/allocations`, { member: PLANNER, ifMatch: versionOf(created), body: { lines: [line(a, central, 5), line(b, central, 1), line(c, local, 2)] } });
    expect(drafted.status).toBe(200);
    const planVersion = await carry(planId, versionOf(drafted), '2030-06-30T00:00:00Z');
    const lines = await rows<{ id: string; project_id: string }>('select al.id, al.project_id from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid', [planId]);
    const lineOf = (projectId: string): string => lines.find((candidate) => candidate.project_id === projectId)?.id as string;
    return {
      planId,
      planVersion,
      year,
      a: { project: a, line: lineOf(a) },
      b: { project: b, line: lineOf(b) },
      c: { project: c, line: lineOf(c) },
      central,
      local,
      snapshotId: await snapshot(true, [a, b, c]),
    };
  }


  let codeCounter = 0;
  const scenarioBody = (w: World, moves: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
    code: `SC-${(codeCounter += 1)}-${randomUUID().slice(0, 6)}`,
    plan_year: w.year,
    base_capital_plan_id: w.planId,
    input_snapshot_id: w.snapshotId,
    constraints: {},
    assumptions: { moves },
    ...extra,
  });
  const move = (from: { line: string }, to: { project: string }, billions: number, extra: Record<string, unknown> = {}) => ({ from_allocation_line_id: from.line, to_project_id: to.project, amount_vnd: money(billions), ...extra });
  const create = (body: Record<string, unknown>, member = RUNNER): Promise<Reply> => call('POST', '/allocation-scenarios', { member, body });
  const run = (scenarioId: string, version: number, member = RUNNER): Promise<Reply> => call('POST', `/allocation-scenarios/${scenarioId}/run`, { member, ifMatch: version, body: {} });
  const promote = (scenarioId: string, version: number, member = BOTH): Promise<Reply> => call('POST', `/allocation-scenarios/${scenarioId}/promote`, { member, ifMatch: version, body: {} });
  const list = (query = '', member = RUNNER, tenantId = TENANT_A): Promise<Reply> => call('GET', `/allocation-scenarios${query}`, { member, tenantId });
  const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
  const row = async (scenarioId: string) =>
    (await rows<{ status: string; result_json: Record<string, unknown> | null; promoted_proposal_id: string | null; version: string }>('select status, result_json, promoted_proposal_id, version::text as version from machvon.allocation_scenario where id = $1::uuid', [scenarioId]))[0]!;
  /** The tables a scenario must never write: how many rows they hold (the whole tenant, for the ledger and the lines). */
  const untouched = async (): Promise<Record<string, string>> => {
    const [counts] = await rows<Record<string, string>>(
      `select (select count(*) from machvon.capital_ledger_entry)::text as ledger, (select count(*) from machvon.allocation_line)::text as lines, (select count(*) from machvon.allocation_balance)::text as balances,
              (select coalesce(sum(amount_vnd), 0) from machvon.allocation_line)::text as allocated, (select count(*) from machvon.capital_plan)::text as plans, (select count(*) from machvon.fund_reservation)::text as reservations`,
    );
    return counts!;
  };

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: BQL1, path: `/${unitId(ROOT)}/${unitId(BQL1)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [PLANNER, APPROVER, PUBLISHER, RUNNER, PROPOSER, READER, BRANCH_READER, BOTH, BRANCH_RUNNER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_PLANNER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PLANNER', ['capital.plan.draft', 'capital.plan.submit', ...READS], 40);
    await harness.seedRole(TENANT_A, 2, 'APPROVER', ['capital.plan.approve', ...READS], 50);
    await harness.seedRole(TENANT_A, 3, 'PUBLISHER', ['plan.publish', ...READS], 50);
    await harness.seedRole(TENANT_A, 4, 'RUNNER', ['capital.scenario.run', ...READS], 40);
    await harness.seedRole(TENANT_A, 5, 'PROPOSER', ['capital.reallocation.propose', ...READS], 40);
    await harness.seedRole(TENANT_A, 6, 'READER', READS, 20);
    await harness.seedRole(TENANT_A, 7, 'BOTH', ['capital.scenario.run', 'capital.reallocation.propose', ...READS], 60);
    await harness.seedRole(TENANT_B, 1, 'PLANNER', ['capital.plan.draft', 'capital.plan.submit', 'capital.scenario.run', 'capital.reallocation.propose', ...READS], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PLANNER, role: 1, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 2, kind: 'TENANT' },
      { n: 3, member: PUBLISHER, role: 3, kind: 'TENANT' },
      { n: 4, member: RUNNER, role: 4, kind: 'TENANT' },
      { n: 5, member: PROPOSER, role: 5, kind: 'TENANT' },
      { n: 6, member: READER, role: 6, kind: 'TENANT' },
      { n: 7, member: BRANCH_READER, role: 6, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 8, member: BOTH, role: 7, kind: 'TENANT' },
      { n: 9, member: BRANCH_RUNNER, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_PLANNER, role: 1, kind: 'TENANT' }]);
    versions.nstw = await seedMaster('NSTW-DTPT', 'FUND_SOURCE', { category: 'NSTW', relation: 'ADDITIVE' });
    versions.nsdp = await seedMaster('NSDP-DTPT', 'FUND_SOURCE', { category: 'NSDP', relation: 'ADDITIVE' });
    versions.area = await seedMaster('AREA', 'AREA', {});
    const tenants = harness.tenants as TenantDatabase;
    const metrics: MetricsSink = { increment: () => undefined, gauge: () => undefined };
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [CapitalPlanController, CapitalPlanApprovalController, CapitalPlanLinesController, CapitalPlanRevisionController, ScenarioController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: CAP_METRICS, useValue: metrics }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of CAP', () => {
    expect(capModule.controllers).toContain(ScenarioController);
  });

  describe('UAT-AC233: a scenario is created, run and read without touching the ledger', () => {
    it('keeps the assumptions and the limits, and writes only the scenario: the ledger, the lines, the balances, the plans and the reservations are as they were', async () => {
      const w = await world();
      const before = await untouched();
      const made = await create(scenarioBody(w, [move(w.a, w.b, 2, { rationale: 'Project A is behind the curve' })], { constraints: { min_remaining_vnd: money(1), max_total_vnd: money(3) } }));
      expect(made).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
      const scenarioId = idOf(made);
      expect(await row(scenarioId)).toMatchObject({ status: 'DRAFT', result_json: null, promoted_proposal_id: null });
      const ran = await run(scenarioId, 1);
      expect(ran).toMatchObject({ status: 200, json: { status: 'RUN', resource_version: 2 } });
      const stored = await row(scenarioId);
      expect(stored.result_json).toMatchObject({
        total_moved_vnd: money(2),
        moves: [{ from_allocation_line_id: w.a.line, to_project_id: w.b.project, amount_vnd: money(2) }],
        lines: [
          { allocation_line_id: [w.a.line, w.b.line].sort()[0], before_vnd: expect.any(String), after_vnd: expect.any(String) },
          { allocation_line_id: [w.a.line, w.b.line].sort()[1], before_vnd: expect.any(String), after_vnd: expect.any(String) },
        ],
      });
      const result = stored.result_json as unknown as { lines: Array<Record<string, string>>; projects: Array<Record<string, string>> };
      const lineA = result.lines.find((line) => line.allocation_line_id === w.a.line)!;
      const lineB = result.lines.find((line) => line.allocation_line_id === w.b.line)!;
      expect([lineA.before_vnd, lineA.after_vnd, lineA.minimum_vnd]).toEqual([money(5), money(3), money(1)]);
      expect([lineB.before_vnd, lineB.after_vnd]).toEqual([money(1), money(3)]);
      // The total of the projects does not change: the scenario moves capital, it does not make any.
      expect(result.projects.reduce((total, project) => total + BigInt(project.after_vnd as string) - BigInt(project.before_vnd as string), 0n)).toBe(0n);
      expect(await untouched()).toEqual(before);
      // Reading it changes nothing either, and it is listed with what the caller may do with it.
      const listed = await list(`?plan_year=${w.year}`);
      expect(listed.status).toBe(200);
      expect(items(listed)).toEqual([
        expect.objectContaining({
          id: scenarioId,
          status: 'RUN',
          version: 2,
          input_snapshot_id: w.snapshotId,
          base_capital_plan: expect.objectContaining({ id: w.planId }),
          actions: { run: true, promote: false },
          constraints: { min_remaining_vnd: money(1), max_total_vnd: money(3) },
        }),
      ]);
      expect(await untouched()).toEqual(before);
    });

    it('shows a project with everything the plan gives it, not only the lines the moves name', async () => {
      const w = await world();
      // A second line of project A, of an earlier source year, that no move names.
      await seed([
        ['create temp table extra_line as select * from machvon.allocation_line where id = $1::uuid', [w.a.line]],
        ["update extra_line set id = gen_random_uuid(), source_year = source_year - 1, amount_vnd = $1::numeric", [money(7)]],
        ['insert into machvon.allocation_line select * from extra_line', []],
        // Its balance holds less than the plan gave it (capital that lapsed): the project is shown by the balance, as its lines are.
        ['create temp table extra_balance as select * from machvon.allocation_balance where allocation_line_id = $1::uuid', [w.a.line]],
        ['update extra_balance set id = gen_random_uuid(), allocation_line_id = (select id from extra_line), allocated_vnd = $1::numeric', [money(4)]],
        ['insert into machvon.allocation_balance select * from extra_balance', []],
      ]);
      const scenarioId = idOf(await create(scenarioBody(w, [move(w.a, w.b, 2)])));
      expect((await run(scenarioId, 1)).status).toBe(200);
      const result = (await row(scenarioId)).result_json as unknown as { projects: Array<Record<string, string>>; lines: Array<Record<string, string>> };
      expect(result.projects.find((project) => project.project_id === w.a.project)).toMatchObject({ before_vnd: money(9), after_vnd: money(7) });
      expect(result.projects.find((project) => project.project_id === w.b.project)).toMatchObject({ before_vnd: money(1), after_vnd: money(3) });
      expect(result.lines.find((line) => line.allocation_line_id === w.a.line)).toMatchObject({ before_vnd: money(5), after_vnd: money(3) });
    });

    it('can be run again until it is promoted: the result is that of the last run, and a stale version is 409 VERSION_CONFLICT', async () => {
      const w = await world();
      const scenarioId = idOf(await create(scenarioBody(w, [move(w.a, w.b, 1)])));
      expect((await run(scenarioId, 1)).status).toBe(200);
      const first = (await row(scenarioId)).result_json as { ran_at: string };
      expect(await run(scenarioId, 1)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await run(scenarioId, 2)).toMatchObject({ status: 200, json: { status: 'RUN', resource_version: 3 } });
      expect(((await row(scenarioId)).result_json as { ran_at: string }).ran_at >= first.ran_at).toBe(true);
    });

    it('is 422 SCENARIO_CONSTRAINT_INFEASIBLE when a limit is broken, with each broken limit named and nothing kept: the scenario stays a draft and the ledger is as it was', async () => {
      const w = await world();
      const before = await untouched();
      const tooMuch = idOf(await create(scenarioBody(w, [move(w.a, w.b, 4)], { constraints: { min_remaining_vnd: money(2) } })));
      const refused = await run(tooMuch, 1);
      expect(refused).toMatchObject({ status: 422, json: { code: 'SCENARIO_CONSTRAINT_INFEASIBLE' } });
      expect(refused.json.violations).toEqual([expect.objectContaining({ kind: 'BELOW_MINIMUM', line_id: w.a.line, allocated_vnd: money(5), reduced_vnd: money(4), minimum_vnd: money(2) })]);
      expect(await row(tooMuch)).toMatchObject({ status: 'DRAFT', result_json: null, version: '1' });

      const limits = idOf(await create(scenarioBody(w, [move(w.a, w.b, 2), move(w.b, w.a, 1)], { constraints: { max_move_vnd: money(1), max_total_vnd: money(2) } })));
      const broken = await run(limits, 1);
      expect(broken).toMatchObject({ status: 422, json: { code: 'SCENARIO_CONSTRAINT_INFEASIBLE' } });
      expect((broken.json.violations as Array<{ kind: string }>).map((violation) => violation.kind)).toEqual(['MOVE_ABOVE_LIMIT', 'TOTAL_ABOVE_LIMIT']);

      // A project that holds no line on the same appropriation cannot receive: C draws on the local one, A on the central one.
      const nowhere = idOf(await create(scenarioBody(w, [move(w.a, w.c, 1)])));
      const unreachable = await run(nowhere, 1);
      expect(unreachable).toMatchObject({ status: 422, json: { code: 'SCENARIO_CONSTRAINT_INFEASIBLE' } });
      expect(unreachable.json.violations).toEqual([{ kind: 'NO_RECIPIENT_LINE', move: 0, to_project_id: w.c.project }]);
      expect(await untouched()).toEqual(before);
    });

    it('keeps on a donor line at least what is reserved, committed and disbursed on it, as a proposal does', async () => {
      const w = await world();
      await seed([[`update machvon.allocation_balance set reserved_vnd = $2::numeric where allocation_line_id = $1::uuid`, [w.a.line, money(4)]]]);
      const scenarioId = idOf(await create(scenarioBody(w, [move(w.a, w.b, 2)])));
      const refused = await run(scenarioId, 1);
      expect(refused).toMatchObject({ status: 422, json: { code: 'SCENARIO_CONSTRAINT_INFEASIBLE' } });
      expect(refused.json.violations).toEqual([expect.objectContaining({ kind: 'BELOW_MINIMUM', line_id: w.a.line, minimum_vnd: money(4) })]);
      const fits = idOf(await create(scenarioBody(w, [move(w.a, w.b, 1)])));
      expect((await run(fits, 1)).status).toBe(200);
    });

    it('judges a line that gives and receives by the difference', async () => {
      const w = await world();
      const scenarioId = idOf(await create(scenarioBody(w, [move(w.a, w.b, 5), move(w.b, w.a, 5)])));
      expect((await run(scenarioId, 1)).status).toBe(200);
      const result = (await row(scenarioId)).result_json as { lines: Array<Record<string, string>> };
      expect(result.lines.map((line) => [line.before_vnd, line.after_vnd])).toEqual([[expect.any(String), expect.any(String)], [expect.any(String), expect.any(String)]]);
      for (const line of result.lines) expect(line.after_vnd).toBe(line.before_vnd);
    });
  });

  describe('UAT-PLAN-65: promoted to a DRAFT reallocation proposal once it has been run', () => {
    it('is 409 SCENARIO_NOT_RUN before it has a result; after it, the proposal is a DRAFT with the moves as its lines and the scenario is PROMOTED, with nothing written to the ledger', async () => {
      const w = await world();
      const scenarioId = idOf(await create(scenarioBody(w, [move(w.a, w.b, 2, { rationale: 'Project A is behind the curve' })])));
      expect(await promote(scenarioId, 1)).toMatchObject({ status: 409, json: { code: 'SCENARIO_NOT_RUN' } });
      expect((await run(scenarioId, 1)).status).toBe(200);
      const before = await untouched();
      const promoted = await promote(scenarioId, 2);
      expect(promoted).toMatchObject({ status: 200, json: { status: 'PROMOTED', resource_version: 3 } });
      const stored = await row(scenarioId);
      expect(stored).toMatchObject({ status: 'PROMOTED', version: '3' });
      const proposal = (await rows<{ status: string; code: string; basis_snapshot_id: string; source_capital_plan_id: string; created_by: string; reason: string }>(
        'select status, code, basis_snapshot_id, source_capital_plan_id, created_by, reason from machvon.reallocation_proposal where id = $1::uuid',
        [stored.promoted_proposal_id],
      ))[0]!;
      expect(proposal).toMatchObject({ status: 'DRAFT', basis_snapshot_id: w.snapshotId, source_capital_plan_id: w.planId, created_by: memberId(BOTH) });
      expect(proposal.code).toMatch(/^SCN-SC-/);
      expect(proposal.reason).toMatch(/Promoted from the allocation scenario SC-/);
      const lines = await rows<{ from_allocation_line_id: string; to_project_id: string; amount_vnd: string; rationale_json: { note: string } }>(
        'select from_allocation_line_id, to_project_id, amount_vnd::text as amount_vnd, rationale_json from machvon.reallocation_line where proposal_id = $1::uuid',
        [stored.promoted_proposal_id],
      );
      expect(lines).toEqual([expect.objectContaining({ from_allocation_line_id: w.a.line, to_project_id: w.b.project, amount_vnd: money(2), rationale_json: expect.objectContaining({ note: 'Project A is behind the curve' }) })]);
      // The proposal is the only thing the promotion added: no ledger entry, no line, no balance.
      expect({ ...(await untouched()) }).toEqual(before);
      // The trail names the proposal and the scenario, never the words of the rationale.
      const audit = await rows<{ action: string; diff: Record<string, unknown> }>(`select action, safe_diff as diff from machvon.audit_event where resource_id = $1::uuid order by occurred_at`, [scenarioId]);
      expect(audit.map((entry) => entry.action)).toEqual(['capital.scenario_created', 'capital.scenario_run', 'capital.scenario_promoted']);
      expect(JSON.stringify(audit)).not.toContain('behind the curve');
      // A promoted scenario is final.
      expect(await promote(scenarioId, 3)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect(await run(scenarioId, 3)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect(items(await list(`?status=PROMOTED`))[0]).toMatchObject({ id: scenarioId, promoted_proposal_id: stored.promoted_proposal_id, actions: { run: false, promote: false } });
    });

    it('is judged again when it is promoted: a plan whose lines changed since the run makes it 422 SCENARIO_CONSTRAINT_INFEASIBLE and nothing is promoted', async () => {
      const w = await world();
      const scenarioId = idOf(await create(scenarioBody(w, [move(w.a, w.b, 2)])));
      expect((await run(scenarioId, 1)).status).toBe(200);
      await seed([[`update machvon.allocation_balance set committed_vnd = $2::numeric where allocation_line_id = $1::uuid`, [w.a.line, money(4)]]]);
      expect(await promote(scenarioId, 2)).toMatchObject({ status: 422, json: { code: 'SCENARIO_CONSTRAINT_INFEASIBLE' } });
      expect(await row(scenarioId)).toMatchObject({ status: 'RUN', promoted_proposal_id: null });
    });

    it('needs a frozen snapshot to rest on: none is 422 VALIDATION_FAILED, one that is not frozen is 422 SNAPSHOT_NOT_FROZEN', async () => {
      const w = await world();
      const without = idOf(await create(scenarioBody(w, [move(w.a, w.b, 1)], { input_snapshot_id: undefined })));
      expect((await run(without, 1)).status).toBe(200);
      expect(await promote(without, 2)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'input_snapshot_id' } });
      const building = idOf(await create(scenarioBody(w, [move(w.a, w.b, 1)], { input_snapshot_id: await snapshot(false, [w.a.project]) })));
      expect((await run(building, 1)).status).toBe(200);
      expect(await promote(building, 2)).toMatchObject({ status: 422, json: { code: 'SNAPSHOT_NOT_FROZEN' } });
      expect(await row(building)).toMatchObject({ status: 'RUN' });
    });

    it('fits the code of the proposal in 50 characters whatever the code of the scenario, and a code taken by another proposal is 409 DUPLICATE_KEY', async () => {
      const w = await world();
      const long = `L${randomUUID()}-${randomUUID().slice(0, 12)}`.slice(0, 50);
      const scenarioId = idOf(await create(scenarioBody(w, [move(w.a, w.b, 1)], { code: long })));
      expect((await run(scenarioId, 1)).status).toBe(200);
      const promoted = await promote(scenarioId, 2);
      expect(promoted.status).toBe(200);
      const proposalCode = (await rows<{ code: string }>('select code from machvon.reallocation_proposal where id = $1::uuid', [(await row(scenarioId)).promoted_proposal_id]))[0]!.code;
      expect(proposalCode).toHaveLength(50);
      const again = idOf(await create(scenarioBody(w, [move(w.a, w.b, 1)], { code: 'SC-TAKEN' })));
      expect((await run(again, 1)).status).toBe(200);
      await rows(
        `insert into machvon.reallocation_proposal (tenant_id, id, code, plan_year, scope_unit_id, basis_snapshot_id, source_capital_plan_id, reason, status, created_by, updated_by)
         values ($1, gen_random_uuid(), 'SCN-SC-TAKEN', $2, $3, $4, $5, 'A proposal that took the code of a scenario', 'DRAFT', $6, $6)`,
        [TENANT_A, w.year, unitId(ROOT), w.snapshotId, w.planId, memberId(PROPOSER)],
      );
      expect(await promote(again, 2)).toMatchObject({ status: 409, json: { code: 'DUPLICATE_KEY', detail: 'code' } });
      expect(await row(again)).toMatchObject({ status: 'RUN', promoted_proposal_id: null });
    });
  });

  describe('what is asked is judged', () => {
    it('refuses assumptions and constraints that are not a list of moves and whole amounts (422 VALIDATION_FAILED naming the field)', async () => {
      const w = await world();
      const one = move(w.a, w.b, 1);
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ assumptions: {} }, 'assumptions.moves'],
        [{ assumptions: { moves: [] } }, 'assumptions.moves'],
        [{ assumptions: { moves: [one], note: 'x' } }, 'assumptions.note'],
        [{ assumptions: { moves: [{ ...one, amount_vnd: '0' }] } }, 'assumptions.moves[0].amount_vnd'],
        [{ assumptions: { moves: [{ ...one, amount_vnd: '1.5' }] } }, 'assumptions.moves[0].amount_vnd'],
        [{ assumptions: { moves: [{ ...one, to_project_id: 'x' }] } }, 'assumptions.moves[0].to_project_id'],
        [{ assumptions: { moves: [{ ...one, extra: 1 }] } }, 'assumptions.moves[0].extra'],
        [{ assumptions: { moves: [one, one] } }, 'assumptions.moves[1].from_allocation_line_id'],
        [{ constraints: { floor: '1' } }, 'constraints.floor'],
        [{ constraints: { max_move_vnd: '0' } }, 'constraints.max_move_vnd'],
        [{ constraints: { min_remaining_vnd: '-1' } }, 'constraints.min_remaining_vnd'],
        [{ plan_year: w.year + 1 }, 'plan_year'],
        [{ input_snapshot_id: randomUUID() }, 'input_snapshot_id'],
      ];
      for (const [extra, field] of cases) {
        expect(await create(scenarioBody(w, [one], extra))).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: field } });
      }
      expect(await create(scenarioBody(w, [one], { base_capital_plan_id: randomUUID() }))).toMatchObject({ status: 404 });
    });

    it('simulates a plan in force only: one still being drawn up is 409 PLAN_NOT_PUBLISHED when the scenario is created, and a plan that is no longer in force when it is run', async () => {
      const w = await world();
      const drafting = await call('POST', '/capital-plans', {
        member: PLANNER,
        body: { plan_code: `SC-DRAFT-${randomUUID().slice(0, 6)}`, plan_kind: 'ANNUAL', plan_year: w.year, period_from_year: w.year, period_to_year: w.year, scope_unit_id: unitId(ROOT) },
      });
      expect(drafting.status).toBe(200);
      expect(await create(scenarioBody(w, [move(w.a, w.b, 1)], { base_capital_plan_id: idOf(drafting) }))).toMatchObject({ status: 409, json: { code: 'PLAN_NOT_PUBLISHED', detail: 'base_capital_plan_id' } });
      const scenarioId = idOf(await create(scenarioBody(w, [move(w.a, w.b, 1)])));
      await seed([["update machvon.capital_plan set status = 'SUPERSEDED' where id = $1::uuid", [w.planId]]]);
      expect(await run(scenarioId, 1)).toMatchObject({ status: 409, json: { code: 'PLAN_NOT_PUBLISHED' } });
      expect(await row(scenarioId)).toMatchObject({ status: 'DRAFT', result_json: null });
    });

    it('refuses a line that is not in the plan when it is run (422 VALIDATION_FAILED) and a code that is taken (409 DUPLICATE_KEY)', async () => {
      const w = await world();
      const body = scenarioBody(w, [move({ line: randomUUID() }, w.b, 1)]);
      const made = await create(body);
      expect(made.status).toBe(200);
      expect(await run(idOf(made), 1)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'lines[0].from_allocation_line_id' } });
      expect(await create(body)).toMatchObject({ status: 409, json: { code: 'DUPLICATE_KEY', detail: 'code' } });
    });
  });

  describe('who may do what', () => {
    it('is refused to someone without the permission, over another branch, or without the permission of the step: a runner cannot promote and a proposer cannot run', async () => {
      const w = await world();
      const body = scenarioBody(w, [move(w.a, w.b, 1)]);
      expect(await create(body, READER)).toMatchObject({ status: 403 });
      expect(await create(body, NOBODY)).toMatchObject({ status: 403 });
      expect(await create(body, BRANCH_RUNNER)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await create(body, PROPOSER)).toMatchObject({ status: 403 });
      const scenarioId = idOf(await create(body));
      expect(await run(scenarioId, 1, PROPOSER)).toMatchObject({ status: 403 });
      expect(await run(scenarioId, 1, BRANCH_RUNNER)).toMatchObject({ status: 403 });
      expect((await run(scenarioId, 1)).status).toBe(200);
      expect(await promote(scenarioId, 2, RUNNER)).toMatchObject({ status: 403 });
      expect(await promote(scenarioId, 2, BRANCH_RUNNER)).toMatchObject({ status: 403 });
      expect(await row(scenarioId)).toMatchObject({ status: 'RUN' });
      expect((await promote(scenarioId, 2, PROPOSER)).status).toBe(200);
    });

    it('is read by those who may read the capital over the unit of the plan, with the actions each may take; another branch and another tenant see nothing', async () => {
      const w = await world();
      const scenarioId = idOf(await create(scenarioBody(w, [move(w.a, w.b, 1)])));
      expect((await run(scenarioId, 1)).status).toBe(200);
      expect(items(await list(`?plan_year=${w.year}`, READER)).map((item) => [item.id, item.actions])).toEqual([[scenarioId, { run: false, promote: false }]]);
      expect(items(await list(`?plan_year=${w.year}`, BOTH)).map((item) => item.actions)).toEqual([{ run: true, promote: true }]);
      expect(items(await list(`?plan_year=${w.year}`, PROPOSER)).map((item) => item.actions)).toEqual([{ run: false, promote: true }]);
      expect(items(await list(`?plan_year=${w.year}`, BRANCH_READER))).toEqual([]);
      expect(items(await list(`?plan_year=${w.year}`, B_PLANNER, TENANT_B))).toEqual([]);
      expect(await list('', NOBODY)).toMatchObject({ status: 403 });
      expect(await call('POST', `/allocation-scenarios/${scenarioId}/run`, { member: B_PLANNER, tenantId: TENANT_B, ifMatch: 2 })).toMatchObject({ status: 404 });
      expect(await call('POST', `/allocation-scenarios/${scenarioId}/promote`, { member: B_PLANNER, tenantId: TENANT_B, ifMatch: 2 })).toMatchObject({ status: 404 });
    });

    it('is listed newest first a page at a time, narrowed by status and year, and a filter that is not one is 422', async () => {
      const w = await world();
      const made: string[] = [];
      for (let index = 0; index < 3; index += 1) made.push(idOf(await create(scenarioBody(w, [move(w.a, w.b, 1)]))));
      expect((await run(made[1]!, 1)).status).toBe(200);
      const first = await list(`?plan_year=${w.year}&limit=2`);
      expect(items(first).map((item) => item.id)).toEqual([made[2], made[1]]);
      const cursor = first.json.next_cursor as string;
      expect(cursor).toEqual(expect.any(String));
      const second = await list(`?plan_year=${w.year}&limit=2&cursor=${encodeURIComponent(cursor)}`);
      expect(items(second).map((item) => item.id)).toEqual([made[0]]);
      expect(second.json.next_cursor).toBeNull();
      expect(items(await list(`?plan_year=${w.year}&status=RUN`)).map((item) => item.id)).toEqual([made[1]]);
      expect(await list('?status=SOON')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'status' } });
      expect(await list('?plan_year=20x')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'plan_year' } });
    });
  });

  describe('the database keeps what was asked', () => {
    it('does not let the question change, a result appear without a run, a promoted scenario move, or a scenario be deleted', async () => {
      const w = await world();
      const scenarioId = idOf(await create(scenarioBody(w, [move(w.a, w.b, 1)])));
      const refused = (sql: string) => expect(rows(sql, [scenarioId])).rejects.toMatchObject({ code: '23514' });
      await refused(`update machvon.allocation_scenario set assumptions_json = '{"moves": []}'::jsonb where id = $1::uuid`);
      await refused(`update machvon.allocation_scenario set constraints_json = '{"max_move_vnd": "1"}'::jsonb where id = $1::uuid`);
      await refused(`update machvon.allocation_scenario set code = 'OTHER' where id = $1::uuid`);
      await refused(`update machvon.allocation_scenario set status = 'RUN' where id = $1::uuid`);
      await refused(`update machvon.allocation_scenario set status = 'PROMOTED', result_json = '{}'::jsonb where id = $1::uuid`);
      await refused(`update machvon.allocation_scenario set result_json = '{}'::jsonb where id = $1::uuid`);
      await expect(
        rows(`insert into machvon.allocation_scenario (tenant_id, id, code, plan_year, base_capital_plan_id, constraints_json, assumptions_json, status, created_by, updated_by)
              select tenant_id, gen_random_uuid(), 'SC-RUN-INSERT', plan_year, base_capital_plan_id, '{}'::jsonb, '{}'::jsonb, 'RUN', created_by, created_by from machvon.allocation_scenario where id = $1::uuid`, [scenarioId]),
      ).rejects.toMatchObject({ code: '23514' });
      expect((await run(scenarioId, 1)).status).toBe(200);
      await refused(`update machvon.allocation_scenario set status = 'DRAFT', result_json = null where id = $1::uuid`);
      expect((await promote(scenarioId, 2)).status).toBe(200);
      await refused(`update machvon.allocation_scenario set status = 'RUN' where id = $1::uuid`);
      await refused(`update machvon.allocation_scenario set result_json = '{"ran_at": "x"}'::jsonb where id = $1::uuid`);
      expect((await rows<{ del: boolean; trunc: boolean }>("select has_table_privilege('machvon_app', 'machvon.allocation_scenario', 'DELETE') as del, has_table_privilege('machvon_app', 'machvon.allocation_scenario', 'TRUNCATE') as trunc"))[0]).toEqual({ del: false, trunc: false });
    });
  });
});

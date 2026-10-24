import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, PrjProjectStore, TenantDatabase } from '@machvon/db';
import { assertOneWinner, loadErrorRegistry, runConcurrently, runLoops, signTenantContext, tallyOutcomes, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AllocationLineReadsController, CapitalPlanController, CapitalPlanLinesController, PlanVersionReadsController } from '../../src/modules/cap/plan.controller';
import { CAP_METRICS } from '../../src/modules/cap/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const PLANNER = 1; // the whole tenant: capital.plan.draft and the reads
const BQL1_PLANNER = 2; // the same permissions on the subtree of BQL1 only
const READER = 3; // capital.read, plan_version.read, allocation_line.read: does not draft
const NOBODY = 4;
const SECOND_PLANNER = 5;
const APPROVER = 6; // capital.plan.approve: sees the revisions in work
const OTHER_TENANT_PLANNER = 1; // of tenant B
const ROOT = 1;
const BQL1 = 2;
const BQL2 = 3;
const BILLION = 1_000_000_000;
const TODAY = vietnamDateOf(new Date());
const DRAFTING = ['capital.plan.draft', 'capital.read', 'plan_version.read', 'allocation_line.read'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('capital plan drafting commands and reads (ST-CAP-002)', () => {
  const harness = new AuthzHarness();
  const projects = new PrjProjectStore();
  let app: RunningApp;
  let counter = 0;
  let yearCounter = 2100;
  const versions: Record<string, string> = {};
  const counted: Array<{ name: string; labels: Record<string, string> | undefined }> = [];
  const gauges: Array<{ name: string; labels: Record<string, string> | undefined }> = [];

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const money = (billions: number): string => String(billions * BILLION);
  const million = (millions: number): string => String(millions * 1_000_000);
  const freshYear = (): number => {
    yearCounter -= 1;
    return yearCounter;
  };

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const versionOf = (reply: Reply): number => reply.json.resource_version as number;
  const itemsOf = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;

  async function document(tenant = TENANT_A): Promise<string> {
    const id = randomUUID();
    await harness.owner(tenant, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
        [tenant, id, `QD-${id.slice(0, 8)}`, memberId(PLANNER)],
      ],
    ]);
    return id;
  }

  /** A published appropriation, written the way a decision leaves it. */
  async function appropriation(year: number, amount: string, options: { fund?: string; allocated?: string; origin?: string } = {}, tenant = TENANT_A): Promise<string> {
    const id = randomUUID();
    await harness.owner(tenant, [
      [
        `insert into machvon.appropriation
           (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
         values ($1, $2, $3, $4, $5, 'CENTRAL', $6::numeric, 0, $7, 'Thủ tướng Chính phủ', $4, 1, 'PUBLISHED', $8, $9, $9)`,
        [tenant, id, options.fund ?? versions.nstw, year, options.origin ?? 'PM_ASSIGNED', amount, await document(tenant), memberId(APPROVER), memberId(PLANNER)],
      ],
    ]);
    return id;
  }

  async function project(unit = BQL1, status = 'PIPELINE', tenant = TENANT_A): Promise<string> {
    counter += 1;
    const number = counter;
    const code = `AP-${number}-${randomUUID().slice(0, 6)}`;
    const created = await harness.tenants.withTenant(contextFor(tenant, memberId(PLANNER)), (tx) =>
      projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(unit), areaMasterVersionId: tenant === TENANT_A ? (versions.area as string) : (versions.areaB as string), totalInvestmentVnd: '500000000000' }, memberId(PLANNER), TODAY),
    );
    await harness.owner(tenant, [['update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, status, 'B', String(8000000 + number)]]]);
    return created.id;
  }

  async function seedMaster(name: string, masterType: string, attributes: Record<string, unknown>, tenant = TENANT_A): Promise<string> {
    counter += 1;
    const recordId = randomUUID();
    const versionId = randomUUID();
    const key = `${name}-${counter}`;
    await harness.owner(tenant, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, 'EFFECTIVE', $5, $5)`, [tenant, recordId, masterType, key, memberId(PLANNER)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1, $5, $6::jsonb, '2020-01-01', 'EFFECTIVE', $7, now(), $8, $8)`,
        [tenant, versionId, masterType, key, `Label ${key}`, JSON.stringify(attributes), recordId, memberId(PLANNER)],
      ],
    ]);
    return versionId;
  }

  const createPlan = (year: number, overrides: Record<string, unknown> = {}, member = PLANNER, tenantId?: string): Promise<Reply> => {
    counter += 1;
    return call('POST', '/capital-plans', {
      member,
      ...(tenantId === undefined ? {} : { tenantId }),
      body: { plan_code: `CP-${counter}-${randomUUID().slice(0, 6)}`, plan_kind: 'ANNUAL', plan_year: year, period_from_year: year, period_to_year: year, scope_unit_id: unitId(ROOT), ...overrides },
    });
  };

  const lineBody = (target: { project: string; appropriation: string; year: number }, amount: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    project_id: target.project,
    appropriation_id: target.appropriation,
    bucket: 'CURRENT_YEAR',
    source_year: target.year,
    amount_vnd: amount,
    ...extra,
  });
  const draft = (planId: string, version: number, lines: Array<Record<string, unknown>>, options: { member?: number; key?: string; remove?: string[]; note?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', `/capital-plans/${planId}/allocations`, {
      member: options.member ?? PLANNER,
      ifMatch: `"${version}"`,
      ...(options.key === undefined ? {} : { key: options.key }),
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      body: { lines, ...(options.remove === undefined ? {} : { remove_line_ids: options.remove }), ...(options.note === undefined ? {} : { note: options.note }) },
    });
  const linesOf = (planId: string, member = PLANNER, query = '', tenantId?: string): Promise<Reply> => call('GET', `/capital-plans/${planId}/lines${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: BQL1, path: `/${unitId(ROOT)}/${unitId(BQL1)}/`, parent: ROOT },
        { n: BQL2, path: `/${unitId(ROOT)}/${unitId(BQL2)}/`, parent: ROOT },
      ]);
    }
    for (const n of [PLANNER, BQL1_PLANNER, READER, NOBODY, SECOND_PLANNER, APPROVER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_PLANNER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'CAPITAL_PLANNER', DRAFTING, 40);
    await harness.seedRole(TENANT_A, 2, 'CAPITAL_READER', ['capital.read', 'plan_version.read', 'allocation_line.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'CAPITAL_APPROVER', ['capital.plan.approve', 'capital.read', 'plan_version.read', 'allocation_line.read'], 50);
    await harness.seedRole(TENANT_B, 1, 'CAPITAL_PLANNER', DRAFTING, 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PLANNER, role: 1, kind: 'TENANT' },
      { n: 2, member: BQL1_PLANNER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(BQL1)] },
      { n: 3, member: READER, role: 2, kind: 'TENANT' },
      { n: 4, member: SECOND_PLANNER, role: 1, kind: 'TENANT' },
      { n: 5, member: APPROVER, role: 3, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_PLANNER, role: 1, kind: 'TENANT' }]);
    versions.nstw = await seedMaster('NSTW-DTPT', 'FUND_SOURCE', { category: 'NSTW', relation: 'ADDITIVE' });
    versions.nsdp = await seedMaster('NSDP-DTPT', 'FUND_SOURCE', { category: 'NSDP', relation: 'ADDITIVE' });
    versions.area = await seedMaster('AREA', 'AREA', {});
    versions.areaB = await seedMaster('AREA-B', 'AREA', {}, TENANT_B);
    const tenants = harness.tenants as TenantDatabase;
    const metrics: MetricsSink = {
      increment: (name, labels) => void counted.push({ name, labels }),
      gauge: (name, _value, labels) => void gauges.push({ name, labels }),
    };
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [CapitalPlanController, CapitalPlanLinesController, PlanVersionReadsController, AllocationLineReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: CAP_METRICS, useValue: metrics },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('createCapitalPlan', () => {
    it('creates revision 1 in DRAFT at version 1 for an annual and a medium-term plan, audited, without an event', async () => {
      const year = freshYear();
      const annual = await createPlan(year);
      expect(annual.status).toBe(200);
      expect(annual.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const medium = await createPlan(year, { plan_kind: 'MEDIUM_TERM', plan_year: undefined, period_from_year: year - 4, period_to_year: year });
      expect(medium.status).toBe(200);
      const stored = await rows<{ plan_kind: string; plan_year: number | null; revision: number; status: string; created_by: string }>(
        'select plan_kind, plan_year, revision, status, created_by from machvon.capital_plan where id = any($1::uuid[]) order by plan_kind',
        [[idOf(annual), idOf(medium)]],
      );
      expect(stored).toEqual([
        { plan_kind: 'ANNUAL', plan_year: year, revision: 1, status: 'DRAFT', created_by: memberId(PLANNER) },
        { plan_kind: 'MEDIUM_TERM', plan_year: null, revision: 1, status: 'DRAFT', created_by: memberId(PLANNER) },
      ]);
      const audit = await rows<{ action: string; diff: Record<string, unknown> }>('select action, safe_diff as diff from machvon.audit_event where resource_id = $1', [idOf(annual)]);
      expect(audit).toMatchObject([{ action: 'capital.plan_created', diff: { plan_kind: 'ANNUAL', plan_year: year, revision: 1, scope_unit_id: unitId(ROOT) } }]);
      expect(await rows('select 1 from machvon.outbox_event where aggregate_id = $1', [idOf(annual)])).toEqual([]);
    });

    it('answers 409 PLAN_CODE_DUPLICATE for a code in use and 409 FISCAL_YEAR_LOCKED for a locked year', async () => {
      const year = freshYear();
      const first = await createPlan(year, { plan_code: `DUP-${year}` });
      expect(first.status).toBe(200);
      const second = await createPlan(year, { plan_code: `DUP-${year}` });
      expect([second.status, second.json.code]).toEqual([409, 'PLAN_CODE_DUPLICATE']);
      const locked = freshYear();
      await rows(`insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, locked_at, locked_by, created_by, updated_by) values ($1, $2, $3, 'LOCKED', now(), $4, $4, $4)`, [TENANT_A, randomUUID(), locked, memberId(PLANNER)]);
      const refused = await createPlan(locked);
      expect([refused.status, refused.json.code]).toEqual([409, 'FISCAL_YEAR_LOCKED']);
    });

    it('judges the unit by the scope of the planner: a unit outside it is 403 SCOPE_DENIED, a unit that does not exist is 404', async () => {
      const year = freshYear();
      expect((await createPlan(year, { scope_unit_id: unitId(ROOT) }, BQL1_PLANNER)).json.code).toBe('SCOPE_DENIED');
      expect((await createPlan(year, { scope_unit_id: unitId(BQL2) }, BQL1_PLANNER)).status).toBe(403);
      const own = await createPlan(year, { scope_unit_id: unitId(BQL1) }, BQL1_PLANNER);
      expect(own.status).toBe(200);
      expect((await createPlan(year, { scope_unit_id: randomUUID() })).json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('has no write path for the status, the revision or the approver: the body allowlist refuses them, and a wrong shape is told by field', async () => {
      const year = freshYear();
      for (const [field, value] of [['status', 'PUBLISHED'], ['revision', 3], ['approved_by', memberId(APPROVER)], ['decision_document_id', randomUUID()]] as const) {
        const reply = await createPlan(year, { [field]: value });
        expect([reply.status, reply.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      }
      expect((await createPlan(year, { plan_kind: 'WEEKLY' })).status).toBeGreaterThanOrEqual(400);
      expect((await createPlan(year, { plan_year: year + 1 })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'period_from_year' });
      expect((await createPlan(year, { plan_kind: 'MEDIUM_TERM', plan_year: undefined, period_from_year: year, period_to_year: year })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'period_to_year' });
    });

    it('needs the permission to draft', async () => {
      const year = freshYear();
      expect((await createPlan(year, {}, READER)).status).toBe(403);
      expect((await createPlan(year, {}, NOBODY)).status).toBe(403);
      expect((await createPlan(year, {}, OTHER_TENANT_PLANNER, TENANT_B)).status).toBe(200);
    });
  });

  describe('draftCapitalAllocation', () => {
    it('drafts lines, moves the allocated total with them and audits each change with where the ceiling stood (AC-ST-CAP-002-3, UAT-AC222)', async () => {
      const year = freshYear();
      const target = await createPlan(year);
      const nstw = await appropriation(year, money(10));
      const nsdp = await appropriation(year, money(5), { fund: versions.nsdp });
      const first = await project();
      const result = await draft(
        idOf(target),
        1,
        [lineBody({ project: first, appropriation: nstw, year }, money(1), { ctmtqg_subset_vnd: million(400) }), lineBody({ project: first, appropriation: nsdp, year }, million(500))],
        { note: 'First proposal of the planning unit' },
      );
      expect(result.status).toBe(200);
      expect(result.json).toMatchObject({ status: 'DRAFT', resource_version: 2, resource_id: idOf(target) });
      const read = await linesOf(idOf(target));
      expect(read.json.totals).toEqual({ line_count: 2, allocated_vnd: '1500000000', ctmtqg_subset_vnd: '400000000' });
      expect((read.json.plan as Record<string, unknown>).totals).toMatchObject({ allocated_vnd: '1500000000', ceiling_vnd: money(15) });
      const audit = await rows<{ action: string; reason: string | null; diff: { plan_version_before: number; plan_version_after: number; changes: Array<Record<string, unknown>>; appropriations: Array<Record<string, unknown>> } }>(
        `select action, reason, safe_diff as diff from machvon.audit_event where resource_id = $1 and action like 'capital.plan_allocation%'`,
        [idOf(target)],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'capital.plan_allocation_drafted', reason: 'First proposal of the planning unit', diff: { plan_version_before: 1, plan_version_after: 2 } });
      expect(audit[0]?.diff.changes).toMatchObject([
        { kind: 'ADDED', project_id: first, appropriation_id: nstw, to_vnd: money(1), ctmtqg_to_vnd: million(400) },
        { kind: 'ADDED', project_id: first, appropriation_id: nsdp, to_vnd: million(500) },
      ]);
      expect(audit[0]?.diff.appropriations).toEqual(
        expect.arrayContaining([expect.objectContaining({ appropriation_id: nstw, allocated_before_vnd: '0', allocated_after_vnd: money(1) })]),
      );
    });

    it('answers 422 APPROPRIATION_EXCEEDED with available_vnd to a line larger than what is left (AC-ST-CAP-002-2, UAT-AC221)', async () => {
      const year = freshYear();
      const target = await createPlan(year);
      const source = await appropriation(year, money(10));
      const base = await project();
      const other = await project();
      expect((await draft(idOf(target), 1, [lineBody({ project: base, appropriation: source, year }, money(5))])).status).toBe(200);
      const refused = await draft(idOf(target), 2, [lineBody({ project: other, appropriation: source, year }, money(6))]);
      expect(refused.status).toBe(422);
      expect(refused.json).toMatchObject({ code: 'APPROPRIATION_EXCEEDED', detail: 'amount_vnd', available_vnd: '5000000000', appropriation_id: source });
      expect(counted).toContainEqual({ name: 'cap_allocation_conflict_total', labels: { code: 'APPROPRIATION_EXCEEDED' } });
      expect(gauges.some((entry) => entry.name === 'cap_draft_latency_ms')).toBe(true);
      expect((await rows<{ allocated: string }>('select allocated_total_vnd::text as allocated from machvon.appropriation where id = $1', [source]))[0]?.allocated).toBe(money(5));
    });

    it('refuses a CTMTQG larger than its line with 422 SUBSET_EXCEEDS_PARENT (AC-ST-CAP-002-3, UAT-AC222)', async () => {
      const year = freshYear();
      const target = await createPlan(year);
      const source = await appropriation(year, money(10));
      const first = await project();
      const refused = await draft(idOf(target), 1, [lineBody({ project: first, appropriation: source, year }, money(1), { ctmtqg_subset_vnd: million(1001) })]);
      expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'SUBSET_EXCEEDS_PARENT', 'ctmtqg_subset_vnd']);
    });

    it('answers a repeated Idempotency-Key with the first result and the same key with another payload with 409 IDEMPOTENCY_CONFLICT (AC-ST-CAP-002-4, UAT-AC238)', async () => {
      const year = freshYear();
      const target = await createPlan(year);
      const source = await appropriation(year, money(10));
      const first = await project();
      const key = `idem-${randomUUID()}`;
      const payload = [lineBody({ project: first, appropriation: source, year }, money(1))];
      const once = await draft(idOf(target), 1, payload, { key });
      const again = await draft(idOf(target), 1, payload, { key });
      expect(once.status).toBe(200);
      expect(again.json).toMatchObject({ resource_id: idOf(target), resource_version: 2, status: 'DRAFT' });
      expect((await rows<{ allocated: string }>('select allocated_total_vnd::text as allocated from machvon.appropriation where id = $1', [source]))[0]?.allocated).toBe(money(1));
      const other = await draft(idOf(target), 1, [lineBody({ project: first, appropriation: source, year }, money(2))], { key });
      expect([other.status, other.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      expect((await rows<{ allocated: string }>('select allocated_total_vnd::text as allocated from machvon.appropriation where id = $1', [source]))[0]?.allocated).toBe(money(1));
    });

    it('reads the lines of the projects in the scope of the reader and refuses to write a project outside the scope of the writer with 404 (AC-ST-CAP-002-5, UAT-AC237)', async () => {
      const year = freshYear();
      const target = await createPlan(year);
      const source = await appropriation(year, money(10));
      const mine = await project(BQL1);
      const theirs = await project(BQL2);
      const saved = await draft(idOf(target), 1, [lineBody({ project: mine, appropriation: source, year }, money(1)), lineBody({ project: theirs, appropriation: source, year }, money(2))]);
      expect(saved.status).toBe(200);
      const seen = await linesOf(idOf(target), BQL1_PLANNER);
      expect(seen.status).toBe(200);
      expect(itemsOf(seen).map((item) => (item.project as Record<string, unknown>).id)).toEqual([mine]);
      expect(seen.json.totals).toMatchObject({ line_count: 1, allocated_vnd: money(1) });
      expect(itemsOf(await linesOf(idOf(target), PLANNER))).toHaveLength(2);
      const refused = await draft(idOf(target), versionOf(saved), [lineBody({ project: theirs, appropriation: source, year }, money(3))], { member: BQL1_PLANNER });
      expect([refused.status, refused.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const written = await draft(idOf(target), versionOf(saved), [lineBody({ project: mine, appropriation: source, year }, money(2))], { member: BQL1_PLANNER });
      expect(written.status).toBe(200);
      const theirLine = itemsOf(await linesOf(idOf(target), PLANNER)).find((item) => (item.project as Record<string, unknown>).id === theirs)?.id as string;
      const removal = await draft(idOf(target), versionOf(written), [lineBody({ project: mine, appropriation: source, year }, money(2))], { member: BQL1_PLANNER, remove: [theirLine] });
      expect([removal.status, removal.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });

    it('lets only one of two planners who save with the same If-Match win and tells the other 409 VERSION_CONFLICT with a safe diff (AC-ST-CAP-002-6, UAT-NFR-SECURITY-05)', async () => {
      const year = freshYear();
      const target = await createPlan(year);
      const source = await appropriation(year, money(10));
      const [a, b, c] = [await project(), await project(), await project()] as [string, string, string];
      let version = 1;
      for (const [index, who] of [a, b, c].entries()) {
        const step = await draft(idOf(target), version, [lineBody({ project: who, appropriation: source, year }, million(100 + index))]);
        version = versionOf(step);
      }
      expect(version).toBe(4);
      const stale = await draft(idOf(target), 3, [lineBody({ project: a, appropriation: source, year }, million(900))], { member: SECOND_PLANNER });
      expect(stale.status).toBe(409);
      expect(stale.json).toMatchObject({ code: 'VERSION_CONFLICT', current_version: 4, safe_diff: { status: 'DRAFT', line_count: 3 } });
      const outcomes = await runConcurrently(
        [PLANNER, SECOND_PLANNER].map((member, index) => async () => {
          const reply = await draft(idOf(target), 4, [lineBody({ project: a, appropriation: source, year }, million(200 + index))], { member });
          return { status: reply.status, ...(reply.status === 200 ? {} : { code: reply.json.code as string }) };
        }),
      );
      assertOneWinner(outcomes, ['409 VERSION_CONFLICT']);
      expect(counted).toContainEqual({ name: 'cap_allocation_conflict_total', labels: { code: 'VERSION_CONFLICT' } });
    });

    it('lets exactly one of two planners who draft 800 million at the same moment win when 9 of 10 billion are taken, and tells the other what is available (AC-ST-CAP-002-1, UAT-AC08)', async () => {
      const year = freshYear();
      const source = await appropriation(year, money(10));
      const racers = [await createPlan(year), await createPlan(year)];
      const racerProjects = [await project(), await project()] as [string, string];
      const base = await createPlan(year);
      await draft(idOf(base), 1, [lineBody({ project: await project(), appropriation: source, year }, money(9))]);
      const rounds = await runLoops({
        loops: 6,
        reset: async () => {
          for (const racer of racers) {
            await rows('delete from machvon.allocation_line where plan_version_id in (select id from machvon.plan_version where capital_plan_id = $1::uuid)', [idOf(racer)]);
            await rows('delete from machvon.plan_version where capital_plan_id = $1::uuid', [idOf(racer)]);
            await rows('update machvon.capital_plan set version = 1 where id = $1::uuid', [idOf(racer)]);
          }
          await harness.owner(TENANT_A, [["select set_config('app.cap_allocation_write', 'on', false)"], ['update machvon.appropriation set allocated_total_vnd = $2::numeric where id = $1::uuid', [source, money(9)]]]);
        },
        commands: () =>
          racers.map((racer, index) => async () => {
            const reply = await draft(idOf(racer), 1, [lineBody({ project: racerProjects[index] as string, appropriation: source, year }, million(800))], { member: index === 0 ? PLANNER : SECOND_PLANNER });
            if (reply.status !== 200) expect(reply.json).toMatchObject({ code: 'APPROPRIATION_EXCEEDED', available_vnd: million(200) });
            return { status: reply.status, ...(reply.status === 200 ? {} : { code: reply.json.code as string }) };
          }),
        verify: async ({ outcomes }) => {
          assertOneWinner(outcomes, ['422 APPROPRIATION_EXCEEDED']);
          const [row] = await rows<{ amount: string; allocated: string }>('select amount_vnd::text as amount, allocated_total_vnd::text as allocated from machvon.appropriation where id = $1', [source]);
          expect(row).toEqual({ amount: money(10), allocated: '9800000000' });
        },
      });
      expect(tallyOutcomes(rounds.flatMap((round) => round.outcomes))).toEqual({ '200': 6, '422 APPROPRIATION_EXCEEDED': 6 });
    }, 120_000);

    it('has no write path for the allocated total: the body allowlist refuses it, and so it does a status or a plan version', async () => {
      const year = freshYear();
      const target = await createPlan(year);
      const source = await appropriation(year, money(10));
      const first = await project();
      for (const field of ['allocated_total_vnd', 'status', 'version']) {
        const reply = await call('POST', `/capital-plans/${idOf(target)}/allocations`, { member: PLANNER, ifMatch: '"1"', body: { lines: [lineBody({ project: first, appropriation: source, year }, money(1))], [field]: 1 } });
        expect([reply.status, reply.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      }
      const inLine = await call('POST', `/capital-plans/${idOf(target)}/allocations`, { member: PLANNER, ifMatch: '"1"', body: { lines: [lineBody({ project: first, appropriation: source, year }, money(1), { allocated_total_vnd: '1' })] } });
      expect([inLine.status, inLine.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      expect((await rows<{ allocated: string }>('select allocated_total_vnd::text as allocated from machvon.appropriation where id = $1', [source]))[0]?.allocated).toBe('0');
    });

    it('needs the permission, the version, a plan of the tenant and a plan that is still a draft', async () => {
      const year = freshYear();
      const target = await createPlan(year);
      const source = await appropriation(year, money(10));
      const first = await project();
      const lines = [lineBody({ project: first, appropriation: source, year }, money(1))];
      expect((await draft(idOf(target), 1, lines, { member: READER })).status).toBe(403);
      expect((await draft(idOf(target), 1, lines, { member: NOBODY })).status).toBe(403);
      expect((await draft(idOf(target), 1, lines, { member: OTHER_TENANT_PLANNER, tenantId: TENANT_B })).json.code).toBe('RESOURCE_NOT_FOUND');
      expect((await draft(randomUUID(), 1, lines)).json.code).toBe('RESOURCE_NOT_FOUND');
      const missing = await call('POST', `/capital-plans/${idOf(target)}/allocations`, { member: PLANNER, body: { lines } });
      expect(missing.status).toBeGreaterThanOrEqual(400);
      expect(missing.json.code).not.toBe('APPROPRIATION_EXCEEDED');
      const first200 = await draft(idOf(target), 1, lines);
      expect(first200.status).toBe(200);
      await rows("update machvon.capital_plan set status = 'IN_REVIEW', submitted_by = $2::uuid where id = $1::uuid", [idOf(target), memberId(PLANNER)]);
      const current = Number((await rows<{ version: string }>('select version::text as version from machvon.capital_plan where id = $1', [idOf(target)]))[0]?.version);
      const closed = await draft(idOf(target), current, [lineBody({ project: first, appropriation: source, year }, money(2))]);
      expect([closed.status, closed.json.code]).toEqual([409, 'PLAN_NOT_DRAFT']);
    });

    it('takes a line for a project in the stages that take capital only, and a removal at any time (PROJECT_STAGE_INVALID)', async () => {
      const year = freshYear();
      const target = await createPlan(year);
      const source = await appropriation(year, money(10));
      const concept = await project(BQL1, 'CONCEPT');
      const refused = await draft(idOf(target), 1, [lineBody({ project: concept, appropriation: source, year }, money(1))]);
      expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'PROJECT_STAGE_INVALID', 'project_id']);
      const funded = await project(BQL1, 'IMPLEMENTATION');
      const saved = await draft(idOf(target), 1, [lineBody({ project: funded, appropriation: source, year }, money(1))]);
      expect(saved.status).toBe(200);
    });
  });

  describe('a command that only removes lines (CR-CAP-01)', () => {
    it('takes an empty lines array with the ids to remove, frees the capital, and removes every line of a plan; the store still needs one of the two', async () => {
      const year = freshYear();
      const target = await createPlan(year);
      const source = await appropriation(year, money(10));
      const [a, b] = [await project(), await project()] as [string, string];
      const added = await draft(idOf(target), 1, [lineBody({ project: a, appropriation: source, year }, money(2)), lineBody({ project: b, appropriation: source, year }, money(3))]);
      const stored = await rows<{ id: string; project_id: string }>('select al.id, al.project_id from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1', [idOf(target)]);
      const first = stored.find((line) => line.project_id === a) as { id: string };
      const second = stored.find((line) => line.project_id === b) as { id: string };
      const one = await draft(idOf(target), versionOf(added), [], { remove: [first.id] });
      expect(one.status).toBe(200);
      expect((await rows<{ allocated: string }>('select allocated_total_vnd::text as allocated from machvon.appropriation where id = $1', [source]))[0]?.allocated).toBe(money(3));
      const all = await draft(idOf(target), versionOf(one), [], { remove: [second.id] });
      expect(all.status).toBe(200);
      expect(await rows('select 1 from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1', [idOf(target)])).toEqual([]);
      expect((await rows<{ allocated: string }>('select allocated_total_vnd::text as allocated from machvon.appropriation where id = $1', [source]))[0]?.allocated).toBe('0');
      const nothing = await draft(idOf(target), versionOf(all), []);
      expect([nothing.status, nothing.json.code, nothing.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'lines']);
    });
  });

  describe('the reads of the plans', () => {
    it('lists the revisions to the people who draft and approve, and only the revisions in force to a reader; a draft by id is 404 for the reader', async () => {
      const year = freshYear();
      const drafted = await createPlan(year);
      const published = await createPlan(year);
      await rows("update machvon.capital_plan set status = 'IN_REVIEW', submitted_by = $2::uuid where id = $1::uuid", [idOf(published), memberId(PLANNER)]);
      await rows("update machvon.capital_plan set status = 'APPROVED', approved_by = $2::uuid where id = $1::uuid", [idOf(published), memberId(APPROVER)]);
      await rows("update machvon.capital_plan set status = 'PUBLISHED', decision_document_id = $2::uuid, effective_at = now(), published_at = now() where id = $1::uuid", [idOf(published), await document()]);
      const list = (member: number, tenantId?: string) => call('GET', `/resources/plan_version?plan_year=${year}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
      expect(itemsOf(await list(PLANNER)).map((item) => item.id)).toEqual([idOf(published), idOf(drafted)]);
      expect(itemsOf(await list(APPROVER)).map((item) => item.id)).toEqual([idOf(published), idOf(drafted)]);
      expect(itemsOf(await list(READER)).map((item) => item.id)).toEqual([idOf(published)]);
      expect(itemsOf(await list(OTHER_TENANT_PLANNER, TENANT_B))).toEqual([]);
      expect((await call('GET', `/resources/plan_version/${idOf(drafted)}`, { member: READER })).status).toBe(404);
      expect((await linesOf(idOf(drafted), READER)).status).toBe(404);
      expect((await linesOf(idOf(published), READER)).status).toBe(200);
      expect((await call('GET', `/resources/plan_version/${idOf(drafted)}`, { member: PLANNER })).status).toBe(200);
      expect((await call('GET', `/resources/plan_version/${idOf(drafted)}`, { member: OTHER_TENANT_PLANNER, tenantId: TENANT_B })).status).toBe(404);
      expect((await linesOf(idOf(drafted), OTHER_TENANT_PLANNER, '', TENANT_B)).status).toBe(404);
      expect((await call('GET', `/resources/plan_version?plan_kind=NOPE`, { member: PLANNER })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'plan_kind' });
      expect((await call('GET', `/resources/plan_version?status=NOPE`, { member: PLANNER })).json).toMatchObject({ detail: 'status' });
      expect((await call('GET', `/resources/plan_version?plan_year=20x6`, { member: PLANNER })).json).toMatchObject({ detail: 'plan_year' });
      expect((await call('GET', `/resources/plan_version?plan_kind=ANNUAL&status=PUBLISHED&plan_year=${year}`, { member: PLANNER })).json.items).toHaveLength(1);
      expect((await call('GET', '/resources/plan_version', { member: NOBODY })).status).toBe(403);
    });

    it('shows the plan by id with its projects in the scope of the caller, as an allowlist without internal columns', async () => {
      const year = freshYear();
      const target = await createPlan(year);
      const source = await appropriation(year, money(10));
      const mine = await project(BQL1);
      const theirs = await project(BQL2);
      await draft(idOf(target), 1, [lineBody({ project: mine, appropriation: source, year }, money(1)), lineBody({ project: theirs, appropriation: source, year }, money(2))]);
      const whole = await call('GET', `/resources/plan_version/${idOf(target)}`, { member: PLANNER });
      expect(whole.json).toMatchObject({ id: idOf(target), plan_kind: 'ANNUAL', plan_year: year, status: 'DRAFT', version: 2, scope_unit: { id: unitId(ROOT) }, totals: { line_count: 2, allocated_vnd: money(3) } });
      expect((whole.json.projects as unknown[]).length).toBe(2);
      const narrow = await call('GET', `/resources/plan_version/${idOf(target)}`, { member: BQL1_PLANNER });
      expect((narrow.json.projects as Array<Record<string, unknown>>).map((item) => item.project_id)).toEqual([mine]);
      expect(narrow.json.totals).toMatchObject({ line_count: 1, allocated_vnd: money(1) });
      expect(Object.keys(whole.json).sort()).toEqual(
        ['decision_document', 'effective_at', 'fund_sources', 'id', 'period_from_year', 'period_to_year', 'plan_code', 'plan_kind', 'plan_year', 'projects', 'published_at', 'revision', 'scope_unit', 'status', 'supersedes_id', 'totals', 'version'].sort(),
      );
    });

    it('reads the lines of one plan with filters and a cursor, and the scaffold reads of the allocation line, as an allowlist', async () => {
      const year = freshYear();
      const target = await createPlan(year);
      const nstw = await appropriation(year, money(10));
      const nsdp = await appropriation(year, money(5), { fund: versions.nsdp });
      const [a, b] = [await project(), await project()] as [string, string];
      await draft(idOf(target), 1, [lineBody({ project: a, appropriation: nstw, year }, money(1)), lineBody({ project: b, appropriation: nsdp, year }, money(2)), lineBody({ project: b, appropriation: nstw, year }, money(3))]);
      const all = await linesOf(idOf(target));
      expect(itemsOf(all)).toHaveLength(3);
      const first = itemsOf(all).find((item) => (item.project as Record<string, unknown>).id === a && (item.appropriation as Record<string, unknown>).id === nstw) as Record<string, unknown>;
      expect(Object.keys(first).sort()).toEqual(
        [
          'amount_vnd', 'appropriation', 'bucket', 'budget_level', 'capital_plan_id', 'committed_vnd', 'ctmtqg_subset_vnd', 'extended_to', 'extension_document', 'fund_source', 'id', 'is_extended', 'origin',
          'plan_code', 'plan_status', 'previous_line_id', 'program', 'project', 'reserved_vnd', 'source_year', 'version',
        ].sort(),
      );
      expect(first.appropriation).toMatchObject({ id: nstw, plan_year: year, amount_vnd: money(10), allocated_total_vnd: money(4), remaining_vnd: money(6) });
      expect(itemsOf(await linesOf(idOf(target), PLANNER, `?project_id=${b}`))).toHaveLength(2);
      expect(itemsOf(await linesOf(idOf(target), PLANNER, `?fund_source_version_id=${versions.nsdp}`))).toHaveLength(1);
      const page1 = await linesOf(idOf(target), PLANNER, '?limit=2');
      expect(itemsOf(page1)).toHaveLength(2);
      expect(page1.json.next_cursor).toEqual(expect.any(String));
      expect(page1.json.totals).toMatchObject({ line_count: 3, allocated_vnd: money(6) });
      const page2 = await linesOf(idOf(target), PLANNER, `?limit=2&cursor=${page1.json.next_cursor as string}`);
      expect(itemsOf(page2)).toHaveLength(1);
      expect([...itemsOf(page1), ...itemsOf(page2)].map((item) => item.id)).toEqual(itemsOf(all).map((item) => item.id));
      expect((await linesOf(idOf(target), PLANNER, '?project_id=nope')).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'project_id' });
      expect((await linesOf(idOf(target), PLANNER, '?limit=0')).json).toMatchObject({ detail: 'limit' });
      const scaffold = await call('GET', '/resources/allocation_line?limit=200', { member: PLANNER });
      expect(itemsOf(scaffold).map((item) => item.id)).toEqual(expect.arrayContaining(itemsOf(all).map((item) => item.id)));
      const one = await call('GET', `/resources/allocation_line/${first.id as string}`, { member: PLANNER });
      expect(one.json).toMatchObject({ id: first.id, amount_vnd: money(1) });
      expect((await call('GET', `/resources/allocation_line/${first.id as string}`, { member: READER })).status).toBe(404);
      expect((await call('GET', `/resources/allocation_line/${first.id as string}`, { member: OTHER_TENANT_PLANNER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/resources/allocation_line/${first.id as string}`, { member: BQL1_PLANNER })).status).toBe(200);
      expect((await call('GET', `/resources/allocation_line/${randomUUID()}`, { member: PLANNER })).status).toBe(404);
      expect((await call('GET', '/resources/allocation_line', { member: NOBODY })).status).toBe(403);
      expect(itemsOf(await call('GET', '/resources/allocation_line', { member: OTHER_TENANT_PLANNER, tenantId: TENANT_B }))).toEqual([]);
    });
  });
});

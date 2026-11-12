import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, PrjProjectStore, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { capModule } from '../../src/modules/cap';
import { CapitalPlanApprovalController } from '../../src/modules/cap/plan-approval.controller';
import { CapitalPlanController, CapitalPlanLinesController } from '../../src/modules/cap/plan.controller';
import { DisbursementScheduleController } from '../../src/modules/cap/schedule.controller';
import { CAP_METRICS } from '../../src/modules/cap/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PLANNER = 2; // capital.plan.draft and capital.plan.submit on the whole tenant
const APPROVER = 3; // capital.plan.approve on the whole tenant
const PUBLISHER = 4; // plan.publish on the whole tenant
const INVESTOR = 5; // capital.schedule.register and capital.read on the whole tenant
const BQL1_INVESTOR = 6; // the same on the subtree of BQL1 only
const READER = 7; // capital.read: no registration
const NOBODY = 8;
const B_INVESTOR = 1; // of tenant B
const ROOT = 1;
const BQL1 = 2;
const BQL2 = 3;
const MILLION = 1_000_000;
const TODAY = vietnamDateOf(new Date());
const REGISTER = ['capital.schedule.register', 'capital.read'];
const PLAN_READS = ['capital.read', 'plan_version.read', 'allocation_line.read'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the registration of the disbursement schedule over HTTP (ST-CAP-009)', () => {
  const harness = new AuthzHarness();
  const projects = new PrjProjectStore();
  let app: RunningApp;
  let counter = 0;
  let yearCounter = 2100;
  const versions: Record<string, string> = {};

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const millions = (n: number): string => String(n * MILLION);
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

  async function document(): Promise<string> {
    const id = randomUUID();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
        [TENANT_A, id, `QD-${id.slice(0, 8)}`, memberId(PLANNER)],
      ],
    ]);
    return id;
  }

  async function project(unit = BQL1, tenant = TENANT_A): Promise<string> {
    counter += 1;
    const code = `SH-${counter}-${randomUUID().slice(0, 6)}`;
    const area = tenant === TENANT_A ? versions.area : versions.areaB;
    const created = await harness.tenants.withTenant({ tenantId: tenant, membershipId: memberId(tenant === TENANT_A ? PLANNER : B_INVESTOR), scopeVersion: 1 }, (tx) =>
      projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(unit), areaMasterVersionId: area as string, totalInvestmentVnd: '500000000000' }, memberId(tenant === TENANT_A ? PLANNER : B_INVESTOR), TODAY),
    );
    await rows('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, 'PIPELINE', 'B', String(9000000 + counter)], tenant);
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

  /** A project with a line in a published plan: the Treasury's payments (ledger entries) hang on that line. */
  async function funded(year: number): Promise<{ projectId: string; appropriationId: string; lineId: string }> {
    const appropriationId = randomUUID();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.appropriation
           (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
         values ($1, $2, $3, $4, 'PM_ASSIGNED', 'CENTRAL', $5::numeric, 0, $6, 'Thủ tướng Chính phủ', $4, 1, 'PUBLISHED', $7, $8, $8)`,
        [TENANT_A, appropriationId, versions.nstw, year, millions(10_000), await document(), memberId(APPROVER), memberId(PLANNER)],
      ],
    ]);
    const projectId = await project();
    counter += 1;
    const created = await call('POST', '/capital-plans', {
      member: PLANNER,
      body: { plan_code: `SH-${counter}-${randomUUID().slice(0, 6)}`, plan_kind: 'ANNUAL', plan_year: year, period_from_year: year, period_to_year: year, scope_unit_id: unitId(ROOT) },
    });
    expect(created.status).toBe(200);
    const planId = idOf(created);
    const drafted = await call('POST', `/capital-plans/${planId}/allocations`, {
      member: PLANNER,
      ifMatch: `"${versionOf(created)}"`,
      body: { lines: [{ project_id: projectId, appropriation_id: appropriationId, bucket: 'CURRENT_YEAR', source_year: year, amount_vnd: millions(1_000) }] },
    });
    expect(drafted.status).toBe(200);
    const submitted = await call('POST', `/capital-plans/${planId}/submit`, { member: PLANNER, ifMatch: `"${versionOf(drafted)}"`, body: {} });
    const decided = await call('POST', `/capital-plans/${planId}/decision`, { member: APPROVER, ifMatch: `"${versionOf(submitted)}"`, body: { decision: 'approve', reason: 'Reviewed against the decision' } });
    const published = await call('POST', `/plans/${planId}/publish`, { member: PUBLISHER, ifMatch: `"${versionOf(decided)}"`, body: { decision_document_id: await document(), effective_at: '2026-01-15T00:00:00Z' } });
    expect(published.status).toBe(200);
    const line = (await rows<{ id: string }>('select al.id from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid', [planId]))[0];
    return { projectId, appropriationId, lineId: line?.id as string };
  }

  const pay = (target: { projectId: string; appropriationId: string; lineId: string }, year: number, amount: string, postedAt: string) =>
    rows(
      `insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, posted_at, posted_by)
       values ($1, $2, $3, $4, $5, 'DISBURSE', $6::numeric, $7, 'PAYMENT_REQUEST', $8, $9::timestamptz, $10)`,
      [TENANT_A, randomUUID(), target.appropriationId, target.lineId, target.projectId, amount, year, randomUUID(), postedAt, memberId(PLANNER)],
    );

  const body = (projectId: string, year: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    project_id: projectId,
    plan_year: year,
    granularity: 'MONTH',
    month: 10,
    kind: 'REGISTERED',
    bucket: 'CURRENT_YEAR',
    budget_level: 'CENTRAL',
    amount_vnd: millions(800),
    ...overrides,
  });
  const register = (payload: Record<string, unknown>, member = INVESTOR, options: { key?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', '/disbursement-schedules', { member, body: payload, ...(options.key === undefined ? {} : { key: options.key }), ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }) });
  const list = (query: string, member = INVESTOR, tenantId?: string): Promise<Reply> => call('GET', `/disbursement-schedules${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const countOf = async (projectId: string): Promise<number> => Number((await rows<{ n: string }>('select count(*)::text as n from machvon.disbursement_schedule_line where project_id = $1::uuid', [projectId]))[0]?.n);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: BQL1, path: `/${unitId(ROOT)}/${unitId(BQL1)}/`, parent: ROOT },
        { n: BQL2, path: `/${unitId(ROOT)}/${unitId(BQL2)}/`, parent: ROOT },
      ]);
    }
    for (const n of [PLANNER, APPROVER, PUBLISHER, INVESTOR, BQL1_INVESTOR, READER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_INVESTOR, ROOT);
    await harness.seedRole(TENANT_A, 2, 'PLANNER', ['capital.plan.draft', 'capital.plan.submit', ...PLAN_READS], 40);
    await harness.seedRole(TENANT_A, 3, 'APPROVER', ['capital.plan.approve', ...PLAN_READS], 50);
    await harness.seedRole(TENANT_A, 4, 'PUBLISHER', ['plan.publish', ...PLAN_READS], 50);
    await harness.seedRole(TENANT_A, 5, 'INVESTOR', REGISTER, 30);
    await harness.seedRole(TENANT_A, 6, 'READER', ['capital.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'INVESTOR', REGISTER, 30);
    await harness.seedGrants(TENANT_A, [
      { n: 2, member: PLANNER, role: 2, kind: 'TENANT' },
      { n: 3, member: APPROVER, role: 3, kind: 'TENANT' },
      { n: 4, member: PUBLISHER, role: 4, kind: 'TENANT' },
      { n: 5, member: INVESTOR, role: 5, kind: 'TENANT' },
      { n: 6, member: BQL1_INVESTOR, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(BQL1)] },
      { n: 7, member: READER, role: 6, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_INVESTOR, role: 1, kind: 'TENANT' }]);
    versions.nstw = await seedMaster('NSTW-DTPT', 'FUND_SOURCE', { category: 'NSTW', relation: 'ADDITIVE' });
    versions.area = await seedMaster('AREA', 'AREA', {});
    versions.areaB = await seedMaster('AREA-B', 'AREA', {}, TENANT_B);
    const tenants = harness.tenants as TenantDatabase;
    const metrics: MetricsSink = { increment: () => undefined, gauge: () => undefined };
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [CapitalPlanController, CapitalPlanApprovalController, CapitalPlanLinesController, DisbursementScheduleController],
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

  it('is registered in the module of CAP', () => {
    expect(capModule.controllers).toContain(DisbursementScheduleController);
  });

  describe('registerDisbursementSchedule', () => {
    it('registers a month: one audit row with the amount before and after, capital.schedule_registered.v1 once (also when the key is replayed), and nothing in the ledger', async () => {
      const year = freshYear();
      const target = await project();
      const ledger = await rows<{ n: string }>('select count(*)::text as n from machvon.capital_ledger_entry');
      const key = `register-${randomUUID()}`;
      const first = await register(body(target, year), INVESTOR, { key });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'CURRENT', resource_version: 1 });
      const replay = await register(body(target, year), INVESTOR, { key });
      expect([replay.status, replay.json.operation_id]).toEqual([200, first.json.operation_id]);
      expect(await countOf(target)).toBe(1);
      const second = await register(body(target, year, { amount_vnd: millions(900), ctmtqg_subset_vnd: millions(100), revision_reason: 'The contractor asked for more' }));
      expect(second.status).toBe(200);
      const audit = await rows<{ reason: string | null; diff: Record<string, unknown>; actor_id: string }>("select reason, safe_diff as diff, actor_id from machvon.audit_event where resource_id = $1::uuid and action = 'capital.schedule_registered'", [idOf(second)]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: memberId(INVESTOR), reason: 'The contractor asked for more', diff: { amount_vnd_before: millions(800), amount_vnd_after: millions(900), revision: 2, supersedes_id: idOf(first), month: 10, kind: 'REGISTERED' } });
      const events = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1::uuid and type = 'capital.schedule_registered.v1'", [idOf(first)]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ tenant_id: TENANT_A, project_id: target, plan_year: year, month: 10, kind: 'REGISTERED', amount_vnd: millions(800), revision: 1, supersedes_id: null });
      expect(await rows<{ n: string }>('select count(*)::text as n from machvon.capital_ledger_entry')).toEqual(ledger);
    });

    it('reads 300 million paid against 800 million registered as 0.3750 and keeps the 800 million registered (AC-ST-CAP-009-1)', async () => {
      const year = freshYear();
      const target = await funded(year);
      expect((await register(body(target.projectId, year))).status).toBe(200);
      await pay(target, year, millions(300), `${year}-10-15T03:00:00.000Z`);
      const read = await list(`?project_id=${target.projectId}&plan_year=${year}`);
      expect(read.status).toBe(200);
      const [row, ...more] = itemsOf(read);
      expect(more).toEqual([]);
      expect(row).toMatchObject({ amount_vnd: millions(800), month: 10, kind: 'REGISTERED', is_current: true, achievement: { disbursed_vnd: millions(300), rate: '0.3750' } });
      // Registering more later does not make the payment bigger, and the payment does not make the registration smaller.
      await register(body(target.projectId, year, { amount_vnd: millions(1_200) }));
      const again = itemsOf(await list(`?project_id=${target.projectId}&plan_year=${year}`));
      expect(again).toHaveLength(1);
      expect(again[0]).toMatchObject({ amount_vnd: millions(1_200), revision: 2, achievement: { disbursed_vnd: millions(300), rate: '0.2500' } });
    });

    it('UAT-AC231: October registers 800 million and the Treasury paid 500 million in it: the screen reads 800 million registered and 62.5 percent achieved, and the registration is never counted as disbursed (the numerator is the 500 million of the Treasury)', async () => {
      const year = freshYear();
      const target = await funded(year);
      const ledger = () => rows<{ n: string; total: string }>(`select count(*)::text as n, coalesce(sum(amount_vnd), 0)::text as total from machvon.capital_ledger_entry where project_id = $1::uuid and entry_type = 'DISBURSE'`, [target.projectId]);
      await pay(target, year, millions(500), `${year}-10-15T03:00:00.000Z`);
      const registered = await register(body(target.projectId, year));
      expect(registered.status).toBe(200);
      expect(registered.json).toMatchObject({ status: 'CURRENT', resource_version: 1 });
      // Registering moves no money: what the ledger holds as disbursed is still the 500 million of the Treasury.
      expect(await ledger()).toEqual([{ n: '1', total: millions(500) }]);
      const read = await list(`?project_id=${target.projectId}&plan_year=${year}&kind=REGISTERED`);
      const [row, ...more] = itemsOf(read);
      expect(more).toEqual([]);
      expect(row).toMatchObject({ amount_vnd: millions(800), month: 10, kind: 'REGISTERED', is_current: true, achievement: { disbursed_vnd: millions(500), rate: '0.6250' } });
      expect(row?.achievement).not.toMatchObject({ disbursed_vnd: millions(800) });
    });

    it('refuses a subset above the amount (422 SUBSET_EXCEEDS_PARENT), a forecast without its assumption, a registration in the wrong grain and a malformed body, writing nothing', async () => {
      const year = freshYear();
      const target = await project();
      const subset = await register(body(target, year, { ctmtqg_subset_vnd: millions(801) }));
      expect([subset.status, subset.json.code]).toEqual([422, 'SUBSET_EXCEEDS_PARENT']);
      expect((await register(body(target, year, { kind: 'FORECAST' }))).status).toBe(422);
      expect((await register(body(target, year, { granularity: 'WEEK', period_id: randomUUID() }))).status).toBe(422);
      expect((await register(body(target, year, { month: 14 }))).status).toBe(422);
      expect((await register(body(target, year, { amount_vnd: 'many' }))).status).toBe(422);
      expect((await register(body(target, year, { unknown: true }))).status).toBe(400);
      expect((await register({ ...body(target, year), project_id: undefined })).status).toBe(400);
      expect((await register(body(target, year, { revision_reason: 'x'.repeat(2001) }))).status).toBe(422);
      expect(await countOf(target)).toBe(0);
    });

    it('refuses a locked period (409 PERIOD_LOCKED) and a locked fiscal year (409 FISCAL_YEAR_LOCKED), and writes nothing (AC-ST-CAP-009-2)', async () => {
      const year = freshYear();
      const target = await project();
      const calendarId = await seedMaster('CAL', 'CALENDAR', {});
      await rows(
        `insert into machvon.reporting_period
           (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, soft_closed_at, locked_at, locked_by, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', $3, 'MONTH', $6, 'LOCKED', now(), now(), $7, $8, $7, $7)`,
        [TENANT_A, randomUUID(), `M-${year}`, `${year}-09-01`, `${year}-09-30`, year, memberId(PLANNER), calendarId],
      );
      const locked = await register(body(target, year, { month: 9 }));
      expect([locked.status, locked.json.code]).toEqual([409, 'PERIOD_LOCKED']);
      expect((await register(body(target, year, { month: 10 }))).status).toBe(200);
      await rows("insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, locked_at, locked_by, created_by, updated_by) values ($1, $2, $3, 'LOCKED', now(), $4, $4, $4)", [TENANT_A, randomUUID(), year, memberId(PLANNER)]);
      const closed = await register(body(target, year, { month: 11 }));
      expect([closed.status, closed.json.code]).toEqual([409, 'FISCAL_YEAR_LOCKED']);
      expect(await countOf(target)).toBe(1);
    });

    it('is for those who hold the permission on the project: a reader and a stranger get 403, a subtree investor gets 404 for a project outside it, and another tenant never sees the project (404)', async () => {
      const year = freshYear();
      const inside = await project(BQL1);
      const outside = await project(BQL2);
      for (const member of [READER, NOBODY]) {
        const refused = await register(body(inside, year), member);
        expect([member, refused.status]).toEqual([member, 403]);
      }
      expect((await register(body(inside, year), BQL1_INVESTOR)).status).toBe(200);
      expect((await register(body(outside, year), BQL1_INVESTOR)).status).toBe(404);
      expect((await register(body(outside, year), INVESTOR)).status).toBe(200);
      expect((await register(body(inside, year), B_INVESTOR, { tenantId: TENANT_B })).status).toBe(404);
      expect(await countOf(outside)).toBe(1);
      expect(await countOf(inside)).toBe(1);
    });

    it('takes the revisions of several requests at the same moment one after the other: each one a revision, one of them current', async () => {
      const year = freshYear();
      const target = await project();
      const replies = await Promise.all([1, 2, 3, 4].map((n) => register(body(target, year, { amount_vnd: millions(100 * n) }))));
      expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200]);
      const stored = await rows<{ revision: number; is_current: boolean }>('select revision, is_current from machvon.disbursement_schedule_line where project_id = $1::uuid order by revision', [target]);
      expect(stored.map((row) => row.revision)).toEqual([1, 2, 3, 4]);
      expect(stored.filter((row) => row.is_current)).toHaveLength(1);
    });
  });

  describe('listDisbursementSchedules', () => {
    it('lists the current registrations newest first in pages, and the history on request, narrowed by project, year, kind, grain and month', async () => {
      const year = freshYear();
      const target = await project();
      await register(body(target, year, { month: 1, amount_vnd: millions(1) }));
      await register(body(target, year, { month: 1, amount_vnd: millions(2) }));
      await register(body(target, year, { month: 2, amount_vnd: millions(3) }));
      await register(body(target, year, { kind: 'FORECAST', month: 3, assumption: 'Because' }));
      const base = `?project_id=${target}&plan_year=${year}`;
      const current = await list(base);
      expect(itemsOf(current).map((row) => [row.month, row.kind, row.amount_vnd])).toEqual([
        [3, 'FORECAST', millions(800)],
        [2, 'REGISTERED', millions(3)],
        [1, 'REGISTERED', millions(2)],
      ]);
      expect(current.json.as_of).toEqual(expect.any(String));
      expect(itemsOf(await list(`${base}&history=true`))).toHaveLength(4);
      expect(itemsOf(await list(`${base}&kind=FORECAST`)).map((row) => row.month)).toEqual([3]);
      expect(itemsOf(await list(`${base}&month=1`)).map((row) => row.amount_vnd)).toEqual([millions(2)]);
      expect(itemsOf(await list(`${base}&granularity=WEEK`))).toEqual([]);
      const page = await list(`${base}&history=true&limit=3`);
      expect(itemsOf(page)).toHaveLength(3);
      expect(page.json.next_cursor).toEqual(expect.any(String));
      const rest = await list(`${base}&history=true&limit=3&cursor=${encodeURIComponent(page.json.next_cursor as string)}`);
      expect(itemsOf(rest)).toHaveLength(1);
      expect(rest.json.next_cursor).toBeNull();
      expect(itemsOf(page)[0]).toMatchObject({ project: { id: target }, bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', granularity: 'MONTH', period: null, achievement: null });
    });

    it('shows a caller only the registrations of the projects in their scope, and nothing of another tenant (AC-ST-CAP-009)', async () => {
      const year = freshYear();
      const inside = await project(BQL1);
      const outside = await project(BQL2);
      await register(body(inside, year));
      await register(body(outside, year));
      const scoped = await list(`?plan_year=${year}`, BQL1_INVESTOR);
      expect(itemsOf(scoped).map((row) => (row.project as { id: string }).id)).toEqual([inside]);
      expect(itemsOf(await list(`?plan_year=${year}`, INVESTOR))).toHaveLength(2);
      expect(itemsOf(await list(`?plan_year=${year}`, READER))).toHaveLength(2);
      expect((await list(`?plan_year=${year}`, NOBODY)).status).toBe(403);
      expect(itemsOf(await list(`?plan_year=${year}`, B_INVESTOR, TENANT_B))).toEqual([]);
    });

    it.each([
      ['project_id=not-an-id', 'project_id'],
      ['plan_year=26', 'plan_year'],
      ['kind=ACTUAL', 'kind'],
      ['granularity=DAY', 'granularity'],
      ['month=14', 'month'],
      ['month=0', 'month'],
      ['history=maybe', 'history'],
    ])('refuses the query %s (422)', async (query) => {
      expect((await list(`?${query}`)).status).toBe(422);
    });
  });
});

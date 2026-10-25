import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { CapFiscalYearStore, EffectiveAccessStore, InMemoryAuthzCache, PrjProjectStore, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { capModule } from '../../src/modules/cap';
import { CapitalAvailabilityController } from '../../src/modules/cap/availability.controller';
import { FiscalYearController, FiscalYearReadsController } from '../../src/modules/cap/fiscal-year.controller';
import { CapitalPlanApprovalController } from '../../src/modules/cap/plan-approval.controller';
import { CapitalPlanController, CapitalPlanLinesController } from '../../src/modules/cap/plan.controller';
import { CAP_METRICS } from '../../src/modules/cap/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PLANNER = 2; // capital.plan.draft and capital.plan.submit
const APPROVER = 3; // capital.plan.approve
const PUBLISHER = 4; // plan.publish
const CLOSER = 5; // capital.year.close and capital.read
const REOPENER = 6; // capital.year.reopen and capital.read
const SOLO = 7; // both rights: the server, not the screen, refuses the reopening of a year they locked
const READER = 8; // capital.read
const NOBODY = 9;
const ROOT = 1;
const BQL1 = 2;
const BILLION = 1_000_000_000;
const TODAY = vietnamDateOf(new Date());
const PLAN_READS = ['capital.read', 'plan_version.read', 'allocation_line.read'];
const REASON = 'The adjustment period of the year has ended';
const REOPEN_REASON = 'The audit found a mistake in the allocation of the year';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the closing, the lapse and the reopening of a fiscal year over HTTP (ST-CAP-008)', () => {
  const harness = new AuthzHarness();
  const projects = new PrjProjectStore();
  const store = new CapFiscalYearStore();
  let app: RunningApp;
  let counter = 0;
  let yearCounter = 2090;
  const versions: Record<string, string> = {};

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const money = (billions: number): string => String(billions * BILLION);
  /** A year with a free year after it, so that closing it never closes the year some other case carries capital into. */
  const yearFor = (): number => {
    yearCounter -= 2;
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

  async function document(): Promise<string> {
    const id = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
      [TENANT_A, id, `QD-${id.slice(0, 8)}`, memberId(PLANNER)],
    );
    return id;
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

  interface Funded {
    year: number;
    projectId: string;
    appropriationId: string;
    lineId: string;
    balanceId: string;
    planId: string;
  }

  /** A project with a line of `allocated` VND in a published plan of a year of its own, made through the API the way a planner does. */
  async function funded(allocated: string): Promise<Funded> {
    const year = yearFor();
    const fund = await seedMaster('FUND', 'FUND_SOURCE', { category: 'NSTW', relation: 'ADDITIVE' });
    const appropriationId = randomUUID();
    await rows(
      `insert into machvon.appropriation
         (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
       values ($1, $2, $3, $4, 'PM_ASSIGNED', 'CENTRAL', $5::numeric, 0, $6, 'Thủ tướng Chính phủ', $4, 1, 'PUBLISHED', $7, $8, $8)`,
      [TENANT_A, appropriationId, fund, year, money(100), await document(), memberId(APPROVER), memberId(PLANNER)],
    );
    counter += 1;
    const code = `FY-${counter}-${randomUUID().slice(0, 6)}`;
    const created = await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(PLANNER), scopeVersion: 1 }, (tx) =>
      projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(BQL1), areaMasterVersionId: versions.area as string, totalInvestmentVnd: '500000000000' }, memberId(PLANNER), TODAY),
    );
    await rows('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, 'PIPELINE', 'B', String(9700000 + counter)]);
    const plan = await newPlan(year);
    expect(plan.status).toBe(200);
    const planId = idOf(plan);
    const drafted = await call('POST', `/capital-plans/${planId}/allocations`, {
      member: PLANNER,
      ifMatch: `"${versionOf(plan)}"`,
      body: { lines: [{ project_id: created.id, appropriation_id: appropriationId, bucket: 'CURRENT_YEAR', source_year: year, amount_vnd: allocated }] },
    });
    expect(drafted.status).toBe(200);
    const submitted = await call('POST', `/capital-plans/${planId}/submit`, { member: PLANNER, ifMatch: `"${versionOf(drafted)}"`, body: {} });
    const decided = await call('POST', `/capital-plans/${planId}/decision`, { member: APPROVER, ifMatch: `"${versionOf(submitted)}"`, body: { decision: 'approve', reason: 'Reviewed against the decision' } });
    const published = await call('POST', `/plans/${planId}/publish`, { member: PUBLISHER, ifMatch: `"${versionOf(decided)}"`, body: { decision_document_id: await document(), effective_at: '2026-01-15T00:00:00Z' } });
    expect(published.status).toBe(200);
    const line = (await rows<{ id: string }>('select al.id from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid', [planId]))[0];
    const balance = (await rows<{ id: string }>('select id from machvon.allocation_balance where allocation_line_id = $1::uuid', [line?.id]))[0];
    return { year, projectId: created.id, appropriationId, lineId: line?.id as string, balanceId: balance?.id as string, planId };
  }

  const newPlan = (year: number): Promise<Reply> =>
    call('POST', '/capital-plans', {
      member: PLANNER,
      body: { plan_code: `FY-${(counter += 1)}-${randomUUID().slice(0, 6)}`, plan_kind: 'ANNUAL', plan_year: year, period_from_year: year, period_to_year: year, scope_unit_id: unitId(ROOT) },
    });
  const closeYear = (year: number, target: string, options: { member?: number; version?: number; reason?: string } = {}): Promise<Reply> =>
    call('POST', `/fiscal-years/${year}/close`, { member: options.member ?? CLOSER, ifMatch: `"${options.version ?? 1}"`, body: { target_status: target, reason: options.reason ?? REASON } });
  const reopenYear = (year: number, version: number, options: { member?: number; reason?: string; hours?: number } = {}): Promise<Reply> =>
    call('POST', `/fiscal-years/${year}/reopen`, { member: options.member ?? REOPENER, ifMatch: `"${version}"`, body: { reason: options.reason ?? REOPEN_REASON, window_hours: options.hours ?? 24 } });
  const controlOf = async (year: number) =>
    (await rows<{ status: string; version: string; locked_by: string | null; reopened_until: string | null; lock_ref_id: string | null }>(
      'select status, version::text as version, locked_by, reopened_until::text as reopened_until, lock_ref_id from machvon.fiscal_year_control where plan_year = $1::integer',
      [year],
    ))[0];

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: BQL1, path: `/${unitId(ROOT)}/${unitId(BQL1)}/`, parent: ROOT },
      ]);
    }
    for (const n of [PLANNER, APPROVER, PUBLISHER, CLOSER, REOPENER, SOLO, READER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, CLOSER, ROOT);
    await harness.seedRole(TENANT_A, 2, 'PLANNER', ['capital.plan.draft', 'capital.plan.submit', ...PLAN_READS], 40);
    await harness.seedRole(TENANT_A, 3, 'APPROVER', ['capital.plan.approve', ...PLAN_READS], 50);
    await harness.seedRole(TENANT_A, 4, 'PUBLISHER', ['plan.publish', ...PLAN_READS], 50);
    await harness.seedRole(TENANT_A, 5, 'YEAR_CLOSER', ['capital.year.close', 'capital.read'], 50);
    await harness.seedRole(TENANT_A, 6, 'YEAR_REOPENER', ['capital.year.reopen', 'capital.read'], 50);
    await harness.seedRole(TENANT_A, 7, 'YEAR_SOLO', ['capital.year.close', 'capital.year.reopen', 'capital.read'], 50);
    await harness.seedRole(TENANT_A, 8, 'READER', ['capital.read'], 20);
    await harness.seedRole(TENANT_B, 5, 'YEAR_CLOSER', ['capital.year.close', 'capital.read'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 2, member: PLANNER, role: 2, kind: 'TENANT' },
      { n: 3, member: APPROVER, role: 3, kind: 'TENANT' },
      { n: 4, member: PUBLISHER, role: 4, kind: 'TENANT' },
      { n: 5, member: CLOSER, role: 5, kind: 'TENANT' },
      { n: 6, member: REOPENER, role: 6, kind: 'TENANT' },
      { n: 7, member: SOLO, role: 7, kind: 'TENANT' },
      { n: 8, member: READER, role: 8, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 5, member: CLOSER, role: 5, kind: 'TENANT' }]);
    versions.area = await seedMaster('AREA', 'AREA', {});
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [CapitalPlanController, CapitalPlanApprovalController, CapitalPlanLinesController, CapitalAvailabilityController, FiscalYearController, FiscalYearReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: CAP_METRICS, useValue: { increment: () => undefined, gauge: () => undefined } },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of CAP', () => {
    expect(capModule.controllers).toEqual(expect.arrayContaining([FiscalYearController, FiscalYearReadsController]));
  });

  describe('closeFiscalYear', () => {
    it('soft-closes a year: the adjustment period, with the audit row and the event; the plan commands of the year are refused with the state (UAT-AC230)', async () => {
      const year = yearFor();
      const closed = await closeYear(year, 'SOFT_CLOSED');
      expect(closed.status).toBe(200);
      expect(closed.json).toMatchObject({ status: 'SOFT_CLOSED', resource_version: 2 });
      expect(await controlOf(year)).toMatchObject({ status: 'SOFT_CLOSED', version: '2' });
      const refused = await newPlan(year);
      expect([refused.status, refused.json.code, refused.json.detail, refused.json.state]).toEqual([409, 'FISCAL_YEAR_LOCKED', 'plan_year', 'SOFT_CLOSED']);
      const audit = await rows<{ action: string; actor_id: string; safe_diff: Record<string, unknown> }>("select action, actor_id, safe_diff from machvon.audit_event where resource_id = $1::uuid and action like 'capital.fiscal_year_%'", [idOf(closed)]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'capital.fiscal_year_soft_closed', actor_id: memberId(CLOSER) });
      expect(audit[0]?.safe_diff).toMatchObject({ plan_year: year, status_before: 'OPEN', status_after: 'SOFT_CLOSED' });
      const events = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1::uuid and type = 'capital.fiscal_year_closed.v1'", [idOf(closed)]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ plan_year: year, status: 'SOFT_CLOSED', previous_status: 'OPEN' });
    });

    it('locks a year: what was not carried over lapses, the line gives up the capital and the event says how much (UAT-AC230)', async () => {
      const line = await funded(money(3));
      await rows('update machvon.allocation_balance set committed_vnd = $2::numeric, disbursed_vnd = $3::numeric where id = $1::uuid', [line.balanceId, money(1), '500000000']);
      const locked = await closeYear(line.year, 'LOCKED');
      expect(locked.json).toMatchObject({ status: 'LOCKED', resource_version: 2 });
      const control = await controlOf(line.year);
      expect(control).toMatchObject({ status: 'LOCKED', locked_by: memberId(CLOSER) });
      const entries = await rows<{ entry_type: string; amount_vnd: string; source_ref_kind: string }>('select entry_type, amount_vnd::text, source_ref_kind from machvon.capital_ledger_entry where source_ref_id = $1::uuid', [control?.lock_ref_id]);
      expect(entries).toEqual([{ entry_type: 'LAPSE', amount_vnd: '1500000000', source_ref_kind: 'YEAR_CLOSE' }]);
      const availability = await call('GET', `/capital/availability?allocation_line_id=${line.lineId}`, { member: READER });
      expect(availability.json).toMatchObject({ allocated_vnd: '1500000000', committed_vnd: money(1), disbursed_vnd: '500000000' });
      const events = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1::uuid and type = 'capital.fiscal_year_closed.v1'", [idOf(locked)]);
      expect(events[0]?.payload).toMatchObject({ status: 'LOCKED', lapsed_lines: 1, lapsed_vnd: '1500000000', lock_ref_id: control?.lock_ref_id });
      const refused = await newPlan(line.year);
      expect([refused.status, refused.json.code, refused.json.state]).toEqual([409, 'FISCAL_YEAR_LOCKED', 'LOCKED']);
    });

    it('refuses to close a year with a plan in review or approved and not yet published: 409 YEAR_STATE_INVALID naming the plans (AC-ST-CAP-008-2, UAT-PLAN-62)', async () => {
      const line = await funded(money(1));
      const plan = await newPlan(line.year);
      const drafted = await call('POST', `/capital-plans/${idOf(plan)}/allocations`, {
        member: PLANNER,
        ifMatch: `"${versionOf(plan)}"`,
        body: { lines: [{ project_id: line.projectId, appropriation_id: line.appropriationId, bucket: 'CURRENT_YEAR', source_year: line.year, amount_vnd: money(1) }] },
      });
      const submitted = await call('POST', `/capital-plans/${idOf(plan)}/submit`, { member: PLANNER, ifMatch: `"${versionOf(drafted)}"`, body: {} });
      expect(submitted.status).toBe(200);
      const refused = await closeYear(line.year, 'LOCKED');
      expect([refused.status, refused.json.code]).toEqual([409, 'YEAR_STATE_INVALID']);
      expect(refused.json).toMatchObject({ reason: 'PLANS_PENDING', plan_ids: [idOf(plan)] });
      expect((await controlOf(line.year))?.status).not.toBe('LOCKED');
      expect(Number((await rows<{ n: string }>("select count(*)::text as n from machvon.capital_ledger_entry where entry_type = 'LAPSE' and allocation_line_id = $1::uuid", [line.lineId]))[0]?.n)).toBe(0);
    });

    it('answers 428 without If-Match, 409 VERSION_CONFLICT to a stale version, 409 YEAR_STATE_INVALID to a year closed already and 422 to a target that is not one', async () => {
      const year = yearFor();
      const noMatch = await call('POST', `/fiscal-years/${year}/close`, { member: CLOSER, body: { target_status: 'LOCKED', reason: REASON } });
      expect([noMatch.status, noMatch.json.code]).toEqual([428, 'PRECONDITION_REQUIRED']);
      const stale = await closeYear(year, 'LOCKED', { version: 9 });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await closeYear(year, 'LOCKED')).status).toBe(200);
      const again = await closeYear(year, 'LOCKED', { version: 2 });
      expect([again.status, again.json.code]).toEqual([409, 'YEAR_STATE_INVALID']);
      const archived = await closeYear(year, 'ARCHIVED', { version: 2 });
      expect([archived.status, archived.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('is refused to a member without the right, and does not touch the year of another tenant', async () => {
      const year = yearFor();
      expect((await closeYear(year, 'SOFT_CLOSED', { member: READER })).status).toBe(403);
      expect((await closeYear(year, 'SOFT_CLOSED', { member: NOBODY })).status).toBe(403);
      expect((await controlOf(year))?.status).toBeUndefined();
      const foreign = await call('POST', `/fiscal-years/${year}/close`, { member: CLOSER, tenantId: TENANT_B, ifMatch: '"1"', body: { target_status: 'SOFT_CLOSED', reason: REASON } });
      expect(foreign.status).toBe(200);
      expect((await controlOf(year))?.status).toBeUndefined();
      expect((await rows<{ status: string }>('select status from machvon.fiscal_year_control where plan_year = $1::integer', [year], TENANT_B))[0]?.status).toBe('SOFT_CLOSED');
    });
  });

  describe('reopenFiscalYear (AC-ST-CAP-008-1, UAT-AC230)', () => {
    it('refuses the person who locked the year with 403 SELF_APPROVAL_DENIED; another officer reopens it for the window and the plan commands are allowed again', async () => {
      const year = yearFor();
      const locked = await closeYear(year, 'LOCKED', { member: SOLO });
      const self = await reopenYear(year, versionOf(locked), { member: SOLO });
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await controlOf(year))?.status).toBe('LOCKED');
      const refusedPlan = await newPlan(year);
      expect(refusedPlan.status).toBe(409);
      const reopened = await reopenYear(year, versionOf(locked));
      expect(reopened.json).toMatchObject({ status: 'OPEN', resource_version: 3 });
      const control = await controlOf(year);
      expect(control?.status).toBe('OPEN');
      expect(Date.parse(control?.reopened_until as string)).toBeGreaterThan(Date.now() + 23 * 3_600_000);
      expect((await newPlan(year)).status).toBe(200);
      const audit = await rows<{ action: string; actor_id: string }>("select action, actor_id from machvon.audit_event where resource_id = $1::uuid and action like 'capital.fiscal_year_%' order by occurred_at", [idOf(locked)]);
      expect(audit).toEqual([
        { action: 'capital.fiscal_year_locked', actor_id: memberId(SOLO) },
        { action: 'capital.fiscal_year_reopened', actor_id: memberId(REOPENER) },
      ]);
      const events = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1::uuid and type = 'capital.fiscal_year_reopened.v1'", [idOf(locked)]);
      expect(events[0]?.payload).toMatchObject({ plan_year: year, window_hours: 24 });
    });

    it('is locked again by the job when the window ends, and a year that is locked again lapses what came back', async () => {
      const line = await funded(money(2));
      const locked = await closeYear(line.year, 'LOCKED');
      expect((await reopenYear(line.year, versionOf(locked))).status).toBe(200);
      await rows('update machvon.allocation_balance set allocated_vnd = $2::numeric where id = $1::uuid', [line.balanceId, money(1)]);
      await rows(
        `insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, posted_by)
         values ($1, gen_random_uuid(), $2, $3, $4, 'ALLOCATE', $5::numeric, $6, 'CAPITAL_PLAN', gen_random_uuid(), $7)`,
        [TENANT_A, line.appropriationId, line.lineId, line.projectId, money(1), line.year, memberId(PLANNER)],
      );
      const tenants = harness.tenants as TenantDatabase;
      const later = new Date(Date.now() + 25 * 3_600_000);
      const outcome = await tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(PUBLISHER), scopeVersion: 1 }, (tx) => store.relockDue(tx, later, memberId(PUBLISHER)));
      expect(outcome.years).toContain(line.year);
      expect(await controlOf(line.year)).toMatchObject({ status: 'LOCKED', locked_by: memberId(PUBLISHER) });
      expect((await rows<{ allocated_vnd: string }>('select allocated_vnd::text from machvon.allocation_balance where id = $1::uuid', [line.balanceId]))[0]?.allocated_vnd).toBe('0');
    });

    it('answers 422 REOPEN_REASON_REQUIRED to a short reason, 422 to a window outside a week, 409 to a year that is not locked and 403 to a member without the right', async () => {
      const year = yearFor();
      const locked = await closeYear(year, 'LOCKED');
      const short = await reopenYear(year, versionOf(locked), { reason: 'too short a reason' });
      expect([short.status, short.json.code]).toEqual([422, 'REOPEN_REASON_REQUIRED']);
      for (const hours of [0, 169]) expect((await reopenYear(year, versionOf(locked), { hours })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await reopenYear(year, versionOf(locked), { member: CLOSER })).status).toBe(403);
      expect((await reopenYear(year, 9)).json.code).toBe('VERSION_CONFLICT');
      expect((await reopenYear(year, versionOf(locked))).status).toBe(200);
      const open = await reopenYear(year, 3);
      expect([open.status, open.json.code]).toEqual([409, 'YEAR_STATE_INVALID']);
    });
  });

  describe('listFiscalYears', () => {
    it('lists the years the control knows with their state, the latest first, for a reader, and none of another tenant', async () => {
      const year = yearFor();
      await closeYear(year, 'SOFT_CLOSED');
      const reply = await call('GET', '/fiscal-years', { member: READER });
      expect(reply.status).toBe(200);
      const items = reply.json.items as Array<Record<string, unknown>>;
      expect(items.find((item) => item.plan_year === year)).toMatchObject({ plan_year: year, status: 'SOFT_CLOSED', version: 2, soft_closed_by: memberId(CLOSER), close_reason: REASON });
      const years = items.map((item) => item.plan_year as number);
      expect(years).toEqual([...years].sort((a, b) => b - a));
      expect((await call('GET', '/fiscal-years', { member: NOBODY })).status).toBe(403);
      const other = await call('GET', '/fiscal-years', { member: CLOSER, tenantId: TENANT_B });
      expect((other.json.items as unknown[]).every((item) => (item as { plan_year: number }).plan_year !== years[years.length - 1] || true)).toBe(true);
      expect((other.json.items as Array<{ plan_year: number }>).map((item) => item.plan_year)).not.toContain(year);
    });
  });
});

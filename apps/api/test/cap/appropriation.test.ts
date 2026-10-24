import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AppropriationController, AppropriationReadsController } from '../../src/modules/cap/appropriation.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const PLANNER = 1; // capital.appropriation.manage and capital.read
const APPROVER = 2; // capital.appropriation.approve and capital.read
const READER = 3; // capital.read
const NOBODY = 4;
const BOTH = 5; // manage and approve: the same person must still not decide on what they registered
const OTHER_TENANT_APPROVER = 1; // of tenant B
const BILLION = 1_000_000_000;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('appropriation register commands and reads (ST-CAP-001)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  let yearCounter = 2100;
  const funds: Record<string, string> = {};

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const money = (billions: number): string => String(billions * BILLION);
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

  async function seedFund(name: string, attributes: Record<string, unknown>, tenant = TENANT_A): Promise<string> {
    counter += 1;
    const recordId = randomUUID();
    const versionId = randomUUID();
    const key = `${name}-${counter}`;
    await harness.owner(tenant, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'FUND_SOURCE', $3, 'EFFECTIVE', $4, $4)`, [tenant, recordId, key, memberId(PLANNER)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, 'FUND_SOURCE', $3, 1, $4, $5::jsonb, '2020-01-01', 'EFFECTIVE', $6, now(), $7, $7)`,
        [tenant, versionId, key, `Label ${key}`, JSON.stringify(attributes), recordId, memberId(PLANNER)],
      ],
    ]);
    return versionId;
  }

  async function document(symbol: string, tenant = TENANT_A): Promise<string> {
    const id = randomUUID();
    await harness.owner(tenant, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
        [tenant, id, symbol, memberId(PLANNER)],
      ],
    ]);
    return id;
  }

  async function body(year: number, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return {
      fund_source_version_id: funds.nstw,
      plan_year: year,
      origin: 'PM_ASSIGNED',
      budget_level: 'CENTRAL',
      amount_vnd: money(10),
      decision_document_id: await document(`QD-${randomUUID().slice(0, 8)}`),
      issuing_authority: 'Thủ tướng Chính phủ',
      source_year: year,
      ...overrides,
    };
  }

  const register = async (year: number, overrides: Record<string, unknown> = {}, member = PLANNER): Promise<Reply> => call('POST', '/appropriations', { member, body: await body(year, overrides) });
  const decide = (target: string, version: number, decision = 'approve', member = APPROVER, tenantId?: string): Promise<Reply> =>
    call('POST', `/appropriations/${target}/decision`, { member, ifMatch: `"${version}"`, body: { decision, reason: 'Checked against the decision of the Prime Minister' }, ...(tenantId === undefined ? {} : { tenantId }) });
  const list = (query: string, member = READER, tenantId?: string): Promise<Reply> => call('GET', `/appropriations?${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const itemsOf = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;

  async function publish(year: number, overrides: Record<string, unknown> = {}): Promise<string> {
    const made = await register(year, overrides);
    expect(made.status).toBe(200);
    const done = await decide(idOf(made), versionOf(made));
    expect(done.status).toBe(200);
    return idOf(made);
  }

  /** The allocation command of a later story, as far as this one needs it: it raises the setting that lets the allocated total change. */
  const allocate = async (target: string, total: string): Promise<void> => {
    await harness.owner(TENANT_A, [
      ["select set_config('app.cap_allocation_write', 'on', false)"],
      ['update machvon.appropriation set allocated_total_vnd = $2::numeric where id = $1', [target, total]],
      ["select set_config('app.cap_allocation_write', 'off', false)"],
    ]);
  };

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    }
    for (const n of [PLANNER, APPROVER, READER, NOBODY, BOTH]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_APPROVER, 1);
    await harness.seedRole(TENANT_A, 1, 'CAPITAL_PLANNER', ['capital.appropriation.manage', 'capital.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'CAPITAL_APPROVER', ['capital.appropriation.approve', 'capital.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'CAPITAL_READER', ['capital.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'CAPITAL_BOTH', ['capital.appropriation.manage', 'capital.appropriation.approve', 'capital.read'], 50);
    await harness.seedRole(TENANT_B, 1, 'CAPITAL_APPROVER', ['capital.appropriation.approve', 'capital.appropriation.manage', 'capital.read'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PLANNER, role: 1, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: BOTH, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_APPROVER, role: 1, kind: 'TENANT' }]);
    funds.nstw = await seedFund('NSTW-DTPT', { category: 'NSTW', relation: 'ADDITIVE' });
    funds.nsdp = await seedFund('NSDP-DTPT', { category: 'NSDP', relation: 'ADDITIVE' });
    funds.subset = await seedFund('CTMTQG-NTM', { category: 'CTMTQG', relation: 'SUBSET_OF' });
    funds.foreign = await seedFund('NSTW-B', { category: 'NSTW', relation: 'ADDITIVE' }, TENANT_B);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [AppropriationController, AppropriationReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('registerAppropriation and decideAppropriation', () => {
    it('registers a Prime Minister assigned and a local added appropriation, publishes them and lists them separately by origin with Con lai (AC-ST-CAP-001-1, UAT-AC220)', async () => {
      const year = freshYear();
      const assigned = await register(year, { origin: 'PM_ASSIGNED', budget_level: 'CENTRAL', fund_source_version_id: funds.nstw, amount_vnd: money(10) });
      const added = await register(year, { origin: 'LOCAL_ADDED', budget_level: 'LOCAL', fund_source_version_id: funds.nsdp, amount_vnd: money(4), issuing_authority: 'Hội đồng nhân dân tỉnh' });
      expect(assigned.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const first = await decide(idOf(assigned), 1);
      expect(first.json).toMatchObject({ status: 'PUBLISHED', resource_version: 2, resource_id: idOf(assigned) });
      await decide(idOf(added), 1);
      await allocate(idOf(assigned), money(6));

      const pm = itemsOf(await list(`plan_year=${year}&origin=PM_ASSIGNED`));
      expect(pm).toHaveLength(1);
      expect(pm[0]).toMatchObject({
        id: idOf(assigned),
        origin: 'PM_ASSIGNED',
        budget_level: 'CENTRAL',
        plan_year: year,
        amount_vnd: money(10),
        allocated_total_vnd: money(6),
        remaining_vnd: money(4),
        status: 'PUBLISHED',
        revision: 1,
        supersedes_id: null,
        issuing_authority: 'Thủ tướng Chính phủ',
        is_extended: false,
        version: 2,
        approved_by: memberId(APPROVER),
        created_by: memberId(PLANNER),
      });
      expect(pm[0]?.fund_source).toMatchObject({ category: 'NSTW', relation: 'ADDITIVE', onlending: null });
      expect(pm[0]?.decision_document).toMatchObject({ symbol: expect.stringMatching(/^QD-/), issued_on: '2026-01-15' });
      const local = itemsOf(await list(`plan_year=${year}&origin=LOCAL_ADDED&budget_level=LOCAL`));
      expect(local.map((item) => [item.origin, item.remaining_vnd])).toEqual([['LOCAL_ADDED', money(4)]]);
      expect(itemsOf(await list(`plan_year=${year}`))).toHaveLength(2);
    });

    it('keeps central support and revenue increase as groups of their own beside the Prime Minister assigned capital (AC-ST-CAP-001-2, UAT-AC235)', async () => {
      const year = freshYear();
      const support = await publish(year, { origin: 'CENTRAL_SUPPORT', amount_vnd: money(20) });
      const revenue = await publish(year, { origin: 'REVENUE_INCREASE', amount_vnd: money(15), budget_level: 'LOCAL', fund_source_version_id: funds.nsdp });
      await publish(year, { origin: 'PM_ASSIGNED', amount_vnd: money(10) });
      await allocate(support, money(20));
      await allocate(revenue, money(15));
      const items = itemsOf(await list(`plan_year=${year}`));
      const byOrigin = Object.fromEntries(items.map((item) => [item.origin as string, [item.amount_vnd, item.allocated_total_vnd, item.remaining_vnd]]));
      expect(byOrigin).toEqual({
        CENTRAL_SUPPORT: [money(20), money(20), '0'],
        REVENUE_INCREASE: [money(15), money(15), '0'],
        PM_ASSIGNED: [money(10), '0', money(10)],
      });
    });

    it('answers 422 APPROPRIATION_BELOW_ALLOCATED to a revision below the allocated total and leaves the appropriation unchanged (AC-ST-CAP-001-3, UAT-PLAN-59)', async () => {
      const year = freshYear();
      const published = await publish(year, { amount_vnd: money(10) });
      await allocate(published, money(6));
      const before = itemsOf(await list(`plan_year=${year}`));

      const refused = await register(year, { supersedes_id: published, amount_vnd: money(5) });
      expect([refused.status, refused.json.code]).toEqual([422, 'APPROPRIATION_BELOW_ALLOCATED']);
      expect(itemsOf(await list(`plan_year=${year}`))).toEqual(before);
      expect(before[0]).toMatchObject({ status: 'PUBLISHED', amount_vnd: money(10), allocated_total_vnd: money(6) });

      // A revision at or above the allocated total is published in place of it, and carries the allocated total.
      const revision = await register(year, { supersedes_id: published, amount_vnd: money(12) });
      expect(revision.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      await decide(idOf(revision), 1);
      const after = itemsOf(await list(`plan_year=${year}`));
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: idOf(revision), revision: 2, supersedes_id: published, amount_vnd: money(12), allocated_total_vnd: money(6), remaining_vnd: money(6) });
    });

    it('never lets the planner decide on what they registered, and refuses a missing or unknown decision document (UAT-AC223)', async () => {
      const year = freshYear();
      const made = await register(year, {}, BOTH);
      const own = await decide(idOf(made), 1, 'approve', BOTH);
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await decide(idOf(made), 1, 'reject', BOTH)).json.code).toBe('SELF_APPROVAL_DENIED');
      expect((await rows<{ status: string }>('select status from machvon.appropriation where id = $1', [idOf(made)]))[0]?.status).toBe('DRAFT');
      expect((await decide(idOf(made), 1)).status).toBe(200);

      const withoutDocument = { ...(await body(year)) };
      delete withoutDocument.decision_document_id;
      const missing = await call('POST', '/appropriations', { member: PLANNER, body: withoutDocument });
      expect([missing.status, missing.json.code]).toEqual([422, 'DECISION_REQUIRED']);
      const unknown = await register(year, { decision_document_id: randomUUID() });
      expect([unknown.status, unknown.json.code]).toEqual([422, 'DECISION_REQUIRED']);
      const foreign = await register(year, { decision_document_id: await document('QD-FOREIGN', TENANT_B) });
      expect(foreign.json.code).toBe('DECISION_REQUIRED');
    });

    it('answers a repeated key with the first result, and the same key with another payload with 409 IDEMPOTENCY_CONFLICT (UAT-AC238)', async () => {
      const year = freshYear();
      const payload = await body(year);
      const key = `idem-${randomUUID()}`;
      const first = await call('POST', '/appropriations', { member: PLANNER, body: payload, key });
      const again = await call('POST', '/appropriations', { member: PLANNER, body: payload, key });
      expect(first.status).toBe(200);
      expect(again.json).toMatchObject({ resource_id: idOf(first), resource_version: 1 });
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.appropriation where plan_year = $1', [year]))[0]?.n)).toBe(1);
      const other = await call('POST', '/appropriations', { member: PLANNER, body: { ...payload, amount_vnd: money(11) }, key });
      expect([other.status, other.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    });

    it('has no write path for the allocated total, the status or the approver: the body allowlist refuses them (TK-CAP-001-5)', async () => {
      const year = freshYear();
      for (const field of ['allocated_total_vnd', 'status', 'approved_by', 'revision', 'is_extended']) {
        const reply = await register(year, { [field]: field === 'status' ? 'PUBLISHED' : field === 'approved_by' ? memberId(APPROVER) : 1 });
        expect([reply.status, reply.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      }
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.appropriation where plan_year = $1', [year]))[0]?.n)).toBe(0);
    });

    it('needs the permission of each command, the current version, and shows nothing of another tenant (UAT-AC237)', async () => {
      const year = freshYear();
      expect((await register(year, {}, READER)).status).toBe(403);
      expect((await register(year, {}, APPROVER)).status).toBe(403);
      expect((await register(year, {}, NOBODY)).status).toBe(403);
      const made = await register(year);
      expect((await decide(idOf(made), 1, 'approve', PLANNER)).status).toBe(403);
      expect((await decide(idOf(made), 1, 'approve', READER)).status).toBe(403);
      expect((await decide(idOf(made), 9)).json.code).toBe('VERSION_CONFLICT');
      expect((await decide(randomUUID(), 1)).json.code).toBe('RESOURCE_NOT_FOUND');
      expect((await decide(idOf(made), 1, 'approve', OTHER_TENANT_APPROVER, TENANT_B)).json.code).toBe('RESOURCE_NOT_FOUND');
      expect((await decide(idOf(made), 1, 'return')).json.code).toBe('VALIDATION_FAILED');
      expect((await decide(idOf(made), 1)).status).toBe(200);
      expect((await decide(idOf(made), 2)).json.code).toBe('STAGE_TRANSITION_DENIED');
      expect(itemsOf(await list(`plan_year=${year}`, OTHER_TENANT_APPROVER, TENANT_B))).toEqual([]);
    });

    it('rejects a draft, which then leaves the register and posts nothing', async () => {
      const year = freshYear();
      const made = await register(year);
      const rejected = await decide(idOf(made), 1, 'reject');
      expect(rejected.json).toMatchObject({ status: 'REJECTED', resource_version: 2 });
      expect(itemsOf(await list(`plan_year=${year}`))).toEqual([]);
      expect(await rows('select 1 from machvon.capital_ledger_entry where appropriation_id = $1', [idOf(made)])).toEqual([]);
      expect(await rows('select 1 from machvon.outbox_event where aggregate_id = $1', [idOf(made)])).toEqual([]);
    });

    it('carries the extension of a carry-over, and names the missing extension document with its own code', async () => {
      const year = freshYear();
      const extension = await document('QD-EXT-1');
      const carry = { origin: 'CARRYOVER', source_year: year - 1, extension_document_id: extension, extended_to: `${year}-12-31` };
      const missing = await register(year, { origin: 'CARRYOVER', source_year: year - 1 });
      expect([missing.status, missing.json.code]).toEqual([422, 'EXTENSION_DOCUMENT_REQUIRED']);
      const made = await register(year, carry);
      expect(made.status).toBe(200);
      await decide(idOf(made), 1);
      expect(itemsOf(await list(`plan_year=${year}&origin=CARRYOVER`))[0]).toMatchObject({ is_extended: true, extended_to: `${year}-12-31`, extension_document_id: extension, source_year: year - 1 });
    });

    it('refuses a subset fund source, a fund source of another tenant, an amount that is not whole VND and a locked year', async () => {
      const year = freshYear();
      expect((await register(year, { fund_source_version_id: funds.subset })).json.code).toBe('SUBSET_SOURCE_NOT_ADDITIVE');
      expect((await register(year, { fund_source_version_id: funds.foreign })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      for (const amount of ['0', '12.5', '-1', '1e9']) expect((await register(year, { amount_vnd: amount })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await register(year, { fund_source_version_id: 'not-a-uuid' })).status).toBe(422);
      await harness.owner(TENANT_A, [
        [`insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, locked_at, created_by, updated_by) values ($1, $2, $3, 'LOCKED', now(), $4, $4)`, [TENANT_A, randomUUID(), year, memberId(PLANNER)]],
      ]);
      expect((await register(year)).json.code).toBe('FISCAL_YEAR_LOCKED');
    });

    it('audits both commands, posts the ledger and tells the other modules once an appropriation is published (UAT-AC234)', async () => {
      const year = freshYear();
      const made = await register(year, { amount_vnd: money(3) });
      const published = await decide(idOf(made), 1);
      const actions = await rows<{ action: string; reason: string | null }>(
        'select action, reason from machvon.audit_event where resource_id = $1 order by occurred_at, id',
        [idOf(made)],
      );
      expect(actions.map((entry) => [entry.action, entry.reason])).toEqual([
        ['capital.appropriation_registered', null],
        ['capital.appropriation_published', 'Checked against the decision of the Prime Minister'],
      ]);
      expect(await rows('select entry_type, amount_vnd::text as amount_vnd, source_ref_kind from machvon.capital_ledger_entry where appropriation_id = $1', [idOf(made)])).toEqual([
        { entry_type: 'APPROPRIATE', amount_vnd: money(3), source_ref_kind: 'APPROPRIATION' },
      ]);
      const events = await rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1', [idOf(made)]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'capital.appropriation_published.v1',
        payload: { appropriation_id: idOf(made), plan_year: year, origin: 'PM_ASSIGNED', amount_vnd: money(3), revision: 1, supersedes_id: null, actor_id: memberId(APPROVER) },
      });
      expect(published.json.status).toBe('PUBLISHED');
    });
  });

  describe('listAppropriations', () => {
    it('lists in pages with a cursor, to those who hold capital.read only, and refuses a filter that is not well formed', async () => {
      const year = freshYear();
      const made: string[] = [];
      for (let n = 0; n < 3; n += 1) made.push(idOf(await register(year)));
      const page = await list(`plan_year=${year}&limit=2`);
      expect(itemsOf(page).map((item) => item.id)).toEqual([made[2], made[1]]);
      const next = await list(`plan_year=${year}&limit=2&cursor=${page.json.next_cursor as string}`);
      expect(itemsOf(next).map((item) => item.id)).toEqual([made[0]]);
      expect(next.json.next_cursor).toBeNull();
      expect((await list(`plan_year=${year}`, NOBODY)).status).toBe(403);
      expect((await list('plan_year=20x6')).status).toBe(422);
      expect((await list('origin=GIFT')).status).toBe(422);
      expect((await list('budget_level=PROVINCE')).status).toBe(422);
      expect((await list('limit=0')).status).toBe(422);
    });
  });
});

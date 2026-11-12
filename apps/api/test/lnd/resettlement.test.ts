import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, LndHouseholdStore, LndPlanStore, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { FieldCipher, loadErrorRegistry, signTenantContext, staticKeyProvider, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { lndModule } from '../../src/modules/lnd';
import { ResettlementController, ResettlementReadsController } from '../../src/modules/lnd/resettlement.controller';
import { FIELD_CIPHER } from '../../src/modules/lnd/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedLndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import type { LndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const ALLOCATOR = 1; // land.resettle.write and land.read on the whole tenant
const DEPARTMENT_ALLOCATOR = 2; // the same on the unit tree of the department only
const PROJECT_ALLOCATOR = 3; // the same on project 1 only: it reaches the project and no household
const READER = 4; // land.read on the whole tenant
const NOBODY = 5;
const OFFICER = 6; // registers households and drafts plans (through the stores)
const B_ALLOCATOR = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0xc6;
const FAMILY_B = 0xc7;
const BASIS = 'Luật Đất đai 2024, Điều 91';
const POLICY = 'Nghị định 88/2024/NĐ-CP, Điều 21';
const HEAD = 'Nguyễn Văn Anh';
const TODAY = vietnamDateOf(new Date());

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Target {
  householdId: string;
  itemId: string;
  planId: string;
}

describe('the allocation of resettlement to the households (ST-LND-012, UAT-PLAN-31)', () => {
  const harness = new AuthzHarness();
  const cipher = new FieldCipher(staticKeyProvider(new Map([[1, randomBytes(32)]])));
  const households = new LndHouseholdStore(cipher);
  const plans = new LndPlanStore();
  let app: RunningApp;
  let world: LndWorld;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> =>
    harness.owner<R>(tenant, [
      ["select set_config('app.scope_units', '*', false)", []],
      [sql, params],
    ]);
  const context = (member: number) => ({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 });

  /** A household of a unit with a plan item of the kind given, in a plan of the status given (the plan is put where the commands leave it after approval). */
  async function target(options: { unit?: number; itemKind?: string; planStatus?: string } = {}): Promise<Target> {
    counter += 1;
    const tenants = harness.tenants as TenantDatabase;
    const registered = await tenants.withTenant(context(OFFICER), (tx) =>
      households.register(
        tx,
        { projectId: world.project, ownerUnitId: unitId(options.unit ?? DEPARTMENT), headName: HEAD, nationalId: String(700000000000 + counter * 31), legalBasis: 'PUBLIC_TASK_LAND_LAW', legalBasisRef: BASIS, retentionUntil: '2036-01-01' },
        memberId(OFFICER),
        '*',
        TODAY,
      ),
    );
    const plan = await tenants.withTenant(context(OFFICER), (tx) =>
      plans.draft(tx, { projectId: world.project, executorUnitId: unitId(options.unit ?? DEPARTMENT), executorKind: 'LAND_FUND_CENTRE', planCode: `RS-${String(counter).padStart(4, '0')}` }, memberId(OFFICER)),
    );
    await tenants.withTenant(context(OFFICER), (tx) =>
      plans.addItems(tx, plan.id, [{ householdId: registered.id, itemKind: options.itemKind ?? 'RESETTLEMENT_LAND', amountVnd: '1000000', legalBasis: POLICY }], 1, memberId(OFFICER), '*'),
    );
    const status = options.planStatus ?? 'APPROVED';
    if (status !== 'DRAFT') {
      await rows("update machvon.compensation_plan set status = 'POSTING', posting_started_on = $2::date, posting_ends_on = $3::date, posting_place_text = 'Commune office', timer_rule_version_id = gen_random_uuid() where id = $1::uuid", [plan.id, '2026-08-01', '2026-08-31']);
      await rows("update machvon.compensation_plan set status = 'POSTING_CLOSED', feedback_summary = 'No opinions' where id = $1::uuid", [plan.id]);
      if (status !== 'POSTING_CLOSED') {
        await rows(
          "update machvon.compensation_plan set status = $4, approved_on = $2::date, approved_by = $3::uuid, payment_due_on = date '2026-12-31', decision_document_version_id = $5::uuid where id = $1::uuid",
          [plan.id, '2026-09-02', memberId(CHECKER), 'APPROVED', world.cleanDocument],
        );
      }
    }
    const [item] = await rows<{ id: string }>('select id from machvon.compensation_plan_item where plan_id = $1::uuid', [plan.id]);
    return { householdId: registered.id, itemId: (item as { id: string }).id, planId: plan.id };
  }
  const CHECKER = 7;

  const body = (aim: Target, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    household_id: aim.householdId,
    plan_item_id: aim.itemId,
    owner_unit_id: unitId(DEPARTMENT),
    unit_kind: 'PLOT',
    unit_code: `PLOT-${randomUUID().slice(0, 8)}`,
    site_text: 'Khu tái định cư số 1',
    ...extra,
  });
  const allocate = (member: number, aim: Target, extra: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> =>
    call('POST', '/resettlement-allocations', { member, body: body(aim, extra), ...(tenantId === undefined ? {} : { tenantId }) });
  const list = (member: number, query = ''): Promise<Reply> => call('GET', `/resettlement-allocations?project_id=${world.project}${query}`, { member });
  const candidates = (member: number): Promise<Reply> => call('GET', `/resettlement-allocations/candidates?project_id=${world.project}`, { member });
  const stored = async (id: string) =>
    (await rows<{ status: string; unit_code: string; allocated_on: string; plan_item_id: string; version: string }>('select status, unit_code, allocated_on::text as allocated_on, plan_item_id, version::text as version from machvon.resettlement_allocation where id = $1::uuid', [id]))[0];

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER_MEMBERSHIP_ID, '2026-10-24'));
    for (const n of [ALLOCATOR, DEPARTMENT_ALLOCATOR, PROJECT_ALLOCATOR, READER, NOBODY, OFFICER, CHECKER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ALLOCATOR, ROOT);
    await harness.seedRole(TENANT_A, 1, 'RESETTLEMENT_OFFICER', ['land.resettle.write', 'land.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'LAND_READER', ['land.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'RESETTLEMENT_OFFICER', ['land.resettle.write', 'land.read'], 30);
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, OFFICER, DEPARTMENT, ROOT);
    await seedLndWorld(harness.database.adminUrl, TENANT_B, FAMILY_B, B_ALLOCATOR, DEPARTMENT, ROOT);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ALLOCATOR, role: 1, kind: 'TENANT' },
      { n: 2, member: DEPARTMENT_ALLOCATOR, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: PROJECT_ALLOCATOR, role: 1, kind: 'PROJECT', refs: [world.project] },
      { n: 4, member: READER, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ALLOCATOR, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ResettlementController, ResettlementReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FIELD_CIPHER, useValue: cipher },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of LND', () => {
    expect(lndModule.controllers).toEqual(expect.arrayContaining([ResettlementController, ResettlementReadsController]));
  });

  it('AC-ST-LND-012-1, UAT-PLAN-31: allocates a plot on an item of an approved plan, and refuses a second allocation of the plot', async () => {
    const one = await target();
    const two = await target();
    const made = await allocate(ALLOCATOR, one, { unit_code: 'PLOT-A-001', area_m2: '120.5', priority_rank: 3 });
    expect(made).toMatchObject({ status: 200, json: { status: 'ALLOCATED', resource_version: 1 } });
    const id = made.json.resource_id as string;
    expect(await stored(id)).toMatchObject({ status: 'ALLOCATED', unit_code: 'PLOT-A-001', allocated_on: TODAY, plan_item_id: one.itemId, version: '1' });
    const second = await allocate(ALLOCATOR, two, { unit_code: 'PLOT-A-001' });
    expect(second).toMatchObject({ status: 409, json: { code: 'UNIT_ALREADY_ALLOCATED' } });
    expect(await rows('select 1 from machvon.resettlement_allocation where unit_code = $1', ['PLOT-A-001'])).toHaveLength(1);
    // The same household and item cannot take another unit either.
    expect(await allocate(ALLOCATOR, one, { unit_code: 'PLOT-A-002' })).toMatchObject({ status: 422, json: { code: 'HOUSEHOLD_NOT_ELIGIBLE', reason: 'ALREADY_ALLOCATED' } });
    // The other household takes another plot.
    expect((await allocate(ALLOCATOR, two, { unit_code: 'PLOT-A-003' })).status).toBe(200);
  });

  it('writes one audit row of personal data with ids only, and one event, and none for a refusal', async () => {
    const aim = await target();
    expect((await allocate(ALLOCATOR, aim, { unit_kind: 'HOUSE' })).status).toBe(422);
    const made = await allocate(ALLOCATOR, aim, { unit_code: 'PLOT-AUDIT-1' });
    const id = made.json.resource_id as string;
    const audit = await rows<{ safe_diff: Record<string, unknown>; actor_id: string; classification: string }>(`select safe_diff, actor_id, classification from machvon.audit_event where action = 'lnd.resettlement_allocated' and resource_id = $1`, [id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: memberId(ALLOCATOR), classification: 'PERSONAL' });
    expect(audit[0]?.safe_diff).toMatchObject({ household_id: aim.householdId, plan_item_id: aim.itemId, unit_kind: 'PLOT', unit_code: 'PLOT-AUDIT-1', allocated_on: TODAY });
    expect(JSON.stringify(audit[0]?.safe_diff)).not.toContain(HEAD);
    const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'lnd.resettlement.allocated.v1' and aggregate_id = $1`, [id]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ allocation_id: id, household_id: aim.householdId, plan_item_id: aim.itemId, unit_kind: 'PLOT', project_id: world.project });
    expect(JSON.stringify(events[0]?.payload)).not.toContain(HEAD);
  });

  it('refuses a household that is not eligible, and says why: no plan item, an item of another household, a plan not approved, an item that is not resettlement, a kind of unit the item does not give', async () => {
    const aim = await target();
    const other = await target();
    const draft = await target({ planStatus: 'DRAFT' });
    const posting = await target({ planStatus: 'POSTING_CLOSED' });
    const support = await target({ itemKind: 'SUPPORT_LIVELIHOOD' });
    const cases: Array<[string, Reply]> = [
      ['NO_PLAN_ITEM', await call('POST', '/resettlement-allocations', { member: ALLOCATOR, body: { ...body(aim), plan_item_id: undefined } })],
      ['PLAN_ITEM_NOT_FOUND', await allocate(ALLOCATOR, aim, { plan_item_id: randomUUID() })],
      ['PLAN_ITEM_OF_ANOTHER_HOUSEHOLD', await allocate(ALLOCATOR, aim, { plan_item_id: other.itemId })],
      ['PLAN_NOT_APPROVED', await allocate(ALLOCATOR, draft)],
      ['PLAN_NOT_APPROVED', await allocate(ALLOCATOR, posting)],
      ['NOT_A_RESETTLEMENT_ITEM', await allocate(ALLOCATOR, support)],
      ['UNIT_KIND_MISMATCH', await allocate(ALLOCATOR, aim, { unit_kind: 'HOUSE' })],
    ];
    for (const [reason, reply] of cases) expect([reply.status, reply.json.code, reply.json.reason]).toEqual([422, 'HOUSEHOLD_NOT_ELIGIBLE', reason]);
    expect(await rows('select 1 from machvon.resettlement_allocation where household_id = any($1::uuid[])', [[aim.householdId, other.householdId, draft.householdId, posting.householdId, support.householdId]])).toHaveLength(0);
  });

  it('lets a house item give a house or a flat and not a plot', async () => {
    const house = await target({ itemKind: 'RESETTLEMENT_HOUSE' });
    expect((await allocate(ALLOCATOR, house, { unit_kind: 'APARTMENT', unit_code: 'FLAT-1' })).status).toBe(200);
    const flat = await target({ itemKind: 'RESETTLEMENT_HOUSE' });
    expect((await allocate(ALLOCATOR, flat, { unit_kind: 'PLOT', unit_code: 'PLOT-NO' })).json.reason).toBe('UNIT_KIND_MISMATCH');
  });

  it('wants what an allocation names (422 naming the field): a kind of the list, a code and a site within their length, an area above zero, a rank from one, and the unit of the household', async () => {
    const aim = await target();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['unit_kind', { unit_kind: 'TENT' }],
      ['unit_code', { unit_code: '   ' }],
      ['unit_code', { unit_code: 'x'.repeat(61) }],
      ['site_text', { site_text: '' }],
      ['site_text', { site_text: 'x'.repeat(301) }],
      ['area_m2', { area_m2: '0' }],
      ['area_m2', { area_m2: '12.345' }],
      ['area_m2', { area_m2: 'big' }],
      ['priority_rank', { priority_rank: 0 }],
      ['owner_unit_id', { owner_unit_id: unitId(ELSEWHERE) }],
      ['household_id', { household_id: 'not-a-uuid' }],
    ];
    for (const [field, extra] of cases) {
      const reply = await allocate(ALLOCATOR, aim, extra);
      expect([reply.status, reply.json.code, reply.json.detail ?? reply.json.field]).toEqual([422, 'VALIDATION_FAILED', field]);
    }
    expect(await rows('select 1 from machvon.resettlement_allocation where household_id = $1::uuid', [aim.householdId])).toHaveLength(0);
  });

  it('is limited to the units of the caller: a household of another unit is not found (404), and so is every household for a grant on the project alone; without the right it is 403', async () => {
    const mine = await target({ unit: DEPARTMENT });
    const away = await target({ unit: ELSEWHERE });
    expect((await allocate(DEPARTMENT_ALLOCATOR, mine)).status).toBe(200);
    expect((await allocate(DEPARTMENT_ALLOCATOR, away, { owner_unit_id: unitId(ELSEWHERE) })).status).toBe(404);
    const again = await target();
    expect((await allocate(PROJECT_ALLOCATOR, again)).status).toBe(404);
    expect((await allocate(READER, again)).status).toBe(403);
    expect((await allocate(NOBODY, again)).status).toBe(403);
    expect((await allocate(B_ALLOCATOR, again, {}, TENANT_B)).status).toBe(404);
    expect(await rows('select 1 from machvon.resettlement_allocation where household_id = $1::uuid', [again.householdId])).toHaveLength(0);
    expect((await allocate(ALLOCATOR, away, { owner_unit_id: unitId(ELSEWHERE), unit_code: 'PLOT-AWAY' })).status).toBe(200);
  });

  it('serialises two allocations asked for at once: of one plot only one household takes it, of one item only one plot is given', async () => {
    const one = await target();
    const two = await target();
    const [first, second] = await Promise.all([allocate(ALLOCATOR, one, { unit_code: 'PLOT-RACE' }), allocate(ALLOCATOR, two, { unit_code: 'PLOT-RACE' })]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const item = await target();
    const [a, b] = await Promise.all([allocate(ALLOCATOR, item, { unit_code: 'PLOT-RACE-A' }), allocate(ALLOCATOR, item, { unit_code: 'PLOT-RACE-B' })]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    expect([a, b].find((reply) => reply.status === 422)?.json.reason).toBe('ALREADY_ALLOCATED');
  });

  it('lists the allocations of the project inside the units of the reader with the household masked, and the candidates that have no unit yet', async () => {
    const aim = await target({ itemKind: 'RESETTLEMENT_LAND' });
    const open = await target();
    const away = await target({ unit: ELSEWHERE });
    const made = await allocate(ALLOCATOR, aim, { unit_code: 'PLOT-LIST-1', area_m2: '90' });
    const seen = await list(READER);
    expect(seen.status).toBe(200);
    const mine = (seen.json.items as Array<Record<string, unknown>>).find((item) => item.id === made.json.resource_id);
    expect(mine).toMatchObject({ project_id: world.project, plan_item_id: aim.itemId, unit_kind: 'PLOT', unit_code: 'PLOT-LIST-1', area_m2: '90.00', status: 'ALLOCATED', allocated_on: TODAY, handed_on: null, version: 1 });
    const household = (mine as { household: { id: string; household_code: string; head_name: string } }).household;
    expect(household.id).toBe(aim.householdId);
    expect(household.head_name).not.toBe(HEAD);
    expect(household.head_name).toMatch(/\*/);
    expect(JSON.stringify(seen.json)).not.toContain(HEAD);
    const candidatesSeen = (await candidates(READER)).json.items as Array<{ plan_item_id: string; household: { head_name: string }; unit_kinds: string[] }>;
    expect(candidatesSeen.map((item) => item.plan_item_id)).toEqual(expect.arrayContaining([open.itemId, away.itemId]));
    expect(candidatesSeen.map((item) => item.plan_item_id)).not.toContain(aim.itemId);
    expect(candidatesSeen.find((item) => item.plan_item_id === open.itemId)?.unit_kinds).toEqual(['PLOT']);
    expect(JSON.stringify(candidatesSeen)).not.toContain(HEAD);
    // A reader of one unit sees only the allocations and the candidates of that unit.
    await allocate(ALLOCATOR, away, { owner_unit_id: unitId(ELSEWHERE), unit_code: 'PLOT-LIST-AWAY' });
    expect(((await list(DEPARTMENT_ALLOCATOR)).json.items as Array<{ unit_code: string }>).map((item) => item.unit_code)).not.toContain('PLOT-LIST-AWAY');
    expect(((await list(ALLOCATOR)).json.items as Array<{ unit_code: string }>).map((item) => item.unit_code)).toContain('PLOT-LIST-AWAY');
    expect((await list(PROJECT_ALLOCATOR)).json.items).toEqual([]);
    expect((await candidates(NOBODY)).status).toBe(403);
    expect((await list(NOBODY)).status).toBe(403);
  });

  it('pages and filters the list, and refuses a query that is not one', async () => {
    const made: string[] = [];
    for (let n = 0; n < 3; n += 1) made.push((await allocate(ALLOCATOR, await target(), { unit_code: `PLOT-PAGE-${n}` })).json.resource_id as string);
    const first = await list(ALLOCATOR, '&limit=2');
    expect((first.json.items as unknown[]).length).toBe(2);
    expect(typeof first.json.next_cursor).toBe('string');
    const second = await list(ALLOCATOR, `&limit=200&cursor=${encodeURIComponent(first.json.next_cursor as string)}`);
    const ids = [...(first.json.items as Array<{ id: string }>), ...(second.json.items as Array<{ id: string }>)].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(made));
    expect(((await list(ALLOCATOR, '&status=HANDED_OVER')).json.items as unknown[]).length).toBe(0);
    for (const bad of ['&status=MAYBE', '&cursor=nope', '&limit=0']) expect((await list(ALLOCATOR, bad)).status).toBe(422);
    expect((await call('GET', '/resettlement-allocations', { member: ALLOCATOR })).status).toBe(422);
    expect((await call('GET', '/resettlement-allocations/candidates', { member: ALLOCATOR })).status).toBe(422);
  });

  it('pages the candidates by household code instead of cutting them: every item that waits for a unit is reached', async () => {
    const aims: Target[] = [];
    for (let n = 0; n < 3; n += 1) aims.push(await target());
    const wanted = aims.map((aim) => aim.itemId);
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 20; page += 1) {
      const reply = await call('GET', `/resettlement-allocations/candidates?project_id=${world.project}&limit=2${cursor}`, { member: READER });
      expect(reply.status).toBe(200);
      const items = reply.json.items as Array<{ plan_item_id: string }>;
      expect(items.length).toBeLessThanOrEqual(2);
      seen.push(...items.map((item) => item.plan_item_id));
      if (reply.json.next_cursor === null) break;
      cursor = `&cursor=${encodeURIComponent(reply.json.next_cursor as string)}`;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(wanted));
    expect((await call('GET', `/resettlement-allocations/candidates?project_id=${world.project}&cursor=nope`, { member: READER })).status).toBe(422);
  });

  it('follows what a household was given through the revisions of its plan: the copy of an item that was allocated is not offered again, and is refused', async () => {
    const aim = await target();
    expect((await allocate(ALLOCATOR, aim, { unit_code: 'PLOT-REV-1' })).status).toBe(200);
    // The plan is revised (its items are copied under new ids) and the revision goes through its posting and its approval.
    const tenants = harness.tenants as TenantDatabase;
    const [planNow] = await rows<{ version: string }>('select version::text as version from machvon.compensation_plan where id = $1::uuid', [aim.planId]);
    const revised = await tenants.withTenant(context(OFFICER), (tx) => plans.revise(tx, aim.planId, 'The price of the land changed', Number(planNow?.version), memberId(OFFICER), '*'));
    await rows("update machvon.compensation_plan set status = 'POSTING', posting_started_on = date '2026-09-10', posting_ends_on = date '2026-10-10', posting_place_text = 'Commune office', timer_rule_version_id = gen_random_uuid() where id = $1::uuid", [revised.id]);
    await rows("update machvon.compensation_plan set status = 'POSTING_CLOSED', feedback_summary = 'No opinions' where id = $1::uuid", [revised.id]);
    await rows("update machvon.compensation_plan set status = 'APPROVED', approved_on = date '2026-10-12', approved_by = $2::uuid, payment_due_on = date '2026-12-31', decision_document_version_id = $3::uuid where id = $1::uuid", [revised.id, memberId(CHECKER), world.cleanDocument]);
    const [copy] = await rows<{ id: string }>('select id from machvon.compensation_plan_item where plan_id = $1::uuid and household_id = $2::uuid', [revised.id, aim.householdId]);
    const copied = copy as { id: string };
    expect(copied.id).not.toBe(aim.itemId);
    const offered = ((await candidates(READER)).json.items as Array<{ plan_item_id: string }>).map((item) => item.plan_item_id);
    expect(offered).not.toContain(copied.id);
    expect(await allocate(ALLOCATOR, { ...aim, itemId: copied.id, planId: revised.id }, { unit_code: 'PLOT-REV-2' })).toMatchObject({ status: 422, json: { code: 'HOUSEHOLD_NOT_ELIGIBLE', reason: 'ALREADY_ALLOCATED' } });
    expect(await rows('select 1 from machvon.resettlement_allocation where household_id = $1::uuid', [aim.householdId])).toHaveLength(1);
  });

  it('waits for the revision of a plan that is under way and then refuses the plan it made REVISED: the plan is locked with the item', async () => {
    const aim = await target();
    const reviser = new Client({ connectionString: harness.database.adminUrl });
    await reviser.connect();
    try {
      await reviser.query('begin');
      await reviser.query("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
      await reviser.query('select 1 from machvon.compensation_plan where id = $1::uuid for update', [aim.planId]);
      const pending = allocate(ALLOCATOR, aim, { unit_code: 'PLOT-REVISION' });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await reviser.query("update machvon.compensation_plan set status = 'REVISED' where id = $1::uuid", [aim.planId]);
      await reviser.query('commit');
      const reply = await pending;
      expect(reply).toMatchObject({ status: 422, json: { code: 'HOUSEHOLD_NOT_ELIGIBLE', reason: 'PLAN_NOT_APPROVED' } });
    } finally {
      await reviser.end();
    }
    expect(await rows('select 1 from machvon.resettlement_allocation where plan_item_id = $1::uuid', [aim.itemId])).toHaveLength(0);
  });

  it('is kept by the database as well: one unit and one item are held once, what was allocated does not change, a final allocation stays, and nothing is deleted', async () => {
    const aim = await target();
    const id = (await allocate(ALLOCATOR, aim, { unit_code: 'PLOT-DB-1' })).json.resource_id as string;
    await expect(rows("insert into machvon.resettlement_allocation (tenant_id, id, household_id, plan_item_id, owner_unit_id, unit_kind, unit_code, site_text, allocated_on, status, created_by, updated_by) values ($1, $2, $3, $4, $5, 'PLOT', 'PLOT-DB-2', 'Site', date '2026-10-20', 'ALLOCATED', $6, $6)", [TENANT_A, randomUUID(), aim.householdId, aim.itemId, unitId(DEPARTMENT), memberId(ALLOCATOR)])).rejects.toThrow(/resettlement_plan_item_uq/);
    await expect(rows("update machvon.resettlement_allocation set unit_code = 'OTHER' where id = $1::uuid", [id])).rejects.toThrow(/do not change/);
    await expect(rows("update machvon.resettlement_allocation set household_id = $2::uuid where id = $1::uuid", [id, (await target()).householdId])).rejects.toThrow(/do not change/);
    await expect(rows("update machvon.resettlement_allocation set unit_code = ' padded ' where id = $1::uuid", [id])).rejects.toThrow();
    await rows("update machvon.resettlement_allocation set status = 'HANDED_OVER', handed_on = $2::date where id = $1::uuid", [id, TODAY]);
    await expect(rows("update machvon.resettlement_allocation set status = 'ALLOCATED' where id = $1::uuid", [id])).rejects.toThrow(/final/);
    const asApplication = (sql: string): Promise<string> =>
      harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(ALLOCATOR), scopeVersion: 0 }, (tx) => tx.query(sql)).then(
        () => 'written',
        (error: { message: string }) => error.message,
      );
    expect(await asApplication('delete from machvon.resettlement_allocation')).toContain('permission denied');
    // A declined allocation gives the unit back: the same code can be allocated again.
    const declined = await target();
    const declinedId = (await allocate(ALLOCATOR, declined, { unit_code: 'PLOT-DB-3' })).json.resource_id as string;
    await rows("update machvon.resettlement_allocation set status = 'DECLINED' where id = $1::uuid", [declinedId]);
    expect((await allocate(ALLOCATOR, await target(), { unit_code: 'PLOT-DB-3' })).status).toBe(200);
    expect((await allocate(ALLOCATOR, declined, { unit_code: 'PLOT-DB-4' })).status).toBe(200);
  });
});

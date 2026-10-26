import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, LndHouseholdStore, LndInventoryStore, LndParcelStore, MasterStore, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { FieldCipher, loadErrorRegistry, signTenantContext, staticKeyProvider } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { CompensationPlanController, CompensationPlanReadsController, planItemView, planLineView } from '../../src/modules/lnd/plan.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedLndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import type { LndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PLANNER = 1; // land.plan.write and land.read on the whole tenant
const DEPARTMENT_PLANNER = 2; // the same on the unit tree of the department only
const PROJECT_PLANNER = 3; // the same on project 1 only: it reaches the plans of the project and no household
const READER = 4; // land.read on the whole tenant
const NOBODY = 5;
const COUNTER = 6; // counts inventory (through the stores)
const CHECKER = 7;
const B_PLANNER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0xbc;
const FAMILY_B = 0xbd;
const WORKER = WORKER_MEMBERSHIP_ID;
const DECISION = 'QD-GIA-2024';
const BASIS = 'Luật Đất đai 2024, Điều 91';
const POLICY = 'Nghị định 88/2024/NĐ-CP, Điều 21';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the plan of compensation, support and resettlement: drafting, composing it from confirmed inventory and revising it (ST-LND-005)', () => {
  const harness = new AuthzHarness();
  const cipher = new FieldCipher(staticKeyProvider(new Map([[1, randomBytes(32)]])));
  const households = new LndHouseholdStore(cipher);
  const parcels = new LndParcelStore();
  const inventory = new LndInventoryStore();
  const masters = new MasterStore();
  let app: RunningApp;
  let world: LndWorld;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const get = (member: number, url: string, tenantId?: string): Promise<Reply> => call('GET', url, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> =>
    harness.owner<R>(tenant, [
      ["select set_config('app.scope_units', '*', false)", []],
      [sql, params],
    ]);
  const context = (member: number) => ({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 });

  async function priceDecision(key: string): Promise<void> {
    const tenants = harness.tenants as TenantDatabase;
    const created = await tenants.withTenant(context(COUNTER), (tx) =>
      masters.propose(tx, { masterType: 'LND_PRICE_DECISION', businessKey: key, content: { label: key, attributes: { title: `Decision ${key}` }, parentRecordId: null, validFrom: '2024-01-01', validUntil: null, legalBasis: null }, reason: 'Decision' }, memberId(COUNTER)),
    );
    await rows("update machvon.master_record_version set status = 'EFFECTIVE', published_at = now() where master_record_id = $1::uuid", [created.recordId]);
  }

  interface Target {
    householdId: string;
    parcelId: string;
  }
  async function target(unit = DEPARTMENT): Promise<Target> {
    counter += 1;
    const tenants = harness.tenants as TenantDatabase;
    const registered = await tenants.withTenant(context(COUNTER), (tx) =>
      households.register(tx, { projectId: world.project, ownerUnitId: unitId(unit), headName: 'Nguyễn Văn A', nationalId: String(500000000000 + counter * 23), legalBasis: 'PUBLIC_TASK_LAND_LAW', legalBasisRef: BASIS, retentionUntil: '2036-12-31' }, memberId(COUNTER), '*', '2026-10-26'),
    );
    const parcel = await tenants.withTenant(context(COUNTER), (tx) =>
      parcels.create(tx, { projectId: world.project, ownerUnitId: unitId(unit), parcelCode: `LP-Q-${String(counter).padStart(4, '0')}`, landUseGroup: 'AGRICULTURAL', areaTotalM2: '1000', areaAffectedM2: '500' }, memberId(COUNTER), '2026-10-26'),
    );
    await tenants.withTenant(context(COUNTER), (tx) => households.link(tx, registered.id, { parcelId: parcel.id, rightKind: 'OWNER' }, memberId(COUNTER), '*'));
    return { householdId: registered.id, parcelId: parcel.id };
  }
  /** A record of the household, counted by one officer and confirmed by another when asked to. */
  async function inventoryOf(aim: Target, confirmed: boolean): Promise<string> {
    const tenants = harness.tenants as TenantDatabase;
    const counted = await tenants.withTenant(context(COUNTER), (tx) =>
      inventory.record(tx, { householdId: aim.householdId, parcelId: aim.parcelId, itemKind: 'HOUSE', description: 'House of level 4', quantity: '80', unitCode: 'M2', unitPriceVnd: '4500000', priceDecisionRef: DECISION, surveyedOn: '2026-06-20' }, memberId(COUNTER), '*', '2026-10-26'),
    );
    if (confirmed) await tenants.withTenant(context(CHECKER), (tx) => inventory.confirm(tx, counted.id, { outcome: 'CONFIRMED', householdConfirmedOn: '2026-07-01' }, 1, memberId(CHECKER), '*', '2026-10-26'));
    return counted.id;
  }

  const draft = (member: number, extra: Record<string, unknown> = {}, options: { key?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', '/compensation-plans', {
      member,
      ...(options.key === undefined ? {} : { key: options.key }),
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      body: { project_id: world.project, executor_unit_id: unitId(DEPARTMENT), executor_kind: 'LAND_FUND_CENTRE', plan_code: `PA-${String(++counter).padStart(4, '0')}`, ...extra },
    });
  const items = (member: number, planId: string, version: number | string, list: Array<Record<string, unknown>>, tenantId?: string): Promise<Reply> =>
    call('POST', `/compensation-plans/${planId}/items`, { member, ifMatch: `"${version}"`, ...(tenantId === undefined ? {} : { tenantId }), body: { items: list } });
  const revise = (member: number, planId: string, version: number | string, reason = 'The price of the land changed', tenantId?: string): Promise<Reply> =>
    call('POST', `/compensation-plans/${planId}/revise`, { member, ifMatch: `"${version}"`, ...(tenantId === undefined ? {} : { tenantId }), body: { reason } });
  const compensation = (aim: Target, basis: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ household_id: aim.householdId, item_kind: 'COMPENSATION_ASSET', basis_inventory_id: basis, legal_basis: BASIS, ...extra });
  const support = (aim: Target, amount: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ household_id: aim.householdId, item_kind: 'SUPPORT_LIVELIHOOD', amount_vnd: amount, legal_basis: POLICY, ...extra });
  const planOf = async (member = PLANNER): Promise<{ id: string; version: number }> => ({ id: (await draft(member)).json.resource_id as string, version: 1 });
  const post = (planId: string) => rows("update machvon.compensation_plan set status = 'POSTING', posting_started_on = date '2026-10-01', posting_ends_on = date '2026-10-31', posting_place_text = 'Commune office', timer_rule_version_id = gen_random_uuid() where id = $1::uuid", [planId]);

  const audits = (resourceId: string, action: string) =>
    rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string; classification: string }>(
      'select safe_diff, outcome, actor_id, classification from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at',
      [resourceId, action],
    );
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);
  const planRow = async (id: string) =>
    (await rows<Record<string, unknown>>('select status, revision, supersedes_id, revision_reason, total_compensation_vnd::text as comp, total_support_vnd::text as support, grand_total_vnd::text as grand, version::text as version from machvon.compensation_plan where id = $1::uuid', [id]))[0];

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER, '2026-10-24'));
    for (const n of [PLANNER, DEPARTMENT_PLANNER, PROJECT_PLANNER, READER, NOBODY, COUNTER, CHECKER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_PLANNER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PLAN_WRITER', ['land.plan.write', 'land.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'LAND_READER', ['land.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'PLAN_WRITER', ['land.plan.write', 'land.read'], 30);
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, COUNTER, DEPARTMENT, ROOT);
    await seedLndWorld(harness.database.adminUrl, TENANT_B, FAMILY_B, B_PLANNER, DEPARTMENT, ROOT);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PLANNER, role: 1, kind: 'TENANT' },
      { n: 2, member: DEPARTMENT_PLANNER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: PROJECT_PLANNER, role: 1, kind: 'PROJECT', refs: [world.project] },
      { n: 4, member: READER, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_PLANNER, role: 1, kind: 'TENANT' }]);
    await priceDecision(DECISION);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [CompensationPlanController, CompensationPlanReadsController],
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

  describe('draftCompensationPlan', () => {
    it('drafts an empty plan for a project, audits it and tells the world with ids and the code', async () => {
      const done = await draft(PLANNER, { plan_code: 'PA-FIRST' });
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const id = done.json.resource_id as string;
      expect(await planRow(id)).toMatchObject({ status: 'DRAFT', revision: 1, comp: '0', support: '0', grand: '0', version: '1' });
      const [audit] = await audits(id, 'lnd.plan_drafted');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(PLANNER), classification: 'INTERNAL', safe_diff: { plan_code: 'PA-FIRST', project_id: world.project, executor_unit_id: unitId(DEPARTMENT), executor_kind: 'LAND_FUND_CENTRE', revision: 1, status: 'DRAFT' } });
      const [event] = await events(id, 'lnd.plan.drafted.v1');
      expect(event?.payload).toMatchObject({ plan_id: id, project_id: world.project, plan_code: 'PA-FIRST', revision: 1, tenant_id: TENANT_A });
    });

    it('answers a repeated request with the first answer and drafts once, and refuses the same code twice with 409 PLAN_CODE_DUPLICATE', async () => {
      const key = `key-${randomUUID()}`;
      const first = await draft(PLANNER, { plan_code: 'PA-IDEM' }, { key });
      const second = await draft(PLANNER, { plan_code: 'PA-IDEM' }, { key });
      expect(second.json.resource_id).toBe(first.json.resource_id);
      const again = await draft(PLANNER, { plan_code: 'PA-IDEM' });
      expect([again.status, again.json.code]).toEqual([409, 'PLAN_CODE_DUPLICATE']);
      expect(await rows("select 1 from machvon.compensation_plan where plan_code = 'PA-IDEM'")).toHaveLength(1);
    });

    it('wants its fields: 422 VALIDATION_FAILED for a missing one or a value that is not one, 400 for a field it does not know', async () => {
      for (const missing of ['project_id', 'executor_unit_id', 'executor_kind', 'plan_code']) {
        const refused = await draft(PLANNER, { [missing]: undefined });
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', missing]);
      }
      for (const extra of [{ executor_kind: 'NOBODY' }, { plan_code: '   ' }, { plan_code: 'x'.repeat(51) }, { section_id: randomUUID() }]) {
        const refused = await draft(PLANNER, extra);
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      const unknown = await draft(PLANNER, { grand_total_vnd: '5' });
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
    });

    it('is drafted for a project the officer reaches: the unit tree of its owner and a grant on the project do, a reader, nobody, another tenant and a project that is not there do not', async () => {
      expect((await draft(DEPARTMENT_PLANNER)).status).toBe(200);
      expect((await draft(PROJECT_PLANNER)).status).toBe(200);
      expect((await draft(READER)).status).toBe(403);
      expect((await draft(NOBODY)).status).toBe(403);
      expect((await draft(PLANNER, { project_id: randomUUID() })).status).toBe(404);
      expect((await draft(PLANNER, { executor_unit_id: randomUUID() })).status).toBe(404);
      expect((await draft(B_PLANNER, {}, { tenantId: TENANT_B })).status).toBe(404);
    });
  });

  describe('addCompensationPlanItems', () => {
    it('AC-ST-LND-005-1, UAT-AC382: composes a plan from a confirmed record and a policy amount, keeps the price decision, and the plan totals are the sums of its items', async () => {
      const aim = await target();
      const confirmed = await inventoryOf(aim, true);
      const plan = await planOf();
      const done = await items(PLANNER, plan.id, plan.version, [compensation(aim, confirmed), support(aim, '10000000'), { household_id: aim.householdId, item_kind: 'RESETTLEMENT_HOUSE', amount_vnd: '500000000', legal_basis: POLICY }]);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'DRAFT', resource_version: 2, resource_id: plan.id });
      expect(await planRow(plan.id)).toMatchObject({ comp: '360000000', support: '10000000', grand: '870000000', version: '2' });
      const [item] = await rows<Record<string, unknown>>("select amount_vnd::text as amount, quantity::text as quantity, unit_price_vnd::text as price, price_decision_ref, price_decision_revision, parcel_id from machvon.compensation_plan_item where plan_id = $1::uuid and item_kind = 'COMPENSATION_ASSET'", [plan.id]);
      expect(item).toEqual({ amount: '360000000', quantity: '80.000000', price: '4500000', price_decision_ref: DECISION, price_decision_revision: 1, parcel_id: aim.parcelId });
      const [audit] = await audits(plan.id, 'lnd.plan_items_added');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(PLANNER), classification: 'PERSONAL', safe_diff: { project_id: world.project, item_count: 3, total_compensation_vnd: '360000000', total_support_vnd: '10000000', total_resettlement_vnd: '500000000', grand_total_vnd: '870000000' } });
      const [event] = await events(plan.id, 'lnd.plan.items_changed.v1');
      expect(event?.payload).toMatchObject({ plan_id: plan.id, items_added: 3, grand_total_vnd: '870000000', version: 2 });
      expect(JSON.stringify([audit, event])).not.toContain(aim.householdId);
    });

    it('AC-ST-LND-005-1, UAT-AC382: refuses a record that is not confirmed (422 INVENTORY_NOT_CONFIRMED) and adds none of the items of the call', async () => {
      const aim = await target();
      const confirmed = await inventoryOf(aim, true);
      const drafted = await inventoryOf(aim, false);
      const plan = await planOf();
      const refused = await items(PLANNER, plan.id, 1, [compensation(aim, confirmed), compensation(aim, drafted)]);
      expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'INVENTORY_NOT_CONFIRMED', 'items[1].basis_inventory_id']);
      expect(await rows('select 1 from machvon.compensation_plan_item where plan_id = $1::uuid', [plan.id])).toEqual([]);
      expect(await planRow(plan.id)).toMatchObject({ comp: '0', version: '1' });
    });

    it('answers a repeated request with the first answer and adds the items once', async () => {
      const aim = await target();
      const plan = await planOf();
      const key = `key-${randomUUID()}`;
      const send = () => call('POST', `/compensation-plans/${plan.id}/items`, { member: PLANNER, ifMatch: '"1"', key, body: { items: [support(aim, '7')] } });
      const first = await send();
      const second = await send();
      expect(second.json).toEqual(first.json);
      expect(await rows('select 1 from machvon.compensation_plan_item where plan_id = $1::uuid', [plan.id])).toHaveLength(1);
      expect(await planRow(plan.id)).toMatchObject({ support: '7', version: '2' });
    });

    it('wants its items: 422 VALIDATION_FAILED naming the item and the field, 409 VERSION_CONFLICT for a stale version, 409 PLAN_STATE_INVALID for a plan that is posted', async () => {
      const aim = await target();
      const plan = await planOf();
      const none = await items(PLANNER, plan.id, 1, []);
      expect([none.status, none.json.code, none.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'items']);
      const kind = await items(PLANNER, plan.id, 1, [support(aim, '1'), support(aim, '1', { item_kind: 'SUPPORT_NOTHING' })]);
      expect([kind.status, kind.json.code, kind.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'items[1].item_kind']);
      const amount = await items(PLANNER, plan.id, 1, [support(aim, '1.5')]);
      expect([amount.status, amount.json.code, amount.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'items[0].amount_vnd']);
      const missing = await call('POST', `/compensation-plans/${plan.id}/items`, { member: PLANNER, ifMatch: '"1"', body: {} });
      expect([missing.status, missing.json.code, missing.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'items']);
      const stale = await items(PLANNER, plan.id, 9, [support(aim, '1')]);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await items(PLANNER, plan.id, 1, [support(aim, '1')])).status).toBe(200);
      await post(plan.id);
      const posted = await items(PLANNER, plan.id, 2, [support(aim, '1')]);
      expect([posted.status, posted.json.code]).toEqual([409, 'PLAN_STATE_INVALID']);
      expect(await rows('select 1 from machvon.compensation_plan_item where plan_id = $1::uuid', [plan.id])).toHaveLength(1);
    });

    it('is written inside the units of the households: the department sees its own, a grant on a project reaches no household, a reader is turned away, another tenant does not find the plan', async () => {
      const inside = await target();
      const elsewhere = await target(ELSEWHERE);
      const plan = await planOf();
      expect((await items(DEPARTMENT_PLANNER, plan.id, 1, [support(inside, '5')])).status).toBe(200);
      const hidden = await items(DEPARTMENT_PLANNER, plan.id, 2, [support(elsewhere, '5')]);
      expect([hidden.status, hidden.json.code, hidden.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'items[0].household_id']);
      const byProject = await items(PROJECT_PLANNER, plan.id, 2, [support(inside, '5')]);
      expect([byProject.status, byProject.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await items(READER, plan.id, 2, [support(inside, '5')])).status).toBe(403);
      expect((await items(NOBODY, plan.id, 2, [support(inside, '5')])).status).toBe(403);
      expect((await items(B_PLANNER, plan.id, 2, [support(inside, '5')], TENANT_B)).status).toBe(404);
      expect((await items(PLANNER, randomUUID(), 1, [support(inside, '5')])).status).toBe(404);
      expect(await planRow(plan.id)).toMatchObject({ support: '5', version: '2' });
    });
  });

  describe('revisePlan', () => {
    it('AC-ST-LND-005-2, UAT-PLAN-30: replaces a plan that was posted by a new revision, leaving the earlier one readable and marked as replaced', async () => {
      const aim = await target();
      const confirmed = await inventoryOf(aim, true);
      const plan = await planOf();
      await items(PLANNER, plan.id, 1, [compensation(aim, confirmed), support(aim, '10000000')]);
      await post(plan.id);
      const done = await revise(PLANNER, plan.id, 2, ' The price of the land changed ');
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const revisedId = done.json.resource_id as string;
      expect(revisedId).not.toBe(plan.id);
      expect(await planRow(plan.id)).toMatchObject({ status: 'REVISED', revision: 1, comp: '360000000', support: '10000000', version: '3' });
      expect(await planRow(revisedId)).toMatchObject({ status: 'DRAFT', revision: 2, supersedes_id: plan.id, revision_reason: 'The price of the land changed', comp: '360000000', support: '10000000', grand: '370000000', version: '1' });
      const [audit] = await audits(revisedId, 'lnd.plan_revised');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(PLANNER), safe_diff: { previous_plan_id: plan.id, revision: 2, items_copied: 2, grand_total_vnd: '370000000' } });
      const [event] = await events(revisedId, 'lnd.plan.revised.v1');
      expect(event?.payload).toMatchObject({ plan_id: revisedId, previous_plan_id: plan.id, revision: 2 });
      const earlier = await get(READER, `/compensation-plans/${plan.id}/items`);
      const later = await get(READER, `/compensation-plans/${revisedId}/items`);
      expect((earlier.json.items as unknown[]).length).toBe(2);
      expect((later.json.items as unknown[]).length).toBe(2);
      const added = await items(PLANNER, revisedId, 1, [support(aim, '1', { item_kind: 'SUPPORT_TRAINING' })]);
      expect(added.status).toBe(200);
    });

    it('revises a plan that was posted or approved only (409 PLAN_STATE_INVALID), under the version seen (409 VERSION_CONFLICT), for a reason in words (422 VALIDATION_FAILED)', async () => {
      const aim = await target();
      const plan = await planOf();
      await items(PLANNER, plan.id, 1, [support(aim, '1')]);
      const draftState = await revise(PLANNER, plan.id, 2);
      expect([draftState.status, draftState.json.code]).toEqual([409, 'PLAN_STATE_INVALID']);
      await post(plan.id);
      expect((await revise(PLANNER, plan.id, 9)).json.code).toBe('VERSION_CONFLICT');
      for (const reason of ['', '   ']) {
        const refused = await revise(PLANNER, plan.id, 2, reason);
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      const missing = await call('POST', `/compensation-plans/${plan.id}/revise`, { member: PLANNER, ifMatch: '"2"', body: {} });
      expect([missing.status, missing.json.code, missing.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'reason']);
      expect((await revise(PLANNER, plan.id, 2)).status).toBe(200);
      const twice = await revise(PLANNER, plan.id, 3);
      expect([twice.status, twice.json.code]).toEqual([409, 'PLAN_STATE_INVALID']);
    });

    it('is revised by someone who reaches the project and sees all its items: a reader and nobody are turned away, a plan that is not there is 404, a narrower scope is 403', async () => {
      const here = await target();
      const there = await target(ELSEWHERE);
      const plan = await planOf();
      await items(PLANNER, plan.id, 1, [support(here, '1'), support(there, '2')]);
      await post(plan.id);
      expect((await revise(READER, plan.id, 2)).status).toBe(403);
      expect((await revise(NOBODY, plan.id, 2)).status).toBe(403);
      expect((await revise(B_PLANNER, plan.id, 2, 'Another tenant', TENANT_B)).status).toBe(404);
      expect((await revise(PLANNER, randomUUID(), 1)).status).toBe(404);
      const narrow = await revise(DEPARTMENT_PLANNER, plan.id, 2);
      expect([narrow.status, narrow.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await planRow(plan.id))?.status).toBe('POSTING');
      expect((await revise(PROJECT_PLANNER, plan.id, 2)).status).toBe(403);
    });
  });

  describe('listCompensationPlans and listCompensationPlanItems', () => {
    it('lists the plans of a project by code, every revision of them, with the filters and the cursor', async () => {
      const aim = await target();
      const first = await planOf();
      await items(PLANNER, first.id, 1, [support(aim, '3')]);
      await post(first.id);
      const revisedId = (await revise(PLANNER, first.id, 2)).json.resource_id as string;
      const all = await get(READER, `/compensation-plans?project_id=${world.project}`);
      expect(all.status).toBe(200);
      const list = all.json.items as Array<Record<string, unknown>>;
      const code = (list.find((line) => line.id === first.id) as Record<string, unknown>).plan_code;
      expect(list.filter((line) => line.plan_code === code).map((line) => [line.revision, line.status])).toEqual([
        [2, 'DRAFT'],
        [1, 'REVISED'],
      ]);
      expect(list.find((line) => line.id === revisedId)).toMatchObject({
        project_id: world.project,
        executor_kind: 'LAND_FUND_CENTRE',
        revision: 2,
        supersedes_id: first.id,
        revision_reason: 'The price of the land changed',
        total_support_vnd: '3',
        grand_total_vnd: '3',
        version: 1,
      });
      expect(typeof all.json.as_of).toBe('string');
      expect(((await get(READER, `/compensation-plans?project_id=${world.project}&status=REVISED`)).json.items as Array<{ id: string }>).map((line) => line.id)).toContain(first.id);
      const page = await get(READER, `/compensation-plans?project_id=${world.project}&limit=1`);
      expect(page.json.items).toHaveLength(1);
      expect(typeof page.json.next_cursor).toBe('string');
      const next = await get(READER, `/compensation-plans?project_id=${world.project}&limit=1&cursor=${page.json.next_cursor as string}`);
      expect((next.json.items as Array<{ id: string }>)[0]?.id).not.toBe((page.json.items as Array<{ id: string }>)[0]?.id);
    });

    it('shows the plans of the project to who reaches it, and nothing to the others; wants a project, a status, a limit and a cursor that are what they should be', async () => {
      await planOf();
      expect(((await get(PROJECT_PLANNER, `/compensation-plans?project_id=${world.project}`)).json.items as unknown[]).length).toBeGreaterThan(0);
      expect(((await get(DEPARTMENT_PLANNER, `/compensation-plans?project_id=${world.project}`)).json.items as unknown[]).length).toBeGreaterThan(0);
      expect((await get(B_PLANNER, `/compensation-plans?project_id=${world.project}`, TENANT_B)).json.items).toEqual([]);
      expect((await get(NOBODY, `/compensation-plans?project_id=${world.project}`)).status).toBe(403);
      for (const query of ['&status=NOPE', '&limit=0', '&cursor=!!!']) {
        const refused = await get(READER, `/compensation-plans?project_id=${world.project}${query}`);
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      for (const url of ['/compensation-plans', '/compensation-plans?project_id=nope']) {
        const refused = await get(READER, url);
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'project_id']);
      }
    });

    it('shows the items of a plan with what they count, inside the units of the reader, and a plan it does not reach as if it were not there', async () => {
      const here = await target();
      const there = await target(ELSEWHERE);
      const confirmed = await inventoryOf(here, true);
      const plan = await planOf();
      await items(PLANNER, plan.id, 1, [compensation(here, confirmed), support(there, '7')]);
      const all = await get(READER, `/compensation-plans/${plan.id}/items`);
      expect(all.status).toBe(200);
      const list = all.json.items as Array<Record<string, unknown>>;
      expect(list).toHaveLength(2);
      expect(list.find((item) => item.basis_inventory_id === confirmed)).toMatchObject({
        plan_id: plan.id,
        household_id: here.householdId,
        parcel_id: here.parcelId,
        owner_unit_id: unitId(DEPARTMENT),
        item_kind: 'COMPENSATION_ASSET',
        amount_vnd: '360000000',
        quantity: '80.000000',
        unit_code: 'M2',
        unit_price_vnd: '4500000',
        price_decision_ref: DECISION,
        price_decision_revision: 1,
        legal_basis: BASIS,
      });
      expect(all.json.next_cursor).toBeNull();
      expect(((await get(DEPARTMENT_PLANNER, `/compensation-plans/${plan.id}/items`)).json.items as Array<{ item_kind: string }>).map((item) => item.item_kind)).toEqual(['COMPENSATION_ASSET']);
      expect((await get(PROJECT_PLANNER, `/compensation-plans/${plan.id}/items`)).json.items).toEqual([]);
      expect((await get(B_PLANNER, `/compensation-plans/${plan.id}/items`, TENANT_B)).status).toBe(404);
      expect((await get(NOBODY, `/compensation-plans/${plan.id}/items`)).status).toBe(403);
      expect((await get(READER, `/compensation-plans/${randomUUID()}/items`)).status).toBe(404);
    });
  });

  it('shows a plan and an item in the allowlist and nothing else', () => {
    const plan = planLineView({
      id: 'a',
      projectId: 'p',
      sectionId: null,
      executorUnitId: 'u',
      executorKind: 'LAND_FUND_CENTRE',
      planCode: 'PA',
      revision: 1,
      supersedesId: null,
      revisionReason: null,
      totalCompensationVnd: '0',
      totalSupportVnd: '0',
      totalResettlementVnd: '0',
      grandTotalVnd: '0',
      status: 'DRAFT',
      postingStartedOn: null,
      postingEndsOn: null,
      postingPlaceText: null,
      feedbackSummary: null,
      approvedOn: null,
      paymentDueOn: null,
      decisionDocumentVersionId: null,
      version: 1,
    });
    expect(Object.keys(plan).sort()).toEqual(
      [
        'approved_on', 'decision_document_version_id', 'executor_kind', 'executor_unit_id', 'feedback_summary', 'grand_total_vnd', 'id', 'payment_due_on', 'plan_code', 'posting_ends_on', 'posting_place_text', 'posting_started_on', 'project_id', 'revision', 'revision_reason', 'section_id',
        'status', 'supersedes_id', 'total_compensation_vnd', 'total_resettlement_vnd', 'total_support_vnd', 'version',
      ].sort(),
    );
    const item = planItemView({
      id: 'i',
      planId: 'a',
      householdId: 'h',
      householdCode: 'HH-000001',
      parcelId: null,
      parcelCode: null,
      ownerUnitId: 'u',
      itemKind: 'SUPPORT_TRAINING',
      amountVnd: '1',
      basisInventoryId: null,
      quantity: null,
      unitCode: null,
      unitPriceVnd: null,
      priceDecisionRef: null,
      priceDecisionRevision: null,
      legalBasis: 'x',
    });
    expect(Object.keys(item).sort()).toEqual(
      ['amount_vnd', 'basis_inventory_id', 'household_code', 'household_id', 'id', 'item_kind', 'legal_basis', 'owner_unit_id', 'parcel_code', 'parcel_id', 'plan_id', 'price_decision_ref', 'price_decision_revision', 'quantity', 'unit_code', 'unit_price_vnd'].sort(),
    );
  });
});

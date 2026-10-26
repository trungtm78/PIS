import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, LndHouseholdStore, LndParcelStore, MasterStore, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { FieldCipher, loadErrorRegistry, signTenantContext, staticKeyProvider } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { LandInventoryController, LandInventoryReadsController, inventoryLineView } from '../../src/modules/lnd/inventory.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedLndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import type { LndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const COUNTER = 1; // counts the assets: land.process and land.household.read on the whole tenant
const CHECKER = 2; // the same, the person who records the answer of the household
const DEPARTMENT_COUNTER = 3; // the same on the unit tree of the department only
const READER = 4; // land.household.read on the whole tenant
const NOBODY = 5;
const PROJECT_COUNTER = 6; // the same rights as the counter, on project 1 only: a grant on a project reaches no household
const B_COUNTER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0xb9;
const FAMILY_B = 0xba;
const WORKER = WORKER_MEMBERSHIP_ID;
const OLD_DECISION = 'QD-GIA-2024';
const NEW_DECISION = 'QD-GIA-2026';
const DESCRIPTION = 'Brick house of level 4 with a tiled roof, built in 2011';
const NOTE = 'The household says the house is 95 square metres';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** A day that has not come, whatever day the test runs on (the commands judge a date against the day in Vietnam). */
const TOMORROW = new Date(Date.now() + 7 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);

describe('the inventory of the assets of the affected households: counting at a price decision in force and the answer of the household (ST-LND-004)', () => {
  const harness = new AuthzHarness();
  const cipher = new FieldCipher(staticKeyProvider(new Map([[1, randomBytes(32)]])));
  const households = new LndHouseholdStore(cipher);
  const parcels = new LndParcelStore();
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

  /** A decision on land prices in force from one day to another, made the way the catalogue makes one and then published. */
  async function priceDecision(key: string, validFrom: string, validUntil: string | null): Promise<void> {
    const tenants = harness.tenants as TenantDatabase;
    const created = await tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(COUNTER), scopeVersion: 1 }, (tx) =>
      masters.propose(
        tx,
        { masterType: 'LND_PRICE_DECISION', businessKey: key, content: { label: key, attributes: { title: `Decision ${key} on land prices` }, parentRecordId: null, validFrom, validUntil, legalBasis: null }, reason: 'Decision on land prices' },
        memberId(COUNTER),
      ),
    );
    await rows("update machvon.master_record_version set status = 'EFFECTIVE', published_at = now() where master_record_id = $1::uuid", [created.recordId]);
  }

  interface Target {
    householdId: string;
    parcelId: string;
  }
  /** A household of the department with a parcel of the department it holds a right on, made through the stores. */
  async function target(unit = DEPARTMENT): Promise<Target> {
    counter += 1;
    const tenants = harness.tenants as TenantDatabase;
    const context = { tenantId: TENANT_A, membershipId: memberId(COUNTER), scopeVersion: 1 };
    const registered = await tenants.withTenant(context, (tx) =>
      households.register(
        tx,
        {
          projectId: world.project,
          ownerUnitId: unitId(unit),
          headName: 'Nguyễn Văn A',
          nationalId: String(300000000000 + counter * 17),
          legalBasis: 'PUBLIC_TASK_LAND_LAW',
          legalBasisRef: 'Luật Đất đai 2024, Điều 87',
          retentionUntil: '2036-12-31',
        },
        memberId(COUNTER),
        '*',
        '2026-10-26',
      ),
    );
    const parcel = await tenants.withTenant(context, (tx) =>
      parcels.create(
        tx,
        { projectId: world.project, ownerUnitId: unitId(unit), parcelCode: `LP-V-${String(counter).padStart(4, '0')}`, landUseGroup: 'AGRICULTURAL', areaTotalM2: '1000', areaAffectedM2: '500' },
        memberId(COUNTER),
        '2026-10-26',
      ),
    );
    await tenants.withTenant(context, (tx) => households.link(tx, registered.id, { parcelId: parcel.id, rightKind: 'OWNER' }, memberId(COUNTER), '*'));
    return { householdId: registered.id, parcelId: parcel.id };
  }

  const record = (member: number, aim: Target, extra: Record<string, unknown> = {}, options: { key?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', '/land-inventory-records', {
      member,
      ...(options.key === undefined ? {} : { key: options.key }),
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      body: {
        household_id: aim.householdId,
        parcel_id: aim.parcelId,
        item_kind: 'HOUSE',
        description: DESCRIPTION,
        quantity: '80',
        unit_code: 'M2',
        unit_price_vnd: '4500000',
        price_decision_ref: OLD_DECISION,
        surveyed_on: '2026-06-20',
        ...extra,
      },
    });
  const confirm = (member: number, id: string, version: number | string, extra: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> =>
    call('POST', `/land-inventory-records/${id}/confirm`, {
      member,
      ifMatch: `"${version}"`,
      ...(tenantId === undefined ? {} : { tenantId }),
      body: { outcome: 'CONFIRMED', household_confirmed_on: '2026-07-01', ...extra },
    });
  const listOf = (member: number, householdId: string, query = '', tenantId?: string): Promise<Reply> => get(member, `/land-inventory-records?household_id=${householdId}${query}`, tenantId);

  const audits = (resourceId: string, action: string) =>
    rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string; classification: string }>(
      'select safe_diff, outcome, actor_id, classification from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at',
      [resourceId, action],
    );
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);
  const stored = async (id: string) =>
    (await rows<Record<string, unknown>>('select status, amount_vnd::text as amount, household_dispute, confirmed_by, note, price_decision_ref, version::text as version from machvon.land_inventory_record where id = $1::uuid', [id]))[0];
  const statusOf = async (table: 'affected_household' | 'land_parcel', id: string): Promise<string> => (await rows<{ status: string }>(`select status from machvon.${table} where id = $1::uuid`, [id]))[0]?.status ?? '';

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
    for (const n of [COUNTER, CHECKER, DEPARTMENT_COUNTER, READER, NOBODY, PROJECT_COUNTER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_COUNTER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'INVENTORY_OFFICER', ['land.process', 'land.household.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'HOUSEHOLD_READER', ['land.household.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'INVENTORY_OFFICER', ['land.process', 'land.household.read'], 30);
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, COUNTER, DEPARTMENT, ROOT);
    await seedLndWorld(harness.database.adminUrl, TENANT_B, FAMILY_B, B_COUNTER, DEPARTMENT, ROOT);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: COUNTER, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 1, kind: 'TENANT' },
      { n: 3, member: DEPARTMENT_COUNTER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 4, member: READER, role: 2, kind: 'TENANT' },
      { n: 5, member: PROJECT_COUNTER, role: 1, kind: 'PROJECT', refs: [world.project] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_COUNTER, role: 1, kind: 'TENANT' }]);
    await priceDecision(OLD_DECISION, '2024-01-01', '2026-07-01');
    await priceDecision(NEW_DECISION, '2026-07-01', null);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [LandInventoryController, LandInventoryReadsController],
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

  describe('recordInventory', () => {
    it('AC-ST-LND-004-1, UAT-PLAN-29: counts a DRAFT at the price decision of the day of the survey, audits it and tells the world with ids and amounts only', async () => {
      const aim = await target();
      const done = await record(COUNTER, aim);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const id = done.json.resource_id as string;
      expect(await stored(id)).toMatchObject({ status: 'DRAFT', amount: '360000000', price_decision_ref: OLD_DECISION, confirmed_by: null, household_dispute: false });
      const [audit] = await audits(id, 'lnd.inventory_recorded');
      expect(audit).toMatchObject({
        outcome: 'SUCCESS',
        actor_id: memberId(COUNTER),
        classification: 'PERSONAL',
        safe_diff: { household_id: aim.householdId, parcel_id: aim.parcelId, item_kind: 'HOUSE', quantity: '80', unit_price_vnd: '4500000', amount_vnd: '360000000', price_decision_ref: OLD_DECISION, price_decision_revision: 1, surveyed_on: '2026-06-20', status: 'DRAFT' },
      });
      const [event] = await events(id, 'lnd.inventory.recorded.v1');
      expect(event?.payload).toMatchObject({ inventory_id: id, household_id: aim.householdId, parcel_id: aim.parcelId, item_kind: 'HOUSE', amount_vnd: '360000000', owner_unit_id: unitId(DEPARTMENT), tenant_id: TENANT_A });
      expect(JSON.stringify([audit, event])).not.toContain(DESCRIPTION);
      const idempotency = await rows<{ response_ref: unknown }>("select response_ref from machvon.idempotency_record where operation = 'recordInventory'");
      expect(JSON.stringify(idempotency)).not.toContain(DESCRIPTION);
    });

    it('answers a repeated request with the first answer and counts once', async () => {
      const aim = await target();
      const key = `key-${randomUUID()}`;
      const first = await record(COUNTER, aim, {}, { key });
      const second = await record(COUNTER, aim, {}, { key });
      expect(second.json.resource_id).toBe(first.json.resource_id);
      expect(await rows('select 1 from machvon.land_inventory_record where household_id = $1::uuid', [aim.householdId])).toHaveLength(1);
    });

    it('AC-ST-LND-004-2, UAT-AC382: refuses a price decision that was not in force on the day of the survey (422 PRICE_DECISION_NOT_EFFECTIVE)', async () => {
      const aim = await target();
      for (const [ref, on] of [
        [OLD_DECISION, '2026-07-15'],
        [NEW_DECISION, '2026-06-30'],
        ['QD-GIA-1999', '2026-06-30'],
      ] as const) {
        const refused = await record(COUNTER, aim, { price_decision_ref: ref, surveyed_on: on });
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'PRICE_DECISION_NOT_EFFECTIVE', 'price_decision_ref']);
      }
      expect((await record(COUNTER, aim, { price_decision_ref: NEW_DECISION, surveyed_on: '2026-07-15' })).status).toBe(200);
      expect(await rows('select 1 from machvon.land_inventory_record where household_id = $1::uuid', [aim.householdId])).toHaveLength(1);
    });

    it('wants a parcel the household holds a right on (422 HOUSEHOLD_PARCEL_NOT_LINKED)', async () => {
      const aim = await target();
      const other = await target();
      const refused = await record(COUNTER, { householdId: aim.householdId, parcelId: other.parcelId });
      expect([refused.status, refused.json.code]).toEqual([422, 'HOUSEHOLD_PARCEL_NOT_LINKED']);
    });

    it('wants its fields: 422 VALIDATION_FAILED for a missing one or a value that is not one, 400 for a field it does not know', async () => {
      const aim = await target();
      for (const missing of ['household_id', 'parcel_id', 'item_kind', 'description', 'quantity', 'unit_code', 'unit_price_vnd', 'price_decision_ref', 'surveyed_on']) {
        const refused = await record(COUNTER, aim, { [missing]: undefined });
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', missing]);
      }
      for (const [field, value] of [
        ['quantity', '0'],
        ['quantity', '-2'],
        ['quantity', '1.1234567'],
        ['unit_price_vnd', '4.5'],
        ['description', '   '],
        ['surveyed_on', TOMORROW],
        ['surveyed_on', '2026-02-30'],
        ['item_kind', 'SPACESHIP'],
      ] as const) {
        const refused = await record(COUNTER, aim, { [field]: value });
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      const unknown = await record(COUNTER, aim, { owner_name: 'Nguyen Van A' });
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
    });

    it('is counted inside the unit of the officer: another unit and another tenant do not see the household (404), a grant on a project reaches no household, and who holds no right is turned away (403)', async () => {
      const inside = await target();
      const elsewhere = await target(ELSEWHERE);
      expect((await record(DEPARTMENT_COUNTER, inside)).status).toBe(200);
      const hidden = await record(DEPARTMENT_COUNTER, elsewhere);
      expect([hidden.status, hidden.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await record(PROJECT_COUNTER, inside)).status).toBe(404);
      expect((await record(READER, inside)).status).toBe(403);
      expect((await record(NOBODY, inside)).status).toBe(403);
      expect((await record(B_COUNTER, inside, {}, { tenantId: TENANT_B })).status).toBe(404);
      expect((await record(COUNTER, { householdId: randomUUID(), parcelId: inside.parcelId })).status).toBe(404);
    });
  });

  describe('confirmInventory', () => {
    it('AC-ST-LND-004-1, UAT-PLAN-29: is confirmed by someone other than the person who counted (403 SELF_APPROVAL_DENIED for the counter), and the household and the parcel are inventoried', async () => {
      const aim = await target();
      const id = (await record(COUNTER, aim)).json.resource_id as string;
      const own = await confirm(COUNTER, id, 1);
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await stored(id))?.status).toBe('DRAFT');
      const done = await confirm(CHECKER, id, 1);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'CONFIRMED', resource_version: 2, resource_id: id });
      expect(await stored(id)).toMatchObject({ status: 'CONFIRMED', confirmed_by: memberId(CHECKER), version: '2', price_decision_ref: OLD_DECISION });
      expect(await statusOf('affected_household', aim.householdId)).toBe('INVENTORIED');
      expect(await statusOf('land_parcel', aim.parcelId)).toBe('INVENTORIED');
      const [audit] = await audits(id, 'lnd.inventory_confirmed');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(CHECKER), safe_diff: { outcome: 'CONFIRMED', amount_vnd: '360000000', household_confirmed_on: '2026-07-01', household_status: 'INVENTORIED', household_moved: true, parcel_moved: true } });
      const [event] = await events(id, 'lnd.inventory.confirmed.v1');
      expect(event?.payload).toMatchObject({ inventory_id: id, household_id: aim.householdId, outcome: 'CONFIRMED', amount_vnd: '360000000' });
    });

    it('answers a stale version with 409 VERSION_CONFLICT and a record that was judged with 409 INVENTORY_STATE_INVALID', async () => {
      const aim = await target();
      const id = (await record(COUNTER, aim)).json.resource_id as string;
      expect((await confirm(CHECKER, id, 5)).json.code).toBe('VERSION_CONFLICT');
      expect((await confirm(CHECKER, id, 1)).status).toBe(200);
      expect((await confirm(CHECKER, id, 1)).json.code).toBe('VERSION_CONFLICT');
      const again = await confirm(CHECKER, id, 2);
      expect([again.status, again.json.code]).toEqual([409, 'INVENTORY_STATE_INVALID']);
    });

    it('moves the household to DISPUTED when it objects, with the note, and keeps the note out of the trail and the events', async () => {
      const aim = await target();
      const id = (await record(COUNTER, aim)).json.resource_id as string;
      const noNote = await confirm(CHECKER, id, 1, { outcome: 'DISPUTED' });
      expect([noNote.status, noNote.json.code, noNote.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'note']);
      const done = await confirm(CHECKER, id, 1, { outcome: 'DISPUTED', note: NOTE });
      expect(done.json).toMatchObject({ status: 'DISPUTED', resource_version: 2 });
      expect(await stored(id)).toMatchObject({ status: 'DISPUTED', household_dispute: true, note: NOTE });
      expect(await statusOf('affected_household', aim.householdId)).toBe('DISPUTED');
      expect(await statusOf('land_parcel', aim.parcelId)).toBe('SURVEYED');
      const [audit] = await audits(id, 'lnd.inventory_confirmed');
      expect(audit?.safe_diff).toMatchObject({ outcome: 'DISPUTED', household_status: 'DISPUTED', household_moved: true, parcel_moved: false });
      const [event] = await events(id, 'lnd.inventory.confirmed.v1');
      expect(JSON.stringify([audit, event])).not.toContain(NOTE);
      expect(JSON.stringify(await rows("select response_ref from machvon.idempotency_record where operation = 'confirmInventory'"))).not.toContain(NOTE);
    });

    it('wants the day the household answered to exist, not to be to come and not to be before the survey, and an outcome that is one (422 VALIDATION_FAILED)', async () => {
      const aim = await target();
      const id = (await record(COUNTER, aim)).json.resource_id as string;
      for (const extra of [{ household_confirmed_on: TOMORROW }, { household_confirmed_on: '2026-06-19' }, { household_confirmed_on: '2026-02-30' }, { outcome: 'MAYBE' }]) {
        const refused = await confirm(CHECKER, id, 1, extra);
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      const missing = await call('POST', `/land-inventory-records/${id}/confirm`, { member: CHECKER, ifMatch: '"1"', body: { outcome: 'CONFIRMED' } });
      expect([missing.status, missing.json.code, missing.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'household_confirmed_on']);
      expect((await stored(id))?.status).toBe('DRAFT');
    });

    it('is confirmed inside the unit: another unit, a grant on a project, another tenant and a reader do not confirm a record', async () => {
      const aim = await target();
      const id = (await record(COUNTER, aim)).json.resource_id as string;
      expect((await confirm(PROJECT_COUNTER, id, 1)).status).toBe(404);
      expect((await confirm(READER, id, 1)).status).toBe(403);
      expect((await confirm(NOBODY, id, 1)).status).toBe(403);
      expect((await confirm(B_COUNTER, id, 1, {}, TENANT_B)).status).toBe(404);
      expect((await confirm(CHECKER, randomUUID(), 1)).status).toBe(404);
      const elsewhere = await target(ELSEWHERE);
      const hidden = (await record(COUNTER, elsewhere)).json.resource_id as string;
      expect((await confirm(DEPARTMENT_COUNTER, hidden, 1)).status).toBe(404);
      expect((await confirm(DEPARTMENT_COUNTER, id, 1)).status).toBe(200);
    });
  });

  describe('listInventoryRecords', () => {
    it('shows the records of a household by parcel inside its unit, with the status filter and the cursor', async () => {
      const aim = await target();
      const first = (await record(COUNTER, aim)).json.resource_id as string;
      const second = (await record(COUNTER, aim, { item_kind: 'TREE', description: 'Fruit trees', quantity: '12', unit_code: 'TREE', unit_price_vnd: '300000' })).json.resource_id as string;
      await confirm(CHECKER, first, 1);
      const all = await listOf(READER, aim.householdId);
      expect(all.status).toBe(200);
      const items = all.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id).sort()).toEqual([first, second].sort());
      expect(items.find((item) => item.id === first)).toMatchObject({
        household_id: aim.householdId,
        parcel_id: aim.parcelId,
        item_kind: 'HOUSE',
        description: DESCRIPTION,
        quantity: '80.000000',
        unit_code: 'M2',
        unit_price_vnd: '4500000',
        amount_vnd: '360000000',
        price_decision_ref: OLD_DECISION,
        price_decision_revision: 1,
        status: 'CONFIRMED',
        household_confirmed_on: '2026-07-01',
        surveyed_by: memberId(COUNTER),
        confirmed_by: memberId(CHECKER),
        version: 2,
      });
      expect(typeof all.json.as_of).toBe('string');
      expect(((await listOf(READER, aim.householdId, '&status=DRAFT')).json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([second]);
      const page = await listOf(READER, aim.householdId, '&limit=1');
      expect(page.json.items).toHaveLength(1);
      expect(typeof page.json.next_cursor).toBe('string');
      const next = await listOf(READER, aim.householdId, `&limit=1&cursor=${page.json.next_cursor as string}`);
      expect(next.json.items).toHaveLength(1);
      expect(next.json.next_cursor).toBeNull();
      expect((next.json.items as Array<{ id: string }>)[0]?.id).not.toBe((page.json.items as Array<{ id: string }>)[0]?.id);
    });

    it('shows nothing of a household of another unit, to a grant on a project, to another tenant; turns away who holds no right; and wants a household, a status, a limit and a cursor that are what they should be', async () => {
      const inside = await target();
      const elsewhere = await target(ELSEWHERE);
      await record(COUNTER, inside);
      await record(COUNTER, elsewhere);
      expect((await listOf(DEPARTMENT_COUNTER, inside.householdId)).json.items).toHaveLength(1);
      expect((await listOf(DEPARTMENT_COUNTER, elsewhere.householdId)).json.items).toEqual([]);
      expect((await listOf(PROJECT_COUNTER, inside.householdId)).json.items).toEqual([]);
      expect((await listOf(B_COUNTER, inside.householdId, '', TENANT_B)).json.items).toEqual([]);
      expect((await listOf(NOBODY, inside.householdId)).status).toBe(403);
      for (const query of ['&status=NOPE', '&limit=0', '&cursor=!!!']) {
        const refused = await listOf(READER, inside.householdId, query);
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      for (const url of ['/land-inventory-records', '/land-inventory-records?household_id=nope']) {
        const refused = await get(READER, url);
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'household_id']);
      }
    });
  });

  it('shows a record in the allowlist and nothing else', () => {
    const view = inventoryLineView({
      id: 'a',
      householdId: 'h',
      householdCode: 'HH-000001',
      parcelId: 'p',
      parcelCode: 'LP-1',
      ownerUnitId: 'u',
      itemKind: 'HOUSE',
      description: 'd',
      quantity: '1.000000',
      unitCode: 'M2',
      unitPriceVnd: '1',
      amountVnd: '1',
      priceDecisionRef: 'QD',
      priceDecisionRevision: null,
      surveyedOn: '2026-06-20',
      surveyedBy: 's',
      householdConfirmedOn: null,
      householdDispute: false,
      confirmedBy: null,
      note: null,
      evidencePhotoId: null,
      documentVersionId: null,
      status: 'DRAFT',
      version: 1,
    });
    expect(Object.keys(view).sort()).toEqual(
      [
        'amount_vnd', 'confirmed_by', 'description', 'document_version_id', 'evidence_photo_id', 'household_code', 'household_confirmed_on', 'household_dispute', 'household_id', 'id', 'item_kind', 'note',
        'owner_unit_id', 'parcel_code', 'parcel_id', 'price_decision_ref', 'price_decision_revision', 'quantity', 'status', 'surveyed_by', 'surveyed_on', 'unit_code', 'unit_price_vnd', 'version',
      ].sort(),
    );
  });
});

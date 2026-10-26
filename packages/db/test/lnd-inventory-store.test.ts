import { randomBytes, randomUUID } from 'node:crypto';
import { FieldCipher, staticKeyProvider } from '@machvon/kernel';
import { LndHouseholdStore } from '../src/lnd-household-store';
import { LndInventoryStore } from '../src/lnd-inventory-store';
import type { NewInventory } from '../src/lnd-inventory-store';
import { LndParcelStore } from '../src/lnd-parcel-store';
import { MasterStore } from '../src/master-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';
import { seedLndWorld } from './support/lnd-fixtures';
import type { LndWorld } from './support/lnd-fixtures';

const harness = new AuthzHarness();
const cipher = new FieldCipher(staticKeyProvider(new Map([[1, randomBytes(32)]])));
const households = new LndHouseholdStore(cipher);
const parcels = new LndParcelStore();
const inventory = new LndInventoryStore();
const masters = new MasterStore();
const COUNTER_OFFICER = 1;
const CHECKER = 2;
const FAMILY = 0xb8;
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const TODAY = '2026-10-26';
const SURVEY = '2026-07-15';
const EVERYWHERE = '*';
const OLD_DECISION = 'QD-GIA-2024';
const NEW_DECISION = 'QD-GIA-2026';

let world: LndWorld;
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = COUNTER_OFFICER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
/** The statement as the owner of the tables sees it: the policy of the scope applies to the owner too, so the scope is put first. */
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], units: string | null = EVERYWHERE): Promise<R[]> =>
  harness.owner<R>(
    TENANT_A,
    units === null
      ? [[sql, params]]
      : [
          ["select set_config('app.scope_units', $1, false)", [units]],
          [sql, params],
        ],
  );

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const sqlState = async (work: Promise<unknown>): Promise<{ sqlstate: string; message: string }> => {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { sqlstate: e.code ?? '', message: e.message };
  }
  throw new Error('expected the database to refuse');
};

/** A decision on land prices in force from one day to another (until is the first day it no longer is), made the way the catalogue makes one and then published. */
async function priceDecision(key: string, validFrom: string, validUntil: string | null): Promise<void> {
  const created = await as((tx) =>
    masters.propose(tx, { masterType: 'LND_PRICE_DECISION', businessKey: key, content: { label: key, attributes: { title: `Decision ${key} on land prices` }, parentRecordId: null, validFrom, validUntil, legalBasis: null }, reason: 'Decision on land prices' }, memberId(COUNTER_OFFICER)),
  );
  await owner(
    "update machvon.master_record_version set status = 'EFFECTIVE', published_at = now() where master_record_id = $1::uuid",
    [created.recordId],
    null,
  );
}

interface Setup {
  householdId: string;
  parcelId: string;
}

/** A household of the department with a parcel of the department it holds a right on. */
async function setup(): Promise<Setup> {
  counter += 1;
  const registered = await as((tx) =>
    households.register(
      tx,
      {
        projectId: world.project,
        ownerUnitId: unitId(DEPARTMENT),
        headName: 'Nguyễn Văn A',
        nationalId: String(200000000000 + counter * 13),
        legalBasis: 'PUBLIC_TASK_LAND_LAW',
        legalBasisRef: 'Luật Đất đai 2024, Điều 87',
        retentionUntil: '2036-12-31',
      },
      memberId(COUNTER_OFFICER),
      EVERYWHERE,
      TODAY,
    ),
  );
  const parcel = await as((tx) =>
    parcels.create(
      tx,
      { projectId: world.project, ownerUnitId: unitId(DEPARTMENT), parcelCode: `LP-I-${String(counter).padStart(4, '0')}`, landUseGroup: 'AGRICULTURAL', areaTotalM2: '1000', areaAffectedM2: '500' },
      memberId(COUNTER_OFFICER),
      TODAY,
    ),
  );
  await as((tx) => households.link(tx, registered.id, { parcelId: parcel.id, rightKind: 'OWNER' }, memberId(COUNTER_OFFICER), EVERYWHERE));
  return { householdId: registered.id, parcelId: parcel.id };
}

const countInput = (target: Setup, extra: Partial<NewInventory> = {}): NewInventory => ({
  householdId: target.householdId,
  parcelId: target.parcelId,
  itemKind: 'HOUSE',
  description: 'House of level 4, brick walls, 80 square metres',
  quantity: '80',
  unitCode: 'M2',
  unitPriceVnd: '4500000',
  priceDecisionRef: OLD_DECISION,
  surveyedOn: '2026-06-20',
  ...extra,
});
const count = (target: Setup, extra: Partial<NewInventory> = {}, units = EVERYWHERE, member = COUNTER_OFFICER) => as((tx) => inventory.record(tx, countInput(target, extra), memberId(member), units, TODAY), member);
const confirm = (id: string, outcome: string, version = 1, extra: { on?: string; note?: string } = {}, member = CHECKER, units = EVERYWHERE) =>
  as((tx) => inventory.confirm(tx, id, { outcome, householdConfirmedOn: extra.on ?? '2026-07-01', ...(extra.note === undefined ? {} : { note: extra.note }) }, version, memberId(member), units, TODAY), member);
const row = async (id: string) =>
  (
    await owner<Record<string, unknown>>(
      `select status, amount_vnd::text as amount, quantity::text as quantity, price_decision_ref, price_decision_revision, price_decision_version_id is not null as has_version, surveyed_by, confirmed_by, household_dispute,
              household_confirmed_on::text as answered, note, version::text as version
         from machvon.land_inventory_record where id = $1::uuid`,
      [id],
    )
  )[0];
const statusOf = async (table: 'affected_household' | 'land_parcel', id: string): Promise<string> => (await owner<{ status: string }>(`select status from machvon.${table} where id = $1::uuid`, [id]))[0]?.status ?? '';

describe('the inventory of the assets of the affected households (ST-LND-004)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      for (const member of [COUNTER_OFFICER, CHECKER]) await harness.seedMembership(tenant, member, PROVINCE);
    }
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, COUNTER_OFFICER, DEPARTMENT, PROVINCE);
    await priceDecision(OLD_DECISION, '2024-01-01', '2026-07-01');
    await priceDecision(NEW_DECISION, '2026-07-01', null);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('counting', () => {
    it('AC-ST-LND-004-1, UAT-PLAN-29: records a DRAFT counted at the price decision in force on the day of the survey, with the amount to the dong and the version of the decision', async () => {
      const target = await setup();
      const recorded = await count(target);
      expect(recorded).toMatchObject({
        householdId: target.householdId,
        parcelId: target.parcelId,
        projectId: world.project,
        ownerUnitId: unitId(DEPARTMENT),
        itemKind: 'HOUSE',
        quantity: '80',
        unitCode: 'M2',
        unitPriceVnd: '4500000',
        amountVnd: '360000000',
        priceDecisionRef: OLD_DECISION,
        priceDecisionRevision: 1,
        surveyedOn: '2026-06-20',
        status: 'DRAFT',
        version: 1,
      });
      expect(await row(recorded.id)).toMatchObject({ status: 'DRAFT', amount: '360000000', has_version: true, price_decision_revision: 1, surveyed_by: memberId(COUNTER_OFFICER), confirmed_by: null, answered: null, household_dispute: false });
      expect(await statusOf('affected_household', target.householdId)).toBe('REGISTERED');
    });

    it('rounds the amount half up to the dong and keeps the quantity to six decimals', async () => {
      const target = await setup();
      const recorded = await count(target, { quantity: '1.000005', unitPriceVnd: '100000', itemKind: 'LAND' });
      expect(recorded.amountVnd).toBe('100001');
      expect((await row(recorded.id))?.quantity).toBe('1.000005');
    });

    it('AC-ST-LND-004-1, UAT-AC382: takes the decision that was in force on the day of the survey, not today: the old one up to its last day, the new one from its first', async () => {
      const target = await setup();
      expect(await count(target, { surveyedOn: '2026-06-30', priceDecisionRef: OLD_DECISION })).toMatchObject({ priceDecisionRef: OLD_DECISION, status: 'DRAFT' });
      expect(await count(target, { surveyedOn: '2026-07-01', priceDecisionRef: NEW_DECISION })).toMatchObject({ priceDecisionRef: NEW_DECISION });
      expect(await refusal(count(target, { surveyedOn: SURVEY, priceDecisionRef: OLD_DECISION }))).toMatchObject({ code: 'PRICE_DECISION_NOT_EFFECTIVE', status: 422, detail: 'price_decision_ref' });
      expect(await refusal(count(target, { surveyedOn: '2026-06-30', priceDecisionRef: NEW_DECISION }))).toMatchObject({ code: 'PRICE_DECISION_NOT_EFFECTIVE', status: 422 });
      expect(await refusal(count(target, { priceDecisionRef: 'QD-GIA-1999' }))).toMatchObject({ code: 'PRICE_DECISION_NOT_EFFECTIVE', status: 422 });
    });

    it('wants a parcel the household holds a right on (422 HOUSEHOLD_PARCEL_NOT_LINKED), whatever parcel is named', async () => {
      const target = await setup();
      const other = await setup();
      expect(await refusal(count(target, { parcelId: other.parcelId }))).toMatchObject({ code: 'HOUSEHOLD_PARCEL_NOT_LINKED', status: 422, detail: 'parcel_id' });
      expect(await refusal(count(target, { parcelId: randomUUID() }))).toMatchObject({ code: 'HOUSEHOLD_PARCEL_NOT_LINKED', status: 422 });
    });

    it('does not find a household outside the scope of the officer (404), and records nothing for it', async () => {
      const target = await setup();
      const before = (await owner<{ n: string }>('select count(*)::text as n from machvon.land_inventory_record'))[0]?.n;
      expect(await refusal(count(target, {}, unitId(OTHER_BRANCH)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(count(target, {}, ''))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(count({ ...target, householdId: randomUUID() }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await owner<{ n: string }>('select count(*)::text as n from machvon.land_inventory_record'))[0]?.n).toBe(before);
      expect(await count(target, {}, unitId(DEPARTMENT))).toMatchObject({ status: 'DRAFT' });
    });

    it('wants values that are values: a kind, words, a quantity above zero, a price in whole dong, a survey day that exists and is not to come (422 VALIDATION_FAILED)', async () => {
      const target = await setup();
      const bad = (extra: Partial<NewInventory>, field: string) => expect(refusal(count(target, extra))).resolves.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: field });
      await bad({ itemKind: 'SPACESHIP' }, 'item_kind');
      await bad({ description: '   ' }, 'description');
      await bad({ description: 'x'.repeat(2001) }, 'description');
      await bad({ description: 'a\u0007b' }, 'description');
      await bad({ quantity: '0' }, 'quantity');
      await bad({ quantity: '-3' }, 'quantity');
      await bad({ quantity: '1.1234567' }, 'quantity');
      await bad({ unitCode: '' }, 'unit_code');
      await bad({ unitCode: 'x'.repeat(51) }, 'unit_code');
      await bad({ unitPriceVnd: '-1' }, 'unit_price_vnd');
      await bad({ unitPriceVnd: '4.5' }, 'unit_price_vnd');
      await bad({ priceDecisionRef: '' }, 'price_decision_ref');
      await bad({ priceDecisionRef: 'x'.repeat(101) }, 'price_decision_ref');
      await bad({ surveyedOn: '2026-02-31' }, 'surveyed_on');
      await bad({ surveyedOn: '2026-10-27' }, 'surveyed_on');
      await bad({ evidencePhotoId: 'not-an-id' }, 'evidence_photo_id');
      await bad({ documentVersionId: 'not-an-id' }, 'document_version_id');
      await bad({ evidencePhotoId: randomUUID() }, 'evidence_photo_id');
      expect(await owner('select 1 from machvon.land_inventory_record where household_id = $1::uuid', [target.householdId])).toEqual([]);
    });

    it('keeps the minutes of the count only when the scan found them clean (422 DOCUMENT_NOT_CLEAN)', async () => {
      const target = await setup();
      expect(await refusal(count(target, { documentVersionId: world.pendingDocument }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN', status: 422, detail: 'document_version_id' });
      expect(await refusal(count(target, { documentVersionId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'document_version_id' });
      const recorded = await count(target, { documentVersionId: world.cleanDocument.toUpperCase() });
      expect((await owner<{ document_version_id: string }>('select document_version_id from machvon.land_inventory_record where id = $1::uuid', [recorded.id]))[0]?.document_version_id).toBe(world.cleanDocument);
    });
  });

  describe('the answer of the household', () => {
    it('AC-ST-LND-004-1, UAT-PLAN-29: is confirmed by someone other than the person who counted, who is refused (403 SELF_APPROVAL_DENIED), and the household and the parcel are inventoried', async () => {
      const target = await setup();
      const recorded = await count(target);
      expect(await refusal(confirm(recorded.id, 'CONFIRMED', 1, {}, COUNTER_OFFICER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await row(recorded.id))?.status).toBe('DRAFT');
      const done = await confirm(recorded.id, 'CONFIRMED');
      expect(done).toMatchObject({ outcome: 'CONFIRMED', status: 'CONFIRMED', amountVnd: '360000000', householdConfirmedOn: '2026-07-01', householdStatus: 'INVENTORIED', householdMoved: true, parcelMoved: true, version: 2 });
      expect(await row(recorded.id)).toMatchObject({ status: 'CONFIRMED', confirmed_by: memberId(CHECKER), answered: '2026-07-01', household_dispute: false, version: '2' });
      expect(await statusOf('affected_household', target.householdId)).toBe('INVENTORIED');
      expect(await statusOf('land_parcel', target.parcelId)).toBe('INVENTORIED');
    });

    it('moves the household and the parcel once: a second confirmed record changes neither', async () => {
      const target = await setup();
      const first = await count(target);
      const second = await count(target, { itemKind: 'TREE', description: 'Fruit trees', quantity: '12', unitCode: 'TREE', unitPriceVnd: '300000' });
      await confirm(first.id, 'CONFIRMED');
      expect(await confirm(second.id, 'CONFIRMED')).toMatchObject({ householdMoved: false, parcelMoved: false, householdStatus: 'INVENTORIED' });
    });

    it('AC-ST-LND-004-1: is answered once: a record that was confirmed or objected to is not answered again (409 INVENTORY_STATE_INVALID)', async () => {
      const target = await setup();
      const recorded = await count(target);
      await confirm(recorded.id, 'CONFIRMED');
      expect(await refusal(confirm(recorded.id, 'DISPUTED', 2, { note: 'Changed my mind' }))).toMatchObject({ code: 'INVENTORY_STATE_INVALID', status: 409, extensions: { status: 'CONFIRMED' } });
      const objected = await count(target, { description: 'Another house' });
      await confirm(objected.id, 'DISPUTED', 1, { note: 'The area is wrong' });
      expect(await refusal(confirm(objected.id, 'CONFIRMED', 2))).toMatchObject({ code: 'INVENTORY_STATE_INVALID', status: 409 });
    });

    it('is answered under the version the officer saw (409 VERSION_CONFLICT)', async () => {
      const target = await setup();
      const recorded = await count(target);
      expect(await refusal(confirm(recorded.id, 'CONFIRMED', 7))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect((await row(recorded.id))?.status).toBe('DRAFT');
    });

    it('moves the household to DISPUTED when it objects, with the note that says why, and keeps it there while a record is objected to', async () => {
      const target = await setup();
      const disputed = await count(target);
      const other = await count(target, { itemKind: 'CROP', description: 'Rice', quantity: '500', unitCode: 'M2', unitPriceVnd: '20000' });
      expect(await refusal(confirm(disputed.id, 'DISPUTED'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'note', extensions: { reason: 'REQUIRED_FOR_AN_OBJECTION' } });
      const done = await confirm(disputed.id, 'DISPUTED', 1, { note: 'The house is larger than counted' });
      expect(done).toMatchObject({ outcome: 'DISPUTED', status: 'DISPUTED', householdStatus: 'DISPUTED', householdMoved: true, parcelMoved: false });
      expect(await row(disputed.id)).toMatchObject({ status: 'DISPUTED', household_dispute: true, note: 'The house is larger than counted' });
      expect(await statusOf('land_parcel', target.parcelId)).toBe('SURVEYED');
      // Another record is confirmed: the household stays disputed as long as one record is objected to.
      expect(await confirm(other.id, 'CONFIRMED')).toMatchObject({ householdStatus: 'DISPUTED', householdMoved: false, parcelMoved: true });
      expect(await statusOf('affected_household', target.householdId)).toBe('DISPUTED');
    });

    it('brings a household back from DISPUTED when the record it objected to is replaced and a record is then confirmed', async () => {
      const target = await setup();
      const disputed = await count(target);
      await confirm(disputed.id, 'DISPUTED', 1, { note: 'The house is larger than counted' });
      await owner("update machvon.land_inventory_record set status = 'SUPERSEDED' where id = $1::uuid", [disputed.id]);
      const again = await count(target, { quantity: '95' });
      expect(await confirm(again.id, 'CONFIRMED')).toMatchObject({ householdStatus: 'INVENTORIED', householdMoved: true });
    });

    it('wants the day the household answered to exist, not to be to come and not to be before the survey (422 VALIDATION_FAILED)', async () => {
      const target = await setup();
      const recorded = await count(target);
      for (const [on, reason] of [
        ['2026-10-27', 'IN_THE_FUTURE'],
        ['2026-06-19', 'BEFORE_THE_SURVEY'],
      ] as const) expect(await refusal(confirm(recorded.id, 'CONFIRMED', 1, { on }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'household_confirmed_on', extensions: { reason } });
      expect(await refusal(confirm(recorded.id, 'CONFIRMED', 1, { on: '2026-02-30' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'household_confirmed_on' });
      expect(await refusal(confirm(recorded.id, 'MAYBE'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'outcome' });
      expect(await refusal(confirm(recorded.id, 'CONFIRMED', 1, { note: '   ' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'note' });
      expect((await row(recorded.id))?.status).toBe('DRAFT');
    });

    it('does not find a record outside the scope of the officer (404)', async () => {
      const target = await setup();
      const recorded = await count(target);
      expect(await refusal(confirm(recorded.id, 'CONFIRMED', 1, {}, CHECKER, unitId(OTHER_BRANCH)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(confirm(randomUUID(), 'CONFIRMED'))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await row(recorded.id))?.status).toBe('DRAFT');
    });
  });

  describe('reading', () => {
    it('lists the records of a household by parcel, with the status filter and the cursor, inside the scope', async () => {
      const target = await setup();
      const first = await count(target);
      const second = await count(target, { itemKind: 'TREE', description: 'Trees', quantity: '3', unitCode: 'TREE', unitPriceVnd: '100000' });
      await confirm(first.id, 'CONFIRMED');
      const all = await as((tx) => inventory.list(tx, EVERYWHERE, { householdId: target.householdId, limit: 50 }));
      expect(all.map((line) => line.id).sort()).toEqual([first.id, second.id].sort());
      const line = all.find((entry) => entry.id === first.id);
      expect(line).toMatchObject({
        householdId: target.householdId,
        parcelId: target.parcelId,
        itemKind: 'HOUSE',
        description: 'House of level 4, brick walls, 80 square metres',
        quantity: '80.000000',
        amountVnd: '360000000',
        priceDecisionRef: OLD_DECISION,
        priceDecisionRevision: 1,
        status: 'CONFIRMED',
        householdConfirmedOn: '2026-07-01',
        surveyedBy: memberId(COUNTER_OFFICER),
        confirmedBy: memberId(CHECKER),
        version: 2,
      });
      expect(line?.householdCode).toMatch(/^HH-/);
      expect((await as((tx) => inventory.list(tx, EVERYWHERE, { householdId: target.householdId, status: 'DRAFT', limit: 50 }))).map((entry) => entry.id)).toEqual([second.id]);
      const page = await as((tx) => inventory.list(tx, EVERYWHERE, { householdId: target.householdId, limit: 1 }));
      const next = await as((tx) => inventory.list(tx, EVERYWHERE, { householdId: target.householdId, limit: 5, after: { code: page[0]?.parcelCode ?? '', id: page[0]?.id ?? '' } }));
      expect(page).toHaveLength(1);
      expect(next.map((entry) => entry.id)).not.toContain(page[0]?.id);
      expect(await as((tx) => inventory.list(tx, unitId(OTHER_BRANCH), { householdId: target.householdId, limit: 50 }))).toEqual([]);
      expect(await as((tx) => inventory.list(tx, '', { householdId: target.householdId, limit: 50 }))).toEqual([]);
    });

    it('refuses what is not a household, a status or a limit (422 VALIDATION_FAILED)', async () => {
      expect(await refusal(as((tx) => inventory.list(tx, EVERYWHERE, { householdId: 'nope', limit: 5 })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'household_id' });
      expect(await refusal(as((tx) => inventory.list(tx, EVERYWHERE, { householdId: randomUUID(), status: 'NOPE', limit: 5 })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'status' });
      expect(await refusal(as((tx) => inventory.list(tx, EVERYWHERE, { householdId: randomUUID(), limit: 0 })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'limit' });
    });
  });

  describe('the database', () => {
    it('holds the amount to the quantity times the price, the judge apart from the counter, and a record that is judged to say so', async () => {
      const target = await setup();
      const recorded = await count(target);
      const update = (assignment: string) => sqlState(owner(`update machvon.land_inventory_record set ${assignment} where id = $1::uuid`, [recorded.id]));
      expect((await update('amount_vnd = amount_vnd + 1')).message).toContain('never changes');
      expect((await update('quantity = 81')).message).toContain('never changes');
      expect((await update('price_decision_ref = \'QD-OTHER\'')).message).toContain('never changes');
      expect((await update(`surveyed_by = '${memberId(CHECKER)}'`)).message).toContain('never changes');
      expect((await update("status = 'CONFIRMED'")).message).toContain('land_inventory_confirm_chk');
      expect((await update(`status = 'CONFIRMED', confirmed_by = '${memberId(COUNTER_OFFICER)}', confirmed_at = now(), household_confirmed_on = date '2026-07-01'`)).message).toContain('land_inventory_independent_chk');
      expect((await update(`status = 'DISPUTED', confirmed_by = '${memberId(CHECKER)}', confirmed_at = now(), household_confirmed_on = date '2026-07-01'`)).message).toContain('land_inventory_dispute_chk');
      expect((await update(`status = 'CONFIRMED', confirmed_by = '${memberId(CHECKER)}', confirmed_at = now(), household_confirmed_on = date '2026-06-01'`)).message).toContain('land_inventory_answer_chk');
      expect((await update("status = 'SUPERSEDED', note = ''")).message).toContain('land_inventory_text_chk');
      const rogue = (columns: string, values: string) =>
        sqlState(
          owner(
            `insert into machvon.land_inventory_record (tenant_id, id, household_id, parcel_id, owner_unit_id, item_kind, description, quantity, unit_code, unit_price_vnd, amount_vnd, price_decision_ref, surveyed_on, surveyed_by, created_by, updated_by${columns})
             values ($1, gen_random_uuid(), $2::uuid, $3::uuid, $4::uuid, 'HOUSE', 'A house', 2, 'M2', 1000, ${values}`,
            [TENANT_A, target.householdId, target.parcelId, unitId(DEPARTMENT)],
          ),
        );
      const tail = `, 'QD-X', date '2026-06-20', '${memberId(COUNTER_OFFICER)}', '${memberId(COUNTER_OFFICER)}', '${memberId(COUNTER_OFFICER)}'`;
      expect((await rogue('', `2001${tail})`)).message).toContain('land_inventory_amount_chk');
      expect((await rogue(", status", `2000${tail}, 'CONFIRMED')`)).message).toContain('a record is counted first');
    });

    it('lets a record be replaced from any state and refuses the ways back, and refuses a record for a household that holds no right on the parcel', async () => {
      const target = await setup();
      const draft = await count(target);
      const confirmed = await count(target, { quantity: '81' });
      await confirm(confirmed.id, 'CONFIRMED');
      for (const id of [draft.id, confirmed.id]) {
        await owner("update machvon.land_inventory_record set status = 'SUPERSEDED' where id = $1::uuid", [id]);
        expect((await row(id))?.status).toBe('SUPERSEDED');
        expect((await sqlState(owner("update machvon.land_inventory_record set status = 'DRAFT' where id = $1::uuid", [id]))).message).toContain('this move of the status is not allowed');
      }
      const other = await setup();
      const rogue = sqlState(
        owner(
          `insert into machvon.land_inventory_record (tenant_id, id, household_id, parcel_id, owner_unit_id, item_kind, description, quantity, unit_code, unit_price_vnd, amount_vnd, price_decision_ref, surveyed_on, surveyed_by, created_by, updated_by)
           values ($1, gen_random_uuid(), $2::uuid, $3::uuid, $4::uuid, 'HOUSE', 'A house', 2, 'M2', 1000, 2000, 'QD-X', date '2026-06-20', $5, $5, $5)`,
          [TENANT_A, target.householdId, other.parcelId, unitId(DEPARTMENT), memberId(COUNTER_OFFICER)],
        ),
      );
      expect((await rogue).message).toContain('HOUSEHOLD_PARCEL_NOT_LINKED');
    });

    it('is kept for good and seen from inside the unit only: the runtime role cannot delete, and the policy hides the records of other units', async () => {
      const target = await setup();
      const recorded = await count(target);
      expect((await sqlState(as(async (tx) => {
        await tx.query("select set_config('app.scope_units', '*', true)");
        await tx.query('delete from machvon.land_inventory_record where id = $1::uuid', [recorded.id]);
      }))).message).toContain('permission denied');
      expect(await owner('select 1 from machvon.land_inventory_record where id = $1::uuid', [recorded.id], unitId(OTHER_BRANCH))).toEqual([]);
      expect(await owner('select 1 from machvon.land_inventory_record where id = $1::uuid', [recorded.id], null)).toEqual([]);
      expect(await owner('select 1 from machvon.land_inventory_record where id = $1::uuid', [recorded.id], unitId(DEPARTMENT))).toHaveLength(1);
    });
  });
});

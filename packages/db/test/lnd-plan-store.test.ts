import { randomBytes, randomUUID } from 'node:crypto';
import { FieldCipher, staticKeyProvider } from '@machvon/kernel';
import { LndHouseholdStore } from '../src/lnd-household-store';
import { LndInventoryStore } from '../src/lnd-inventory-store';
import { LndParcelStore } from '../src/lnd-parcel-store';
import { LndPlanStore } from '../src/lnd-plan-store';
import type { NewPlanItem } from '../src/lnd-plan-store';
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
const plans = new LndPlanStore();
const masters = new MasterStore();
const OFFICER = 1;
const CHECKER = 2;
const FAMILY = 0xbb;
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const TODAY = '2026-10-26';
const EVERYWHERE = '*';
const DECISION = 'QD-GIA-2024';
const BASIS = 'Luật Đất đai 2024, Điều 91';
const POLICY = 'Nghị định 88/2024/NĐ-CP, Điều 21';
const allPlans = () => ({ sql: 'true', params: [] as unknown[] });
const noPlans = () => ({ sql: 'false', params: [] as unknown[] });

let world: LndWorld;
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = OFFICER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
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

async function priceDecision(key: string): Promise<void> {
  const created = await as((tx) =>
    masters.propose(tx, { masterType: 'LND_PRICE_DECISION', businessKey: key, content: { label: key, attributes: { title: `Decision ${key}` }, parentRecordId: null, validFrom: '2024-01-01', validUntil: null, legalBasis: null }, reason: 'Decision' }, memberId(OFFICER)),
  );
  await owner("update machvon.master_record_version set status = 'EFFECTIVE', published_at = now() where master_record_id = $1::uuid", [created.recordId], null);
}

interface Target {
  householdId: string;
  parcelId: string;
}
/** A household of the unit asked for, with a parcel of the unit it holds a right on. */
async function target(unit = DEPARTMENT, project = world.project): Promise<Target> {
  counter += 1;
  const registered = await as((tx) =>
    households.register(
      tx,
      { projectId: project, ownerUnitId: unitId(unit), headName: 'Nguyễn Văn A', nationalId: String(400000000000 + counter * 19), legalBasis: 'PUBLIC_TASK_LAND_LAW', legalBasisRef: BASIS, retentionUntil: '2036-12-31' },
      memberId(OFFICER),
      EVERYWHERE,
      TODAY,
    ),
  );
  const parcel = await as((tx) =>
    parcels.create(tx, { projectId: project, ownerUnitId: unitId(unit), parcelCode: `LP-P-${String(counter).padStart(4, '0')}`, landUseGroup: 'AGRICULTURAL', areaTotalM2: '1000', areaAffectedM2: '500' }, memberId(OFFICER), TODAY),
  );
  await as((tx) => households.link(tx, registered.id, { parcelId: parcel.id, rightKind: 'OWNER' }, memberId(OFFICER), EVERYWHERE));
  return { householdId: registered.id, parcelId: parcel.id };
}

/** A record counted by the officer; confirmed by the checker when asked to. */
async function record(aim: Target, options: { confirmed?: boolean; disputed?: boolean; itemKind?: string; quantity?: string; unitPriceVnd?: string } = {}): Promise<string> {
  const counted = await as((tx) =>
    inventory.record(
      tx,
      {
        householdId: aim.householdId,
        parcelId: aim.parcelId,
        itemKind: options.itemKind ?? 'HOUSE',
        description: 'House of level 4',
        quantity: options.quantity ?? '80',
        unitCode: 'M2',
        unitPriceVnd: options.unitPriceVnd ?? '4500000',
        priceDecisionRef: DECISION,
        surveyedOn: '2026-06-20',
      },
      memberId(OFFICER),
      EVERYWHERE,
      TODAY,
    ),
  );
  if (options.confirmed === true || options.disputed === true) {
    await as(
      (tx) =>
        inventory.confirm(
          tx,
          counted.id,
          options.disputed === true ? { outcome: 'DISPUTED', householdConfirmedOn: '2026-07-01', note: 'The area is wrong' } : { outcome: 'CONFIRMED', householdConfirmedOn: '2026-07-01' },
          1,
          memberId(CHECKER),
          EVERYWHERE,
          TODAY,
        ),
      CHECKER,
    );
  }
  return counted.id;
}

const draft = (extra: Record<string, unknown> = {}) =>
  as((tx) => plans.draft(tx, { projectId: world.project, executorUnitId: unitId(DEPARTMENT), executorKind: 'LAND_FUND_CENTRE', planCode: `PA-${String(++counter).padStart(4, '0')}`, ...extra }, memberId(OFFICER)));
const add = (planId: string, items: NewPlanItem[], version = 1, units = EVERYWHERE) => as((tx) => plans.addItems(tx, planId, items, version, memberId(OFFICER), units));
const compensation = (aim: Target, basis: string, extra: Partial<NewPlanItem> = {}): NewPlanItem => ({ householdId: aim.householdId, itemKind: 'COMPENSATION_ASSET', basisInventoryId: basis, legalBasis: BASIS, ...extra });
const support = (aim: Target, amountVnd: string, extra: Partial<NewPlanItem> = {}): NewPlanItem => ({ householdId: aim.householdId, itemKind: 'SUPPORT_LIVELIHOOD', amountVnd, legalBasis: POLICY, ...extra });
const revise = (planId: string, version: number, reason = 'The price of the land changed', units = EVERYWHERE) => as((tx) => plans.revise(tx, planId, reason, version, memberId(OFFICER), units));
const planRow = async (planId: string) =>
  (
    await owner<Record<string, unknown>>(
      'select status, revision, supersedes_id, revision_reason, total_compensation_vnd::text as comp, total_support_vnd::text as support, total_resettlement_vnd::text as resettlement, grand_total_vnd::text as grand, version::text as version from machvon.compensation_plan where id = $1::uuid',
      [planId],
    )
  )[0];
const post = (planId: string) =>
  owner("update machvon.compensation_plan set status = 'POSTING', posting_started_on = date '2026-10-01', posting_ends_on = date '2026-10-31', posting_place_text = 'Commune office', timer_rule_version_id = gen_random_uuid() where id = $1::uuid", [planId]);
const sumOfItems = async (planId: string) =>
  (
    await owner<{ comp: string; support: string; resettlement: string }>(
      `select coalesce(sum(amount_vnd) filter (where item_kind like 'COMPENSATION_%'), 0)::text as comp, coalesce(sum(amount_vnd) filter (where item_kind like 'SUPPORT_%'), 0)::text as support,
              coalesce(sum(amount_vnd) filter (where item_kind like 'RESETTLEMENT_%'), 0)::text as resettlement from machvon.compensation_plan_item where plan_id = $1::uuid`,
      [planId],
    )
  )[0];

describe('the plan of compensation, support and resettlement: composing it from confirmed inventory and revising it (ST-LND-005)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      for (const member of [OFFICER, CHECKER]) await harness.seedMembership(tenant, member, PROVINCE);
    }
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, OFFICER, DEPARTMENT, PROVINCE);
    await priceDecision(DECISION);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('drafting', () => {
    it('drafts an empty plan at its first revision for a project, an executor and a code', async () => {
      const plan = await draft({ planCode: ' PA-DRAFT-1 ' });
      expect(plan).toMatchObject({ projectId: world.project, executorUnitId: unitId(DEPARTMENT), executorKind: 'LAND_FUND_CENTRE', planCode: 'PA-DRAFT-1', revision: 1, status: 'DRAFT', version: 1, sectionId: null });
      expect(await planRow(plan.id)).toMatchObject({ status: 'DRAFT', revision: 1, supersedes_id: null, revision_reason: null, comp: '0', support: '0', resettlement: '0', grand: '0', version: '1' });
    });

    it('refuses a code the project already has (409 PLAN_CODE_DUPLICATE) and keeps the first plan', async () => {
      const plan = await draft({ planCode: 'PA-TWICE' });
      expect(await refusal(draft({ planCode: 'PA-TWICE' }))).toMatchObject({ code: 'PLAN_CODE_DUPLICATE', status: 409 });
      expect(await owner('select 1 from machvon.compensation_plan where plan_code = $1', ['PA-TWICE'])).toHaveLength(1);
      expect(plan.revision).toBe(1);
    });

    it('wants an executor kind, a code that is words, and a section of the project (422 VALIDATION_FAILED)', async () => {
      expect(await refusal(draft({ executorKind: 'NOBODY' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'executor_kind' });
      for (const planCode of ['', '   ', 'x'.repeat(51), 'a\u0007b']) expect(await refusal(draft({ planCode }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'plan_code' });
      expect(await refusal(draft({ sectionId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'section_id' });
    });
  });

  describe('adding items', () => {
    it('AC-ST-LND-005-1, UAT-AC382: counts a compensation from a confirmed record: the amount is its quantity times its price, the price decision is kept, and the totals are the sums of the items', async () => {
      const aim = await target();
      const confirmed = await record(aim, { confirmed: true });
      const plan = await draft();
      const done = await add(plan.id, [compensation(aim, confirmed)]);
      expect(done).toMatchObject({ planId: plan.id, projectId: world.project, status: 'DRAFT', version: 2, totals: { compensation: '360000000', support: '0', resettlement: '0', grand: '360000000' } });
      expect(done.added).toEqual([{ id: expect.any(String), householdId: aim.householdId, itemKind: 'COMPENSATION_ASSET', amountVnd: '360000000', basisInventoryId: confirmed }]);
      const [item] = await owner<Record<string, unknown>>(
        `select parcel_id, owner_unit_id, item_kind, amount_vnd::text as amount, quantity::text as quantity, unit_code, unit_price_vnd::text as price, price_decision_ref, price_decision_version_id is not null as has_version,
                price_decision_revision, legal_basis from machvon.compensation_plan_item where plan_id = $1::uuid`,
        [plan.id],
      );
      expect(item).toEqual({
        parcel_id: aim.parcelId,
        owner_unit_id: unitId(DEPARTMENT),
        item_kind: 'COMPENSATION_ASSET',
        amount: '360000000',
        quantity: '80.000000',
        unit_code: 'M2',
        price: '4500000',
        price_decision_ref: DECISION,
        has_version: true,
        price_decision_revision: 1,
        legal_basis: BASIS,
      });
      expect(await planRow(plan.id)).toMatchObject({ comp: '360000000', grand: '360000000', version: '2' });
    });

    it('AC-ST-LND-005-1, UAT-AC382: refuses a record that is not confirmed (422 INVENTORY_NOT_CONFIRMED), a draft and an objected one alike, and adds none of the items of that call', async () => {
      const aim = await target();
      const confirmed = await record(aim, { confirmed: true });
      const drafted = await record(aim, { quantity: '10' });
      const disputed = await record(aim, { disputed: true, quantity: '20' });
      const plan = await draft();
      expect(await refusal(add(plan.id, [compensation(aim, confirmed), compensation(aim, drafted)]))).toMatchObject({ code: 'INVENTORY_NOT_CONFIRMED', status: 422, detail: 'items[1].basis_inventory_id', extensions: { status: 'DRAFT' } });
      expect(await refusal(add(plan.id, [compensation(aim, disputed)]))).toMatchObject({ code: 'INVENTORY_NOT_CONFIRMED', status: 422, extensions: { status: 'DISPUTED' } });
      expect(await owner('select 1 from machvon.compensation_plan_item where plan_id = $1::uuid', [plan.id])).toEqual([]);
      expect(await planRow(plan.id)).toMatchObject({ comp: '0', version: '1' });
    });

    it('adds a support and a resettlement as the amounts of a policy with their legal basis, and the grand total is the sum of the three', async () => {
      const aim = await target();
      const confirmed = await record(aim, { confirmed: true });
      const plan = await draft();
      const done = await add(plan.id, [
        compensation(aim, confirmed),
        support(aim, '10000000'),
        support(aim, '2500000', { itemKind: 'SUPPORT_TRAINING' }),
        { householdId: aim.householdId, itemKind: 'RESETTLEMENT_HOUSE', amountVnd: '500000000', legalBasis: POLICY, parcelId: aim.parcelId },
      ]);
      expect(done.totals).toEqual({ compensation: '360000000', support: '12500000', resettlement: '500000000', grand: '872500000' });
      expect(await planRow(plan.id)).toMatchObject({ comp: '360000000', support: '12500000', resettlement: '500000000', grand: '872500000' });
      expect(await sumOfItems(plan.id)).toEqual({ comp: '360000000', support: '12500000', resettlement: '500000000' });
      // A second call adds to the totals and not over them.
      const more = await add(plan.id, [support(aim, '1', { itemKind: 'SUPPORT_RELOCATION' })], done.version);
      expect(more).toMatchObject({ version: 3, totals: { support: '12500001', grand: '872500001' } });
      expect(await sumOfItems(plan.id)).toEqual({ comp: '360000000', support: '12500001', resettlement: '500000000' });
    });

    it('compensates land as land, from a record of land, and refuses a kind that does not match the record', async () => {
      const aim = await target();
      const land = await record(aim, { confirmed: true, itemKind: 'LAND', quantity: '500', unitPriceVnd: '200000' });
      const house = await record(aim, { confirmed: true, quantity: '10' });
      const plan = await draft();
      expect(await refusal(add(plan.id, [compensation(aim, land)]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'items[0].item_kind', extensions: { reason: 'DOES_NOT_MATCH_THE_RECORD' } });
      expect(await refusal(add(plan.id, [compensation(aim, house, { itemKind: 'COMPENSATION_LAND' })]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'items[0].item_kind' });
      const done = await add(plan.id, [compensation(aim, land, { itemKind: 'COMPENSATION_LAND' }), compensation(aim, house)]);
      expect(done.totals).toMatchObject({ compensation: '145000000' });
    });

    it('takes the amount, the parcel and the price decision from the record, and refuses an amount or a parcel that disagrees with it', async () => {
      const aim = await target();
      const other = await target();
      const confirmed = await record(aim, { confirmed: true });
      const plan = await draft();
      expect(await refusal(add(plan.id, [compensation(aim, confirmed, { amountVnd: '359999999' })]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'items[0].amount_vnd', extensions: { reason: 'THE_AMOUNT_IS_THE_AMOUNT_OF_THE_RECORD' } });
      expect(await refusal(add(plan.id, [compensation(aim, confirmed, { parcelId: other.parcelId })]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'items[0].parcel_id' });
      expect((await add(plan.id, [compensation(aim, confirmed, { amountVnd: '360000000', parcelId: aim.parcelId.toUpperCase() })])).totals.compensation).toBe('360000000');
    });

    it('uses a record once in a plan, also inside one call (422 VALIDATION_FAILED, ALREADY_IN_THE_PLAN)', async () => {
      const aim = await target();
      const confirmed = await record(aim, { confirmed: true });
      const plan = await draft();
      expect(await refusal(add(plan.id, [compensation(aim, confirmed), compensation(aim, confirmed)]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'items[1].basis_inventory_id', extensions: { reason: 'ALREADY_IN_THE_PLAN' } });
      await add(plan.id, [compensation(aim, confirmed)]);
      expect(await refusal(add(plan.id, [compensation(aim, confirmed)], 2))).toMatchObject({ code: 'VALIDATION_FAILED', extensions: { reason: 'ALREADY_IN_THE_PLAN' } });
      // Another plan may use it: a plan is a proposal, and the record is the household's.
      const another = await draft();
      expect((await add(another.id, [compensation(aim, confirmed)])).totals.compensation).toBe('360000000');
    });

    it('wants a household of the project and of the scope of the officer, a record of that household, and the shape each kind needs', async () => {
      const aim = await target();
      const stranger = await target();
      const confirmed = await record(aim, { confirmed: true });
      const plan = await draft();
      const bad = (item: NewPlanItem, field: string, reason?: string) =>
        expect(refusal(add(plan.id, [item]))).resolves.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: `items[0].${field}`, ...(reason === undefined ? {} : { extensions: { reason } }) });
      await bad(compensation(aim, confirmed, { householdId: stranger.householdId }), 'basis_inventory_id', 'NOT_A_RECORD_OF_THE_HOUSEHOLD');
      await bad(compensation(aim, confirmed, { householdId: randomUUID() }), 'household_id', 'NOT_FOUND');
      await bad(compensation(aim, randomUUID()), 'basis_inventory_id', 'NOT_FOUND');
      await bad(compensation(aim, 'nope'), 'basis_inventory_id');
      await bad({ householdId: aim.householdId, itemKind: 'COMPENSATION_ASSET', legalBasis: BASIS }, 'basis_inventory_id');
      await bad(support(aim, '1', { basisInventoryId: confirmed }), 'basis_inventory_id', 'ONLY_A_COMPENSATION_RESTS_ON_AN_INVENTORY');
      await bad({ householdId: aim.householdId, itemKind: 'SUPPORT_TRAINING', legalBasis: POLICY }, 'amount_vnd');
      await bad(support(aim, '-5'), 'amount_vnd');
      await bad(support(aim, '1.5'), 'amount_vnd');
      await bad(support(aim, '1', { amountVnd: 100 }), 'amount_vnd');
      await bad(compensation(aim, confirmed, { amountVnd: 100 }), 'amount_vnd');
      await bad(compensation(aim, confirmed, { amountVnd: 'x' }), 'amount_vnd');
      await bad(support(aim, '1', { itemKind: 'SUPPORT_NOTHING' }), 'item_kind');
      await bad(support(aim, '1', { householdId: 'nope' }), 'household_id');
      await bad(support(aim, '1', { parcelId: 'nope' }), 'parcel_id');
      await bad(support(aim, '1', { legalBasis: '   ' }), 'legal_basis');
      await bad(support(aim, '1', { legalBasis: 'x'.repeat(501) }), 'legal_basis');
      await bad(support(aim, '1', { legalBasis: 7 }), 'legal_basis');
      expect(await refusal(add(plan.id, [null as unknown as NewPlanItem]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'items[0]' });
      expect(await refusal(add(plan.id, []))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'items' });
      expect(await refusal(add(plan.id, Array.from({ length: 201 }, () => support(aim, '1'))))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'items' });
      expect(await owner('select 1 from machvon.compensation_plan_item where plan_id = $1::uuid', [plan.id])).toEqual([]);
    });

    it('does not take a household of another project or outside the scope of the officer', async () => {
      const aim = await target();
      const elsewhere = await target(OTHER_BRANCH);
      const plan = await draft();
      expect(await refusal(add(plan.id, [support(elsewhere, '1')], 1, unitId(DEPARTMENT)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'items[0].household_id', extensions: { reason: 'NOT_FOUND' } });
      expect(await refusal(add(plan.id, [support(aim, '1')], 1, ''))).toMatchObject({ code: 'VALIDATION_FAILED', extensions: { reason: 'NOT_FOUND' } });
      const otherProject = await target(DEPARTMENT, world.otherProject);
      expect(await refusal(add(plan.id, [support(otherProject, '1')]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'items[0].household_id', extensions: { reason: 'NOT_IN_THE_PROJECT_OF_THE_PLAN' } });
      expect((await add(plan.id, [support(aim, '1')], 1, unitId(DEPARTMENT))).totals.support).toBe('1');
    });

    it('is added under the version the officer saw (409 VERSION_CONFLICT), to a draft only (409 PLAN_STATE_INVALID), to a plan that exists (404)', async () => {
      const aim = await target();
      const plan = await draft();
      expect(await refusal(add(plan.id, [support(aim, '1')], 9))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await add(plan.id, [support(aim, '1')]);
      await post(plan.id);
      expect(await refusal(add(plan.id, [support(aim, '1')], 2))).toMatchObject({ code: 'PLAN_STATE_INVALID', status: 409, extensions: { status: 'POSTING' } });
      expect(await refusal(add(randomUUID(), [support(aim, '1')]))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('revising', () => {
    async function posted(): Promise<{ aim: Target; plan: { id: string }; version: number; confirmed: string }> {
      const aim = await target();
      const confirmed = await record(aim, { confirmed: true });
      const plan = await draft();
      const done = await add(plan.id, [compensation(aim, confirmed), support(aim, '10000000')]);
      await post(plan.id);
      return { aim, plan, version: done.version, confirmed };
    }

    it('AC-ST-LND-005-2, UAT-PLAN-30: replaces a plan that was posted by a new revision with the same items, leaving the earlier one readable and marked as replaced', async () => {
      const { plan, version } = await posted();
      const revised = await revise(plan.id, version, ' The price of the land changed ');
      expect(revised).toMatchObject({ previousId: plan.id, revision: 2, itemsCopied: 2, totals: { compensation: '360000000', support: '10000000', resettlement: '0', grand: '370000000' }, previousVersion: version + 1 });
      expect(revised.id).not.toBe(plan.id);
      expect(await planRow(plan.id)).toMatchObject({ status: 'REVISED', revision: 1, comp: '360000000', support: '10000000', version: String(version + 1) });
      expect(await planRow(revised.id)).toMatchObject({ status: 'DRAFT', revision: 2, supersedes_id: plan.id, revision_reason: 'The price of the land changed', comp: '360000000', support: '10000000', grand: '370000000', version: '1' });
      // The earlier revision keeps its items; the new one has its own copies.
      expect(await sumOfItems(plan.id)).toEqual({ comp: '360000000', support: '10000000', resettlement: '0' });
      expect(await sumOfItems(revised.id)).toEqual({ comp: '360000000', support: '10000000', resettlement: '0' });
      const lines = await as((tx) => plans.list(tx, allPlans, { projectId: world.project, limit: 100 }));
      const code = lines.find((line) => line.id === plan.id)?.planCode;
      expect(lines.filter((line) => line.planCode === code).map((line) => [line.revision, line.status])).toEqual([
        [2, 'DRAFT'],
        [1, 'REVISED'],
      ]);
      expect((await as((tx) => plans.items(tx, plan.id, EVERYWHERE))).length).toBe(2);
      expect((await as((tx) => plans.items(tx, revised.id, EVERYWHERE))).length).toBe(2);
    });

    it('lets the new revision be edited and the one it replaced not, and revises the new one in its turn', async () => {
      const { aim, plan, version } = await posted();
      const revised = await revise(plan.id, version);
      const more = await add(revised.id, [support(aim, '5', { itemKind: 'SUPPORT_TRAINING' })], 1);
      expect(more.totals).toMatchObject({ support: '10000005' });
      expect(await refusal(add(plan.id, [support(aim, '5')], version + 1))).toMatchObject({ code: 'PLAN_STATE_INVALID', status: 409, extensions: { status: 'REVISED' } });
      await post(revised.id);
      const third = await revise(revised.id, 2);
      expect(third).toMatchObject({ revision: 3, itemsCopied: 3 });
      expect(await planRow(third.id)).toMatchObject({ supersedes_id: revised.id });
    });

    it('revises a plan that was posted, closed or approved, and no other (409 PLAN_STATE_INVALID), under the version seen (409 VERSION_CONFLICT)', async () => {
      const aim = await target();
      const plan = await draft();
      const done = await add(plan.id, [support(aim, '1')]);
      expect(await refusal(revise(plan.id, done.version))).toMatchObject({ code: 'PLAN_STATE_INVALID', status: 409, extensions: { status: 'DRAFT' } });
      await post(plan.id);
      expect(await refusal(revise(plan.id, 77))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await owner("update machvon.compensation_plan set status = 'POSTING_CLOSED', feedback_summary = 'No opinions' where id = $1::uuid", [plan.id]);
      await owner("update machvon.compensation_plan set status = 'APPROVED', approved_on = date '2026-11-05', payment_due_on = date '2026-12-05', decision_document_version_id = $2::uuid, approved_by = $3::uuid where id = $1::uuid", [plan.id, world.cleanDocument, memberId(CHECKER)]);
      const revised = await revise(plan.id, done.version);
      expect(revised.revision).toBe(2);
      expect(await refusal(revise(plan.id, done.version + 1))).toMatchObject({ code: 'PLAN_STATE_INVALID', extensions: { status: 'REVISED' } });
      const paying = await draft();
      await add(paying.id, [support(aim, '1')]);
      await post(paying.id);
      await owner("update machvon.compensation_plan set status = 'POSTING_CLOSED', feedback_summary = 'No opinions' where id = $1::uuid", [paying.id]);
      await owner("update machvon.compensation_plan set status = 'APPROVED', approved_on = date '2026-11-05', payment_due_on = date '2026-12-05', decision_document_version_id = $2::uuid, approved_by = $3::uuid where id = $1::uuid", [paying.id, world.cleanDocument, memberId(CHECKER)]);
      await owner("update machvon.compensation_plan set status = 'PAYING' where id = $1::uuid", [paying.id]);
      expect(await refusal(revise(paying.id, 2))).toMatchObject({ code: 'PLAN_STATE_INVALID', extensions: { status: 'PAYING' } });
      expect(await refusal(revise(randomUUID(), 1))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('wants a reason in words (422 VALIDATION_FAILED)', async () => {
      const { plan, version } = await posted();
      for (const reason of ['', '   ', 'x'.repeat(2001), 'a\u0007b']) expect(await refusal(revise(plan.id, version, reason))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect((await planRow(plan.id))?.status).toBe('POSTING');
    });

    it('does not copy a plan whose items the officer does not all see (403 SCOPE_DENIED), nor one that rests on a record that is no longer confirmed (422 INVENTORY_NOT_CONFIRMED)', async () => {
      const here = await target();
      const there = await target(OTHER_BRANCH);
      const plan = await draft();
      const done = await add(plan.id, [support(here, '1'), support(there, '2')]);
      await post(plan.id);
      expect(await refusal(revise(plan.id, done.version, 'Narrow scope', unitId(DEPARTMENT)))).toMatchObject({ code: 'SCOPE_DENIED', status: 403, extensions: { reason: 'ITEMS_OUTSIDE_THE_SCOPE' } });
      expect((await planRow(plan.id))?.status).toBe('POSTING');
      const aim = await target();
      const confirmed = await record(aim, { confirmed: true });
      const second = await draft();
      const added = await add(second.id, [compensation(aim, confirmed)]);
      await post(second.id);
      await owner("update machvon.land_inventory_record set status = 'SUPERSEDED' where id = $1::uuid", [confirmed]);
      expect(await refusal(revise(second.id, added.version))).toMatchObject({ code: 'INVENTORY_NOT_CONFIRMED', status: 422, extensions: { status: 'SUPERSEDED' } });
      expect((await planRow(second.id))?.status).toBe('POSTING');
    });
  });

  describe('reading', () => {
    it('lists the plans of a project by code with the newest revision first, the status filter and the cursor, and the plans of a scope', async () => {
      const first = await draft({ planCode: 'PA-LIST-A' });
      const second = await draft({ planCode: 'PA-LIST-B' });
      await add(second.id, [support(await target(), '1')]);
      await post(second.id);
      const all = await as((tx) => plans.list(tx, allPlans, { projectId: world.project, limit: 100 }));
      expect(all.map((line) => line.id)).toEqual(expect.arrayContaining([first.id, second.id]));
      expect(all.find((line) => line.id === second.id)).toMatchObject({ planCode: 'PA-LIST-B', revision: 1, status: 'POSTING', postingStartedOn: '2026-10-01', postingEndsOn: '2026-10-31', totalCompensationVnd: '0', totalSupportVnd: '1', grandTotalVnd: '1', version: 2, supersedesId: null });
      expect((await as((tx) => plans.list(tx, allPlans, { projectId: world.project, status: 'POSTING', limit: 100 }))).map((line) => line.id)).toContain(second.id);
      expect((await as((tx) => plans.list(tx, allPlans, { projectId: world.project, status: 'POSTING', limit: 100 }))).map((line) => line.id)).not.toContain(first.id);
      const page = await as((tx) => plans.list(tx, allPlans, { projectId: world.project, limit: 1 }));
      const next = await as((tx) => plans.list(tx, allPlans, { projectId: world.project, limit: 100, after: { code: page[0]?.planCode ?? '', id: page[0]?.id ?? '' } }));
      expect(page).toHaveLength(1);
      expect(next.map((line) => line.id)).not.toContain(page[0]?.id);
      expect(await as((tx) => plans.list(tx, noPlans, { projectId: world.project, limit: 100 }))).toEqual([]);
      expect(await as((tx) => plans.list(tx, allPlans, { projectId: world.otherProject, limit: 100 }))).toEqual([]);
    });

    it('refuses what is not a project, a status or a limit (422 VALIDATION_FAILED)', async () => {
      expect(await refusal(as((tx) => plans.list(tx, allPlans, { projectId: 'nope', limit: 5 })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'project_id' });
      expect(await refusal(as((tx) => plans.list(tx, allPlans, { projectId: world.project, status: 'NOPE', limit: 5 })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'status' });
      expect(await refusal(as((tx) => plans.list(tx, allPlans, { projectId: world.project, limit: 0 })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'limit' });
      expect(await refusal(as((tx) => plans.items(tx, 'nope', EVERYWHERE)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'plan_id' });
    });

    it('shows the items of a plan with what they count, and only those of the units of the officer', async () => {
      const here = await target();
      const there = await target(OTHER_BRANCH);
      const confirmed = await record(here, { confirmed: true });
      const plan = await draft();
      await add(plan.id, [compensation(here, confirmed), support(there, '7')]);
      const all = await as((tx) => plans.items(tx, plan.id, EVERYWHERE));
      expect(all).toHaveLength(2);
      const counted = all.find((item) => item.basisInventoryId === confirmed);
      expect(counted).toMatchObject({
        planId: plan.id,
        householdId: here.householdId,
        parcelId: here.parcelId,
        ownerUnitId: unitId(DEPARTMENT),
        itemKind: 'COMPENSATION_ASSET',
        amountVnd: '360000000',
        quantity: '80.000000',
        unitCode: 'M2',
        unitPriceVnd: '4500000',
        priceDecisionRef: DECISION,
        priceDecisionRevision: 1,
        legalBasis: BASIS,
      });
      expect(counted?.householdCode).toMatch(/^HH-/);
      expect(counted?.parcelCode).toMatch(/^LP-P-/);
      expect(all.find((item) => item.itemKind === 'SUPPORT_LIVELIHOOD')).toMatchObject({ amountVnd: '7', parcelId: null, parcelCode: null, basisInventoryId: null, quantity: null, priceDecisionRef: null });
      expect((await as((tx) => plans.items(tx, plan.id, unitId(DEPARTMENT)))).map((item) => item.itemKind)).toEqual(['COMPENSATION_ASSET']);
      expect(await as((tx) => plans.items(tx, plan.id, ''))).toEqual([]);
    });
  });

  describe('the database', () => {
    it('holds the plan: the edges of the status, what the plan is, the totals of a plan that is not a draft, and the revision that supersedes the one before', async () => {
      const aim = await target();
      const plan = await draft();
      await add(plan.id, [support(aim, '10')]);
      const update = (assignment: string, id = plan.id) => sqlState(owner(`update machvon.compensation_plan set ${assignment} where id = $1::uuid`, [id]));
      expect((await update("status = 'APPROVED'")).message).toContain('this move of the status is not allowed');
      expect((await update("status = 'PAYING'")).message).toContain('this move of the status is not allowed');
      expect((await update("plan_code = 'OTHER'")).message).toContain('never changes');
      expect((await update('revision = 5')).message).toContain('never changes');
      expect((await update("executor_kind = 'PROJECT_OWNER'")).message).toContain('never changes');
      await post(plan.id);
      expect((await update('total_support_vnd = 99')).message).toContain('the totals of a plan that is not a draft do not change');
      expect((await update("status = 'DRAFT'")).message).toContain('this move of the status is not allowed');
      await owner("update machvon.compensation_plan set status = 'CANCELLED' where id = $1::uuid", [plan.id]);
      expect((await update("status = 'POSTING'")).message).toContain('this move of the status is not allowed');
      const insert = (columns: string, values: string) =>
        sqlState(
          owner(
            `insert into machvon.compensation_plan (tenant_id, id, project_id, executor_unit_id, executor_kind, plan_code, created_by, updated_by${columns})
             values ($1, gen_random_uuid(), $2::uuid, $3::uuid, 'PROJECT_OWNER', 'PA-ROGUE', $4, $4${values})`,
            [TENANT_A, world.project, unitId(DEPARTMENT), memberId(OFFICER)],
          ),
        );
      expect((await insert(', revision', ', 2')).message).toContain('compensation_plan_revision_chk');
      expect((await insert(', total_support_vnd', ', 5')).message).toContain('a plan is drafted first and empty');
      expect((await insert(', status', ", 'POSTING'")).message).toContain('a plan is drafted first and empty');
      expect((await insert(', revision_reason', ", 'why'")).message).toContain('compensation_plan_revision_chk');
    });

    it('holds the items: what an item counts, a record used once, a draft to write to, the unit and the project of the household, and a record that is confirmed', async () => {
      const aim = await target();
      const other = await target();
      const confirmed = await record(aim, { confirmed: true });
      const drafted = await record(aim, { quantity: '3' });
      const plan = await draft();
      await add(plan.id, [compensation(aim, confirmed)]);
      const rogue = (overrides: Record<string, unknown>) => {
        const item = {
          plan_id: plan.id,
          household_id: aim.householdId,
          parcel_id: aim.parcelId,
          owner_unit_id: unitId(DEPARTMENT),
          item_kind: 'COMPENSATION_ASSET',
          amount_vnd: '360000000',
          basis_inventory_id: confirmed,
          legal_basis: BASIS,
          quantity: '80',
          unit_code: 'M2',
          unit_price_vnd: '4500000',
          price_decision_ref: DECISION,
          ...overrides,
        };
        const keys = Object.keys(item);
        return sqlState(
          owner(
            `insert into machvon.compensation_plan_item (tenant_id, id, created_by, updated_by, ${keys.join(', ')})
             values ($1, gen_random_uuid(), $2, $2, ${keys.map((_, index) => `$${index + 3}`).join(', ')})`,
            [TENANT_A, memberId(OFFICER), ...keys.map((key) => item[key as keyof typeof item] ?? null)],
          ),
        );
      };
      expect((await rogue({})).message).toContain('compensation_plan_item_basis_uq');
      expect((await rogue({ basis_inventory_id: null })).message).toContain('compensation_plan_item_basis_chk');
      expect((await rogue({ item_kind: 'SUPPORT_TRAINING' })).message).toContain('an item counts what its inventory record counts');
      expect((await rogue({ basis_inventory_id: drafted, amount_vnd: '13500000', quantity: '3' })).message).toContain('INVENTORY_NOT_CONFIRMED');
      expect((await rogue({ basis_inventory_id: await record(aim, { confirmed: true }), quantity: '81' })).message).toContain('compensation_plan_item_count_chk');
      expect((await rogue({ household_id: other.householdId })).message).toContain('an item counts what its inventory record counts');
      expect((await rogue({ amount_vnd: '1' })).message).toContain('an item counts what its inventory record counts');
      expect((await rogue({ owner_unit_id: unitId(OTHER_BRANCH), basis_inventory_id: null, item_kind: 'SUPPORT_TRAINING', amount_vnd: '1', quantity: null, unit_code: null, unit_price_vnd: null, price_decision_ref: null })).message).toContain('an item belongs to the unit and the project of its household');
      expect((await rogue({ legal_basis: ' ' })).message).toContain('compensation_plan_item_text_chk');
      await post(plan.id);
      expect((await rogue({ basis_inventory_id: null, item_kind: 'SUPPORT_TRAINING', amount_vnd: '1', quantity: null, unit_code: null, unit_price_vnd: null, price_decision_ref: null })).message).toContain('items are added to a plan that is a draft');
      expect((await sqlState(owner('update machvon.compensation_plan_item set legal_basis = $2 where plan_id = $1::uuid', [plan.id, 'Changed']))).message).toContain('what a plan item is never changes');
    });

    it('is kept for good and seen from inside the units: the runtime role cannot delete, and the policy hides the items of other units', async () => {
      const aim = await target();
      const plan = await draft();
      await add(plan.id, [support(aim, '10')]);
      for (const table of ['compensation_plan_item', 'compensation_plan']) {
        expect(
          (
            await sqlState(
              as(async (tx) => {
                await tx.query("select set_config('app.scope_units', '*', true)");
                await tx.query(`delete from machvon.${table} where ${table === 'compensation_plan' ? 'id' : 'plan_id'} = $1::uuid`, [plan.id]);
              }),
            )
          ).message,
        ).toContain('permission denied');
      }
      expect(await owner('select 1 from machvon.compensation_plan_item where plan_id = $1::uuid', [plan.id], unitId(OTHER_BRANCH))).toEqual([]);
      expect(await owner('select 1 from machvon.compensation_plan_item where plan_id = $1::uuid', [plan.id], null)).toEqual([]);
      expect(await owner('select 1 from machvon.compensation_plan_item where plan_id = $1::uuid', [plan.id], unitId(DEPARTMENT))).toHaveLength(1);
    });
  });
});

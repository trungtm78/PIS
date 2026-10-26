import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { FieldCipher, addCalendarDays, staticKeyProvider, vietnamDateOf } from '@machvon/kernel';
import type { ContractScopes } from '../src/ctr-contract-store';
import { LndHouseholdStore } from '../src/lnd-household-store';
import { LndInventoryStore } from '../src/lnd-inventory-store';
import { LndParcelStore } from '../src/lnd-parcel-store';
import { LndPaymentStore } from '../src/lnd-payment-store';
import type { NewPayment } from '../src/lnd-payment-store';
import { LndPlanPostingStore } from '../src/lnd-plan-posting-store';
import { LndPlanStore } from '../src/lnd-plan-store';
import type { NewPlanItem } from '../src/lnd-plan-store';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { MasterStore } from '../src/master-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';
import { seedLndWorld } from './support/lnd-fixtures';
import type { LndWorld } from './support/lnd-fixtures';

const harness = new AuthzHarness();
const keys = new Map([[1, randomBytes(32)]]);
const cipher = new FieldCipher(staticKeyProvider(keys));
const households = new LndHouseholdStore(cipher);
const parcels = new LndParcelStore();
const inventory = new LndInventoryStore();
const plans = new LndPlanStore();
const posting = new LndPlanPostingStore();
const payments = new LndPaymentStore(cipher);
const masters = new MasterStore();
const OFFICER = 1;
const CHECKER = 2;
const APPROVER = 3;
const FAMILY = 0xbb;
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const TODAY = vietnamDateOf(new Date());
/** The posting ends 30 days after it starts, the plan is approved that day and its payments are due 30 days after: the days the commands are given as their clock. */
const ENDS = addCalendarDays(TODAY, 30);
const DUE = addCalendarDays(ENDS, 30);
const EVERYWHERE = '*';
const NOWHERE = '';
const DECISION = 'QD-GIA-2024';
const BASIS = 'Luật Đất đai 2024, Điều 91';
const POLICY = 'Nghị định 88/2024/NĐ-CP, Điều 21';
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const nothing: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };

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
async function target(unit = DEPARTMENT, project = world.project): Promise<Target> {
  counter += 1;
  const registered = await as((tx) =>
    households.register(
      tx,
      { projectId: project, ownerUnitId: unitId(unit), headName: 'Nguyễn Văn A', nationalId: String(700000000000 + counter * 31), legalBasis: 'PUBLIC_TASK_LAND_LAW', legalBasisRef: BASIS, retentionUntil: '2036-12-31' },
      memberId(OFFICER),
      EVERYWHERE,
      TODAY,
    ),
  );
  const parcel = await as((tx) =>
    parcels.create(tx, { projectId: project, ownerUnitId: unitId(unit), parcelCode: `LP-S-${String(counter).padStart(4, '0')}`, landUseGroup: 'AGRICULTURAL', areaTotalM2: '1000', areaAffectedM2: '500' }, memberId(OFFICER), TODAY),
  );
  await as((tx) => households.link(tx, registered.id, { parcelId: parcel.id, rightKind: 'OWNER' }, memberId(OFFICER), EVERYWHERE));
  return { householdId: registered.id, parcelId: parcel.id };
}

/** A record of the inventory of 360 million, counted by the officer and confirmed by the checker. */
async function confirmed(aim: Target): Promise<string> {
  const counted = await as((tx) =>
    inventory.record(
      tx,
      { householdId: aim.householdId, parcelId: aim.parcelId, itemKind: 'HOUSE', description: 'House of level 4', quantity: '80', unitCode: 'M2', unitPriceVnd: '4500000', priceDecisionRef: DECISION, surveyedOn: '2026-06-20' },
      memberId(OFFICER),
      EVERYWHERE,
      TODAY,
    ),
  );
  await as((tx) => inventory.confirm(tx, counted.id, { outcome: 'CONFIRMED', householdConfirmedOn: '2026-07-01' }, 1, memberId(CHECKER), EVERYWHERE, TODAY), CHECKER);
  return counted.id;
}

const support = (aim: Target, amountVnd: string): NewPlanItem => ({ householdId: aim.householdId, itemKind: 'SUPPORT_LIVELIHOOD', amountVnd, legalBasis: POLICY });

/** An approved plan (the flow of ST-LND-005 and ST-LND-006, with the days of the posting and of the approval as the clock of the commands): its households and what the plan holds for each. */
async function approvedPlan(items: Array<{ aim: Target; amount: string; basis?: string }>): Promise<{ id: string; version: number }> {
  const plan = await as((tx) => plans.draft(tx, { projectId: world.project, executorUnitId: unitId(DEPARTMENT), executorKind: 'LAND_FUND_CENTRE', planCode: `PT-${String(++counter).padStart(4, '0')}` }, memberId(OFFICER)));
  const list: NewPlanItem[] = items.flatMap(({ aim, amount, basis }) =>
    basis === undefined ? [support(aim, amount)] : [{ householdId: aim.householdId, itemKind: 'COMPENSATION_ASSET' as const, basisInventoryId: basis, legalBasis: BASIS }, ...(amount === '0' ? [] : [support(aim, amount)])],
  );
  await as((tx) => plans.addItems(tx, plan.id, list, 1, memberId(OFFICER), EVERYWHERE));
  await as((tx) => posting.post(tx, { planId: plan.id, expectedVersion: 2, postingStartedOn: TODAY, postingPlaceText: 'Commune office' }, memberId(OFFICER), TODAY));
  await as((tx) => posting.closePosting(tx, { planId: plan.id, expectedVersion: 3, feedbackSummary: 'No opinion' }, memberId(OFFICER), ENDS));
  const approved = await as((tx) => posting.approve(tx, { planId: plan.id, expectedVersion: 4, approvedOn: ENDS, decisionDocumentVersionId: world.cleanDocument }, memberId(APPROVER), ENDS), APPROVER);
  return { id: plan.id, version: approved.version };
}

const schedule = (planId: string, version: number, list: NewPayment[], units = EVERYWHERE) => as((tx) => payments.schedule(tx, { planId, expectedVersion: version, payments: list }, memberId(OFFICER), units));
const pay = (aim: Target, amount: string, extra: Partial<NewPayment> = {}): NewPayment => ({ householdId: aim.householdId, amountVnd: amount, ...extra });
const confirm = (
  paymentId: string,
  version: number,
  extra: { paidOn?: string; method?: string; voucherDocumentVersionId?: string; treasuryTransactionId?: string; advanceId?: string; lateReason?: string; units?: string; scopes?: ContractScopes; today?: string } = {},
) =>
  as((tx) =>
    payments.confirm(
      tx,
      {
        paymentId,
        expectedVersion: version,
        paidOn: extra.paidOn ?? DUE,
        method: extra.method ?? 'BANK_TRANSFER',
        voucherDocumentVersionId: extra.voucherDocumentVersionId ?? world.cleanDocument,
        treasuryTransactionId: extra.treasuryTransactionId,
        advanceId: extra.advanceId,
        lateReason: extra.lateReason,
        requestId: randomUUID(),
      },
      memberId(OFFICER),
      extra.units ?? EVERYWHERE,
      extra.today ?? addCalendarDays(DUE, 5),
      extra.scopes ?? everything,
    ),
  );
const deposit = (paymentId: string, version: number, extra: { paidOn?: string; depositReason?: string; voucherDocumentVersionId?: string; units?: string; today?: string } = {}) =>
  as((tx) =>
    payments.deposit(
      tx,
      { paymentId, expectedVersion: version, paidOn: extra.paidOn ?? DUE, depositReason: extra.depositReason ?? 'The household refused to take the money', voucherDocumentVersionId: extra.voucherDocumentVersionId ?? world.cleanDocument },
      memberId(OFFICER),
      extra.units ?? EVERYWHERE,
      extra.today ?? addCalendarDays(DUE, 5),
    ),
  );
const rowOf = async (id: string) =>
  (
    await owner<Record<string, unknown>>(
      `select status, version::text as version, paid_on::text as paid_on, due_on::text as due_on, method, late_reason, deposit_reason, advance_id, bank_account_masked, bank_account_enc is not null as sealed, payment_no
         from machvon.compensation_payment where id = $1::uuid`,
      [id],
    )
  )[0];
const deadlineOf = async (paymentId: string) =>
  (await owner<{ status: string; due_on: string; days_applied: number; satisfied_on: string | null; rule_version_id: string }>("select status, due_on::text as due_on, days_applied, satisfied_on::text as satisfied_on, rule_version_id from machvon.land_deadline where subject_id = $1::uuid and subject_kind = 'PAYMENT'", [paymentId]))[0];
const planOf = async (id: string) => (await owner<{ status: string; version: string }>('select status, version::text as version from machvon.compensation_plan where id = $1::uuid', [id]))[0];
const statusOf = async (table: 'land_parcel' | 'affected_household', id: string): Promise<string> => ((await owner<{ status: string }>(`select status from machvon.${table} where id = $1::uuid`, [id]))[0] as { status: string }).status;
const withoutRule = async (code: string, work: () => Promise<void>): Promise<void> => {
  await owner("update machvon.master_record_version set published_at = null where master_type = 'LND_TIMER' and code = $1", [code]);
  try {
    await work();
  } finally {
    await owner("update machvon.master_record_version set published_at = now() where master_type = 'LND_TIMER' and code = $1", [code]);
  }
};

/** Statements as the administrator of the database, with the foreign keys to the modules that land clearance only reads switched off (as the seed of the world does). */
async function asAdmin(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query("select set_config('app.tenant_id', $1, false)", [TENANT_A]);
    for (const [text, params] of statements) await client.query(text, params);
  } finally {
    await client.end();
  }
}

/** A GPMB advance of the contract of the project that has been paid out (the Treasury story does this): the row in the state the commands of PAY leave it, with the party it was paid to. */
async function advanceOf(amount: string, contract = world.contract): Promise<string> {
  const party = randomUUID();
  const id = randomUUID();
  await asAdmin([
    [
      `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, (select contractor_id from machvon.contract where id = $2::uuid), 'SOLE', 100, 1000, 'ACTIVE', date '2026-01-01', $3::uuid, $3::uuid
       where not exists (select 1 from machvon.contract_party where contract_id = $2::uuid)`,
      [party, contract, memberId(OFFICER)],
    ],
    [
      `insert into machvon.contract_advance
         (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, (select id from machvon.contract_party where contract_id = $2::uuid), (select coalesce(max(tranche_no), 0) + 1 from machvon.contract_advance where contract_id = $2::uuid), 'GPMB', $3::numeric, $3::numeric, 'PAID', $3::numeric, date '2026-07-01', 80, date '2026-12-31', $4::uuid, $4::uuid)`,
      [id, contract, amount, memberId(OFFICER)],
    ],
    ['update machvon.contract set contract_value_vnd = 100000000000, advance_paid_vnd = advance_paid_vnd + $2::numeric where id = $1::uuid', [contract, amount]],
  ]);
  return id;
}
const advanceRow = async (id: string) => (await owner<{ status: string; recovered: string; outstanding: string; version: string }>('select status, recovered_vnd::text as recovered, outstanding_vnd::text as outstanding, version::text as version from machvon.contract_advance where id = $1::uuid', [id]))[0];
const ledgerOf = (advanceId: string) => owner<{ entry_kind: string; amount: string; source: string | null; basis: string | null }>("select entry_kind, amount_vnd::text as amount, source_ref_id as source, basis from machvon.advance_ledger_entry where advance_id = $1::uuid order by posted_at, id", [advanceId]);

describe('the payments of a plan of compensation to its households (ST-LND-007)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      for (const member of [OFFICER, CHECKER, APPROVER]) await harness.seedMembership(tenant, member, PROVINCE);
    }
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, OFFICER, DEPARTMENT, PROVINCE);
    await priceDecision(DECISION);
    await as((tx) => applyBaseline(tx, BASELINE_PACK, memberId(OFFICER)));
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('scheduling', () => {
    it('AC-ST-LND-007-1, UAT-AC378: schedules a payment for each household inside the 30 days of the approval, starts a timer for each, keeps the account sealed and moves the plan to PAYING', async () => {
      const a = await target();
      const b = await target();
      const c = await target();
      const basis = await confirmed(a);
      const plan = await approvedPlan([{ aim: a, amount: '90000000', basis }, { aim: b, amount: '300000000' }, { aim: c, amount: '120000000' }]);
      const done = await schedule(plan.id, plan.version, [pay(a, '450000000', { bankAccount: '0123456789' }), pay(b, '300000000'), pay(c, '120000000', { dueOn: addCalendarDays(ENDS, 10) })]);
      expect(done).toMatchObject({ planId: plan.id, projectId: world.project, version: plan.version + 1, status: 'PAYING', scheduledVnd: '870000000', remainingVnd: '0' });
      expect(done.payments.map((entry) => [entry.householdId, entry.paymentNo, entry.amountVnd, entry.dueOn])).toEqual([
        [a.householdId, 1, '450000000', DUE],
        [b.householdId, 1, '300000000', DUE],
        [c.householdId, 1, '120000000', addCalendarDays(ENDS, 10)],
      ]);
      expect(await planOf(plan.id)).toEqual({ status: 'PAYING', version: String(plan.version + 1) });
      const [first] = done.payments;
      expect(await rowOf(first?.id as string)).toMatchObject({ status: 'PENDING', version: '1', paid_on: null, due_on: DUE, payment_no: 1, bank_account_masked: '******6789', sealed: true });
      expect(await deadlineOf(first?.id as string)).toEqual({ status: 'RUNNING', due_on: DUE, days_applied: 30, satisfied_on: null, rule_version_id: done.ruleVersionId });
      expect(await deadlineOf(done.payments[2]?.id as string)).toMatchObject({ days_applied: 10, due_on: addCalendarDays(ENDS, 10) });
      const [sealed] = await owner<{ enc: Buffer }>('select bank_account_enc as enc from machvon.compensation_payment where id = $1::uuid', [first?.id]);
      expect(sealed?.enc.toString('utf8')).not.toContain('0123456789');
    });

    it('lets a plan that is being paid take another payment of a household for what is still unscheduled, and numbers it', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      const first = await schedule(plan.id, plan.version, [pay(a, '400')]);
      const second = await schedule(plan.id, first.version, [pay(a, '100'), pay(a, '500')]);
      expect(second.payments.map((entry) => entry.paymentNo)).toEqual([2, 3]);
      expect(second).toMatchObject({ scheduledVnd: '1000', remainingVnd: '0' });
      expect(await refusal(schedule(plan.id, second.version, [pay(a, '1')]))).toMatchObject({ code: 'PAYMENT_EXCEEDS_PLAN', status: 422, extensions: { scope: 'HOUSEHOLD', remaining_vnd: '0' } });
    });

    it('UAT-AC378: refuses a payment that takes a household over what the plan holds for it, naming the payment and how much is left', async () => {
      const a = await target();
      const b = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }, { aim: b, amount: '500' }]);
      expect(await refusal(schedule(plan.id, plan.version, [pay(b, '100'), pay(a, '1001')]))).toEqual({ code: 'PAYMENT_EXCEEDS_PLAN', status: 422, detail: 'payments[1].amount_vnd', extensions: { scope: 'HOUSEHOLD', remaining_vnd: '1000' } });
      expect(await refusal(schedule(plan.id, plan.version, [pay(b, '300'), pay(b, '201')]))).toMatchObject({ code: 'PAYMENT_EXCEEDS_PLAN', detail: 'payments[1].amount_vnd', extensions: { remaining_vnd: '200' } });
      expect(await owner('select 1 from machvon.compensation_payment where plan_id = $1::uuid', [plan.id])).toEqual([]);
      expect((await planOf(plan.id))?.status).toBe('APPROVED');
    });

    it('wants an approved plan, the version the caller saw and a list of payments of the right size', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      expect(await refusal(schedule(plan.id, plan.version - 1, [pay(a, '1')]))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      for (const list of [[], Array.from({ length: 201 }, () => pay(a, '1'))]) expect(await refusal(schedule(plan.id, plan.version, list))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'payments' });
      const draft = await as((tx) => plans.draft(tx, { projectId: world.project, executorUnitId: unitId(DEPARTMENT), executorKind: 'LAND_FUND_CENTRE', planCode: `PT-${String(++counter).padStart(4, '0')}` }, memberId(OFFICER)));
      expect(await refusal(schedule(draft.id, 1, [pay(a, '1')]))).toEqual({ code: 'PLAN_STATE_INVALID', status: 409, detail: 'status', extensions: { status: 'DRAFT' } });
      expect(await refusal(schedule(randomUUID(), 1, [pay(a, '1')]))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(schedule('x', 1, [pay(a, '1')]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'plan_id' });
    });

    it('wants each payment to name a household that has an amount in the plan, a whole amount above zero, a day inside the 30 days and an account in the form of one', async () => {
      const a = await target();
      const stranger = await target();
      const elsewhere = await target(DEPARTMENT, world.otherProject);
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      const bad = async (entry: NewPayment, field: string, units = EVERYWHERE) => expect(await refusal(schedule(plan.id, plan.version, [entry], units))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: `payments[0].${field}` });
      await bad({ householdId: 'x', amountVnd: '1' }, 'household_id');
      await bad({ householdId: randomUUID(), amountVnd: '1' }, 'household_id');
      await bad(pay(stranger, '1'), 'household_id');
      await bad(pay(elsewhere, '1'), 'household_id');
      await bad(pay(a, '1'), 'household_id', unitId(OTHER_BRANCH));
      for (const amount of ['0', '-5', '1.5', 'x', '1'.repeat(25)]) await bad(pay(a, amount), 'amount_vnd');
      await bad({ householdId: a.householdId, amountVnd: 5 }, 'amount_vnd');
      for (const dueOn of [ENDS, addCalendarDays(DUE, 1), '2026-02-30']) await bad(pay(a, '1', { dueOn }), 'due_on');
      await bad({ householdId: a.householdId, amountVnd: '1', dueOn: 5 }, 'due_on');
      for (const bankAccount of ['12', 'x'.repeat(41), '12 34!', 5]) await bad({ householdId: a.householdId, amountVnd: '1', bankAccount }, 'bank_account');
      await bad({ householdId: a.householdId, amountVnd: '1', unknownKeys: ['household_id', 'status'] }, 'status');
      expect(await schedule(plan.id, plan.version, [{ householdId: a.householdId, amountVnd: '1', unknownKeys: ['household_id', 'amount_vnd', 'due_on', 'bank_account'] }])).toMatchObject({ status: 'PAYING' });
      expect((await planOf(plan.id))?.status).toBe('PAYING');
    });

    it('does not count a deadline from a number it made up: no rule in force is 422 TIMER_RULE_UNCONFIRMED and nothing is scheduled', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      await withoutRule('PAYMENT_30', async () => {
        expect(await refusal(schedule(plan.id, plan.version, [pay(a, '1')]))).toMatchObject({ code: 'TIMER_RULE_UNCONFIRMED', status: 422 });
      });
      expect(await owner('select 1 from machvon.compensation_payment where plan_id = $1::uuid', [plan.id])).toEqual([]);
    });
  });

  describe('confirming and depositing', () => {
    it('AC-ST-LND-007-1, UAT-AC378: confirms on time, refuses a late payment without a reason, records it with one, deposits what the household does not take, and completes the plan when everything was paid or deposited', async () => {
      const a = await target();
      const b = await target();
      const c = await target();
      const basis = await confirmed(a);
      const plan = await approvedPlan([{ aim: a, amount: '90000000', basis }, { aim: b, amount: '300000000' }, { aim: c, amount: '120000000' }]);
      const scheduled = await schedule(plan.id, plan.version, [pay(a, '450000000'), pay(b, '300000000'), pay(c, '120000000')]);
      const [first, second, third] = scheduled.payments;
      expect(await statusOf('land_parcel', a.parcelId)).toBe('PLAN_APPROVED');
      expect(await statusOf('affected_household', a.householdId)).toBe('PLAN_LISTED');
      // On the day it is due.
      const done = await confirm(first?.id as string, 1, { paidOn: DUE, method: 'TREASURY' });
      expect(done).toMatchObject({ id: first?.id, planId: plan.id, projectId: world.project, amountVnd: '450000000', advanceId: null, paidOn: DUE, dueOn: DUE, lateDays: 0, version: 2, planCompleted: false, householdsMoved: 1, parcelsMoved: 1 });
      expect(await rowOf(first?.id as string)).toMatchObject({ status: 'PAID', paid_on: DUE, method: 'TREASURY', late_reason: null, version: '2' });
      expect(await deadlineOf(first?.id as string)).toMatchObject({ status: 'SATISFIED', satisfied_on: DUE });
      expect(await statusOf('affected_household', a.householdId)).toBe('COMPENSATED');
      expect(await statusOf('land_parcel', a.parcelId)).toBe('PAID');
      expect(await refusal(confirm(first?.id as string, 2))).toEqual({ code: 'PAYMENT_STATE_INVALID', status: 409, detail: 'status', extensions: { status: 'PAID' } });
      // A day after it is due: not without the reason, not with a reason that is not words; with a reason it is recorded as late and its timer is breached.
      const late = addCalendarDays(DUE, 1);
      expect(await refusal(confirm(second?.id as string, 1, { paidOn: late }))).toEqual({ code: 'PAYMENT_LATE_REASON_REQUIRED', status: 422, detail: 'late_reason', extensions: { due_on: DUE } });
      expect(await refusal(confirm(second?.id as string, 1, { paidOn: late, lateReason: '   ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'late_reason' });
      expect((await rowOf(second?.id as string))?.status).toBe('PENDING');
      const lateDone = await confirm(second?.id as string, 1, { paidOn: late, lateReason: 'The treasury was closed on the due day' });
      expect(lateDone).toMatchObject({ lateDays: 1, planCompleted: false });
      expect(await rowOf(second?.id as string)).toMatchObject({ status: 'PAID', late_reason: 'The treasury was closed on the due day' });
      expect(await deadlineOf(second?.id as string)).toMatchObject({ status: 'BREACHED', satisfied_on: null });
      // The money of the third household is deposited: not without a reason, with one it is.
      expect(await refusal(deposit(third?.id as string, 1, { depositReason: '  ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'deposit_reason' });
      const deposited = await deposit(third?.id as string, 1, { paidOn: late });
      expect(deposited).toMatchObject({ id: third?.id, amountVnd: '120000000', lateDays: 1, planCompleted: true });
      expect(await rowOf(third?.id as string)).toMatchObject({ status: 'DEPOSITED', method: 'DEPOSITED', deposit_reason: 'The household refused to take the money', paid_on: late });
      expect((await planOf(plan.id))?.status).toBe('COMPLETED');
    });

    it('keeps a plan that was paid in part as it is, and a payment of another plan out of its completion', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      const [part] = (await schedule(plan.id, plan.version, [pay(a, '600')])).payments;
      await confirm(part?.id as string, 1);
      expect((await planOf(plan.id))?.status).toBe('PAYING');
      expect(await statusOf('affected_household', a.householdId)).not.toBe('COMPENSATED');
    });

    it('wants a payment in the units of the caller, the version they saw, a day that has come and is not before the approval, a method, and a voucher that was scanned clean', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      const [one] = (await schedule(plan.id, plan.version, [pay(a, '1000')])).payments;
      const id = one?.id as string;
      expect(await refusal(confirm(randomUUID(), 1))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(confirm('x', 1))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'id' });
      expect(await refusal(confirm(id, 1, { units: unitId(OTHER_BRANCH) }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(confirm(id, 1, { units: NOWHERE }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(confirm(id, 7))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(confirm(id, 1, { paidOn: addCalendarDays(DUE, 9) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'paid_on' });
      expect(await refusal(confirm(id, 1, { paidOn: addCalendarDays(TODAY, 29) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'paid_on' });
      expect(await refusal(confirm(id, 1, { paidOn: '2026-02-30' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'paid_on' });
      expect(await refusal(confirm(id, 1, { method: 'DEPOSITED' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'method' });
      expect(await refusal(confirm(id, 1, { voucherDocumentVersionId: world.pendingDocument }))).toEqual({ code: 'DOCUMENT_NOT_CLEAN', status: 422, detail: 'voucher_document_version_id' });
      expect(await refusal(confirm(id, 1, { voucherDocumentVersionId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'voucher_document_version_id' });
      expect(await refusal(confirm(id, 1, { voucherDocumentVersionId: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'voucher_document_version_id' });
      expect(await refusal(confirm(id, 1, { treasuryTransactionId: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'treasury_transaction_id' });
      expect(await refusal(confirm(id, 1, { treasuryTransactionId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'treasury_transaction_id' });
      expect(await refusal(confirm(id, 1, { advanceId: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'advance_id' });
      expect(await refusal(confirm(id, 1, { advanceId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'advance_id' });
      expect(await refusal(confirm(id, 1, { lateReason: 'Not late' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'late_reason' });
      expect(await refusal(deposit(id, 1, { paidOn: '2026-02-30' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'paid_on' });
      expect(await refusal(deposit(id, 1, { voucherDocumentVersionId: world.pendingDocument }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN' });
      expect(await refusal(deposit(id, 3))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect((await rowOf(id))?.status).toBe('PENDING');
    });

    it('names a treasury transaction of the project of the plan', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      const [one] = (await schedule(plan.id, plan.version, [pay(a, '1000')])).payments;
      const own = randomUUID();
      const foreign = randomUUID();
      for (const [id, project] of [
        [own, world.project],
        [foreign, world.otherProject],
      ] as const) {
        await asAdmin([
          [`insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, source_kind, provider_event_id) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, 'KBNN', 1000, now(), repeat('a', 64), 'CALLBACK_MOCK', $3)`, [id, project, `TX-${id.slice(0, 8)}`]],
        ]);
      }
      expect(await refusal(confirm(one?.id as string, 1, { method: 'TREASURY', treasuryTransactionId: foreign }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'treasury_transaction_id' });
      await confirm(one?.id as string, 1, { method: 'TREASURY', treasuryTransactionId: own });
      expect((await owner<{ treasury_transaction_id: string }>('select treasury_transaction_id from machvon.compensation_payment where id = $1::uuid', [one?.id]))[0]?.treasury_transaction_id).toBe(own);
    });
  });

  describe('the advance of the land clearance', () => {
    it('AC-ST-LND-007-2, UAT-AC383: recovers the advance by the payments that name it through the command of PAY, and refuses a payment that would recover more than is owed, leaving it unpaid', async () => {
      const a = await target();
      const b = await target();
      const c = await target();
      const plan = await approvedPlan([{ aim: a, amount: '450000000' }, { aim: b, amount: '300000000' }, { aim: c, amount: '580000000' }]);
      const [first, second, third] = (await schedule(plan.id, plan.version, [pay(a, '450000000'), pay(b, '300000000'), pay(c, '580000000')])).payments;
      const advance = await advanceOf('1000000000');
      await confirm(first?.id as string, 1, { advanceId: advance });
      expect(await advanceRow(advance)).toMatchObject({ status: 'RECOVERING', recovered: '450000000', outstanding: '550000000' });
      await confirm(second?.id as string, 1, { advanceId: advance });
      expect(await advanceRow(advance)).toMatchObject({ status: 'RECOVERING', recovered: '750000000', outstanding: '250000000' });
      expect(await ledgerOf(advance)).toEqual([
        { entry_kind: 'RECOVER', amount: '450000000', source: first?.id, basis: 'COMPENSATION_PAYMENT' },
        { entry_kind: 'RECOVER', amount: '300000000', source: second?.id, basis: 'COMPENSATION_PAYMENT' },
      ]);
      expect(await refusal(confirm(third?.id as string, 1, { advanceId: advance }))).toMatchObject({ code: 'ADVANCE_RECOVERY_EXCEEDED', status: 422 });
      expect(await rowOf(third?.id as string)).toMatchObject({ status: 'PENDING', advance_id: null });
      expect(await advanceRow(advance)).toMatchObject({ recovered: '750000000', outstanding: '250000000' });
      expect((await rowOf(first?.id as string))?.advance_id).toBe(advance);
    });

    it('recovers only an advance of a contract of the project, only for someone who reaches that contract, and only through an advance that can be recovered', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '3000' }]);
      const [one, two, three] = (await schedule(plan.id, plan.version, [pay(a, '1000'), pay(a, '1000'), pay(a, '1000')])).payments;
      const foreign = await advanceOf('5000', world.foreignContract);
      expect(await refusal(confirm(one?.id as string, 1, { advanceId: foreign }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'advance_id' });
      const own = await advanceOf('5000');
      expect(await refusal(confirm(two?.id as string, 1, { advanceId: own, scopes: nothing }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      await asAdmin([["update machvon.contract_advance set status = 'PLANNED', paid_vnd = 0, paid_on = null, recovered_vnd = 0 where id = $1::uuid", [own]]]);
      expect(await refusal(confirm(three?.id as string, 1, { advanceId: own }))).toMatchObject({ code: 'ADVANCE_STATE_INVALID', status: 409 });
      for (const id of [one, two, three]) expect((await rowOf(id?.id as string))?.status).toBe('PENDING');
    });
  });

  describe('reading', () => {
    it('lists the payments of a plan inside the units of the caller, by household code, with the account masked and never opened', async () => {
      const a = await target();
      const b = await target(OTHER_BRANCH);
      const plan = await approvedPlan([{ aim: a, amount: '1000' }, { aim: b, amount: '500' }]);
      const [first, second] = (await schedule(plan.id, plan.version, [pay(a, '1000', { bankAccount: '9876543210' }), pay(b, '500')])).payments;
      await confirm(first?.id as string, 1, { method: 'CASH_VOUCHER' });
      const all = await as((tx) => payments.list(tx, plan.id, EVERYWHERE));
      expect(all).toHaveLength(2);
      expect(all.map((line) => [line.id, line.status, line.amountVnd, line.paymentNo])).toEqual(
        expect.arrayContaining([
          [first?.id, 'PAID', '1000', 1],
          [second?.id, 'PENDING', '500', 1],
        ]),
      );
      const mine = all.find((line) => line.id === first?.id);
      expect(mine).toMatchObject({ planId: plan.id, householdId: a.householdId, ownerUnitId: unitId(DEPARTMENT), dueOn: DUE, paidOn: DUE, method: 'CASH_VOUCHER', bankAccountMasked: '******3210', depositReason: null, lateReason: null, version: 2 });
      expect(JSON.stringify(all)).not.toContain('9876543210');
      expect((await as((tx) => payments.list(tx, plan.id, unitId(DEPARTMENT)))).map((line) => line.id)).toEqual([first?.id]);
      expect(await as((tx) => payments.list(tx, plan.id, NOWHERE))).toEqual([]);
      expect((await as((tx) => payments.list(tx, plan.id, EVERYWHERE, 'PENDING'))).map((line) => line.id)).toEqual([second?.id]);
      expect(await refusal(as((tx) => payments.list(tx, plan.id, EVERYWHERE, 'LOST')))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'status' });
      expect(await refusal(as((tx) => payments.list(tx, 'x', EVERYWHERE)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'plan_id' });
    });

    it('tells where a payment lies for whoever reaches its unit and nobody else', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      const [one] = (await schedule(plan.id, plan.version, [pay(a, '1000')])).payments;
      expect(await as((tx) => payments.place(tx, one?.id as string, EVERYWHERE))).toEqual({ planId: plan.id, projectId: world.project });
      expect(await as((tx) => payments.place(tx, one?.id as string, unitId(OTHER_BRANCH)))).toBeUndefined();
      expect(await as((tx) => payments.place(tx, randomUUID(), EVERYWHERE))).toBeUndefined();
      expect(await refusal(as((tx) => payments.place(tx, 'x', EVERYWHERE)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'id' });
    });
  });

  describe('what the database keeps whoever writes', () => {
    it('schedules a payment only on an approved plan, for a household of its unit and project that holds an amount in it, inside its days, and never beyond what the plan holds', async () => {
      const a = await target();
      const stranger = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      const insert = (household: string, amount: string, dueOn: string, planId = plan.id, unit = unitId(DEPARTMENT)) =>
        sqlState(
          owner(
            `insert into machvon.compensation_payment (tenant_id, id, plan_id, household_id, owner_unit_id, payment_no, amount_vnd, due_on, status, created_by, updated_by)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 9, $4::numeric, $5::date, 'PENDING', $6::uuid, $6::uuid)`,
            [planId, household, unit, amount, dueOn, memberId(OFFICER)],
          ),
        );
      expect((await insert(a.householdId, '1', DUE, (await as((tx) => plans.draft(tx, { projectId: world.project, executorUnitId: unitId(DEPARTMENT), executorKind: 'LAND_FUND_CENTRE', planCode: `PT-${String(++counter).padStart(4, '0')}` }, memberId(OFFICER)))).id)).message).toContain(
        'a payment is scheduled on a plan that is approved',
      );
      expect((await insert(a.householdId, '1', DUE, plan.id, unitId(OTHER_BRANCH))).message).toContain('a payment belongs to the unit and the project of its household');
      expect((await insert(stranger.householdId, '1', DUE)).message).toContain('a payment is for a household that has an amount in the plan');
      expect((await insert(a.householdId, '1', ENDS)).message).toContain('a payment is due inside the days that follow the approval of the plan');
      expect((await insert(a.householdId, '1', addCalendarDays(DUE, 1))).message).toContain('a payment is due inside the days that follow the approval of the plan');
      expect((await insert(a.householdId, '1001', DUE)).message).toContain('PAYMENT_EXCEEDS_PLAN');
      expect((await insert(a.householdId, '0', DUE)).sqlstate).toBe('23514');
    });

    it('keeps what a payment is, lets it move from PENDING once, and keeps how it was made', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      const [one, two] = (await schedule(plan.id, plan.version, [pay(a, '500'), pay(a, '500', { bankAccount: '0011223344' })])).payments;
      const update = (id: string, assignment: string) => sqlState(owner(`update machvon.compensation_payment set ${assignment} where id = $1::uuid`, [id]));
      expect((await update(one?.id as string, 'amount_vnd = 400')).message).toContain('what a payment is never changes');
      expect((await update(one?.id as string, `due_on = date '${addCalendarDays(ENDS, 29)}'`)).message).toContain('what a payment is never changes');
      expect((await update(two?.id as string, "bank_account_masked = '******0000'")).message).toContain('what a payment is never changes');
      expect((await update(one?.id as string, "voucher_document_version_id = '" + world.cleanDocument + "'")).message).toContain('how a payment was made is not rewritten');
      expect((await update(one?.id as string, "status = 'PAID'")).sqlstate).toBe('23514');
      expect((await update(one?.id as string, `status = 'PAID', method = 'DEPOSITED', paid_on = date '${DUE}', voucher_document_version_id = '${world.cleanDocument}'`)).message).toContain('compensation_payment_status_chk');
      expect((await update(one?.id as string, `status = 'PAID', method = 'BANK_TRANSFER', paid_on = date '${addCalendarDays(DUE, 1)}', voucher_document_version_id = '${world.cleanDocument}'`)).message).toContain('compensation_payment_status_chk');
      await confirm(one?.id as string, 1);
      expect((await update(one?.id as string, "status = 'CANCELLED'")).message).toContain('a payment that was paid, deposited or cancelled does not move again');
      expect((await sqlState(as((tx) => tx.query('delete from machvon.compensation_payment where id = $1::uuid', [one?.id])))).message).toContain('permission denied');
      await owner("update machvon.compensation_payment set status = 'CANCELLED' where id = $1::uuid", [two?.id]);
      expect((await rowOf(two?.id as string))?.status).toBe('CANCELLED');
    });

    it('moves a plan to PAYING once a payment is scheduled and to COMPLETED once everything was paid or deposited, and only then', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      const move = (status: string) => sqlState(owner('update machvon.compensation_plan set status = $2 where id = $1::uuid', [plan.id, status]));
      expect((await move('PAYING')).message).toContain('a plan is paid once a payment is scheduled');
      const [one] = (await schedule(plan.id, plan.version, [pay(a, '600')])).payments;
      expect((await move('COMPLETED')).message).toContain('a plan is completed when every amount of it was paid or deposited');
      await confirm(one?.id as string, 1);
      expect((await move('COMPLETED')).message).toContain('a plan is completed when every amount of it was paid or deposited');
    });

    it('shows a payment only inside the unit of its household while the totals of the plan do not depend on what the caller sees', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      await schedule(plan.id, plan.version, [pay(a, '600')]);
      expect(await owner('select 1 from machvon.compensation_payment where plan_id = $1::uuid', [plan.id], unitId(DEPARTMENT))).toHaveLength(1);
      expect(await owner('select 1 from machvon.compensation_payment where plan_id = $1::uuid', [plan.id], unitId(OTHER_BRANCH))).toHaveLength(0);
      expect(await owner('select scheduled_vnd::text as scheduled, settled_vnd::text as settled, pending_count from machvon.plan_payment_totals($1::uuid)', [plan.id], NOWHERE)).toEqual([{ scheduled: '600', settled: '0', pending_count: 1 }]);
      expect(await harness.owner(TENANT_B, [['select scheduled_vnd::text as scheduled, pending_count from machvon.plan_payment_totals($1::uuid)', [plan.id]]])).toEqual([{ scheduled: '0', pending_count: 0 }]);
      expect(await harness.owner(TENANT_B, [['select households_moved, parcels_moved from machvon.advance_paid_subjects($1::uuid, $2::uuid)', [plan.id, memberId(OFFICER)]]])).toEqual([{ households_moved: 0, parcels_moved: 0 }]);
    });
  });
});

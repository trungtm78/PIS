import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, LndHouseholdStore, LndParcelStore, LndPlanStore, MasterStore, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { FieldCipher, loadErrorRegistry, signTenantContext, staticKeyProvider, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { CompensationPaymentController, CompensationPaymentReadsController, deadlineView, paymentLineView } from '../../src/modules/lnd/payment.controller';
import { CompensationPlanController, CompensationPlanReadsController } from '../../src/modules/lnd/plan.controller';
import { FIELD_CIPHER } from '../../src/modules/lnd/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedLndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import type { LndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PAYER = 1; // land.payment.write and land.read on the whole tenant
const DEPARTMENT_PAYER = 2; // the same on the unit tree of the department only
const PROJECT_PAYER = 3; // the same on project 1 only: it reaches the plans of the project and no household
const READER = 4; // land.read on the whole tenant
const NOBODY = 5;
const OFFICER = 6; // counts inventory and drafts plans (through the stores)
const CHECKER = 7;
const APPROVER = 8; // the member that approved the plans of the fixtures
const B_PAYER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0xc2;
const FAMILY_B = 0xc3;
const WORKER = WORKER_MEMBERSHIP_ID;
const DECISION = 'QD-GIA-2024';
const BASIS = 'Luật Đất đai 2024, Điều 91';
const POLICY = 'Nghị định 88/2024/NĐ-CP, Điều 21';
const TODAY = vietnamDateOf(new Date());
const daysAgo = (days: number): string => vietnamDateOf(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
/** The posting of the plans of the fixtures ended 40 days ago, they were approved 39 days ago and the payments are due 9 days ago. */
const STARTED = daysAgo(70);
const ENDS = daysAgo(40);
const APPROVED = daysAgo(39);
const DUE = daysAgo(9);
const ON_TIME = daysAgo(10);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the payments of a plan of compensation to its households (ST-LND-007)', () => {
  const harness = new AuthzHarness();
  const cipher = new FieldCipher(staticKeyProvider(new Map([[1, randomBytes(32)]])));
  const households = new LndHouseholdStore(cipher);
  const parcels = new LndParcelStore();
  const plans = new LndPlanStore();
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

  async function priceDecision(key: string): Promise<void> {
    const tenants = harness.tenants as TenantDatabase;
    const created = await tenants.withTenant(context(OFFICER), (tx) =>
      masters.propose(tx, { masterType: 'LND_PRICE_DECISION', businessKey: key, content: { label: key, attributes: { title: `Decision ${key}` }, parentRecordId: null, validFrom: '2024-01-01', validUntil: null, legalBasis: null }, reason: 'Decision' }, memberId(OFFICER)),
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
    const registered = await tenants.withTenant(context(OFFICER), (tx) =>
      households.register(tx, { projectId: world.project, ownerUnitId: unitId(unit), headName: 'Nguyễn Văn A', nationalId: String(800000000000 + counter * 37), legalBasis: 'PUBLIC_TASK_LAND_LAW', legalBasisRef: BASIS, retentionUntil: '2036-12-31' }, memberId(OFFICER), '*', TODAY),
    );
    const parcel = await tenants.withTenant(context(OFFICER), (tx) =>
      parcels.create(tx, { projectId: world.project, ownerUnitId: unitId(unit), parcelCode: `LP-T-${String(counter).padStart(4, '0')}`, landUseGroup: 'AGRICULTURAL', areaTotalM2: '1000', areaAffectedM2: '500' }, memberId(OFFICER), TODAY),
    );
    await tenants.withTenant(context(OFFICER), (tx) => households.link(tx, registered.id, { parcelId: parcel.id, rightKind: 'OWNER' }, memberId(OFFICER), '*'));
    return { householdId: registered.id, parcelId: parcel.id };
  }

  /**
   * An approved plan with the amounts the households are to be paid: the plan is drafted and filled by the stores and then put where the commands leave it after its posting closed and it was approved
   * (the commands cannot be given a clock, so the days are put 70 to 9 days back), at version 2.
   */
  async function approvedPlan(items: Array<{ aim: Target; amount: string }>, dueOn = DUE): Promise<{ id: string }> {
    const tenants = harness.tenants as TenantDatabase;
    const plan = await tenants.withTenant(context(OFFICER), (tx) => plans.draft(tx, { projectId: world.project, executorUnitId: unitId(DEPARTMENT), executorKind: 'LAND_FUND_CENTRE', planCode: `PY-${String(++counter).padStart(4, '0')}` }, memberId(OFFICER)));
    await tenants.withTenant(context(OFFICER), (tx) =>
      plans.addItems(tx, plan.id, items.map(({ aim, amount }) => ({ householdId: aim.householdId, itemKind: 'SUPPORT_LIVELIHOOD', amountVnd: amount, legalBasis: POLICY })), 1, memberId(OFFICER), '*'),
    );
    await rows(
      "update machvon.compensation_plan set status = 'POSTING', posting_started_on = $2::date, posting_ends_on = $3::date, posting_place_text = 'Commune office', timer_rule_version_id = gen_random_uuid() where id = $1::uuid",
      [plan.id, STARTED, ENDS],
    );
    await rows("update machvon.compensation_plan set status = 'POSTING_CLOSED', feedback_summary = 'No opinions' where id = $1::uuid", [plan.id]);
    await rows(
      "update machvon.compensation_plan set status = 'APPROVED', approved_on = $2::date, approved_by = $3::uuid, payment_due_on = $4::date, decision_document_version_id = $5::uuid where id = $1::uuid",
      [plan.id, APPROVED, memberId(APPROVER), dueOn, world.cleanDocument],
    );
    return { id: plan.id };
  }

  const schedule = (member: number, planId: string, version: number | string, payments: Array<Record<string, unknown>>, options: { tenantId?: string; key?: string } = {}): Promise<Reply> =>
    call('POST', `/compensation-plans/${planId}/payments`, { member, ifMatch: `"${version}"`, ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }), ...(options.key === undefined ? {} : { key: options.key }), body: { payments } });
  const confirm = (member: number, paymentId: string, version: number | string, body: Record<string, unknown> = {}, options: { tenantId?: string; key?: string } = {}): Promise<Reply> =>
    call('POST', `/compensation-payments/${paymentId}/confirm`, {
      member,
      ifMatch: `"${version}"`,
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      ...(options.key === undefined ? {} : { key: options.key }),
      body: { paid_on: ON_TIME, method: 'BANK_TRANSFER', voucher_document_version_id: world.cleanDocument, ...body },
    });
  const deposit = (member: number, paymentId: string, version: number | string, body: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/compensation-payments/${paymentId}/deposit`, { member, ifMatch: `"${version}"`, body: { deposit_reason: 'The household refused to take the money', voucher_document_version_id: world.cleanDocument, paid_on: ON_TIME, ...body } });
  const entry = (aim: Target, amount: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ household_id: aim.householdId, amount_vnd: amount, ...extra });

  const audits = (resourceId: string, action: string) =>
    rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string; classification: string }>(
      'select safe_diff, outcome, actor_id, classification from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at',
      [resourceId, action],
    );
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);
  const paymentRow = async (id: string) =>
    (await rows<Record<string, unknown>>('select status, version::text as version, paid_on::text as paid_on, due_on::text as due_on, method, late_reason, advance_id, bank_account_masked from machvon.compensation_payment where id = $1::uuid', [id]))[0];
  const planRow = async (id: string) => (await rows<{ status: string; version: string }>('select status, version::text as version from machvon.compensation_plan where id = $1::uuid', [id]))[0];

  async function advanceOf(amount: string, contract = world.contract): Promise<{ id: string; version: number }> {
    const id = randomUUID();
    await asAdmin([
      [
        `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
         select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, (select contractor_id from machvon.contract where id = $1::uuid), 'SOLE', 100, 1000, 'ACTIVE', date '2026-01-01', $2::uuid, $2::uuid
          where not exists (select 1 from machvon.contract_party where contract_id = $1::uuid)`,
        [contract, memberId(OFFICER)],
      ],
      [
        `insert into machvon.contract_advance
           (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, (select id from machvon.contract_party where contract_id = $2::uuid), (select coalesce(max(tranche_no), 0) + 1 from machvon.contract_advance where contract_id = $2::uuid),
                 'GPMB', $3::numeric, $3::numeric, 'PAID', $3::numeric, date '2026-07-01', 80, date '2026-12-31', $4::uuid, $4::uuid)`,
        [id, contract, amount, memberId(OFFICER)],
      ],
      ['update machvon.contract set contract_value_vnd = 100000000000, advance_paid_vnd = advance_paid_vnd + $2::numeric where id = $1::uuid', [contract, amount]],
    ]);
    return { id, version: 1 };
  }
  const advanceRow = async (id: string) => (await rows<{ status: string; recovered: string; outstanding: string }>('select status, recovered_vnd::text as recovered, outstanding_vnd::text as outstanding from machvon.contract_advance where id = $1::uuid', [id]))[0];

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
    for (const n of [PAYER, DEPARTMENT_PAYER, PROJECT_PAYER, READER, NOBODY, OFFICER, CHECKER, APPROVER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_PAYER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PAYER', ['land.payment.write', 'land.read', 'advance.recover'], 30);
    await harness.seedRole(TENANT_A, 2, 'LAND_READER', ['land.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'PAYER', ['land.payment.write', 'land.read'], 30);
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, OFFICER, DEPARTMENT, ROOT);
    await seedLndWorld(harness.database.adminUrl, TENANT_B, FAMILY_B, B_PAYER, DEPARTMENT, ROOT);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PAYER, role: 1, kind: 'TENANT' },
      { n: 2, member: DEPARTMENT_PAYER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: PROJECT_PAYER, role: 1, kind: 'PROJECT', refs: [world.project] },
      { n: 4, member: READER, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_PAYER, role: 1, kind: 'TENANT' }]);
    await priceDecision(DECISION);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [CompensationPlanController, CompensationPlanReadsController, CompensationPaymentController, CompensationPaymentReadsController],
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

  describe('scheduleCompensationPayments', () => {
    it('AC-ST-LND-007-1, UAT-AC378: schedules a payment for each household inside the 30 days of the approval, audits it and tells the world with the id, the plan and the amount and nothing of the household or the account', async () => {
      const a = await target();
      const b = await target();
      const plan = await approvedPlan([{ aim: a, amount: '450000000' }, { aim: b, amount: '300000000' }]);
      const done = await schedule(PAYER, plan.id, 2, [entry(a, '450000000', { bank_account: '0123456789' }), entry(b, '300000000')]);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'PAYING', resource_version: 3, resource_id: plan.id });
      expect(await planRow(plan.id)).toEqual({ status: 'PAYING', version: '3' });
      const stored = await rows<{ id: string; amount: string; due_on: string; masked: string | null }>('select id, amount_vnd::text as amount, due_on::text as due_on, bank_account_masked as masked from machvon.compensation_payment where plan_id = $1::uuid order by amount_vnd desc', [plan.id]);
      expect(stored.map((row) => [row.amount, row.due_on, row.masked])).toEqual([
        ['450000000', DUE, '******6789'],
        ['300000000', DUE, null],
      ]);
      const [audit] = await audits(plan.id, 'lnd.payments_scheduled');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(PAYER), classification: 'PERSONAL', safe_diff: { project_id: world.project, payment_count: 2, scheduled_vnd: '750000000', remaining_vnd: '0' } });
      const first = stored[0] as { id: string };
      const [event] = await events(first.id, 'lnd.payment.scheduled.v1');
      expect(event?.payload).toMatchObject({ payment_id: first.id, plan_id: plan.id, project_id: world.project, amount_vnd: '450000000', due_on: DUE, tenant_id: TENANT_A });
      expect(JSON.stringify([audit, event])).not.toContain(a.householdId);
      expect(JSON.stringify([audit, event])).not.toContain('0123456789');
      const [deadline] = await rows<{ timer_code: string; status: string; due_on: string }>("select timer_code, status, due_on::text as due_on from machvon.land_deadline where subject_id = $1::uuid", [first.id]);
      expect(deadline).toEqual({ timer_code: 'PAYMENT_30', status: 'RUNNING', due_on: DUE });
    });

    it('AC-ST-LND-007-3, UAT-AC397: answers a repeated request with the first answer and schedules once', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      const key = `key-${randomUUID()}`;
      const first = await schedule(PAYER, plan.id, 2, [entry(a, '1000')], { key });
      const second = await schedule(PAYER, plan.id, 2, [entry(a, '1000')], { key });
      expect(second.json).toEqual(first.json);
      expect(await rows('select 1 from machvon.compensation_payment where plan_id = $1::uuid', [plan.id])).toHaveLength(1);
      expect(await audits(plan.id, 'lnd.payments_scheduled')).toHaveLength(1);
    });

    it('wants its payments: 422 VALIDATION_FAILED naming the payment and the field, PAYMENT_EXCEEDS_PLAN above what a household holds, 409 for a stale version or a plan that is not approved', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      const none = await schedule(PAYER, plan.id, 2, []);
      expect([none.status, none.json.code, none.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'payments']);
      const missing = await call('POST', `/compensation-plans/${plan.id}/payments`, { member: PAYER, ifMatch: '"2"', body: {} });
      expect([missing.status, missing.json.code, missing.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'payments']);
      for (const [extra, field] of [
        [{ amount_vnd: '0' }, 'amount_vnd'],
        [{ amount_vnd: '1.5' }, 'amount_vnd'],
        [{ due_on: APPROVED }, 'due_on'],
        [{ bank_account: 'x' }, 'bank_account'],
        [{ status: 'PAID' }, 'status'],
      ] as const) {
        const refused = await schedule(PAYER, plan.id, 2, [entry(a, '1', extra as Record<string, unknown>)]);
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', `payments[0].${field}`]);
      }
      const unknownHousehold = await schedule(PAYER, plan.id, 2, [{ household_id: randomUUID(), amount_vnd: '1' }]);
      expect([unknownHousehold.status, unknownHousehold.json.detail]).toEqual([422, 'payments[0].household_id']);
      const over = await schedule(PAYER, plan.id, 2, [entry(a, '1001')]);
      expect([over.status, over.json.code, over.json.detail]).toEqual([422, 'PAYMENT_EXCEEDS_PLAN', 'payments[0].amount_vnd']);
      const stale = await schedule(PAYER, plan.id, 9, [entry(a, '1')]);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const draft = await (harness.tenants as TenantDatabase).withTenant(context(OFFICER), (tx) => plans.draft(tx, { projectId: world.project, executorUnitId: unitId(DEPARTMENT), executorKind: 'LAND_FUND_CENTRE', planCode: `PY-${String(++counter).padStart(4, '0')}` }, memberId(OFFICER)));
      const notApproved = await schedule(PAYER, draft.id, 1, [entry(a, '1')]);
      expect([notApproved.status, notApproved.json.code]).toEqual([409, 'PLAN_STATE_INVALID']);
      expect(await rows('select 1 from machvon.compensation_payment where plan_id = $1::uuid', [plan.id])).toEqual([]);
    });

    it('is scheduled by someone who reaches the project and the unit of the household: a department sees its own, a grant on a project reaches no household, a reader and nobody are turned away, another tenant does not find the plan', async () => {
      const inside = await target();
      const elsewhere = await target(ELSEWHERE);
      const plan = await approvedPlan([{ aim: inside, amount: '100' }, { aim: elsewhere, amount: '100' }]);
      expect((await schedule(DEPARTMENT_PAYER, plan.id, 2, [entry(inside, '10')])).status).toBe(200);
      const hidden = await schedule(DEPARTMENT_PAYER, plan.id, 3, [entry(elsewhere, '10')]);
      expect([hidden.status, hidden.json.detail]).toEqual([422, 'payments[0].household_id']);
      const byProject = await schedule(PROJECT_PAYER, plan.id, 3, [entry(inside, '10')]);
      expect([byProject.status, byProject.json.detail]).toEqual([422, 'payments[0].household_id']);
      expect((await schedule(READER, plan.id, 3, [entry(inside, '10')])).status).toBe(403);
      expect((await schedule(NOBODY, plan.id, 3, [entry(inside, '10')])).status).toBe(403);
      expect((await schedule(B_PAYER, plan.id, 3, [entry(inside, '10')], { tenantId: TENANT_B })).status).toBe(404);
      expect((await schedule(PAYER, randomUUID(), 1, [entry(inside, '10')])).status).toBe(404);
    });
  });

  describe('confirmCompensationPayment and depositCompensationPayment', () => {
    it('AC-ST-LND-007-1, UAT-AC378: confirms on time, refuses a late payment without a reason and records it with one, deposits what the household does not take, and says so with ids, amounts and dates only', async () => {
      const a = await target();
      const b = await target();
      const c = await target();
      const plan = await approvedPlan([{ aim: a, amount: '450000000' }, { aim: b, amount: '300000000' }, { aim: c, amount: '120000000' }]);
      await schedule(PAYER, plan.id, 2, [entry(a, '450000000'), entry(b, '300000000'), entry(c, '120000000')]);
      const [pa, pb, pc] = await rows<{ id: string }>('select p.id from machvon.compensation_payment p where p.plan_id = $1::uuid order by p.amount_vnd desc', [plan.id]);
      const onTime = await confirm(PAYER, (pa as { id: string }).id, 1);
      expect(onTime.status).toBe(200);
      expect(onTime.json).toMatchObject({ status: 'PAID', resource_version: 2 });
      expect(await paymentRow((pa as { id: string }).id)).toMatchObject({ status: 'PAID', paid_on: ON_TIME, method: 'BANK_TRANSFER', late_reason: null });
      const [audit] = await audits((pa as { id: string }).id, 'lnd.payment_confirmed');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(PAYER), classification: 'PERSONAL', safe_diff: { plan_id: plan.id, project_id: world.project, amount_vnd: '450000000', paid_on: ON_TIME, due_on: DUE, late_days: 0, plan_completed: false, method: 'BANK_TRANSFER' } });
      const [event] = await events((pa as { id: string }).id, 'lnd.payment.paid.v1');
      expect(event?.payload).toMatchObject({ payment_id: (pa as { id: string }).id, plan_id: plan.id, amount_vnd: '450000000', status: 'PAID', paid_on: ON_TIME, late_days: 0, version: 2 });
      expect(JSON.stringify([audit, event])).not.toContain(a.householdId);
      // After the due day.
      const late = await confirm(PAYER, (pb as { id: string }).id, 1, { paid_on: TODAY });
      expect([late.status, late.json.code, late.json.detail]).toEqual([422, 'PAYMENT_LATE_REASON_REQUIRED', 'late_reason']);
      expect((await paymentRow((pb as { id: string }).id))?.status).toBe('PENDING');
      expect(await audits((pb as { id: string }).id, 'lnd.payment_confirmed')).toHaveLength(0);
      const reasoned = await confirm(PAYER, (pb as { id: string }).id, 1, { paid_on: TODAY, late_reason: 'The treasury was closed on the due day' });
      expect(reasoned.status).toBe(200);
      expect(await paymentRow((pb as { id: string }).id)).toMatchObject({ status: 'PAID', late_reason: 'The treasury was closed on the due day' });
      expect((await rows<{ status: string }>("select status from machvon.land_deadline where subject_id = $1::uuid", [(pb as { id: string }).id]))[0]?.status).toBe('BREACHED');
      // The money of the third household is deposited.
      const nothing = await deposit(PAYER, (pc as { id: string }).id, 1, { deposit_reason: undefined });
      expect([nothing.status, nothing.json.code, nothing.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'deposit_reason']);
      const deposited = await deposit(PAYER, (pc as { id: string }).id, 1);
      expect(deposited.json).toMatchObject({ status: 'DEPOSITED', resource_version: 2 });
      expect(await paymentRow((pc as { id: string }).id)).toMatchObject({ status: 'DEPOSITED', method: 'DEPOSITED', paid_on: ON_TIME });
      const [depositAudit] = await audits((pc as { id: string }).id, 'lnd.payment_deposited');
      expect(depositAudit).toMatchObject({ safe_diff: { plan_id: plan.id, amount_vnd: '120000000', plan_completed: true } });
      expect((await events((pc as { id: string }).id, 'lnd.payment.deposited.v1'))[0]?.payload).toMatchObject({ status: 'DEPOSITED', plan_completed: true });
      expect((await planRow(plan.id))?.status).toBe('COMPLETED');
      expect(JSON.stringify(depositAudit)).not.toContain('refused to take');
    });

    it('AC-ST-LND-007-3, AC-ST-CTR-013-2, UAT-AC397: answers a repeated confirmation with the first answer, refuses the same key with another body, and a new key meets the state: one payment, one audit row and one event', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      await schedule(PAYER, plan.id, 2, [entry(a, '1000')]);
      const id = ((await rows<{ id: string }>('select id from machvon.compensation_payment where plan_id = $1::uuid', [plan.id]))[0] as { id: string }).id;
      const key = `key-${randomUUID()}`;
      const first = await confirm(PAYER, id, 1, {}, { key });
      const second = await confirm(PAYER, id, 1, {}, { key });
      expect(second.json).toEqual(first.json);
      const changed = await confirm(PAYER, id, 1, { method: 'TREASURY' }, { key });
      expect([changed.status, changed.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      expect(await audits(id, 'lnd.payment_confirmed')).toHaveLength(1);
      expect(await events(id, 'lnd.payment.paid.v1')).toHaveLength(1);
      const again = await confirm(PAYER, id, 2);
      expect([again.status, again.json.code]).toEqual([409, 'PAYMENT_STATE_INVALID']);
    });

    it('wants its fields and the units of the payment: 422 for what is missing or wrong, 409 for a stale version, 404 for a payment of another unit, another tenant or nobody', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }]);
      await schedule(PAYER, plan.id, 2, [entry(a, '1000')]);
      const id = ((await rows<{ id: string }>('select id from machvon.compensation_payment where plan_id = $1::uuid', [plan.id]))[0] as { id: string }).id;
      for (const field of ['paid_on', 'method', 'voucher_document_version_id']) {
        const refused = await confirm(PAYER, id, 1, { [field]: undefined });
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', field]);
      }
      const method = await confirm(PAYER, id, 1, { method: 'DEPOSITED' });
      expect([method.status, method.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const unclean = await confirm(PAYER, id, 1, { voucher_document_version_id: world.pendingDocument });
      expect([unclean.status, unclean.json.code]).toEqual([422, 'DOCUMENT_NOT_CLEAN']);
      const future = await confirm(PAYER, id, 1, { paid_on: addDays(TODAY, 3) });
      expect([future.status, future.json.detail]).toEqual([422, 'paid_on']);
      const stale = await confirm(PAYER, id, 9);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const unknown = await confirm(PAYER, id, 1, { settled: true });
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      expect((await confirm(PROJECT_PAYER, id, 1)).status).toBe(404);
      expect((await confirm(DEPARTMENT_PAYER, id, 1)).status).toBe(200);
      expect((await confirm(READER, id, 2)).status).toBe(403);
      expect((await confirm(NOBODY, id, 2)).status).toBe(403);
      expect((await confirm(B_PAYER, id, 2, {}, { tenantId: TENANT_B })).status).toBe(404);
      expect((await confirm(PAYER, randomUUID(), 1)).status).toBe(404);
      expect((await deposit(READER, id, 2)).status).toBe(403);
      expect((await deposit(PAYER, randomUUID(), 1)).status).toBe(404);
    });

    it('AC-ST-LND-007-2, UAT-AC383: recovers the advance through PAY with the payment that names it, leaves the trail of PAY, and refuses a payment beyond what is owed, which stays unpaid and leaves no trail', async () => {
      const a = await target();
      const b = await target();
      const c = await target();
      const plan = await approvedPlan([{ aim: a, amount: '450000000' }, { aim: b, amount: '300000000' }, { aim: c, amount: '580000000' }]);
      await schedule(PAYER, plan.id, 2, [entry(a, '450000000'), entry(b, '300000000'), entry(c, '580000000')]);
      const [p300, p450, p580] = (await rows<{ id: string }>('select id from machvon.compensation_payment where plan_id = $1::uuid order by amount_vnd', [plan.id])).map((row) => row.id);
      const advance = await advanceOf('1000000000');
      expect((await confirm(PAYER, p450 as string, 1, { advance_id: advance.id })).status).toBe(200);
      expect((await confirm(PAYER, p300 as string, 1, { advance_id: advance.id })).status).toBe(200);
      expect(await advanceRow(advance.id)).toEqual({ status: 'RECOVERING', recovered: '750000000', outstanding: '250000000' });
      const ledger = await rows<{ entry_kind: string; amount: string; source: string; basis: string }>('select entry_kind, amount_vnd::text as amount, source_ref_id as source, basis from machvon.advance_ledger_entry where advance_id = $1::uuid order by amount_vnd', [advance.id]);
      expect(ledger).toEqual([
        { entry_kind: 'RECOVER', amount: '300000000', source: p300, basis: 'COMPENSATION_PAYMENT' },
        { entry_kind: 'RECOVER', amount: '450000000', source: p450, basis: 'COMPENSATION_PAYMENT' },
      ]);
      const [recovered] = await audits(advance.id, 'advance.recovered');
      expect(recovered).toMatchObject({ actor_id: memberId(PAYER), safe_diff: { to_status: 'RECOVERING', basis: 'COMPENSATION_PAYMENT', recovery_amount_vnd: '450000000' } });
      expect((await events(advance.id, 'pay.advance.recovered.v1')).length).toBe(2);
      const [paid] = await audits(p450 as string, 'lnd.payment_confirmed');
      expect(paid).toMatchObject({ safe_diff: { advance_id: advance.id } });
      const over = await confirm(PAYER, p580 as string, 1, { advance_id: advance.id });
      expect([over.status, over.json.code]).toEqual([422, 'ADVANCE_RECOVERY_EXCEEDED']);
      expect((await paymentRow(p580 as string))?.status).toBe('PENDING');
      expect(await audits(p580 as string, 'lnd.payment_confirmed')).toHaveLength(0);
      expect(await advanceRow(advance.id)).toMatchObject({ recovered: '750000000' });
      const foreign = await advanceOf('5000', world.foreignContract);
      const wrongProject = await confirm(PAYER, p580 as string, 1, { advance_id: foreign.id });
      expect([wrongProject.status, wrongProject.json.detail]).toEqual([422, 'advance_id']);
    });
  });

  describe('listCompensationPayments', () => {
    it('lists the payments of a plan inside the units of the reader with the account masked, and nothing to a grant that reaches no household', async () => {
      const a = await target();
      const b = await target(ELSEWHERE);
      const plan = await approvedPlan([{ aim: a, amount: '1000' }, { aim: b, amount: '500' }]);
      await schedule(PAYER, plan.id, 2, [entry(a, '1000', { bank_account: '9876543210' }), entry(b, '500')]);
      const all = await get(READER, `/compensation-plans/${plan.id}/payments`);
      expect(all.status).toBe(200);
      const list = all.json.items as Array<Record<string, unknown>>;
      expect(list).toHaveLength(2);
      const mine = list.find((line) => line.amount_vnd === '1000') as Record<string, unknown>;
      expect(mine).toMatchObject({ plan_id: plan.id, household_id: a.householdId, owner_unit_id: unitId(DEPARTMENT), payment_no: 1, due_on: DUE, paid_on: null, method: null, bank_account_masked: '******3210', status: 'PENDING', version: 1 });
      expect(JSON.stringify(all.json)).not.toContain('9876543210');
      expect(typeof all.json.as_of).toBe('string');
      expect(((await get(DEPARTMENT_PAYER, `/compensation-plans/${plan.id}/payments`)).json.items as unknown[]).length).toBe(1);
      expect(((await get(PROJECT_PAYER, `/compensation-plans/${plan.id}/payments`)).json.items as unknown[]).length).toBe(0);
      expect(((await get(READER, `/compensation-plans/${plan.id}/payments?status=PAID`)).json.items as unknown[]).length).toBe(0);
      expect((await get(READER, `/compensation-plans/${plan.id}/payments?status=LOST`)).status).toBe(422);
      expect((await get(NOBODY, `/compensation-plans/${plan.id}/payments`)).status).toBe(403);
      expect((await get(B_PAYER, `/compensation-plans/${plan.id}/payments`, TENANT_B)).status).toBe(404);
      expect((await get(READER, `/compensation-plans/${randomUUID()}/payments`)).status).toBe(404);
      expect(Object.keys(mine).sort()).toEqual(
        [
          'advance_id', 'amount_vnd', 'bank_account_masked', 'deposit_reason', 'due_on', 'household_code', 'household_id', 'id', 'late_reason', 'method', 'owner_unit_id', 'paid_on', 'payment_no', 'plan_id', 'status', 'treasury_transaction_id', 'version',
          'voucher_document_version_id',
        ].sort(),
      );
    });

    it('shows a payment in the allowlist and nothing else', () => {
      const view = paymentLineView({
        id: 'a',
        planId: 'b',
        householdId: 'c',
        householdCode: 'HH',
        ownerUnitId: 'u',
        paymentNo: 1,
        amountVnd: '5',
        dueOn: DUE,
        paidOn: null,
        method: null,
        bankAccountMasked: null,
        treasuryTransactionId: null,
        advanceId: null,
        voucherDocumentVersionId: null,
        depositReason: null,
        lateReason: null,
        status: 'PENDING',
        version: 1,
      });
      expect(view.amount_vnd).toBe('5');
      expect(Object.keys(view)).not.toContain('bank_account_enc');
    });
  });

  describe('listUpcomingLandDeadlines', () => {
    it('lists the timers that are running and fall due within the days asked, the soonest first, naming what they count by its code, in the projects the reader reaches', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }], addDays(TODAY, 3));
      await schedule(PAYER, plan.id, 2, [entry(a, '1000')]);
      const reply = await get(READER, '/land-deadlines/upcoming?within_days=7');
      expect(reply.status).toBe(200);
      const list = reply.json.items as Array<Record<string, unknown>>;
      const mine = list.find((line) => line.timer_code === 'PAYMENT_30' && String(line.subject_label).endsWith(' #1') && line.due_on === addDays(TODAY, 3));
      expect(mine).toMatchObject({ project_id: world.project, subject_kind: 'PAYMENT', remaining_days: 3, status: 'RUNNING', days_applied: 42, awaiting_confirmation: true, cxn: 'CXN-12' });
      expect(String(mine?.subject_label)).toContain('PY-');
      expect(list.map((line) => line.due_on)).toEqual([...list.map((line) => String(line.due_on))].sort());
      expect(JSON.stringify(reply.json)).not.toContain(a.householdId);
      expect(typeof reply.json.as_of).toBe('string');
      const none = await get(READER, '/land-deadlines/upcoming?within_days=1');
      expect((none.json.items as Array<Record<string, unknown>>).find((line) => line.id === mine?.id)).toBeUndefined();
      const unscoped = await get(PROJECT_PAYER, '/land-deadlines/upcoming?within_days=7');
      expect((unscoped.json.items as Array<Record<string, unknown>>).find((line) => line.id === mine?.id)).toMatchObject({ subject_label: null });
      expect(((await get(B_PAYER, '/land-deadlines/upcoming?within_days=180', TENANT_B)).json.items as Array<Record<string, unknown>>).find((line) => line.id === mine?.id)).toBeUndefined();
      expect((await get(NOBODY, '/land-deadlines/upcoming')).status).toBe(403);
    });

    it('pages by the due day, takes only a count of days from 0 to 180, and shows the days past of a payment that was not made', async () => {
      const a = await target();
      const plan = await approvedPlan([{ aim: a, amount: '1000' }], addDays(TODAY, 5));
      await schedule(PAYER, plan.id, 2, [entry(a, '500'), entry(a, '500', { due_on: addDays(TODAY, 2) })]);
      const first = await get(READER, '/land-deadlines/upcoming?within_days=180&limit=1');
      expect(first.json.items).toHaveLength(1);
      expect(typeof first.json.next_cursor).toBe('string');
      const next = await get(READER, `/land-deadlines/upcoming?within_days=180&limit=1&cursor=${first.json.next_cursor as string}`);
      expect((next.json.items as Array<{ id: string }>)[0]?.id).not.toBe((first.json.items as Array<{ id: string }>)[0]?.id);
      const overdue = (await get(READER, '/land-deadlines/upcoming')).json.items as Array<Record<string, unknown>>;
      expect(overdue.some((line) => Number(line.remaining_days) < 0 && line.status === 'RUNNING')).toBe(true);
      for (const query of ['within_days=-1', 'within_days=181', 'within_days=abc', 'within_days=1.5']) {
        const refused = await get(READER, `/land-deadlines/upcoming?${query}`);
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'within_days']);
      }
      expect((await get(READER, '/land-deadlines/upcoming?limit=0')).status).toBe(422);
      expect(
        deadlineView({
          id: 'd',
          projectId: 'p',
          subjectKind: 'PARCEL',
          subjectId: 's',
          subjectLabel: 'TB-1',
          timerCode: 'NOTICE_AGRICULTURAL_90',
          daysApplied: 90,
          startedOn: '2026-07-01',
          dueOn: '2026-09-29',
          remainingDays: -3,
          status: 'RUNNING',
          alertLevelSent: 1,
          legalBasis: null,
          awaitingConfirmation: false,
          cxn: null,
        }),
      ).toMatchObject({ remaining_days: -3, alert_level_sent: 1, subject_label: 'TB-1' });
    });
  });
});

const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

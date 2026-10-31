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
import { EnforcementController, EnforcementReadsController } from '../../src/modules/lnd/enforcement.controller';
import { FIELD_CIPHER } from '../../src/modules/lnd/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedLndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import type { LndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const STARTER = 1; // land.enforce.write and land.read on the whole tenant: draws the cases up
const LEADER = 2; // the same: advances them
const DEPARTMENT_LEADER = 3; // the same on the unit tree of the department only
const PROJECT_LEADER = 4; // the same on project 1 only: it reaches the project and no household
const READER = 5; // land.read on the whole tenant
const NOBODY = 6;
const OFFICER = 7; // registers households and drafts plans (through the stores)
const CHECKER = 8;
const NARROW = 9; // reads the whole tenant and enforces on the unit tree of the department only
const B_STARTER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0xc8;
const FAMILY_B = 0xc9;
const BASIS = 'Luật Đất đai 2024, Điều 91';
const POLICY = 'Nghị định 88/2024/NĐ-CP, Điều 21';
const LEGAL = 'Luật Đất đai 2024, Điều 89';
const HEAD = 'Nguyễn Văn Anh';
const TODAY = vietnamDateOf(new Date());

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Aim {
  householdId: string;
  planId: string;
  parcelId: string;
}

describe('the enforcement of a land recovery (ST-LND-011, UAT-AC385)', () => {
  const harness = new AuthzHarness();
  const cipher = new FieldCipher(staticKeyProvider(new Map([[1, randomBytes(32)]])));
  const households = new LndHouseholdStore(cipher);
  const plans = new LndPlanStore();
  let app: RunningApp;
  let world: LndWorld;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; version?: number }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.version !== undefined) headers['if-match'] = `"${options.version}"`;
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

  /**
   * A household of a unit with a plan item in a plan that has the status given, a parcel of the project the household has a right on, and (unless said otherwise) a payment of the plan that the household did not take and that was
   * deposited. The plan is put where the commands leave it.
   */
  async function aim(options: { unit?: number; planStatus?: string; payment?: 'DEPOSITED' | 'PAID' | 'PENDING' | 'NONE'; parcelStatus?: string; decided?: boolean; linked?: boolean; covers?: boolean; paidVnd?: number } = {}): Promise<Aim> {
    counter += 1;
    const tenants = harness.tenants as TenantDatabase;
    const unit = options.unit ?? DEPARTMENT;
    const registered = await tenants.withTenant(context(OFFICER), (tx) =>
      households.register(
        tx,
        { projectId: world.project, ownerUnitId: unitId(unit), headName: HEAD, nationalId: String(800000000000 + counter * 37), legalBasis: 'PUBLIC_TASK_LAND_LAW', legalBasisRef: BASIS, retentionUntil: '2036-01-01' },
        memberId(OFFICER),
        '*',
        TODAY,
      ),
    );
    const parcelId = randomUUID();
    await rows(
      `insert into machvon.land_parcel (tenant_id, id, project_id, owner_unit_id, parcel_code, land_use_group, area_total_m2, area_affected_m2, status, recovery_notice_on, notice_days_applied, notice_document_version_id,
                                         recovery_decision_on, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, 'AGRICULTURAL', 100, 50, $5, date '2026-01-01', 90, $6::uuid, $7::date, $8::uuid, $8::uuid)`,
      [parcelId, world.project, unitId(unit), `LP-E-${String(counter).padStart(4, '0')}`, options.parcelStatus ?? 'PLAN_APPROVED', world.cleanDocument, options.decided === false ? null : '2026-06-01', memberId(OFFICER)],
    );
    if (options.linked !== false) {
      await rows(
        `insert into machvon.household_parcel (tenant_id, id, household_id, parcel_id, owner_unit_id, right_kind, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'OWNER', $4::uuid, $4::uuid)`,
        [registered.id, parcelId, unitId(unit), memberId(OFFICER)],
      );
    }
    const plan = await tenants.withTenant(context(OFFICER), (tx) =>
      plans.draft(tx, { projectId: world.project, executorUnitId: unitId(unit), executorKind: 'LAND_FUND_CENTRE', planCode: `EF-${String(counter).padStart(4, '0')}` }, memberId(OFFICER)),
    );
    await tenants.withTenant(context(OFFICER), (tx) => plans.addItems(tx, plan.id, [{ householdId: registered.id, ...(options.covers === false ? {} : { parcelId }), itemKind: 'RESETTLEMENT_LAND', amountVnd: '1000000', legalBasis: POLICY }], 1, memberId(OFFICER), '*'));
    const status = options.planStatus ?? 'APPROVED';
    if (status !== 'DRAFT') {
      await rows("update machvon.compensation_plan set status = 'POSTING', posting_started_on = $2::date, posting_ends_on = $3::date, posting_place_text = 'Commune office', timer_rule_version_id = gen_random_uuid() where id = $1::uuid", [plan.id, '2026-08-01', '2026-08-31']);
      await rows("update machvon.compensation_plan set status = 'POSTING_CLOSED', feedback_summary = 'No opinions' where id = $1::uuid", [plan.id]);
      await rows(
        "update machvon.compensation_plan set status = 'APPROVED', approved_on = $2::date, approved_by = $3::uuid, payment_due_on = date '2026-12-31', decision_document_version_id = $4::uuid where id = $1::uuid",
        [plan.id, '2026-09-02', memberId(CHECKER), world.cleanDocument],
      );
    }
    const payment = options.payment ?? 'DEPOSITED';
    if (payment !== 'NONE' && status !== 'DRAFT') {
      await rows(
        `insert into machvon.compensation_payment (tenant_id, id, plan_id, household_id, owner_unit_id, payment_no, amount_vnd, due_on, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 1, $5::numeric, date '2026-10-02', 'PENDING', $4::uuid, $4::uuid)`,
        [plan.id, registered.id, unitId(unit), memberId(OFFICER), options.paidVnd ?? 1000000],
      );
      if (payment !== 'PENDING') {
        await rows("update machvon.compensation_plan set status = 'PAYING' where id = $1::uuid", [plan.id]);
        await rows(
          payment === 'PAID'
            ? "update machvon.compensation_payment set status = 'PAID', paid_on = date '2026-10-01', method = 'BANK_TRANSFER', voucher_document_version_id = $2::uuid where plan_id = $1::uuid"
            : "update machvon.compensation_payment set status = 'DEPOSITED', paid_on = date '2026-10-01', method = 'DEPOSITED', voucher_document_version_id = $2::uuid, deposit_reason = 'The household did not take the money' where plan_id = $1::uuid",
          [plan.id, world.cleanDocument],
        );
      }
    }
    return { householdId: registered.id, planId: plan.id, parcelId };
  }

  const startBody = (target: Aim, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    project_id: world.project,
    parcel_id: target.parcelId,
    household_id: target.householdId,
    plan_id: target.planId,
    owner_unit_id: unitId(DEPARTMENT),
    authority_unit_id: unitId(ROOT),
    legal_basis: LEGAL,
    started_on: TODAY,
    ...extra,
  });
  const start = (member: number, target: Aim, extra: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> =>
    call('POST', '/land-enforcement-cases', { member, body: startBody(target, extra), ...(tenantId === undefined ? {} : { tenantId }) });
  const advance = (member: number, caseId: string, version: number, body: Record<string, unknown>): Promise<Reply> => call('POST', `/land-enforcement-cases/${caseId}/advance`, { member, version, body });
  const list = (member: number, query = ''): Promise<Reply> => call('GET', `/land-enforcement-cases?project_id=${world.project}${query}`, { member });
  const stored = async (id: string) =>
    (
      await rows<{ step: string; version: string; decision_document_version_id: string | null; planned_on: string | null; executed_on: string | null; suspended_from: string | null; suspend_reason: string | null }>(
        'select step, version::text, decision_document_version_id, planned_on::text, executed_on::text, suspended_from, suspend_reason from machvon.land_enforcement_case where id = $1::uuid',
        [id],
      )
    )[0];
  const parcelStatus = async (id: string): Promise<string | undefined> => (await rows<{ status: string }>('select status from machvon.land_parcel where id = $1::uuid', [id]))[0]?.status;
  /** A case drawn up by STARTER, taken by LEADER up to the step given. */
  async function caseAt(step: 'PERSUASION' | 'NOTICE' | 'ORGANIZATION_DECISION' | 'ENFORCEMENT_DECISION' | 'EXECUTING' | 'COMPLETED'): Promise<{ id: string; version: number; aim: Aim }> {
    const target = await aim();
    const made = await start(STARTER, target);
    expect(made.status).toBe(200);
    let version = 1;
    const id = made.json.resource_id as string;
    const steps: Array<[string, Record<string, unknown>]> = [
      ['NOTICE', {}],
      ['ORGANIZATION_DECISION', { decision_document_version_id: world.cleanDocument }],
      ['ENFORCEMENT_DECISION', { decision_document_version_id: world.cleanDocument }],
      ['EXECUTING', { decision_document_version_id: world.cleanDocument, planned_on: TODAY }],
      ['COMPLETED', { executed_on: TODAY }],
    ];
    const order = ['PERSUASION', 'NOTICE', 'ORGANIZATION_DECISION', 'ENFORCEMENT_DECISION', 'EXECUTING', 'COMPLETED'];
    for (const [to, extra] of steps) {
      if (order.indexOf(to) > order.indexOf(step)) break;
      const moved = await advance(LEADER, id, version, { to_step: to, ...extra });
      expect(moved.status).toBe(200);
      version += 1;
    }
    return { id, version, aim: target };
  }

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
    for (const n of [STARTER, LEADER, DEPARTMENT_LEADER, PROJECT_LEADER, READER, NOBODY, OFFICER, CHECKER, NARROW]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_STARTER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'ENFORCEMENT_LEADER', ['land.enforce.write', 'land.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'LAND_READER', ['land.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'ENFORCEMENT_LEADER', ['land.enforce.write', 'land.read'], 30);
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, OFFICER, DEPARTMENT, ROOT);
    await seedLndWorld(harness.database.adminUrl, TENANT_B, FAMILY_B, B_STARTER, DEPARTMENT, ROOT);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: STARTER, role: 1, kind: 'TENANT' },
      { n: 2, member: LEADER, role: 1, kind: 'TENANT' },
      { n: 3, member: DEPARTMENT_LEADER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 4, member: PROJECT_LEADER, role: 1, kind: 'PROJECT', refs: [world.project] },
      { n: 5, member: READER, role: 2, kind: 'TENANT' },
      { n: 6, member: NARROW, role: 2, kind: 'TENANT' },
      { n: 7, member: NARROW, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_STARTER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [EnforcementController, EnforcementReadsController],
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
    expect(lndModule.controllers).toEqual(expect.arrayContaining([EnforcementController, EnforcementReadsController]));
  });

  describe('startEnforcement (AC-ST-LND-011-1, UAT-AC385)', () => {
    it('refuses a case for a parcel that the plan does not compensate for the household, although the household was paid for another parcel of it', async () => {
      const other = await aim({ covers: false, payment: 'PAID' });
      expect(await start(STARTER, other)).toMatchObject({ status: 422, json: { code: 'PAYMENT_NOT_OFFERED', reason: 'PLAN_DOES_NOT_COVER_PARCEL' } });
      expect(await rows('select 1 from machvon.land_enforcement_case where parcel_id = $1::uuid', [other.parcelId])).toEqual([]);
      expect((await start(STARTER, await aim({ payment: 'PAID' }))).status).toBe(200);
    });

    it('refuses a case while only a part of what the plan holds for the household was paid, and opens it once the installments cover it', async () => {
      const part = await aim({ paidVnd: 1, payment: 'PAID' });
      expect(await start(STARTER, part)).toMatchObject({ status: 422, json: { code: 'PAYMENT_NOT_OFFERED', reason: 'NOT_PAID_OR_DEPOSITED' } });
      await rows(
        `insert into machvon.compensation_payment (tenant_id, id, plan_id, household_id, owner_unit_id, payment_no, amount_vnd, due_on, status, created_by, updated_by)
         select tenant_id, gen_random_uuid(), plan_id, household_id, owner_unit_id, 2, 999999, date '2026-10-03', 'PENDING', created_by, updated_by from machvon.compensation_payment where plan_id = $1::uuid`,
        [part.planId],
      );
      // The second installment is still waiting: the household is not yet paid.
      expect(await start(STARTER, part)).toMatchObject({ status: 422, json: { code: 'PAYMENT_NOT_OFFERED' } });
      await rows("update machvon.compensation_payment set status = 'PAID', paid_on = date '2026-10-01', method = 'BANK_TRANSFER', voucher_document_version_id = $2::uuid where plan_id = $1::uuid and status = 'PENDING'", [part.planId, world.cleanDocument]);
      expect((await start(STARTER, part)).status).toBe(200);
    });

    it('UAT-AC385: refuses a case while the money was not offered to the household, and opens it once it was deposited', async () => {
      const none = await aim({ payment: 'NONE' });
      expect(await start(STARTER, none)).toMatchObject({ status: 422, json: { code: 'PAYMENT_NOT_OFFERED', reason: 'NOT_PAID_OR_DEPOSITED' } });
      const pending = await aim({ payment: 'PENDING' });
      expect(await start(STARTER, pending)).toMatchObject({ status: 422, json: { code: 'PAYMENT_NOT_OFFERED' } });
      expect(await rows('select 1 from machvon.land_enforcement_case where parcel_id = any($1::uuid[])', [[none.parcelId, pending.parcelId]])).toEqual([]);
      for (const payment of ['DEPOSITED', 'PAID'] as const) {
        const offered = await aim({ payment });
        const made = await start(STARTER, offered);
        expect(made).toMatchObject({ status: 200, json: { status: 'PERSUASION', resource_version: 1 } });
        expect(await stored(made.json.resource_id as string)).toMatchObject({ step: 'PERSUASION', version: '1', decision_document_version_id: null });
      }
    });

    it('writes one audit row of personal data with ids only, and one event, and none for a refusal', async () => {
      const refused = await aim({ payment: 'NONE' });
      expect((await start(STARTER, refused)).status).toBe(422);
      const target = await aim();
      const made = await start(STARTER, target);
      const id = made.json.resource_id as string;
      const audit = await rows<{ safe_diff: Record<string, unknown>; actor_id: string; classification: string }>(`select safe_diff, actor_id, classification from machvon.audit_event where action = 'lnd.enforcement_started' and resource_id = $1`, [id]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: memberId(STARTER), classification: 'PERSONAL' });
      expect(audit[0]?.safe_diff).toMatchObject({ project_id: world.project, parcel_id: target.parcelId, household_id: target.householdId, plan_id: target.planId, to_step: 'PERSUASION', from_step: null, started_on: TODAY });
      expect(JSON.stringify(audit[0]?.safe_diff)).not.toContain(HEAD);
      expect(JSON.stringify(audit[0]?.safe_diff)).not.toContain('Luật');
      const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'lnd.enforcement.started.v1' and aggregate_id = $1`, [id]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ case_id: id, parcel_id: target.parcelId, step: 'PERSUASION', version: 1, actor_id: memberId(STARTER) });
      expect(JSON.stringify(events[0]?.payload)).not.toContain(HEAD);
      expect(await rows(`select 1 from machvon.audit_event where action = 'lnd.enforcement_started' and safe_diff ->> 'parcel_id' = $1`, [refused.parcelId])).toEqual([]);
    });

    it('refuses what the recovery has not reached: a parcel with no decision, one that is not under a plan, a plan that is not approved, a household with no right on the parcel, no plan', async () => {
      expect(await start(STARTER, await aim({ decided: false }))).toMatchObject({ status: 422, json: { code: 'PRECONDITION_NOT_MET', reason: 'RECOVERY_DECISION_MISSING' } });
      expect(await start(STARTER, await aim({ parcelStatus: 'SURVEYED' }))).toMatchObject({ status: 422, json: { code: 'PRECONDITION_NOT_MET', reason: 'PARCEL_STATUS' } });
      expect(await start(STARTER, await aim({ planStatus: 'DRAFT' }))).toMatchObject({ status: 422, json: { code: 'PRECONDITION_NOT_MET', reason: 'PLAN_NOT_APPROVED' } });
      expect(await start(STARTER, await aim({ linked: false }))).toMatchObject({ status: 422, json: { code: 'PRECONDITION_NOT_MET', reason: 'HOUSEHOLD_NOT_ON_PARCEL' } });
      const target = await aim();
      expect(await start(STARTER, target, { plan_id: undefined })).toMatchObject({ status: 422, json: { code: 'PAYMENT_NOT_OFFERED', reason: 'NO_PLAN_OR_HOUSEHOLD' } });
      expect(await start(STARTER, target, { household_id: undefined })).toMatchObject({ status: 422, json: { code: 'PAYMENT_NOT_OFFERED', reason: 'NO_PLAN_OR_HOUSEHOLD' } });
      expect(await start(STARTER, target, { plan_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'PRECONDITION_NOT_MET', reason: 'PLAN_NOT_APPROVED' } });
      // A parcel under a complaint is enforced as well.
      expect((await start(STARTER, await aim({ parcelStatus: 'DISPUTED' }))).status).toBe(200);
    });

    it('opens one case at a time for a parcel: a second is refused while the first is open, suspended included, and once it is completed the parcel is enforced and needs none', async () => {
      const target = await aim();
      const first = await start(STARTER, target);
      expect(await start(STARTER, target)).toMatchObject({ status: 409, json: { code: 'ENFORCEMENT_CASE_EXISTS' } });
      const id = first.json.resource_id as string;
      expect((await advance(LEADER, id, 1, { to_step: 'SUSPENDED', suspend_reason: 'An appeal was filed' })).status).toBe(200);
      expect(await start(STARTER, target)).toMatchObject({ status: 409, json: { code: 'ENFORCEMENT_CASE_EXISTS' } });
      expect(await rows('select 1 from machvon.land_enforcement_case where parcel_id = $1::uuid', [target.parcelId])).toHaveLength(1);
      const done = await caseAt('COMPLETED');
      expect(await start(STARTER, done.aim)).toMatchObject({ status: 422, json: { code: 'PRECONDITION_NOT_MET', reason: 'PARCEL_STATUS' } });
    });

    it('refuses what is badly formed or out of reach: a day in the future, a unit that is not the household’s, an authority that is not there, a parcel or a household of another project, a project of another tenant', async () => {
      const target = await aim();
      expect(await start(STARTER, target, { started_on: '2999-01-01' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'started_on' } });
      expect(await start(STARTER, target, { started_on: '2026-02-30' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'started_on' } });
      expect(await start(STARTER, target, { owner_unit_id: unitId(ELSEWHERE) })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'owner_unit_id' } });
      expect(await start(STARTER, target, { authority_unit_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'authority_unit_id' } });
      expect(await start(STARTER, target, { legal_basis: '   ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'legal_basis' } });
      expect(await start(STARTER, target, { parcel_id: randomUUID() })).toMatchObject({ status: 404 });
      expect(await start(STARTER, target, { household_id: randomUUID() })).toMatchObject({ status: 404 });
      expect(await start(STARTER, target, { project_id: world.otherProject })).toMatchObject({ status: 404 });
      expect(await start(STARTER, target, { project_id: randomUUID() })).toMatchObject({ status: 404 });
      expect(await start(STARTER, target, { status: 'EXECUTING' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await rows('select 1 from machvon.land_enforcement_case where parcel_id = $1::uuid', [target.parcelId])).toEqual([]);
    });
  });

  describe('advanceEnforcement (AC-ST-LND-011-1, UAT-AC385)', () => {
    it('UAT-AC385: refuses the execution without the decision, and the person who drew the case up, then executes it for someone else with the decision and the day, putting the parcel under enforcement', async () => {
      const at = await caseAt('ENFORCEMENT_DECISION');
      expect(await advance(LEADER, at.id, at.version, { to_step: 'EXECUTING', planned_on: TODAY })).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_REQUIRED' } });
      expect(await advance(LEADER, at.id, at.version, { to_step: 'EXECUTING', decision_document_version_id: world.cleanDocument })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'planned_on' } });
      expect(await advance(STARTER, at.id, at.version, { to_step: 'EXECUTING', decision_document_version_id: world.cleanDocument, planned_on: TODAY })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await stored(at.id)).toMatchObject({ step: 'ENFORCEMENT_DECISION', version: String(at.version) });
      expect(await parcelStatus(at.aim.parcelId)).toBe('PLAN_APPROVED');
      const moved = await advance(LEADER, at.id, at.version, { to_step: 'EXECUTING', decision_document_version_id: world.cleanDocument, planned_on: TODAY });
      expect(moved).toMatchObject({ status: 200, json: { status: 'EXECUTING', resource_version: at.version + 1 } });
      expect(await stored(at.id)).toMatchObject({ step: 'EXECUTING', decision_document_version_id: world.cleanDocument, planned_on: TODAY });
      expect(await parcelStatus(at.aim.parcelId)).toBe('ENFORCEMENT');
      const audit = await rows<{ safe_diff: Record<string, unknown>; actor_id: string; classification: string }>(
        `select safe_diff, actor_id, classification from machvon.audit_event where action = 'lnd.enforcement_advanced' and resource_id = $1 order by occurred_at desc, id desc`,
        [at.id],
      );
      expect(audit[0]).toMatchObject({ actor_id: memberId(LEADER), classification: 'PERSONAL', safe_diff: { from_step: 'ENFORCEMENT_DECISION', to_step: 'EXECUTING', planned_on: TODAY, decision_document_version_id: world.cleanDocument } });
      const events = await rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where type = 'lnd.enforcement.advanced.v1' and aggregate_id = $1 order by created_at desc, id desc`, [at.id]);
      expect(events[0]?.payload).toMatchObject({ case_id: at.id, step: 'EXECUTING', from_step: 'ENFORCEMENT_DECISION', version: at.version + 1 });
    });

    it('goes through every step, each decision with its document, and completes with the day it was carried out', async () => {
      const done = await caseAt('COMPLETED');
      expect(await stored(done.id)).toMatchObject({ step: 'COMPLETED', executed_on: TODAY, decision_document_version_id: world.cleanDocument });
      expect(await rows(`select 1 from machvon.audit_event where action = 'lnd.enforcement_advanced' and resource_id = $1`, [done.id])).toHaveLength(5);
      // A completed case is final.
      for (const to of ['SUSPENDED', 'NOTICE', 'COMPLETED']) expect(await advance(LEADER, done.id, done.version, { to_step: to, suspend_reason: 'x', executed_on: TODAY })).toMatchObject({ status: 422, json: { code: 'ENFORCEMENT_STEP_INVALID' } });
    });

    it('refuses a step that is skipped or gone back to, a decision with no document or with one that is not clean, a day before the case or in the future, and a step that does not exist', async () => {
      const at = await caseAt('NOTICE');
      expect(await advance(LEADER, at.id, at.version, { to_step: 'ENFORCEMENT_DECISION', decision_document_version_id: world.cleanDocument })).toMatchObject({
        status: 422,
        json: { code: 'ENFORCEMENT_STEP_INVALID', from_step: 'NOTICE', to_step: 'ENFORCEMENT_DECISION' },
      });
      expect(await advance(LEADER, at.id, at.version, { to_step: 'NOTICE' })).toMatchObject({ status: 422, json: { code: 'ENFORCEMENT_STEP_INVALID' } });
      expect(await advance(LEADER, at.id, at.version, { to_step: 'ORGANIZATION_DECISION' })).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_REQUIRED' } });
      expect(await advance(LEADER, at.id, at.version, { to_step: 'ORGANIZATION_DECISION', decision_document_version_id: world.pendingDocument })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_CLEAN' } });
      expect(await advance(LEADER, at.id, at.version, { to_step: 'ORGANIZATION_DECISION', decision_document_version_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect([400, 422]).toContain((await advance(LEADER, at.id, at.version, { to_step: 'PERSUASION' })).status);
      expect([400, 422]).toContain((await advance(LEADER, at.id, at.version, { to_step: 'LATER' })).status);
      expect(await stored(at.id)).toMatchObject({ step: 'NOTICE' });
      const executing = await caseAt('EXECUTING');
      expect(await advance(LEADER, executing.id, executing.version, { to_step: 'COMPLETED' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'executed_on' } });
      expect(await advance(LEADER, executing.id, executing.version, { to_step: 'COMPLETED', executed_on: '2999-01-01' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'executed_on', reason: 'IN_THE_FUTURE' } });
      expect(await advance(LEADER, executing.id, executing.version, { to_step: 'COMPLETED', executed_on: '2000-01-01' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'executed_on', reason: 'BEFORE_START' } });
      const later = await caseAt('NOTICE');
      expect(await advance(LEADER, later.id, later.version, { to_step: 'ORGANIZATION_DECISION', decision_document_version_id: world.cleanDocument, planned_on: '2000-01-01' })).toMatchObject({
        status: 422,
        json: { code: 'VALIDATION_FAILED', detail: 'planned_on', reason: 'BEFORE_START' },
      });
    });

    it('answers a version that moved, and a case that does not exist', async () => {
      const at = await caseAt('PERSUASION');
      expect(await advance(LEADER, at.id, at.version + 3, { to_step: 'NOTICE' })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await advance(LEADER, randomUUID(), 1, { to_step: 'NOTICE' })).toMatchObject({ status: 404 });
      expect((await advance(LEADER, at.id, at.version, { to_step: 'NOTICE' })).status).toBe(200);
      // The same version is no longer the version of the case.
      expect(await advance(LEADER, at.id, at.version, { to_step: 'ORGANIZATION_DECISION', decision_document_version_id: world.cleanDocument })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    });

    it('suspends a case with a reason and takes it up again where it stopped or at the step after it, and not elsewhere', async () => {
      const at = await caseAt('NOTICE');
      expect(await advance(LEADER, at.id, at.version, { to_step: 'SUSPENDED' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'suspend_reason' } });
      expect((await advance(LEADER, at.id, at.version, { to_step: 'SUSPENDED', suspend_reason: 'An appeal was filed' })).status).toBe(200);
      expect(await stored(at.id)).toMatchObject({ step: 'SUSPENDED', suspended_from: 'NOTICE', suspend_reason: 'An appeal was filed' });
      expect(await advance(LEADER, at.id, at.version + 1, { to_step: 'ENFORCEMENT_DECISION', decision_document_version_id: world.cleanDocument })).toMatchObject({ status: 422, json: { code: 'ENFORCEMENT_STEP_INVALID' } });
      expect(await advance(LEADER, at.id, at.version + 1, { to_step: 'SUSPENDED', suspend_reason: 'Again' })).toMatchObject({ status: 422, json: { code: 'ENFORCEMENT_STEP_INVALID' } });
      expect((await advance(LEADER, at.id, at.version + 1, { to_step: 'NOTICE' })).status).toBe(200);
      expect(await stored(at.id)).toMatchObject({ step: 'NOTICE', suspended_from: null });
      const second = await caseAt('PERSUASION');
      await advance(LEADER, second.id, second.version, { to_step: 'SUSPENDED', suspend_reason: 'Waiting for the court' });
      expect((await advance(LEADER, second.id, second.version + 1, { to_step: 'NOTICE' })).status).toBe(200);
    });

    it('lets a case that was executing be suspended and taken up again at execution without moving the parcel twice', async () => {
      const at = await caseAt('EXECUTING');
      expect(await parcelStatus(at.aim.parcelId)).toBe('ENFORCEMENT');
      expect((await advance(LEADER, at.id, at.version, { to_step: 'SUSPENDED', suspend_reason: 'Rain' })).status).toBe(200);
      expect((await advance(LEADER, at.id, at.version + 1, { to_step: 'EXECUTING', decision_document_version_id: world.cleanDocument, planned_on: TODAY })).status).toBe(200);
      expect(await parcelStatus(at.aim.parcelId)).toBe('ENFORCEMENT');
    });

    it('refuses to execute on a parcel that is not under a plan, a payment or a complaint any more', async () => {
      const at = await caseAt('ENFORCEMENT_DECISION');
      await rows("update machvon.land_parcel set status = 'HANDED_OVER' where id = $1::uuid", [at.aim.parcelId]);
      expect(await advance(LEADER, at.id, at.version, { to_step: 'EXECUTING', decision_document_version_id: world.cleanDocument, planned_on: TODAY })).toMatchObject({
        status: 422,
        json: { code: 'ENFORCEMENT_STEP_INVALID', reason: 'PARCEL_STATUS' },
      });
      expect(await stored(at.id)).toMatchObject({ step: 'ENFORCEMENT_DECISION' });
    });
  });

  describe('who may', () => {
    it('is for the holders of the right over the project and the unit of the household: a project seen and not served is 403, one not seen is 404', async () => {
      const target = await aim();
      expect((await start(NOBODY, target)).status).toBe(403);
      expect((await start(READER, target)).status).toBe(403);
      // The department leader holds the right over the unit of the household.
      expect((await start(DEPARTMENT_LEADER, target)).status).toBe(200);
      // The leader of the project reaches the project and no household: the unit of the household is not there for it.
      expect(await start(PROJECT_LEADER, await aim())).toMatchObject({ status: 404 });
      expect(await start(DEPARTMENT_LEADER, await aim({ unit: ELSEWHERE }), { owner_unit_id: unitId(ELSEWHERE) })).toMatchObject({ status: 404 });
      expect(await start(B_STARTER, await aim(), {}, TENANT_B)).toMatchObject({ status: 404 });
    });

    it('does not let anyone advance a case outside the units of the caller', async () => {
      const at = await caseAt('PERSUASION');
      expect((await advance(NOBODY, at.id, at.version, { to_step: 'NOTICE' })).status).toBe(403);
      expect((await advance(READER, at.id, at.version, { to_step: 'NOTICE' })).status).toBe(403);
      expect(await advance(PROJECT_LEADER, at.id, at.version, { to_step: 'NOTICE' })).toMatchObject({ status: 404 });
      const foreign = await call('POST', `/land-enforcement-cases/${at.id}/advance`, { member: B_STARTER, tenantId: TENANT_B, version: at.version, body: { to_step: 'NOTICE' } });
      expect(foreign.status).toBe(404);
      expect((await advance(DEPARTMENT_LEADER, at.id, at.version, { to_step: 'NOTICE' })).status).toBe(200);
    });
  });

  describe('listEnforcementCases (LND-09)', () => {
    it('lists the cases of a project newest first with the household masked, what the caller may do, and a page at a time, and filters them by step', async () => {
      const first = await caseAt('PERSUASION');
      const second = await caseAt('NOTICE');
      const third = await caseAt('PERSUASION');
      const all = await list(LEADER);
      expect(all.status).toBe(200);
      const items = all.json.items as Array<Record<string, unknown>>;
      const ids = items.map((item) => item.id);
      expect(ids.indexOf(third.id)).toBeLessThan(ids.indexOf(second.id));
      expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
      const line = items.find((item) => item.id === second.id) as Record<string, unknown>;
      expect(line).toMatchObject({ project_id: world.project, step: 'NOTICE', legal_basis: LEGAL, parcel: { id: second.aim.parcelId, status: 'PLAN_APPROVED' }, household: { id: second.aim.householdId }, version: 2 });
      expect(JSON.stringify(line)).not.toContain(HEAD);
      expect((line.household as Record<string, unknown>).head_name).not.toBe(HEAD);
      expect(Object.keys(line).sort()).toEqual(
        ['allowed', 'authority_unit_id', 'decision_document_version_id', 'executed_on', 'household', 'id', 'legal_basis', 'owner_unit_id', 'parcel', 'plan_id', 'planned_on', 'project_id', 'started_on', 'step', 'suspend_reason', 'suspended_from', 'version'].sort(),
      );
      // Drawn up by STARTER: it does not advance the case, the leader does.
      expect(line.allowed).toMatchObject({ advance: true, suspend: true, next: 'ORGANIZATION_DECISION' });
      const mine = ((await list(STARTER)).json.items as Array<Record<string, unknown>>).find((item) => item.id === second.id);
      expect(mine?.allowed).toMatchObject({ advance: false, suspend: false });
      const reading = ((await list(READER)).json.items as Array<Record<string, unknown>>).find((item) => item.id === second.id);
      expect(reading?.allowed).toMatchObject({ advance: false, suspend: false });
      // A reader of the whole tenant who enforces inside one unit only is offered the cases of that unit and not the others: the server would answer 404 to the rest.
      const inside = (await start(STARTER, await aim())).json.resource_id as string;
      const outside = (await start(STARTER, await aim({ unit: ELSEWHERE }), { owner_unit_id: unitId(ELSEWHERE) })).json.resource_id as string;
      const narrow = (await list(NARROW)).json.items as Array<Record<string, unknown>>;
      expect(narrow.find((item) => item.id === inside)?.allowed).toMatchObject({ advance: true, suspend: true });
      expect(narrow.find((item) => item.id === outside)?.allowed).toMatchObject({ advance: false, suspend: false });
      expect(((await list(LEADER)).json.items as Array<Record<string, unknown>>).find((item) => item.id === outside)?.allowed).toMatchObject({ advance: true, suspend: true });
      const completed = await caseAt('COMPLETED');
      const done = ((await list(LEADER, '&step=COMPLETED')).json.items as Array<Record<string, unknown>>).find((item) => item.id === completed.id);
      expect(done).toMatchObject({ step: 'COMPLETED', allowed: { advance: false, suspend: false, next: null } });
      await advance(LEADER, third.id, third.version, { to_step: 'SUSPENDED', suspend_reason: 'Waiting' });
      const suspended = ((await list(LEADER, '&step=SUSPENDED')).json.items as Array<Record<string, unknown>>).find((item) => item.id === third.id);
      expect(suspended).toMatchObject({ step: 'SUSPENDED', suspended_from: 'PERSUASION', suspend_reason: 'Waiting', allowed: { next: 'NOTICE' } });

      const everyone = ((await list(LEADER)).json.items as Array<{ id: string }>).map((item) => item.id);
      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 40; page += 1) {
        const reply = await list(LEADER, `&limit=2${cursor}`);
        seen.push(...(reply.json.items as Array<{ id: string }>).map((entry) => entry.id));
        if (reply.json.next_cursor === null) break;
        cursor = `&cursor=${encodeURIComponent(reply.json.next_cursor as string)}`;
      }
      expect(seen).toEqual(everyone);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expect.arrayContaining([first.id, second.id, third.id, completed.id]));
    });

    it('shows nothing outside the units of the reader, nothing of a project the caller cannot reach, and refuses what is badly formed', async () => {
      const at = await caseAt('PERSUASION');
      expect(((await list(DEPARTMENT_LEADER)).json.items as Array<{ id: string }>).map((item) => item.id)).toContain(at.id);
      expect((await list(PROJECT_LEADER)).json.items).toEqual([]);
      expect((await call('GET', `/land-enforcement-cases?project_id=${world.otherProject}`, { member: LEADER })).json.items).toEqual([]);
      expect((await call('GET', `/land-enforcement-cases?project_id=${randomUUID()}`, { member: LEADER })).json.items).toEqual([]);
      expect((await list(NOBODY)).status).toBe(403);
      for (const query of ['&step=NOPE', '&limit=0', '&limit=500', '&cursor=nope']) expect((await list(LEADER, query)).status).toBeGreaterThanOrEqual(400);
      expect((await call('GET', '/land-enforcement-cases', { member: LEADER })).status).toBe(422);
      expect((await call('GET', '/land-enforcement-cases?project_id=nope', { member: LEADER })).status).toBe(422);
      expect(((await call('GET', `/land-enforcement-cases?project_id=${world.project}`, { member: B_STARTER, tenantId: TENANT_B })).json.items as unknown[]).length).toBe(0);
    });
  });

  describe('is kept by the database as well', () => {
    const edit = async (sql: string, params: unknown[] = []): Promise<string> => {
      const client = new Client({ connectionString: harness.database.adminUrl });
      await client.connect();
      try {
        await client.query(sql, params);
        return 'done';
      } catch (error) {
        return (error as Error).message;
      } finally {
        await client.end();
      }
    };

    it('does not let what a case is change, its step skip a step or go back, a suspension forget where it stopped, nor a completed case move', async () => {
      const at = await caseAt('NOTICE');
      expect(await edit("update machvon.land_enforcement_case set legal_basis = 'Other' where id = $1::uuid", [at.id])).toMatch(/never changes/);
      expect(await edit("update machvon.land_enforcement_case set parcel_id = gen_random_uuid() where id = $1::uuid", [at.id])).toMatch(/never changes|foreign key/);
      expect(await edit("update machvon.land_enforcement_case set step = 'ENFORCEMENT_DECISION' where id = $1::uuid", [at.id])).toMatch(/not allowed/);
      expect(await edit("update machvon.land_enforcement_case set step = 'PERSUASION' where id = $1::uuid", [at.id])).toMatch(/not allowed/);
      expect(await edit("update machvon.land_enforcement_case set step = 'SUSPENDED', suspend_reason = 'Why', suspended_from = 'PERSUASION' where id = $1::uuid", [at.id])).toMatch(/suspended from the step it stands at/);
      expect(await edit("update machvon.land_enforcement_case set step = 'SUSPENDED', suspend_reason = 'Why' where id = $1::uuid", [at.id])).toMatch(/land_enforcement_suspended_chk|suspended from/);
      expect(await edit("update machvon.land_enforcement_case set step = 'EXECUTING' where id = $1::uuid", [at.id])).toMatch(/not allowed/);
      expect(await stored(at.id)).toMatchObject({ step: 'NOTICE' });
      const done = await caseAt('COMPLETED');
      expect(await edit("update machvon.land_enforcement_case set planned_on = date '2030-01-01' where id = $1::uuid", [done.id])).toMatch(/final/);
      expect(await edit("update machvon.land_enforcement_case set step = 'COMPLETED', executed_on = null where id = $1::uuid", [done.id])).toMatch(/final|land_enforcement_completed_chk/);
    });

    it('keeps the days after the day the case started, a legal basis that is trimmed, and a case that is completed with its day', async () => {
      const at = await caseAt('NOTICE');
      expect(await edit("update machvon.land_enforcement_case set planned_on = date '2000-01-01' where id = $1::uuid", [at.id])).toMatch(/land_enforcement_dates_chk/);
      const insert = (basis: string, step = 'PERSUASION') =>
        edit(
          `insert into machvon.land_enforcement_case (tenant_id, id, project_id, parcel_id, owner_unit_id, step, started_on, legal_basis, created_by, updated_by)
           select tenant_id, gen_random_uuid(), project_id, gen_random_uuid(), owner_unit_id, $2, started_on, $1, created_by, updated_by from machvon.land_enforcement_case where id = $3::uuid`,
          [basis, step, at.id],
        );
      expect(await insert(' padded ')).toMatch(/land_enforcement_text_chk|foreign key/);
      expect(await insert('basis', 'COMPLETED')).toMatch(/land_enforcement_completed_chk|land_enforcement_exec_chk|foreign key/);
    });

    it('is never deleted by the application', async () => {
      const at = await caseAt('PERSUASION');
      const appClient = new Client({ connectionString: harness.database.urlFor('machvon_app') });
      await appClient.connect();
      try {
        await appClient.query('begin');
        await appClient.query("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
        await appClient.query("select set_config('app.scope_units', '*', true)");
        await expect(appClient.query('delete from machvon.land_enforcement_case where id = $1::uuid', [at.id])).rejects.toThrow(/permission denied/);
      } finally {
        await appClient.end();
      }
      expect(await stored(at.id)).toMatchObject({ step: 'PERSUASION' });
    });
  });
});

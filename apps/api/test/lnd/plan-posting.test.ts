import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, LndHouseholdStore, LndInventoryStore, LndParcelStore, MasterStore, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { FieldCipher, addCalendarDays, loadErrorRegistry, signTenantContext, staticKeyProvider, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { CompensationPlanController, CompensationPlanReadsController } from '../../src/modules/lnd/plan.controller';
import { CompensationPlanPostingController, CompensationPlanPostingReadsController, feedbackLineView, planTimersView } from '../../src/modules/lnd/plan-posting.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedLndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import type { LndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PLANNER = 1; // land.plan.write and land.read on the whole tenant
const APPROVER = 2; // land.plan.approve and land.read on the whole tenant
const DEPARTMENT_PLANNER = 3; // the same as the planner on the unit tree of the department only
const PROJECT_PLANNER = 4; // the same on project 1 only: it reaches the plans of the project and no household
const READER = 5; // land.read on the whole tenant
const NOBODY = 6;
const COUNTER = 7; // counts inventory (through the stores)
const CHECKER = 8;
const DRAFTER_APPROVER = 9; // writes and approves: the four eyes are what stop it approving its own plan
const B_PLANNER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0xbe;
const FAMILY_B = 0xbf;
const WORKER = WORKER_MEMBERSHIP_ID;
const DECISION = 'QD-GIA-2024';
const BASIS = 'Luật Đất đai 2024, Điều 91';
const PLACE = 'Trụ sở UBND xã Tân Hòa';
const WORDS = 'The price of the house is far too low';
const TODAY = vietnamDateOf(new Date());
const daysAgo = (days: number): string => vietnamDateOf(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the posting of a plan to the households, the opinions on it and its approval (ST-LND-006)', () => {
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
      households.register(tx, { projectId: world.project, ownerUnitId: unitId(unit), headName: 'Nguyễn Văn A', nationalId: String(600000000000 + counter * 29), legalBasis: 'PUBLIC_TASK_LAND_LAW', legalBasisRef: BASIS, retentionUntil: '2036-12-31' }, memberId(COUNTER), '*', TODAY),
    );
    const parcel = await tenants.withTenant(context(COUNTER), (tx) =>
      parcels.create(tx, { projectId: world.project, ownerUnitId: unitId(unit), parcelCode: `LP-R-${String(counter).padStart(4, '0')}`, landUseGroup: 'AGRICULTURAL', areaTotalM2: '1000', areaAffectedM2: '500' }, memberId(COUNTER), TODAY),
    );
    await tenants.withTenant(context(COUNTER), (tx) => households.link(tx, registered.id, { parcelId: parcel.id, rightKind: 'OWNER' }, memberId(COUNTER), '*'));
    return { householdId: registered.id, parcelId: parcel.id };
  }
  async function confirmed(aim: Target): Promise<string> {
    const tenants = harness.tenants as TenantDatabase;
    const counted = await tenants.withTenant(context(COUNTER), (tx) =>
      inventory.record(tx, { householdId: aim.householdId, parcelId: aim.parcelId, itemKind: 'HOUSE', description: 'House of level 4', quantity: '80', unitCode: 'M2', unitPriceVnd: '4500000', priceDecisionRef: DECISION, surveyedOn: '2026-06-20' }, memberId(COUNTER), '*', TODAY),
    );
    await tenants.withTenant(context(CHECKER), (tx) => inventory.confirm(tx, counted.id, { outcome: 'CONFIRMED', householdConfirmedOn: '2026-07-01' }, 1, memberId(CHECKER), '*', TODAY));
    return counted.id;
  }

  const draft = (member: number): Promise<Reply> =>
    call('POST', '/compensation-plans', { member, body: { project_id: world.project, executor_unit_id: unitId(DEPARTMENT), executor_kind: 'LAND_FUND_CENTRE', plan_code: `PP-${String(++counter).padStart(4, '0')}` } });
  const addItems = (member: number, planId: string, version: number, list: Array<Record<string, unknown>>): Promise<Reply> =>
    call('POST', `/compensation-plans/${planId}/items`, { member, ifMatch: `"${version}"`, body: { items: list } });
  const postPlan = (member: number, planId: string, version: number, body: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> =>
    call('POST', `/compensation-plans/${planId}/post`, { member, ifMatch: `"${version}"`, ...(tenantId === undefined ? {} : { tenantId }), body: { posting_started_on: TODAY, posting_place_text: PLACE, ...body } });
  const feedback = (member: number, planId: string, body: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> =>
    call('POST', `/compensation-plans/${planId}/feedback`, { member, ...(tenantId === undefined ? {} : { tenantId }), body: { summary: WORDS, channel: 'MEETING', ...body } });
  const handle = (member: number, planId: string, feedbackId: string, body: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/compensation-plans/${planId}/feedback/${feedbackId}/handle`, { member, body: { handling_note: 'Explained at the meeting of the commune', ...body } });
  const close = (member: number, planId: string, version: number, body: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/compensation-plans/${planId}/close-posting`, { member, ifMatch: `"${version}"`, body: { feedback_summary: 'The opinions were on the price', ...body } });
  const approve = (member: number, planId: string, version: number, body: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> =>
    call('POST', `/compensation-plans/${planId}/approve`, { member, ifMatch: `"${version}"`, ...(tenantId === undefined ? {} : { tenantId }), body: { approved_on: TODAY, decision_document_version_id: world.cleanDocument, ...body } });
  const compensation = (aim: Target, basis: string): Record<string, unknown> => ({ household_id: aim.householdId, item_kind: 'COMPENSATION_ASSET', basis_inventory_id: basis, legal_basis: BASIS });

  /** A plan with a confirmed compensation, drafted by the planner: version 2. */
  async function drafted(member = PLANNER): Promise<{ id: string; aim: Target; basis: string }> {
    const aim = await target();
    const basis = await confirmed(aim);
    const id = (await draft(member)).json.resource_id as string;
    expect((await addItems(member, id, 1, [compensation(aim, basis)])).status).toBe(200);
    return { id, aim, basis };
  }
  /** The same plan as if it had been posted 40 days ago and its 30 days were over: the commands cannot be given a clock, so the days are put where they would be. */
  async function postedLongAgo(planId: string): Promise<void> {
    const [ruleRow] = await rows<{ id: string }>("select id from machvon.master_record_version where master_type = 'LND_TIMER' and code = 'PLAN_POSTING_30' order by revision desc limit 1");
    const started = TODAY;
    await rows(
      "update machvon.compensation_plan set status = 'POSTING', posting_started_on = ($2::date - 40), posting_ends_on = ($2::date - 10), posting_place_text = 'Commune office', timer_rule_version_id = $3::uuid, version = version + 1 where id = $1::uuid",
      [planId, started, ruleRow?.id],
    );
    await rows(
      `insert into machvon.land_deadline (tenant_id, id, project_id, subject_kind, subject_id, timer_code, days_applied, started_on, due_on, status, rule_version_id, version, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 'PLAN', $2::uuid, 'PLAN_POSTING_30', 30, $3::date - 40, $3::date - 10, 'RUNNING', $4::uuid, 1, $5::uuid, $5::uuid)`,
      [world.project, planId, started, ruleRow?.id, memberId(COUNTER)],
    );
    await rows('select * from machvon.advance_plan_subjects($1::uuid, $2::uuid)', [planId, memberId(COUNTER)]);
  }

  const audits = (resourceId: string, action: string) =>
    rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string; classification: string }>(
      'select safe_diff, outcome, actor_id, classification from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at',
      [resourceId, action],
    );
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);
  const planRow = async (id: string) =>
    (
      await rows<Record<string, unknown>>(
        `select status, version::text as version, posting_started_on::text as started, posting_ends_on::text as ends, approved_on::text as approved_on, payment_due_on::text as payment_due, approved_by
           from machvon.compensation_plan where id = $1::uuid`,
        [id],
      )
    )[0];

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
    for (const n of [PLANNER, APPROVER, DEPARTMENT_PLANNER, PROJECT_PLANNER, READER, NOBODY, COUNTER, CHECKER, DRAFTER_APPROVER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_PLANNER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PLAN_WRITER', ['land.plan.write', 'land.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'LAND_READER', ['land.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'PLAN_APPROVER', ['land.plan.approve', 'land.read'], 40);
    await harness.seedRole(TENANT_A, 4, 'PLAN_BOTH', ['land.plan.write', 'land.plan.approve', 'land.read'], 50);
    await harness.seedRole(TENANT_B, 1, 'PLAN_WRITER', ['land.plan.write', 'land.plan.approve', 'land.read'], 30);
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, COUNTER, DEPARTMENT, ROOT);
    await seedLndWorld(harness.database.adminUrl, TENANT_B, FAMILY_B, B_PLANNER, DEPARTMENT, ROOT);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PLANNER, role: 1, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 3, kind: 'TENANT' },
      { n: 3, member: DEPARTMENT_PLANNER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 4, member: PROJECT_PLANNER, role: 1, kind: 'PROJECT', refs: [world.project] },
      { n: 5, member: READER, role: 2, kind: 'TENANT' },
      { n: 6, member: DRAFTER_APPROVER, role: 4, kind: 'TENANT' },
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
      controllers: [CompensationPlanController, CompensationPlanReadsController, CompensationPlanPostingController, CompensationPlanPostingReadsController],
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

  describe('postCompensationPlan', () => {
    it('AC-ST-LND-006-1, UAT-AC377: posts a draft for the days of the rule, audits it and tells the world with ids and dates only', async () => {
      const { id, aim } = await drafted();
      const done = await postPlan(PLANNER, id, 2);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'POSTING', resource_version: 3, resource_id: id });
      const ends = addCalendarDays(TODAY, 30);
      expect(await planRow(id)).toMatchObject({ status: 'POSTING', version: '3', started: TODAY, ends });
      const [deadline] = await rows<Record<string, unknown>>("select timer_code, days_applied, started_on::text as started_on, due_on::text as due_on, status from machvon.land_deadline where subject_id = $1::uuid", [id]);
      expect(deadline).toEqual({ timer_code: 'PLAN_POSTING_30', days_applied: 30, started_on: TODAY, due_on: ends, status: 'RUNNING' });
      const [audit] = await audits(id, 'lnd.plan_posted');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(PLANNER), classification: 'INTERNAL', safe_diff: { project_id: world.project, posting_started_on: TODAY, posting_ends_on: ends, days_applied: 30, parcels_moved: 1, households_moved: 1 } });
      const [event] = await events(id, 'lnd.plan.posted.v1');
      expect(event?.payload).toMatchObject({ plan_id: id, project_id: world.project, posting_started_on: TODAY, posting_ends_on: ends, days_applied: 30, version: 3, tenant_id: TENANT_A });
      expect(JSON.stringify([audit, event])).not.toContain(aim.householdId);
      expect(JSON.stringify([audit, event])).not.toContain(PLACE);
    });

    it('answers a repeated request with the first answer and posts once', async () => {
      const { id } = await drafted();
      const key = `key-${randomUUID()}`;
      const send = () => call('POST', `/compensation-plans/${id}/post`, { member: PLANNER, ifMatch: '"2"', key, body: { posting_started_on: TODAY, posting_place_text: PLACE } });
      const first = await send();
      const second = await send();
      expect(second.json).toEqual(first.json);
      expect(await rows('select 1 from machvon.land_deadline where subject_id = $1::uuid', [id])).toHaveLength(1);
    });

    it('wants its fields (422 VALIDATION_FAILED for a missing one, 400 for a field it does not know) and refuses what cannot be posted', async () => {
      const { id, basis } = await drafted();
      for (const missing of ['posting_started_on', 'posting_place_text']) {
        const refused = await postPlan(PLANNER, id, 2, { [missing]: undefined });
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', missing]);
      }
      const unknown = await postPlan(PLANNER, id, 2, { posting_ends_on: TODAY });
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const future = await postPlan(PLANNER, id, 2, { posting_started_on: addCalendarDays(TODAY, 3) });
      expect([future.status, future.json.code, future.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'posting_started_on']);
      const stale = await postPlan(PLANNER, id, 1);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const empty = (await draft(PLANNER)).json.resource_id as string;
      const none = await postPlan(PLANNER, empty, 1);
      expect([none.status, none.json.code]).toEqual([422, 'PLAN_HAS_NO_ITEMS']);
      await rows("update machvon.land_inventory_record set status = 'SUPERSEDED' where id = $1::uuid", [basis]);
      const moved = await postPlan(PLANNER, id, 2);
      expect([moved.status, moved.json.code, moved.json.detail]).toEqual([422, 'INVENTORY_NOT_CONFIRMED', 'items']);
      expect((await planRow(id))?.status).toBe('DRAFT');
    });

    it('is refused for a plan that is not a draft, and to whoever may not post: a reader, an approver, nobody, a project it does not reach, another tenant', async () => {
      const { id } = await drafted();
      expect((await postPlan(READER, id, 2)).status).toBe(403);
      expect((await postPlan(APPROVER, id, 2)).status).toBe(403);
      expect((await postPlan(NOBODY, id, 2)).status).toBe(403);
      expect((await postPlan(B_PLANNER, id, 2, {}, TENANT_B)).status).toBe(404);
      expect((await postPlan(PLANNER, randomUUID(), 1)).status).toBe(404);
      expect((await postPlan(PROJECT_PLANNER, id, 2)).status).toBe(200);
      const twice = await postPlan(PLANNER, id, 3);
      expect([twice.status, twice.json.code]).toEqual([409, 'PLAN_STATE_INVALID']);
    });
  });

  describe('recordPlanFeedback and handlePlanFeedback', () => {
    it('records the opinion of a household and of nobody on the list and handles each once, without a word of them in the trail or the events', async () => {
      const { id, aim } = await drafted();
      expect((await feedback(PLANNER, id)).json.code).toBe('PLAN_STATE_INVALID');
      await postPlan(PLANNER, id, 2);
      const household = await feedback(PLANNER, id, { household_id: aim.householdId, channel: 'IN_PERSON' });
      const stranger = await feedback(PLANNER, id, { channel: 'LETTER' });
      expect(household.status).toBe(200);
      expect(household.json).toMatchObject({ status: 'OPEN', resource_version: 1 });
      const feedbackId = household.json.resource_id as string;
      const [audit] = await audits(id, 'lnd.plan_feedback_recorded');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(PLANNER), classification: 'PERSONAL', safe_diff: { project_id: world.project, feedback_id: feedbackId, household_id: aim.householdId, channel: 'IN_PERSON' } });
      const [event] = await events(feedbackId, 'lnd.plan.feedback_recorded.v1');
      expect(event?.payload).toMatchObject({ plan_id: id, feedback_id: feedbackId, channel: 'IN_PERSON' });
      const done = await handle(PLANNER, id, feedbackId);
      expect(done.json).toMatchObject({ status: 'HANDLED', resource_version: 2, resource_id: feedbackId });
      const [handled] = await audits(id, 'lnd.plan_feedback_handled');
      expect(handled).toMatchObject({ classification: 'PERSONAL', safe_diff: { feedback_id: feedbackId, handled_on: TODAY, open_remaining: 1 } });
      const [handledEvent] = await events(feedbackId, 'lnd.plan.feedback_handled.v1');
      expect(handledEvent?.payload).toMatchObject({ feedback_id: feedbackId, open_remaining: 1 });
      expect(JSON.stringify([audit, event, handled, handledEvent])).not.toContain(WORDS);
      expect(JSON.stringify([audit, event, handled, handledEvent])).not.toContain('Explained');
      const again = await handle(PLANNER, id, feedbackId);
      expect([again.status, again.json.code]).toEqual([409, 'FEEDBACK_ALREADY_HANDLED']);
      expect(stranger.status).toBe(200);
    });

    it('wants its fields and a household the caller sees; the officer of the department sees its own, a grant on a project reaches no household', async () => {
      const { id, aim } = await drafted();
      await postPlan(PLANNER, id, 2);
      for (const missing of ['summary', 'channel']) {
        const refused = await feedback(PLANNER, id, { [missing]: undefined });
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', missing]);
      }
      const channel = await feedback(PLANNER, id, { channel: 'SMOKE' });
      expect([channel.status, channel.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const noNote = await handle(PLANNER, id, randomUUID(), { handling_note: undefined });
      expect([noNote.status, noNote.json.code, noNote.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'handling_note']);
      expect((await handle(PLANNER, id, randomUUID())).status).toBe(404);
      expect((await feedback(PLANNER, id, { household_id: randomUUID() })).status).toBe(404);
      expect((await feedback(DEPARTMENT_PLANNER, id, { household_id: aim.householdId })).status).toBe(200);
      expect((await feedback(DEPARTMENT_PLANNER, id)).status).toBe(200);
      const byProject = await feedback(PROJECT_PLANNER, id);
      expect([byProject.status, byProject.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await feedback(PROJECT_PLANNER, id, { household_id: aim.householdId })).status).toBe(404);
      expect((await feedback(READER, id)).status).toBe(403);
      expect((await feedback(APPROVER, id)).status).toBe(403);
      expect((await feedback(B_PLANNER, id, {}, TENANT_B)).status).toBe(404);
    });

    it('lists the opinions inside the units of the reader and by status, and shows a plan it does not reach as if it were not there', async () => {
      const { id, aim } = await drafted();
      await postPlan(PLANNER, id, 2);
      const first = (await feedback(PLANNER, id, { household_id: aim.householdId })).json.resource_id as string;
      await feedback(PLANNER, id, { summary: 'Second' });
      await handle(PLANNER, id, first);
      const all = await get(READER, `/compensation-plans/${id}/feedback`);
      expect(all.status).toBe(200);
      const list = all.json.items as Array<Record<string, unknown>>;
      expect(list.map((line) => [line.status, line.summary])).toEqual([
        ['HANDLED', WORDS],
        ['OPEN', 'Second'],
      ]);
      expect(list[0]).toMatchObject({ plan_id: id, household_id: aim.householdId, channel: 'MEETING', recorded_on: TODAY, handled_on: TODAY, handling_note: 'Explained at the meeting of the commune', version: 2 });
      expect(typeof all.json.as_of).toBe('string');
      expect(((await get(READER, `/compensation-plans/${id}/feedback?status=OPEN`)).json.items as unknown[]).length).toBe(1);
      expect((await get(READER, `/compensation-plans/${id}/feedback?status=LOST`)).status).toBe(422);
      expect(((await get(PROJECT_PLANNER, `/compensation-plans/${id}/feedback`)).json.items as unknown[]).length).toBe(0);
      expect((await get(NOBODY, `/compensation-plans/${id}/feedback`)).status).toBe(403);
      expect((await get(B_PLANNER, `/compensation-plans/${id}/feedback`, TENANT_B)).status).toBe(404);
      expect((await get(READER, `/compensation-plans/${randomUUID()}/feedback`)).status).toBe(404);
      expect(feedbackLineView({ id: 'a', planId: 'b', householdId: null, householdCode: null, ownerUnitId: 'c', channel: 'LETTER', summary: 'x', status: 'OPEN', recordedOn: TODAY, handledOn: null, handlingNote: null, version: 1 })).toEqual({
        id: 'a',
        plan_id: 'b',
        household_id: null,
        household_code: null,
        owner_unit_id: 'c',
        channel: 'LETTER',
        summary: 'x',
        status: 'OPEN',
        recorded_on: TODAY,
        handled_on: null,
        handling_note: null,
        version: 1,
      });
    });
  });

  describe('closePlanPosting and approveCompensationPlan', () => {
    it('AC-ST-LND-006-1, UAT-AC377: refuses to close a posting before the days are over, closes it after, and approves only when every opinion is handled and by someone other than the drafter', async () => {
      const { id } = await drafted();
      await postPlan(PLANNER, id, 2);
      const early = await close(PLANNER, id, 3);
      expect([early.status, early.json.code, early.json.detail]).toEqual([422, 'POSTING_PERIOD_NOT_ELAPSED', 'posting_ends_on']);
      expect((await planRow(id))?.status).toBe('POSTING');
      // The 30 days of the posting are over (the commands cannot be given a clock, so the plan is put where it would be).
      const later = await drafted();
      const after = later.id;
      await postedLongAgo(after);
      const opinion = (await feedback(PLANNER, after, { household_id: later.aim.householdId })).json.resource_id as string;
      const second = (await feedback(PLANNER, after)).json.resource_id as string;
      const closed = await close(PLANNER, after, 3);
      expect(closed.status).toBe(200);
      expect(closed.json).toMatchObject({ status: 'POSTING_CLOSED', resource_version: 4 });
      const [audit] = await audits(after, 'lnd.plan_posting_closed');
      expect(audit).toMatchObject({ classification: 'INTERNAL', safe_diff: { project_id: world.project, closed_on: TODAY, feedback_open: 2, feedback_handled: 0 } });
      const [event] = await events(after, 'lnd.plan.posting_closed.v1');
      expect(event?.payload).toMatchObject({ plan_id: after, closed_on: TODAY, feedback_open: 2, version: 4 });
      expect((await rows<{ status: string; satisfied_on: string | null }>("select status, satisfied_on::text as satisfied_on from machvon.land_deadline where subject_id = $1::uuid", [after]))[0]).toEqual({ status: 'SATISFIED', satisfied_on: TODAY });
      const twice = await close(PLANNER, after, 4);
      expect([twice.status, twice.json.code]).toEqual([409, 'PLAN_STATE_INVALID']);
      // Approval waits for the opinions, whoever approves.
      const open = await approve(APPROVER, after, 4);
      expect([open.status, open.json.code, open.json.detail]).toEqual([422, 'UNRESOLVED_FEEDBACK', 'feedback']);
      await handle(PLANNER, after, opinion);
      await handle(PLANNER, after, second);
      const approved = await approve(APPROVER, after, 4);
      expect(approved.status).toBe(200);
      expect(approved.json).toMatchObject({ status: 'APPROVED', resource_version: 5, resource_id: after });
      expect(await planRow(after)).toMatchObject({ status: 'APPROVED', approved_on: TODAY, payment_due: addCalendarDays(TODAY, 30), approved_by: memberId(APPROVER) });
      const [approval] = await audits(after, 'lnd.plan_approved');
      expect(approval).toMatchObject({ actor_id: memberId(APPROVER), classification: 'INTERNAL', safe_diff: { project_id: world.project, approved_on: TODAY, payment_due_on: addCalendarDays(TODAY, 30), payment_days: 30, decision_document_version_id: world.cleanDocument, parcels_moved: 1 } });
      const [approvedEvent] = await events(after, 'lnd.plan.approved.v1');
      expect(approvedEvent?.payload).toMatchObject({ plan_id: after, approved_on: TODAY, payment_due_on: addCalendarDays(TODAY, 30), decision_document_version_id: world.cleanDocument, version: 5 });
      expect((await rows<{ status: string }>('select status from machvon.land_parcel where id = $1::uuid', [later.aim.parcelId]))[0]?.status).toBe('PLAN_APPROVED');
    });

    it('UAT-AC377 step 5: approves nothing that is not closed, and refuses the drafter, whoever may not approve, a decision that is missing or not clean and a day that has not come', async () => {
      const { id } = await drafted(DRAFTER_APPROVER);
      const draftState = await approve(APPROVER, id, 2);
      expect([draftState.status, draftState.json.code]).toEqual([409, 'PLAN_STATE_INVALID']);
      await postedLongAgo(id);
      const stillPosting = await approve(APPROVER, id, 3);
      expect([stillPosting.status, stillPosting.json.code]).toEqual([409, 'PLAN_STATE_INVALID']);
      expect((await close(DRAFTER_APPROVER, id, 3)).status).toBe(200);
      const own = await approve(DRAFTER_APPROVER, id, 4);
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const missing = await approve(APPROVER, id, 4, { decision_document_version_id: undefined });
      expect([missing.status, missing.json.code, missing.json.detail]).toEqual([422, 'DECISION_DOCUMENT_REQUIRED', 'decision_document_version_id']);
      const unknown = await approve(APPROVER, id, 4, { decision_document_version_id: randomUUID() });
      expect([unknown.status, unknown.json.code]).toEqual([422, 'DECISION_DOCUMENT_REQUIRED']);
      const pending = await approve(APPROVER, id, 4, { decision_document_version_id: world.pendingDocument });
      expect([pending.status, pending.json.code]).toEqual([422, 'DOCUMENT_NOT_CLEAN']);
      const tomorrow = await approve(APPROVER, id, 4, { approved_on: addCalendarDays(TODAY, 1) });
      expect([tomorrow.status, tomorrow.json.code, tomorrow.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'approved_on']);
      const early = await approve(APPROVER, id, 4, { approved_on: daysAgo(11) });
      expect([early.status, early.json.code]).toEqual([422, 'POSTING_PERIOD_NOT_ELAPSED']);
      const stale = await approve(APPROVER, id, 3);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await approve(PLANNER, id, 4)).status).toBe(403);
      expect((await approve(READER, id, 4)).status).toBe(403);
      expect((await approve(NOBODY, id, 4)).status).toBe(403);
      expect((await approve(B_PLANNER, id, 4, {}, TENANT_B)).status).toBe(404);
      expect((await approve(APPROVER, randomUUID(), 1)).status).toBe(404);
      expect((await planRow(id))?.status).toBe('POSTING_CLOSED');
    });
  });

  describe('getCompensationPlanTimers', () => {
    it('reads the timers of a plan with what is left of each and the opinions counted, for whoever reads the project', async () => {
      const { id } = await drafted();
      const draftTimers = await get(READER, `/compensation-plans/${id}/timers`);
      expect(draftTimers.json).toMatchObject({ plan_id: id, status: 'DRAFT', posting_ends_on: null, payment_remaining_days: null, feedback_open: 0, feedback_handled: 0, deadlines: [] });
      await postPlan(PLANNER, id, 2);
      await feedback(PLANNER, id);
      const timers = await get(PROJECT_PLANNER, `/compensation-plans/${id}/timers`);
      expect(timers.status).toBe(200);
      expect(timers.json).toMatchObject({ status: 'POSTING', posting_started_on: TODAY, posting_ends_on: addCalendarDays(TODAY, 30), feedback_open: 1, feedback_handled: 0 });
      const [deadline] = timers.json.deadlines as Array<Record<string, unknown>>;
      expect(deadline).toMatchObject({ timer_code: 'PLAN_POSTING_30', days_applied: 30, due_on: addCalendarDays(TODAY, 30), status: 'RUNNING', remaining_days: 30, awaiting_confirmation: true, cxn: 'CXN-12' });
      expect(typeof timers.json.as_of).toBe('string');
      expect((await get(NOBODY, `/compensation-plans/${id}/timers`)).status).toBe(403);
      expect((await get(B_PLANNER, `/compensation-plans/${id}/timers`, TENANT_B)).status).toBe(404);
      expect((await get(READER, `/compensation-plans/${randomUUID()}/timers`)).status).toBe(404);
    });

    it('counts a timer that has passed as negative and one that is over as none', () => {
      const base = { planId: 'p', projectId: 'q', status: 'APPROVED' as const, postingStartedOn: '2026-08-01', postingEndsOn: '2026-08-31', approvedOn: '2026-09-01', paymentDueOn: '2026-10-01', openFeedback: 0, handledFeedback: 2 };
      const line = (status: 'RUNNING' | 'SATISFIED', dueOn: string) => ({ id: 'd', timerCode: 'PLAN_POSTING_30' as const, daysApplied: 30, startedOn: '2026-08-01', dueOn, satisfiedOn: null, status, legalBasis: null, awaitingConfirmation: false, cxn: null });
      const view = planTimersView({ ...base, deadlines: [line('RUNNING', '2026-08-31'), line('SATISFIED', '2026-08-31')] }, '2026-09-02');
      expect(view).toMatchObject({ payment_remaining_days: 29, feedback_handled: 2 });
      expect((view.deadlines as Array<{ remaining_days: number | null }>).map((entry) => entry.remaining_days)).toEqual([-2, null]);
    });
  });
});

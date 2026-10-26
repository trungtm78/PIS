import { randomBytes, randomUUID } from 'node:crypto';
import { FieldCipher, addCalendarDays, staticKeyProvider, vietnamDateOf } from '@machvon/kernel';
import { LndHouseholdStore } from '../src/lnd-household-store';
import { LndInventoryStore } from '../src/lnd-inventory-store';
import { LndParcelStore } from '../src/lnd-parcel-store';
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
const cipher = new FieldCipher(staticKeyProvider(new Map([[1, randomBytes(32)]])));
const households = new LndHouseholdStore(cipher);
const parcels = new LndParcelStore();
const inventory = new LndInventoryStore();
const plans = new LndPlanStore();
const posting = new LndPlanPostingStore();
const masters = new MasterStore();
const OFFICER = 1;
const CHECKER = 2;
const APPROVER = 3;
const FAMILY = 0xbb;
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
/** The days of the posting are counted from the day the plan is posted, which cannot be before the plan was drafted: the real day, with a clock that the commands are given. */
const TODAY = vietnamDateOf(new Date());
const EVERYWHERE = '*';
const NOWHERE = '';
const DECISION = 'QD-GIA-2024';
const BASIS = 'Luật Đất đai 2024, Điều 91';
const PLACE = 'Trụ sở UBND xã Tân Hòa';

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
      { projectId: project, ownerUnitId: unitId(unit), headName: 'Nguyễn Văn A', nationalId: String(500000000000 + counter * 19), legalBasis: 'PUBLIC_TASK_LAND_LAW', legalBasisRef: BASIS, retentionUntil: '2036-12-31' },
      memberId(OFFICER),
      EVERYWHERE,
      TODAY,
    ),
  );
  const parcel = await as((tx) =>
    parcels.create(tx, { projectId: project, ownerUnitId: unitId(unit), parcelCode: `LP-Q-${String(counter).padStart(4, '0')}`, landUseGroup: 'AGRICULTURAL', areaTotalM2: '1000', areaAffectedM2: '500' }, memberId(OFFICER), TODAY),
  );
  await as((tx) => households.link(tx, registered.id, { parcelId: parcel.id, rightKind: 'OWNER' }, memberId(OFFICER), EVERYWHERE));
  return { householdId: registered.id, parcelId: parcel.id };
}

/** A record counted by the officer and confirmed by the checker. */
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
  await as(
    (tx) => inventory.confirm(tx, counted.id, { outcome: 'CONFIRMED', householdConfirmedOn: '2026-07-01' }, 1, memberId(CHECKER), EVERYWHERE, TODAY),
    CHECKER,
  );
  return counted.id;
}

const draft = (extra: Record<string, unknown> = {}) =>
  as((tx) => plans.draft(tx, { projectId: world.project, executorUnitId: unitId(DEPARTMENT), executorKind: 'LAND_FUND_CENTRE', planCode: `PP-${String(++counter).padStart(4, '0')}`, ...extra }, memberId(OFFICER)));
const add = (planId: string, items: NewPlanItem[], version = 1) => as((tx) => plans.addItems(tx, planId, items, version, memberId(OFFICER), EVERYWHERE));
const compensation = (aim: Target, basis: string): NewPlanItem => ({ householdId: aim.householdId, itemKind: 'COMPENSATION_ASSET', basisInventoryId: basis, legalBasis: BASIS });
const postIt = (planId: string, version: number, extra: { postingStartedOn?: string; postingPlaceText?: string } = {}, today = TODAY) =>
  as((tx) => posting.post(tx, { planId, expectedVersion: version, postingStartedOn: TODAY, postingPlaceText: PLACE, ...extra }, memberId(OFFICER), today));
const feedbackOf = (planId: string, input: { householdId?: string; summary?: string; channel?: string } = {}, units = EVERYWHERE, today = TODAY) =>
  as((tx) => posting.recordFeedback(tx, { planId, summary: 'The price is too low', channel: 'MEETING', ...input }, memberId(OFFICER), today, units));
const handle = (planId: string, feedbackId: string, note = 'Explained at the meeting of the commune', units = EVERYWHERE, today = TODAY) =>
  as((tx) => posting.handleFeedback(tx, { planId, feedbackId, handlingNote: note }, memberId(OFFICER), today, units));
const close = (planId: string, version: number, today: string, summary = 'Two opinions on the price') =>
  as((tx) => posting.closePosting(tx, { planId, expectedVersion: version, feedbackSummary: summary }, memberId(OFFICER), today));
const approve = (planId: string, version: number, extra: { approvedOn?: string; decisionDocumentVersionId?: string } = {}, today = TODAY, member = APPROVER) =>
  as((tx) => posting.approve(tx, { planId, expectedVersion: version, approvedOn: today, decisionDocumentVersionId: world.cleanDocument, ...extra }, memberId(member), today), member);
const planRow = async (planId: string) =>
  (
    await owner<Record<string, unknown>>(
      `select status, version::text as version, posting_started_on::text as started, posting_ends_on::text as ends, posting_place_text, timer_rule_version_id, feedback_summary, approved_on::text as approved_on,
              payment_due_on::text as payment_due, approved_by, decision_document_version_id from machvon.compensation_plan where id = $1::uuid`,
      [planId],
    )
  )[0];
const statusOf = async (table: 'land_parcel' | 'affected_household', id: string): Promise<string> => ((await owner<{ status: string }>(`select status from machvon.${table} where id = $1::uuid`, [id]))[0] as { status: string }).status;
const deadlineRows = (planId: string) =>
  owner<{ id: string; timer_code: string; days_applied: number; started_on: string; due_on: string; status: string; satisfied_on: string | null; rule_version_id: string }>(
    `select id, timer_code, days_applied, started_on::text as started_on, due_on::text as due_on, status, satisfied_on::text as satisfied_on, rule_version_id from machvon.land_deadline where subject_id = $1::uuid order by created_at`,
    [planId],
  );
const rule = (code: string) => owner<{ id: string }>("select id from machvon.master_record_version where master_type = 'LND_TIMER' and code = $1 order by revision desc limit 1", [code]);
const withoutRule = async (code: string, work: () => Promise<void>): Promise<void> => {
  await owner("update machvon.master_record_version set published_at = null where master_type = 'LND_TIMER' and code = $1", [code]);
  try {
    await work();
  } finally {
    await owner("update machvon.master_record_version set published_at = now() where master_type = 'LND_TIMER' and code = $1", [code]);
  }
};

/** A plan with one confirmed compensation, drafted and not yet posted: version 2. */
async function drafted(): Promise<{ id: string; aim: Target; basis: string }> {
  const aim = await target();
  const basis = await confirmed(aim);
  const plan = await draft();
  await add(plan.id, [compensation(aim, basis)]);
  return { id: plan.id, aim, basis };
}

describe('the posting of a plan, the opinions on it and its approval (ST-LND-006)', () => {
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

  describe('posting', () => {
    it('AC-ST-LND-006-1, UAT-AC377: posts a draft for the days of the rule, starts the timer by the version of the rule that decided the days, and moves the parcels and households of the plan on', async () => {
      const { id, aim } = await drafted();
      expect(await statusOf('land_parcel', aim.parcelId)).toBe('PLAN_DRAFTED');
      expect(await statusOf('affected_household', aim.householdId)).toBe('INVENTORIED');
      const done = await postIt(id, 2);
      const ends = addCalendarDays(TODAY, 30);
      const ruleId = (await rule('PLAN_POSTING_30'))[0]?.id;
      expect(done).toMatchObject({ planId: id, projectId: world.project, version: 3, postingStartedOn: TODAY, postingEndsOn: ends, daysApplied: 30, ruleVersionId: ruleId, parcelsMoved: 1, householdsMoved: 1 });
      expect(await planRow(id)).toMatchObject({ status: 'POSTING', version: '3', started: TODAY, ends, posting_place_text: PLACE, timer_rule_version_id: ruleId });
      expect(await deadlineRows(id)).toEqual([{ id: done.deadlineId, timer_code: 'PLAN_POSTING_30', days_applied: 30, started_on: TODAY, due_on: ends, status: 'RUNNING', satisfied_on: null, rule_version_id: ruleId }]);
      expect(await statusOf('land_parcel', aim.parcelId)).toBe('PLAN_POSTED');
      expect(await statusOf('affected_household', aim.householdId)).toBe('PLAN_LISTED');
    });

    it('leaves a parcel and a household that are somewhere else where they are', async () => {
      const { id, aim } = await drafted();
      await owner("update machvon.land_parcel set status = 'DISPUTED' where id = $1::uuid", [aim.parcelId]);
      await owner("update machvon.affected_household set status = 'DISPUTED' where id = $1::uuid", [aim.householdId]);
      expect(await postIt(id, 2)).toMatchObject({ parcelsMoved: 0, householdsMoved: 0 });
      expect(await statusOf('land_parcel', aim.parcelId)).toBe('DISPUTED');
      expect(await statusOf('affected_household', aim.householdId)).toBe('DISPUTED');
    });

    it('refuses a plan with nothing in it, a plan that is not a draft and a plan another call changed', async () => {
      const empty = await draft();
      expect(await refusal(postIt(empty.id, 1))).toEqual({ code: 'PLAN_HAS_NO_ITEMS', status: 422 });
      const { id } = await drafted();
      expect(await refusal(postIt(id, 1))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await postIt(id, 2);
      expect(await refusal(postIt(id, 3))).toEqual({ code: 'PLAN_STATE_INVALID', status: 409, detail: 'status', extensions: { status: 'POSTING' } });
      expect(await refusal(postIt(randomUUID(), 1))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(postIt('not-an-id', 1))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'plan_id' });
    });

    it('wants a start that has come and is not before the plan existed, and a place in words', async () => {
      const { id } = await drafted();
      expect(await refusal(postIt(id, 2, { postingStartedOn: addCalendarDays(TODAY, 1) }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'posting_started_on' });
      expect(await refusal(postIt(id, 2, { postingStartedOn: '2020-01-01' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'posting_started_on' });
      expect(await refusal(postIt(id, 2, { postingStartedOn: '2026-02-30' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'posting_started_on' });
      for (const postingPlaceText of ['', '   ', 'x'.repeat(2001)]) expect(await refusal(postIt(id, 2, { postingPlaceText }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'posting_place_text' });
      expect((await planRow(id))?.status).toBe('DRAFT');
    });

    it('UAT-AC382: refuses a plan whose compensation no longer rests on a confirmed record, whoever posts it', async () => {
      const { id, basis } = await drafted();
      await owner("update machvon.land_inventory_record set status = 'SUPERSEDED' where id = $1::uuid", [basis]);
      expect(await refusal(postIt(id, 2))).toEqual({ code: 'INVENTORY_NOT_CONFIRMED', status: 422, detail: 'items', extensions: { status: 'SUPERSEDED' } });
      expect((await planRow(id))?.status).toBe('DRAFT');
    });

    it('does not post from a number it made up: no rule in force is 422 TIMER_RULE_UNCONFIRMED and the plan stays a draft', async () => {
      const { id } = await drafted();
      await withoutRule('PLAN_POSTING_30', async () => {
        expect(await refusal(postIt(id, 2))).toMatchObject({ code: 'TIMER_RULE_UNCONFIRMED', status: 422 });
      });
      expect((await planRow(id))?.status).toBe('DRAFT');
      expect(await deadlineRows(id)).toEqual([]);
    });
  });

  describe('opinions', () => {
    it('records an opinion of a household and one of nobody on the list while the plan is posted, each in the unit it came from', async () => {
      const { id, aim } = await drafted();
      expect(await refusal(feedbackOf(id))).toMatchObject({ code: 'PLAN_STATE_INVALID', status: 409, extensions: { status: 'DRAFT' } });
      await postIt(id, 2);
      const household = await feedbackOf(id, { householdId: aim.householdId, channel: 'IN_PERSON', summary: '  The area is wrong  ' });
      const stranger = await feedbackOf(id, { channel: 'LETTER' });
      expect(household).toMatchObject({ planId: id, projectId: world.project, householdId: aim.householdId, channel: 'IN_PERSON' });
      expect(stranger).toMatchObject({ householdId: null, channel: 'LETTER' });
      const rows = await owner<{ id: string; owner_unit_id: string; household_id: string | null; summary: string; status: string; recorded_on: string }>(
        'select id, owner_unit_id, household_id, summary, status, recorded_on::text as recorded_on from machvon.compensation_plan_feedback where plan_id = $1::uuid order by created_at',
        [id],
      );
      expect(rows).toEqual([
        { id: household.id, owner_unit_id: unitId(DEPARTMENT), household_id: aim.householdId, summary: 'The area is wrong', status: 'OPEN', recorded_on: TODAY },
        { id: stranger.id, owner_unit_id: unitId(DEPARTMENT), household_id: null, summary: 'The price is too low', status: 'OPEN', recorded_on: TODAY },
      ]);
    });

    it('wants a summary in words, a channel it knows and a household of the project that the caller sees', async () => {
      const { id, aim } = await drafted();
      await postIt(id, 2);
      for (const summary of ['', '   ', 'x'.repeat(2001)]) expect(await refusal(feedbackOf(id, { summary }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'summary' });
      expect(await refusal(feedbackOf(id, { channel: 'SMOKE' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'channel' });
      expect(await refusal(feedbackOf(id, { householdId: 'nobody' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'household_id' });
      expect(await refusal(feedbackOf(id, { householdId: randomUUID() }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404, detail: 'household_id' });
      // A household of another unit than the caller reaches is as if it did not exist; one of another project of the tenant does not belong on this plan.
      expect(await refusal(feedbackOf(id, { householdId: aim.householdId }, unitId(OTHER_BRANCH)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(feedbackOf(id, {}, NOWHERE))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(feedbackOf(id, {}, unitId(OTHER_BRANCH)))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect(await feedbackOf(id, {}, `${unitId(OTHER_BRANCH)},${unitId(DEPARTMENT)}`)).toMatchObject({ householdId: null });
      const elsewhere = await target(DEPARTMENT, world.otherProject);
      expect(await refusal(feedbackOf(id, { householdId: elsewhere.householdId }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'household_id' });
      expect(await owner('select 1 from machvon.compensation_plan_feedback where plan_id = $1::uuid', [id])).toHaveLength(1);
    });

    it('handles an opinion once with a note, and a handled opinion is final', async () => {
      const { id } = await drafted();
      await postIt(id, 2);
      const opinion = await feedbackOf(id);
      const done = await handle(id, opinion.id);
      expect(done).toEqual({ id: opinion.id, planId: id, projectId: world.project, handledOn: TODAY, openRemaining: 0 });
      expect((await owner('select status, handled_on::text as on, handling_note, handled_by from machvon.compensation_plan_feedback where id = $1::uuid', [opinion.id]))[0]).toEqual({
        status: 'HANDLED',
        on: TODAY,
        handling_note: 'Explained at the meeting of the commune',
        handled_by: memberId(OFFICER),
      });
      expect(await refusal(handle(id, opinion.id))).toEqual({ code: 'FEEDBACK_ALREADY_HANDLED', status: 409 });
      expect((await sqlState(owner("update machvon.compensation_plan_feedback set handling_note = 'Rewritten' where id = $1::uuid", [opinion.id]))).message).toContain('a handled opinion is final');
    });

    it('wants a note in words, an opinion of this plan inside the units of the caller, and a plan that is posted or whose posting is closed', async () => {
      const { id } = await drafted();
      const other = await drafted();
      await postIt(id, 2);
      await postIt(other.id, 2);
      const opinion = await feedbackOf(id);
      for (const note of ['', '  ', 'x'.repeat(2001)]) expect(await refusal(handle(id, opinion.id, note))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'handling_note' });
      expect(await refusal(handle(id, 'x'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'feedback_id' });
      expect(await refusal(handle(other.id, opinion.id))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(handle(id, opinion.id, 'Explained', unitId(OTHER_BRANCH)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await owner("update machvon.compensation_plan set status = 'CANCELLED' where id = $1::uuid", [id]);
      expect(await refusal(handle(id, opinion.id))).toMatchObject({ code: 'PLAN_STATE_INVALID', status: 409, extensions: { status: 'CANCELLED' } });
    });

    it('keeps the day of the opinion when the clock of the call is earlier than the day it was recorded', async () => {
      const { id } = await drafted();
      await postIt(id, 2);
      const opinion = await feedbackOf(id);
      expect((await handle(id, opinion.id, 'Explained', EVERYWHERE, vietnamDateOf(new Date(Date.now() - 24 * 60 * 60 * 1000)))).handledOn).toBe(TODAY);
    });

    it('lists the opinions inside the units of the caller, in the order they were recorded, and by status', async () => {
      const { id, aim } = await drafted();
      await postIt(id, 2);
      const first = await feedbackOf(id, { householdId: aim.householdId, summary: 'First' });
      const second = await feedbackOf(id, { summary: 'Second' });
      await handle(id, first.id);
      const all = await as((tx) => posting.feedback(tx, id, EVERYWHERE));
      expect(all.map((line) => [line.id, line.summary, line.status, line.householdId, line.householdCode === null])).toEqual([
        [first.id, 'First', 'HANDLED', aim.householdId, false],
        [second.id, 'Second', 'OPEN', null, true],
      ]);
      expect(all[0]).toMatchObject({ planId: id, ownerUnitId: unitId(DEPARTMENT), channel: 'MEETING', recordedOn: TODAY, handledOn: TODAY, handlingNote: 'Explained at the meeting of the commune', version: 2 });
      expect((await as((tx) => posting.feedback(tx, id, EVERYWHERE, 'OPEN'))).map((line) => line.id)).toEqual([second.id]);
      expect((await as((tx) => posting.feedback(tx, id, EVERYWHERE, 'HANDLED'))).map((line) => line.id)).toEqual([first.id]);
      expect(await as((tx) => posting.feedback(tx, id, NOWHERE))).toEqual([]);
      expect(await as((tx) => posting.feedback(tx, id, unitId(OTHER_BRANCH)))).toEqual([]);
      expect(await refusal(as((tx) => posting.feedback(tx, id, EVERYWHERE, 'LOST')))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'status' });
      expect(await refusal(as((tx) => posting.feedback(tx, 'x', EVERYWHERE)))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'plan_id' });
    });
  });

  describe('closing the posting and approving', () => {
    it('AC-ST-LND-006-1, UAT-AC377: does not close before the day the timer falls due, closes on it, and approves only when every opinion is handled', async () => {
      const { id, aim } = await drafted();
      await postIt(id, 2);
      const ends = addCalendarDays(TODAY, 30);
      const first = await feedbackOf(id, { householdId: aim.householdId });
      const second = await feedbackOf(id);
      expect(await refusal(close(id, 3, addCalendarDays(TODAY, 29)))).toEqual({ code: 'POSTING_PERIOD_NOT_ELAPSED', status: 422, detail: 'posting_ends_on', extensions: { posting_ends_on: ends } });
      expect((await planRow(id))?.status).toBe('POSTING');
      const closed = await close(id, 3, ends);
      expect(closed).toMatchObject({ planId: id, projectId: world.project, version: 4, closedOn: ends, postingEndsOn: ends, openFeedback: 2, handledFeedback: 0 });
      expect(await planRow(id)).toMatchObject({ status: 'POSTING_CLOSED', feedback_summary: 'Two opinions on the price' });
      expect(await deadlineRows(id)).toMatchObject([{ status: 'SATISFIED', satisfied_on: ends }]);
      // The posting is closed, the opinions are not: the approval waits for them, and handling is still possible.
      expect(await refusal(approve(id, 4, { approvedOn: ends }, ends))).toEqual({ code: 'UNRESOLVED_FEEDBACK', status: 422, detail: 'feedback', extensions: { open_count: 2 } });
      expect(await refusal(feedbackOf(id))).toMatchObject({ code: 'PLAN_STATE_INVALID', status: 409, extensions: { status: 'POSTING_CLOSED' } });
      await handle(id, first.id, 'Explained', EVERYWHERE, ends);
      expect(await refusal(approve(id, 4, { approvedOn: ends }, ends))).toMatchObject({ code: 'UNRESOLVED_FEEDBACK', extensions: { open_count: 1 } });
      expect((await handle(id, second.id, 'Explained', EVERYWHERE, ends)).openRemaining).toBe(0);
      const approved = await approve(id, 4, { approvedOn: ends }, ends);
      expect(approved).toMatchObject({ planId: id, projectId: world.project, version: 5, approvedOn: ends, paymentDueOn: addCalendarDays(ends, 30), decisionDocumentVersionId: world.cleanDocument, paymentDays: 30, parcelsMoved: 1 });
      expect(await planRow(id)).toMatchObject({ status: 'APPROVED', approved_on: ends, payment_due: addCalendarDays(ends, 30), approved_by: memberId(APPROVER), decision_document_version_id: world.cleanDocument });
      expect(await statusOf('land_parcel', aim.parcelId)).toBe('PLAN_APPROVED');
      expect(await statusOf('affected_household', aim.householdId)).toBe('PLAN_LISTED');
    });

    it('closes with a summary in words and only a posted plan, under the version the caller saw', async () => {
      const { id } = await drafted();
      expect(await refusal(close(id, 2, TODAY))).toMatchObject({ code: 'PLAN_STATE_INVALID', status: 409, extensions: { status: 'DRAFT' } });
      await postIt(id, 2);
      const ends = addCalendarDays(TODAY, 30);
      for (const summary of ['', '  ', 'x'.repeat(2001)]) expect(await refusal(close(id, 3, ends, summary))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'feedback_summary' });
      expect(await refusal(close(id, 2, ends))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await owner("update machvon.land_deadline set status = 'CANCELLED' where subject_id = $1::uuid", [id]);
      expect(await refusal(close(id, 3, ends))).toMatchObject({ code: 'PLAN_STATE_INVALID', status: 409 });
    });

    it('UAT-AC377 step 5: refuses to approve a plan that is a draft or is still posted, whoever asks', async () => {
      const { id } = await drafted();
      expect(await refusal(approve(id, 2))).toMatchObject({ code: 'PLAN_STATE_INVALID', status: 409, extensions: { status: 'DRAFT' } });
      await postIt(id, 2);
      expect(await refusal(approve(id, 3))).toMatchObject({ code: 'PLAN_STATE_INVALID', status: 409, extensions: { status: 'POSTING' } });
    });

    it('is approved by someone other than the drafter, on a day that has come and is not before the posting ended, with a decision document that was scanned clean', async () => {
      const { id } = await drafted();
      await postIt(id, 2);
      const ends = addCalendarDays(TODAY, 30);
      await close(id, 3, ends);
      expect(await refusal(approve(id, 4, { approvedOn: ends }, ends, OFFICER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(approve(id, 4, { approvedOn: addCalendarDays(ends, 1) }, ends))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'approved_on' });
      expect(await refusal(approve(id, 4, { approvedOn: addCalendarDays(TODAY, 29) }, ends))).toEqual({ code: 'POSTING_PERIOD_NOT_ELAPSED', status: 422, detail: 'approved_on', extensions: { posting_ends_on: ends } });
      expect(await refusal(approve(id, 4, { approvedOn: 'soon' }, ends))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'approved_on' });
      expect(await refusal(approve(id, 4, { decisionDocumentVersionId: randomUUID() }, ends))).toEqual({ code: 'DECISION_DOCUMENT_REQUIRED', status: 422, detail: 'decision_document_version_id' });
      expect(await refusal(approve(id, 4, { decisionDocumentVersionId: world.pendingDocument }, ends))).toEqual({ code: 'DOCUMENT_NOT_CLEAN', status: 422, detail: 'decision_document_version_id' });
      expect(await refusal(approve(id, 4, { decisionDocumentVersionId: 'x' }, ends))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_document_version_id' });
      expect(await refusal(approve(id, 3, {}, ends))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect((await planRow(id))?.status).toBe('POSTING_CLOSED');
    });

    it('does not approve a plan that rests on a record which stopped being confirmed during the posting, and does not pay days from a rule that is not in force', async () => {
      const { id, basis } = await drafted();
      await postIt(id, 2);
      const ends = addCalendarDays(TODAY, 30);
      await close(id, 3, ends);
      await owner("update machvon.land_inventory_record set status = 'SUPERSEDED' where id = $1::uuid", [basis]);
      expect(await refusal(approve(id, 4, {}, ends))).toEqual({ code: 'INVENTORY_NOT_CONFIRMED', status: 422, detail: 'items', extensions: { status: 'SUPERSEDED' } });
      expect((await planRow(id))?.status).toBe('POSTING_CLOSED');
      const second = await drafted();
      await postIt(second.id, 2);
      await close(second.id, 3, ends);
      await withoutRule('PAYMENT_30', async () => {
        expect(await refusal(approve(second.id, 4, {}, ends))).toMatchObject({ code: 'TIMER_RULE_UNCONFIRMED', status: 422 });
      });
      expect((await planRow(second.id))?.status).toBe('POSTING_CLOSED');
    });
  });

  describe('timers', () => {
    it('reads the timers of a plan with the rule that counted them, and the opinions counted', async () => {
      const { id } = await drafted();
      expect(await as((tx) => posting.timersOf(tx, id))).toMatchObject({ planId: id, projectId: world.project, status: 'DRAFT', postingStartedOn: null, postingEndsOn: null, approvedOn: null, paymentDueOn: null, openFeedback: 0, handledFeedback: 0, deadlines: [] });
      const done = await postIt(id, 2);
      const opinion = await feedbackOf(id);
      await feedbackOf(id);
      await handle(id, opinion.id);
      const timers = await as((tx) => posting.timersOf(tx, id));
      expect(timers).toMatchObject({ status: 'POSTING', postingStartedOn: TODAY, postingEndsOn: addCalendarDays(TODAY, 30), openFeedback: 1, handledFeedback: 1 });
      expect(timers?.deadlines).toEqual([
        {
          id: done.deadlineId,
          timerCode: 'PLAN_POSTING_30',
          daysApplied: 30,
          startedOn: TODAY,
          dueOn: addCalendarDays(TODAY, 30),
          satisfiedOn: null,
          status: 'RUNNING',
          legalBasis: expect.stringContaining('Luật Đất đai 2024'),
          awaitingConfirmation: true,
          cxn: 'CXN-12',
        },
      ]);
      expect(await refusal(as((tx) => posting.timersOf(tx, randomUUID())))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => posting.timersOf(tx, 'x')))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'plan_id' });
    });
  });

  describe('what the database keeps whoever writes', () => {
    it('keeps a posting and an approval as they were given, and a plan that is not posted without a place and a rule', async () => {
      const { id } = await drafted();
      await postIt(id, 2);
      const update = (assignment: string, plan = id) => sqlState(owner(`update machvon.compensation_plan set ${assignment} where id = $1::uuid`, [plan]));
      expect((await update("posting_place_text = 'Elsewhere'")).message).toContain('a posting is not rewritten');
      expect((await update(`posting_ends_on = date '${addCalendarDays(TODAY, 3)}'`)).message).toContain('a posting is not rewritten');
      expect((await update("status = 'POSTING_CLOSED'")).message).toContain('a posting is closed with a summary of the opinions');
      const ends = addCalendarDays(TODAY, 30);
      await close(id, 3, ends);
      await approve(id, 4, {}, ends);
      expect((await update(`approved_on = date '${addCalendarDays(ends, 1)}'`)).message).toContain('an approval is not rewritten');
      expect((await update(`approved_by = '${memberId(CHECKER)}'`)).message).toContain('an approval is not rewritten');
      // A draft cannot be posted by the owner of the tables with nothing in it, and a posted plan names where and by which rule.
      const empty = await draft();
      expect((await update('status = \'POSTING\', posting_started_on = current_date, posting_ends_on = current_date + 30, posting_place_text = \'x\', timer_rule_version_id = gen_random_uuid()', empty.id)).message).toContain('PLAN_HAS_NO_ITEMS');
      const filled = await drafted();
      expect((await update("status = 'POSTING', posting_started_on = current_date, posting_ends_on = current_date + 30", filled.id)).message).toContain('compensation_plan_posting_facts_chk');
    });

    it('refuses an approval by the drafter or without an approver, as a constraint', async () => {
      const { id } = await drafted();
      await postIt(id, 2);
      const ends = addCalendarDays(TODAY, 30);
      await close(id, 3, ends);
      const approveAs = (member: number | null) =>
        sqlState(
          owner(
            `update machvon.compensation_plan set status = 'APPROVED', approved_on = date '${ends}', payment_due_on = date '${addCalendarDays(ends, 30)}', decision_document_version_id = $2::uuid, approved_by = $3::uuid where id = $1::uuid`,
            [id, world.cleanDocument, member === null ? null : memberId(member)],
          ),
        );
      expect((await approveAs(OFFICER)).message).toContain('compensation_plan_approver_chk');
      expect((await approveAs(null)).message).toContain('compensation_plan_approver_chk');
      await owner(
        "update machvon.compensation_plan set status = 'APPROVED', approved_on = $2::date, payment_due_on = $2::date + 30, decision_document_version_id = $3::uuid, approved_by = $4::uuid where id = $1::uuid",
        [id, ends, world.cleanDocument, memberId(APPROVER)],
      );
      expect((await planRow(id))?.status).toBe('APPROVED');
    });

    it('records an opinion only on a posted plan, in the unit it came from, and never rewrites or deletes it', async () => {
      const { id, aim } = await drafted();
      const insert = (planId: string, household: string | null, unit: string) =>
        sqlState(
          owner(
            `insert into machvon.compensation_plan_feedback (tenant_id, id, plan_id, household_id, owner_unit_id, channel, summary, recorded_on, created_by, updated_by)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'MEETING', 'Words', current_date, $4::uuid, $4::uuid)`,
            [planId, household, unit, memberId(OFFICER)],
          ),
        );
      expect((await insert(id, null, unitId(DEPARTMENT))).message).toContain('an opinion is recorded while the plan is posted');
      await postIt(id, 2);
      expect((await insert(id, null, unitId(OTHER_BRANCH))).message).toContain('belongs to the unit that executes the plan');
      expect((await insert(id, aim.householdId, unitId(OTHER_BRANCH))).message).toContain('belongs to the unit and the project of its household');
      await owner(
        `insert into machvon.compensation_plan_feedback (tenant_id, id, plan_id, household_id, owner_unit_id, channel, summary, recorded_on, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, null, $2::uuid, 'MEETING', 'Words', current_date, $3::uuid, $3::uuid)`,
        [id, unitId(DEPARTMENT), memberId(OFFICER)],
      );
      const [row] = await owner<{ id: string }>('select id from machvon.compensation_plan_feedback where plan_id = $1::uuid', [id]);
      const update = (assignment: string) => sqlState(owner(`update machvon.compensation_plan_feedback set ${assignment} where id = $1::uuid`, [row?.id]));
      expect((await update("summary = 'Other words'")).message).toContain('what an opinion says is never changed');
      expect((await update("status = 'HANDLED'")).sqlstate).toBe('23514');
      expect((await sqlState(as((tx) => tx.query('delete from machvon.compensation_plan_feedback where id = $1::uuid', [row?.id])))).message).toContain('permission denied');
    });

    it('shows an opinion only inside the unit it came from, while the counts and the checks of the plan do not depend on what the caller sees', async () => {
      const { id } = await drafted();
      await postIt(id, 2);
      await feedbackOf(id);
      expect(await owner('select 1 from machvon.compensation_plan_feedback where plan_id = $1::uuid', [id], unitId(DEPARTMENT))).toHaveLength(1);
      expect(await owner('select 1 from machvon.compensation_plan_feedback where plan_id = $1::uuid', [id], unitId(OTHER_BRANCH))).toHaveLength(0);
      expect(await owner('select 1 from machvon.compensation_plan_feedback where plan_id = $1::uuid', [id], NOWHERE)).toHaveLength(0);
      const counted = await owner<{ open_count: number; handled_count: number }>('select open_count, handled_count from machvon.plan_feedback_counts($1::uuid)', [id], NOWHERE);
      expect(counted).toEqual([{ open_count: 1, handled_count: 0 }]);
      expect(await owner('select machvon.plan_unconfirmed_inventory($1::uuid) as status', [id], NOWHERE)).toEqual([{ status: null }]);
    });

    it('answers for the tenant it acts as and for no other', async () => {
      const { id } = await drafted();
      const asOther = await harness.owner<{ open_count: number | null }>(TENANT_B, [['select open_count from machvon.plan_feedback_counts($1::uuid)', [id]]]);
      expect(asOther).toEqual([{ open_count: 0 }]);
      expect(await harness.owner(TENANT_B, [['select machvon.plan_unconfirmed_inventory($1::uuid) as status', [id]]])).toEqual([{ status: null }]);
      expect(await harness.owner(TENANT_B, [['select parcels_moved from machvon.advance_plan_subjects($1::uuid, $2::uuid)', [id, memberId(OFFICER)]]])).toEqual([{ parcels_moved: 0 }]);
    });
  });
});

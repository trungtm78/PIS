import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { PrjLessonsStore } from '../src/prj-lessons-store';
import { PrjLookAheadStore } from '../src/prj-look-ahead-store';
import { PrjProjectStore } from '../src/prj-project-store';
import { PrjStageStore } from '../src/prj-stage-store';
import type { ProjectObligationsPort } from '../src/prj-stage-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const projects = new PrjProjectStore();
const lookAheads = new PrjLookAheadStore();
const lessons = new PrjLessonsStore();
const ACTOR = 1;
const OTHER = 2;
const THIRD = 3;
const PROVINCE = 1;
const WORKER = '00000000-0000-4000-8000-000000000000';
const NOW = new Date('2026-11-09T03:00:00Z');
const TODAY = vietnamDateOf(NOW);

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = ACTOR, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

const sqlState = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? '';
  }
  throw new Error('expected the database to refuse');
};

let areaVersion = '';
let counter = 0;

async function seedArea(): Promise<string> {
  const recordId = randomUUID();
  const versionId = randomUUID();
  await harness.owner(TENANT_A, [
    [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'AREA-G11', 'EFFECTIVE', $3, $3)`, [TENANT_A, recordId, memberId(ACTOR)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, 'AREA', 'AREA-G11', 1, 'Area', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $3, now(), $4, $4)`,
      [TENANT_A, versionId, recordId, memberId(ACTOR)],
    ],
  ]);
  return versionId;
}

async function project(status: string): Promise<string> {
  counter += 1;
  const code = `G11-${counter}-${randomUUID().slice(0, 6)}`;
  const created = await as((tx) => projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(PROVINCE), areaMasterVersionId: areaVersion, totalInvestmentVnd: '500000000000' }, memberId(ACTOR), TODAY));
  await owner('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, status, 'B', String(8000000 + counter)]);
  return created.id;
}

const item = (over: Partial<{ description: string; plannedStart: string; plannedFinish: string; responsible: string | null }> = {}) => ({ description: 'Pour the slab of level two', plannedStart: '2026-11-10', plannedFinish: '2026-11-12', responsible: 'Crew A', ...over });
const plan = (projectId: string, over: Partial<{ weekStart: string; horizonWeeks: number; items: ReturnType<typeof item>[] }> = {}) =>
  as((tx) => lookAheads.create(tx, everything, { projectId, weekStart: over.weekStart ?? '2026-11-09', horizonWeeks: over.horizonWeeks ?? 3, items: over.items ?? [item(), item({ description: 'Fix the rebar of level three', plannedStart: '2026-11-16', plannedFinish: '2026-11-18' })], actor: memberId(ACTOR), now: NOW }));

describe('GOV-11a PRJ stores (G1-19): the look-ahead plan, the lessons learned and the closing gate', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: PROVINCE, path: '/u1/' }]);
      await harness.seedMembership(tenant, ACTOR, PROVINCE);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY));
    }
    await harness.seedMembership(TENANT_A, OTHER, PROVINCE);
    await harness.seedMembership(TENANT_A, THIRD, PROVINCE);
    areaVersion = await seedArea();
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the look-ahead plan', () => {
    it('makes a draft plan with its items for a Monday and a window within the rule, and refuses the others', async () => {
      const id = await project('IMPLEMENTATION');
      const made = await plan(id);
      expect(made).toMatchObject({ status: 'DRAFT', weekStart: '2026-11-09', horizonWeeks: 3, windowEnd: '2026-11-30', ppc: { band: 'NO_DATA' } });
      expect(made.items.map((each) => each.sequence)).toEqual([1, 2]);
      expect(made.items.every((each) => each.state === 'READY')).toBe(true);
      expect(await refusal(plan(id))).toMatchObject({ code: 'LOOK_AHEAD_PLAN_EXISTS', status: 409 });
      const other = await project('IMPLEMENTATION');
      expect(await refusal(plan(other, { horizonWeeks: 1 }))).toMatchObject({ code: 'LOOK_AHEAD_WINDOW_INVALID', status: 422 });
      expect(await refusal(plan(other, { horizonWeeks: 7 }))).toMatchObject({ code: 'LOOK_AHEAD_WINDOW_INVALID', status: 422 });
      expect(await refusal(plan(other, { weekStart: '2026-11-10' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'week_start' });
      expect(await refusal(plan(other, { items: [item({ plannedStart: '2026-12-30', plannedFinish: '2026-12-31' })] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'items[0].planned_start' });
      expect(await refusal(as((tx) => lookAheads.create(tx, nothing, { projectId: other, weekStart: '2026-11-09', horizonWeeks: 3, items: [item()], actor: memberId(ACTOR), now: NOW })))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('opens the plan of a week that has not begun by its id, and treats the plan of another project or outside the scope as not found', async () => {
      const id = await project('IMPLEMENTATION');
      const current = await plan(id);
      const future = await plan(id, { weekStart: '2026-11-16', items: [item({ plannedStart: '2026-11-17', plannedFinish: '2026-11-18' })] });
      expect((await as((tx) => lookAheads.view(tx, everything, id, NOW))).plan?.id).toBe(current.id);
      const asked = await as((tx) => lookAheads.view(tx, everything, id, NOW, future.id));
      expect(asked.plan).toMatchObject({ id: future.id, status: 'DRAFT', weekStart: '2026-11-16' });
      expect(asked.history.map((week) => week.id)).toEqual(expect.arrayContaining([current.id, future.id]));
      const foreign = await plan(await project('IMPLEMENTATION'));
      expect(await refusal(as((tx) => lookAheads.view(tx, everything, id, NOW, foreign.id)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => lookAheads.view(tx, nothing, id, NOW, future.id)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('publishes once under the version it was read at, and a published plan is not changed by the database', async () => {
      const made = await plan(await project('IMPLEMENTATION'));
      expect(await refusal(as((tx) => lookAheads.publish(tx, everything, { planId: made.id, expectedVersion: 99, actor: memberId(ACTOR), now: NOW })))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      const published = await as((tx) => lookAheads.publish(tx, everything, { planId: made.id, expectedVersion: made.version, actor: memberId(ACTOR), now: NOW }));
      expect(published).toMatchObject({ status: 'PUBLISHED', version: made.version + 1 });
      expect(await refusal(as((tx) => lookAheads.publish(tx, everything, { planId: made.id, expectedVersion: published.version, actor: memberId(ACTOR), now: NOW })))).toMatchObject({ code: 'LOOK_AHEAD_STATE_INVALID', status: 409 });
      expect(await sqlState(owner("update machvon.look_ahead_plan set horizon_weeks = 4 where id = $1::uuid", [made.id]))).toBe('23514');
      expect(await sqlState(owner('delete from machvon.look_ahead_plan where id = $1::uuid', [made.id]))).toBe('23514');
    });

    it('an item with an open constraint that starts within the lead days is not ready, one far away is only constrained, and clearing makes it ready (G1-19)', async () => {
      const id = await project('IMPLEMENTATION');
      const made = await plan(id, { items: [item(), item({ description: 'Install the lifts of the tower', plannedStart: '2026-11-30', plannedFinish: '2026-12-02' })], horizonWeeks: 4 });
      const published = await as((tx) => lookAheads.publish(tx, everything, { planId: made.id, expectedVersion: made.version, actor: memberId(ACTOR), now: NOW }));
      const [near, far] = published.items;
      const raised = await as((tx) => lookAheads.raiseConstraint(tx, everything, { itemId: (near as { id: string }).id, kind: 'MATERIAL', description: 'Rebar delivery is not confirmed', actor: memberId(ACTOR), now: NOW }));
      await as((tx) => lookAheads.raiseConstraint(tx, everything, { itemId: (far as { id: string }).id, kind: 'EQUIPMENT', description: 'The crane is booked elsewhere', actor: memberId(ACTOR), now: NOW }));
      expect(await refusal(as((tx) => lookAheads.raiseConstraint(tx, everything, { itemId: (near as { id: string }).id, kind: 'NOT_A_KIND', description: 'Something that is not listed', actor: memberId(ACTOR), now: NOW })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'kind' });
      const view = await as((tx) => lookAheads.view(tx, everything, id, NOW));
      expect(view.plan?.items.map((each) => each.state)).toEqual(['NOT_READY', 'CONSTRAINED']);
      const alerts = await as((tx) => lookAheads.notReady(tx, everything, NOW));
      expect(alerts.filter((row) => row.projectId === id).map((row) => row.itemId)).toEqual([(near as { id: string }).id]);
      const cleared = await as((tx) => lookAheads.clearConstraint(tx, everything, { constraintId: raised.constraintId, expectedVersion: 1, note: 'Delivery confirmed for Tuesday', actor: memberId(OTHER), now: NOW }));
      expect(cleared.constraintId).toBe(raised.constraintId);
      expect(await refusal(as((tx) => lookAheads.clearConstraint(tx, everything, { constraintId: raised.constraintId, expectedVersion: 2, note: undefined, actor: memberId(OTHER), now: NOW })))).toMatchObject({ code: 'LOOK_AHEAD_STATE_INVALID', status: 409 });
      expect(await sqlState(owner("update machvon.look_ahead_constraint set status = 'OPEN', cleared_by = null, cleared_at = null where id = $1::uuid", [raised.constraintId]))).toBe('23514');
      const after = await as((tx) => lookAheads.view(tx, everything, id, NOW));
      expect(after.plan?.items.map((each) => each.state)).toEqual(['READY', 'CONSTRAINED']);
    });

    it('records each item once, a not-done item with a standard reason, and the PPC of the week follows (G1-19)', async () => {
      const id = await project('IMPLEMENTATION');
      const made = await plan(id, { items: [item(), item({ description: 'Second item of the week' }), item({ description: 'Third item of the week' })] });
      expect(await refusal(as((tx) => lookAheads.recordOutcome(tx, everything, { itemId: made.items[0]!.id, expectedVersion: 1, outcome: 'DONE', reasonCode: undefined, actor: memberId(ACTOR), now: NOW })))).toMatchObject({ code: 'LOOK_AHEAD_STATE_INVALID', status: 409 });
      await as((tx) => lookAheads.publish(tx, everything, { planId: made.id, expectedVersion: made.version, actor: memberId(ACTOR), now: NOW }));
      const [first, second, third] = made.items;
      await as((tx) => lookAheads.recordOutcome(tx, everything, { itemId: (first as { id: string }).id, expectedVersion: 1, outcome: 'DONE', reasonCode: undefined, actor: memberId(ACTOR), now: NOW }));
      expect(await refusal(as((tx) => lookAheads.recordOutcome(tx, everything, { itemId: (second as { id: string }).id, expectedVersion: 1, outcome: 'NOT_DONE', reasonCode: undefined, actor: memberId(ACTOR), now: NOW })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason_code' });
      expect(await refusal(as((tx) => lookAheads.recordOutcome(tx, everything, { itemId: (second as { id: string }).id, expectedVersion: 1, outcome: 'NOT_DONE', reasonCode: 'NOT_A_REASON', actor: memberId(ACTOR), now: NOW })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason_code' });
      expect(await refusal(as((tx) => lookAheads.recordOutcome(tx, everything, { itemId: (first as { id: string }).id, expectedVersion: 2, outcome: 'NOT_DONE', reasonCode: 'WEATHER', actor: memberId(ACTOR), now: NOW })))).toMatchObject({ code: 'LOOK_AHEAD_STATE_INVALID', status: 409 });
      await as((tx) => lookAheads.recordOutcome(tx, everything, { itemId: (second as { id: string }).id, expectedVersion: 1, outcome: 'NOT_DONE', reasonCode: 'WEATHER', actor: memberId(ACTOR), now: NOW }));
      const view = await as((tx) => lookAheads.view(tx, everything, id, NOW));
      expect(view.plan?.ppc).toMatchObject({ committed: 2, done: 1, pct: '50.0', band: 'ALERT' });
      expect(view.plan?.items.map((each) => each.state)).toEqual(['DONE', 'NOT_DONE', 'READY']);
      expect(view.history[0]).toMatchObject({ weekStart: '2026-11-09', ppc: { pct: '50.0' } });
      expect(await sqlState(owner("update machvon.look_ahead_item set outcome = 'DONE', variance_reason_code = null where id = $1::uuid", [(second as { id: string }).id]))).toBe('23514');
      expect((third as { outcome: string }).outcome).toBe('PLANNED');
    });

    it('names a project in implementation whose newest plan is older than the cadence as missing, and one with a fresh plan as not', async () => {
      const stale = await project('IMPLEMENTATION');
      const fresh = await project('IMPLEMENTATION');
      for (const [target, weekStart] of [[stale, '2026-10-05'], [fresh, '2026-11-09']] as const) {
        const made = await plan(target, { weekStart, items: [item({ plannedStart: weekStart, plannedFinish: weekStart })] });
        await as((tx) => lookAheads.publish(tx, everything, { planId: made.id, expectedVersion: made.version, actor: memberId(ACTOR), now: NOW }));
      }
      const missing = (await as((tx) => lookAheads.missing(tx, everything, NOW))).map((row) => row.projectId);
      expect(missing).toContain(stale);
      expect(missing).not.toContain(fresh);
    });
  });

  describe('the lessons learned and the closing gate', () => {
    const draft = { category: 'PLANNING', title: 'Plan the site access earlier', situation: 'The access road was not ready when the crews arrived.', recommendation: 'Clear the site access before the contract starts.' };
    const noObligations: ProjectObligationsPort = { openObligations: async () => ({ committedVnd: '0', disbursedVnd: '0', activeReservations: 0 }) };
    const close = async (id: string) =>
      as((tx) => new PrjStageStore(undefined, noObligations).transition(tx, { command: 'closeProject', projectId: id, expectedVersion: 1, actor: memberId(ACTOR), scopes: { act: everything, read: everything }, input: { reason: 'Closing the project' }, today: TODAY }));

    it('refuses a lesson with a category that is not listed or too few words, and a proposer who decides their own lesson', async () => {
      const id = await project('SETTLED');
      expect(await refusal(as((tx) => lessons.propose(tx, everything, { projectId: id, draft: { ...draft, category: 'NOPE' }, actor: memberId(ACTOR), now: NOW })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'category' });
      expect(await refusal(as((tx) => lessons.propose(tx, everything, { projectId: id, draft: { ...draft, situation: 'Too short' }, actor: memberId(ACTOR), now: NOW })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'situation' });
      const lesson = await as((tx) => lessons.propose(tx, everything, { projectId: id, draft, actor: memberId(ACTOR), now: NOW }));
      expect(lesson).toMatchObject({ status: 'PROPOSED', version: 1 });
      expect(await refusal(as((tx) => lessons.decide(tx, everything, { id: lesson.id, expectedVersion: 1, decision: 'APPROVE', note: undefined, actor: memberId(ACTOR), now: NOW })))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(as((tx) => lessons.decide(tx, everything, { id: lesson.id, expectedVersion: 1, decision: 'REJECT', note: 'No', actor: memberId(OTHER), now: NOW }), OTHER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'note' });
      expect(await sqlState(owner("update machvon.lesson_learned set status = 'APPROVED', decided_by = proposed_by, decided_at = now() where id = $1::uuid", [lesson.id]))).toBe('23514');
    });

    it('refuses to close a project without an approved lesson or waiver (422 LESSONS_LEARNED_REQUIRED) and closes it once a second person approved a lesson', async () => {
      const id = await project('SETTLED');
      expect(await as((tx) => lessons.gate(tx, id, 'CLOSE', NOW))).toMatchObject({ met: false, reason: 'MISSING', required: 1, approved: 0 });
      expect(await refusal(close(id))).toEqual({ code: 'LESSONS_LEARNED_REQUIRED', status: 422, detail: 'MISSING' });
      const lesson = await as((tx) => lessons.propose(tx, everything, { projectId: id, draft, actor: memberId(ACTOR), now: NOW }));
      expect(await as((tx) => lessons.gate(tx, id, 'CLOSE', NOW))).toMatchObject({ met: false, reason: 'PENDING_REVIEW' });
      expect(await refusal(close(id))).toMatchObject({ code: 'LESSONS_LEARNED_REQUIRED', detail: 'PENDING_REVIEW' });
      const alerts = await as((tx) => lessons.missingAtClose(tx, everything, NOW));
      expect(alerts.find((row) => row.projectId === id)).toMatchObject({ required: 1, approved: 0 });
      const decided = await as((tx) => lessons.decide(tx, everything, { id: lesson.id, expectedVersion: 1, decision: 'APPROVE', note: undefined, actor: memberId(OTHER), now: NOW }), OTHER);
      expect(decided).toMatchObject({ status: 'APPROVED', decidedBy: memberId(OTHER), version: 2 });
      expect(await refusal(as((tx) => lessons.decide(tx, everything, { id: lesson.id, expectedVersion: 2, decision: 'REJECT', note: 'Changed my mind later', actor: memberId(THIRD), now: NOW }), THIRD))).toMatchObject({ code: 'LESSON_STATE_INVALID', status: 409 });
      expect(await as((tx) => lessons.gate(tx, id, 'CLOSE', NOW))).toMatchObject({ met: true, reason: 'APPROVED_LESSONS' });
      expect((await close(id)).to).toBe('CLOSED');
    });

    it('closes a project on a waiver that a second person approved, never on one that waits or was rejected, and one waiver at a time', async () => {
      const id = await project('SETTLED');
      const reason = 'The project was a short repair with nothing to carry over to later projects.';
      expect(await refusal(as((tx) => lessons.requestWaiver(tx, everything, { projectId: id, reason: 'Too short', actor: memberId(ACTOR), now: NOW })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      const waiver = await as((tx) => lessons.requestWaiver(tx, everything, { projectId: id, reason, actor: memberId(ACTOR), now: NOW }));
      expect(await refusal(as((tx) => lessons.requestWaiver(tx, everything, { projectId: id, reason, actor: memberId(OTHER), now: NOW }), OTHER))).toMatchObject({ code: 'LESSON_STATE_INVALID', status: 409 });
      expect(await as((tx) => lessons.gate(tx, id, 'CLOSE', NOW))).toMatchObject({ met: false, reason: 'WAIVER_PENDING' });
      expect(await refusal(close(id))).toMatchObject({ code: 'LESSONS_LEARNED_REQUIRED', detail: 'WAIVER_PENDING' });
      expect(await refusal(as((tx) => lessons.decideWaiver(tx, everything, { id: waiver.id, expectedVersion: 1, decision: 'APPROVE', note: undefined, actor: memberId(ACTOR), now: NOW })))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      const rejected = await as((tx) => lessons.decideWaiver(tx, everything, { id: waiver.id, expectedVersion: 1, decision: 'REJECT', note: 'There is something to learn here', actor: memberId(OTHER), now: NOW }), OTHER);
      expect(rejected.status).toBe('REJECTED');
      expect(await refusal(close(id))).toMatchObject({ code: 'LESSONS_LEARNED_REQUIRED', detail: 'MISSING' });
      const again = await as((tx) => lessons.requestWaiver(tx, everything, { projectId: id, reason, actor: memberId(ACTOR), now: NOW }));
      await as((tx) => lessons.decideWaiver(tx, everything, { id: again.id, expectedVersion: 1, decision: 'APPROVE', note: undefined, actor: memberId(OTHER), now: NOW }), OTHER);
      expect(await as((tx) => lessons.gate(tx, id, 'CLOSE', NOW))).toMatchObject({ met: true, reason: 'WAIVER_APPROVED' });
      expect((await close(id)).to).toBe('CLOSED');
    });

    it('does not show a project outside the scope of the caller, and keeps tenants apart', async () => {
      const id = await project('SETTLED');
      expect(await refusal(as((tx) => lessons.view(tx, nothing, id, NOW)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => lessons.propose(tx, nothing, { projectId: id, draft, actor: memberId(ACTOR), now: NOW })))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => lessons.view(tx, everything, id, NOW), ACTOR, TENANT_B))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => lookAheads.view(tx, everything, id, NOW), ACTOR, TENANT_B))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });
});

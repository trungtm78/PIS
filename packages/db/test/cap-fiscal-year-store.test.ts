import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import { CapAllocationExtensionStore } from '../src/cap-allocation-extension-store';
import { CapAvailabilityStore } from '../src/cap-availability-store';
import { CapFiscalYearStore } from '../src/cap-fiscal-year-store';
import { CapPlanApprovalStore } from '../src/cap-plan-approval-store';
import type { PlanAuthorizer } from '../src/cap-plan-approval-store';
import { CapPlanPublicationStore } from '../src/cap-plan-publication-store';
import { CapPlanRevisionStore } from '../src/cap-plan-revision-store';
import { CapPlanStore } from '../src/cap-plan-store';
import type { DraftScopes } from '../src/cap-plan-store';
import type { ScopeBuilder } from '../src/scope-version';
import { TENANT_A, TENANT_B, memberId, unitId } from './support/authz-fixtures';
import { APPROVER, CapWorld, MAKER, PUBLISHER, ROOT, money } from './support/cap-fixtures';
import type { PublishedLine } from './support/cap-fixtures';

const TODAY = vietnamDateOf(new Date());
const world = new CapWorld();
const years = new CapFiscalYearStore();
const publication = new CapPlanPublicationStore();
const approvals = new CapPlanApprovalStore();
const revisions = new CapPlanRevisionStore();
const plans = new CapPlanStore();
const extensions = new CapAllocationExtensionStore();
const availability = new CapAvailabilityStore();
const allow: PlanAuthorizer = () => undefined;
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const scopes: DraftScopes = { write: everything, read: { lines: everything, drafts: true } };
const LOCKER = 4; // a year-close officer
const OTHER_OFFICER = 5;
/** A year of the test with a free year after it: the years the tests close never serve as the next year of capital that another test carries over. */
const yearFor = (): number => {
  world.freshYear();
  return world.freshYear();
};
const REASON = 'The adjustment period of the year has ended';
const REOPEN_REASON = 'The audit found a mistake in the allocation of the year';
const NOW = new Date('2026-10-25T06:00:00Z');
const HOUR_MS = 3_600_000;

interface Refusal {
  code: string;
  status: number;
  detail?: string;
  extensions?: Record<string, unknown>;
}

async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
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

const close = (year: number, target: string, options: { member?: number; version?: number; reason?: string; now?: Date } = {}) =>
  world.as(async (tx) => years.close(tx, { year, target, reason: options.reason ?? REASON, closedBy: memberId(options.member ?? LOCKER), expectedVersion: options.version ?? (await years.find(tx, year)).version }, options.now ?? NOW), options.member ?? LOCKER);
const reopen = (year: number, options: { member?: number; version?: number; reason?: string; hours?: number; now?: Date } = {}) =>
  world.as(
    async (tx) => years.reopen(tx, { year, reason: options.reason ?? REOPEN_REASON, windowHours: options.hours ?? 24, reopenedBy: memberId(options.member ?? OTHER_OFFICER), expectedVersion: options.version ?? (await years.find(tx, year)).version }, options.now ?? NOW),
    options.member ?? OTHER_OFFICER,
  );
const rowOf = (year: number) => world.as((tx) => years.find(tx, year));
const versionOf = async (planId: string): Promise<number> => Number((await world.owner<{ version: string }>('select version::text as version from machvon.capital_plan where id = $1::uuid', [planId]))[0]?.version);
const newPlan = (year: number) =>
  world.as((tx) => plans.createPlan(tx, { planCode: `FY-${year}-${randomUUID().slice(0, 6)}`, planKind: 'ANNUAL', planYear: year, periodFromYear: year, periodToYear: year, scopeUnitId: unitId(ROOT) }, memberId(MAKER), allow));
const entriesOf = (refId: string) =>
  world.owner<{ entry_type: string; amount_vnd: string; allocation_line_id: string; source_ref_kind: string; plan_year: number; reason: string | null }>(
    'select entry_type, amount_vnd::text as amount_vnd, allocation_line_id, source_ref_kind, plan_year, reason from machvon.capital_ledger_entry where source_ref_id = $1::uuid order by allocation_line_id',
    [refId],
  );
const drift = () => world.as((tx) => publication.balanceDrift(tx));
const ask = (line: PublishedLine, amount: string) =>
  world.as((tx) => extensions.request(tx, { allocationLineId: line.lineId, amountVnd: amount, extendedTo: `${line.year + 1}-03-31`, reasonCode: 'GPMB_CHAM', requestedBy: memberId(MAKER) }, allow));

describe('CapFiscalYearStore (ST-CAP-008)', () => {
  beforeAll(async () => {
    await world.start();
    for (const member of [LOCKER, OTHER_OFFICER]) await world.harness.seedMembership(TENANT_A, member, ROOT);
  }, 180_000);
  afterAll(async () => {
    await world.stop();
  }, 60_000);

  describe('the state of a year', () => {
    it('is open with version 1 when the control does not know the year, and lists the years it knows, the latest first', async () => {
      const year = yearFor();
      expect(await rowOf(year)).toMatchObject({ year, status: 'OPEN', version: 1, lockedAt: null, reopenedUntil: null });
      await close(year, 'SOFT_CLOSED');
      const other = yearFor();
      await close(other, 'SOFT_CLOSED');
      const listed = await world.as((tx) => years.list(tx));
      expect(listed.map((row) => row.year).slice(0, 2)).toEqual([year, other].sort((a, b) => b - a));
      expect(await world.harness.tenants.withTenant({ tenantId: TENANT_B, membershipId: memberId(MAKER), scopeVersion: 1 }, (tx) => years.list(tx))).toEqual([]);
    });
  });

  describe('closeFiscalYear', () => {
    it('soft-closes an open year: the adjustment period, with who and why, version 2', async () => {
      const year = yearFor();
      const closed = await close(year, 'SOFT_CLOSED');
      expect(closed.previous).toBe('OPEN');
      expect(closed.lapse).toBeUndefined();
      expect(closed.row).toMatchObject({ year, status: 'SOFT_CLOSED', version: 2, softClosedBy: memberId(LOCKER), closeReason: REASON, lockedAt: null });
      expect(closed.row.softClosedAt).toBe(NOW.toISOString());
    });

    it('takes from a soft-closed year only what carries capital out of it: no plan, no appropriation, no commitment, no capital carried into it', async () => {
      const line = await world.publishedLine({ allocated: money(3), year: yearFor() });
      await close(line.year, 'SOFT_CLOSED');
      expect(await refusal(newPlan(line.year))).toMatchObject({ code: 'FISCAL_YEAR_LOCKED', status: 409, detail: 'plan_year', extensions: { state: 'SOFT_CLOSED' } });
      expect(await refusal(world.appropriation({ planYear: line.year }))).toMatchObject({ code: 'FISCAL_YEAR_LOCKED' });
      expect(
        await refusal(world.as((tx) => availability.checkAndCommit(tx, { allocationLineId: line.lineId, amountVnd: '1000', sourceKind: 'CONTRACT', sourceId: randomUUID(), acknowledgeWarning: false }, memberId(MAKER)))),
      ).toMatchObject({ code: 'FISCAL_YEAR_LOCKED', extensions: { state: 'SOFT_CLOSED' } });
      // Carrying capital out of the year is what the adjustment period is for.
      const asked = await ask(line, money(1));
      expect(asked.status).toBe('REQUESTED');
      // The next year, if it were soft-closed, would not take the capital.
      const next = await world.publishedLine({ allocated: money(2), year: yearFor() });
      await close(next.year + 1, 'SOFT_CLOSED');
      expect(await refusal(ask(next, money(1)))).toMatchObject({ code: 'FISCAL_YEAR_LOCKED' });
    });

    it('locks a year: what was not carried over lapses as LAPSE entries of one closing, the balances follow and the ledger agrees (AC-ST-CAP-008-1)', async () => {
      const first = await world.publishedLine({ allocated: money(3), year: yearFor() });
      await world.setFigures(first.balanceId, { committed: money(1), disbursed: '500000000' });
      const ended = await ask(first, money(1));
      const closed = await close(first.year, 'LOCKED');
      expect(closed.previous).toBe('OPEN');
      expect(closed.row).toMatchObject({ status: 'LOCKED', version: 2, lockedBy: memberId(LOCKER), closeReason: REASON });
      expect(closed.row.lockRefId).toBe(closed.lapse?.refId);
      // 3 billion allocated, 1 committed and 0.5 disbursed: 1.5 billion lapses and the committed and disbursed capital stays.
      expect(closed.lapse).toMatchObject({ lines: 1, totalVnd: '1500000000', extensionsLapsed: 1 });
      expect(await world.balanceOf(first.balanceId)).toMatchObject({ allocated: '1500000000', committed: money(1), disbursed: '500000000' });
      const entries = await entriesOf(closed.lapse?.refId ?? '');
      expect(entries).toEqual([{ entry_type: 'LAPSE', amount_vnd: '1500000000', allocation_line_id: first.lineId, source_ref_kind: 'YEAR_CLOSE', plan_year: first.year, reason: 'UNEXTENDED' }]);
      expect(await drift()).toEqual([]);
      // The request nobody decided can no longer be decided.
      expect((await world.owner<{ status: string }>('select status from machvon.allocation_extension where id = $1::uuid', [ended.id]))[0]?.status).toBe('LAPSED');
    });

    it('lapses nothing from a line that is used up, and nothing from the lines of another year', async () => {
      const used = await world.publishedLine({ allocated: money(2), year: yearFor() });
      await world.setFigures(used.balanceId, { committed: money(1), disbursed: money(1) });
      const bystander = await world.publishedLine({ allocated: money(2), year: yearFor() });
      const closed = await close(used.year, 'LOCKED');
      expect(closed.lapse).toMatchObject({ lines: 0, totalVnd: '0', extensionsLapsed: 0, entryIds: [] });
      expect(await world.balanceOf(used.balanceId)).toMatchObject({ allocated: money(2) });
      expect(await world.balanceOf(bystander.balanceId)).toMatchObject({ allocated: money(2) });
    });

    it('goes from soft-closed to locked, and is refused twice in the same state with 409 YEAR_STATE_INVALID', async () => {
      const line = await world.publishedLine({ allocated: money(2), year: yearFor() });
      await close(line.year, 'SOFT_CLOSED');
      expect(await refusal(close(line.year, 'SOFT_CLOSED'))).toMatchObject({ code: 'YEAR_STATE_INVALID', status: 409, extensions: { reason: 'ALREADY_SOFT_CLOSED' } });
      expect((await close(line.year, 'LOCKED')).row.status).toBe('LOCKED');
      expect(await refusal(close(line.year, 'LOCKED'))).toMatchObject({ code: 'YEAR_STATE_INVALID', extensions: { reason: 'ALREADY_LOCKED' } });
      expect(await refusal(close(line.year, 'SOFT_CLOSED'))).toMatchObject({ code: 'YEAR_STATE_INVALID', extensions: { reason: 'ALREADY_LOCKED' } });
    });

    it('refuses to close a year with a plan in review or approved and not yet published, naming the plans (AC-ST-CAP-008-2, UAT-PLAN-62)', async () => {
      const year = yearFor();
      const line = await world.publishedLine({ allocated: money(1), year });
      const draftPlan = await newPlan(year);
      await world.as(async (tx) =>
        plans.draft(tx, draftPlan.id, await versionOf(draftPlan.id), { lines: [{ projectId: line.projectId, appropriationId: line.appropriationId, bucket: 'CURRENT_YEAR', sourceYear: year, amountVnd: money(1) }], removeLineIds: [] }, memberId(MAKER), scopes, TODAY),
      );
      // A draft is not pending: nobody waits for it and it cannot be edited after the lock.
      expect((await close(year, 'SOFT_CLOSED')).row.status).toBe('SOFT_CLOSED');
      const reviewed = yearFor();
      const reviewedLine = await world.publishedLine({ allocated: money(1), year: reviewed });
      const other = await newPlan(reviewed);
      await world.as(async (tx) =>
        plans.draft(tx, other.id, await versionOf(other.id), { lines: [{ projectId: reviewedLine.projectId, appropriationId: reviewedLine.appropriationId, bucket: 'CURRENT_YEAR', sourceYear: reviewed, amountVnd: money(1) }], removeLineIds: [] }, memberId(MAKER), scopes, TODAY),
      );
      await world.as(async (tx) => approvals.submit(tx, other.id, await versionOf(other.id), memberId(MAKER), allow));
      expect(await refusal(close(reviewed, 'SOFT_CLOSED'))).toMatchObject({ code: 'YEAR_STATE_INVALID', status: 409, extensions: { reason: 'PLANS_PENDING', plan_ids: [other.id] } });
      expect(await refusal(close(reviewed, 'LOCKED'))).toMatchObject({ code: 'YEAR_STATE_INVALID', extensions: { reason: 'PLANS_PENDING' } });
      await world.as(async (tx) => approvals.decide(tx, other.id, await versionOf(other.id), 'approve', 'Reviewed against the decision', memberId(APPROVER), allow), APPROVER);
      // Approved and not published is as pending as in review: the lock would leave it stuck.
      expect(await refusal(close(reviewed, 'SOFT_CLOSED'))).toMatchObject({ code: 'YEAR_STATE_INVALID', extensions: { reason: 'PLANS_PENDING', plan_ids: [other.id] } });
      expect((await rowOf(reviewed)).status).toBe('OPEN');
    });

    it('refuses to lock a year while a reservation of it is active, and lets it be soft-closed', async () => {
      const line = await world.publishedLine({ allocated: money(2), year: yearFor() });
      const reservation = randomUUID();
      await world.owner(
        `insert into machvon.fund_reservation (tenant_id, id, allocation_line_id, project_id, purpose, amount_vnd, expires_at, status, created_by, updated_by)
         values ($1, $2, $3, $4, 'OTHER', 1000, now() + interval '30 days', 'ACTIVE', $5, $5)`,
        [TENANT_A, reservation, line.lineId, line.projectId, memberId(MAKER)],
      );
      expect((await close(line.year, 'SOFT_CLOSED')).row.status).toBe('SOFT_CLOSED');
      expect(await refusal(close(line.year, 'LOCKED'))).toMatchObject({ code: 'YEAR_STATE_INVALID', extensions: { reason: 'RESERVATIONS_ACTIVE', reservation_ids: [reservation] } });
      await world.owner("update machvon.fund_reservation set status = 'RELEASED', release_reason = 'done' where id = $1::uuid", [reservation]);
      expect((await close(line.year, 'LOCKED')).row.status).toBe('LOCKED');
    });

    it('answers 409 VERSION_CONFLICT to a stale version and 422 to a target or a reason that is not one', async () => {
      const year = yearFor();
      expect(await refusal(close(year, 'SOFT_CLOSED', { version: 9 }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 1 } });
      expect(await refusal(close(year, 'ARCHIVED'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'target_status' });
      expect(await refusal(close(year, 'LOCKED', { reason: 'no' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(close(1800, 'LOCKED'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'year' });
      expect((await rowOf(year)).status).toBe('OPEN');
    });
  });

  describe('a locked year (UAT-AC230)', () => {
    it('refuses the plan commands, the appropriations and the commitments of the year with 409 FISCAL_YEAR_LOCKED', async () => {
      const line = await world.publishedLine({ allocated: money(3), year: yearFor() });
      await close(line.year, 'LOCKED');
      expect(await refusal(newPlan(line.year))).toMatchObject({ code: 'FISCAL_YEAR_LOCKED', status: 409, extensions: { state: 'LOCKED' } });
      expect(await refusal(world.appropriation({ planYear: line.year }))).toMatchObject({ code: 'FISCAL_YEAR_LOCKED' });
      expect(await refusal(ask(line, money(1)))).toMatchObject({ code: 'FISCAL_YEAR_LOCKED' });
      expect(await refusal(world.as(async (tx) => revisions.create(tx, line.planId, await versionOf(line.planId), memberId(MAKER), allow)))).toMatchObject({ code: 'FISCAL_YEAR_LOCKED' });
    });
  });

  describe('reopenFiscalYear', () => {
    it('is refused to the person who locked the year with 403 SELF_APPROVAL_DENIED, and the year stays locked (AC-ST-CAP-008-1)', async () => {
      const year = yearFor();
      await close(year, 'LOCKED');
      expect(await refusal(reopen(year, { member: LOCKER }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await rowOf(year)).status).toBe('LOCKED');
    });

    it('opens the year for the window for another person, with the reason and the approver, and lets the plan commands in again', async () => {
      const line = await world.publishedLine({ allocated: money(2), year: yearFor() });
      await close(line.year, 'LOCKED');
      const opened = await reopen(line.year, { hours: 24 });
      expect(opened).toMatchObject({ status: 'OPEN', version: 3, lockedAt: null, reopenReason: REOPEN_REASON, reopenApprovedBy: memberId(OTHER_OFFICER) });
      expect(opened.reopenedAt).toBe(NOW.toISOString());
      expect(opened.reopenedUntil).toBe(new Date(NOW.getTime() + 24 * HOUR_MS).toISOString());
      expect((await newPlan(line.year)).status).toBe('DRAFT');
    });

    it('answers 422 REOPEN_REASON_REQUIRED to a reason under 20 characters, 422 to a window outside 1 to 168 hours, 409 to a stale version and 409 to a year that is not locked', async () => {
      const year = yearFor();
      expect(await refusal(reopen(year))).toMatchObject({ code: 'YEAR_STATE_INVALID', status: 409, extensions: { reason: 'NOT_LOCKED' } });
      await close(year, 'LOCKED');
      expect(await refusal(reopen(year, { reason: 'too short' }))).toMatchObject({ code: 'REOPEN_REASON_REQUIRED', status: 422, detail: 'reason' });
      for (const hours of [0, 169, 2.5]) expect(await refusal(reopen(year, { hours }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'window_hours' });
      expect(await refusal(reopen(year, { version: 9 }))).toMatchObject({ code: 'VERSION_CONFLICT', extensions: { current_version: 2 } });
      await reopen(year);
      expect(await refusal(reopen(year))).toMatchObject({ code: 'YEAR_STATE_INVALID', extensions: { reason: 'NOT_LOCKED' } });
      const soft = yearFor();
      await close(soft, 'SOFT_CLOSED');
      expect(await refusal(reopen(soft))).toMatchObject({ code: 'YEAR_STATE_INVALID' });
    });
  });

  describe('relockDue (the job every 15 minutes, UAT-AC230)', () => {
    it('locks the year again when the window ends, lapses what came back and leaves the years whose window has not ended', async () => {
      const line = await world.publishedLine({ allocated: money(2), year: yearFor() });
      const first = await close(line.year, 'LOCKED');
      expect(first.lapse?.totalVnd).toBe(money(2));
      await reopen(line.year, { hours: 24 });
      // During the window capital comes back to the line (a correction approved by the officers).
      await world.owner('update machvon.allocation_balance set allocated_vnd = $2::numeric where id = $1::uuid', [line.balanceId, money(1)]);
      await world.owner(
        `insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, posted_by)
         values ($1, gen_random_uuid(), $2, $3, $4, 'ALLOCATE', $5::numeric, $6, 'CAPITAL_PLAN', gen_random_uuid(), $7)`,
        [TENANT_A, line.appropriationId, line.lineId, line.projectId, money(1), line.year, memberId(MAKER)],
      );
      const before = new Date(NOW.getTime() + 23 * HOUR_MS);
      expect((await world.as((tx) => years.relockDue(tx, before, memberId(PUBLISHER)))).years).not.toContain(line.year);
      expect((await rowOf(line.year)).status).toBe('OPEN');
      const after = new Date(NOW.getTime() + 25 * HOUR_MS);
      const outcome = await world.as((tx) => years.relockDue(tx, after, memberId(PUBLISHER)));
      expect(outcome.years).toContain(line.year);
      const row = await rowOf(line.year);
      expect(row).toMatchObject({ status: 'LOCKED', lockedBy: memberId(PUBLISHER), closeReason: 'The window of the reopening ended' });
      expect(row.lockRefId).not.toBe(first.lapse?.refId);
      expect(await world.balanceOf(line.balanceId)).toMatchObject({ allocated: '0' });
      expect((await entriesOf(row.lockRefId ?? '')).map((entry) => entry.amount_vnd)).toEqual([money(1)]);
      expect(await drift()).toEqual([]);
      // Idempotent: a year that is locked is not touched.
      expect((await world.as((tx) => years.relockDue(tx, after, memberId(PUBLISHER)))).years).not.toContain(line.year);
    });
  });

  describe('the capital that lapsed stays off the line', () => {
    it('is not put back by a revision of the plan published in a reopened year: the line is judged against its amount less what lapsed', async () => {
      const line = await world.publishedLine({ allocated: money(3), year: 2030 });
      await world.setFigures(line.balanceId, { committed: money(1) });
      await close(line.year, 'LOCKED');
      await reopen(line.year, { hours: 24 });
      expect(await world.balanceOf(line.balanceId)).toMatchObject({ allocated: money(1), committed: money(1) });
      const revised = await world.as(async (tx) => revisions.create(tx, line.planId, await versionOf(line.planId), memberId(MAKER), allow));
      await world.as((tx) => approvals.submit(tx, revised.id, revised.version, memberId(MAKER), allow));
      await world.as(async (tx) => approvals.decide(tx, revised.id, await versionOf(revised.id), 'approve', 'Reviewed against the decision', memberId(APPROVER), allow), APPROVER);
      const decisionDocumentId = await world.document();
      const published = await world.as(async (tx) => publication.publish(tx, revised.id, await versionOf(revised.id), { decisionDocumentId, effectiveAt: undefined }, memberId(PUBLISHER), allow, TODAY), PUBLISHER);
      expect(published.ledger).toEqual([]);
      expect(await drift()).toEqual([]);
    });
  });

  describe('what the database guards (V1367)', () => {
    it('never removes a year or changes its number, and moves a year only along the closing', async () => {
      const year = yearFor();
      await close(year, 'SOFT_CLOSED');
      expect(await sqlState(world.owner('delete from machvon.fiscal_year_control where plan_year = $1::integer', [year]))).toBe('23514');
      expect(await sqlState(world.owner('update machvon.fiscal_year_control set plan_year = plan_year + 1 where plan_year = $1::integer', [year]))).toBe('23514');
      expect(await sqlState(world.owner("update machvon.fiscal_year_control set status = 'OPEN' where plan_year = $1::integer", [year]))).toBe('23514');
      await close(year, 'LOCKED');
      expect(await sqlState(world.owner("update machvon.fiscal_year_control set status = 'SOFT_CLOSED', soft_closed_at = now(), locked_at = null where plan_year = $1::integer", [year]))).toBe('23514');
    });

    it('opens a locked year only with a new reason, a window of at most a week, an approver other than the locker', async () => {
      const year = yearFor();
      await close(year, 'LOCKED');
      const reopenSql = (assignments: string) => world.owner(`update machvon.fiscal_year_control set status = 'OPEN', locked_at = null, ${assignments} where plan_year = $1::integer`, [year]);
      expect(await sqlState(world.owner("update machvon.fiscal_year_control set status = 'OPEN', locked_at = null where plan_year = $1::integer", [year]))).toBe('23514');
      expect(await sqlState(reopenSql(`reopen_reason = 'a reason of more than twenty letters', reopened_at = now(), reopened_until = now() + interval '170 hours', reopen_approved_by = '${memberId(OTHER_OFFICER)}'`))).toBe('23514');
      expect(await sqlState(reopenSql(`reopen_reason = 'short', reopened_at = now(), reopened_until = now() + interval '2 hours', reopen_approved_by = '${memberId(OTHER_OFFICER)}'`))).toBe('23514');
      expect(await sqlState(reopenSql(`reopen_reason = 'a reason of more than twenty letters', reopened_at = now(), reopened_until = now() + interval '2 hours', reopen_approved_by = '${memberId(LOCKER)}'`))).toBe('23514');
      expect(await sqlState(reopenSql(`reopen_reason = 'a reason of more than twenty letters', reopened_at = now(), reopened_until = now() + interval '2 hours'`))).toBe('23514');
      expect((await rowOf(year)).status).toBe('LOCKED');
    });

    it('lets a lapse name its line and its project', async () => {
      const line = await world.publishedLine({ allocated: money(1), year: yearFor() });
      expect(
        await sqlState(
          world.owner(
            `insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, posted_by)
             values ($1, gen_random_uuid(), $2, 'LAPSE', 1, $3, 'YEAR_CLOSE', gen_random_uuid(), $4)`,
            [TENANT_A, line.appropriationId, line.year, memberId(MAKER)],
          ),
        ),
      ).toBe('23514');
    });
  });
});

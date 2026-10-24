import { randomUUID } from 'node:crypto';
import { CollectingTelemetry } from '@machvon/kernel';
import { Client } from 'pg';
import { AuditWriter } from '../src/audit-writer';
import { DIS_PERIOD_REOPEN_METRIC, DisPeriodReopenStore, REOPEN_EXPIRY_REASON, reopenLabels, reopenRecord } from '../src/dis-period-reopen-store';
import type { ProjectPlace, ReopenRequest } from '../src/dis-period-reopen-store';
import { DisPeriodStore } from '../src/dis-period-store';
import type { PeriodRow } from '../src/dis-period-store';
import { DisReopenExpiry } from '../src/dis-reopen-expiry';
import { BASELINE_PACK, applyBaseline, sealPack } from '../src/master-baseline';
import type { BaselineEntry } from '../src/master-baseline';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const periods = new DisPeriodStore();
const reopens = new DisPeriodReopenStore(periods);
const MAKER = 1;
const APPROVER = 2;
const WORKER = '00000000-0000-4000-8000-000000000000';
const PROJECT_ONE = '00000000-0000-4000-8000-0000000000b1';
const PROJECT_TWO = '00000000-0000-4000-8000-0000000000b2';
const PROJECT_OF_B = '00000000-0000-4000-8000-0000000000b3';
const calendarEntry = BASELINE_PACK.entries.find((entry) => entry.masterType === 'CALENDAR') as BaselineEntry;
const at = (instant: string): Date => new Date(instant);
const HOUR = 3_600_000;

/** Week 39 is due 2026-09-25 03:00Z; the test locks it at 03:10 and every clock below is later than that. */
const LOCKED_AT = '2026-09-25T03:10:00Z';
const NOW = '2026-10-05T01:00:00.000Z';
const reach = (): boolean => true;

const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

const periodByCode = async (code: string, tenant = TENANT_A): Promise<PeriodRow> => {
  const [found] = await owner<{ id: string }>('select id from machvon.reporting_period where code = $1', [code], tenant);
  return (await as(MAKER, (tx) => periods.find(tx, (found as { id: string }).id), tenant)) as PeriodRow;
};

const reasonText = 'The Treasury returned the vouchers for a wrong source code';
const ask = (period: PeriodRow, overrides: Partial<ReopenRequest> = {}, now = NOW, mayReach: (place: ProjectPlace) => boolean = reach, tenant = TENANT_A) =>
  as(MAKER, (tx) => reopens.request(tx, { periodId: period.id, scopeKind: 'PROJECTS', projectIds: [PROJECT_ONE], reason: reasonText, windowHours: 72, ...overrides }, memberId(MAKER), at(now), mayReach), tenant);
const decide = (id: string, version: number, decision: Parameters<DisPeriodReopenStore['decide']>[3], member = APPROVER, now = NOW, tenant = TENANT_A) =>
  as(member, (tx) => reopens.decide(tx, id, version, decision, memberId(member), at(now)), tenant);
const judge = (period: PeriodRow, project: string, instant: string) => as(MAKER, (tx) => periods.judge(tx, period.id, project, at(instant)));
const clear = (): Promise<unknown> => harness.owner(TENANT_A, [['delete from machvon.period_reopen']]);

describe('DisPeriodReopenStore (the reasoned reopening of a locked period, ST-DIS-002)', () => {
  let week39: PeriodRow;
  let week40: PeriodRow;
  let week41: PeriodRow;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: `/${unitId(1)}/` },
        { n: 2, path: `/${unitId(1)}/${unitId(2)}/` },
      ]);
      for (const member of [MAKER, APPROVER]) await harness.seedMembership(tenant, member, 1);
    }
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, sealPack('DIS-REOPEN-A', [calendarEntry]), WORKER));
    await harness.tenants.withTenant({ tenantId: TENANT_B, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, sealPack('DIS-REOPEN-B', [calendarEntry]), WORKER));
    // The reference data a project points at (master versions) is not what is under test.
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await admin.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'P-A-001', 'Project one', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'), ($1, $5, 'P-A-002', 'Project two', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'),
                ($6, $7, 'P-B-001', 'Project of B', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT_ONE, unitId(2), randomUUID(), PROJECT_TWO, TENANT_B, PROJECT_OF_B],
      );
    } finally {
      await admin.end();
    }
    for (const tenant of [TENANT_A, TENANT_B]) {
      await as(MAKER, (tx) => periods.generate(tx, { calendarCode: 'DEFAULT', fiscalYear: 2026, periodType: 'WEEK' }, memberId(MAKER), at('2026-09-01T00:00:00Z')), tenant);
    }
    for (const code of ['W2026-39', 'W2026-40']) {
      const period = await periodByCode(code);
      await as(MAKER, (tx) => periods.softClose(tx, period.id, 1, memberId(MAKER), at(new Date(Date.parse(period.deadlineAt) + 5 * 60_000).toISOString())));
      await as(MAKER, (tx) => periods.lock(tx, period.id, 2, memberId(MAKER), at(new Date(Date.parse(period.deadlineAt) + 10 * 60_000).toISOString())));
    }
    week39 = await periodByCode('W2026-39');
    week40 = await periodByCode('W2026-40');
    week41 = await periodByCode('W2026-41');
    const lockedInB = await periodByCode('W2026-39', TENANT_B);
    await as(MAKER, (tx) => periods.softClose(tx, lockedInB.id, 1, memberId(MAKER), at('2026-09-25T03:05:00Z')), TENANT_B);
    await as(MAKER, (tx) => periods.lock(tx, lockedInB.id, 2, memberId(MAKER), at(LOCKED_AT)), TENANT_B);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  afterEach(clear);

  describe('the window of a reopening (AC-ST-DIS-002-1)', () => {
    it('opens P-A-001 only, for the hours the approver grants, and closes it on time whether or not the job has run (AC-ST-DIS-002-1)', async () => {
      const asked = await ask(week39);
      expect(asked.reopen).toMatchObject({ scopeKind: 'PROJECTS', status: 'REQUESTED', windowUntil: null, requestedWindowHours: 72, reason: reasonText, requestedBy: memberId(MAKER), approvedBy: null, version: 1 });
      expect(asked.reopen.projects).toEqual([{ id: PROJECT_ONE, code: 'P-A-001' }]);
      // Before the decision nothing is open: the period is locked for everyone.
      expect(await refusal(judge(week39, PROJECT_ONE, NOW))).toEqual({ code: 'PERIOD_LOCKED', status: 409 });

      // The requester may not decide; a stale version is a conflict; the right decision is made once.
      expect(await refusal(decide(asked.reopen.id, 1, { decision: 'approve', reason: 'Approved by myself' }, MAKER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(decide(asked.reopen.id, 9, { decision: 'approve', reason: 'Approved with a stale view' }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      const approved = await decide(asked.reopen.id, 1, { decision: 'approve', reason: 'The vouchers are documented', windowHours: 48 });
      expect(approved.reopen).toMatchObject({
        status: 'APPROVED',
        approvedBy: memberId(APPROVER),
        decidedBy: memberId(APPROVER),
        decidedAt: NOW,
        decisionReason: 'The vouchers are documented',
        windowUntil: new Date(Date.parse(NOW) + 48 * HOUR).toISOString(),
        version: 2,
      });
      // The period is not touched: it stays LOCKED with the version it had.
      expect(approved.period).toMatchObject({ status: 'LOCKED', version: 3 });

      const during = await judge(week39, PROJECT_ONE, new Date(Date.parse(NOW) + HOUR).toISOString());
      expect(during.reopen).toEqual({ id: asked.reopen.id, windowUntil: approved.reopen.windowUntil });
      expect(during.late).toBe(true);
      expect(await refusal(judge(week39, PROJECT_TWO, new Date(Date.parse(NOW) + HOUR).toISOString()))).toEqual({ code: 'PERIOD_LOCKED', status: 409 });
      expect(await refusal(judge(week40, PROJECT_ONE, new Date(Date.parse(NOW) + HOUR).toISOString()))).toEqual({ code: 'PERIOD_LOCKED', status: 409 });

      // At 49 hours the window is over: the guard and the read say so although the job has not stored it yet.
      const later = new Date(Date.parse(NOW) + 49 * HOUR);
      expect(await refusal(judge(week39, PROJECT_ONE, later.toISOString()))).toEqual({ code: 'PERIOD_LOCKED', status: 409 });
      expect((await as(MAKER, (tx) => periods.reopens(tx, [week39.id], later))).get(week39.id)?.[0]?.status).toBe('EXPIRED');
      expect((await owner<{ status: string }>('select status from machvon.period_reopen where id = $1', [asked.reopen.id]))[0]?.status).toBe('APPROVED');
      // On the last instant the window is still open; one millisecond later it is not.
      expect((await judge(week39, PROJECT_ONE, new Date(Date.parse(approved.reopen.windowUntil as string) - 1).toISOString())).reopen).not.toBeNull();
      expect(await refusal(judge(week39, PROJECT_ONE, approved.reopen.windowUntil as string))).toEqual({ code: 'PERIOD_LOCKED', status: 409 });
    });

    it('stores the expiry with the job, once, and leaves the trace of who asked, who approved and the window (AC-ST-DIS-002-1)', async () => {
      const asked = await ask(week39);
      const approved = await decide(asked.reopen.id, 1, { decision: 'approve', reason: 'The vouchers are documented', windowHours: 48 });
      const telemetry = new CollectingTelemetry();
      const job = new DisReopenExpiry(new AuditWriter(harness.tenants), { metrics: telemetry });
      const before = new Date(Date.parse(NOW) + 47 * HOUR);
      expect(await as(APPROVER, (tx) => job.run(tx, WORKER, before))).toEqual({ expired: 0 });
      const after = new Date(Date.parse(NOW) + 49 * HOUR);
      expect(await as(APPROVER, (tx) => job.run(tx, WORKER, after))).toEqual({ expired: 1 });
      expect(await as(APPROVER, (tx) => job.run(tx, WORKER, after))).toEqual({ expired: 0 });
      const [stored] = await owner<{ status: string; version: string; approved_by: string; window_until: Date }>('select status, version::text, approved_by, window_until from machvon.period_reopen where id = $1', [asked.reopen.id]);
      expect(stored).toMatchObject({ status: 'EXPIRED', version: '3', approved_by: memberId(APPROVER) });
      const audit = await owner<{ action: string; actor_id: string; reason: string; safe_diff: Record<string, unknown> }>(
        "select action, actor_id, reason, safe_diff from machvon.audit_event where resource_id = $1 and action = 'dis.period_reopen_expired'",
        [asked.reopen.id],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: WORKER, reason: REOPEN_EXPIRY_REASON });
      expect(audit[0]?.safe_diff).toMatchObject({
        period_code: 'W2026-39',
        scope_kind: 'PROJECTS',
        project_ids: [PROJECT_ONE],
        requested_by: memberId(MAKER),
        approved_by: memberId(APPROVER),
        requested_window_hours: 72,
        window_hours: 48,
        window_until: approved.reopen.windowUntil,
        status: 'EXPIRED',
        trigger: 'AUTO',
      });
      expect(telemetry.snapshot().counters).toEqual([{ name: DIS_PERIOD_REOPEN_METRIC, labels: reopenLabels('expired'), value: 1 }]);
      // Once stored, the state is final: nothing reopens an expired request.
      expect(await refusal(decide(asked.reopen.id, 3, { decision: 'approve', reason: 'Approved again by mistake' }))).toEqual({ code: 'PERIOD_STATE_INVALID', status: 409, detail: 'status' });
    });

    it('grants the hours that were asked for when the approver names none, and never longer than 168 hours', async () => {
      const asked = await ask(week39, { windowHours: 6 });
      const approved = await decide(asked.reopen.id, 1, { decision: 'approve', reason: 'Granted as asked' });
      expect(Date.parse(approved.reopen.windowUntil as string) - Date.parse(NOW)).toBe(6 * HOUR);
      const long = await ask(week40, { windowHours: 168 });
      expect(await refusal(decide(long.reopen.id, 1, { decision: 'approve', reason: 'Granted too long', windowHours: 169 }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'window_hours' });
      expect(await refusal(decide(long.reopen.id, 1, { decision: 'approve', reason: 'Granted none at all', windowHours: 0 }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'window_hours' });
      const widest = await decide(long.reopen.id, 1, { decision: 'approve', reason: 'Granted at the limit', windowHours: 168 });
      expect(Date.parse(widest.reopen.windowUntil as string) - Date.parse(NOW)).toBe(168 * HOUR);
    });

    it('covers every project of the period for a request for the whole period, and only inside its own period', async () => {
      const asked = await ask(week39, { scopeKind: 'PERIOD', projectIds: [] });
      expect(asked.reopen.projects).toEqual([]);
      await decide(asked.reopen.id, 1, { decision: 'approve', reason: 'The whole week is reopened', windowHours: 24 });
      const inside = new Date(Date.parse(NOW) + HOUR).toISOString();
      expect((await judge(week39, PROJECT_ONE, inside)).reopen?.id).toBe(asked.reopen.id);
      expect((await judge(week39, PROJECT_TWO, inside)).reopen?.id).toBe(asked.reopen.id);
      expect((await judge(week39, randomUUID(), inside)).reopen?.id).toBe(asked.reopen.id);
      expect(await refusal(judge(week40, PROJECT_ONE, inside))).toEqual({ code: 'PERIOD_LOCKED', status: 409 });
    });

    it('lets the latest ending window decide when several cover a project, and ignores a window that began after the instant', async () => {
      const first = await ask(week39, { projectIds: [PROJECT_ONE, PROJECT_TWO] });
      const second = await ask(week39, { projectIds: [PROJECT_ONE] });
      const shorter = await decide(first.reopen.id, 1, { decision: 'approve', reason: 'Granted for a day', windowHours: 24 });
      const longer = await decide(second.reopen.id, 1, { decision: 'approve', reason: 'Granted for three days', windowHours: 72 });
      const inside = new Date(Date.parse(NOW) + HOUR).toISOString();
      expect((await judge(week39, PROJECT_ONE, inside)).reopen?.id).toBe(longer.reopen.id);
      expect((await judge(week39, PROJECT_TWO, inside)).reopen?.id).toBe(shorter.reopen.id);
      // A clock that reads before the decision does not see the window.
      expect(await refusal(judge(week39, PROJECT_ONE, new Date(Date.parse(NOW) - HOUR).toISOString()))).toEqual({ code: 'PERIOD_LOCKED', status: 409 });
    });

    it('never changes the period and takes reports as usual in a period that is not locked', async () => {
      const asked = await ask(week39);
      await decide(asked.reopen.id, 1, { decision: 'approve', reason: 'The vouchers are documented', windowHours: 24 });
      const after = await periodByCode('W2026-39');
      expect(after).toMatchObject({ status: 'LOCKED', version: week39.version, lockedAt: week39.lockedAt, lockedBy: week39.lockedBy });
      expect((await judge(week41, PROJECT_TWO, NOW)).reopen).toBeNull();
    });
  });

  describe('a request', () => {
    it('is refused without a reason of 20 characters, for a window out of range and for a scope that does not fit', async () => {
      expect(await refusal(ask(week39, { reason: 'sai' }))).toEqual({ code: 'REOPEN_REASON_REQUIRED', status: 422, detail: 'reason' });
      expect(await refusal(ask(week39, { reason: `  ${'x'.repeat(19)}  ` }))).toEqual({ code: 'REOPEN_REASON_REQUIRED', status: 422, detail: 'reason' });
      expect(await refusal(ask(week39, { reason: 'x'.repeat(2001) }))).toEqual({ code: 'REOPEN_REASON_REQUIRED', status: 422, detail: 'reason' });
      for (const windowHours of [0, 169, 1.5]) expect(await refusal(ask(week39, { windowHours }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'window_hours' });
      expect(await refusal(ask(week39, { scopeKind: 'PERIOD', projectIds: [PROJECT_ONE] }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'project_ids' });
      expect(await refusal(ask(week39, { scopeKind: 'PROJECTS', projectIds: [] }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'project_ids' });
      expect(await refusal(ask(week39, { projectIds: Array.from({ length: 501 }, () => randomUUID()) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'project_ids' });
      expect(await owner('select id from machvon.period_reopen')).toEqual([]);
    });

    it('keeps the reason trimmed, names each project once as lower-case text, and lists the projects by code', async () => {
      const asked = await ask(week39, { reason: `  ${reasonText}  `, projectIds: [PROJECT_TWO.toUpperCase(), PROJECT_ONE, PROJECT_TWO] });
      expect(asked.reopen.reason).toBe(reasonText);
      expect(asked.reopen.projects.map((project) => project.code)).toEqual(['P-A-001', 'P-A-002']);
      const [stored] = await owner<{ scope_project_ids: string[] }>('select scope_project_ids from machvon.period_reopen where id = $1', [asked.reopen.id]);
      expect(stored?.scope_project_ids).toEqual([PROJECT_TWO, PROJECT_ONE]);
    });

    it('is refused for a project that does not exist in the tenant, for one outside the reach of the requester, and for a period that is not locked', async () => {
      expect(await refusal(ask(week39, { projectIds: [randomUUID()] }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'project_ids' });
      expect(await refusal(ask(week39, { projectIds: [PROJECT_OF_B] }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'project_ids' });
      expect(await refusal(ask(week39, { projectIds: [PROJECT_ONE, PROJECT_TWO] }, NOW, (place) => place.id === PROJECT_ONE))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(ask(week41, {}))).toEqual({ code: 'PERIOD_STATE_INVALID', status: 409, detail: 'status' });
      expect(await refusal(as(MAKER, (tx) => reopens.request(tx, { periodId: randomUUID(), scopeKind: 'PERIOD', projectIds: [], reason: reasonText, windowHours: 1 }, memberId(MAKER), at(NOW), reach)))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await owner('select id from machvon.period_reopen')).toEqual([]);
    });

    it('is handed the units a project is judged by', async () => {
      const places = await as(MAKER, (tx) => reopens.projectPlaces(tx, [PROJECT_ONE]));
      expect(places).toEqual([{ id: PROJECT_ONE, code: 'P-A-001', ownerUnit: { id: unitId(2), path: `/${unitId(1)}/${unitId(2)}/` }, investorUnit: null }]);
      expect(await as(MAKER, (tx) => reopens.projectPlaces(tx, []))).toEqual([]);
      expect(await as(MAKER, (tx) => reopens.projectPlaces(tx, [PROJECT_OF_B]))).toEqual([]);
    });

    it('does not exist for another tenant', async () => {
      const asked = await ask(week39);
      expect(await refusal(decide(asked.reopen.id, 1, { decision: 'approve', reason: 'Approved from tenant B' }, APPROVER, NOW, TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await as(APPROVER, (tx) => reopens.find(tx, asked.reopen.id, at(NOW)), TENANT_B)).toBeUndefined();
      const theirs = await periodByCode('W2026-39', TENANT_B);
      // The period of tenant B does not exist for tenant A, and the project of tenant A does not exist for tenant B.
      expect(await refusal(ask(theirs))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(ask(theirs, {}, NOW, reach, TENANT_B))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'project_ids' });
    });
  });

  describe('a decision', () => {
    it('rejects with a reason, grants nothing and takes no hours', async () => {
      const asked = await ask(week39);
      expect(await refusal(decide(asked.reopen.id, 1, { decision: 'reject', reason: 'Not needed', windowHours: 24 }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'window_hours' });
      expect(await refusal(decide(asked.reopen.id, 1, { decision: 'reject', reason: 'no' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect(await refusal(decide(asked.reopen.id, 1, { decision: 'reject', reason: 'x'.repeat(2001) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect(await refusal(decide(asked.reopen.id, 1, { decision: 'reject', reason: 'Not needed' }, MAKER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      const rejected = await decide(asked.reopen.id, 1, { decision: 'reject', reason: '  The vouchers are not documented  ' });
      expect(rejected.reopen).toMatchObject({ status: 'REJECTED', approvedBy: null, decidedBy: memberId(APPROVER), decidedAt: NOW, decisionReason: 'The vouchers are not documented', windowUntil: null, version: 2 });
      expect(await refusal(judge(week39, PROJECT_ONE, new Date(Date.parse(NOW) + HOUR).toISOString()))).toEqual({ code: 'PERIOD_LOCKED', status: 409 });
      expect(await refusal(decide(asked.reopen.id, 2, { decision: 'approve', reason: 'Approved after the rejection' }))).toEqual({ code: 'PERIOD_STATE_INVALID', status: 409, detail: 'status' });
    });

    it('answers a request that does not exist with 404, and the requester with 403 before anything about the request is told', async () => {
      expect(await refusal(decide(randomUUID(), 1, { decision: 'approve', reason: 'Approved at random' }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const asked = await ask(week39);
      expect(await refusal(decide(asked.reopen.id, 99, { decision: 'approve', reason: 'Approved by myself' }, MAKER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    });

    it('lets one of two decisions made at the same moment win and the other see the conflict', async () => {
      const asked = await ask(week39);
      const results = await Promise.allSettled([
        decide(asked.reopen.id, 1, { decision: 'approve', reason: 'Approved at once' }),
        decide(asked.reopen.id, 1, { decision: 'reject', reason: 'Rejected at once' }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect((lost.reason as { code: string }).code).toBe('VERSION_CONFLICT');
    });
  });

  describe('the trace of a step', () => {
    it('is built once for the command and the job: the audit row keeps who asked, who approved and the window; only an approval is an event', async () => {
      const asked = await ask(week39, { projectIds: [PROJECT_ONE] });
      const requested = reopenRecord('requested', asked.reopen, asked.period, asked.reopen.reason);
      expect(requested.event).toBeUndefined();
      expect(requested.audit).toMatchObject({ action: 'dis.period_reopen_requested', resourceType: 'period_reopen', resourceId: asked.reopen.id, reason: reasonText });
      expect(requested.audit.diff).toEqual({ period_id: week39.id, period_code: 'W2026-39', scope_kind: 'PROJECTS', project_ids: [PROJECT_ONE], requested_by: memberId(MAKER), requested_window_hours: 72, status: 'REQUESTED' });
      const approved = await decide(asked.reopen.id, 1, { decision: 'approve', reason: 'The vouchers are documented', windowHours: 48 });
      const done = reopenRecord('approved', approved.reopen, approved.period, 'The vouchers are documented');
      expect(done.audit.diff).toMatchObject({ requested_by: memberId(MAKER), approved_by: memberId(APPROVER), window_hours: 48, window_until: approved.reopen.windowUntil, decided_at: NOW });
      expect(done.event).toMatchObject({
        aggregateType: 'period_reopen',
        aggregateId: asked.reopen.id,
        aggregateVersion: 2,
        type: 'period.reopened.v1',
        schemaVersion: 1,
        eventKey: `period_reopen:${asked.reopen.id}:2`,
        payload: { reopen_id: asked.reopen.id, period_id: week39.id, period_code: 'W2026-39', scope_kind: 'PROJECTS', project_ids: [PROJECT_ONE], requested_by: memberId(MAKER), approved_by: memberId(APPROVER), window_until: approved.reopen.windowUntil },
      });
      // The event carries ids and times, never the reasons.
      expect(JSON.stringify(done.event?.payload)).not.toContain(reasonText);
      const other = await ask(week40);
      const rejected = await decide(other.reopen.id, 1, { decision: 'reject', reason: 'The vouchers are not documented' });
      const rejection = reopenRecord('rejected', rejected.reopen, rejected.period, 'The vouchers are not documented');
      expect(rejection.event).toBeUndefined();
      expect(rejection.audit.diff).toMatchObject({ decided_by: memberId(APPROVER), decided_at: NOW, status: 'REJECTED' });
      expect(rejection.audit.diff).not.toHaveProperty('window_until');
    });
  });

  describe('the table keeps the rules itself', () => {
    const insertRequest = (overrides: { id?: string; period?: string; status?: string; hours?: number; scope?: string; projects?: string[] | null; reason?: string } = {}) =>
      owner(
        `insert into machvon.period_reopen (tenant_id, id, period_id, scope_kind, scope_project_ids, reason, requested_by, requested_window_hours, status, created_by, updated_by)
         values ($1, $2, $3, $4, $5::uuid[], $6, $7, $8, $9, $7, $7)`,
        [TENANT_A, overrides.id ?? randomUUID(), overrides.period ?? week39.id, overrides.scope ?? 'PROJECTS', overrides.projects === undefined ? [PROJECT_ONE] : overrides.projects, overrides.reason ?? reasonText, memberId(MAKER), overrides.hours ?? 24, overrides.status ?? 'REQUESTED'],
      );

    it('refuses a request that is not born REQUESTED, for a period that is not locked, with an untrimmed reason, an empty or repeated project list or a window out of range', async () => {
      await expect(insertRequest({ status: 'APPROVED' })).rejects.toThrow(/born REQUESTED|status_shape|window_chk/);
      await expect(insertRequest({ period: week41.id })).rejects.toThrow(/only a locked reporting period/);
      await expect(insertRequest({ reason: ` ${reasonText}` })).rejects.toThrow(/period_reopen_reason_text_chk/);
      await expect(insertRequest({ projects: [PROJECT_ONE, PROJECT_ONE] })).rejects.toThrow(/each project once/);
      await expect(insertRequest({ projects: [] })).rejects.toThrow(/period_reopen_scope/);
      await expect(insertRequest({ scope: 'PERIOD', projects: [PROJECT_ONE] })).rejects.toThrow(/period_reopen_scope/);
      await expect(insertRequest({ hours: 169 })).rejects.toThrow(/period_reopen_requested_window_chk/);
      await expect(insertRequest({ hours: 0 })).rejects.toThrow(/period_reopen_requested_window_chk/);
      expect(await owner('select id from machvon.period_reopen')).toEqual([]);
    });

    it('moves a request only along REQUESTED to APPROVED or REJECTED and APPROVED to EXPIRED or CLOSED, one version at a time, and never rewrites what was asked or decided', async () => {
      const id = randomUUID();
      await insertRequest({ id });
      const approve = (extra = '', version = 2) =>
        owner(
          `update machvon.period_reopen set status = 'APPROVED', approved_by = $2, decided_by = $2, decided_at = $3, decision_reason = 'Approved for the test', window_until = $4, version = $5 ${extra} where id = $1`,
          [id, memberId(APPROVER), NOW, new Date(Date.parse(NOW) + 24 * HOUR).toISOString(), version],
        );
      await expect(owner("update machvon.period_reopen set status = 'EXPIRED', version = 2 where id = $1", [id])).rejects.toThrow(/moves only from REQUESTED/);
      await expect(approve('', 5)).rejects.toThrow(/raises its version by one/);
      await expect(owner('update machvon.period_reopen set reason = $2 where id = $1', [id, 'Another reason that is long enough'])).rejects.toThrow(/never changes/);
      await expect(owner('update machvon.period_reopen set requested_window_hours = 5, version = 2 where id = $1', [id])).rejects.toThrow(/never changes/);
      await expect(owner('update machvon.period_reopen set period_id = $2 where id = $1', [id, week40.id])).rejects.toThrow(/never changes/);
      // The requester cannot be the decider, whatever the path.
      await expect(
        owner("update machvon.period_reopen set status = 'APPROVED', approved_by = requested_by, decided_by = requested_by, decided_at = $2, decision_reason = 'Self approval', window_until = $3, version = 2 where id = $1", [
          id,
          NOW,
          new Date(Date.parse(NOW) + 24 * HOUR).toISOString(),
        ]),
      ).rejects.toThrow(/period_reopen_sod_chk|period_reopen_decider_sod_chk/);
      // An approval without a window, with a window longer than 168 hours or ending before it began is not a shape of the table.
      await expect(owner("update machvon.period_reopen set status = 'APPROVED', approved_by = $2, decided_by = $2, decided_at = $3, decision_reason = 'No window', version = 2 where id = $1", [id, memberId(APPROVER), NOW])).rejects.toThrow(/period_reopen_(window|status_shape)_chk/);
      await expect(
        owner("update machvon.period_reopen set status = 'APPROVED', approved_by = $2, decided_by = $2, decided_at = $3, decision_reason = 'Too long', window_until = $4, version = 2 where id = $1", [
          id,
          memberId(APPROVER),
          NOW,
          new Date(Date.parse(NOW) + 169 * HOUR).toISOString(),
        ]),
      ).rejects.toThrow(/period_reopen_status_shape_chk/);
      await approve();
      await expect(owner("update machvon.period_reopen set window_until = window_until + interval '1 hour', status = 'EXPIRED', version = 3 where id = $1", [id])).rejects.toThrow(/never changes/);
      await expect(owner("update machvon.period_reopen set status = 'REQUESTED', version = 3 where id = $1", [id])).rejects.toThrow(/moves only from REQUESTED/);
      await owner("update machvon.period_reopen set status = 'CLOSED', version = 3 where id = $1", [id]);
      await expect(owner("update machvon.period_reopen set status = 'APPROVED', version = 4 where id = $1", [id])).rejects.toThrow(/moves only from REQUESTED/);
    });
  });
});

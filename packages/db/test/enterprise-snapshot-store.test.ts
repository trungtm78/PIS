import { randomUUID } from 'node:crypto';
import { EnterpriseFigureReader, enterpriseSnapshotHash } from '@machvon/kernel';
import { DisPeriodReopenStore } from '../src/dis-period-reopen-store';
import { DisPeriodStore } from '../src/dis-period-store';
import type { PeriodRow } from '../src/dis-period-store';
import { DisSnapshotStore } from '../src/dis-snapshot-store';
import { ENTERPRISE_METRIC_SET_VERSION, EnterpriseSnapshotStore, periodRefOf } from '../src/enterprise-snapshot-store';
import { FndFigureStore } from '../src/fnd-figure-store';
import type { FigureProposal } from '../src/fnd-figure-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';
import { everything, nothing, seedAs } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const store = new EnterpriseSnapshotStore();
const figures = new FndFigureStore();
const periodsStore = new DisPeriodStore();
const reopens = new DisPeriodReopenStore();
const MAKER = 1;
const CHECKER = 2;
const THIRD = 3;
const PACK = 'ENTERPRISE';
const ENTRY_TIME = new Date('2026-11-08T03:00:00Z');
const at = (minutes: number): Date => new Date(new Date('2026-11-09T03:00:00Z').getTime() + minutes * 60_000);

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string | undefined; extensions?: Record<string, unknown> | undefined }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, detail: e.detail, extensions: e.extensions };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return String((error as { message?: string }).message);
  }
  throw new Error('expected the database to refuse');
}

const projects: Record<'A' | 'B', string> = { A: '', B: '' };
const periods: Record<string, string> = {};
let calendarVersionId = '';

async function seedProject(unit: number, label: string): Promise<string> {
  const created = randomUUID();
  await seedAs(harness, [[
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
     values ($1, $2, $3, 'Enterprise project', $4, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
    [TENANT_A, created, `ENT-${label}`, unitId(unit), id(0x50, 90)],
  ]]);
  return created;
}

async function seedPeriod(code: string, start: string, end: string): Promise<string> {
  const periodId = randomUUID();
  await seedAs(harness, [[
    `insert into machvon.reporting_period
       (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
     values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', 'ENTERPRISE', 'MONTH', 2026, 'OPEN', $6, $7, $7)`,
    [TENANT_A, periodId, code, start, end, calendarVersionId, memberId(MAKER)],
  ]]);
  return periodId;
}

/** Moves a period forward by the two steps the guard allows. */
async function lock(periodId: string): Promise<void> {
  await owner(`update machvon.reporting_period set status = 'SOFT_CLOSED', soft_closed_at = now(), version = 2 where id = $1::uuid`, [periodId]);
  await owner(`update machvon.reporting_period set status = 'LOCKED', locked_at = now(), locked_by = $2::uuid, version = 3 where id = $1::uuid`, [periodId, memberId(CHECKER)]);
}

async function seedPlan(projectId: string, amount: string): Promise<void> {
  const versionId = randomUUID();
  await seedAs(harness, [[`insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, 2026, 1, $4, 'PUBLISHED', '2026-01-10T03:00:00Z'::timestamptz)`, [TENANT_A, versionId, projectId, randomUUID()]]]);
  await seedAs(harness, [[
    `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, budget_level, taxonomy_pack)
     values ($1, $2, $3, $4, 'EQUITY', 2026, $5::numeric, 0, 'ALL', 'ENTERPRISE')`,
    [TENANT_A, randomUUID(), versionId, randomUUID(), amount],
  ]]);
}

const actualOf = (projectId: string, ordinal: number, amountVnd: string): FigureProposal => ({ projectId, classCode: 'EQUITY', tierCode: 'ALL', measure: 'DISBURSED', kind: 'ACTUAL', grain: 'MONTH', planYear: 2026, asOfDate: `2026-0${ordinal + 1}-03`, entries: [{ ordinal, amountVnd }] });

/** An actual prepared by one person and accepted by another, through the store of FND-1. */
async function settleActual(projectId: string, ordinal: number, amountVnd: string): Promise<void> {
  const drafted = await as((tx) => figures.propose(tx, actualOf(projectId, ordinal, amountVnd), PACK, memberId(MAKER), everything, ENTRY_TIME));
  const submitted = await as((tx) => figures.submit(tx, drafted.batchId, 1, memberId(MAKER), everything, ENTRY_TIME));
  await as((tx) => figures.accept(tx, drafted.batchId, submitted.version, memberId(CHECKER), PACK, everything, ENTRY_TIME), CHECKER);
}

/** Accepted actuals of zero for the months given, written as the books of the test (the months before the period are closed already). */
async function acceptedZeros(projectId: string, from: number, to: number): Promise<void> {
  await seedAs(harness, [[
    `insert into machvon.plan_figure_revision (tenant_id, id, batch_id, project_id, taxonomy_pack, bucket, budget_level, measure, figure_kind, period_grain, plan_year, period_ordinal, amount_vnd, basis, as_of_date, status, prepared_by, approved_by, approved_at, updated_by)
     select $1::uuid, gen_random_uuid(), $2::uuid, $3::uuid, 'ENTERPRISE', 'EQUITY', 'ALL', 'DISBURSED', 'ACTUAL', 'MONTH', 2026, m::smallint, 0, 'REPORTED', '2026-04-03'::date, 'ACCEPTED', $4::uuid, $5::uuid, now(), $4::uuid from generate_series($6::int, $7::int) as m`,
    [TENANT_A, randomUUID(), projectId, memberId(MAKER), memberId(CHECKER), from, to],
  ]]);
}

const periodOf = async (periodId: string): Promise<PeriodRow> => (await as((tx) => periodsStore.find(tx, periodId))) as PeriodRow;
const build = async (periodId: string, member: number, when: Date) => {
  const period = await periodOf(periodId);
  return as((tx) => store.build(tx, { period, asOfAt: when, actor: memberId(member), scope: everything }), member);
};

async function reopen(periodId: string, when: Date): Promise<string> {
  const requested = await as((tx) => reopens.request(tx, { periodId, scopeKind: 'PERIOD', projectIds: [], reason: 'The owner of unit two corrects the actual of the month', windowHours: 24 }, memberId(MAKER), when, () => true), MAKER);
  const self = await refusal(as((tx) => reopens.decide(tx, requested.reopen.id, requested.reopen.version, { decision: 'approve', reason: 'approved by myself' }, memberId(MAKER), when), MAKER));
  expect(self.code).toBe('SELF_APPROVAL_DENIED');
  await as((tx) => reopens.decide(tx, requested.reopen.id, requested.reopen.version, { decision: 'approve', reason: 'approved by the checker' }, memberId(CHECKER), when), CHECKER);
  return requested.reopen.id;
}

describe('the enterprise period snapshot (ENT-3a, DL.03)', () => {
  let march = '';
  let marchSnapshotId = '';
  let firstHash = '';

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: `/${unitId(1)}/` },
        { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 },
      ]);
      for (const member of [MAKER, CHECKER, THIRD]) await harness.seedMembership(tenant, member, 1);
    }
    calendarVersionId = randomUUID();
    projects.A = await seedProject(1, 'A');
    projects.B = await seedProject(2, 'B');
    await seedPlan(projects.A, '1000');
    await seedPlan(projects.B, '2000');
    periods['JAN'] = await seedPeriod('ENT-2026-01', '2026-01-01', '2026-01-31');
    march = await seedPeriod('ENT-2026-03', '2026-03-01', '2026-03-31');
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('reads the month, quarter or year of an enterprise period and refuses a period of another calendar or with other dates', async () => {
    const period = await periodOf(periods['JAN'] as string);
    expect(periodRefOf(period)).toEqual({ grain: 'MONTH', planYear: 2026, ordinal: 1 });
    expect(() => periodRefOf({ ...period, calendarCode: 'DEFAULT' })).toThrow();
    expect(() => periodRefOf({ ...period, endDate: '2026-01-30' })).toThrow();
  });

  it('refuses to build while the period is not locked (409 PERIOD_STATE_INVALID) and a person who does not see the whole tenant (403 SCOPE_DENIED)', async () => {
    expect(await refusal(build(periods['JAN'] as string, MAKER, at(0)))).toMatchObject({ code: 'PERIOD_STATE_INVALID', status: 409 });
    const period = await periodOf(periods['JAN'] as string);
    expect(await refusal(as((tx) => store.build(tx, { period, asOfAt: at(0), actor: memberId(MAKER), scope: nothing })))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
  });

  it('refuses a build when no input point has submitted and names every missing unit with its projects and cells; readiness says the same without writing', async () => {
    await lock(periods['JAN'] as string);
    const none = await refusal(build(periods['JAN'] as string, MAKER, at(0)));
    expect(none).toMatchObject({ code: 'ENTERPRISE_SNAPSHOT_INCOMPLETE', status: 422 });
    const units = (none.extensions?.['missing_units'] as Array<{ unit_code: string; projects: Array<{ project_code: string }> }>).map((unit) => [unit.unit_code, unit.projects.map((project) => project.project_code)]);
    expect(units).toEqual([['U1', ['ENT-A']], ['U2', ['ENT-B']]]);
    expect(none.extensions?.['planned_cells']).toBe(2);
    const period = await periodOf(periods['JAN'] as string);
    const ready = await as((tx) => store.readiness(tx, period, everything, at(0)));
    expect(ready.completeness.missingUnits.map((unit) => unit.unitCode)).toEqual(['U1', 'U2']);
    expect(ready.frozen).toBeNull();
    expect(ready.rebuildAllowed).toBe(true);
    expect((await owner<{ n: string }>(`select count(*)::text as n from machvon.period_snapshot where snapshot_kind = 'ENTERPRISE_CLOSE'`))[0]?.n).toBe('0');
  });

  it('lists only the units that have not submitted: one unit hands in and is not listed again', async () => {
    // A year to date needs every month up to the period: January and February are accepted zeros, March is the figure.
    await acceptedZeros(projects.A, 1, 2);
    await settleActual(projects.A, 3, '100');
    await lock(march);
    const refused = await refusal(build(march, MAKER, at(0)));
    expect(refused).toMatchObject({ code: 'ENTERPRISE_SNAPSHOT_INCOMPLETE', status: 422 });
    expect((refused.extensions?.['missing_units'] as Array<{ unit_code: string }>).map((unit) => unit.unit_code)).toEqual(['U2']);
  });

  it('a gap is a gap and an accepted zero is a submission: with the zero of the other unit the period builds, for review', async () => {
    // The period is locked already, so the zero of unit two is seeded as an accepted row dated before the lock.
    await acceptedZeros(projects.B, 1, 3);
    const built = await build(march, MAKER, at(0));
    expect(built.snapshot).toMatchObject({ status: 'BUILDING', revision: 1, taxonomyPack: 'ENTERPRISE', hashSchema: 2, version: 1, payloadSha256: null });
    expect(built.projects).toBe(2);
    expect(built.snapshot.figureCount).toBeGreaterThan(0);
    marchSnapshotId = built.snapshot.id;
  });

  it('carries the figures in force of the indicator dictionary and counts them in the row count; a new build replaces the one that waits', async () => {
    await seedAs(harness, [[
      `insert into machvon.ind_figure (tenant_id, id, project_id, period_id, indicator_code, revision, value, unit, definition_version, source, entered_by)
       values ($1, $2, $3, $4, 'PHYSICAL_PROGRESS', 1, 40, 'PERCENT', 1, 'ENTRY', $5)`,
      [TENANT_A, randomUUID(), projects.A, march, memberId(MAKER)],
    ]]);
    const again = await build(march, MAKER, at(1));
    expect(again.discardedId).toBe(marchSnapshotId);
    expect(again.indicators).toBe(1);
    expect(again.snapshot.indicatorCount).toBe(1);
    expect(again.snapshot.rowCount).toBe(again.snapshot.figureCount + 1);
    marchSnapshotId = again.snapshot.id;
    expect(await owner<{ status: string }>(`select status from machvon.period_snapshot where snapshot_kind = 'ENTERPRISE_CLOSE' and status = 'FAILED'`)).toHaveLength(1);
  });

  it('the person who built does not freeze (403 SELF_APPROVAL_DENIED); another person freezes it with a hash that the stored rows reproduce in any order', async () => {
    expect(await refusal(as((tx) => store.freeze(tx, marchSnapshotId, 1, memberId(MAKER), at(2)), MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    expect((await refusal(as((tx) => store.freeze(tx, marchSnapshotId, 7, memberId(CHECKER), at(2)), CHECKER))).code).toBe('VERSION_CONFLICT');
    const done = await as((tx) => store.freeze(tx, marchSnapshotId, 1, memberId(CHECKER), at(2)), CHECKER);
    expect(done.supersededId).toBeNull();
    expect(done.snapshot).toMatchObject({ status: 'FROZEN', revision: 1, frozenBy: memberId(CHECKER), supersedesId: null });
    firstHash = done.snapshot.payloadSha256 as string;
    expect(firstHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await as((tx) => store.verify(tx, marchSnapshotId))).toEqual({ ok: true, expected: firstHash, actual: firstHash });
    const held = await as((tx) => store.rowsOf(tx, marchSnapshotId));
    const outside = enterpriseSnapshotHash({
      periodId: march,
      snapshotKind: 'ENTERPRISE_CLOSE',
      asOfDate: '2026-03-31',
      metricSetVersion: ENTERPRISE_METRIC_SET_VERSION,
      definitionStatus: done.snapshot.definitionStatus,
      taxonomyPack: 'ENTERPRISE',
      taxonomyVersion: done.snapshot.taxonomyVersion,
      actualsPrecedence: 'REPORTED_UNTIL_RECONCILED',
      figures: [...held.figures].reverse(),
      indicators: [...held.indicators].reverse(),
    });
    expect(outside).toBe(firstHash);
    expect(await refusal(as((tx) => store.freeze(tx, marchSnapshotId, 2, memberId(THIRD), at(3)), THIRD))).toMatchObject({ code: 'SNAPSHOT_FROZEN', status: 409 });
  });

  it('a frozen snapshot is immutable in the database: figures, indicator figures and the hash cannot be changed or deleted', async () => {
    expect(await databaseRefusal(owner(`update machvon.period_snapshot_figure set amount_vnd = 1 where snapshot_id = $1::uuid`, [marchSnapshotId]))).toContain('not changed');
    expect(await databaseRefusal(owner(`delete from machvon.period_snapshot_indicator where snapshot_id = $1::uuid`, [marchSnapshotId]))).toContain('not changed');
    expect(await databaseRefusal(owner(`update machvon.period_snapshot set payload_sha256 = repeat('a', 64) where id = $1::uuid`, [marchSnapshotId]))).toContain('frozen snapshot is not changed');
  });

  it('a second build of a frozen period is refused until a reopening is approved after the freeze (409 SNAPSHOT_FROZEN, reopen required)', async () => {
    const refused = await refusal(build(march, THIRD, at(10)));
    expect(refused).toMatchObject({ code: 'SNAPSHOT_FROZEN', status: 409 });
    expect(refused.extensions).toMatchObject({ reopen_required: true });
    const period = await periodOf(march);
    const ready = await as((tx) => store.readiness(tx, period, everything, at(10)));
    expect(ready).toMatchObject({ rebuildAllowed: false, frozen: { revision: 1, payloadSha256: firstHash } });
  });

  it('is read through the one reader: totals, a rate with its numerator and denominator, and the indicator figure', async () => {
    const row = (await as((tx) => store.find(tx, marchSnapshotId))) as NonNullable<Awaited<ReturnType<typeof store.find>>>;
    const reader = new EnterpriseFigureReader(await as((tx) => store.view(tx, row)));
    expect(reader.hash).toBe(firstHash);
    expect(reader.amountOf({}, 'DISBURSED', 'CUMULATIVE_YTD')).toBe('100');
    expect(reader.amountOf({}, 'DISBURSED', 'PLAN_IN_FORCE')).toBe('3000');
    expect(reader.rate({}, 'DISBURSED', 'RATE_YEAR_IN_FORCE')).toMatchObject({ numeratorVnd: '100', denominatorVnd: '3000', ratePct: '3.3333' });
    expect(reader.indicatorSum({}, 'PHYSICAL_PROGRESS')).toBe('40');
    expect(reader.unitIds()).toHaveLength(2);
  });

  it('the public snapshot paths do not see it: it is not listed, the public freeze refuses it and the latest public close ignores it', async () => {
    const disStore = new DisSnapshotStore();
    expect((await as((tx) => disStore.list(tx, {}, 50))).map((one) => one.id)).not.toContain(marchSnapshotId);
    expect(await as((tx) => disStore.latestFrozen(tx))).toBeUndefined();
    const refused = await refusal(as((tx) => disStore.freeze(tx, marchSnapshotId, 2, memberId(CHECKER), at(4)), CHECKER));
    expect(refused.code).toMatch(/SNAPSHOT_FROZEN|SNAPSHOT_NOT_BUILT/);
  });

  it('is invisible to another tenant', async () => {
    expect(await as((tx) => store.find(tx, marchSnapshotId), MAKER, TENANT_B)).toBeUndefined();
    expect(await as((tx) => store.list(tx, {}, 50), MAKER, TENANT_B)).toEqual([]);
  });

  it('a reopening approved after the freeze (reason, another approver) lets the next revision be built; the old one is superseded and keeps its hash', async () => {
    const reopenId = await reopen(march, at(20));
    await seedAs(harness, [[
      `insert into machvon.ind_figure (tenant_id, id, project_id, period_id, indicator_code, revision, value, unit, definition_version, source, reason, entered_by)
       values ($1, $2, $3, $4, 'PHYSICAL_PROGRESS', 2, 45, 'PERCENT', 1, 'ENTRY', 'corrected after the reopening', $5)`,
      [TENANT_A, randomUUID(), projects.A, march, memberId(MAKER)],
    ]]);
    const rebuilt = await build(march, THIRD, at(30));
    expect(rebuilt.reopenId).toBe(reopenId);
    expect(rebuilt.snapshot).toMatchObject({ status: 'BUILDING', revision: 2 });
    const done = await as((tx) => store.freeze(tx, rebuilt.snapshot.id, 1, memberId(MAKER), at(40)), MAKER);
    expect(done.supersededId).toBe(marchSnapshotId);
    expect(done.snapshot).toMatchObject({ status: 'FROZEN', revision: 2, supersedesId: marchSnapshotId });
    expect(done.snapshot.payloadSha256).not.toBe(firstHash);
    expect(await as((tx) => store.find(tx, marchSnapshotId))).toMatchObject({ status: 'SUPERSEDED', payloadSha256: firstHash, revision: 1 });
    expect((await as((tx) => store.verify(tx, marchSnapshotId))).ok).toBe(true);
    const official = await as((tx) => store.frozenOf(tx, march));
    expect(official?.id).toBe(rebuilt.snapshot.id);
    expect((await as((tx) => store.frozenForDates(tx, 'MONTH', '2026-03-01', '2026-03-31')))?.revision).toBe(2);
    expect(new EnterpriseFigureReader(await as((tx) => store.view(tx, official as NonNullable<typeof official>))).indicatorSum({}, 'PHYSICAL_PROGRESS')).toBe('45');
  });

  it('a snapshot built before a later reopening is not frozen after it (409 PERIOD_STATE_INVALID): the figures may have moved', async () => {
    await reopen(march, at(50));
    const waiting = await build(march, THIRD, at(60));
    expect(waiting.snapshot).toMatchObject({ status: 'BUILDING', revision: 3 });
    await reopen(march, at(70));
    const refused = await refusal(as((tx) => store.freeze(tx, waiting.snapshot.id, 1, memberId(MAKER), at(80)), MAKER));
    expect(refused).toMatchObject({ code: 'PERIOD_STATE_INVALID', status: 409 });
    expect(refused.extensions).toMatchObject({ reopened_since_build: true });
  });
});

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { FUNDING_CELLS, draftHash, fundingCells, fundingTotals } from '@machvon/kernel';
import type { EffectiveAccess, RawFundingLine, Scope } from '@machvon/kernel';
import { DisReportStore } from '../src/dis-report-store';
import type { Allocation, NewDraft } from '../src/dis-report-store';
import { projectScope } from '../src/prj-project-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new DisReportStore();

const MAKER = 1;
const OTHER = 2;
const FAMILY = 0x9c;
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const NOW = new Date('2026-10-26T03:00:00Z');
const AREA = id(FAMILY, 30);
const FUND_SOURCE = id(FAMILY, 31);
const DECISION = id(FAMILY, 32);

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = MAKER): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const accessOf = (permissions: readonly string[], scope: Scope): EffectiveAccess => ({
  membershipId: memberId(MAKER),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'DIS', rank: 30, permissions, scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const READ = 'report.read';
const CREATE = 'report.create';
const whole = accessOf([READ, CREATE], { kind: 'TENANT' });
const seeAll = projectScope(whole, READ, NOW);
const actsAll = projectScope(whole, CREATE, NOW);
const readOnly = projectScope(accessOf([READ], { kind: 'TENANT' }), CREATE, NOW);
const elsewhereOnly = projectScope(accessOf([READ, CREATE], { kind: 'UNIT_SUBTREE', refIds: [unitId(ELSEWHERE)], paths: ['/u3/'] }), READ, NOW);

const project = { a: id(FAMILY, 1), b: id(FAMILY, 2), concept: id(FAMILY, 3) };
const period = { w40: id(FAMILY, 10), w41: id(FAMILY, 11), w42: id(FAMILY, 12), y2025: id(FAMILY, 13), month: id(FAMILY, 14) };
const plan = { published: id(FAMILY, 20), later: id(FAMILY, 21), draft: id(FAMILY, 22), year2025: id(FAMILY, 23), noLines: id(FAMILY, 24), b: id(FAMILY, 25) };

/** FX-DIS-001: six cells 100/200/30/70/0/20 million and CTMTQG 40 million in the year plan of the central budget. */
const FX_DIS_001: RawFundingLine[] = [
  { bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '40000000' },
  { bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', cumulative_vnd: '200000000' },
  { bucket: 'CARRYOVER', budget_level: 'CENTRAL', cumulative_vnd: '30000000' },
  { bucket: 'CARRYOVER', budget_level: 'LOCAL', cumulative_vnd: '70000000' },
  { bucket: 'OTHER', budget_level: 'CENTRAL', cumulative_vnd: '0' },
  { bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '20000000' },
];

async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    // The tables this story only reads (projects, plans, periods) belong to other slices: they are seeded with the foreign keys switched off.
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

const projectRow = (n: string, code: string, owner_unit: string, status: string): [string, unknown[]] => [
  `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
   values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, $7, 1, 'B')`,
  [TENANT_A, n, code, `Project ${code}`, owner_unit, AREA, status],
];
const periodRow = (n: string, code: string, start: string, end: string, type = 'WEEK', year = 2026): [string, unknown[]] => [
  `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
   values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', 'DEFAULT', $6, $7, 'OPEN', $8, $9, $9)`,
  [TENANT_A, n, code, start, end, type, year, id(FAMILY, 40), memberId(MAKER)],
];
/** A period of its own: the next week after the last one handed out. */
const weekRow = (n: string, code: string): [string, unknown[]] => {
  const week = nextWeek();
  return periodRow(n, code, week.start, week.end, 'WEEK', week.year);
};
const planRow = (n: string, projectId: string, year: number, revision: number, status: string, effective: string | null): [string, unknown[]] => [
  `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
  [TENANT_A, n, projectId, year, revision, DECISION, status, effective],
];
const allocationRow = (planId: string, projectId: string, bucket: string, level: string | null, amount: string, year = 2026): [string, unknown[]] => [
  `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, budget_level, is_extended, extended_to, extension_document_id)
   values ($1, gen_random_uuid(), $2, $3, $4, $5, $6::numeric, 0, $7, $8, $9, case when $9 then date '2027-03-31' end, case when $9 then $10::uuid end)`,
  [TENANT_A, planId, FUND_SOURCE, bucket, year, amount, projectId, level, bucket === 'CARRYOVER', DECISION],
];

const allocationsOf = (planId: string): Promise<Map<string, Allocation>> => as((tx) => store.allocations(tx, planId));

interface Made {
  id: string;
  version: number;
}

let counter = 0;
let weeks = 0;
/** The weeks of 2040 and after, one after the other (periods of one calendar never overlap): the first is Monday 2040-01-02. */
function nextWeek(): { start: string; end: string; year: number } {
  const start = new Date(Date.UTC(2040, 0, 2) + weeks * 7 * 86_400_000);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  weeks += 1;
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), year: start.getUTCFullYear() };
}
const draftOf = async (projectId: string, periodId: string, planId: string, overrides: Partial<NewDraft> = {}): Promise<NewDraft> => ({
  projectId,
  periodId,
  planVersionId: planId,
  reportType: 'WEEKLY',
  measurementBasis: 'YTD',
  cells: fundingCells(FX_DIS_001),
  negativeDeltaExplanation: null,
  clientOperationId: undefined,
  allocations: await allocationsOf(planId),
  ...overrides,
});

const create = async (projectId: string, periodId: string, planId: string, overrides: Partial<NewDraft> = {}, member = MAKER): Promise<Made> => {
  const input = await draftOf(projectId, periodId, planId, overrides);
  return as((tx) => store.createDraft(tx, input, memberId(member)), TENANT_A, member);
};

/** A fresh project (so that a test owns its periods), in the department, with the plan version and the periods it needs. */
async function freshProject(): Promise<string> {
  counter += 1;
  const projectId = id(FAMILY, 100 + counter);
  await seedReplica([projectRow(projectId, `FR-${counter}`, unitId(DEPARTMENT), 'IMPLEMENTATION'), planRow(id(FAMILY, 300 + counter), projectId, 2026, 1, 'PUBLISHED', '2026-01-15T00:00:00Z')]);
  return projectId;
}
const state = async (reportId: string) =>
  (await owner<{ status: string; version: string; hash: string; basis: string; explanation: string | null; is_current: boolean }>(
    'select status, version::text as version, payload_hash as hash, measurement_basis as basis, negative_delta_explanation as explanation, is_current from machvon.report_revision where id = $1',
    [reportId],
  ))[0] as { status: string; version: string; hash: string; basis: string; explanation: string | null; is_current: boolean };
const cells = (reportId: string) =>
  owner<{ bucket: string; budget_level: string; cumulative: string; ctmtqg: string | null; allocated: string; next_month: string; source_year: number | null; allocation_line_id: string | null }>(
    `select bucket, budget_level, disbursed_cumulative_vnd::text as cumulative, ctmtqg_subset_vnd::text as ctmtqg, allocated_vnd::text as allocated, next_month_registered_vnd::text as next_month, source_year, allocation_line_id
       from machvon.funding_snapshot_line where report_revision_id = $1 order by bucket, budget_level`,
    [reportId],
  );

describe('DisReportStore (the weekly report draft, ST-DIS-003)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: ROOT },
        { n: ELSEWHERE, path: '/u3/' },
      ]);
    }
    for (const n of [MAKER, OTHER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await seedReplica([
      [
        "insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'FUND_SOURCE', 'NSTW', 'EFFECTIVE', $3, $3)",
        [TENANT_A, id(FAMILY, 33), memberId(MAKER)],
      ],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
         values ($1, $2, $3, 'FUND_SOURCE', 'NSTW', 1, 'Central budget', '{}', date '2024-01-01', 'EFFECTIVE', 'TENANT', now(), $4, $4)`,
        [TENANT_A, FUND_SOURCE, id(FAMILY, 33), memberId(MAKER)],
      ],
      projectRow(project.a, 'DA-A', unitId(DEPARTMENT), 'IMPLEMENTATION'),
      projectRow(project.b, 'DA-B', unitId(ELSEWHERE), 'BUDGETED'),
      projectRow(project.concept, 'DA-C', unitId(DEPARTMENT), 'CONCEPT'),
      periodRow(period.w40, '2026-W40', '2026-09-28', '2026-10-04'),
      periodRow(period.w41, '2026-W41', '2026-10-05', '2026-10-11'),
      periodRow(period.w42, '2026-W42', '2026-10-12', '2026-10-18'),
      periodRow(period.y2025, '2025-W52', '2025-12-22', '2025-12-28', 'WEEK', 2025),
      periodRow(period.month, '2026-M10', '2026-10-01', '2026-10-31', 'MONTH'),
      // The plan of project A: v1 published in January, a revision published on 2026-10-08 (after the end of W40, before the end of W41), a draft that is never in force, a plan of another year.
      planRow(plan.published, project.a, 2026, 1, 'SUPERSEDED', '2026-01-15T00:00:00Z'),
      planRow(plan.later, project.a, 2026, 2, 'PUBLISHED', '2026-10-08T01:00:00Z'),
      planRow(plan.draft, project.a, 2026, 3, 'DRAFT', null),
      planRow(plan.year2025, project.a, 2025, 1, 'PUBLISHED', '2025-01-10T00:00:00Z'),
      planRow(plan.noLines, project.b, 2026, 1, 'PUBLISHED', '2026-01-15T00:00:00Z'),
      allocationRow(plan.published, project.a, 'CURRENT_YEAR', 'CENTRAL', '500000000'),
      allocationRow(plan.published, project.a, 'CURRENT_YEAR', 'CENTRAL', '100000000'),
      allocationRow(plan.published, project.a, 'CURRENT_YEAR', 'LOCAL', '300000000'),
      allocationRow(plan.published, project.a, 'CARRYOVER', 'LOCAL', '50000000', 2025),
      allocationRow(plan.published, project.a, 'OTHER', null, '999'),
      allocationRow(plan.later, project.a, 'CURRENT_YEAR', 'CENTRAL', '700000000'),
    ]);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the project, the plan and the period before', () => {
    it('finds a project in the scope of the caller, 404 when it lies outside it or is not there, 403 when the caller may read it and not act on it', async () => {
      expect(await as((tx) => store.project(tx, project.a, seeAll, actsAll))).toEqual({ id: project.a, code: 'DA-A', name: 'Project DA-A', status: 'IMPLEMENTATION' });
      expect(await refusal(as((tx) => store.project(tx, project.a, elsewhereOnly, actsAll)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => store.project(tx, randomUUID(), seeAll, actsAll)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => store.project(tx, project.a, seeAll, readOnly)))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(as((tx) => store.project(tx, project.a, seeAll, actsAll), TENANT_B))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('takes the plan version that was in force on the last day of the period, in the fiscal year of the period, and never a draft', async () => {
      const at = (year: number, end: string) => as((tx) => store.effectivePlan(tx, project.a, year, end));
      expect((await at(2026, '2026-10-04'))?.id).toBe(plan.published);
      expect((await at(2026, '2026-10-07'))?.id).toBe(plan.published);
      // The revision published on the 8th at 08:00 Vietnam time is in force from that day.
      expect((await at(2026, '2026-10-08'))?.id).toBe(plan.later);
      expect(await at(2026, '2026-10-11')).toMatchObject({ id: plan.later, projectId: project.a, fiscalYear: 2026, revision: 2, status: 'PUBLISHED' });
      expect((await at(2025, '2025-12-28'))?.id).toBe(plan.year2025);
      expect(await at(2026, '2026-01-14')).toBeUndefined();
      expect(await at(2024, '2024-06-01')).toBeUndefined();
      expect(await as((tx) => store.effectivePlan(tx, project.b, 2025, '2025-12-28'))).toBeUndefined();
    });

    it('adds what the plan allocated to each cell, names the line when it is the only one, and leaves the cells it did not touch at zero', async () => {
      const allocations = await allocationsOf(plan.published);
      expect([...allocations.keys()]).toEqual(FUNDING_CELLS.map((cell) => `${cell.bucket}/${cell.budgetLevel}`));
      expect(allocations.get('CURRENT_YEAR/CENTRAL')).toEqual({ allocatedVnd: '600000000', allocationLineId: null, fundSourceVersionId: null, sourceYear: null });
      expect(allocations.get('CURRENT_YEAR/LOCAL')).toMatchObject({ allocatedVnd: '300000000', fundSourceVersionId: FUND_SOURCE, sourceYear: 2026 });
      expect(allocations.get('CURRENT_YEAR/LOCAL')?.allocationLineId).toEqual(expect.any(String));
      expect(allocations.get('CARRYOVER/LOCAL')).toMatchObject({ allocatedVnd: '50000000', sourceYear: 2025 });
      for (const empty of ['CARRYOVER/CENTRAL', 'OTHER/CENTRAL', 'OTHER/LOCAL']) expect(allocations.get(empty)).toMatchObject({ allocatedVnd: '0', allocationLineId: null });
      expect([...(await allocationsOf(plan.noLines)).values()].every((allocation) => allocation.allocatedVnd === '0')).toBe(true);
    });

    it('reads the previous period from the accepted, current revision of the latest earlier period of the same type and year, and nothing else', async () => {
      const projectId = await freshProject();
      const plan1 = id(FAMILY, 300 + counter);
      const accept = async (periodId: string, cumulative: string, options: { status?: string; current?: boolean } = {}): Promise<void> => {
        const made = await create(projectId, periodId, plan1, { cells: fundingCells([{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: cumulative }]) });
        await owner("update machvon.report_revision set status = $2, is_current = $3, accepted_by = $4, submitted_by = $5, submitted_at = now(), accepted_at = now() where id = $1", [
          made.id,
          options.status ?? 'ACCEPTED',
          options.current ?? true,
          memberId(OTHER),
          memberId(MAKER),
        ]);
      };
      const span = [nextWeek(), nextWeek(), nextWeek()].map((range, index) => ({ id: randomUUID(), code: `P-W${index + 1}-${counter}`, ...range }));
      await seedReplica(span.map((entry) => periodRow(entry.id, entry.code, entry.start, entry.end, 'WEEK', entry.year)));
      await accept(span[0]?.id as string, '100');
      await accept(span[1]?.id as string, '150', { status: 'SUBMITTED', current: false });
      const third = span[2] as (typeof span)[number];
      const current = { id: third.id, code: 'x', periodType: 'WEEK', fiscalYear: third.year, startDate: third.start, endDate: third.end, status: 'OPEN' };
      // The week before this one has nothing accepted: the comparison reaches back to the latest week that has.
      expect((await as((tx) => store.previousCumulative(tx, projectId, current))).get('CURRENT_YEAR/CENTRAL')).toBe('100');
      // Another type of period, another year, or another project has no say.
      expect((await as((tx) => store.previousCumulative(tx, projectId, { ...current, periodType: 'MONTH' })).then((map) => map.size))).toBe(0);
      expect((await as((tx) => store.previousCumulative(tx, projectId, { ...current, fiscalYear: third.year + 1 })).then((map) => map.size))).toBe(0);
      expect((await as((tx) => store.previousCumulative(tx, project.b, current)).then((map) => map.size))).toBe(0);
      // The first period has none before it.
      expect((await as((tx) => store.previousCumulative(tx, projectId, { ...current, startDate: (span[0] as (typeof span)[number]).start })).then((map) => map.size))).toBe(0);
    });
  });

  describe('making a draft (AC-ST-DIS-003-1, AC-ST-DIS-003-3)', () => {
    it('AC-ST-DIS-003-1 / FX-DIS-001: writes revision 1 in DRAFT with six cells that add up to 420 million, the CTMTQG of 40 million apart, and what the plan allocated', async () => {
      const made = await create(project.a, period.w40, plan.published);
      expect(made.version).toBe(1);
      expect(await state(made.id)).toMatchObject({ status: 'DRAFT', version: '1', basis: 'YTD', explanation: null, is_current: false });
      const stored = await cells(made.id);
      expect(stored.map((cell) => [cell.bucket, cell.budget_level, cell.cumulative, cell.ctmtqg, cell.allocated])).toEqual([
        ['CARRYOVER', 'CENTRAL', '30000000', null, '0'],
        ['CARRYOVER', 'LOCAL', '70000000', null, '50000000'],
        ['CURRENT_YEAR', 'CENTRAL', '100000000', '40000000', '600000000'],
        ['CURRENT_YEAR', 'LOCAL', '200000000', null, '300000000'],
        ['OTHER', 'CENTRAL', '0', null, '0'],
        ['OTHER', 'LOCAL', '20000000', null, '0'],
      ]);
      expect(fundingTotals(stored.map((cell) => ({ cumulativeVnd: cell.cumulative, ctmtqgVnd: cell.ctmtqg, nextMonthVnd: cell.next_month, nextMonthCtmtqgVnd: null })))).toMatchObject({ cumulativeVnd: '420000000', ctmtqgVnd: '40000000' });
      expect((await state(made.id)).hash).toBe(
        draftHash({ projectId: project.a, periodId: period.w40, planVersionId: plan.published, reportType: 'WEEKLY', measurementBasis: 'YTD', cells: fundingCells(FX_DIS_001), negativeDeltaExplanation: null }),
      );
    });

    it('AC-ST-DIS-003-3: a second draft of the project in the period is 409 DRAFT_EXISTS with the first, and a revision that was handed in is 409 REPORT_STATE_INVALID', async () => {
      const first = await create(project.a, period.w41, plan.later);
      expect(await refusal(create(project.a, period.w41, plan.later))).toMatchObject({ code: 'DRAFT_EXISTS', status: 409, detail: 'period_id', extensions: { report_id: first.id, revision: 1, report_status: 'DRAFT' } });
      expect(await owner('select id from machvon.report_revision where project_id = $1 and period_id = $2', [project.a, period.w41])).toHaveLength(1);
      await owner("update machvon.report_revision set status = 'SUBMITTED', submitted_by = $2, submitted_at = now() where id = $1", [first.id, memberId(MAKER)]);
      expect(await refusal(create(project.a, period.w41, plan.later))).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409, extensions: { report_id: first.id, report_status: 'SUBMITTED' } });
    });

    it('lets two makers start the draft of the same project and period at once, and only one is written', async () => {
      const projectId = await freshProject();
      const planId = id(FAMILY, 300 + counter);
      const periodId = randomUUID();
      await seedReplica([weekRow(periodId, `RACE-${counter}`)]);
      const input = await draftOf(projectId, periodId, planId);
      const settled = await Promise.allSettled([as((tx) => store.createDraft(tx, input, memberId(MAKER))), as((tx) => store.createDraft(tx, input, memberId(OTHER)), TENANT_A, OTHER)]);
      expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
      expect((settled.find((item) => item.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
      expect(await owner('select id from machvon.report_revision where project_id = $1 and period_id = $2', [projectId, periodId])).toHaveLength(1);
    });

    it('keeps the id of a client operation, once: the same operation sent again finds the report it made, another report cannot reuse it', async () => {
      const projectId = await freshProject();
      const planId = id(FAMILY, 300 + counter);
      const periodId = randomUUID();
      await seedReplica([weekRow(periodId, `OPS-${counter}`), weekRow(randomUUID(), `OPS2-${counter}`)]);
      const operation = randomUUID();
      const made = await create(projectId, periodId, planId, { clientOperationId: operation });
      const found = await as((tx) => store.byClientOperation(tx, operation));
      expect(found).toMatchObject({ id: made.id, projectId, periodId, revision: 1, status: 'DRAFT', clientOperationId: operation });
      expect(await as((tx) => store.byClientOperation(tx, randomUUID()))).toBeUndefined();
      const other = (await owner<{ id: string }>('select id from machvon.reporting_period where code = $1', [`OPS2-${counter}`]))[0]?.id as string;
      expect(await refusal(create(projectId, other, planId, { clientOperationId: operation }))).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409, detail: 'client_operation_id' });
    });

    it('finds the latest revision of a project in a period, whatever its status, and none when there never was one', async () => {
      const made = await create(project.a, period.w42, plan.later);
      expect(await as((tx) => store.latestFor(tx, project.a, period.w42))).toMatchObject({ id: made.id, status: 'DRAFT', deleted: false, version: 1, reportType: 'WEEKLY' });
      expect(await as((tx) => store.latestFor(tx, project.b, period.w42))).toBeUndefined();
    });
  });

  describe('saving the draft (AC-ST-DIS-003-2)', () => {
    const lockFor = (reportId: string, version: number, member = MAKER) => as((tx) => store.lock(tx, reportId, seeAll, actsAll, version), TENANT_A, member);

    it('replaces the entries of the cells, keeps what the plan allocated, and moves the version and the hash', async () => {
      const projectId = await freshProject();
      const planId = id(FAMILY, 300 + counter);
      const periodId = randomUUID();
      await seedReplica([weekRow(periodId, `SAVE-${counter}`)]);
      const made = await create(projectId, periodId, planId);
      const before = await state(made.id);
      const next = fundingCells([
        { bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '150000000', ctmtqg_subset_vnd: '60000000', next_month_vnd: '10000000', next_month_ctmtqg_subset_vnd: '2000000' },
        { bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '5', source_year: 2024 },
      ]);
      const head = await lockFor(made.id, 1);
      const saved = await as((tx) => store.saveDraft(tx, head, { measurementBasis: 'PERIOD', cells: next, negativeDeltaExplanation: 'The Treasury returned a payment.' }, memberId(MAKER)));
      expect(saved.version).toBe(2);
      const after = await state(made.id);
      expect(after).toMatchObject({ status: 'DRAFT', version: '2', basis: 'PERIOD', explanation: 'The Treasury returned a payment.' });
      expect(after.hash).toBe(saved.payloadHash);
      expect(after.hash).not.toBe(before.hash);
      const stored = await cells(made.id);
      expect(stored.find((cell) => cell.bucket === 'CURRENT_YEAR' && cell.budget_level === 'CENTRAL')).toMatchObject({ cumulative: '150000000', ctmtqg: '60000000', allocated: '0', next_month: '10000000' });
      expect(stored.find((cell) => cell.bucket === 'OTHER' && cell.budget_level === 'LOCAL')).toMatchObject({ cumulative: '5', source_year: 2024 });
      expect(stored.find((cell) => cell.bucket === 'CARRYOVER' && cell.budget_level === 'CENTRAL')).toMatchObject({ cumulative: '0', ctmtqg: null });
    });

    it('answers the same content with the same hash and refuses a stale version (409 VERSION_CONFLICT)', async () => {
      const made = await create(await freshProject(), await newPeriod(), id(FAMILY, 300 + counter));
      const head = await lockFor(made.id, 1);
      expect(await refusal(lockFor(made.id, 7))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      const content = { measurementBasis: 'YTD' as const, cells: fundingCells(FX_DIS_001), negativeDeltaExplanation: null };
      const first = await as((tx) => store.saveDraft(tx, head, content, memberId(MAKER)));
      const second = await as((tx) => store.saveDraft(tx, { ...head, version: first.version }, content, memberId(MAKER)));
      expect(second.payloadHash).toBe(first.payloadHash);
    });

    it('does not edit a revision that was handed in (409 REVISION_IMMUTABLE), nor one that was deleted', async () => {
      const made = await create(await freshProject(), await newPeriod(), id(FAMILY, 300 + counter));
      const head = await lockFor(made.id, 1);
      const content = { measurementBasis: 'YTD' as const, cells: fundingCells(FX_DIS_001), negativeDeltaExplanation: null };
      await owner("update machvon.report_revision set status = 'SUBMITTED', submitted_by = $2, submitted_at = now() where id = $1", [made.id, memberId(MAKER)]);
      expect(await refusal(as((tx) => store.saveDraft(tx, { ...head, status: 'SUBMITTED' }, content, memberId(MAKER))))).toMatchObject({ code: 'REVISION_IMMUTABLE', status: 409, extensions: { report_status: 'SUBMITTED' } });
      expect(await refusal(as((tx) => store.saveDraft(tx, { ...head, deleted: true }, content, memberId(MAKER))))).toMatchObject({ code: 'REVISION_IMMUTABLE' });
    });

    it('is for the maker who acts on the project: another branch is 404, a reader 403, another tenant 404', async () => {
      const made = await create(await freshProject(), await newPeriod(), id(FAMILY, 300 + counter));
      expect(await refusal(as((tx) => store.lock(tx, made.id, elsewhereOnly, actsAll, 1)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => store.lock(tx, made.id, seeAll, readOnly, 1)))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(as((tx) => store.lock(tx, made.id, seeAll, actsAll, 1), TENANT_B))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(await refusal(as((tx) => store.lock(tx, randomUUID(), seeAll, actsAll, 1)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });
  });

  const newPeriod = async (): Promise<string> => {
    const periodId = randomUUID();
    await seedReplica([weekRow(periodId, `NP-${randomUUID().slice(0, 8)}`)]);
    return periodId;
  };

  describe('what the table refuses', () => {
    async function submitted(): Promise<string> {
      const made = await create(await freshProject(), await newPeriod(), id(FAMILY, 300 + counter));
      await owner("update machvon.report_revision set status = 'SUBMITTED', submitted_by = $2, submitted_at = now() where id = $1", [made.id, memberId(MAKER)]);
      return made.id;
    }

    it('keeps the cells of a revision that was handed in: not edited, not added to, not deleted', async () => {
      const reportId = await submitted();
      await expect(owner("update machvon.funding_snapshot_line set disbursed_cumulative_vnd = 1 where report_revision_id = $1 and bucket = 'OTHER' and budget_level = 'LOCAL'", [reportId])).rejects.toMatchObject({
        code: '23514',
        constraint: 'funding_snapshot_line_immutable_guard',
      });
      await expect(owner('delete from machvon.funding_snapshot_line where report_revision_id = $1', [reportId])).rejects.toMatchObject({ code: '23514', constraint: 'funding_snapshot_line_guard' });
      await expect(
        owner("insert into machvon.funding_snapshot_line (tenant_id, id, report_revision_id, bucket, budget_level, disbursed_cumulative_vnd, next_month_registered_vnd) values ($1, gen_random_uuid(), $2, 'OTHER', 'CENTRAL', 1, 0)", [TENANT_A, reportId]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'funding_snapshot_line_immutable_guard' });
    });

    it('keeps the place of a cell in its report and the amount the plan allocated to it, even in a draft', async () => {
      const made = await create(await freshProject(), await newPeriod(), id(FAMILY, 300 + counter));
      await expect(owner("update machvon.funding_snapshot_line set allocated_vnd = 1 where report_revision_id = $1 and bucket = 'OTHER' and budget_level = 'LOCAL'", [made.id])).rejects.toMatchObject({
        constraint: 'funding_snapshot_line_identity_guard',
      });
      await expect(owner("update machvon.funding_snapshot_line set bucket = 'OTHER' where report_revision_id = $1 and bucket = 'CARRYOVER' and budget_level = 'LOCAL'", [made.id])).rejects.toMatchObject({
        constraint: 'funding_snapshot_line_identity_guard',
      });
    });

    it('checks the money of a cell: not negative, the CTMTQG inside its cell and absent from the other sources, one cell once', async () => {
      const made = await create(await freshProject(), await newPeriod(), id(FAMILY, 300 + counter));
      const update = (set: string, bucket: string, level: string) => owner(`update machvon.funding_snapshot_line set ${set} where report_revision_id = $1 and bucket = '${bucket}' and budget_level = '${level}'`, [made.id]);
      await expect(update('disbursed_cumulative_vnd = -1', 'OTHER', 'LOCAL')).rejects.toMatchObject({ constraint: 'funding_line_money_chk' });
      await expect(update('ctmtqg_subset_vnd = 100000001', 'CURRENT_YEAR', 'CENTRAL')).rejects.toMatchObject({ constraint: 'funding_line_subset_chk' });
      await expect(update('ctmtqg_subset_vnd = 1', 'OTHER', 'LOCAL')).rejects.toMatchObject({ constraint: 'funding_line_ctmtqg_bucket_chk' });
      await expect(
        owner("insert into machvon.funding_snapshot_line (tenant_id, id, report_revision_id, bucket, budget_level, disbursed_cumulative_vnd, next_month_registered_vnd) values ($1, gen_random_uuid(), $2, 'OTHER', 'LOCAL', 1, 0)", [TENANT_A, made.id]),
      ).rejects.toMatchObject({ constraint: 'funding_line_cell_uq' });
    });

    it('keeps the identity of a revision for good and refuses to edit or delete one that was handed in', async () => {
      const reportId = await submitted();
      for (const set of ["project_id = '" + project.b + "'", "period_id = '" + period.w40 + "'", "plan_version_id = '" + plan.later + "'", 'revision = 2', "report_type = 'MONTHLY'", "created_by = '" + memberId(OTHER) + "'"]) {
        await expect(owner(`update machvon.report_revision set ${set} where id = $1`, [reportId])).rejects.toMatchObject({ code: '23514' });
      }
      await expect(owner("update machvon.report_revision set measurement_basis = 'PERIOD' where id = $1", [reportId])).rejects.toMatchObject({ constraint: 'report_revision_immutable_guard' });
      await expect(owner("update machvon.report_revision set payload_hash = repeat('b', 64) where id = $1", [reportId])).rejects.toMatchObject({ constraint: 'report_revision_immutable_guard' });
      await expect(owner("update machvon.report_revision set negative_delta_explanation = 'Another explanation.' where id = $1", [reportId])).rejects.toMatchObject({ constraint: 'report_revision_immutable_guard' });
      await expect(owner('delete from machvon.report_revision where id = $1', [reportId])).rejects.toMatchObject({ code: '23514', constraint: 'report_revision_guard' });
      // The review moves it: the status and the people are not content.
      await expect(owner("update machvon.report_revision set status = 'UNDER_REVIEW' where id = $1", [reportId])).resolves.toBeDefined();
    });

    it('checks the basis, the explanation, the deletion mark and the amendment of a revision', async () => {
      const made = await create(await freshProject(), await newPeriod(), id(FAMILY, 300 + counter));
      await expect(owner("update machvon.report_revision set measurement_basis = 'WEEKLY' where id = $1", [made.id])).rejects.toMatchObject({ constraint: 'report_revision_basis_chk' });
      await expect(owner("update machvon.report_revision set negative_delta_explanation = 'short' where id = $1", [made.id])).rejects.toMatchObject({ constraint: 'report_revision_explanation_chk' });
      await expect(owner("update machvon.report_revision set deleted_at = now() where id = $1", [made.id])).rejects.toMatchObject({ constraint: 'report_revision_delete_pair_chk' });
      await expect(owner("update machvon.report_revision set revision = 2 where id = $1", [made.id])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('reading', () => {
    it('shows a report with its project, period and plan, the cells with what the period before had reached, and a fall as a negative delta', async () => {
      const projectId = await freshProject();
      const planId = id(FAMILY, 300 + counter);
      const before = randomUUID();
      const periodId = randomUUID();
      await seedReplica([weekRow(before, `RD1-${counter}`), weekRow(periodId, `RD2-${counter}`)]);
      const earlier = await create(projectId, before, planId, { cells: fundingCells([{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '300' }, { bucket: 'CARRYOVER', budget_level: 'LOCAL', cumulative_vnd: '10' }]) });
      await owner("update machvon.report_revision set status = 'ACCEPTED', is_current = true, submitted_by = $2, accepted_by = $3, submitted_at = now(), accepted_at = now() where id = $1", [earlier.id, memberId(MAKER), memberId(OTHER)]);
      const made = await create(projectId, periodId, planId, { cells: fundingCells([{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '250', ctmtqg_subset_vnd: '50' }, { bucket: 'CARRYOVER', budget_level: 'LOCAL', cumulative_vnd: '40' }]) });
      const detail = await as((tx) => store.find(tx, made.id, seeAll));
      expect(detail).toMatchObject({
        id: made.id,
        revision: 1,
        status: 'DRAFT',
        version: 1,
        measurementBasis: 'YTD',
        reportType: 'WEEKLY',
        project: { id: projectId, status: 'IMPLEMENTATION' },
        period: { id: periodId, fiscalYear: 2040, periodType: 'WEEK' },
        plan: { id: planId, projectId, fiscalYear: 2026, revision: 1, status: 'PUBLISHED' },
      });
      expect(detail?.lines.map((line) => [line.bucket, line.budgetLevel, line.cumulativeVnd, line.previousCumulativeVnd, line.deltaVnd])).toEqual([
        ['CURRENT_YEAR', 'CENTRAL', '250', '300', '-50'],
        ['CURRENT_YEAR', 'LOCAL', '0', '0', '0'],
        ['CARRYOVER', 'CENTRAL', '0', '0', '0'],
        ['CARRYOVER', 'LOCAL', '40', '10', '30'],
        ['OTHER', 'CENTRAL', '0', '0', '0'],
        ['OTHER', 'LOCAL', '0', '0', '0'],
      ]);
      expect(detail?.totals).toMatchObject({ cumulativeVnd: '290', ctmtqgVnd: '50', allocatedVnd: '0' });
    });

    it('does not show a report of a project outside the scope, nor of another tenant, nor one that is not there', async () => {
      const made = await create(await freshProject(), await newPeriod(), id(FAMILY, 300 + counter));
      expect(await as((tx) => store.find(tx, made.id, elsewhereOnly))).toBeUndefined();
      expect(await as((tx) => store.find(tx, made.id, seeAll), TENANT_B)).toBeUndefined();
      expect(await as((tx) => store.find(tx, randomUUID(), seeAll))).toBeUndefined();
    });

    it('lists the reports newest first with their totals, a page at a time, in the scope of the caller, without a draft that was deleted', async () => {
      const projectId = await freshProject();
      const planId = id(FAMILY, 300 + counter);
      const made: Made[] = [];
      for (const index of [0, 1, 2]) {
        const periodId = await newPeriod();
        made.push(await create(projectId, periodId, planId, { cells: fundingCells([{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: String(100 * (index + 1)), ctmtqg_subset_vnd: String(10 * (index + 1)) }]) }));
      }
      const filter = { projectId };
      const first = await as((tx) => store.list(tx, seeAll, filter, { limit: 2, after: undefined }));
      expect(first.map((line) => line.id)).toEqual([made[2]?.id, made[1]?.id]);
      expect(first[0]).toMatchObject({ project: { id: projectId }, revision: 1, status: 'DRAFT', reportType: 'WEEKLY', cumulativeVnd: '300', ctmtqgVnd: '30', version: 1, isLate: false });
      const last = first[1] as (typeof first)[number];
      const second = await as((tx) => store.list(tx, seeAll, filter, { limit: 2, after: { createdAt: last.createdAt, id: last.id } }));
      expect(second.map((line) => line.id)).toEqual([made[0]?.id]);
      expect(await as((tx) => store.list(tx, elsewhereOnly, filter, { limit: 10, after: undefined }))).toEqual([]);
      expect(await as((tx) => store.list(tx, seeAll, filter, { limit: 10, after: undefined }), TENANT_B)).toEqual([]);
      await owner("update machvon.report_revision set deleted_at = now(), deleted_reason = 'Entered in error' where id = $1", [made[1]?.id]);
      expect((await as((tx) => store.list(tx, seeAll, filter, { limit: 10, after: undefined }))).map((line) => line.id)).toEqual([made[2]?.id, made[0]?.id]);
    });

    it('filters the list by year, period, plan, project, status and type, and gives the figures of the filter apart from the figures of the whole scope', async () => {
      const projectId = await freshProject();
      const planId = id(FAMILY, 300 + counter);
      const periodId = await newPeriod();
      const made = await create(projectId, periodId, planId, { cells: fundingCells([{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '700', ctmtqg_subset_vnd: '70' }]) });
      await owner("update machvon.report_revision set status = 'SUBMITTED', submitted_by = $2, submitted_at = now() where id = $1", [made.id, memberId(MAKER)]);
      const page = (filter: object) => as((tx) => store.list(tx, seeAll, filter, { limit: 100, after: undefined }));
      expect((await page({ projectId })).map((line) => line.id)).toEqual([made.id]);
      expect((await page({ periodId })).map((line) => line.id)).toEqual([made.id]);
      expect((await page({ planVersionId: planId, status: 'SUBMITTED', reportType: 'WEEKLY', fiscalYear: 2040 })).map((line) => line.id)).toEqual([made.id]);
      const capitalPlan = randomUUID();
      await seedReplica([['update machvon.plan_version set capital_plan_id = $2 where id = $1', [planId, capitalPlan]]]);
      expect((await page({ planId: capitalPlan })).map((line) => line.id)).toEqual([made.id]);
      expect(await page({ planId: randomUUID() })).toEqual([]);
      for (const miss of [{ status: 'DRAFT' }, { reportType: 'MONTHLY' }, { fiscalYear: 1999 }, { planVersionId: plan.later }, { periodId: period.w40 }, { projectId: project.b }]) {
        expect((await page({ projectId, ...miss })).map((line) => line.id)).toEqual([]);
      }
      const filtered = await as((tx) => store.kpi(tx, seeAll, { projectId }));
      expect(filtered).toEqual({ reports: 1, projects: 1, cumulativeVnd: '700', ctmtqgVnd: '70' });
      const everything = await as((tx) => store.kpi(tx, seeAll, {}));
      expect(everything.reports).toBeGreaterThan(filtered.reports);
      expect(BigInt(everything.cumulativeVnd)).toBeGreaterThan(BigInt(filtered.cumulativeVnd));
      expect(await as((tx) => store.kpi(tx, elsewhereOnly, { projectId }))).toEqual({ reports: 0, projects: 0, cumulativeVnd: '0', ctmtqgVnd: '0' });
      expect(await as((tx) => store.kpi(tx, seeAll, {}), TENANT_B)).toEqual({ reports: 0, projects: 0, cumulativeVnd: '0', ctmtqgVnd: '0' });
    });
  });
});

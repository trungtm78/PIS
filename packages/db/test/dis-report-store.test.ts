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

/** A save that names none of the volumes, the narrative and the files: it keeps them. */
const KEEP = { progress: undefined, narrative: undefined, attachments: undefined };

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
  progress: null,
  narrative: null,
  attachments: [],
  asOfDate: '2026-10-04',
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
        // A report is handed in before it is accepted: the table lets it move along the graph only.
        await owner("update machvon.report_revision set status = 'SUBMITTED', submitted_by = $2, submitted_at = now() where id = $1", [made.id, memberId(MAKER)]);
        if ((options.status ?? 'ACCEPTED') === 'ACCEPTED') {
          await owner("update machvon.report_revision set status = 'ACCEPTED', is_current = $2, accepted_by = $3, accepted_at = now() where id = $1", [made.id, options.current ?? true, memberId(OTHER)]);
        }
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
        draftHash({ projectId: project.a, periodId: period.w40, planVersionId: plan.published, reportType: 'WEEKLY', measurementBasis: 'YTD', cells: fundingCells(FX_DIS_001), negativeDeltaExplanation: null, progress: null, narrative: null, attachments: [] }),
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
      const saved = await as((tx) => store.saveDraft(tx, head, { ...KEEP, measurementBasis: 'PERIOD', cells: next, negativeDeltaExplanation: 'The Treasury returned a payment.' }, '2026-10-04', memberId(MAKER)));
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
      const content = { ...KEEP, measurementBasis: 'YTD' as const, cells: fundingCells(FX_DIS_001), negativeDeltaExplanation: null };
      const first = await as((tx) => store.saveDraft(tx, head, content, '2026-10-04', memberId(MAKER)));
      const second = await as((tx) => store.saveDraft(tx, { ...head, version: first.version }, content, '2026-10-04', memberId(MAKER)));
      expect(second.payloadHash).toBe(first.payloadHash);
    });

    it('does not edit a revision that was handed in (409 REVISION_IMMUTABLE), nor one that was deleted', async () => {
      const made = await create(await freshProject(), await newPeriod(), id(FAMILY, 300 + counter));
      const head = await lockFor(made.id, 1);
      const content = { ...KEEP, measurementBasis: 'YTD' as const, cells: fundingCells(FX_DIS_001), negativeDeltaExplanation: null };
      await owner("update machvon.report_revision set status = 'SUBMITTED', submitted_by = $2, submitted_at = now() where id = $1", [made.id, memberId(MAKER)]);
      expect(await refusal(as((tx) => store.saveDraft(tx, { ...head, status: 'SUBMITTED' }, content, '2026-10-04', memberId(MAKER))))).toMatchObject({ code: 'REVISION_IMMUTABLE', status: 409, extensions: { report_status: 'SUBMITTED' } });
      expect(await refusal(as((tx) => store.saveDraft(tx, { ...head, deleted: true }, content, '2026-10-04', memberId(MAKER))))).toMatchObject({ code: 'REVISION_IMMUTABLE' });
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
      await owner("update machvon.report_revision set status = 'SUBMITTED', submitted_by = $2, submitted_at = now() where id = $1", [earlier.id, memberId(MAKER)]);
      await owner("update machvon.report_revision set status = 'ACCEPTED', is_current = true, accepted_by = $2, accepted_at = now() where id = $1", [earlier.id, memberId(OTHER)]);
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

  describe('the volumes, the narrative and the files (ST-DIS-004)', () => {
    const lockFor = (reportId: string, version: number) => as((tx) => store.lock(tx, reportId, seeAll, actsAll, version));
    const PROGRESS = { constructionVnd: '300000000', acceptanceVnd: '200000000', treasurySubmittedVnd: '150000000', preparingDossierVnd: '50000000', physicalProgressPct: '37.50' };
    const NARRATIVE = { resultsText: 'Foundations done.', causesText: null, solutionsText: 'Add a second shift.', proposalsText: null, linkedIssueIds: [] as string[] };
    const fileOf = (name: string, size = 1000) => ({ fileObjectId: randomUUID(), fileSha256: 'b'.repeat(64), fileName: name, contentType: 'application/pdf', sizeBytes: size });
    const content = (overrides: object = {}) => ({ ...KEEP, measurementBasis: 'YTD' as const, cells: fundingCells(FX_DIS_001), negativeDeltaExplanation: null, ...overrides });
    const save = async (reportId: string, version: number, overrides: object = {}, asOf = '2026-10-04') => {
      const head = await lockFor(reportId, version);
      return as((tx) => store.saveDraft(tx, head, content(overrides), asOf, memberId(MAKER)));
    };
    const progressRows = (reportId: string) =>
      owner<{ construction: string; acceptance: string; treasury: string; preparing: string; pct: string | null; as_of: string; basis: string }>(
        `select construction_value_vnd::text as construction, acceptance_value_vnd::text as acceptance, treasury_submitted_value_vnd::text as treasury, preparing_dossier_value_vnd::text as preparing,
                physical_progress_pct::text as pct, as_of_date::text as as_of, measurement_basis as basis from machvon.progress_snapshot where report_revision_id = $1`,
        [reportId],
      );
    const fresh = async (overrides: Partial<NewDraft> = {}): Promise<{ made: Made; projectId: string }> => {
      const projectId = await freshProject();
      const made = await create(projectId, await newPeriod(), id(FAMILY, 300 + counter), overrides);
      return { made, projectId };
    };

    it('AC-ST-DIS-004-1: stores the volumes with the date of the period, the basis of the report and the percent, and reads them back', async () => {
      const { made } = await fresh();
      expect(await progressRows(made.id)).toEqual([]);
      const saved = await save(made.id, 1, { progress: PROGRESS });
      expect(await progressRows(made.id)).toEqual([{ construction: '300000000', acceptance: '200000000', treasury: '150000000', preparing: '50000000', pct: '37.50', as_of: '2026-10-04', basis: 'YTD' }]);
      const detail = await as((tx) => store.find(tx, made.id, seeAll));
      expect(detail?.progress).toEqual({ ...PROGRESS, asOfDate: '2026-10-04', measurementBasis: 'YTD' });
      expect((await state(made.id)).hash).toBe(saved.payloadHash);
      // The same volumes again give the same hash, and one amount more gives another.
      const again = await save(made.id, saved.version, { progress: PROGRESS });
      expect(again.payloadHash).toBe(saved.payloadHash);
      expect((await save(made.id, again.version, { progress: { ...PROGRESS, constructionVnd: '300000001' } })).payloadHash).not.toBe(saved.payloadHash);
    });

    it('keeps the volumes, the narrative and the files when a save does not name them, and moves the volumes to a new basis', async () => {
      const { made } = await fresh();
      const file = fileOf('voucher.pdf');
      const first = await save(made.id, 1, { progress: PROGRESS, narrative: NARRATIVE, attachments: [file] });
      const second = await save(made.id, first.version, { measurementBasis: 'PERIOD' });
      expect(second.payloadHash).not.toBe(first.payloadHash);
      expect((await progressRows(made.id))[0]).toMatchObject({ construction: '300000000', basis: 'PERIOD' });
      const detail = await as((tx) => store.find(tx, made.id, seeAll));
      expect(detail?.narrative).toEqual(NARRATIVE);
      expect(detail?.attachments.map((entry) => [entry.fileObjectId, entry.fileName, entry.position])).toEqual([[file.fileObjectId, 'voucher.pdf', 1]]);
      // Naming the same content again, whatever the order the screen sent it in, is the same hash.
      const third = await save(made.id, second.version, { measurementBasis: 'PERIOD', progress: PROGRESS, narrative: NARRATIVE, attachments: [file] });
      expect(third.payloadHash).toBe(second.payloadHash);
    });

    it('writes the volumes, the narrative and the files of a new draft with it', async () => {
      const file = fileOf('scan.pdf', 2048);
      const { made } = await fresh({ progress: PROGRESS, narrative: { ...NARRATIVE, proposalsText: 'Release the tranche' }, attachments: [file] });
      const detail = await as((tx) => store.find(tx, made.id, seeAll));
      expect(detail).toMatchObject({ progress: { constructionVnd: '300000000', asOfDate: '2026-10-04' }, narrative: { proposalsText: 'Release the tranche' } });
      expect(detail?.attachments[0]).toMatchObject({ fileObjectId: file.fileObjectId, fileSha256: 'b'.repeat(64), contentType: 'application/pdf', sizeBytes: 2048, createdBy: memberId(MAKER) });
      expect((await state(made.id)).hash).toBe(
        draftHash({
          projectId: detail?.projectId ?? '',
          periodId: detail?.periodId ?? '',
          planVersionId: detail?.planVersionId ?? '',
          reportType: 'WEEKLY',
          measurementBasis: 'YTD',
          cells: fundingCells(FX_DIS_001),
          negativeDeltaExplanation: null,
          progress: PROGRESS,
          narrative: { ...NARRATIVE, proposalsText: 'Release the tranche' },
          attachments: [{ fileObjectId: file.fileObjectId, fileSha256: file.fileSha256, fileName: 'scan.pdf' }],
        }),
      );
    });

    it('replaces the narrative as a whole, removes it when the save leaves none, and counts its versions', async () => {
      const { made } = await fresh();
      const first = await save(made.id, 1, { narrative: NARRATIVE });
      const second = await save(made.id, first.version, { narrative: { resultsText: null, causesText: 'Rain', solutionsText: null, proposalsText: null, linkedIssueIds: [] } });
      expect(await as((tx) => store.narrativeOf(tx, made.id))).toEqual({ resultsText: null, causesText: 'Rain', solutionsText: null, proposalsText: null, linkedIssueIds: [] });
      expect((await owner<{ version: string }>('select version::text as version from machvon.report_narrative where report_revision_id = $1', [made.id]))[0]?.version).toBe('2');
      await save(made.id, second.version, { narrative: null });
      expect(await as((tx) => store.narrativeOf(tx, made.id))).toBeNull();
      expect(await owner('select 1 from machvon.report_narrative where report_revision_id = $1', [made.id])).toEqual([]);
    });

    it('writes the files as the whole list: the ones no longer named are unlinked, the ones that stay keep their row, and the order is the order of the list', async () => {
      const { made } = await fresh();
      const [one, two, three] = [fileOf('one.pdf'), fileOf('two.pdf'), fileOf('three.pdf')];
      const first = await save(made.id, 1, { attachments: [one, two] });
      const before = await owner<{ id: string; file_object_id: string }>('select id, file_object_id from machvon.report_attachment where report_revision_id = $1', [made.id]);
      const second = await save(made.id, first.version, { attachments: [three, { ...two, fileName: 'two-renamed.pdf' }] });
      const rows = await as((tx) => store.attachmentsOf(tx, made.id));
      expect(rows.map((row) => [row.fileName, row.position])).toEqual([
        ['three.pdf', 1],
        ['two-renamed.pdf', 2],
      ]);
      expect(rows.find((row) => row.fileObjectId === two.fileObjectId)?.id).toBe(before.find((row) => row.file_object_id === two.fileObjectId)?.id);
      await save(made.id, second.version, { attachments: [] });
      expect(await as((tx) => store.attachmentsOf(tx, made.id))).toEqual([]);
    });

    it('refuses in the table a narrative with nothing in it, a text above 4000 characters, more than 50 issues, a file twice, a 21st file and a name that is not one', async () => {
      const { made } = await fresh();
      const insertNarrative = (results: string | null, issues: string[] | null) =>
        owner(
          `insert into machvon.report_narrative (tenant_id, id, report_revision_id, results_text, linked_issue_ids, created_by, updated_by) values ($1, gen_random_uuid(), $2, $3, $4::uuid[], $5, $5)`,
          [TENANT_A, made.id, results, issues, memberId(MAKER)],
        );
      await expect(insertNarrative(null, null)).rejects.toMatchObject({ constraint: 'report_narrative_not_empty_chk' });
      await expect(insertNarrative(null, [])).rejects.toMatchObject({ constraint: 'report_narrative_not_empty_chk' });
      await expect(insertNarrative('x'.repeat(4001), null)).rejects.toMatchObject({ constraint: 'report_narrative_text_chk' });
      await expect(insertNarrative(' padded ', null)).rejects.toMatchObject({ constraint: 'report_narrative_text_chk' });
      await expect(insertNarrative(null, Array.from({ length: 51 }, () => randomUUID()))).rejects.toMatchObject({ constraint: 'report_narrative_issues_chk' });
      const insertFile = (fileObjectId: string, name: string, position: number) =>
        owner(
          `insert into machvon.report_attachment (tenant_id, id, report_revision_id, file_object_id, file_sha256, file_name, content_type, size_bytes, position, created_by)
           values ($1, gen_random_uuid(), $2, $3, $4, $5, 'application/pdf', 10, $6, $7)`,
          [TENANT_A, made.id, fileObjectId, 'c'.repeat(64), name, position, memberId(MAKER)],
        );
      const same = randomUUID();
      await insertFile(same, 'a.pdf', 1);
      await expect(insertFile(same, 'b.pdf', 2)).rejects.toMatchObject({ constraint: 'report_attachment_file_uq' });
      await expect(insertFile(randomUUID(), 'c.pdf', 1)).rejects.toMatchObject({ constraint: 'report_attachment_position_uq' });
      await expect(insertFile(randomUUID(), 'd.pdf', 21)).rejects.toMatchObject({ code: '23514' });
      await expect(insertFile(randomUUID(), ' padded.pdf', 3)).rejects.toMatchObject({ code: '23514' });
      await expect(insertFile(randomUUID(), '', 3)).rejects.toMatchObject({ code: '23514' });
    });

    it('does not edit what belongs to a report that was handed in, nor let it move to another report, nor read on another basis than the report', async () => {
      const { made } = await fresh({ progress: PROGRESS, narrative: NARRATIVE, attachments: [fileOf('a.pdf')] });
      const other = await fresh();
      await expect(owner("update machvon.progress_snapshot set measurement_basis = 'PERIOD' where report_revision_id = $1", [made.id])).rejects.toMatchObject({ constraint: 'progress_snapshot_basis_guard' });
      await expect(owner('update machvon.report_narrative set report_revision_id = $2 where report_revision_id = $1', [made.id, other.made.id])).rejects.toMatchObject({ constraint: 'report_child_identity_guard' });
      await owner("update machvon.report_revision set status = 'SUBMITTED', submitted_by = $2, submitted_at = now() where id = $1", [made.id, memberId(MAKER)]);
      await expect(owner('update machvon.progress_snapshot set construction_value_vnd = 1 where report_revision_id = $1', [made.id])).rejects.toMatchObject({ constraint: 'report_child_immutable_guard' });
      await expect(owner("update machvon.report_narrative set results_text = 'changed' where report_revision_id = $1", [made.id])).rejects.toMatchObject({ constraint: 'report_child_immutable_guard' });
      await expect(owner('delete from machvon.report_narrative where report_revision_id = $1', [made.id])).rejects.toMatchObject({ constraint: 'report_child_immutable_guard' });
      await expect(owner('delete from machvon.report_attachment where report_revision_id = $1', [made.id])).rejects.toMatchObject({ constraint: 'report_child_immutable_guard' });
      await expect(owner('delete from machvon.progress_snapshot where report_revision_id = $1', [made.id])).rejects.toMatchObject({ constraint: 'report_child_immutable_guard' });
      expect(await progressRows(made.id)).toHaveLength(1);
      // A save through the store is refused first, with the status.
      const head = await lockFor(made.id, 1);
      expect(await refusal(as((tx) => store.saveDraft(tx, head, content({ progress: PROGRESS }), '2026-10-04', memberId(MAKER))))).toMatchObject({ code: 'REVISION_IMMUTABLE', status: 409 });
    });

    it('refuses in the table a volume below zero and a percent above 100', async () => {
      const { made } = await fresh();
      const insert = (construction: string, pct: string | null, asOf: string | null) =>
        owner(
          `insert into machvon.progress_snapshot (tenant_id, id, report_revision_id, construction_value_vnd, acceptance_value_vnd, treasury_submitted_value_vnd, preparing_dossier_value_vnd, measurement_basis, as_of_date, physical_progress_pct)
           values ($1, gen_random_uuid(), $2, $3::numeric, 0, 0, 0, 'YTD', $4::date, $5::numeric)`,
          [TENANT_A, made.id, construction, asOf, pct],
        );
      await expect(insert('-1', null, '2026-10-04')).rejects.toMatchObject({ constraint: 'progress_money_chk' });
      await expect(insert('1', '100.01', '2026-10-04')).rejects.toBeDefined();
    });

    it('says which of the issues named are not issues of the project', async () => {
      const { projectId } = await fresh();
      const mine = randomUUID();
      const elsewhere = randomUUID();
      const issueRow = (n: string, owner_project: string): [string, unknown[]] => [
        `insert into machvon.issue
           (tenant_id, id, project_id, category_version_id, severity, assignee_id, due_at, status, version, code, title, description, source_module, reported_by, opened_at, owner_unit_id, sla_policy_id, response_due_at)
         values ($1, $2, $3, $4, 'MEDIUM', $5, now() + interval '7 days', 'OPEN', 1, $6, 'An issue', 'It is an issue', 'MANUAL', $5, now(), $7, $4, now() + interval '1 day')`,
        [TENANT_A, n, owner_project, FUND_SOURCE, memberId(MAKER), `VM-2026-${String(100000 + (counter += 1))}`, unitId(DEPARTMENT)],
      ];
      await seedReplica([issueRow(mine, projectId), issueRow(elsewhere, project.b)]);
      const unknown = randomUUID();
      expect(await as((tx) => store.issuesOutside(tx, projectId, [mine, elsewhere, unknown]))).toEqual([elsewhere, unknown]);
      expect(await as((tx) => store.issuesOutside(tx, projectId, [mine]))).toEqual([]);
      expect(await as((tx) => store.issuesOutside(tx, projectId, []))).toEqual([]);
      expect(await as((tx) => store.issuesOutside(tx, projectId, [mine]), TENANT_B)).toEqual([mine]);
    });

    it('adds up what the Treasury paid on the days it booked it in the window, takes the refunds off, and says nothing when it booked nothing', async () => {
      const projectId = await freshProject();
      const paid = (amount: string, at: string, refundOf: string | null = null, n = randomUUID()): [string, unknown[]] => [
        `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, direction, reversal_of_id, import_id)
         values ($1, $2, $3, $4, 'TREASURY', $5::numeric, $6::timestamptz, $7, $8, $9, gen_random_uuid())`,
        [TENANT_A, n, projectId, `EXT-${n}`, amount, at, 'd'.repeat(64), refundOf === null ? 'PAYMENT' : 'REFUND', refundOf],
      ];
      const first = randomUUID();
      await seedReplica([
        paid('500000000', '2026-09-30T08:00:00+07:00', null, first),
        paid('300000000', '2026-10-01T09:00:00+07:00'),
        paid('50000000', '2026-10-02T09:00:00+07:00', first),
        paid('7', '2025-12-31T23:30:00+07:00'),
      ]);
      const figure = (from: string | null, to: string) => as((tx) => store.treasuryFigure(tx, projectId, { from, to }));
      // The day a payment counts on is the day of the Vietnam clock: the booking of 23:30 on 31 December is in 2025.
      expect(await figure('2026-01-01', '2026-09-30')).toEqual({ totalVnd: '500000000', transactions: 1 });
      expect(await figure('2026-01-01', '2026-10-04')).toEqual({ totalVnd: '750000000', transactions: 3 });
      expect(await figure('2026-10-01', '2026-10-04')).toEqual({ totalVnd: '250000000', transactions: 2 });
      expect(await figure(null, '2026-10-04')).toEqual({ totalVnd: '750000007', transactions: 4 });
      expect(await figure(null, '2025-12-31')).toEqual({ totalVnd: '7', transactions: 1 });
      expect(await figure('2026-10-03', '2026-10-04')).toBeUndefined();
      expect(await as((tx) => store.treasuryFigure(tx, projectId, { from: null, to: '2030-01-01' }), TENANT_B)).toBeUndefined();
    });
  });

  describe('the decision of a reviewer and the chain of corrections (ST-DIS-006)', () => {
    const REVIEWER = OTHER;
    const AT = new Date('2026-10-27T03:00:00.000Z');
    const DUE = new Date('2026-11-03T03:00:00.000Z');
    const approval = { decision: 'approve', reason: 'The figures agree with the Treasury.', evidenceIds: [], returnItems: [], dueAt: null } as const;
    const giveBack = { decision: 'return', reason: 'The CTMTQG cell is wrong.', evidenceIds: [], returnItems: ['Fix the CTMTQG cell', 'Explain the fall'], dueAt: DUE } as const;
    const amendment = { decision: 'request_amendment', reason: 'The Treasury corrected a payment of March.', evidenceIds: [], returnItems: [], dueAt: null } as const;

    const headOf = async (reportId: string, member = MAKER) => as(async (tx) => store.lock(tx, reportId, seeAll, actsAll, Number((await state(reportId)).version)), TENANT_A, member);
    async function handIn(reportId: string): Promise<void> {
      const head = await headOf(reportId);
      await as((tx) => store.submit(tx, head, { actor: memberId(MAKER), at: new Date('2026-10-26T03:00:00.000Z'), late: false, payloadHash: head.payloadHash, workflowVersionId: undefined }));
    }
    /** A report of a fresh project in a period of its own, handed in by the maker (member 1). */
    async function submitted(): Promise<{ id: string; projectId: string; periodId: string; planId: string }> {
      const projectId = await freshProject();
      const planId = id(FAMILY, 300 + counter);
      const week = nextWeek();
      const periodId = id(FAMILY, 2000 + weeks);
      await seedReplica([periodRow(periodId, `DC-W${weeks}`, week.start, week.end, 'WEEK', week.year)]);
      const made = await create(projectId, periodId, planId);
      await handIn(made.id);
      return { id: made.id, projectId, periodId, planId };
    }
    const decide = (reportId: string, input: Parameters<DisReportStore['decide']>[2], member = REVIEWER) =>
      as(async (tx) => store.decide(tx, await store.lock(tx, reportId, seeAll, actsAll, Number((await state(reportId)).version)), input, memberId(member), AT), TENANT_A, member);
    const decisions = (reportId: string) => as((tx) => store.decisionsOf(tx, reportId));

    async function correct(sourceId: string): Promise<{ id: string; version: number; revision: number }> {
      const detail = (await as((tx) => store.find(tx, sourceId, seeAll))) as NonNullable<Awaited<ReturnType<DisReportStore['find']>>>;
      const latest = (await as((tx) => store.latestFor(tx, detail.projectId, detail.periodId))) as NonNullable<Awaited<ReturnType<DisReportStore['latestFor']>>>;
      const input = {
        ...(await draftOf(detail.projectId, detail.periodId, detail.planVersionId)),
        revision: latest.revision + 1,
        supersedesId: sourceId,
        amendmentReason: 'The Treasury corrected a payment of March.',
      };
      return as((tx) => store.createCorrection(tx, input, memberId(MAKER)));
    }

    it('AC-ST-DIS-006-1 / UAT-AC05: accepts a report that was handed in: ACCEPTED, current, who and when, one decision kept, and the version moves once', async () => {
      const report = await submitted();
      const done = await decide(report.id, approval);
      expect(done).toMatchObject({ version: 3, supersededId: null });
      expect(await state(report.id)).toMatchObject({ status: 'ACCEPTED', is_current: true, version: '3' });
      const [row] = await owner<{ accepted_by: string; submitted_by: string }>('select accepted_by, submitted_by from machvon.report_revision where id = $1', [report.id]);
      expect(row).toMatchObject({ accepted_by: memberId(REVIEWER), submitted_by: memberId(MAKER) });
      expect(await decisions(report.id)).toEqual([
        expect.objectContaining({ decision: 'ACCEPTED', reason: 'The figures agree with the Treasury.', returnItems: [], dueAt: null, decidedBy: memberId(REVIEWER), decidedAt: AT.toISOString() }),
      ]);
    });

    it('AC-ST-DIS-006-1: the person who handed the report in does not decide on it, whatever the decision (403 SELF_APPROVAL_DENIED), and the report stays as it was', async () => {
      const report = await submitted();
      for (const input of [approval, giveBack]) expect(await refusal(decide(report.id, input, MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await state(report.id)).toMatchObject({ status: 'SUBMITTED', is_current: false });
      expect(await decisions(report.id)).toEqual([]);
    });

    it('AC-ST-DIS-006-3 / UAT-AC260: returns a report with what to fix and by when: RETURNED with the reason, the items and the day kept', async () => {
      const report = await submitted();
      expect(await decide(report.id, giveBack)).toMatchObject({ version: 3, supersededId: null });
      expect(await state(report.id)).toMatchObject({ status: 'RETURNED', is_current: false });
      expect((await owner<{ returned_reason: string }>('select returned_reason from machvon.report_revision where id = $1', [report.id]))[0]?.returned_reason).toBe('The CTMTQG cell is wrong.');
      expect(await decisions(report.id)).toEqual([expect.objectContaining({ decision: 'RETURNED', returnItems: ['Fix the CTMTQG cell', 'Explain the fall'], dueAt: DUE.toISOString() })]);
    });

    it('asks for an amendment of an accepted report: AMENDMENT_REQUESTED, still the current one until a corrected revision is accepted', async () => {
      const report = await submitted();
      await decide(report.id, approval);
      await decide(report.id, amendment);
      expect(await state(report.id)).toMatchObject({ status: 'AMENDMENT_REQUESTED', is_current: true });
      expect((await decisions(report.id)).map((row) => row.decision)).toEqual(['ACCEPTED', 'AMENDMENT_REQUESTED']);
    });

    it('decides only along the graph: a draft, a returned report and an accepted one are not decided again (409 REPORT_STATE_INVALID, nothing written)', async () => {
      const report = await submitted();
      const draft = await create(await freshProject(), period.w41, id(FAMILY, 300 + counter));
      expect(await refusal(decide(draft.id, approval))).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409 });
      await decide(report.id, giveBack);
      for (const input of [approval, giveBack, amendment]) expect(await refusal(decide(report.id, input))).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409 });
      expect(await decisions(report.id)).toHaveLength(1);
      const accepted = await submitted();
      await decide(accepted.id, approval);
      expect(await refusal(decide(accepted.id, approval))).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409 });
    });

    it('takes the version the reviewer saw (409 VERSION_CONFLICT) and answers 404 outside the scope, 403 for a reader', async () => {
      const report = await submitted();
      expect(await refusal(as((tx) => store.lock(tx, report.id, seeAll, actsAll, 99), TENANT_A, REVIEWER))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(as((tx) => store.lock(tx, report.id, elsewhereOnly, actsAll, 2), TENANT_A, REVIEWER))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => store.lock(tx, report.id, seeAll, readOnly, 2), TENANT_A, REVIEWER))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
    });

    it('BR-DIS-02: the accepted revision is the one current: accepting the next one makes the one before it SUPERSEDED and moves the current mark, in one step', async () => {
      const first = await submitted();
      await decide(first.id, approval);
      await decide(first.id, amendment);
      const second = await correct(first.id);
      await handIn(second.id);
      expect(await decide(second.id, approval)).toMatchObject({ supersededId: first.id });
      expect(await state(first.id)).toMatchObject({ status: 'SUPERSEDED', is_current: false });
      expect(await state(second.id)).toMatchObject({ status: 'ACCEPTED', is_current: true });
      expect((await owner<{ n: string }>('select count(*)::text as n from machvon.report_revision where project_id = $1 and period_id = $2 and is_current', [first.projectId, first.periodId]))[0]?.n).toBe('1');
      // A revision that is plain ACCEPTED is superseded by the next one too.
      const third = await correct(second.id);
      await handIn(third.id);
      expect(await decide(third.id, approval)).toMatchObject({ supersededId: second.id });
      expect(await state(second.id)).toMatchObject({ status: 'SUPERSEDED' });
    });

    it('AC-ST-DIS-006-2 / UAT-AC247: a correction is a new revision in DRAFT that points at the one it corrects with the reason; the revision it corrects keeps its hash', async () => {
      const first = await submitted();
      const before = await state(first.id);
      await decide(first.id, giveBack);
      const second = await correct(first.id);
      expect(second).toMatchObject({ version: 1, revision: 2 });
      expect(await state(second.id)).toMatchObject({ status: 'DRAFT', is_current: false, version: '1' });
      const [row] = await owner<{ supersedes_id: string; amendment_reason: string; revision: number }>('select supersedes_id, amendment_reason, revision from machvon.report_revision where id = $1', [second.id]);
      expect(row).toEqual({ supersedes_id: first.id, amendment_reason: 'The Treasury corrected a payment of March.', revision: 2 });
      expect((await state(first.id)).hash).toBe(before.hash);
      expect(await cells(second.id)).toHaveLength(6);
      // The correction is a draft like any other: it is edited and handed in under the rules of a draft.
      expect(await headOf(second.id)).toMatchObject({ revision: 2, supersedesId: first.id, status: 'DRAFT', amendmentReason: 'The Treasury corrected a payment of March.' });
    });

    it('lets one correction at a time start from a period: another that is waiting is found, whatever it is waiting for', async () => {
      const first = await submitted();
      await decide(first.id, giveBack);
      const second = await correct(first.id);
      expect(await as((tx) => store.pendingFor(tx, first.projectId, first.periodId, first.id))).toMatchObject({ id: second.id, status: 'DRAFT', revision: 2 });
      expect(await as((tx) => store.pendingFor(tx, first.projectId, first.periodId, second.id))).toBeUndefined();
      await handIn(second.id);
      expect(await as((tx) => store.pendingFor(tx, first.projectId, first.periodId, first.id))).toMatchObject({ id: second.id, status: 'SUBMITTED' });
    });

    it('refuses in the table a report that moves off the graph, a decision that is edited or deleted, one by the person who handed the report in, and a return without its items', async () => {
      const report = await submitted();
      await decide(report.id, giveBack);
      const [decided] = await decisions(report.id);
      const guard = (sql: string, params: unknown[] = []) => refusal(owner(sql, params));
      expect(await guard("update machvon.report_revision set status = 'ACCEPTED', is_current = true, accepted_by = $2, accepted_at = now() where id = $1", [report.id, memberId(REVIEWER)])).toMatchObject({ code: '23514' });
      expect(await guard('update machvon.report_decision set reason = $2 where id = $1', [decided?.id, 'Edited later'])).toMatchObject({ code: '23514' });
      expect(await guard('delete from machvon.report_decision where id = $1', [decided?.id])).toMatchObject({ code: '23514' });
      const open = await submitted();
      const insert = (decision: string, by: string, items: string[], due: string | null) =>
        guard(
          `insert into machvon.report_decision (tenant_id, id, report_revision_id, decision, reason, return_items, due_at, decided_by, decided_at)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, 'Reason', $3::text[], $4::timestamptz, $5, now())`,
          [open.id, decision, items, due, by],
        );
      expect(await insert('RETURNED', memberId(MAKER), ['Fix the cell'], DUE.toISOString())).toMatchObject({ code: '23514' });
      expect(await insert('RETURNED', memberId(REVIEWER), [], DUE.toISOString())).toMatchObject({ code: '23514' });
      expect(await insert('RETURNED', memberId(REVIEWER), ['Fix the cell'], null)).toMatchObject({ code: '23514' });
      expect(await insert('ACCEPTED', memberId(REVIEWER), ['Fix the cell'], null)).toMatchObject({ code: '23514' });
      const accepted = await submitted();
      await decide(accepted.id, approval);
      expect(await guard('update machvon.report_revision set accepted_by = $2 where id = $1', [accepted.id, memberId(MAKER)])).toMatchObject({ code: '23514' });
      expect(await guard("update machvon.report_revision set status = 'SUBMITTED', is_current = false where id = $1", [accepted.id])).toMatchObject({ code: '23514' });
    });

    it('keeps the figure of the period while an amendment is asked for: the next period still takes its change from the accepted report, until the corrected one is accepted', async () => {
      const report = await submitted();
      await decide(report.id, approval);
      const detail = (await as((tx) => store.find(tx, report.id, seeAll))) as NonNullable<Awaited<ReturnType<DisReportStore['find']>>>;
      const next = { ...detail.period, startDate: '2041-12-30', endDate: '2042-01-05' };
      const baseline = () => as((tx) => store.previousCumulative(tx, report.projectId, next));
      expect((await baseline()).get('CURRENT_YEAR/CENTRAL')).toBe('100000000');
      await decide(report.id, amendment);
      expect(await state(report.id)).toMatchObject({ status: 'AMENDMENT_REQUESTED', is_current: true });
      expect((await baseline()).get('CURRENT_YEAR/CENTRAL')).toBe('100000000');
      const second = await correct(report.id);
      await handIn(second.id);
      await decide(second.id, approval);
      expect(await state(report.id)).toMatchObject({ status: 'SUPERSEDED', is_current: false });
      expect((await baseline()).get('CURRENT_YEAR/CENTRAL')).toBe('100000000');
    });

    it('keeps what a decision names in the tenant: another tenant reads none of it', async () => {
      const report = await submitted();
      await decide(report.id, giveBack);
      expect(await as((tx) => store.decisionsOf(tx, report.id), TENANT_B)).toEqual([]);
    });

    describe('the withdrawal, the soft deletion and the restore (ST-DIS-007)', () => {
      const WITHDRAWAL = 'The wrong period was reported by mistake.';
      const withdraw = (reportId: string, member = MAKER, at = AT) =>
        as(async (tx) => store.withdraw(tx, await store.lock(tx, reportId, seeAll, actsAll, Number((await state(reportId)).version)), WITHDRAWAL, memberId(member), at), TENANT_A, member);
      const remove = (reportId: string, at = AT, reason = 'Started in the wrong week.') =>
        as(async (tx) => store.softDelete(tx, await store.lock(tx, reportId, seeAll, actsAll, Number((await state(reportId)).version)), reason, memberId(MAKER), at));
      const restore = (reportId: string, now: Date, acts = actsAll) =>
        as(async (tx) => store.restore(tx, await store.lock(tx, reportId, seeAll, acts, Number((await state(reportId)).version)), memberId(MAKER), now));
      const draftOf2 = async () => {
        const projectId = await freshProject();
        const planId = id(FAMILY, 300 + counter);
        const week = nextWeek();
        const periodId = id(FAMILY, 2000 + weeks);
        await seedReplica([periodRow(periodId, `DL-W${weeks}`, week.start, week.end, 'WEEK', week.year)]);
        return { ...(await create(projectId, periodId, planId)), projectId, periodId };
      };
      const listed = (filter: Parameters<DisReportStore['list']>[2], member = MAKER) => as((tx) => store.list(tx, seeAll, filter, { limit: 100, after: undefined }), TENANT_A, member);

      it('AC-ST-DIS-007-3 / UAT-AC259: takes back a report that was handed in and is not under review: WITHDRAWN with who, when and why, and the version moves once', async () => {
        const report = await submitted();
        const done = await withdraw(report.id);
        expect(done).toEqual({ version: 3 });
        expect(await state(report.id)).toMatchObject({ status: 'WITHDRAWN', is_current: false, version: '3' });
        expect((await owner<{ withdrawn_by: string; withdrawn_at: string; withdrawn_reason: string }>('select withdrawn_by, withdrawn_at::text as withdrawn_at, withdrawn_reason from machvon.report_revision where id = $1', [report.id]))[0]).toMatchObject({
          withdrawn_by: memberId(MAKER),
          withdrawn_reason: WITHDRAWAL,
        });
        const detail = await as((tx) => store.find(tx, report.id, seeAll));
        expect(detail).toMatchObject({ status: 'WITHDRAWN', withdrawnBy: memberId(MAKER), withdrawnReason: WITHDRAWAL, withdrawnAt: AT.toISOString() });
      });

      it('AC-ST-DIS-007-3: a report under review, a draft, one that was decided on and one that was withdrawn are not withdrawn (409 REPORT_STATE_INVALID, nothing written)', async () => {
        const reviewing = await submitted();
        await owner("update machvon.report_revision set status = 'UNDER_REVIEW' where id = $1", [reviewing.id]);
        expect(await refusal(withdraw(reviewing.id))).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409, extensions: { report_status: 'UNDER_REVIEW' } });
        const draft = await draftOf2();
        expect(await refusal(withdraw(draft.id))).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409 });
        const accepted = await submitted();
        await decide(accepted.id, approval);
        expect(await refusal(withdraw(accepted.id))).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409 });
        const gone = await submitted();
        await withdraw(gone.id);
        expect(await refusal(withdraw(gone.id))).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409 });
        expect(await state(reviewing.id)).toMatchObject({ status: 'UNDER_REVIEW' });
      });

      it('lets the maker report the period again from a report that was withdrawn: the correction is the next revision of it', async () => {
        const first = await submitted();
        await withdraw(first.id);
        const second = await correct(first.id);
        expect(second).toMatchObject({ revision: 2 });
        expect(await state(second.id)).toMatchObject({ status: 'DRAFT' });
      });

      it('refuses in the table a withdrawal without its facts, a reason that is not words, and the facts of a withdrawal that are edited', async () => {
        const report = await submitted();
        const guard = (sql: string, params: unknown[] = []) => refusal(owner(sql, params));
        expect(await guard("update machvon.report_revision set status = 'WITHDRAWN' where id = $1", [report.id])).toMatchObject({ code: '23514' });
        expect(await guard("update machvon.report_revision set status = 'WITHDRAWN', withdrawn_by = $2, withdrawn_at = now(), withdrawn_reason = 'too short' where id = $1", [report.id, memberId(MAKER)])).toMatchObject({ code: '23514' });
        expect(await guard('update machvon.report_revision set withdrawn_reason = $2 where id = $1', [report.id, WITHDRAWAL])).toMatchObject({ code: '23514' });
        await withdraw(report.id);
        expect(await guard('update machvon.report_revision set withdrawn_reason = $2 where id = $1', [report.id, 'Another reason that is long enough.'])).toMatchObject({ code: '23514' });
        expect(await guard('update machvon.report_revision set withdrawn_at = now() where id = $1', [report.id])).toMatchObject({ code: '23514' });
      });

      it('AC-ST-DIS-007-1 / UAT-AC259: deletes a draft softly with the reason, lists it apart while it can be restored, and restores it as it was', async () => {
        const draft = await draftOf2();
        // The list of the drafts that can be restored runs on the clock of the database, so the deletion is dated by it.
        expect(await remove(draft.id, new Date())).toEqual({ version: 2 });
        expect(await state(draft.id)).toMatchObject({ status: 'DRAFT', version: '2' });
        const [row] = await owner<{ deleted_at: string; deleted_reason: string }>('select deleted_at::text as deleted_at, deleted_reason from machvon.report_revision where id = $1', [draft.id]);
        expect(row?.deleted_reason).toBe('Started in the wrong week.');
        expect((await listed({ projectId: draft.projectId })).map((line) => line.id)).toEqual([]);
        // The drafts that were deleted are listed apart, as long as they can be restored.
        expect((await listed({ projectId: draft.projectId, deleted: true })).map((line) => line.id)).toEqual([draft.id]);
        expect((await as((tx) => store.kpi(tx, seeAll, { projectId: draft.projectId }))).reports).toBe(0);
        expect((await as((tx) => store.kpi(tx, seeAll, { projectId: draft.projectId, deleted: true }))).reports).toBe(1);
        // A draft that was deleted is not edited.
        expect(await refusal(as(async (tx) => store.saveDraft(tx, await store.lock(tx, draft.id, seeAll, actsAll, 2), { measurementBasis: 'YTD', cells: fundingCells(FX_DIS_001), negativeDeltaExplanation: null, ...KEEP }, '2026-10-04', memberId(MAKER))))).toMatchObject({
          code: 'REVISION_IMMUTABLE',
          status: 409,
        });
        expect(await restore(draft.id, new Date(AT.getTime() + 86_400_000))).toEqual({ version: 3 });
        expect(await state(draft.id)).toMatchObject({ status: 'DRAFT', version: '3' });
        expect((await listed({ projectId: draft.projectId })).map((line) => line.id)).toEqual([draft.id]);
        expect((await listed({ projectId: draft.projectId, deleted: true })).map((line) => line.id)).toEqual([]);
        expect(await cells(draft.id)).toHaveLength(6);
      });

      it('AC-ST-DIS-007-1: a report that was handed in is not deleted (409 REPORT_NOT_EDITABLE), nor is a draft twice', async () => {
        const report = await submitted();
        expect(await refusal(remove(report.id))).toMatchObject({ code: 'REPORT_NOT_EDITABLE', status: 409, extensions: { report_status: 'SUBMITTED' } });
        const draft = await draftOf2();
        await remove(draft.id);
        expect(await refusal(remove(draft.id))).toMatchObject({ code: 'REPORT_NOT_EDITABLE', status: 409 });
        expect(await refusal(owner("update machvon.report_revision set deleted_at = now() where id = $1", [report.id]))).toMatchObject({ code: '23514' });
      });

      it('AC-ST-DIS-007-2 / UAT-PLAN-68: restores within 30 days and not after (422 RESTORE_WINDOW_EXPIRED), and only what was deleted (409)', async () => {
        const draft = await draftOf2();
        // The window of the list runs on the clock of the database, so the deletion is dated by it.
        const deletedAt = new Date(Date.now() - 40 * 86_400_000);
        const lastDay = new Date(deletedAt.getTime() + 30 * 86_400_000);
        await remove(draft.id, deletedAt);
        expect(await refusal(restore(draft.id, new Date(lastDay.getTime() + 1000)))).toMatchObject({ code: 'RESTORE_WINDOW_EXPIRED', status: 422 });
        expect((await listed({ projectId: draft.projectId, deleted: true })).map((line) => line.id)).toEqual([]);
        expect(await state(draft.id)).toMatchObject({ status: 'DRAFT', version: '2' });
        expect(await restore(draft.id, lastDay)).toEqual({ version: 3 });
        expect(await refusal(restore(draft.id, lastDay))).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409 });
      });

      it('AC-ST-DIS-007-2: restores only for a person who may edit the project now (403 SCOPE_DENIED, the draft stays deleted); another tenant finds nothing (404)', async () => {
        const draft = await draftOf2();
        await remove(draft.id);
        expect(await refusal(restore(draft.id, AT, readOnly))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
        expect(await state(draft.id)).toMatchObject({ version: '2' });
        expect(await refusal(as((tx) => store.lock(tx, draft.id, seeAll, actsAll, 2), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      });

      it('keeps a deletion as it was made: the instant and the reason are not rewritten while the draft stays deleted', async () => {
        const draft = await draftOf2();
        await remove(draft.id);
        const guard = (sql: string, params: unknown[] = []) => refusal(owner(sql, params));
        expect(await guard('update machvon.report_revision set deleted_reason = $2 where id = $1', [draft.id, 'Another reason'])).toMatchObject({ code: '23514' });
        expect(await guard("update machvon.report_revision set deleted_at = now() where id = $1", [draft.id])).toMatchObject({ code: '23514' });
      });
    });
  });
});

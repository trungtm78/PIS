import { randomUUID } from 'node:crypto';
import { runLoops, tallyOutcomes, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { CapAppropriationStore } from '../src/cap-appropriation-store';
import type { AppropriationInput } from '../src/cap-appropriation-store';
import { CapPlanApprovalStore } from '../src/cap-plan-approval-store';
import type { PlanAuthorizer } from '../src/cap-plan-approval-store';
import { CapPlanPublicationStore } from '../src/cap-plan-publication-store';
import type { PlanReadScope } from '../src/cap-plan-reads';
import { CapPlanStore } from '../src/cap-plan-store';
import type { DraftScopes, LineInput } from '../src/cap-plan-store';
import { CapScheduleStore, achievementRate } from '../src/cap-schedule-store';
import type { ScheduleInput } from '../src/cap-schedule-store';
import { WORKER_MEMBERSHIP_ID } from '../src/consumer-inbox';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { PrjProjectStore, projectScope } from '../src/prj-project-store';
import type { ProjectStatus } from '../src/prj-project-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const appropriations = new CapAppropriationStore();
const plans = new CapPlanStore();
const approvals = new CapPlanApprovalStore();
const publication = new CapPlanPublicationStore();
const projects = new PrjProjectStore();
const schedules = new CapScheduleStore();
const MAKER = 1;
const APPROVER = 2;
const PUBLISHER = 3;
const ROOT = 1;
const BQL1 = 2;
const BQL2 = 3;
const MILLION = 1_000_000;
const TODAY = vietnamDateOf(new Date());

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const allDrafts: PlanReadScope = { lines: everything, drafts: true };
const scopes: DraftScopes = { write: everything, read: allDrafts };
const allow: PlanAuthorizer = () => undefined;
const millions = (n: number): string => String(n * MILLION);
const NOW = new Date('2026-10-20T03:00:00.000Z');

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = MAKER): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
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

let counter = 0;
let yearCounter = 2100;
const freshYear = (): number => {
  yearCounter -= 1;
  return yearCounter;
};
const versions: Record<string, string> = {};

async function seedMaster(name: string, masterType: string, attributes: Record<string, unknown>): Promise<string> {
  counter += 1;
  const recordId = randomUUID();
  const versionId = randomUUID();
  const key = `${name}-${counter}`;
  await harness.owner(TENANT_A, [
    [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, 'EFFECTIVE', $5, $5)`, [TENANT_A, recordId, masterType, key, memberId(MAKER)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, $3, $4, 1, $5, $6::jsonb, '2020-01-01', 'EFFECTIVE', $7, now(), $8, $8)`,
      [TENANT_A, versionId, masterType, key, `Label ${key}`, JSON.stringify(attributes), recordId, memberId(MAKER)],
    ],
  ]);
  return versionId;
}

async function document(): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
    [TENANT_A, id, `QD-${id.slice(0, 8)}/2026`, memberId(MAKER)],
  );
  return id;
}

async function project(unit = BQL1, status: ProjectStatus = 'PIPELINE', tenant = TENANT_A): Promise<string> {
  counter += 1;
  const code = `SC-${counter}-${randomUUID().slice(0, 6)}`;
  const area = tenant === TENANT_A ? versions.area : versions.areaB;
  const created = await as((tx) => projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(unit), areaMasterVersionId: area as string, totalInvestmentVnd: '500000000000' }, memberId(MAKER), TODAY), tenant);
  await owner('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, status, 'B', String(8000000 + counter)], tenant);
  return created.id;
}

/** A project with a line of a published plan: the ledger entries of its payments hang on that line. */
async function fundedProject(year: number, bucket: LineInput['bucket'] = 'CURRENT_YEAR', unit = BQL1): Promise<{ projectId: string; appropriationId: string; lineId: string }> {
  const input: AppropriationInput = {
    fundSourceVersionId: versions.nstw as string,
    planYear: year,
    origin: 'PM_ASSIGNED',
    budgetLevel: 'CENTRAL',
    amountVnd: millions(10_000),
    decisionDocumentId: await document(),
    issuingAuthority: 'Thủ tướng Chính phủ',
    sourceYear: year,
  };
  const draftedAppropriation = await as((tx) => appropriations.register(tx, input, memberId(MAKER), TODAY));
  await as((tx) => appropriations.decide(tx, draftedAppropriation.id, draftedAppropriation.version, 'approve', memberId(APPROVER), TODAY), TENANT_A, APPROVER);
  const projectId = await project(unit);
  counter += 1;
  const created = await as((tx) =>
    plans.createPlan(tx, { planCode: `SC-${counter}-${randomUUID().slice(0, 6)}`, planKind: 'ANNUAL', planYear: year, periodFromYear: year, periodToYear: year, scopeUnitId: unitId(ROOT) }, memberId(MAKER), allow),
  );
  const version = Number((await owner<{ version: string }>('select version::text as version from machvon.capital_plan where id = $1::uuid', [created.id]))[0]?.version);
  await as((tx) =>
    plans.draft(tx, created.id, version, { lines: [{ projectId, appropriationId: draftedAppropriation.id, bucket, sourceYear: year, amountVnd: millions(1_000) }], removeLineIds: [] }, memberId(MAKER), scopes, TODAY),
  );
  const submitVersion = Number((await owner<{ version: string }>('select version::text as version from machvon.capital_plan where id = $1::uuid', [created.id]))[0]?.version);
  await as((tx) => approvals.submit(tx, created.id, submitVersion, memberId(MAKER), allow));
  const decideVersion = Number((await owner<{ version: string }>('select version::text as version from machvon.capital_plan where id = $1::uuid', [created.id]))[0]?.version);
  await as((tx) => approvals.decide(tx, created.id, decideVersion, 'approve', 'Reviewed against the decision', memberId(APPROVER), allow), TENANT_A, APPROVER);
  const publishVersion = Number((await owner<{ version: string }>('select version::text as version from machvon.capital_plan where id = $1::uuid', [created.id]))[0]?.version);
  const decisionDocumentId = await document();
  await as((tx) => publication.publish(tx, created.id, publishVersion, { decisionDocumentId, effectiveAt: '2026-01-15T03:00:00.000Z' }, memberId(PUBLISHER), allow, TODAY), TENANT_A, PUBLISHER);
  const line = (await owner<{ id: string }>('select al.id from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid', [created.id]))[0];
  return { projectId, appropriationId: draftedAppropriation.id, lineId: line?.id as string };
}

/** A DISBURSE entry of the ledger (what the Treasury paid), or the reversal of one. */
async function pay(target: { projectId: string; appropriationId: string; lineId: string }, year: number, amount: string, postedAt: string, reversalOf?: string): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, reversal_of_id, posted_at, posted_by)
     values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, 'PAYMENT_REQUEST', $9, $10, $11::timestamptz, $12)`,
    [TENANT_A, id, target.appropriationId, target.lineId, target.projectId, reversalOf === undefined ? 'DISBURSE' : 'REVERSAL', amount, year, randomUUID(), reversalOf ?? null, postedAt, memberId(MAKER)],
  );
  return id;
}

const input = (projectId: string, year: number, overrides: Partial<ScheduleInput> = {}): ScheduleInput => ({
  projectId,
  planYear: year,
  granularity: 'MONTH',
  month: 10,
  kind: 'REGISTERED',
  bucket: 'CURRENT_YEAR',
  budgetLevel: 'CENTRAL',
  amountVnd: millions(800),
  ...overrides,
});

const register = (value: ScheduleInput, scope: ScopeBuilder = everything, member = MAKER, tenant = TENANT_A) => as((tx) => schedules.register(tx, value, memberId(member), scope, NOW), tenant);
const list = (filter: Parameters<CapScheduleStore['list']>[1] = {}, scope: ScopeBuilder = everything, limit = 100, after?: { code: string; id: string }) => as((tx) => schedules.list(tx, filter, scope, { limit, after }));
const rowsOf = (projectId: string) =>
  owner<{ id: string; revision: number; is_current: boolean; amount: string; supersedes_id: string | null; version: string }>(
    'select id, revision, is_current, amount_vnd::text as amount, supersedes_id, version::text as version from machvon.disbursement_schedule_line where project_id = $1::uuid order by revision',
    [projectId],
  );

async function seedPeriod(year: number, type: 'WEEK' | 'MONTH', start: string, end: string, status: 'OPEN' | 'LOCKED'): Promise<string> {
  const id = randomUUID();
  const [calendar] = await owner<{ id: string }>("select id from machvon.master_record_version where master_type = 'CALENDAR' limit 1");
  const locked = status === 'LOCKED';
  await owner(
    `insert into machvon.reporting_period
       (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, soft_closed_at, locked_at, locked_by, calendar_version_id, created_by, updated_by)
     values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
    [
      TENANT_A,
      id,
      `${type}-${id.slice(0, 8)}`,
      start,
      end,
      `CAL-${id.slice(0, 8)}`,
      type,
      year,
      status,
      locked ? `${end}T05:00:00Z` : null,
      locked ? `${end}T06:00:00Z` : null,
      locked ? memberId(MAKER) : null,
      calendar?.id,
      memberId(MAKER),
    ],
  );
  return id;
}

beforeAll(async () => {
  await harness.start();
  for (const tenant of [TENANT_A, TENANT_B]) {
    await harness.seedUnits(tenant, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: BQL1, path: `/${unitId(ROOT)}/${unitId(BQL1)}/`, parent: ROOT },
      { n: BQL2, path: `/${unitId(ROOT)}/${unitId(BQL2)}/`, parent: ROOT },
    ]);
    for (const member of [MAKER, APPROVER, PUBLISHER]) await harness.seedMembership(tenant, member, ROOT);
  }
  await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER_MEMBERSHIP_ID, TODAY));
  versions.nstw = await seedMaster('NSTW-DTPT', 'FUND_SOURCE', { category: 'NSTW', relation: 'ADDITIVE' });
  versions.area = await seedMaster('AREA', 'AREA', {});
  const areaRecord = randomUUID();
  versions.areaB = randomUUID();
  await harness.owner(TENANT_B, [
    [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', 'AREA-B', 'EFFECTIVE', $3, $3)`, [TENANT_B, areaRecord, memberId(MAKER)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, 'AREA', 'AREA-B', 1, 'Area B', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $3, now(), $4, $4)`,
      [TENANT_B, versions.areaB, areaRecord, memberId(MAKER)],
    ],
  ]);
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

jest.setTimeout(240_000);

describe('CapScheduleStore.register (registerDisbursementSchedule, ST-CAP-009)', () => {
  it('registers a month as revision 1, and a new registration of the same month takes its place: the old row stays but is no longer current', async () => {
    const year = freshYear();
    const target = await project();
    const first = await register(input(target, year));
    expect(first).toMatchObject({ version: 1, revision: 1, supersedesId: null, amountVnd: millions(800), previousAmountVnd: null });
    const second = await register(input(target, year, { amountVnd: millions(900), ctmtqgSubsetVnd: millions(100) }));
    expect(second).toMatchObject({ revision: 2, supersedesId: first.id, amountVnd: millions(900), previousAmountVnd: millions(800), ctmtqgSubsetVnd: millions(100) });
    const rows = await rowsOf(target);
    expect(rows.map((row) => [row.revision, row.is_current, row.amount])).toEqual([
      [1, false, millions(800)],
      [2, true, millions(900)],
    ]);
    expect(rows[0]).toMatchObject({ version: '2' });
    expect(rows[1]).toMatchObject({ supersedes_id: first.id, version: '1' });
    // Another key (month, source group, kind) has its own current row.
    await register(input(target, year, { month: 11 }));
    await register(input(target, year, { bucket: 'CARRYOVER' }));
    await register(input(target, year, { kind: 'FORECAST', assumption: 'Payment follows the acceptance of volume' }));
    expect((await rowsOf(target)).filter((row) => row.is_current)).toHaveLength(4);
  });

  it('is a promise and never money paid: it writes nothing to the ledger or the balances (BR-CAP-08)', async () => {
    const year = freshYear();
    const funded = await fundedProject(year);
    const before = await owner<{ n: string; total: string }>('select count(*)::text as n, coalesce(sum(amount_vnd), 0)::text as total from machvon.capital_ledger_entry');
    const balance = await owner('select allocated_vnd::text as allocated, committed_vnd::text as committed, disbursed_vnd::text as disbursed from machvon.allocation_balance where allocation_line_id = $1::uuid', [funded.lineId]);
    await register(input(funded.projectId, year, { amountVnd: millions(800) }));
    expect(await owner('select count(*)::text as n, coalesce(sum(amount_vnd), 0)::text as total from machvon.capital_ledger_entry')).toEqual(before);
    expect(await owner('select allocated_vnd::text as allocated, committed_vnd::text as committed, disbursed_vnd::text as disbursed from machvon.allocation_balance where allocation_line_id = $1::uuid', [funded.lineId])).toEqual(balance);
  });

  it('keeps one current row of a key and numbers the revisions without a gap when several requests arrive at the same moment', async () => {
    let target = '';
    let year = 0;
    const rounds = await runLoops({
      loops: 5,
      reset: async () => {
        year = freshYear();
        target = await project();
      },
      commands: () =>
        [1, 2, 3, 4].map((n) => async () => {
          await register(input(target, year, { amountVnd: millions(100 * n) }));
        }),
      verify: async ({ outcomes }) => {
        expect(outcomes.every((outcome) => outcome.status === 200)).toBe(true);
        const rows = await rowsOf(target);
        expect(rows.map((row) => row.revision)).toEqual([1, 2, 3, 4]);
        expect(rows.filter((row) => row.is_current)).toHaveLength(1);
        expect(rows[3]?.is_current).toBe(true);
        // Each revision replaces the one before it: a chain, never a fork.
        expect(rows.slice(1).map((row, index) => row.supersedes_id === rows[index]?.id)).toEqual([true, true, true]);
      },
    });
    expect(tallyOutcomes(rounds.flatMap((round) => round.outcomes))).toEqual({ '200': 20 });
  }, 240_000);

  it('refuses a subset above the amount (SUBSET_EXCEEDS_PARENT) and every malformed field (422)', async () => {
    const year = freshYear();
    const target = await project();
    expect(await refusal(register(input(target, year, { ctmtqgSubsetVnd: millions(801) })))).toEqual({ code: 'SUBSET_EXCEEDS_PARENT', status: 422, detail: 'ctmtqg_subset_vnd' });
    // A subset equal to the amount is allowed.
    await register(input(target, year, { ctmtqgSubsetVnd: millions(800) }));
    const bad = async (overrides: Partial<ScheduleInput>, detail: string) => expect(await refusal(register(input(target, year, overrides)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail });
    await bad({ amountVnd: '1.5' }, 'amount_vnd');
    await bad({ amountVnd: '-1' }, 'amount_vnd');
    await bad({ amountVnd: '1e3' }, 'amount_vnd');
    await bad({ amountVnd: '9'.repeat(25) }, 'amount_vnd');
    await bad({ amountVnd: 100 as unknown as string }, 'amount_vnd');
    await bad({ ctmtqgSubsetVnd: 'x' }, 'ctmtqg_subset_vnd');
    await bad({ month: 0 }, 'month');
    await bad({ month: 14 }, 'month');
    await bad({ month: 1.5 }, 'month');
    await bad({ month: undefined }, 'month');
    await bad({ periodId: randomUUID() }, 'period_id');
    await bad({ planYear: 1989 }, 'plan_year');
    await bad({ planYear: 2101 }, 'plan_year');
    await bad({ projectId: 'not-an-id' }, 'project_id');
    await bad({ allocationLineId: 'not-an-id' }, 'allocation_line_id');
    await bad({ granularity: 'DAY' as unknown as 'WEEK' }, 'granularity');
    await bad({ kind: 'ACTUAL' as unknown as 'REGISTERED' }, 'kind');
    await bad({ bucket: 'X' as unknown as 'OTHER' }, 'bucket');
    await bad({ budgetLevel: 'X' as unknown as 'LOCAL' }, 'budget_level');
    // The kind and the grain go together: a registration is monthly, a weekly commitment weekly.
    await bad({ kind: 'WEEKLY_COMMITMENT' }, 'granularity');
    await bad({ granularity: 'WEEK', periodId: randomUUID(), kind: 'REGISTERED', month: undefined }, 'granularity');
    // A weekly row names its period and no month.
    await bad({ granularity: 'WEEK', kind: 'WEEKLY_COMMITMENT', month: undefined, periodId: undefined }, 'period_id');
    await bad({ granularity: 'WEEK', kind: 'WEEKLY_COMMITMENT', month: 3, periodId: randomUUID() }, 'month');
    // A forecast says what it rests on; the other kinds carry no assumption.
    await bad({ kind: 'FORECAST' }, 'assumption');
    await bad({ kind: 'FORECAST', assumption: '   ' }, 'assumption');
    await bad({ assumption: 'Why' }, 'assumption');
    await bad({ kind: 'FORECAST', assumption: 'x'.repeat(2001) }, 'assumption');
    await bad({ kind: 'FORECAST', assumption: 'a\u0000b' }, 'assumption');
  });

  it('judges the project: outside the scope or of another tenant it does not exist (404), and a project that takes no capital is refused (422)', async () => {
    const year = freshYear();
    const inside = await project(BQL1);
    const outside = await project(BQL2);
    const access: EffectiveAccess = {
      membershipId: memberId(MAKER),
      scopeVersion: 1,
      membershipActive: true,
      grants: [
        {
          roleCode: 'TEST',
          rank: 10,
          permissions: ['capital.schedule.register', 'capital.read'],
          scope: { kind: 'UNIT_SUBTREE', refIds: [unitId(BQL1)], paths: [`/${unitId(ROOT)}/${unitId(BQL1)}/`] } as Scope,
          status: 'Active',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          effectiveUntil: null,
        },
      ],
    };
    const mine = projectScope(access, 'capital.schedule.register', NOW);
    await register(input(inside, year), mine);
    expect(await refusal(register(input(outside, year), mine))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    const foreign = await project(BQL1, 'PIPELINE', TENANT_B);
    expect(await refusal(register(input(foreign, year)))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await refusal(register(input(randomUUID(), year)))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    for (const status of ['CONCEPT', 'COMPLETED', 'CANCELLED'] as const) {
      const stopped = await project(BQL1, status);
      expect(await refusal(register(input(stopped, year)))).toEqual({ code: 'PROJECT_STAGE_INVALID', status: 422, detail: 'project_id' });
    }
    expect(await rowsOf(outside)).toEqual([]);
    expect(await rowsOf(foreign)).toEqual([]);
  });

  it('refuses a locked fiscal year (409), a line that is not the line of the project (422), a locked period (409 PERIOD_LOCKED) and a period that is not a week (422)', async () => {
    const year = freshYear();
    const target = await project();
    await owner("insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, locked_at, locked_by, created_by, updated_by) values ($1, $2, $3, 'LOCKED', now(), $4, $4, $4)", [TENANT_A, randomUUID(), year, memberId(MAKER)]);
    expect(await refusal(register(input(target, year)))).toEqual({ code: 'FISCAL_YEAR_LOCKED', status: 409, detail: 'plan_year' });

    const openYear = freshYear();
    const funded = await fundedProject(openYear);
    const other = await project();
    expect(await refusal(register(input(other, openYear, { allocationLineId: funded.lineId })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'allocation_line_id' });
    await register(input(funded.projectId, openYear, { allocationLineId: funded.lineId }));
    expect((await owner<{ allocation_line_id: string }>('select allocation_line_id from machvon.disbursement_schedule_line where project_id = $1::uuid', [funded.projectId]))[0]?.allocation_line_id).toBe(funded.lineId);

    const week = await seedPeriod(openYear, 'WEEK', `${openYear}-03-02`, `${openYear}-03-08`, 'OPEN');
    const lockedWeek = await seedPeriod(openYear, 'WEEK', `${openYear}-03-09`, `${openYear}-03-15`, 'LOCKED');
    const month = await seedPeriod(openYear, 'MONTH', `${openYear}-05-01`, `${openYear}-05-31`, 'OPEN');
    await seedPeriod(openYear, 'MONTH', `${openYear}-06-01`, `${openYear}-06-30`, 'LOCKED');
    const weekly = (periodId: string): ScheduleInput => input(target, openYear, { granularity: 'WEEK', kind: 'WEEKLY_COMMITMENT', month: undefined, periodId });
    await register(weekly(week));
    expect(await refusal(register(weekly(lockedWeek)))).toEqual({ code: 'PERIOD_LOCKED', status: 409 });
    expect(await refusal(register(weekly(month)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'period_id' });
    expect(await refusal(register(weekly(randomUUID())))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'period_id' });
    // A month whose monthly period is locked takes nothing; the months around it, and month 13, do.
    expect(await refusal(register(input(target, openYear, { month: 6 })))).toEqual({ code: 'PERIOD_LOCKED', status: 409 });
    await register(input(target, openYear, { month: 5 }));
    await register(input(target, openYear, { month: 7 }));
    await register(input(target, openYear, { month: 13 }));
    expect(await rowsOf(target)).toHaveLength(4);
  });

  it('lets a weekly commitment and a forecast through with their own shape', async () => {
    const year = freshYear();
    const target = await project();
    const week = await seedPeriod(year, 'WEEK', `${year}-04-06`, `${year}-04-12`, 'OPEN');
    const commitment = await register(input(target, year, { granularity: 'WEEK', kind: 'WEEKLY_COMMITMENT', month: undefined, periodId: week, amountVnd: millions(50) }));
    expect(commitment).toMatchObject({ granularity: 'WEEK', month: null, periodId: week, kind: 'WEEKLY_COMMITMENT' });
    const forecast = await register(input(target, year, { kind: 'FORECAST', month: 12, assumption: '  Volume accepted in November  ' }));
    expect((await owner<{ assumption: string }>('select assumption from machvon.disbursement_schedule_line where id = $1::uuid', [forecast.id]))[0]?.assumption).toBe('Volume accepted in November');
    const weeks = await list({ granularity: 'WEEK' });
    expect(weeks.find((row) => row.id === commitment.id)).toMatchObject({ period: { id: week }, month: null, achievement: null });
  });
});

describe('CapScheduleStore.list and the achievement of a monthly registration (AC-ST-CAP-009-1)', () => {
  it('reads 300 million paid against 800 million registered as 0.3750, and the registration stays 800 million', async () => {
    const year = freshYear();
    const funded = await fundedProject(year);
    await register(input(funded.projectId, year, { month: 10, amountVnd: millions(800) }));
    await pay(funded, year, millions(300), `${year}-10-15T03:00:00.000Z`);
    const [row] = await list({ projectId: funded.projectId });
    expect(row).toMatchObject({ amountVnd: millions(800), month: 10, kind: 'REGISTERED', isCurrent: true, achievement: { disbursedVnd: millions(300), rate: '0.3750' } });
  });

  it('counts the payments of the month by Vietnam time, the source group of the registration, and not a payment that was undone', async () => {
    const year = freshYear();
    const funded = await fundedProject(year, 'CURRENT_YEAR');
    await register(input(funded.projectId, year, { month: 10, amountVnd: millions(1_000) }));
    await register(input(funded.projectId, year, { month: 11, amountVnd: millions(1_000) }));
    await register(input(funded.projectId, year, { month: 13, amountVnd: millions(1_000) }));
    await register(input(funded.projectId, year, { month: 10, bucket: 'CARRYOVER', amountVnd: millions(1_000) }));
    // 17:30 UTC on 31 October is 00:30 on 1 November in Vietnam: the payment belongs to November.
    await pay(funded, year, millions(100), `${year}-10-31T17:30:00.000Z`);
    await pay(funded, year, millions(200), `${year}-10-31T16:30:00.000Z`);
    const undone = await pay(funded, year, millions(400), `${year}-10-02T03:00:00.000Z`);
    await pay(funded, year, millions(400), `${year}-10-03T03:00:00.000Z`, undone);
    // January of the next year is the adjustment period (month 13); later months of that year belong to no registration.
    await pay(funded, year, millions(50), `${year + 1}-01-10T03:00:00.000Z`);
    await pay(funded, year, millions(70), `${year + 1}-02-10T03:00:00.000Z`);
    const byKey = new Map((await list({ projectId: funded.projectId })).map((row) => [`${row.month}:${row.bucket}`, row.achievement]));
    expect(byKey.get('10:CURRENT_YEAR')).toEqual({ disbursedVnd: millions(200), rate: '0.2000' });
    expect(byKey.get('11:CURRENT_YEAR')).toEqual({ disbursedVnd: millions(100), rate: '0.1000' });
    expect(byKey.get('13:CURRENT_YEAR')).toEqual({ disbursedVnd: millions(50), rate: '0.0500' });
    // The carry-over registration is a different source group: the payments on the line of the year are not its payments.
    expect(byKey.get('10:CARRYOVER')).toEqual({ disbursedVnd: '0', rate: '0.0000' });
  });

  it('has no rate when nothing is registered, and shows a registration beyond its amount as more than one', async () => {
    const year = freshYear();
    const funded = await fundedProject(year);
    await register(input(funded.projectId, year, { month: 3, amountVnd: '0' }));
    await register(input(funded.projectId, year, { month: 4, amountVnd: millions(100) }));
    await pay(funded, year, millions(250), `${year}-03-10T03:00:00.000Z`);
    await pay(funded, year, millions(250), `${year}-04-10T03:00:00.000Z`);
    const byMonth = new Map((await list({ projectId: funded.projectId })).map((row) => [row.month, row.achievement]));
    expect(byMonth.get(3)).toEqual({ disbursedVnd: millions(250), rate: null });
    expect(byMonth.get(4)).toEqual({ disbursedVnd: millions(250), rate: '2.5000' });
  });

  it('shows the current registration of each key by default, the whole history on request, narrowed by project, year, kind and month, newest first and in pages', async () => {
    const year = freshYear();
    const target = await project();
    const noise = await project();
    await register(input(noise, year));
    const first = await register(input(target, year, { month: 1, amountVnd: millions(1) }));
    const second = await register(input(target, year, { month: 1, amountVnd: millions(2) }));
    await register(input(target, year, { month: 2, amountVnd: millions(3) }));
    await register(input(target, year, { kind: 'FORECAST', month: 2, assumption: 'Because' }));
    const current = await list({ projectId: target, planYear: year });
    expect(current.map((row) => [row.month, row.kind, row.amountVnd, row.revision])).toEqual([
      [2, 'FORECAST', millions(800), 1],
      [2, 'REGISTERED', millions(3), 1],
      [1, 'REGISTERED', millions(2), 2],
    ]);
    const history = await list({ projectId: target, kind: 'REGISTERED', history: true });
    expect(history.map((row) => row.id)).toContain(first.id);
    expect(history.filter((row) => row.month === 1).map((row) => [row.revision, row.isCurrent])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(history.find((row) => row.id === second.id)?.supersedesId).toBe(first.id);
    expect((await list({ projectId: target, month: 1 })).map((row) => row.amountVnd)).toEqual([millions(2)]);
    expect((await list({ projectId: target, granularity: 'MONTH', planYear: year + 1 }))).toEqual([]);
    // Pages: the cursor is the creation moment and the id of the last row.
    const page1 = await list({ projectId: target, history: true }, everything, 2);
    expect(page1).toHaveLength(2);
    const last = page1[1] as (typeof page1)[number];
    const page2 = await list({ projectId: target, history: true }, everything, 10, { code: last.createdAtKey, id: last.id });
    expect(page2).toHaveLength(2);
    expect(new Set([...page1, ...page2].map((row) => row.id)).size).toBe(4);
    expect(await refusal(list({}, everything, 5, { code: 'yesterday', id: randomUUID() }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'cursor' });
    expect(await refusal(list({}, everything, 5, { code: '2026-01-01T00:00:00.000000Z', id: 'x' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'cursor' });
  });

  it('shows a caller only the registrations of the projects in the scope', async () => {
    const year = freshYear();
    const mine = await project(BQL1);
    const theirs = await project(BQL2);
    await register(input(mine, year));
    await register(input(theirs, year));
    const access: EffectiveAccess = {
      membershipId: memberId(MAKER),
      scopeVersion: 1,
      membershipActive: true,
      grants: [
        {
          roleCode: 'TEST',
          rank: 10,
          permissions: ['capital.read'],
          scope: { kind: 'UNIT_SUBTREE', refIds: [unitId(BQL1)], paths: [`/${unitId(ROOT)}/${unitId(BQL1)}/`] } as Scope,
          status: 'Active',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          effectiveUntil: null,
        },
      ],
    };
    const seen = await list({ planYear: year }, projectScope(access, 'capital.read', NOW));
    expect(seen.map((row) => row.project.id)).toEqual([mine]);
    expect((await list({ planYear: year })).map((row) => row.project.id).sort()).toEqual([mine, theirs].sort());
  });
});

describe('the table of the schedule', () => {
  it('is never edited or deleted: a row keeps its values for good and only stops being current when it is replaced', async () => {
    const year = freshYear();
    const target = await project();
    const first = await register(input(target, year));
    await register(input(target, year, { amountVnd: millions(1) }));
    await expect(owner('update machvon.disbursement_schedule_line set amount_vnd = 1 where id = $1::uuid', [first.id])).rejects.toThrow(/never edited/);
    await expect(owner('update machvon.disbursement_schedule_line set is_current = true where id = $1::uuid', [first.id])).rejects.toThrow(/stops being current/);
    await expect(as((tx) => tx.query('delete from machvon.disbursement_schedule_line where id = $1::uuid', [first.id]))).rejects.toThrow(/permission denied/);
    await expect(as((tx) => tx.query('truncate machvon.disbursement_schedule_line'))).rejects.toThrow(/permission denied/);
  });

  it('holds the shape with its own constraints, whatever writes the row', async () => {
    const year = freshYear();
    const target = await project();
    const insert = (columns: string, values: string): Promise<unknown[]> =>
      owner(
        `insert into machvon.disbursement_schedule_line (tenant_id, id, project_id, plan_year, bucket, budget_level, amount_vnd, revision, created_by, updated_by, granularity, kind, ${columns})
         values ($1, gen_random_uuid(), $2, ${year}, 'OTHER', 'LOCAL', 1, 1, $3, $3, ${values})`,
        [TENANT_A, target, memberId(MAKER)],
      );
    await expect(insert('month', "'WEEK', 'REGISTERED', 4")).rejects.toThrow(/schedule_kind_grain_chk|schedule_grain_chk/);
    await expect(insert('month', "'MONTH', 'WEEKLY_COMMITMENT', 4")).rejects.toThrow(/schedule_kind_grain_chk/);
    await expect(insert('month, period_id', `'MONTH', 'REGISTERED', 4, '${randomUUID()}'`)).rejects.toThrow(/schedule_grain_exclusive_chk|foreign key/);
    await expect(insert('month', "'MONTH', 'FORECAST', 4")).rejects.toThrow(/schedule_forecast_assumption_chk/);
    await expect(insert('month, supersedes_id', `'MONTH', 'REGISTERED', 4, '${randomUUID()}'`)).rejects.toThrow(/schedule_supersedes_chk/);
    await expect(insert('month, assumption', "'MONTH', 'FORECAST', 4, ' padded '")).rejects.toThrow(/schedule_assumption_text_chk/);
    await expect(insert('month', "'MONTH', 'REGISTERED', 14")).rejects.toThrow(/check constraint/);
  });
});

describe('achievementRate', () => {
  it('is exact to four decimals, half up, and never a float', () => {
    expect(achievementRate('300000000', '800000000')).toBe('0.3750');
    expect(achievementRate('1', '3')).toBe('0.3333');
    expect(achievementRate('2', '3')).toBe('0.6667');
    expect(achievementRate('5', '8')).toBe('0.6250');
    expect(achievementRate('1', '16')).toBe('0.0625');
    expect(achievementRate('1', '32')).toBe('0.0313');
    expect(achievementRate('0', '10')).toBe('0.0000');
    expect(achievementRate('10', '10')).toBe('1.0000');
    expect(achievementRate('25', '10')).toBe('2.5000');
    expect(achievementRate('5', '0')).toBeNull();
    expect(achievementRate('999999999999999999999999', '1000000000000000000000000')).toBe('1.0000');
    expect(achievementRate('123456789012345678901234', '3')).toBe('41152263004115226300411.3333');
  });
});

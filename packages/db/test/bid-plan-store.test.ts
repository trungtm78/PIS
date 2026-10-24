import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { BidPlanReads, bidReadScope } from '../src/bid-plan-reads';
import type { BidReadScope } from '../src/bid-plan-reads';
import { checkedPlan, commentOf, readPackages } from '../src/bid-plan-input';
import type { NewPlanInput, PackageInput } from '../src/bid-plan-input';
import { BidPlanStore, PLANNABLE_PROJECT_STATUSES } from '../src/bid-plan-store';
import type { BidDecisionInput } from '../src/bid-plan-store';
import { projectScope } from '../src/prj-project-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const plans = new BidPlanStore();
const reads = new BidPlanReads();
const MAKER = 1;
const APPROVER = 2;
const SECOND_APPROVER = 3;
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const BILLION = 1_000_000_000;
const FAMILY = 0x93;
const NOW = new Date();

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const money = (billions: number): string => String(billions * BILLION);

const grant = (permission: string, scope: Scope): EffectiveAccess => ({
  membershipId: memberId(MAKER),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const subtree = (permission: string, unit: number): EffectiveAccess => grant(permission, { kind: 'UNIT_SUBTREE', refIds: [unitId(unit)], paths: [`/${unitId(unit)}/`] });

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

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

/** The SQLSTATE and the message of a statement the database refuses (the owner connection autocommits, so a deferred trigger fires at its end). */
async function databaseRefusal(work: Promise<unknown>): Promise<{ sqlstate: string; message: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { sqlstate: e.code ?? '', message: e.message };
  }
  throw new Error('expected the database to refuse');
}

async function seedAs(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    // Foreign keys to the modules this story only reads are out of scope here, so the superuser seeds with them switched off.
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

let counter = 0;
const nextCode = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${counter}`;
};

async function document(options: { effective?: boolean; type?: string; tenant?: string } = {}): Promise<string> {
  const documentId = randomUUID();
  const tenant = options.tenant ?? TENANT_A;
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
     values ($1, $2, 'REFERENCE', $3, 'Decision approving the procurement plan', '45/QD-UBND', '2026-10-01', $4, 'INTERNAL', $5, $5)`,
    [tenant, documentId, options.type ?? 'QD', options.effective === false ? 'PENDING' : 'EFFECTIVE', memberId(MAKER)],
    tenant,
  );
  return documentId;
}

interface Seeded {
  projectId: string;
  lines: string[];
}

/**
 * A project with the lines of capital a procurement plan draws on: one line per given amount (in billions), held by a capital plan in the
 * given status (PUBLISHED is the plan in force).
 */
async function seedProject(options: { status?: string; unit?: number; lines?: number[]; capital?: string; tenant?: string; lineOfProject?: string } = {}): Promise<Seeded> {
  const tenant = options.tenant ?? TENANT_A;
  const projectId = randomUUID();
  const capitalPlanId = randomUUID();
  const versionId = randomUUID();
  const decision = await document({ tenant });
  const lines = (options.lines ?? [30]).map(() => randomUUID());
  const unit = options.unit ?? DEPARTMENT;
  const statements: Array<[string, unknown[]]> = [
    [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, 'Procurement project', $4, $5, $6, 'INTERNAL', 1000, $7, 1, 'B')`,
      [tenant, projectId, nextCode('BP'), unitId(unit), unitId(PROVINCE), id(FAMILY, 90), options.status ?? 'IMPLEMENTATION'],
    ],
    [
      `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, decision_document_id, effective_at, created_by, updated_by)
       values ($1, $2, $3, 'ANNUAL', 2026, 2026, 2026, $4, 1, $5, $6, now(), $7, $7)`,
      [tenant, capitalPlanId, nextCode('CPLAN'), unitId(PROVINCE), options.capital ?? 'PUBLISHED', decision, memberId(MAKER)],
    ],
    [
      `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at, capital_plan_id)
       values ($1, $2, $3, 2026, 1, $4, $5, now(), $6)`,
      [tenant, versionId, projectId, decision, options.capital ?? 'PUBLISHED', capitalPlanId],
    ],
  ];
  lines.forEach((lineId, index) => {
    statements.push([
      `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id)
       values ($1, $2, $3, $4, 'CURRENT_YEAR', 2026, $5::numeric, 0, $6)`,
      [tenant, lineId, versionId, id(FAMILY, 91), money(options.lines?.[index] ?? 30), options.lineOfProject ?? projectId],
    ]);
  });
  await seedAs(statements);
  return { projectId, lines };
}

const pack = (line: string, billions: number, extra: Partial<PackageInput> = {}): PackageInput => ({
  code: nextCode('GT'),
  title: 'Construction package',
  budgetVnd: money(billions),
  method: 'OPEN_BIDDING',
  contractType: 'LUMP_SUM',
  biddingForm: 'ONLINE',
  allocationLineId: line,
  plannedStartPeriod: '2026-Q4',
  durationDays: 180,
  ...extra,
});

const planInput = (seeded: Seeded, packages: PackageInput[], extra: Partial<NewPlanInput> = {}): NewPlanInput => ({
  projectId: seeded.projectId,
  title: 'Procurement plan 2026',
  legalBasis: 'Luật Đấu thầu 22/2023/QH15',
  packages,
  ...extra,
});

const create = (input: NewPlanInput, scope: ScopeBuilder = everything, member = MAKER) => as((tx) => plans.createPlan(tx, input, memberId(member), scope), member);
const submit = (planId: string, version: number, scope: ScopeBuilder = everything, member = MAKER) => as((tx) => plans.submit(tx, planId, version, memberId(member), scope), member);
const decide = (planId: string, version: number, input: BidDecisionInput, member = APPROVER, scope: ScopeBuilder = everything) => as((tx) => plans.decide(tx, planId, version, input, memberId(member), scope), member);

/** A plan with one package per amount (billions) on the first line, created by the maker. */
async function drafted(options: Parameters<typeof seedProject>[0] = {}, amounts: number[] = [18, 10]) {
  const seeded = await seedProject(options);
  const created = await create(planInput(seeded, amounts.map((amount) => pack(seeded.lines[0] as string, amount))));
  return { seeded, created };
}

async function submitted(options: Parameters<typeof seedProject>[0] = {}, amounts: number[] = [18, 10]) {
  const made = await drafted(options, amounts);
  const sent = await submit(made.created.id, 1);
  return { ...made, sent };
}

async function approved(options: Parameters<typeof seedProject>[0] = {}, amounts: number[] = [18, 10]) {
  const made = await submitted(options, amounts);
  const decided = await decide(made.created.id, 2, { decision: 'APPROVE', decisionDocumentId: await document() });
  return { ...made, decided };
}

const planRow = async (planId: string) =>
  (
    await owner<{ status: string; version: string; total: string; revision: number; supersedes_id: string | null; submitted_by: string | null; approved_by: string | null; decision_document_id: string | null }>(
      'select status, version::text as version, total_value_vnd::text as total, revision, supersedes_id, submitted_by, approved_by, decision_document_id from machvon.procurement_plan where id = $1::uuid',
      [planId],
    )
  )[0] as { status: string; version: string; total: string; revision: number; supersedes_id: string | null; submitted_by: string | null; approved_by: string | null; decision_document_id: string | null };
const packageStatuses = async (planId: string): Promise<string[]> => (await owner<{ status: string }>('select status from machvon.procurement_package where plan_id = $1::uuid order by code', [planId])).map((row) => row.status);
const eventKinds = async (planId: string): Promise<string[]> =>
  (await owner<{ event_kind: string }>('select event_kind from machvon.procurement_plan_event where plan_id = $1::uuid order by occurred_at, id', [planId])).map((row) => row.event_kind);

describe('the shape of a plan (no database)', () => {
  const raw = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    code: 'GT-01',
    title: ' Construction package ',
    budget_vnd: '18000000000',
    method: 'OPEN_BIDDING',
    contract_type: 'LUMP_SUM',
    bidding_form: 'ONLINE',
    allocation_line_id: id(FAMILY, 1).toUpperCase(),
    planned_start_period: '2026-Q4',
    duration_days: 180,
    ...extra,
  });

  it('reads a package with trimmed text and a lower-case line id', () => {
    expect(readPackages([raw()])).toEqual([
      {
        code: 'GT-01',
        title: 'Construction package',
        budgetVnd: '18000000000',
        method: 'OPEN_BIDDING',
        contractType: 'LUMP_SUM',
        biddingForm: 'ONLINE',
        allocationLineId: id(FAMILY, 1),
        plannedStartPeriod: '2026-Q4',
        durationDays: 180,
      },
    ]);
  });

  it.each([
    ['not a list', 'x'],
    ['an empty list', []],
    ['an item that is not an object', ['x']],
    ['an item that is a list', [[]]],
    ['a period that is not a quarter or a month', [raw({ planned_start_period: '2026-Q5' })]],
    ['a period without a year', [raw({ planned_start_period: 'Q4' })]],
    ['a duration of zero', [raw({ duration_days: 0 })]],
    ['a duration of text', [raw({ duration_days: '180' })]],
    ['a duration of a fraction', [raw({ duration_days: 1.5 })]],
    ['a duration above ten years', [raw({ duration_days: 3651 })]],
    ['a budget with a fraction', [raw({ budget_vnd: '100.5' })]],
    ['a budget of zero', [raw({ budget_vnd: '0' })]],
    ['a budget as a number', [raw({ budget_vnd: 100 })]],
    ['a budget wider than the column', [raw({ budget_vnd: '1'.padEnd(25, '0') })]],
    ['a code of nothing', [raw({ code: '  ' })]],
    ['a code with a control character', [raw({ code: 'GT\n01' })]],
    ['a title that is too short', [raw({ title: 'ab' })]],
    ['a method that is not one of the list', [raw({ method: 'OPEN' })]],
    ['a contract type that is not one of the list', [raw({ contract_type: 'PER_DAY' })]],
    ['a bidding form that is not one of the list', [raw({ bidding_form: 'HYBRID' })]],
    ['a line that is not an id', [raw({ allocation_line_id: 'not-an-id' })]],
  ])('refuses %s as 422 VALIDATION_FAILED', (_name, value) => {
    expect(() => readPackages(value)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422 }));
  });

  it('names the field and the place of a package that has one the contract does not know (400 FIELD_NOT_ALLOWED)', () => {
    expect(() => readPackages([raw(), raw({ status: 'AWARDED' })])).toThrow(expect.objectContaining({ code: 'FIELD_NOT_ALLOWED', status: 400, detail: 'packages.1.status' }));
  });

  it('adds the budgets exactly and refuses a repeated code, a total the column cannot hold and text outside its bounds', () => {
    const base = { projectId: id(FAMILY, 2), title: 'Plan', legalBasis: 'Law' };
    const packages = readPackages([raw({ code: 'A', budget_vnd: '999999999999999999999999' }), raw({ code: 'B', budget_vnd: '1' })]);
    expect(() => checkedPlan({ ...base, packages })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'packages.1.budget_vnd' }));
    const twice = readPackages([raw({ code: 'A' }), raw({ code: 'A' })]);
    expect(() => checkedPlan({ ...base, packages: twice })).toThrow(expect.objectContaining({ code: 'PACKAGE_CODE_DUPLICATE', status: 409, detail: 'packages.1.code' }));
    const exact = readPackages([raw({ code: 'A', budget_vnd: '12345678901234567890' }), raw({ code: 'B', budget_vnd: '98765432109876543210' })]);
    expect(checkedPlan({ ...base, packages: exact }).totalVnd).toBe('111111111011111111100');
    expect(() => checkedPlan({ ...base, title: 'x', packages: exact })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'title' }));
    expect(() => checkedPlan({ ...base, projectId: 'x', packages: exact })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'project_id' }));
    expect(() => checkedPlan({ ...base, legalBasis: 'x'.repeat(2001), packages: exact })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'legal_basis' }));
  });

  it('keeps the words of a decision trimmed, and refuses control characters and too long a text', () => {
    expect(commentOf(undefined)).toBeUndefined();
    expect(commentOf('   ')).toBeUndefined();
    expect(commentOf('  Back to the planner\nwith notes  ')).toBe('Back to the planner\nwith notes');
    expect(() => commentOf('x'.repeat(2001))).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'comment' }));
    expect(() => commentOf('bell\u0007')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'comment' }));
    expect(() => commentOf(5)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'comment' }));
  });
});

describe('BidPlanStore (the procurement plan, ST-BID-001)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: `/${unitId(PROVINCE)}/` },
        { n: DEPARTMENT, path: `/${unitId(PROVINCE)}/${unitId(DEPARTMENT)}/`, parent: PROVINCE },
        { n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` },
      ]);
      for (const member of [MAKER, APPROVER, SECOND_APPROVER]) await harness.seedMembership(tenant, member, PROVINCE);
    }
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('createPlan', () => {
    it('drafts the plan as revision 1 with its packages, the exact total and a CREATED step in its history', async () => {
      const { created } = await drafted();
      expect(created).toMatchObject({ revision: 1, version: 1, status: 'DRAFT', supersedesId: null, replacedPlanId: null, totalVnd: money(28) });
      expect(created.packages.map((item) => item.budgetVnd)).toEqual([money(18), money(10)]);
      expect(await planRow(created.id)).toMatchObject({ status: 'DRAFT', version: '1', total: money(28), revision: 1, supersedes_id: null });
      expect(await packageStatuses(created.id)).toEqual(['DRAFT', 'DRAFT']);
      expect(await eventKinds(created.id)).toEqual(['CREATED']);
      const stored = await owner<{ revision: number; plan_id: string; created_by: string; project_id: string }>('select revision, plan_id, created_by, project_id from machvon.procurement_package where plan_id = $1::uuid', [created.id]);
      expect(stored).toHaveLength(2);
      expect(stored.every((row) => row.revision === 1 && row.created_by === memberId(MAKER))).toBe(true);
    });

    it('refuses a project in a stage that takes no procurement plan (422 PROJECT_STAGE_INVALID) and writes nothing', async () => {
      expect(PLANNABLE_PROJECT_STATUSES).toEqual(['PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED']);
      for (const status of ['CONCEPT', 'APPRAISAL', 'COMPLETED', 'CLOSED', 'CANCELLED']) {
        const seeded = await seedProject({ status });
        expect(await refusal(create(planInput(seeded, [pack(seeded.lines[0] as string, 1)])))).toMatchObject({ code: 'PROJECT_STAGE_INVALID', status: 422 });
        expect(await owner('select 1 from machvon.procurement_plan where project_id = $1::uuid', [seeded.projectId])).toEqual([]);
      }
    });

    it('does not know a project outside the scope of the caller or of another tenant (404), and a line of another project is ALLOCATION_LINE_INVALID', async () => {
      const seeded = await seedProject({ unit: OTHER_BRANCH });
      const input = planInput(seeded, [pack(seeded.lines[0] as string, 1)]);
      expect(await refusal(create(input, projectScope(subtree('bid.plan.manage', DEPARTMENT), 'bid.plan.manage', NOW)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => plans.createPlan(tx, input, memberId(MAKER), everything), MAKER, TENANT_B))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const mine = await seedProject();
      const other = await seedProject();
      expect(await refusal(create(planInput(mine, [pack(other.lines[0] as string, 1)])))).toMatchObject({ code: 'ALLOCATION_LINE_INVALID', status: 409, detail: 'packages.0.allocation_line_id' });
      expect(await refusal(create(planInput(mine, [pack(mine.lines[0] as string, 1), pack(randomUUID(), 1)])))).toMatchObject({ code: 'ALLOCATION_LINE_INVALID', detail: 'packages.1.allocation_line_id' });
      expect(await owner('select 1 from machvon.procurement_plan where project_id = $1::uuid', [mine.projectId])).toEqual([]);
    });

    it('restarts a draft: the new plan is revision 2, the draft is CANCELLED with its packages and the step is kept', async () => {
      const first = await drafted();
      const again = await create(planInput(first.seeded, [pack(first.seeded.lines[0] as string, 5)]), everything, SECOND_APPROVER);
      expect(again).toMatchObject({ revision: 2, replacedPlanId: first.created.id, supersedesId: first.created.id, totalVnd: money(5) });
      expect(await planRow(first.created.id)).toMatchObject({ status: 'CANCELLED', version: '2' });
      expect(await packageStatuses(first.created.id)).toEqual(['CANCELLED', 'CANCELLED']);
      expect(await eventKinds(first.created.id)).toEqual(['CREATED', 'REPLACED']);
      const open = await owner('select id from machvon.procurement_plan where project_id = $1::uuid and status in (\'DRAFT\', \'IN_REVIEW\')', [first.seeded.projectId]);
      expect(open).toEqual([{ id: again.id }]);
    });

    it('refuses a new plan while one is in review (409 PLAN_STATE_INVALID naming it), and a repeated package code', async () => {
      const { seeded, created } = await submitted();
      const refused = await refusal(create(planInput(seeded, [pack(seeded.lines[0] as string, 1)])));
      expect(refused).toMatchObject({ code: 'PLAN_STATE_INVALID', status: 409, extensions: { open_plan_id: created.id } });
      expect(await planRow(created.id)).toMatchObject({ status: 'IN_REVIEW' });
      const fresh = await seedProject();
      const code = nextCode('DUP');
      expect(await refusal(create(planInput(fresh, [pack(fresh.lines[0] as string, 1, { code }), pack(fresh.lines[0] as string, 1, { code })])))).toMatchObject({ code: 'PACKAGE_CODE_DUPLICATE', status: 409 });
    });

    it('makes the revision after an approved plan: it names the plan in force as the one it supersedes, and leaves that plan as it is', async () => {
      const { seeded, created } = await approved();
      const next = await create(planInput(seeded, [pack(seeded.lines[0] as string, 20)]));
      expect(next).toMatchObject({ revision: 2, supersedesId: created.id, replacedPlanId: null });
      expect(await planRow(created.id)).toMatchObject({ status: 'APPROVED' });
      expect(await planRow(next.id)).toMatchObject({ status: 'DRAFT', supersedes_id: created.id });
    });

    it('makes two plans of one project at the same moment one after the other: the second restarts the draft of the first, one stays open', async () => {
      const seeded = await seedProject();
      const results = await Promise.all([
        create(planInput(seeded, [pack(seeded.lines[0] as string, 1)])),
        create(planInput(seeded, [pack(seeded.lines[0] as string, 2)]), everything, SECOND_APPROVER),
      ]);
      expect(results.map((result) => result.revision).sort()).toEqual([1, 2]);
      const rows = await owner<{ status: string }>('select status from machvon.procurement_plan where project_id = $1::uuid order by revision', [seeded.projectId]);
      expect(rows.map((row) => row.status)).toEqual(['CANCELLED', 'DRAFT']);
    });
  });

  describe('submitPlan (the budget check)', () => {
    it('submits a plan whose packages, line by line, cost no more than the line was given (the limit itself passes), IN_REVIEW with the packages', async () => {
      const { sent, created } = await submitted({ lines: [30, 5] }, [18, 12]);
      expect(sent).toMatchObject({ status: 'IN_REVIEW', version: 2, totalVnd: money(30) });
      expect(sent.allocations).toEqual([{ allocationLineId: created.packages[0]?.allocationLineId, allocatedVnd: money(30), packagesVnd: money(30) }]);
      expect(await planRow(created.id)).toMatchObject({ status: 'IN_REVIEW', version: '2', submitted_by: memberId(MAKER) });
      expect(await packageStatuses(created.id)).toEqual(['IN_REVIEW', 'IN_REVIEW']);
      expect(await eventKinds(created.id)).toEqual(['CREATED', 'SUBMITTED']);
    });

    it('refuses packages above the line with 422 PACKAGE_BUDGET_EXCEEDS_ALLOCATION naming every line over its limit, and keeps the plan a DRAFT', async () => {
      const seeded = await seedProject({ lines: [30, 10] });
      const [first, second] = seeded.lines as [string, string];
      const created = await create(planInput(seeded, [pack(first, 18), pack(first, 10), pack(first, 5), pack(second, 11)]));
      const refused = await refusal(submit(created.id, 1));
      expect(refused).toMatchObject({ code: 'PACKAGE_BUDGET_EXCEEDS_ALLOCATION', status: 422 });
      expect(refused.extensions?.lines).toEqual([
        { allocation_line_id: first, allocated_vnd: money(30), packages_vnd: money(33), excess_vnd: money(3) },
        { allocation_line_id: second, allocated_vnd: money(10), packages_vnd: money(11), excess_vnd: money(1) },
      ].sort((a, b) => a.allocation_line_id.localeCompare(b.allocation_line_id)));
      expect(await planRow(created.id)).toMatchObject({ status: 'DRAFT', version: '1', submitted_by: null });
      expect(await eventKinds(created.id)).toEqual(['CREATED']);
    });

    it('adds exactly: a sum one dong over the limit is refused although each package is below it', async () => {
      const seeded = await seedProject({ lines: [1] });
      const line = seeded.lines[0] as string;
      const created = await create(planInput(seeded, [pack(line, 0, { budgetVnd: '500000000' }), pack(line, 0, { budgetVnd: '500000001' })]));
      const refused = await refusal(submit(created.id, 1));
      expect(refused).toMatchObject({ code: 'PACKAGE_BUDGET_EXCEEDS_ALLOCATION' });
      expect((refused.extensions?.lines as Array<{ excess_vnd: string }>)[0]?.excess_vnd).toBe('1');
    });

    it('refuses a line that the capital plan has not published, one that is no line of the project, and a stage that no longer takes procurement', async () => {
      const draftCapital = await drafted({ capital: 'APPROVED' });
      expect(await refusal(submit(draftCapital.created.id, 1))).toMatchObject({ code: 'ALLOCATION_LINE_INVALID', status: 409 });
      const superseded = await drafted({ capital: 'SUPERSEDED' });
      expect(await refusal(submit(superseded.created.id, 1))).toMatchObject({ code: 'ALLOCATION_LINE_INVALID' });
      const stray = await seedProject({ lines: [30] });
      const strayCreated = await create(planInput(stray, [pack(stray.lines[0] as string, 1)]));
      await seedAs([['update machvon.allocation_line set project_id = $2::uuid where id = $1::uuid', [stray.lines[0], (await seedProject()).projectId]]]);
      expect(await refusal(submit(strayCreated.id, 1))).toMatchObject({ code: 'ALLOCATION_LINE_INVALID' });

      const { seeded, created } = await drafted();
      await owner("update machvon.project set status = 'CLOSED' where id = $1::uuid", [seeded.projectId]);
      expect(await refusal(submit(created.id, 1))).toMatchObject({ code: 'PROJECT_STAGE_INVALID', status: 422 });
      expect(await owner("select 1 from machvon.procurement_plan where id = $1::uuid and status = 'IN_REVIEW'", [created.id])).toEqual([]);
      expect(await packageStatuses(created.id)).toEqual(['DRAFT', 'DRAFT']);
    });

    it('answers a stale version with 409 VERSION_CONFLICT, a plan that is not a draft with 409 PLAN_STATE_INVALID, and a plan outside the scope with 404', async () => {
      const { created } = await drafted();
      expect(await refusal(submit(created.id, 7))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 1 } });
      expect(await refusal(submit(created.id, 1, projectScope(subtree('bid.plan.manage', OTHER_BRANCH), 'bid.plan.manage', NOW)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(submit(randomUUID(), 1))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await submit(created.id, 1);
      expect(await refusal(submit(created.id, 2))).toMatchObject({ code: 'PLAN_STATE_INVALID', status: 409 });
    });

    it('lets only one of two submissions of the same plan through', async () => {
      const { created } = await drafted();
      const outcomes = await Promise.allSettled([submit(created.id, 1), submit(created.id, 1, everything, SECOND_APPROVER)]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const failed = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      expect((failed.reason as { code: string }).code).toBe('VERSION_CONFLICT');
    });
  });

  describe('decidePlan', () => {
    it('refuses the maker and the submitter as the approver (403 SELF_APPROVAL_DENIED) and writes nothing', async () => {
      const { created } = await submitted();
      const document1 = await document();
      expect(await refusal(decide(created.id, 2, { decision: 'APPROVE', decisionDocumentId: document1 }, MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      // The submitter is somebody other than the maker.
      const other = await drafted();
      await submit(other.created.id, 1, everything, SECOND_APPROVER);
      expect(await refusal(decide(other.created.id, 2, { decision: 'APPROVE', decisionDocumentId: document1 }, SECOND_APPROVER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect(await refusal(decide(other.created.id, 2, { decision: 'RETURN', comment: 'Please check the packages' }, MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect(await planRow(created.id)).toMatchObject({ status: 'IN_REVIEW', version: '2' });
    });

    it('approves only on a decision in force: none, a pending one, one that is no decision and one that does not exist are refused', async () => {
      const { created } = await submitted();
      expect(await refusal(decide(created.id, 2, { decision: 'APPROVE' }))).toMatchObject({ code: 'DECISION_DOCUMENT_NOT_EFFECTIVE', status: 422, detail: 'decision_document_id' });
      expect(await refusal(decide(created.id, 2, { decision: 'APPROVE', decisionDocumentId: await document({ effective: false }) }))).toMatchObject({ code: 'DECISION_DOCUMENT_NOT_EFFECTIVE', status: 422 });
      expect(await refusal(decide(created.id, 2, { decision: 'APPROVE', decisionDocumentId: await document({ type: 'CV' }) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_document_id' });
      expect(await refusal(decide(created.id, 2, { decision: 'APPROVE', decisionDocumentId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_document_id' });
      expect(await refusal(decide(created.id, 2, { decision: 'APPROVE', decisionDocumentId: await document({ tenant: TENANT_B, effective: true }) }))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await refusal(decide(created.id, 2, { decision: 'APPROVE', decisionDocumentId: 'not-an-id' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_document_id' });
      expect(await planRow(created.id)).toMatchObject({ status: 'IN_REVIEW' });
    });

    it('approves: the plan is APPROVED on the decision with the approver, the packages are PLANNED on it, and the history says so', async () => {
      const { created, decided } = await approved();
      expect(decided).toMatchObject({ status: 'APPROVED', version: 3, supersededPlanId: null, decision: 'APPROVE' });
      expect(decided.packageIds).toHaveLength(2);
      const row = await planRow(created.id);
      expect(row).toMatchObject({ status: 'APPROVED', version: '3', approved_by: memberId(APPROVER), decision_document_id: decided.decisionDocumentId });
      expect(await packageStatuses(created.id)).toEqual(['PLANNED', 'PLANNED']);
      const stored = await owner<{ approved_decision_id: string }>('select approved_decision_id from machvon.procurement_package where plan_id = $1::uuid', [created.id]);
      expect(stored.every((item) => item.approved_decision_id === decided.decisionDocumentId)).toBe(true);
      expect(await eventKinds(created.id)).toEqual(['CREATED', 'SUBMITTED', 'APPROVED']);
    });

    it('replaces the plan in force: a revision that adds 5 billion to a line of 30 is refused at submission, and the approved revision supersedes the earlier plan', async () => {
      const first = await approved({ lines: [30] }, [18, 10]);
      const line = first.seeded.lines[0] as string;
      const over = await create(planInput(first.seeded, [pack(line, 18), pack(line, 10), pack(line, 5)]));
      expect(over.revision).toBe(2);
      expect(await refusal(submit(over.id, 1))).toMatchObject({ code: 'PACKAGE_BUDGET_EXCEEDS_ALLOCATION' });
      expect(await owner("select id from machvon.procurement_plan where project_id = $1::uuid and status = 'APPROVED'", [first.seeded.projectId])).toEqual([{ id: first.created.id }]);

      const fitting = await create(planInput(first.seeded, [pack(line, 18), pack(line, 12)]));
      expect(fitting).toMatchObject({ revision: 3, supersedesId: first.created.id, replacedPlanId: over.id });
      await submit(fitting.id, 1, everything, SECOND_APPROVER);
      const decision = await document();
      const decided = await decide(fitting.id, 2, { decision: 'APPROVE', decisionDocumentId: decision, comment: 'Approved as revised' });
      expect(decided).toMatchObject({ status: 'APPROVED', supersededPlanId: first.created.id, comment: 'Approved as revised' });
      expect(await planRow(first.created.id)).toMatchObject({ status: 'SUPERSEDED' });
      expect(await packageStatuses(first.created.id)).toEqual(['SUPERSEDED', 'SUPERSEDED']);
      expect(await eventKinds(first.created.id)).toEqual(['CREATED', 'SUBMITTED', 'APPROVED', 'SUPERSEDED']);
      expect(await owner("select id from machvon.procurement_plan where project_id = $1::uuid and status = 'APPROVED'", [first.seeded.projectId])).toEqual([{ id: fitting.id }]);
    });

    it('judges the lines again at the approval: a line that left the capital plan in force after the submission blocks it', async () => {
      const { seeded, created } = await submitted();
      await seedAs([["update machvon.capital_plan set status = 'SUPERSEDED' where id = (select capital_plan_id from machvon.plan_version where project_id = $1::uuid)", [seeded.projectId]]]);
      expect(await refusal(decide(created.id, 2, { decision: 'APPROVE', decisionDocumentId: await document() }))).toMatchObject({ code: 'ALLOCATION_LINE_INVALID' });
      await seedAs([["update machvon.capital_plan set status = 'PUBLISHED' where id = (select capital_plan_id from machvon.plan_version where project_id = $1::uuid)", [seeded.projectId]]]);
      await owner("update machvon.project set status = 'CLOSED' where id = $1::uuid", [seeded.projectId]);
      expect(await refusal(decide(created.id, 2, { decision: 'APPROVE', decisionDocumentId: await document() }))).toMatchObject({ code: 'PROJECT_STAGE_INVALID' });
      expect(await planRow(created.id)).toMatchObject({ status: 'IN_REVIEW' });
    });

    it('returns a plan as a DRAFT and rejects one as CANCELLED, each with the words that explain it, and keeps the words in the history', async () => {
      const returned = await submitted();
      expect(await refusal(decide(returned.created.id, 2, { decision: 'RETURN' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'comment' });
      expect(await refusal(decide(returned.created.id, 2, { decision: 'REJECT', comment: '  ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'comment' });
      expect(await refusal(decide(returned.created.id, 2, { decision: 'RETURN', comment: 'Reduce package 2', decisionDocumentId: await document() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_document_id' });
      const back = await decide(returned.created.id, 2, { decision: 'RETURN', comment: ' Reduce package 2 ' });
      expect(back).toMatchObject({ status: 'DRAFT', version: 3, comment: 'Reduce package 2', decisionDocumentId: null });
      expect(await planRow(returned.created.id)).toMatchObject({ status: 'DRAFT', submitted_by: null });
      expect(await packageStatuses(returned.created.id)).toEqual(['DRAFT', 'DRAFT']);
      // A returned plan can be submitted again, by anybody who plans.
      expect(await submit(returned.created.id, 3)).toMatchObject({ status: 'IN_REVIEW', version: 4 });

      const rejected = await submitted();
      const ended = await decide(rejected.created.id, 2, { decision: 'REJECT', comment: 'No capital for this' });
      expect(ended).toMatchObject({ status: 'CANCELLED', version: 3 });
      expect(await packageStatuses(rejected.created.id)).toEqual(['CANCELLED', 'CANCELLED']);
      expect(await eventKinds(rejected.created.id)).toEqual(['CREATED', 'SUBMITTED', 'REJECTED']);
      expect(await refusal(decide(rejected.created.id, 3, { decision: 'REJECT', comment: 'Again' }))).toMatchObject({ code: 'PLAN_STATE_INVALID' });
      // A rejected plan frees the project for a new revision.
      expect(await create(planInput(rejected.seeded, [pack(rejected.seeded.lines[0] as string, 1)]))).toMatchObject({ revision: 2 });
    });

    it('refuses a decision that is not one, a stale version, a plan that is not in review and a plan outside the scope', async () => {
      const { created } = await submitted();
      expect(await refusal(decide(created.id, 2, { decision: 'MAYBE' as never, comment: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision' });
      expect(await refusal(decide(created.id, 1, { decision: 'RETURN', comment: 'x' }))).toMatchObject({ code: 'VERSION_CONFLICT', extensions: { current_version: 2 } });
      expect(await refusal(decide(created.id, 2, { decision: 'RETURN', comment: 'x' }, APPROVER, projectScope(subtree('bid.plan.approve', OTHER_BRANCH), 'bid.plan.approve', NOW)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(await refusal(decide(randomUUID(), 1, { decision: 'RETURN', comment: 'x' }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      const draftOnly = await drafted();
      expect(await refusal(decide(draftOnly.created.id, 1, { decision: 'RETURN', comment: 'x' }))).toMatchObject({ code: 'PLAN_STATE_INVALID', status: 409 });
    });

    it('lets only one of two approvals of the same plan through', async () => {
      const { created } = await submitted();
      const decision = await document();
      const outcomes = await Promise.allSettled([
        decide(created.id, 2, { decision: 'APPROVE', decisionDocumentId: decision }),
        decide(created.id, 2, { decision: 'APPROVE', decisionDocumentId: decision }, SECOND_APPROVER),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(await owner("select count(*)::int as n from machvon.procurement_plan where project_id = (select project_id from machvon.procurement_plan where id = $1::uuid) and status = 'APPROVED'", [created.id])).toEqual([{ n: 1 }]);
    });
  });

  describe('what the database keeps for good', () => {
    it('refuses to delete a plan or a package of a plan, to rewrite what a plan was made of and to take a way the state machine does not have', async () => {
      const { created } = await approved();
      expect((await databaseRefusal(owner('delete from machvon.procurement_plan where id = $1::uuid', [created.id]))).message).toMatch(/never deleted/);
      expect((await databaseRefusal(owner('delete from machvon.procurement_package where plan_id = $1::uuid', [created.id]))).message).toMatch(/never deleted/);
      expect((await databaseRefusal(owner("update machvon.procurement_plan set total_value_vnd = 1 where id = $1::uuid", [created.id]))).message).toMatch(/keeps its project, revision, text, total and maker/);
      expect((await databaseRefusal(owner("update machvon.procurement_plan set title = 'Another title' where id = $1::uuid", [created.id]))).sqlstate).toBe('23514');
      expect((await databaseRefusal(owner("update machvon.procurement_plan set status = 'DRAFT' where id = $1::uuid", [created.id]))).message).toMatch(/state transition/);
      expect((await databaseRefusal(owner('update machvon.procurement_plan set decision_document_id = $2::uuid where id = $1::uuid', [created.id, await document()]))).message).toMatch(/approval of a procurement plan is not rewritten/);
      expect((await databaseRefusal(owner('update machvon.procurement_package set budget_vnd = 1 where plan_id = $1::uuid', [created.id]))).message).toMatch(/keeps what the plan decided/);
      expect((await databaseRefusal(owner("update machvon.procurement_package set code = 'OTHER' where plan_id = $1::uuid", [created.id]))).sqlstate).toBe('23514');
      // What may follow the plan: the status, the code on the national network, the version.
      await owner("update machvon.procurement_package set status = 'AWARDED', external_package_code = 'IB2600001', version = version + 1 where plan_id = $1::uuid", [created.id]);
      expect(await packageStatuses(created.id)).toEqual(['AWARDED', 'AWARDED']);
    });

    it('lets nobody finish a plan that was never submitted, approve it for its submitter or maker, or move a final plan', async () => {
      const { created } = await drafted();
      const decision = await document();
      expect((await databaseRefusal(owner("update machvon.procurement_plan set status = 'APPROVED', decision_document_id = $2::uuid, approved_by = $3::uuid, approved_at = now() where id = $1::uuid", [created.id, decision, memberId(APPROVER)]))).message).toMatch(/state transition/);
      const sent = await submitted();
      expect((await databaseRefusal(owner("update machvon.procurement_plan set status = 'APPROVED', decision_document_id = $2::uuid, approved_by = created_by, approved_at = now() where id = $1::uuid", [sent.created.id, decision]))).message).toMatch(/procurement_plan_sod_chk/);
      expect(
        (await databaseRefusal(owner("update machvon.procurement_plan set status = 'APPROVED', decision_document_id = $2::uuid, approved_by = submitted_by, approved_at = now() where id = $1::uuid", [sent.created.id, decision]))).message,
      ).toMatch(/procurement_plan_(submitter_sod|sod)_chk/);
      expect((await databaseRefusal(owner("update machvon.procurement_plan set status = 'IN_REVIEW', submitted_by = null where id = $1::uuid", [created.id]))).message).toMatch(/procurement_plan_submitted_chk/);
      const ended = await submitted();
      await decide(ended.created.id, 2, { decision: 'REJECT', comment: 'Not now' });
      expect((await databaseRefusal(owner("update machvon.procurement_plan set status = 'DRAFT' where id = $1::uuid", [ended.created.id]))).message).toMatch(/never changes/);
    });

    it('holds a package to a draft plan of its own project and revision, and the plan to the exact sum of its packages at the commit', async () => {
      const { seeded, created } = await approved();
      const line = seeded.lines[0] as string;
      const insertPackage = (planId: string, projectId: string, revision: number) =>
        owner(
          `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, plan_id, title, contract_type, bidding_form, allocation_line_id, planned_start_period, duration_days)
           values ($1, $2, $3, $4, 100, 'OPEN_BIDDING', $5, 'DRAFT', $6, 'Late package', 'LUMP_SUM', 'ONLINE', $7, '2026-Q4', 30)`,
          [TENANT_A, randomUUID(), projectId, nextCode('LATE'), revision, planId, line],
        );
      expect((await databaseRefusal(insertPackage(created.id, seeded.projectId, 1))).message).toMatch(/while the plan is a draft/);
      const open = await drafted();
      expect((await databaseRefusal(insertPackage(open.created.id, seeded.projectId, 1))).message).toMatch(/project and the revision of its plan/);
      expect((await databaseRefusal(insertPackage(open.created.id, open.seeded.projectId, 9))).message).toMatch(/project and the revision of its plan/);
      expect((await databaseRefusal(owner("update machvon.procurement_package set plan_id = $2::uuid where id = (select id from machvon.procurement_package where plan_id is null limit 1)", [open.created.id]))).sqlstate).toBeDefined();

      const lone = await seedProject();
      const planId = randomUUID();
      const insertLone = (total: number) =>
        owner(
          `insert into machvon.procurement_plan (tenant_id, id, project_id, revision, title, total_value_vnd, legal_basis, status, created_by, updated_by)
           values ($1, $2, $3, 1, 'Plan with no packages', $4, 'Law', 'DRAFT', $5, $5)`,
          [TENANT_A, planId, lone.projectId, total, memberId(MAKER)],
        );
      expect((await databaseRefusal(insertLone(5))).message).toMatch(/sum of its packages/);
      await insertLone(0);
      expect((await databaseRefusal(owner("insert into machvon.procurement_plan (tenant_id, id, project_id, revision, title, total_value_vnd, legal_basis, status, created_by, updated_by) values ($1, $2, $3, 2, 'Starts approved', 0, 'Law', 'APPROVED', $4, $4)", [TENANT_A, randomUUID(), lone.projectId, memberId(MAKER)]))).message).toMatch(/starts as a draft/);
    });

    it('keeps the history of a plan: a step is never changed or deleted, and a rejection needs its words', async () => {
      const { created } = await submitted();
      expect((await databaseRefusal(owner("update machvon.procurement_plan_event set comment = 'x' where plan_id = $1::uuid", [created.id]))).message).toMatch(/never changed or deleted/);
      expect((await databaseRefusal(owner('delete from machvon.procurement_plan_event where plan_id = $1::uuid', [created.id]))).message).toMatch(/never changed or deleted/);
      expect(
        (
          await databaseRefusal(
            owner("insert into machvon.procurement_plan_event (tenant_id, id, plan_id, event_kind, from_status, to_status, actor_id) values ($1, $2, $3, 'REJECTED', 'IN_REVIEW', 'CANCELLED', $4)", [TENANT_A, randomUUID(), created.id, memberId(APPROVER)]),
          )
        ).message,
      ).toMatch(/procurement_plan_event_comment_chk/);
      expect((await databaseRefusal(owner("insert into machvon.procurement_plan_event (tenant_id, id, plan_id, event_kind, to_status, actor_id) values ($1, $2, $3, 'APPROVED', 'APPROVED', $4)", [TENANT_A, randomUUID(), created.id, memberId(APPROVER)]))).message).toMatch(/procurement_plan_event_decision_chk/);
    });

    it('lets the runtime role neither delete nor truncate plans, packages or their history, nor change the history', async () => {
      const client = new Client({ connectionString: harness.database.adminUrl });
      await client.connect();
      try {
        const answer = await client.query<{ relname: string; can_delete: boolean; can_truncate: boolean; can_update: boolean }>(
          `select c.relname, has_table_privilege('machvon_app', c.oid, 'DELETE') as can_delete, has_table_privilege('machvon_app', c.oid, 'TRUNCATE') as can_truncate,
                  has_table_privilege('machvon_app', c.oid, 'UPDATE') as can_update
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'machvon' and c.relname in ('procurement_plan', 'procurement_package', 'procurement_plan_event') order by c.relname`,
        );
        expect(answer.rows).toEqual([
          { relname: 'procurement_package', can_delete: false, can_truncate: false, can_update: true },
          { relname: 'procurement_plan', can_delete: false, can_truncate: false, can_update: true },
          { relname: 'procurement_plan_event', can_delete: false, can_truncate: false, can_update: false },
        ]);
      } finally {
        await client.end();
      }
    });
  });

  describe('the reads', () => {
    const allProjects = (circle: boolean): BidReadScope => ({ projects: everything, circle });

    it('lists the plans newest first with the decision, the count of packages and the last step; the words belong to the circle that plans and approves', async () => {
      const first = await approved();
      const second = await submitted();
      await decide(second.created.id, 2, { decision: 'RETURN', comment: 'Split package 1' });
      const third = await drafted();
      const circle = await as((tx) => reads.listPlans(tx, allProjects(true), {}, { limit: 50, after: undefined }));
      const ids = circle.map((line) => line.id);
      expect(ids.indexOf(third.created.id)).toBeLessThan(ids.indexOf(second.created.id));
      expect(ids.indexOf(second.created.id)).toBeLessThan(ids.indexOf(first.created.id));
      const approvedLine = circle.find((line) => line.id === first.created.id);
      expect(approvedLine).toMatchObject({
        status: 'APPROVED',
        packageCount: 2,
        totalVnd: money(28),
        version: 3,
        decisionDocument: { id: first.decided.decisionDocumentId, symbol: '45/QD-UBND', issuedOn: '2026-10-01' },
        lastDecision: { kind: 'APPROVED', comment: null },
        project: { id: first.seeded.projectId, status: 'IMPLEMENTATION' },
      });
      expect(circle.find((line) => line.id === second.created.id)?.lastDecision).toMatchObject({ kind: 'RETURNED', comment: 'Split package 1' });
      expect(circle.find((line) => line.id === third.created.id)).toMatchObject({ status: 'DRAFT', lastDecision: null, decisionDocument: null, approvedAt: null });

      const readers = await as((tx) => reads.listPlans(tx, allProjects(false), {}, { limit: 50, after: undefined }));
      expect(readers.map((line) => line.id)).toContain(first.created.id);
      expect(readers.map((line) => line.id)).not.toContain(second.created.id);
      expect(readers.map((line) => line.id)).not.toContain(third.created.id);
      expect(readers.every((line) => line.status === 'APPROVED' || line.status === 'SUPERSEDED')).toBe(true);
    });

    it('filters by project and status, pages by cursor and stays inside the scope', async () => {
      const first = await approved();
      const next = await create(planInput(first.seeded, [pack(first.seeded.lines[0] as string, 2)]));
      const byProject = await as((tx) => reads.listPlans(tx, allProjects(true), { projectId: first.seeded.projectId }, { limit: 50, after: undefined }));
      expect(byProject.map((line) => line.id)).toEqual([next.id, first.created.id]);
      expect((await as((tx) => reads.listPlans(tx, allProjects(true), { projectId: first.seeded.projectId, status: 'DRAFT' }, { limit: 50, after: undefined }))).map((line) => line.id)).toEqual([next.id]);
      const page1 = await as((tx) => reads.listPlans(tx, allProjects(true), { projectId: first.seeded.projectId }, { limit: 1, after: undefined }));
      const anchor = page1[0] as { createdAtKey: string; id: string };
      const page2 = await as((tx) => reads.listPlans(tx, allProjects(true), { projectId: first.seeded.projectId }, { limit: 5, after: { code: anchor.createdAtKey, id: anchor.id } }));
      expect(page2.map((line) => line.id)).toEqual([first.created.id]);
      const outside = bidReadScope(subtree('bid.read', OTHER_BRANCH), 'bid.read', NOW);
      expect(await as((tx) => reads.listPlans(tx, outside, { projectId: first.seeded.projectId }, { limit: 50, after: undefined }))).toEqual([]);
      expect(await as((tx) => reads.listPlans(tx, allProjects(true), {}, { limit: 50, after: undefined }), MAKER, TENANT_B)).toEqual([]);
    });

    it('lists the packages with their plan, project, fund source and period; a package outside a plan is shown like one in force', async () => {
      const { seeded, created } = await approved({ lines: [30] });
      await seedAs([
        [
          `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'FUND_SOURCE', 'NSTW-BID', 'EFFECTIVE', $3, $3)`,
          [TENANT_A, id(FAMILY, 95), memberId(MAKER)],
        ],
        [
          `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
           values ($1, $2, 'FUND_SOURCE', 'NSTW-BID', 1, 'Central budget', '{}', '2020-01-01', 'EFFECTIVE', $3, now(), $4, $4)`,
          [TENANT_A, id(FAMILY, 91), id(FAMILY, 95), memberId(MAKER)],
        ],
        [
          `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status) values ($1, $2, $3, $4, 1000, 'OPEN', 1, 'AWARDED')`,
          [TENANT_A, id(FAMILY, 96), seeded.projectId, nextCode('LEGACY')],
        ],
      ]);
      const circle = await as((tx) => reads.listPackages(tx, allProjects(true), { limit: 200, after: undefined }));
      const mine = circle.filter((line) => line.plan?.id === created.id);
      expect(mine).toHaveLength(2);
      expect(mine[0]).toMatchObject({
        title: 'Construction package',
        status: 'PLANNED',
        method: 'OPEN_BIDDING',
        contractType: 'LUMP_SUM',
        biddingForm: 'ONLINE',
        plannedStartPeriod: '2026-Q4',
        durationDays: 180,
        plan: { id: created.id, revision: 1, status: 'APPROVED' },
        project: { id: seeded.projectId },
        fundSource: { businessKey: 'NSTW-BID', label: 'Central budget' },
        allocationLineId: seeded.lines[0],
      });
      const legacy = circle.find((line) => line.id === id(FAMILY, 96));
      expect(legacy).toMatchObject({ plan: null, title: null, contractType: null, fundSource: null, status: 'AWARDED', budgetVnd: '1000' });
      const working = await drafted();
      const readers = await as((tx) => reads.listPackages(tx, allProjects(false), { limit: 200, after: undefined }));
      expect(readers.some((line) => line.plan?.id === working.created.id)).toBe(false);
      expect(readers.some((line) => line.id === id(FAMILY, 96))).toBe(true);
      const circleAgain = await as((tx) => reads.listPackages(tx, allProjects(true), { limit: 200, after: undefined }));
      expect(circleAgain.some((line) => line.plan?.id === working.created.id)).toBe(true);

      const page1 = await as((tx) => reads.listPackages(tx, allProjects(true), { limit: 1, after: undefined }));
      const anchor = page1[0] as { createdAtKey: string; id: string };
      const page2 = await as((tx) => reads.listPackages(tx, allProjects(true), { limit: 200, after: { code: anchor.createdAtKey, id: anchor.id } }));
      expect(page2.map((line) => line.id)).not.toContain(anchor.id);
    });

    it('finds one package in the scope of the caller and hides the rest', async () => {
      const { seeded, created } = await approved();
      const packageId = created.packages[0]?.id as string;
      const found = await as((tx) => reads.findPackage(tx, packageId, allProjects(false)));
      expect(found).toMatchObject({ id: packageId, code: created.packages[0]?.code, budgetVnd: created.packages[0]?.budgetVnd });
      const outside = bidReadScope(subtree('procurement_package.read', OTHER_BRANCH), 'procurement_package.read', NOW);
      expect(await as((tx) => reads.findPackage(tx, packageId, outside))).toBeUndefined();
      expect(await as((tx) => reads.findPackage(tx, packageId, allProjects(true)), MAKER, TENANT_B)).toBeUndefined();
      expect(await as((tx) => reads.findPackage(tx, randomUUID(), allProjects(true)))).toBeUndefined();
      const working = await drafted({ unit: DEPARTMENT });
      expect(await as((tx) => reads.findPackage(tx, working.created.packages[0]?.id as string, allProjects(false)))).toBeUndefined();
      expect(await as((tx) => reads.findPackage(tx, working.created.packages[0]?.id as string, allProjects(true)))).toMatchObject({ status: 'DRAFT' });
      expect(seeded.projectId).toBeDefined();
    });

    it('is in the circle that plans and approves when a grant carries either permission, on any scope', () => {
      expect(bidReadScope(subtree('bid.plan.manage', DEPARTMENT), 'bid.read', NOW).circle).toBe(true);
      expect(bidReadScope(subtree('bid.plan.approve', DEPARTMENT), 'bid.read', NOW).circle).toBe(true);
      expect(bidReadScope(subtree('bid.read', DEPARTMENT), 'bid.read', NOW).circle).toBe(false);
    });
  });
});

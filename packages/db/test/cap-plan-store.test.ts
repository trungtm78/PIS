import { randomUUID } from 'node:crypto';
import { assertOneWinner, runConcurrently, runLoops, tallyOutcomes, vietnamDateOf } from '@machvon/kernel';
import type { CommandOutcome, EffectiveAccess, Scope } from '@machvon/kernel';
import { CapAppropriationStore } from '../src/cap-appropriation-store';
import type { AppropriationInput } from '../src/cap-appropriation-store';
import { CapPlanReads, planReadScope } from '../src/cap-plan-reads';
import type { PlanReadScope } from '../src/cap-plan-reads';
import { CapPlanStore } from '../src/cap-plan-store';
import type { DraftScopes, LineInput } from '../src/cap-plan-store';
import { PrjProjectStore, projectScope } from '../src/prj-project-store';
import type { ProjectStatus } from '../src/prj-project-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const appropriations = new CapAppropriationStore();
const plans = new CapPlanStore();
const reads = new CapPlanReads();
const projects = new PrjProjectStore();
const MAKER = 1;
const APPROVER = 2;
const SECOND_MAKER = 3;
const ROOT = 1;
const BQL1 = 2;
const BQL2 = 3;
const BILLION = 1_000_000_000;
const TODAY = vietnamDateOf(new Date());

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const allDrafts: PlanReadScope = { lines: everything, drafts: true };
const scopes: DraftScopes = { write: everything, read: allDrafts };
const money = (billions: number): string => String(billions * BILLION);
const million = (millions: number): string => String(millions * 1_000_000);

const grant = (permission: string, scope: Scope): EffectiveAccess => ({
  membershipId: memberId(MAKER),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const subtree = (permission: string, unit: number): EffectiveAccess => grant(permission, { kind: 'UNIT_SUBTREE', refIds: [unitId(unit)], paths: [`/${unitId(ROOT)}/${unitId(unit)}/`] });

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = MAKER): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
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

const sqlState = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? '';
  }
  throw new Error('expected the database to refuse');
};

let counter = 0;
let yearCounter = 2100;
const freshYear = (): number => {
  yearCounter -= 1;
  return yearCounter;
};
const versions: Record<string, string> = {};

async function seedMaster(name: string, masterType: string, attributes: Record<string, unknown>, tenant = TENANT_A): Promise<string> {
  counter += 1;
  const recordId = randomUUID();
  const versionId = randomUUID();
  const key = `${name}-${counter}`;
  await harness.owner(tenant, [
    [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, 'EFFECTIVE', $5, $5)`, [tenant, recordId, masterType, key, memberId(MAKER)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, $3, $4, 1, $5, $6::jsonb, '2020-01-01', 'EFFECTIVE', $7, now(), $8, $8)`,
      [tenant, versionId, masterType, key, `Label ${key}`, JSON.stringify(attributes), recordId, memberId(MAKER)],
    ],
  ]);
  return versionId;
}

async function document(tenant = TENANT_A): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
    [tenant, id, `QD-${id.slice(0, 8)}/2026`, memberId(MAKER)],
    tenant,
  );
  return id;
}

/** A published appropriation (registered by one person, decided by another). */
async function appropriation(options: Partial<AppropriationInput> & { publish?: boolean } = {}): Promise<string> {
  const planYear = options.planYear ?? freshYear();
  const carryover = options.origin === 'CARRYOVER';
  const input: AppropriationInput = {
    fundSourceVersionId: versions.nstw as string,
    planYear,
    origin: 'PM_ASSIGNED',
    budgetLevel: 'CENTRAL',
    amountVnd: money(10),
    decisionDocumentId: await document(),
    issuingAuthority: 'Thủ tướng Chính phủ',
    sourceYear: carryover ? planYear - 1 : planYear,
    ...(carryover ? { extendedTo: `${planYear}-12-31`, extensionDocumentId: await document() } : {}),
    ...options,
  };
  delete (input as { publish?: boolean }).publish;
  const draft = await as((tx) => appropriations.register(tx, input, memberId(MAKER), TODAY));
  if (options.publish === false) return draft.id;
  await as((tx) => appropriations.decide(tx, draft.id, draft.version, 'approve', memberId(APPROVER), TODAY), TENANT_A, APPROVER);
  return draft.id;
}

async function project(status: ProjectStatus = 'PIPELINE', unit = BQL1, tenant = TENANT_A): Promise<string> {
  counter += 1;
  const number = counter;
  const code = `CP-${number}-${randomUUID().slice(0, 6)}`;
  const created = await as(
    (tx) => projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(unit), areaMasterVersionId: tenant === TENANT_A ? (versions.area as string) : (versions.areaB as string), totalInvestmentVnd: '500000000000' }, memberId(MAKER), TODAY),
    tenant,
  );
  await owner('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, status, 'B', String(7000000 + number)], tenant);
  return created.id;
}

async function plan(options: { kind?: 'ANNUAL' | 'MEDIUM_TERM'; year?: number; from?: number; to?: number; code?: string; unit?: number } = {}): Promise<{ id: string; year: number }> {
  counter += 1;
  const kind = options.kind ?? 'ANNUAL';
  const year = options.year ?? freshYear();
  const created = await as((tx) =>
    plans.createPlan(
      tx,
      {
        planCode: options.code ?? `CP-${counter}-${randomUUID().slice(0, 6)}`,
        planKind: kind,
        ...(kind === 'ANNUAL' ? { planYear: year } : {}),
        periodFromYear: options.from ?? year,
        periodToYear: options.to ?? year,
        scopeUnitId: unitId(options.unit ?? ROOT),
      },
      memberId(MAKER),
      () => undefined,
    ),
  );
  return { id: created.id, year };
}

const planRow = async (id: string) =>
  (await owner<{ version: string; status: string; updated_by: string }>('select version::text as version, status, updated_by from machvon.capital_plan where id = $1::uuid', [id]))[0] as { version: string; status: string; updated_by: string };
const versionOf = async (id: string): Promise<number> => Number((await planRow(id)).version);
const appropriationRow = async (id: string) =>
  (await owner<{ amount: string; allocated: string; version: string }>('select amount_vnd::text as amount, allocated_total_vnd::text as allocated, version::text as version from machvon.appropriation where id = $1::uuid', [id]))[0] as {
    amount: string;
    allocated: string;
    version: string;
  };
const linesOf = (planId: string) =>
  owner<{ id: string; project_id: string; appropriation_id: string; amount: string; ctmtqg: string; bucket: string; budget_level: string; origin: string; created_by: string; version: string }>(
    `select al.id, al.project_id, al.appropriation_id, al.amount_vnd::text as amount, al.ctmtqg_subset_vnd::text as ctmtqg, al.bucket, al.budget_level, al.origin, al.created_by, al.version::text as version
       from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid order by al.created_at, al.id`,
    [planId],
  );

const line = (target: { project: string; appropriation: string; year: number }, amount: string, extra: Partial<LineInput> = {}): LineInput => ({
  projectId: target.project,
  appropriationId: target.appropriation,
  bucket: 'CURRENT_YEAR',
  sourceYear: target.year,
  amountVnd: amount,
  ...extra,
});

async function draft(planId: string, lines: LineInput[], options: { version?: number; remove?: string[]; scope?: DraftScopes; member?: number } = {}) {
  const version = options.version ?? (await versionOf(planId));
  return as((tx) => plans.draft(tx, planId, version, { lines, removeLineIds: options.remove }, memberId(options.member ?? MAKER), options.scope ?? scopes, TODAY), TENANT_A, options.member ?? MAKER);
}

const drift = (ids?: string[]) => as((tx) => plans.allocatedDrift(tx, ids));

/** The reset of a race: the owner puts an allocated total back (the setting that the guard asks for is raised in the same session). */
const setAllocated = (ids: string[], total: string) =>
  harness.owner(TENANT_A, [["select set_config('app.cap_allocation_write', 'on', false)"], ['update machvon.appropriation set allocated_total_vnd = $2::numeric where id = any($1::uuid[])', [ids, total]]]);

/** The reset of a race: the lines and versions of some plans are removed and the plans are at version 1 again. */
async function emptyPlans(planIds: string[]): Promise<void> {
  for (const planId of planIds) {
    await owner('delete from machvon.allocation_line where plan_version_id in (select id from machvon.plan_version where capital_plan_id = $1::uuid)', [planId]);
    await owner('delete from machvon.plan_version where capital_plan_id = $1::uuid', [planId]);
    await owner('update machvon.capital_plan set version = 1 where id = $1::uuid', [planId]);
  }
}

beforeAll(async () => {
  await harness.start();
  for (const tenant of [TENANT_A, TENANT_B]) {
    await harness.seedUnits(tenant, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: BQL1, path: `/${unitId(ROOT)}/${unitId(BQL1)}/`, parent: ROOT },
      { n: BQL2, path: `/${unitId(ROOT)}/${unitId(BQL2)}/`, parent: ROOT },
    ]);
    for (const member of [MAKER, APPROVER, SECOND_MAKER]) await harness.seedMembership(tenant, member, ROOT);
  }
  versions.nstw = await seedMaster('NSTW-DTPT', 'FUND_SOURCE', { category: 'NSTW', relation: 'ADDITIVE' });
  versions.nsdp = await seedMaster('NSDP-DTPT', 'FUND_SOURCE', { category: 'NSDP', relation: 'ADDITIVE' });
  versions.ctmtqg = await seedMaster('CTMTQG-NTM', 'PROGRAM', { category: 'CTMTQG' });
  versions.otherProgram = await seedMaster('CTMTQG-OTHER', 'PROGRAM', { category: 'CTMTQG' });
  versions.area = await seedMaster('AREA', 'AREA', {});
  versions.areaB = await seedMaster('AREA-B', 'AREA', {}, TENANT_B);
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

describe('CapPlanStore.createPlan (createCapitalPlan)', () => {
  it('creates revision 1 in DRAFT at version 1, for an annual plan and for a medium-term plan', async () => {
    const annual = await plan({ kind: 'ANNUAL', year: 2031 });
    expect(await planRow(annual.id)).toMatchObject({ version: '1', status: 'DRAFT', updated_by: memberId(MAKER) });
    const medium = await plan({ kind: 'MEDIUM_TERM', from: 2031, to: 2035, year: 2031 });
    const header = await as((tx) => reads.findPlan(tx, medium.id, allDrafts));
    expect(header).toMatchObject({ planKind: 'MEDIUM_TERM', planYear: null, periodFromYear: 2031, periodToYear: 2035, revision: 1, status: 'DRAFT', version: 1, scopeUnit: { id: unitId(ROOT) }, totals: { lineCount: 0, allocatedVnd: '0' } });
  });

  it('refuses a second plan with the same code (409 PLAN_CODE_DUPLICATE) and lets only one of two parallel creations win, never a raw database error', async () => {
    const code = `DUP-${randomUUID().slice(0, 8)}`;
    await plan({ code });
    expect(await refusal(plan({ code }))).toMatchObject({ code: 'PLAN_CODE_DUPLICATE', status: 409, detail: 'plan_code' });
    const racing = `RACE-${randomUUID().slice(0, 8)}`;
    const outcomes = await runConcurrently([0, 1].map(() => () => plan({ code: racing }).then(() => undefined)));
    expect(tallyOutcomes(outcomes)).toEqual({ '200': 1, '409 PLAN_CODE_DUPLICATE': 1 });
  });

  it('judges the shape of the plan: kind, years, code, unit', async () => {
    const create = (input: Partial<Parameters<CapPlanStore['createPlan']>[1]>, authorize: (unit: { id: string; path: string }) => void = () => undefined) =>
      as((tx) => plans.createPlan(tx, { planCode: `SHAPE-${randomUUID().slice(0, 6)}`, planKind: 'ANNUAL', planYear: 2040, periodFromYear: 2040, periodToYear: 2040, scopeUnitId: unitId(ROOT), ...input }, memberId(MAKER), authorize));
    expect(await refusal(create({ planKind: 'WEEKLY' as never }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'plan_kind' });
    expect(await refusal(create({ planCode: '   ' }))).toMatchObject({ detail: 'plan_code' });
    expect(await refusal(create({ planCode: 'x'.repeat(51) }))).toMatchObject({ detail: 'plan_code' });
    expect(await refusal(create({ planCode: 'bad\u0007code' }))).toMatchObject({ detail: 'plan_code' });
    expect(await refusal(create({ planYear: undefined }))).toMatchObject({ detail: 'plan_year' });
    expect(await refusal(create({ planYear: 1800, periodFromYear: 1800, periodToYear: 1800 }))).toMatchObject({ detail: 'period_from_year' });
    expect(await refusal(create({ periodFromYear: 2039 }))).toMatchObject({ detail: 'period_from_year' });
    expect(await refusal(create({ planKind: 'MEDIUM_TERM', planYear: 2040, periodFromYear: 2040, periodToYear: 2044 }))).toMatchObject({ detail: 'plan_year' });
    expect(await refusal(create({ planKind: 'MEDIUM_TERM', planYear: undefined, periodFromYear: 2044, periodToYear: 2044 }))).toMatchObject({ detail: 'period_to_year' });
    expect(await refusal(create({ scopeUnitId: 'nope' }))).toMatchObject({ detail: 'scope_unit_id' });
    expect(await refusal(create({ scopeUnitId: randomUUID() }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await refusal(create({}, () => { throw Object.assign(new Error('x'), { code: 'SCOPE_DENIED', status: 403 }); }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
  });

  it('refuses a locked year (409 FISCAL_YEAR_LOCKED)', async () => {
    const year = freshYear();
    await owner(`insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, locked_at, locked_by, created_by, updated_by) values ($1, $2, $3, 'LOCKED', now(), $4, $4, $4)`, [TENANT_A, randomUUID(), year, memberId(MAKER)]);
    expect(await refusal(plan({ year }))).toMatchObject({ code: 'FISCAL_YEAR_LOCKED', status: 409 });
  });
});

describe('CapPlanStore.draft (draftCapitalAllocation)', () => {
  it('adds lines for projects: the allocated total moves with them, the lines carry what the appropriation says, and the plan version moves by one', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const first = await project();
    const second = await project('BUDGETED', BQL2);
    const result = await draft(target.id, [line({ project: first, appropriation: source, year: target.year }, money(3)), line({ project: second, appropriation: source, year: target.year }, money(2), { ctmtqgSubsetVnd: million(400) })]);
    expect(result).toMatchObject({ planId: target.id, status: 'DRAFT', version: 2 });
    expect(result.changes.map((change) => [change.kind, change.toVnd])).toEqual([
      ['ADDED', money(3)],
      ['ADDED', money(2)],
    ]);
    expect(result.appropriations).toEqual([{ id: source, amountVnd: money(10), allocatedBeforeVnd: '0', allocatedAfterVnd: money(5) }]);
    expect(await versionOf(target.id)).toBe(2);
    expect(await appropriationRow(source)).toMatchObject({ amount: money(10), allocated: money(5) });
    const stored = await linesOf(target.id);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ budget_level: 'CENTRAL', origin: 'PM_ASSIGNED', bucket: 'CURRENT_YEAR', created_by: memberId(MAKER), version: '1' });
    expect(await owner<{ n: string }>('select count(*)::text as n from machvon.plan_version where capital_plan_id = $1::uuid', [target.id])).toEqual([{ n: '2' }]);
    expect(await drift([source])).toEqual([]);
  });

  it('answers 422 APPROPRIATION_EXCEEDED with available_vnd when a line is larger than what the appropriation has left, and writes nothing (AC-ST-CAP-002-2)', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const base = await project();
    const other = await project();
    await draft(target.id, [line({ project: base, appropriation: source, year: target.year }, money(5))]);
    const before = { plan: await versionOf(target.id), appropriation: await appropriationRow(source), lines: await linesOf(target.id) };
    const refused = await refusal(draft(target.id, [line({ project: other, appropriation: source, year: target.year }, money(6))]));
    expect(refused).toMatchObject({ code: 'APPROPRIATION_EXCEEDED', status: 422, detail: 'amount_vnd', extensions: { available_vnd: '5000000000', appropriation_id: source } });
    expect({ plan: await versionOf(target.id), appropriation: await appropriationRow(source), lines: await linesOf(target.id) }).toEqual(before);
    // The whole of what is left fits, one dong more does not.
    expect(await refusal(draft(target.id, [line({ project: other, appropriation: source, year: target.year }, String(5 * BILLION + 1))]))).toMatchObject({ code: 'APPROPRIATION_EXCEEDED', extensions: { available_vnd: '5000000000' } });
    await draft(target.id, [line({ project: other, appropriation: source, year: target.year }, money(5))]);
    expect(await appropriationRow(source)).toMatchObject({ allocated: money(10) });
    expect(await drift([source])).toEqual([]);
  });

  it('adds up the lines of one command against the ceiling together, and refuses the whole command when it does not fit', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const [a, b, c] = [await project(), await project(), await project()] as [string, string, string];
    const refused = await refusal(draft(target.id, [a, b, c].map((p) => line({ project: p, appropriation: source, year: target.year }, money(4)))));
    expect(refused).toMatchObject({ code: 'APPROPRIATION_EXCEEDED', extensions: { available_vnd: money(10) } });
    expect(await linesOf(target.id)).toEqual([]);
    expect(await owner('select 1 from machvon.plan_version where capital_plan_id = $1::uuid', [target.id])).toEqual([]);
  });

  it('keeps CTMTQG inside the line and out of the total (AC-ST-CAP-002-3)', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const nsdp = await appropriation({ planYear: target.year, fundSourceVersionId: versions.nsdp as string, budgetLevel: 'LOCAL', amountVnd: money(5) });
    const first = await project();
    await draft(target.id, [
      line({ project: first, appropriation: source, year: target.year }, money(1), { ctmtqgSubsetVnd: million(400), programMasterVersionId: versions.ctmtqg as string }),
      line({ project: first, appropriation: nsdp, year: target.year }, million(500)),
    ]);
    const totals = await as((tx) => reads.lineTotals(tx, { capitalPlanId: target.id }, allDrafts));
    expect(totals).toEqual({ lineCount: 2, allocatedVnd: '1500000000', ctmtqgSubsetVnd: '400000000' });
    const header = await as((tx) => reads.findPlan(tx, target.id, allDrafts));
    expect(header?.totals).toEqual({ lineCount: 2, allocatedVnd: '1500000000', ctmtqgSubsetVnd: '400000000', ceilingVnd: String(15 * BILLION) });
    expect(header?.fundSources.map((fund) => fund.businessKey).sort()).toEqual([expect.stringContaining('NSDP'), expect.stringContaining('NSTW')]);
    // More CTMTQG than the line is refused, on a new line and on a change; the same amount is allowed.
    const second = await project();
    expect(await refusal(draft(target.id, [line({ project: second, appropriation: source, year: target.year }, million(100), { ctmtqgSubsetVnd: million(101) })]))).toMatchObject({ code: 'SUBSET_EXCEEDS_PARENT', status: 422, detail: 'ctmtqg_subset_vnd' });
    expect(await refusal(draft(target.id, [line({ project: first, appropriation: source, year: target.year }, money(1), { ctmtqgSubsetVnd: String(BILLION + 1), programMasterVersionId: versions.ctmtqg as string })]))).toMatchObject({ code: 'SUBSET_EXCEEDS_PARENT' });
    await draft(target.id, [line({ project: second, appropriation: source, year: target.year }, million(100), { ctmtqgSubsetVnd: million(100) })]);
    expect((await as((tx) => reads.lineTotals(tx, { capitalPlanId: target.id }, allDrafts))).ctmtqgSubsetVnd).toBe('500000000');
  });

  it('changes the amount of a line (the total follows), leaves a repeated request alone, and removes a line with its version when it was the last one', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const [a, b] = [await project(), await project()] as [string, string];
    const first = await draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(3)), line({ project: b, appropriation: source, year: target.year }, money(2))]);
    const [lineA, lineB] = first.changes.map((change) => change.lineId) as [string, string];
    // A bigger and then a smaller amount: the same line, version 3 of the line, the total follows.
    const raised = await draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(4))]);
    expect(raised.changes).toMatchObject([{ kind: 'CHANGED', lineId: lineA, fromVnd: money(3), toVnd: money(4) }]);
    expect(await appropriationRow(source)).toMatchObject({ allocated: money(6) });
    await draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(1))]);
    expect(await appropriationRow(source)).toMatchObject({ allocated: money(3) });
    expect((await linesOf(target.id)).find((stored) => stored.id === lineA)).toMatchObject({ amount: money(1), version: '3' });
    // The same request again changes nothing and moves no version.
    const version = await versionOf(target.id);
    const appropriationVersion = (await appropriationRow(source)).version;
    const again = await draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(1))]);
    expect(again).toMatchObject({ version, changes: [], appropriations: [] });
    expect(await versionOf(target.id)).toBe(version);
    expect((await appropriationRow(source)).version).toBe(appropriationVersion);
    // Removing frees the ceiling at once; the version of a project with no line left goes with it.
    const removed = await draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(1))], { remove: [lineB] });
    expect(removed.changes).toMatchObject([{ kind: 'REMOVED', lineId: lineB, fromVnd: money(2), toVnd: null }]);
    expect(await appropriationRow(source)).toMatchObject({ allocated: money(1) });
    expect(await owner('select 1 from machvon.plan_version where capital_plan_id = $1::uuid and project_id = $2::uuid', [target.id, b])).toEqual([]);
    expect(await drift([source])).toEqual([]);
    await draft(target.id, [line({ project: b, appropriation: source, year: target.year }, money(9))]);
    expect(await appropriationRow(source)).toMatchObject({ allocated: money(10) });
    expect(await drift([source])).toEqual([]);
  });

  it('does not take a removal of a line that belongs to another plan, nor a line removed and written in the same command', async () => {
    const mine = await plan();
    const others = await plan({ year: mine.year });
    const source = await appropriation({ planYear: mine.year });
    const a = await project();
    const b = await project();
    const foreign = (await draft(others.id, [line({ project: b, appropriation: source, year: mine.year }, money(1))])).changes[0]?.lineId as string;
    const own = (await draft(mine.id, [line({ project: a, appropriation: source, year: mine.year }, money(1))])).changes[0]?.lineId as string;
    expect(await refusal(draft(mine.id, [line({ project: a, appropriation: source, year: mine.year }, money(2))], { remove: [foreign] }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await refusal(draft(mine.id, [line({ project: a, appropriation: source, year: mine.year }, money(2))], { remove: [own] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'remove_line_ids' });
    expect(await refusal(draft(mine.id, [line({ project: a, appropriation: source, year: mine.year }, money(2)), line({ project: a, appropriation: source, year: mine.year }, money(3))]))).toMatchObject({ detail: 'lines' });
    expect(await refusal(draft(mine.id, []))).toMatchObject({ detail: 'lines' });
    expect(await refusal(draft(mine.id, [line({ project: a, appropriation: source, year: mine.year }, money(2))], { remove: ['nope'] }))).toMatchObject({ detail: 'remove_line_ids' });
    expect(await linesOf(others.id)).toHaveLength(1);
    expect(await drift([source])).toEqual([]);
  });

  it('accepts a command that only removes lines', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const a = await project();
    const added = await draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(2))]);
    const removed = await draft(target.id, [], { remove: [added.changes[0]?.lineId as string] });
    expect(removed.changes).toMatchObject([{ kind: 'REMOVED' }]);
    expect(await appropriationRow(source)).toMatchObject({ allocated: '0' });
  });

  it('refuses the amounts the column cannot hold exactly: zero, negative, fractions, text, more than 24 digits (422, never a database overflow)', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const a = await project();
    for (const amount of ['0', '-5', '1.5', '1000.00', 'abc', '', '1'.repeat(25), '٣']) {
      expect(await refusal(draft(target.id, [line({ project: a, appropriation: source, year: target.year }, amount)]))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'amount_vnd' });
    }
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: source, year: target.year }, 12 as unknown as string)]))).toMatchObject({ detail: 'amount_vnd' });
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(1), { ctmtqgSubsetVnd: '-1' })]))).toMatchObject({ detail: 'ctmtqg_subset_vnd' });
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(1), { ctmtqgSubsetVnd: '1.5' })]))).toMatchObject({ detail: 'ctmtqg_subset_vnd' });
    const huge = `9${'0'.repeat(23)}`;
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: source, year: target.year }, huge)]))).toMatchObject({ code: 'APPROPRIATION_EXCEEDED', status: 422 });
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(1), { bucket: 'ELSEWHERE' as never })]))).toMatchObject({ detail: 'bucket' });
    expect(await refusal(draft(target.id, [line({ project: 'x', appropriation: source, year: target.year }, money(1))]))).toMatchObject({ detail: 'project_id' });
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: 'x', year: target.year }, money(1))]))).toMatchObject({ detail: 'appropriation_id' });
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: source, year: 1800 }, money(1))]))).toMatchObject({ detail: 'source_year' });
    expect(await refusal(draft(target.id, Array.from({ length: 201 }, () => line({ project: a, appropriation: source, year: target.year }, money(1)))))).toMatchObject({ detail: 'lines' });
    expect(await linesOf(target.id)).toEqual([]);
  });

  it('stores identifiers in small letters whatever the request spelled', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const a = await project();
    const result = await draft(target.id, [line({ project: a.toUpperCase(), appropriation: source.toUpperCase(), year: target.year }, money(1))]);
    expect(result.changes[0]).toMatchObject({ projectId: a, appropriationId: source });
    expect((await linesOf(target.id))[0]).toMatchObject({ project_id: a, appropriation_id: source });
  });

  it('refuses a plan that is no longer a draft (409 PLAN_NOT_DRAFT) and a plan that does not exist (404)', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const a = await project();
    await draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(1))]);
    await owner("update machvon.capital_plan set status = 'IN_REVIEW', submitted_by = $2::uuid, version = version + 1 where id = $1::uuid", [target.id, memberId(MAKER)]);
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(2))]))).toMatchObject({ code: 'PLAN_NOT_DRAFT', status: 409 });
    expect(await refusal(draft(randomUUID(), [line({ project: a, appropriation: source, year: target.year }, money(2))], { version: 1 }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await appropriationRow(source)).toMatchObject({ allocated: money(1) });
  });

  it('refuses a locked year: the year of an annual plan, and the year of the appropriation of a line in a medium-term plan (409 FISCAL_YEAR_LOCKED)', async () => {
    const annual = await plan();
    const source = await appropriation({ planYear: annual.year });
    const a = await project();
    await owner(`insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, locked_at, locked_by, created_by, updated_by) values ($1, $2, $3, 'LOCKED', now(), $4, $4, $4)`, [TENANT_A, randomUUID(), annual.year, memberId(MAKER)]);
    expect(await refusal(draft(annual.id, [line({ project: a, appropriation: source, year: annual.year }, money(1))]))).toMatchObject({ code: 'FISCAL_YEAR_LOCKED', status: 409 });
    const first = freshYear();
    // The year before it is locked below: no other test may be given it as its own.
    freshYear();
    const medium = await plan({ kind: 'MEDIUM_TERM', from: first - 1, to: first, year: first });
    const lockedSource = await appropriation({ planYear: first - 1 });
    const openSource = await appropriation({ planYear: first });
    await owner(`insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, locked_at, locked_by, created_by, updated_by) values ($1, $2, $3, 'LOCKED', now(), $4, $4, $4)`, [TENANT_A, randomUUID(), first - 1, memberId(MAKER)]);
    expect(await refusal(draft(medium.id, [line({ project: a, appropriation: lockedSource, year: first - 1 }, money(1))]))).toMatchObject({ code: 'FISCAL_YEAR_LOCKED' });
    await draft(medium.id, [line({ project: a, appropriation: openSource, year: first }, money(1))]);
    expect(await appropriationRow(lockedSource)).toMatchObject({ allocated: '0' });
  });

  it.each([
    ['CONCEPT', false],
    ['APPRAISAL', false],
    ['PIPELINE', true],
    ['BUDGETED', true],
    ['IMPLEMENTATION', true],
    ['SUSPENDED', true],
    ['COMPLETED', false],
    ['SETTLED', false],
    ['CLOSED', false],
    ['REJECTED', false],
    ['CANCELLED', false],
  ] as Array<[ProjectStatus, boolean]>)('takes a line for a project in stage %s: %s (422 PROJECT_STAGE_INVALID otherwise)', async (status, allowed) => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const subject = await project(status);
    const attempt = draft(target.id, [line({ project: subject, appropriation: source, year: target.year }, money(1))]);
    if (allowed) expect((await attempt).changes).toHaveLength(1);
    else expect(await refusal(attempt)).toMatchObject({ code: 'PROJECT_STAGE_INVALID', status: 422, detail: 'project_id' });
  });

  it('still removes a line of a project that has left the stages that take capital', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const subject = await project();
    const added = await draft(target.id, [line({ project: subject, appropriation: source, year: target.year }, money(1))]);
    await owner("update machvon.project set status = 'CLOSED' where id = $1::uuid", [subject]);
    await draft(target.id, [], { remove: [added.changes[0]?.lineId as string] });
    expect(await appropriationRow(source)).toMatchObject({ allocated: '0' });
  });

  it('judges the appropriation: it must exist, be published, fall in the years of the plan, keep its source year, and carry-over goes with the carry-over bucket', async () => {
    const target = await plan();
    const a = await project();
    const published = await appropriation({ planYear: target.year });
    const waiting = await appropriation({ planYear: target.year, fundSourceVersionId: versions.nsdp as string, publish: false });
    const otherYear = await appropriation({ planYear: target.year - 1 });
    const carried = await appropriation({ planYear: target.year, origin: 'CARRYOVER', fundSourceVersionId: versions.nsdp as string, decisionDocumentId: await document() });
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: randomUUID(), year: target.year }, money(1))]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'appropriation_id' });
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: waiting, year: target.year }, money(1))]))).toMatchObject({ code: 'APPROPRIATION_NOT_PUBLISHED', status: 422 });
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: otherYear, year: target.year - 1 }, money(1))]))).toMatchObject({ detail: 'appropriation_id' });
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: published, year: target.year - 1 }, money(1))]))).toMatchObject({ detail: 'source_year' });
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: published, year: target.year }, money(1), { bucket: 'CARRYOVER' })]))).toMatchObject({ detail: 'bucket' });
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: carried, year: target.year - 1 }, money(1))]))).toMatchObject({ detail: 'bucket' });
    const carry = await draft(target.id, [line({ project: a, appropriation: carried, year: target.year - 1 }, money(1), { bucket: 'CARRYOVER' })]);
    expect(carry.changes).toHaveLength(1);
    const stored = (await owner<{ is_extended: boolean; extended_to: string; extension_document_id: string; origin: string }>(
      'select is_extended, extended_to::text as extended_to, extension_document_id, origin from machvon.allocation_line where id = $1::uuid',
      [carry.changes[0]?.lineId],
    ))[0];
    expect(stored).toMatchObject({ is_extended: true, extended_to: `${target.year}-12-31`, origin: 'CARRYOVER' });
    expect(stored?.extension_document_id).toEqual(expect.any(String));
    expect(await drift()).not.toContainEqual(expect.objectContaining({ appropriationId: carried }));
  });

  it('takes the other bucket for the capital that is not carried over, and records the program of the line', async () => {
    const target = await plan();
    const a = await project();
    const support = await appropriation({ planYear: target.year, origin: 'CENTRAL_SUPPORT', fundSourceVersionId: versions.nsdp as string });
    const result = await draft(target.id, [line({ project: a, appropriation: support, year: target.year }, money(1), { bucket: 'OTHER' })]);
    expect(await linesOf(target.id)).toMatchObject([{ bucket: 'OTHER', origin: 'CENTRAL_SUPPORT' }]);
    expect(result.changes[0]?.bucket).toBe('OTHER');
  });

  it('judges the program of a line: a program in force, and the same program as the appropriation when it has one', async () => {
    const target = await plan();
    const a = await project();
    const open = await appropriation({ planYear: target.year });
    const tied = await appropriation({ planYear: target.year, fundSourceVersionId: versions.nsdp as string, programMasterVersionId: versions.ctmtqg as string });
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: open, year: target.year }, money(1), { programMasterVersionId: versions.nstw as string })]))).toMatchObject({ detail: 'program_master_version_id' });
    expect(await refusal(draft(target.id, [line({ project: a, appropriation: tied, year: target.year }, money(1), { programMasterVersionId: versions.otherProgram as string })]))).toMatchObject({ detail: 'program_master_version_id' });
    const kept = await draft(target.id, [line({ project: a, appropriation: tied, year: target.year }, money(1))]);
    expect(kept.changes).toHaveLength(1);
    expect((await owner<{ program_master_version_id: string }>('select program_master_version_id from machvon.allocation_line where id = $1::uuid', [kept.changes[0]?.lineId]))[0]?.program_master_version_id).toBe(versions.ctmtqg);
    await draft(target.id, [line({ project: a, appropriation: open, year: target.year }, money(1), { programMasterVersionId: versions.ctmtqg as string })]);
  });

  it('names the line it replaces only when it belongs to the same project', async () => {
    const target = await plan();
    const a = await project();
    const b = await project();
    const source = await appropriation({ planYear: target.year });
    const earlier = (await draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(1))])).changes[0]?.lineId as string;
    expect(await refusal(draft(target.id, [line({ project: b, appropriation: source, year: target.year }, money(1), { previousLineId: earlier })]))).toMatchObject({ detail: 'previous_line_id' });
    expect(await refusal(draft(target.id, [line({ project: b, appropriation: source, year: target.year }, money(1), { previousLineId: randomUUID() })]))).toMatchObject({ detail: 'previous_line_id' });
    const next = await draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(2), { previousLineId: earlier })]);
    expect(next.changes[0]).toMatchObject({ kind: 'CHANGED' });
  });

  it('draws a medium-term plan on the appropriations of the years of its period and no other', async () => {
    const first = freshYear() - 5;
    const medium = await plan({ kind: 'MEDIUM_TERM', from: first, to: first + 4, year: first });
    const a = await project();
    const inside = await appropriation({ planYear: first + 2 });
    const outside = await appropriation({ planYear: first + 6 });
    expect(await refusal(draft(medium.id, [line({ project: a, appropriation: outside, year: first + 6 }, money(1))]))).toMatchObject({ detail: 'appropriation_id' });
    await draft(medium.id, [line({ project: a, appropriation: inside, year: first + 2 }, money(1))]);
    expect((await owner<{ fiscal_year: number; revision: number; status: string }>('select fiscal_year, revision, status from machvon.plan_version where capital_plan_id = $1::uuid', [medium.id]))[0]).toEqual({ fiscal_year: first, revision: 1, status: 'DRAFT' });
  });

  it('writes lines only for projects in the scope of the writer: a project outside it does not exist (404), and nothing is written (AC-ST-CAP-002-5)', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const inside = await project('PIPELINE', BQL1);
    const outside = await project('PIPELINE', BQL2);
    const narrow: DraftScopes = { write: projectScope(subtree('capital.plan.draft', BQL1), 'capital.plan.draft', new Date()), read: allDrafts };
    await draft(target.id, [line({ project: inside, appropriation: source, year: target.year }, money(1))], { scope: narrow });
    expect(await refusal(draft(target.id, [line({ project: outside, appropriation: source, year: target.year }, money(1))], { scope: narrow }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    const foreign = (await draft(target.id, [line({ project: outside, appropriation: source, year: target.year }, money(2))])).changes[0]?.lineId as string;
    // Neither the line of a project outside the scope can be removed, nor a project of another tenant named.
    expect(await refusal(draft(target.id, [line({ project: inside, appropriation: source, year: target.year }, money(1))], { scope: narrow, remove: [foreign] }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    const foreignTenant = await project('PIPELINE', BQL1, TENANT_B);
    expect(await refusal(draft(target.id, [line({ project: foreignTenant, appropriation: source, year: target.year }, money(1))]))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await appropriationRow(source)).toMatchObject({ allocated: money(3) });
    expect(await drift([source])).toEqual([]);
  });

  it('reads only the lines of the projects in the scope of the reader (AC-ST-CAP-002-5)', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const inside = await project('PIPELINE', BQL1);
    const outside = await project('PIPELINE', BQL2);
    await draft(target.id, [line({ project: inside, appropriation: source, year: target.year }, money(1)), line({ project: outside, appropriation: source, year: target.year }, money(2))]);
    const narrowRead: PlanReadScope = { ...planReadScope(subtree('capital.read', BQL1), 'capital.read', new Date()), drafts: true };
    const visible = await as((tx) => reads.listLines(tx, { capitalPlanId: target.id }, narrowRead, { limit: 50, after: undefined }));
    expect(visible.map((row) => row.project.id)).toEqual([inside]);
    expect(await as((tx) => reads.lineTotals(tx, { capitalPlanId: target.id }, narrowRead))).toMatchObject({ lineCount: 1, allocatedVnd: money(1) });
    expect((await as((tx) => reads.planProjects(tx, target.id, narrowRead))).map((row) => row.projectId)).toEqual([inside]);
    expect((await as((tx) => reads.findPlan(tx, target.id, narrowRead)))?.totals.allocatedVnd).toBe(money(1));
    const everyone = await as((tx) => reads.listLines(tx, { capitalPlanId: target.id }, allDrafts, { limit: 50, after: undefined }));
    expect(everyone.map((row) => row.project.id).sort()).toEqual([inside, outside].sort());
    const hidden = await as((tx) => reads.findLine(tx, everyone.find((row) => row.project.id === outside)?.id as string, narrowRead));
    expect(hidden).toBeUndefined();
  });

  it('answers 409 VERSION_CONFLICT with a safe diff to the planner who saved with an old version, and lets only one of two parallel savers win (AC-ST-CAP-002-6)', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const [a, b] = [await project(), await project()] as [string, string];
    for (let step = 0; step < 6; step += 1) await draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(step + 1))]);
    expect(await versionOf(target.id)).toBe(7);
    const stale = await refusal(draft(target.id, [line({ project: b, appropriation: source, year: target.year }, money(1))], { version: 6 }));
    expect(stale).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 7, safe_diff: { status: 'DRAFT', line_count: 1, allocated_vnd: money(6) } } });
    expect(JSON.stringify(stale.extensions)).not.toContain(a);
    const rounds = await runLoops({
      loops: 20,
      reset: async () => {
        await owner('delete from machvon.allocation_line where project_id = $1::uuid', [b]);
        await owner('delete from machvon.plan_version where project_id = $1::uuid and capital_plan_id = $2::uuid', [b, target.id]);
        await owner('update machvon.allocation_line set amount_vnd = $2::numeric where project_id = $1::uuid', [a, money(6)]);
        await owner('update machvon.capital_plan set version = 7 where id = $1::uuid', [target.id]);
        await setAllocated([source], money(6));
      },
      commands: () => [SECOND_MAKER, MAKER].map((member, index) => () => draft(target.id, [line({ project: index === 0 ? b : a, appropriation: source, year: target.year }, money(index === 0 ? 1 : 7))], { version: 7, member }).then(() => undefined)),
      verify: async ({ outcomes }) => {
        assertOneWinner(outcomes, ['409 VERSION_CONFLICT']);
        expect(await versionOf(target.id)).toBe(8);
      },
    });
    expect(tallyOutcomes(rounds.flatMap((round) => round.outcomes))).toEqual({ '200': 20, '409 VERSION_CONFLICT': 20 });
  }, 120_000);
});

describe('the ceiling under concurrency (AC-ST-CAP-002-1)', () => {
  it('lets exactly one of two planners who draft 800 million at the same moment win when 9 of 10 billion are taken, 30 times, and the ceiling never breaks', async () => {
    const year = freshYear();
    const source = await appropriation({ planYear: year, amountVnd: money(10) });
    const baseProject = await project();
    const racers = [await plan({ year }), await plan({ year })];
    const racerProjects = [await project(), await project()];
    const base = await plan({ year });
    await draft(base.id, [line({ project: baseProject, appropriation: source, year }, money(9))]);
    const rounds = await runLoops({
      loops: 30,
      reset: async () => {
        await emptyPlans(racers.map((racer) => racer.id));
        await setAllocated([source], money(9));
      },
      commands: () => racers.map((racer, index) => () => draft(racer.id, [line({ project: racerProjects[index] as string, appropriation: source, year }, million(800))], { version: 1, member: index === 0 ? MAKER : SECOND_MAKER }).then(() => undefined)),
      verify: async ({ outcomes }) => {
        assertOneWinner(outcomes, ['422 APPROPRIATION_EXCEEDED']);
        expect(await appropriationRow(source)).toMatchObject({ amount: money(10), allocated: '9800000000' });
        expect(await drift([source])).toEqual([]);
        const winners = await owner<{ n: string }>(
          'select count(*)::text as n from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = any($1::uuid[])',
          [racers.map((racer) => racer.id)],
        );
        expect(winners).toEqual([{ n: '1' }]);
      },
    });
    expect(tallyOutcomes(rounds.flatMap((round) => round.outcomes))).toEqual({ '200': 30, '422 APPROPRIATION_EXCEEDED': 30 });
  }, 180_000);

  it('lets as many parallel planners win as the ceiling holds when five of them each ask for 300 million of the 1 billion that is left', async () => {
    const year = freshYear();
    const source = await appropriation({ planYear: year, amountVnd: money(1) });
    const racers = await Promise.all(Array.from({ length: 5 }, () => plan({ year })));
    const racerProjects = await Promise.all(racers.map(() => project()));
    const rounds = await runLoops({
      loops: 10,
      reset: async () => {
        await emptyPlans(racers.map((racer) => racer.id));
        await setAllocated([source], '0');
      },
      commands: () => racers.map((racer, index) => () => draft(racer.id, [line({ project: racerProjects[index] as string, appropriation: source, year }, million(300))], { version: 1 }).then(() => undefined)),
      verify: async ({ outcomes }) => {
        const tally = tallyOutcomes(outcomes);
        expect(tally).toEqual({ '200': 3, '422 APPROPRIATION_EXCEEDED': 2 });
        expect(await appropriationRow(source)).toMatchObject({ allocated: million(900) });
        expect(await drift([source])).toEqual([]);
      },
    });
    expect(rounds).toHaveLength(10);
  }, 180_000);

  it('does not deadlock two plans that draw on the same two appropriations in opposite order: both win, 30 times', async () => {
    const year = freshYear();
    const first = await appropriation({ planYear: year });
    const second = await appropriation({ planYear: year, fundSourceVersionId: versions.nsdp as string, budgetLevel: 'LOCAL' });
    const racers = [await plan({ year }), await plan({ year })];
    const racerProjects = [await project(), await project()];
    const rounds = await runLoops({
      loops: 30,
      reset: async () => {
        await emptyPlans(racers.map((racer) => racer.id));
        await setAllocated([first, second], '0');
      },
      commands: () =>
        racers.map((racer, index) => () => {
          const order = index === 0 ? [first, second] : [second, first];
          return draft(racer.id, order.map((source) => line({ project: racerProjects[index] as string, appropriation: source, year }, money(1))), { version: 1 }).then(() => undefined);
        }),
      verify: async ({ outcomes }: { outcomes: CommandOutcome[] }) => {
        expect(tallyOutcomes(outcomes)).toEqual({ '200': 2 });
        expect(await appropriationRow(first)).toMatchObject({ allocated: money(2) });
        expect(await appropriationRow(second)).toMatchObject({ allocated: money(2) });
        expect(await drift([first, second])).toEqual([]);
      },
    });
    expect(rounds).toHaveLength(30);
  }, 180_000);
});

describe('what the database holds to (TK-CAP-002-7)', () => {
  it('lets the allocated total change only through the allocation command: a direct write is refused by the database', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const a = await project();
    await draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(1))]);
    expect(await sqlState(as((tx) => tx.query('update machvon.appropriation set allocated_total_vnd = 0 where id = $1::uuid', [source])))).toBe('23514');
    expect(await sqlState(as((tx) => tx.query('update machvon.appropriation set allocated_total_vnd = allocated_total_vnd + 1 where id = $1::uuid', [source])))).toBe('23514');
    expect(await appropriationRow(source)).toMatchObject({ allocated: money(1) });
  });

  it('refuses to edit or remove a line once the plan is no longer a draft, and keeps the plan, the version and the line for good', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const a = await project();
    const added = await draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(1))]);
    const lineId = added.changes[0]?.lineId as string;
    await owner("update machvon.capital_plan set status = 'IN_REVIEW', submitted_by = $2::uuid where id = $1::uuid", [target.id, memberId(MAKER)]);
    await owner("update machvon.plan_version set status = 'IN_REVIEW' where capital_plan_id = $1::uuid", [target.id]);
    expect(await sqlState(owner('update machvon.allocation_line set amount_vnd = 5 where id = $1::uuid', [lineId]))).toBe('23514');
    expect(await sqlState(owner('delete from machvon.allocation_line where id = $1::uuid', [lineId]))).toBe('23514');
    expect(await sqlState(owner('delete from machvon.plan_version where capital_plan_id = $1::uuid', [target.id]))).toBe('23514');
    // The one change a line may take outside a draft is the move to the revision of its appropriation.
    const revision = await appropriation({ planYear: target.year + 1 });
    await owner('update machvon.allocation_line set appropriation_id = $2::uuid, version = version + 1 where id = $1::uuid', [lineId, revision]);
    expect(await sqlState(owner('update machvon.allocation_line set appropriation_id = $2::uuid, amount_vnd = 7 where id = $1::uuid', [lineId, source]))).toBe('23514');
  });

  it('keeps the identity of a plan and its state machine', async () => {
    const target = await plan();
    for (const change of ["plan_code = 'OTHER'", "plan_kind = 'MEDIUM_TERM'", 'period_from_year = 2000', `scope_unit_id = '${unitId(BQL1)}'`, 'revision = 2', "status = 'PUBLISHED'", "status = 'APPROVED'"]) {
      expect(await sqlState(owner(`update machvon.capital_plan set ${change} where id = $1::uuid`, [target.id]))).toBe('23514');
    }
    await owner("update machvon.capital_plan set status = 'IN_REVIEW', submitted_by = $2::uuid where id = $1::uuid", [target.id, memberId(MAKER)]);
    await owner("update machvon.capital_plan set status = 'REJECTED' where id = $1::uuid", [target.id]);
    expect(await sqlState(owner("update machvon.capital_plan set status = 'DRAFT' where id = $1::uuid", [target.id]))).toBe('23514');
  });

  it('keeps plans, versions and lines for good: the runtime role cannot delete a plan or truncate them, and a draft plan cannot be deleted', async () => {
    const target = await plan();
    expect(await sqlState(as((tx) => tx.query('delete from machvon.capital_plan where id = $1::uuid', [target.id])))).toBe('42501');
    for (const table of ['capital_plan', 'plan_version', 'allocation_line']) expect(await sqlState(as((tx) => tx.query(`truncate machvon.${table}`)))).toBe('42501');
  });

  it('holds a line that draws on an appropriation to be complete, and to a known origin and year', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const a = await project();
    const added = await draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(1))]);
    const lineId = added.changes[0]?.lineId as string;
    expect(await sqlState(owner('update machvon.allocation_line set origin = $2 where id = $1::uuid', [lineId, 'MADE_UP']))).toBe('23514');
    expect(await sqlState(owner('update machvon.allocation_line set budget_level = null where id = $1::uuid', [lineId]))).toBe('23514');
    expect(await sqlState(owner('update machvon.allocation_line set source_year = 1800 where id = $1::uuid', [lineId]))).toBe('23514');
    expect(await sqlState(owner('update machvon.allocation_line set ctmtqg_subset_vnd = amount_vnd + 1 where id = $1::uuid', [lineId]))).toBe('23514');
  });
});

describe('the reads of the plans', () => {
  it('shows the revisions in work only to the people who draft and approve, newest first, with a cursor', async () => {
    const year = freshYear();
    const drafts = [await plan({ year }), await plan({ year }), await plan({ year })];
    const published = await plan({ year });
    const documentId = await document();
    await owner("update machvon.capital_plan set status = 'IN_REVIEW', submitted_by = $2::uuid where id = $1::uuid", [published.id, memberId(MAKER)]);
    await owner("update machvon.capital_plan set status = 'APPROVED', approved_by = $2::uuid where id = $1::uuid", [published.id, memberId(APPROVER)]);
    await owner("update machvon.capital_plan set status = 'PUBLISHED', decision_document_id = $2::uuid, effective_at = now(), published_at = now() where id = $1::uuid", [published.id, documentId]);
    const reader: PlanReadScope = { lines: everything, drafts: false };
    const asReader = await as((tx) => reads.listPlans(tx, reader, { planYear: year }, { limit: 50, after: undefined }));
    expect(asReader.map((row) => row.id)).toEqual([published.id]);
    expect(asReader[0]).toMatchObject({ status: 'PUBLISHED', decisionDocumentId: documentId, decisionSymbol: expect.any(String) });
    const asPlanner = await as((tx) => reads.listPlans(tx, allDrafts, { planYear: year }, { limit: 50, after: undefined }));
    expect(asPlanner.map((row) => row.id)).toEqual([published.id, ...drafts.map((row) => row.id).reverse()]);
    const firstPage = await as((tx) => reads.listPlans(tx, allDrafts, { planYear: year }, { limit: 2, after: undefined }));
    const last = firstPage[1] as (typeof firstPage)[number];
    const secondPage = await as((tx) => reads.listPlans(tx, allDrafts, { planYear: year }, { limit: 2, after: { code: last.createdAtKey, id: last.id } }));
    expect([...firstPage, ...secondPage].map((row) => row.id)).toEqual(asPlanner.map((row) => row.id));
    expect(await as((tx) => reads.findPlan(tx, drafts[0]?.id as string, reader))).toBeUndefined();
    expect(await as((tx) => reads.findPlan(tx, published.id, reader))).toMatchObject({ id: published.id });
    expect(await as((tx) => reads.listPlans(tx, allDrafts, { planKind: 'MEDIUM_TERM', planYear: year }, { limit: 5, after: undefined }))).toEqual([]);
    expect((await as((tx) => reads.listPlans(tx, allDrafts, { status: 'PUBLISHED', planYear: year }, { limit: 5, after: undefined }))).map((row) => row.id)).toEqual([published.id]);
    expect(await as((tx) => reads.listPlans(tx, allDrafts, { planYear: year }, { limit: 50, after: undefined }), TENANT_B)).toEqual([]);
  });

  it('computes the draft-visibility of a caller from the permissions they hold on any scope', () => {
    const now = new Date();
    expect(planReadScope(grant('capital.plan.draft', { kind: 'TENANT' }), 'capital.read', now).drafts).toBe(true);
    expect(planReadScope(grant('capital.plan.approve', { kind: 'UNIT_ONLY', refIds: [unitId(BQL1)] }), 'capital.read', now).drafts).toBe(true);
    expect(planReadScope(grant('plan.publish', { kind: 'TENANT' }), 'capital.read', now).drafts).toBe(true);
    expect(planReadScope(grant('capital.read', { kind: 'TENANT' }), 'capital.read', now).drafts).toBe(false);
  });

  it('reads a line with its appropriation, program, extension document and the balance it has once published, and filters by project and source', async () => {
    const target = await plan();
    const a = await project();
    const b = await project();
    const source = await appropriation({ planYear: target.year });
    const other = await appropriation({ planYear: target.year, origin: 'CARRYOVER', fundSourceVersionId: versions.nsdp as string });
    const added = await draft(target.id, [
      line({ project: a, appropriation: source, year: target.year }, money(2), { programMasterVersionId: versions.ctmtqg as string }),
      line({ project: b, appropriation: other, year: target.year - 1 }, money(1), { bucket: 'CARRYOVER' }),
    ]);
    const [first, second] = added.changes.map((change) => change.lineId) as [string, string];
    await owner('insert into machvon.allocation_balance (tenant_id, id, allocation_line_id, allocated_vnd, reserved_vnd, committed_vnd) values ($1, $2, $3, $4::numeric, 5, 7)', [TENANT_A, randomUUID(), first, money(2)]);
    const all = await as((tx) => reads.listLines(tx, { capitalPlanId: target.id }, allDrafts, { limit: 50, after: undefined }));
    expect(all).toHaveLength(2);
    const one = all.find((row) => row.id === first);
    expect(one).toMatchObject({
      planCode: expect.any(String),
      planStatus: 'DRAFT',
      project: { id: a },
      appropriation: { id: source, planYear: target.year, amountVnd: money(10), allocatedTotalVnd: money(2), remainingVnd: money(8) },
      program: { versionId: versions.ctmtqg },
      amountVnd: money(2),
      ctmtqgSubsetVnd: '0',
      bucket: 'CURRENT_YEAR',
      isExtended: false,
      extensionDocument: null,
      committedVnd: '7',
      reservedVnd: '5',
      fundSource: { versionId: versions.nstw, category: 'NSTW' },
    });
    const carried = all.find((row) => row.id === second);
    expect(carried).toMatchObject({ bucket: 'CARRYOVER', isExtended: true, extendedTo: `${target.year}-12-31`, extensionDocument: { id: expect.any(String), symbol: expect.any(String) }, committedVnd: null });
    const byProject = await as((tx) => reads.listLines(tx, { capitalPlanId: target.id, projectId: b }, allDrafts, { limit: 50, after: undefined }));
    expect(byProject.map((row) => row.id)).toEqual([second]);
    const bySource = await as((tx) => reads.listLines(tx, { capitalPlanId: target.id, fundSourceVersionId: versions.nstw as string }, allDrafts, { limit: 50, after: undefined }));
    expect(bySource.map((row) => row.id)).toEqual([first]);
    const firstPage = await as((tx) => reads.listLines(tx, { capitalPlanId: target.id }, allDrafts, { limit: 1, after: undefined }));
    const page2 = await as((tx) => reads.listLines(tx, { capitalPlanId: target.id }, allDrafts, { limit: 1, after: { code: firstPage[0]?.createdAtKey as string, id: firstPage[0]?.id as string } }));
    expect([...firstPage, ...page2].map((row) => row.id)).toEqual(all.map((row) => row.id));
    expect(await as((tx) => reads.findLine(tx, first, allDrafts))).toMatchObject({ id: first });
    expect(await as((tx) => reads.findLine(tx, first, { lines: everything, drafts: false }))).toBeUndefined();
    expect(await as((tx) => reads.findLine(tx, first, allDrafts), TENANT_B)).toBeUndefined();
    expect(await as((tx) => reads.planProjects(tx, target.id, allDrafts))).toMatchObject([{ lineCount: 1 }, { lineCount: 1 }]);
  });
});

describe('the facts of the publication and the reconciliation of the allocated totals', () => {
  it('gives the facts of a published plan: its revision, year, effective moment, decision and the projects that have money in it', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const [a, b] = [await project(), await project()] as [string, string];
    await draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(1)), line({ project: b, appropriation: source, year: target.year }, money(2))]);
    expect(await as((tx) => plans.publicationFacts(tx, target.id))).toBeUndefined();
    const documentId = await document();
    await owner("update machvon.capital_plan set status = 'IN_REVIEW', submitted_by = $2::uuid where id = $1::uuid", [target.id, memberId(MAKER)]);
    await owner("update machvon.capital_plan set status = 'APPROVED', approved_by = $2::uuid where id = $1::uuid", [target.id, memberId(APPROVER)]);
    await owner("update machvon.capital_plan set status = 'PUBLISHED', decision_document_id = $2::uuid, effective_at = '2026-01-15T00:00:00Z', published_at = now() where id = $1::uuid", [target.id, documentId]);
    const facts = await as((tx) => plans.publicationFacts(tx, target.id));
    expect(facts).toEqual({ capitalPlanId: target.id, revision: 1, planYear: target.year, effectiveAt: '2026-01-15T00:00:00.000Z', decisionDocumentId: documentId, projectIds: [a, b].sort() });
    expect(await as((tx) => plans.publicationFacts(tx, randomUUID()))).toBeUndefined();
  });

  it('reports an appropriation whose allocated total is not the sum of its lines, and nothing for the ones that agree', async () => {
    const target = await plan();
    const source = await appropriation({ planYear: target.year });
    const a = await project();
    await draft(target.id, [line({ project: a, appropriation: source, year: target.year }, money(1))]);
    expect(await drift([source])).toEqual([]);
    await setAllocated([source], money(2));
    expect(await drift([source])).toEqual([{ appropriationId: source, allocatedTotalVnd: money(2), linesTotalVnd: money(1) }]);
    expect((await drift()).map((row) => row.appropriationId)).toContain(source);
  });
});

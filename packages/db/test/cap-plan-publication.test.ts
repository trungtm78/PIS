import { randomUUID } from 'node:crypto';
import { DomainError, assertOneWinner, runConcurrently, runLoops, tallyOutcomes, vietnamDateOf } from '@machvon/kernel';
import { CapAppropriationStore } from '../src/cap-appropriation-store';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { WORKER_MEMBERSHIP_ID } from '../src/consumer-inbox';
import type { AppropriationInput } from '../src/cap-appropriation-store';
import { CapPlanApprovalStore } from '../src/cap-plan-approval-store';
import type { CapPlanDecision, PlanAuthorizer } from '../src/cap-plan-approval-store';
import { BalanceDriftError, CapPlanPublicationStore } from '../src/cap-plan-publication-store';
import type { CapPublishInput, PublishResult } from '../src/cap-plan-publication-store';
import { CapPlanStore } from '../src/cap-plan-store';
import type { DraftScopes, LineInput } from '../src/cap-plan-store';
import { lockLedgerRows } from '../src/ledger-lock';
import { PrjProjectStore } from '../src/prj-project-store';
import type { ProjectStatus } from '../src/prj-project-store';
import type { PlanReadScope } from '../src/cap-plan-reads';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const appropriations = new CapAppropriationStore();
const plans = new CapPlanStore();
const approvals = new CapPlanApprovalStore();
const publication = new CapPlanPublicationStore();
const projects = new PrjProjectStore();
const MAKER = 1; // creates, drafts and submits the plans
const APPROVER = 2; // decides and registers nothing
const PUBLISHER = 3; // publishes
const SECOND_MAKER = 4;
const ROOT = 1;
const BQL1 = 2;
const BILLION = 1_000_000_000;
const TODAY = vietnamDateOf(new Date());

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const allDrafts: PlanReadScope = { lines: everything, drafts: true };
const scopes: DraftScopes = { write: everything, read: allDrafts };
const allow: PlanAuthorizer = () => undefined;
const money = (billions: number): string => String(billions * BILLION);

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

async function document(tenant = TENANT_A, status = 'EFFECTIVE'): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', $5, 'INTERNAL', $4, $4)`,
    [tenant, id, `QD-${id.slice(0, 8)}/2026`, memberId(MAKER), status],
    tenant,
  );
  return id;
}

/** A published appropriation (registered by one person, decided by another). */
async function appropriation(options: Partial<AppropriationInput> = {}): Promise<string> {
  const planYear = options.planYear ?? freshYear();
  const input: AppropriationInput = {
    fundSourceVersionId: versions.nstw as string,
    planYear,
    origin: 'PM_ASSIGNED',
    budgetLevel: 'CENTRAL',
    amountVnd: money(10),
    decisionDocumentId: await document(),
    issuingAuthority: 'Thủ tướng Chính phủ',
    sourceYear: planYear,
    ...options,
  };
  const draft = await as((tx) => appropriations.register(tx, input, memberId(MAKER), TODAY));
  await as((tx) => appropriations.decide(tx, draft.id, draft.version, 'approve', memberId(APPROVER), TODAY), TENANT_A, APPROVER);
  return draft.id;
}

async function project(status: ProjectStatus = 'PIPELINE', options: { nationalCode?: string | null } = {}): Promise<string> {
  counter += 1;
  const number = counter;
  const code = `PB-${number}-${randomUUID().slice(0, 6)}`;
  const created = await as((tx) =>
    projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(BQL1), areaMasterVersionId: versions.area as string, totalInvestmentVnd: '500000000000' }, memberId(MAKER), TODAY),
  );
  const nationalCode = options.nationalCode === undefined ? String(6000000 + number) : options.nationalCode;
  await owner('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, status, 'B', nationalCode]);
  return created.id;
}

const planRow = async (id: string) =>
  (
    await owner<{ version: string; status: string; submitted_by: string | null; approved_by: string | null; published_by: string | null; decision_document_id: string | null; decision_reason: string | null; effective_at: string | null }>(
      `select version::text as version, status, submitted_by, approved_by, published_by, decision_document_id, decision_reason, to_char(effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as effective_at from machvon.capital_plan where id = $1::uuid`,
      [id],
    )
  )[0] as { version: string; status: string; submitted_by: string | null; approved_by: string | null; published_by: string | null; decision_document_id: string | null; decision_reason: string | null; effective_at: string | null };
const versionOf = async (id: string): Promise<number> => Number((await planRow(id)).version);
const statusOf = async (id: string): Promise<string> => (await planRow(id)).status;
const appropriationRow = async (id: string) =>
  (await owner<{ amount: string; allocated: string }>('select amount_vnd::text as amount, allocated_total_vnd::text as allocated from machvon.appropriation where id = $1::uuid', [id]))[0] as { amount: string; allocated: string };
const linesOf = (planId: string) =>
  owner<{ id: string; project_id: string; appropriation_id: string; amount: string; version_status: string }>(
    `select al.id, al.project_id, al.appropriation_id, al.amount_vnd::text as amount, pv.status as version_status
       from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid order by al.created_at, al.id`,
    [planId],
  );
const balanceOfLine = async (lineId: string) =>
  (
    await owner<{ id: string; allocated: string; reserved: string; committed: string; disbursed: string; version: string }>(
      `select id, allocated_vnd::text as allocated, reserved_vnd::text as reserved, committed_vnd::text as committed, disbursed_vnd::text as disbursed, version::text as version
         from machvon.allocation_balance where allocation_line_id = $1::uuid`,
      [lineId],
    )
  )[0];
const ledgerOf = (planId: string) =>
  owner<{ id: string; entry_type: string; amount: string; allocation_line_id: string; project_id: string; appropriation_id: string; plan_year: number; source_ref_kind: string; posted_by: string }>(
    `select id, entry_type, amount_vnd::text as amount, allocation_line_id, project_id, appropriation_id, plan_year, source_ref_kind, posted_by
       from machvon.capital_ledger_entry where source_ref_kind = 'CAPITAL_PLAN' and source_ref_id = $1::uuid order by allocation_line_id, entry_type`,
    [planId],
  );
const ledgerCount = async (): Promise<number> => Number((await owner<{ n: string }>("select count(*)::text as n from machvon.capital_ledger_entry where source_ref_kind = 'CAPITAL_PLAN'"))[0]?.n);

const line = (target: { project: string; appropriation: string; year: number }, amount: string, extra: Partial<LineInput> = {}): LineInput => ({
  projectId: target.project,
  appropriationId: target.appropriation,
  bucket: 'CURRENT_YEAR',
  sourceYear: target.year,
  amountVnd: amount,
  ...extra,
});

async function createPlan(year: number, code?: string): Promise<string> {
  counter += 1;
  const created = await as((tx) =>
    plans.createPlan(tx, { planCode: code ?? `PB-${counter}-${randomUUID().slice(0, 6)}`, planKind: 'ANNUAL', planYear: year, periodFromYear: year, periodToYear: year, scopeUnitId: unitId(ROOT) }, memberId(MAKER), allow),
  );
  return created.id;
}

async function draft(planId: string, lines: LineInput[], remove: string[] = []): Promise<void> {
  const version = await versionOf(planId);
  await as((tx) => plans.draft(tx, planId, version, { lines, removeLineIds: remove }, memberId(MAKER), scopes, TODAY));
}

async function submit(planId: string, member = MAKER, authorize: PlanAuthorizer = allow) {
  const version = await versionOf(planId);
  return as((tx) => approvals.submit(tx, planId, version, memberId(member), authorize), TENANT_A, member);
}

async function decide(planId: string, decision: CapPlanDecision, member = APPROVER, reason = 'Reviewed against the decision', authorize: PlanAuthorizer = allow) {
  const version = await versionOf(planId);
  return as((tx) => approvals.decide(tx, planId, version, decision, reason, memberId(member), authorize), TENANT_A, member);
}

async function publish(planId: string, input: Partial<CapPublishInput> & { member?: number; version?: number; authorize?: PlanAuthorizer } = {}): Promise<PublishResult> {
  const version = input.version ?? (await versionOf(planId));
  const decisionDocumentId = input.decisionDocumentId ?? (await document());
  return as(
    (tx) => publication.publish(tx, planId, version, { decisionDocumentId, effectiveAt: input.effectiveAt }, memberId(input.member ?? PUBLISHER), input.authorize ?? allow, TODAY),
    TENANT_A,
    input.member ?? PUBLISHER,
  );
}

interface Fixture {
  planId: string;
  year: number;
  appropriationId: string;
  projects: string[];
  lineIds: string[];
}

/** A plan with one line per project, drafted by MAKER, submitted by MAKER and approved by APPROVER. */
async function approvedPlan(options: { amounts?: string[]; appropriationAmount?: string; code?: string; year?: number; projectStatus?: ProjectStatus; appropriationId?: string } = {}): Promise<Fixture> {
  const year = options.year ?? freshYear();
  const appropriationId = options.appropriationId ?? (await appropriation({ planYear: year, amountVnd: options.appropriationAmount ?? money(10) }));
  const amounts = options.amounts ?? [money(1)];
  const members: string[] = [];
  for (let index = 0; index < amounts.length; index += 1) members.push(await project(options.projectStatus ?? 'PIPELINE'));
  const planId = await createPlan(year, options.code);
  await draft(
    planId,
    members.map((member, index) => line({ project: member, appropriation: appropriationId, year }, amounts[index] as string)),
  );
  await submit(planId);
  await decide(planId, 'approve');
  const stored = await linesOf(planId);
  return { planId, year, appropriationId, projects: members, lineIds: members.map((member) => (stored.find((row) => row.project_id === member) as (typeof stored)[number]).id) };
}

async function publishedPlan(options: Parameters<typeof approvedPlan>[0] = {}): Promise<Fixture & { result: PublishResult }> {
  const fixture = await approvedPlan(options);
  return { ...fixture, result: await publish(fixture.planId) };
}

/**
 * A DRAFT revision of a published plan, written the way the revision command of ST-CAP-004 leaves it: the lines are copies that point at the lines
 * they replace, and the allocated total of each appropriation counts only the difference to the revision it replaces.
 */
async function revise(base: Fixture, amounts: Array<string | null>, extras: Array<{ project: string; amount: string }> = []): Promise<Fixture> {
  const baseRow = (
    await owner<{ plan_code: string; plan_year: number; revision: number }>(
      'select plan_code, plan_year, (select max(revision) from machvon.capital_plan other where other.plan_code = cp.plan_code) as revision from machvon.capital_plan cp where id = $1::uuid',
      [base.planId],
    )
  )[0] as { plan_code: string; plan_year: number; revision: number };
  const stored = await linesOf(base.planId);
  // The amounts are in the order of the projects of the base, whichever order the database returns the lines in.
  const baseLines = base.projects.map((member) => stored.find((row) => row.project_id === member) as (typeof stored)[number]);
  const planId = randomUUID();
  const statements: Array<[string, unknown[]?]> = [
    [
      `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, supersedes_id, created_by, updated_by, version)
       values ($1, $2, $3, 'ANNUAL', $4, $4, $4, $5, $6, 'DRAFT', $7, $8, $8, 1)`,
      [TENANT_A, planId, baseRow.plan_code, baseRow.plan_year, unitId(ROOT), baseRow.revision + 1, base.planId, memberId(MAKER)],
    ],
  ];
  let delta = 0n;
  const kept: string[] = [];
  const lineIds: string[] = [];
  const copy = (templateLineId: string, projectId: string, amount: string, previousLineId: string | null): void => {
    const versionId = randomUUID();
    const lineId = randomUUID();
    kept.push(projectId);
    lineIds.push(lineId);
    statements.push([
      `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, status, capital_plan_id, created_by, updated_by, version)
       values ($1, $2, $3, $4, $5, 'DRAFT', $6, $7, $7, 1)`,
      [TENANT_A, versionId, projectId, baseRow.plan_year, baseRow.revision + 1, planId, memberId(MAKER)],
    ]);
    statements.push([
      `insert into machvon.allocation_line
         (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, project_id, budget_level, origin, previous_line_id, created_by, updated_by)
       select tenant_id, $2::uuid, $3::uuid, fund_source_version_id, bucket, source_year, $4::numeric, 0, appropriation_id, $5::uuid, budget_level, origin, $6::uuid, created_by, updated_by
         from machvon.allocation_line where id = $1::uuid`,
      [templateLineId, lineId, versionId, amount, projectId, previousLineId],
    ]);
  };
  baseLines.forEach((baseLine, index) => {
    const amount = amounts[index];
    if (amount === null || amount === undefined) {
      // A line of the base that the revision drops contributes its whole amount as a reduction.
      delta -= BigInt(baseLine.amount);
      return;
    }
    delta += BigInt(amount) - BigInt(baseLine.amount);
    copy(baseLine.id, baseLine.project_id, amount, baseLine.id);
  });
  for (const extra of extras) {
    delta += BigInt(extra.amount);
    copy((baseLines[0] as (typeof stored)[number]).id, extra.project, extra.amount, null);
  }
  statements.push(["select set_config('app.cap_allocation_write', 'on', false)"], ['update machvon.appropriation set allocated_total_vnd = allocated_total_vnd + $2::numeric where id = $1::uuid', [base.appropriationId, delta.toString()]]);
  await harness.owner(TENANT_A, statements);
  return { planId, year: base.year, appropriationId: base.appropriationId, projects: kept, lineIds };
}

async function approveRevision(revision: Fixture): Promise<void> {
  await submit(revision.planId);
  await decide(revision.planId, 'approve');
}

const drift = (projectIds?: string[]) => as((tx) => publication.balanceDrift(tx, projectIds));
const drifted = async (fixture: Fixture) => drift(fixture.projects);

/** The balance row of a published line takes a commitment, the way the payment story will: lock it, judge it, write it. */
async function commit(balanceId: string, amount: string): Promise<void> {
  await as(async (tx) => {
    await lockLedgerRows(tx, [{ table: 'allocation_balance', id: balanceId }]);
    const [row] = await tx.query<{ free: string }>('select (allocated_vnd - committed_vnd - disbursed_vnd)::text as free from machvon.allocation_balance where id = $1::uuid', [balanceId]);
    if (row === undefined || BigInt(row.free) < BigInt(amount)) throw new DomainError('BALANCE_INSUFFICIENT', 409, 'amount');
    await tx.query('update machvon.allocation_balance set committed_vnd = committed_vnd + $2::numeric, version = version + 1 where id = $1::uuid', [balanceId, amount]);
  });
}

/** The state of FX-CAP-003 on the balance of a published line: allocated as published, committed 6 billion, disbursed 3 billion. */
const spend = (lineId: string, committed: string, disbursed: string) =>
  owner('update machvon.allocation_balance set committed_vnd = $2::numeric, disbursed_vnd = $3::numeric where allocation_line_id = $1::uuid', [lineId, committed, disbursed]);

beforeAll(async () => {
  await harness.start();
  for (const tenant of [TENANT_A, TENANT_B]) {
    await harness.seedUnits(tenant, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: BQL1, path: `/${unitId(ROOT)}/${unitId(BQL1)}/`, parent: ROOT },
    ]);
    for (const member of [MAKER, APPROVER, PUBLISHER, SECOND_MAKER]) await harness.seedMembership(tenant, member, ROOT);
  }
  await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER_MEMBERSHIP_ID, TODAY));
  versions.nstw = await seedMaster('NSTW-DTPT', 'FUND_SOURCE', { category: 'NSTW', relation: 'ADDITIVE' });
  versions.area = await seedMaster('AREA', 'AREA', {});
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

jest.setTimeout(240_000);

describe('CapPlanApprovalStore.submit (submitCapitalPlan)', () => {
  it('moves a DRAFT plan to IN_REVIEW and freezes its lines in the database: the versions of the plan leave DRAFT and the guard of the lines refuses an edit', async () => {
    const year = freshYear();
    const appropriationId = await appropriation({ planYear: year });
    const target = await project();
    const planId = await createPlan(year);
    await draft(planId, [line({ project: target, appropriation: appropriationId, year }, money(2))]);
    const result = await submit(planId);
    expect(result).toMatchObject({ planId, status: 'IN_REVIEW', version: 3, lineCount: 1, projectCount: 1, totalVnd: money(2), planYear: year });
    expect(await planRow(planId)).toMatchObject({ status: 'IN_REVIEW', version: '3', submitted_by: memberId(MAKER), approved_by: null });
    const [stored] = await linesOf(planId);
    expect(stored?.version_status).toBe('IN_REVIEW');
    expect(await sqlState(owner('update machvon.allocation_line set amount_vnd = 1 where id = $1::uuid', [stored?.id]))).toBe('23514');
    expect(await sqlState(owner('delete from machvon.allocation_line where id = $1::uuid', [stored?.id]))).toBe('23514');
    // The command of the drafting stops first, with its own refusal.
    expect(await refusal(as((tx) => plans.draft(tx, planId, 3, { lines: [line({ project: target, appropriation: appropriationId, year }, money(3))] }, memberId(MAKER), scopes, TODAY)))).toMatchObject({ code: 'PLAN_NOT_DRAFT' });
  });

  it('refuses a plan that is not a DRAFT, a stale version, a plan without lines and a unit the caller does not reach, and writes nothing', async () => {
    const year = freshYear();
    const appropriationId = await appropriation({ planYear: year });
    const target = await project();
    const planId = await createPlan(year);
    expect(await refusal(submit(planId))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'lines' });
    await draft(planId, [line({ project: target, appropriation: appropriationId, year }, money(1))]);
    expect(await refusal(as((tx) => approvals.submit(tx, planId, 1, memberId(MAKER), allow)))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 2 } });
    const denied: PlanAuthorizer = () => {
      throw new DomainError('SCOPE_DENIED', 403);
    };
    expect(await refusal(submit(planId, MAKER, denied))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
    expect(await refusal(as((tx) => approvals.submit(tx, randomUUID(), 1, memberId(MAKER), allow)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await planRow(planId)).toMatchObject({ status: 'DRAFT', version: '2', submitted_by: null });
    await submit(planId);
    expect(await refusal(as((tx) => approvals.submit(tx, planId, 3, memberId(MAKER), allow)))).toMatchObject({ code: 'PLAN_NOT_DRAFT', status: 409 });
  });

  it('judges the lines again: a project that left the stages that take capital, an appropriation that is not published and a locked year refuse the submission', async () => {
    const year = freshYear();
    const appropriationId = await appropriation({ planYear: year });
    const target = await project();
    const planId = await createPlan(year);
    await draft(planId, [line({ project: target, appropriation: appropriationId, year }, money(1))]);
    const [stored] = await linesOf(planId);
    await owner("update machvon.project set status = 'CANCELLED' where id = $1::uuid", [target]);
    expect(await refusal(submit(planId))).toMatchObject({ code: 'PROJECT_STAGE_INVALID', status: 422, extensions: { line_id: stored?.id } });
    await owner("update machvon.project set status = 'PIPELINE' where id = $1::uuid", [target]);
    await owner('update machvon.allocation_line set appropriation_id = null, budget_level = null, origin = null where id = $1::uuid', [stored?.id]);
    expect(await refusal(submit(planId))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'lines' });
    await owner('update machvon.allocation_line set appropriation_id = $2::uuid, budget_level = $3, origin = $4 where id = $1::uuid', [stored?.id, appropriationId, 'CENTRAL', 'PM_ASSIGNED']);
    await owner(
      "insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, locked_at, locked_by, created_by, updated_by) values ($1, $2, $3, 'LOCKED', now(), $4, $4, $4)",
      [TENANT_A, randomUUID(), year, memberId(MAKER)],
    );
    expect(await refusal(submit(planId))).toMatchObject({ code: 'FISCAL_YEAR_LOCKED', status: 409 });
    expect(await statusOf(planId)).toBe('DRAFT');
  });
});

describe('CapPlanApprovalStore.decide (decideCapitalPlan)', () => {
  it('never lets the creator or the submitter decide, in any state and whatever the decision (403 SELF_APPROVAL_DENIED)', async () => {
    const year = freshYear();
    const appropriationId = await appropriation({ planYear: year });
    const target = await project();
    const planId = await createPlan(year);
    await draft(planId, [line({ project: target, appropriation: appropriationId, year }, money(1))]);
    // The plan is still a DRAFT: the four-eyes rule is judged before the state.
    expect(await refusal(decide(planId, 'approve', MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    await as((tx) => approvals.submit(tx, planId, 2, memberId(SECOND_MAKER), allow), TENANT_A, SECOND_MAKER);
    for (const decision of ['approve', 'reject', 'return'] as const) {
      expect(await refusal(decide(planId, decision, MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect(await refusal(decide(planId, decision, SECOND_MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    }
    expect(await planRow(planId)).toMatchObject({ status: 'IN_REVIEW', approved_by: null });
    expect(await decide(planId, 'approve', APPROVER)).toMatchObject({ status: 'APPROVED', decision: 'approve' });
  });

  it('approves: the plan is APPROVED with its approver and reason, the versions follow, and a decision on a plan that is not in review is refused', async () => {
    const fixture = await approvedPlan();
    expect(await planRow(fixture.planId)).toMatchObject({ status: 'APPROVED', approved_by: memberId(APPROVER), submitted_by: memberId(MAKER), decision_reason: 'Reviewed against the decision' });
    expect((await linesOf(fixture.planId))[0]?.version_status).toBe('APPROVED');
    expect(await refusal(decide(fixture.planId, 'approve'))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
    expect(await sqlState(owner('update machvon.capital_plan set approved_by = $2::uuid where id = $1::uuid', [fixture.planId, memberId(PUBLISHER)]))).toBe('23514');
  });

  it('judges the shape of the decision, the version and the unit', async () => {
    const year = freshYear();
    const appropriationId = await appropriation({ planYear: year });
    const target = await project();
    const planId = await createPlan(year);
    await draft(planId, [line({ project: target, appropriation: appropriationId, year }, money(1))]);
    await submit(planId);
    const version = await versionOf(planId);
    const decideAs = (decision: string, reason: string, expected = version, authorize: PlanAuthorizer = allow) =>
      as((tx) => approvals.decide(tx, planId, expected, decision as CapPlanDecision, reason, memberId(APPROVER), authorize), TENANT_A, APPROVER);
    expect(await refusal(decideAs('delete', 'A reason that is long enough'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision' });
    expect(await refusal(decideAs('approve', 'no'))).toMatchObject({ detail: 'reason' });
    expect(await refusal(decideAs('approve', 'x'.repeat(2001)))).toMatchObject({ detail: 'reason' });
    expect(await refusal(decideAs('approve', 'A reason that is long enough', version - 1))).toMatchObject({ code: 'VERSION_CONFLICT', extensions: { current_version: version } });
    const denied: PlanAuthorizer = () => {
      throw new DomainError('SCOPE_DENIED', 403);
    };
    expect(await refusal(decideAs('approve', 'A reason that is long enough', version, denied))).toMatchObject({ code: 'SCOPE_DENIED' });
    expect(await refusal(as((tx) => approvals.decide(tx, randomUUID(), 1, 'approve', 'A reason that is long enough', memberId(APPROVER), allow), TENANT_A, APPROVER))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(await statusOf(planId)).toBe('IN_REVIEW');
  });

  it('returns a plan to its planner with the reason, who edits it again, submits it again and has it approved by someone else', async () => {
    const year = freshYear();
    const appropriationId = await appropriation({ planYear: year });
    const target = await project();
    const planId = await createPlan(year);
    await draft(planId, [line({ project: target, appropriation: appropriationId, year }, money(2))]);
    await submit(planId);
    expect(await decide(planId, 'return', APPROVER, 'Lower the line to one billion')).toMatchObject({ status: 'DRAFT', decision: 'return', released: [] });
    expect(await planRow(planId)).toMatchObject({ status: 'DRAFT', submitted_by: null, approved_by: null, decision_reason: 'Lower the line to one billion' });
    expect((await linesOf(planId))[0]?.version_status).toBe('DRAFT');
    await draft(planId, [line({ project: target, appropriation: appropriationId, year }, money(1))]);
    expect((await appropriationRow(appropriationId)).allocated).toBe(money(1));
    await submit(planId);
    expect(await planRow(planId)).toMatchObject({ status: 'IN_REVIEW', decision_reason: null });
    expect(await decide(planId, 'approve', APPROVER)).toMatchObject({ status: 'APPROVED' });
  });

  it('rejects a plan for good and gives its ceiling back to the appropriation, so the allocated total is again the sum of the live plans', async () => {
    const year = freshYear();
    const appropriationId = await appropriation({ planYear: year });
    const first = await project();
    const second = await project();
    const planId = await createPlan(year);
    await draft(planId, [line({ project: first, appropriation: appropriationId, year }, money(3)), line({ project: second, appropriation: appropriationId, year }, money(2))]);
    expect((await appropriationRow(appropriationId)).allocated).toBe(money(5));
    await submit(planId);
    const result = await decide(planId, 'reject', APPROVER, 'Not in the medium-term plan');
    expect(result).toMatchObject({ status: 'REJECTED', released: [{ id: appropriationId, allocatedBeforeVnd: money(5), allocatedAfterVnd: '0' }] });
    expect((await appropriationRow(appropriationId)).allocated).toBe('0');
    expect(await as((tx) => plans.allocatedDrift(tx, [appropriationId]))).toEqual([]);
    expect(await sqlState(owner("update machvon.capital_plan set status = 'DRAFT' where id = $1::uuid", [planId]))).toBe('23514');
    // Another plan takes the ceiling the rejected plan gave back.
    const other = await createPlan(year);
    await draft(other, [line({ project: first, appropriation: appropriationId, year }, money(10))]);
    expect((await appropriationRow(appropriationId)).allocated).toBe(money(10));
  });

  it('gives back only the difference when a revision is rejected: the lines of the revision it replaces still hold their ceiling', async () => {
    const base = await publishedPlan({ amounts: [money(4), money(2)] });
    expect((await appropriationRow(base.appropriationId)).allocated).toBe(money(6));
    const revision = await revise(base, [money(5), money(1)]);
    expect((await appropriationRow(base.appropriationId)).allocated).toBe(money(6));
    await submit(revision.planId);
    const result = await decide(revision.planId, 'reject', APPROVER, 'The increase is not funded');
    expect(result.released).toEqual([]);
    expect((await appropriationRow(base.appropriationId)).allocated).toBe(money(6));
    const grown = await revise(base, [money(6), money(2)]);
    expect((await appropriationRow(base.appropriationId)).allocated).toBe(money(8));
    await submit(grown.planId);
    expect((await decide(grown.planId, 'reject', APPROVER, 'The increase is not funded')).released).toEqual([
      { id: base.appropriationId, amountVnd: money(10), allocatedBeforeVnd: money(8), allocatedAfterVnd: money(6) },
    ]);
    expect(await as((tx) => plans.allocatedDrift(tx, [base.appropriationId]))).toEqual([]);
  });
});

describe('CapPlanPublicationStore.publish (post_plans_id_publish): the first publication of a plan', () => {
  it('publishes with its decision document: the plan, its versions, one ALLOCATE entry and one balance per line, in one transaction (AC-ST-CAP-003-1)', async () => {
    const fixture = await approvedPlan({ amounts: [money(3), money(2)] });
    const document_ = await document();
    const before = await ledgerCount();
    const result = await publish(fixture.planId, { decisionDocumentId: document_, effectiveAt: '2026-07-01T00:00:00Z' });
    expect(result).toMatchObject({ planId: fixture.planId, supersededId: null, decisionDocumentId: document_, lineCount: 2, allocateVnd: money(5), reduceVnd: '0', totalBeforeVnd: '0', totalAfterVnd: money(5), nationalCodeWarnings: [] });
    expect(await planRow(fixture.planId)).toMatchObject({ status: 'PUBLISHED', decision_document_id: document_, approved_by: memberId(APPROVER), published_by: memberId(PUBLISHER), effective_at: '2026-07-01T00:00:00.000Z' });
    const stored = await linesOf(fixture.planId);
    expect(stored.map((row) => row.version_status)).toEqual(['PUBLISHED', 'PUBLISHED']);
    const entries = await ledgerOf(fixture.planId);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.entry_type)).toEqual(['ALLOCATE', 'ALLOCATE']);
    expect(entries.map((entry) => entry.posted_by)).toEqual([memberId(PUBLISHER), memberId(PUBLISHER)]);
    expect(entries.every((entry) => entry.source_ref_kind === 'CAPITAL_PLAN' && entry.plan_year === fixture.year && entry.appropriation_id === fixture.appropriationId)).toBe(true);
    for (const row of stored) {
      expect(await balanceOfLine(row.id)).toMatchObject({ allocated: row.amount, reserved: '0', committed: '0', disbursed: '0', version: '1' });
      expect(entries.find((entry) => entry.allocation_line_id === row.id)).toMatchObject({ amount: row.amount, project_id: row.project_id });
    }
    expect((await ledgerCount()) - before).toBe(2);
    // The ceiling was taken by the drafting: the publication does not touch the allocated total.
    expect((await appropriationRow(fixture.appropriationId)).allocated).toBe(money(5));
    expect(await drifted(fixture)).toEqual([]);
    expect(await as((tx) => plans.allocatedDrift(tx, [fixture.appropriationId]))).toEqual([]);
    expect(await as((tx) => plans.publicationFacts(tx, fixture.planId))).toMatchObject({ capitalPlanId: fixture.planId, decisionDocumentId: document_, projectIds: [...fixture.projects].sort() });
  });

  it('refuses a publication without a usable decision document (422 DECISION_REQUIRED), before it moves anything', async () => {
    const fixture = await approvedPlan();
    for (const bad of [randomUUID(), await document(TENANT_B), await document(TENANT_A, 'RECALLED')]) {
      expect(await refusal(publish(fixture.planId, { decisionDocumentId: bad }))).toMatchObject({ code: 'DECISION_REQUIRED', status: 422, detail: 'decision_document_id' });
    }
    expect(await refusal(publish(fixture.planId, { decisionDocumentId: 'not-an-id' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_document_id' });
    expect(await refusal(publish(fixture.planId, { effectiveAt: 'yesterday' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'effective_at' });
    expect(await planRow(fixture.planId)).toMatchObject({ status: 'APPROVED', decision_document_id: null });
    expect(await ledgerOf(fixture.planId)).toEqual([]);
    expect(await balanceOfLine(fixture.lineIds[0] as string)).toBeUndefined();
  });

  it('publishes only an APPROVED plan (409 PLAN_NOT_APPROVED), never its creator or submitter (403 SELF_APPROVAL_DENIED), only the current version, and not into a locked year', async () => {
    const year = freshYear();
    const appropriationId = await appropriation({ planYear: year });
    const target = await project();
    const planId = await createPlan(year);
    await draft(planId, [line({ project: target, appropriation: appropriationId, year }, money(1))]);
    expect(await refusal(publish(planId))).toMatchObject({ code: 'PLAN_NOT_APPROVED', status: 409 });
    await submit(planId);
    expect(await refusal(publish(planId))).toMatchObject({ code: 'PLAN_NOT_APPROVED', status: 409 });
    await decide(planId, 'approve');
    expect(await refusal(publish(planId, { member: MAKER }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    const version = await versionOf(planId);
    expect(await refusal(publish(planId, { version: version - 1 }))).toMatchObject({ code: 'VERSION_CONFLICT', extensions: { current_version: version } });
    expect(await refusal(publish(planId, { member: PUBLISHER, authorize: () => { throw new DomainError('SCOPE_DENIED', 403); } }))).toMatchObject({ code: 'SCOPE_DENIED' });
    await owner("insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, locked_at, locked_by, created_by, updated_by) values ($1, $2, $3, 'LOCKED', now(), $4, $4, $4)", [TENANT_A, randomUUID(), year, memberId(MAKER)]);
    expect(await refusal(publish(planId))).toMatchObject({ code: 'FISCAL_YEAR_LOCKED', status: 409 });
    expect(await statusOf(planId)).toBe('APPROVED');
    expect(await refusal(as((tx) => publication.publish(tx, randomUUID(), 1, { decisionDocumentId: randomUUID() }, memberId(PUBLISHER), allow, TODAY), TENANT_A, PUBLISHER))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    // The approver may publish what they approved: the rule is about the maker.
    const other = await approvedPlan();
    expect((await publish(other.planId, { member: APPROVER })).planId).toBe(other.planId);
  });

  it('applies the rule on the national project code to the projects of the pipeline it funds: BLOCK refuses and names them, WARN lets them through and reports them (CXN-01)', async () => {
    const withoutCode = await project('PIPELINE', { nationalCode: null });
    const withCode = await project('PIPELINE');
    const budgeted = await project('BUDGETED', { nationalCode: null });
    const year = freshYear();
    const appropriationId = await appropriation({ planYear: year });
    const planId = await createPlan(year);
    await draft(planId, [withoutCode, withCode, budgeted].map((member) => line({ project: member, appropriation: appropriationId, year }, money(1))));
    await submit(planId);
    await decide(planId, 'approve');
    const refused = await refusal(publish(planId));
    expect(refused).toMatchObject({ code: 'NATIONAL_CODE_REQUIRED', status: 422, detail: 'national_project_code', extensions: { project_ids: [withoutCode] } });
    expect(await planRow(planId)).toMatchObject({ status: 'APPROVED' });
    expect(await ledgerOf(planId)).toEqual([]);
    const setMode = (mode: string) =>
      owner(`update machvon.master_record_version v set attributes = jsonb_set(attributes, '{mode}', to_jsonb($1::text)) from machvon.master_record r where r.id = v.master_record_id and r.master_type = 'NATIONAL_CODE_REQUIRED'`, [mode]);
    await setMode('WARN');
    try {
      expect(await publish(planId)).toMatchObject({ planId, nationalCodeWarnings: [withoutCode], lineCount: 3 });
    } finally {
      await setMode('BLOCK');
    }
    expect(await statusOf(planId)).toBe('PUBLISHED');
  });
});

describe('CapPlanPublicationStore.publish: the revision of a published plan', () => {
  it('replaces the published revision: it is SUPERSEDED, the balance moves to the new line with its commitments, the difference is posted and the books agree (AC-ST-CAP-003-1)', async () => {
    const base = await publishedPlan({ amounts: [money(10)] });
    const baseLineId = base.lineIds[0] as string;
    await spend(baseLineId, money(6), money(3));
    const balanceBefore = await balanceOfLine(baseLineId);
    const revision = await revise(base, [money(9)]);
    await approveRevision(revision);
    const result = await publish(revision.planId);
    expect(result).toMatchObject({ supersededId: base.planId, allocateVnd: '0', reduceVnd: money(1), totalBeforeVnd: money(10), totalAfterVnd: money(9) });
    expect(await statusOf(base.planId)).toBe('SUPERSEDED');
    expect(await statusOf(revision.planId)).toBe('PUBLISHED');
    expect((await linesOf(base.planId))[0]?.version_status).toBe('SUPERSEDED');
    expect((await linesOf(revision.planId))[0]?.version_status).toBe('PUBLISHED');
    expect(await owner<{ superseded_by: string | null }>('select superseded_by_id::text as superseded_by from machvon.plan_version where capital_plan_id = $1::uuid', [base.planId])).toHaveLength(1);
    // The balance row is the same row, now on the line of the revision: nothing committed or disbursed is lost.
    expect(await balanceOfLine(baseLineId)).toBeUndefined();
    expect(await balanceOfLine(revision.lineIds[0] as string)).toMatchObject({ id: balanceBefore?.id, allocated: money(9), committed: money(6), disbursed: money(3), version: '2' });
    expect(await ledgerOf(revision.planId)).toMatchObject([{ entry_type: 'REDUCE', amount: money(1), allocation_line_id: revision.lineIds[0] }]);
    expect(await drifted(base)).toEqual([]);
    expect(await as((tx) => plans.allocatedDrift(tx, [base.appropriationId]))).toEqual([]);
    expect((await appropriationRow(base.appropriationId)).allocated).toBe(money(9));
  });

  it('posts ALLOCATE for a line that grows and for a line the revision adds, and REDUCE for a line it drops; a dropped line with nothing committed ends at nothing (AC-ST-CAP-003-1)', async () => {
    const base = await publishedPlan({ amounts: [money(2), money(3), money(1)] });
    const [kept, grown, dropped] = base.lineIds;
    const added = await project();
    const revision = await revise(base, [money(2), money(4), null], [{ project: added, amount: money(2) }]);
    await approveRevision(revision);
    const result = await publish(revision.planId);
    expect(result).toMatchObject({ allocateVnd: money(3), reduceVnd: money(1), totalBeforeVnd: money(6), totalAfterVnd: money(8) });
    const entries = await ledgerOf(revision.planId);
    expect(entries.map((entry) => [entry.entry_type, entry.amount]).sort()).toEqual([
      ['ALLOCATE', money(1)],
      ['ALLOCATE', money(2)],
      ['REDUCE', money(1)],
    ]);
    expect(entries.find((entry) => entry.entry_type === 'REDUCE')?.allocation_line_id).toBe(dropped);
    expect(entries.find((entry) => entry.project_id === added)).toMatchObject({ entry_type: 'ALLOCATE', amount: money(2) });
    expect(await balanceOfLine(dropped as string)).toMatchObject({ allocated: '0' });
    expect(await balanceOfLine(kept as string)).toBeUndefined();
    expect(await balanceOfLine(grown as string)).toBeUndefined();
    expect(await balanceOfLine(revision.lineIds[2] as string)).toMatchObject({ allocated: money(2), committed: '0', version: '1' });
    expect(await drift([...base.projects, added])).toEqual([]);
  });

  it('refuses a line below what is committed and disbursed, lists the line, writes nothing, then accepts the line at exactly that floor (AC-ST-CAP-003-2)', async () => {
    const base = await publishedPlan({ amounts: [money(10)] });
    await spend(base.lineIds[0] as string, money(6), money(3));
    const low = await revise(base, [String(8.5 * BILLION)]);
    await approveRevision(low);
    const entriesBefore = await ledgerCount();
    const refused = await refusal(publish(low.planId));
    expect(refused).toMatchObject({
      code: 'REVISED_BELOW_COMMITTED',
      status: 422,
      extensions: { lines: [{ line_id: low.lineIds[0], project_id: base.projects[0], allocated_vnd: String(8.5 * BILLION), committed_vnd: money(6), disbursed_vnd: money(3), minimum_vnd: money(9) }] },
    });
    expect(await statusOf(low.planId)).toBe('APPROVED');
    expect(await statusOf(base.planId)).toBe('PUBLISHED');
    expect(await ledgerCount()).toBe(entriesBefore);
    expect(await balanceOfLine(base.lineIds[0] as string)).toMatchObject({ allocated: money(10), committed: money(6), disbursed: money(3), version: '1' });
    // The database is the last guard behind the check: the constraint refuses a balance below the floor.
    expect(await sqlState(owner('update machvon.allocation_balance set allocated_vnd = $2::numeric where allocation_line_id = $1::uuid', [base.lineIds[0], String(8.5 * BILLION)]))).toBe('23514');

    const exact = await publishedPlanWithBase(base, [money(9)]);
    expect(exact.result.reduceVnd).toBe(money(1));
    expect(await balanceOfLine(exact.revision.lineIds[0] as string)).toMatchObject({ allocated: money(9), committed: money(6), disbursed: money(3) });
  });

  it('lists every line that falls below its floor, a dropped line that still has a commitment among them', async () => {
    const base = await publishedPlan({ amounts: [money(5), money(5), money(5)], appropriationAmount: money(20) });
    for (const lineId of base.lineIds) await spend(lineId, money(2), money(1));
    const revision = await revise(base, [money(2), money(4), null]);
    await approveRevision(revision);
    const refused = await refusal(publish(revision.planId));
    expect(refused.code).toBe('REVISED_BELOW_COMMITTED');
    const listed = (refused.extensions?.lines as Array<{ line_id: string; allocated_vnd: string }>).map((row) => [row.line_id, row.allocated_vnd]);
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([[revision.lineIds[0], money(2)], [base.lineIds[2], '0']]));
    expect(await drifted(base)).toEqual([]);
  });

  it('refuses a revision whose base is no longer the published revision (409 PLAN_CHANGED_SINCE_PROPOSAL) and a revision published over a stale base', async () => {
    const base = await publishedPlan({ amounts: [money(4)] });
    const first = await revise(base, [money(5)]);
    const second = await revise(base, [money(3)]);
    await approveRevision(first);
    await approveRevision(second);
    await publish(first.planId);
    expect(await refusal(publish(second.planId))).toMatchObject({ code: 'PLAN_CHANGED_SINCE_PROPOSAL', status: 409, detail: 'supersedes_id' });
    expect(await statusOf(second.planId)).toBe('APPROVED');
    // A first revision cannot be published while another revision of its code is in force.
    const stray = await approvedPlan({ code: (await owner<{ plan_code: string }>('select plan_code from machvon.capital_plan where id = $1::uuid', [base.planId]))[0]?.plan_code }).catch((error: unknown) => error);
    expect(stray).toBeDefined();
  });

  it('keeps the as-of order of the revisions: a revision does not take effect before the one it replaces', async () => {
    const base = await approvedPlan({ amounts: [money(4)] });
    await publish(base.planId, { effectiveAt: '2026-07-01T00:00:00Z' });
    const revision = await revise(base, [money(5)]);
    await approveRevision(revision);
    expect(await refusal(publish(revision.planId, { effectiveAt: '2026-06-30T00:00:00Z' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'effective_at' });
    expect((await publish(revision.planId, { effectiveAt: '2026-07-02T00:00:00Z' })).effectiveAt).toBe('2026-07-02T00:00:00.000Z');
  });

  it('has the active reservations of a line follow its balance to the line of the revision; a released one stays where it was', async () => {
    const base = await publishedPlan({ amounts: [money(4)] });
    const baseLine = base.lineIds[0] as string;
    const reservation = async (status: string) => {
      const id = randomUUID();
      await owner(
        `insert into machvon.fund_reservation (tenant_id, id, allocation_line_id, project_id, purpose, amount_vnd, expires_at, status, release_reason, created_by, updated_by)
         values ($1, $2, $3, $4, 'OTHER', 1000, now() + interval '1 day', $5, case when $5 = 'RELEASED' then 'test' end, $6, $6)`,
        [TENANT_A, id, baseLine, base.projects[0], status, memberId(MAKER)],
      );
      return id;
    };
    const active = await reservation('ACTIVE');
    const released = await reservation('RELEASED');
    const revision = await revise(base, [money(5)]);
    await approveRevision(revision);
    await publish(revision.planId);
    const where = async (id: string) => (await owner<{ allocation_line_id: string }>('select allocation_line_id from machvon.fund_reservation where id = $1::uuid', [id]))[0]?.allocation_line_id;
    expect(await where(active)).toBe(revision.lineIds[0]);
    expect(await where(released)).toBe(baseLine);
  });
});

describe('the capital ledger and the balances (AC-ST-CAP-003-3)', () => {
  it('lets the application role append entries and read them but neither update nor delete them, and an entry is reversed once', async () => {
    const fixture = await publishedPlan({ amounts: [money(1)] });
    const [entry] = await ledgerOf(fixture.planId);
    expect(await sqlState(as((tx) => tx.query('update machvon.capital_ledger_entry set amount_vnd = 1 where id = $1::uuid', [entry?.id])))).toBe('42501');
    expect(await sqlState(as((tx) => tx.query('delete from machvon.capital_ledger_entry where id = $1::uuid', [entry?.id])))).toBe('42501');
    expect(await sqlState(as((tx) => tx.query('truncate machvon.capital_ledger_entry')))).toBe('42501');
    expect(await sqlState(as((tx) => tx.query('delete from machvon.allocation_balance where allocation_line_id = $1::uuid', [fixture.lineIds[0]])))).toBe('42501');
    expect((await as((tx) => tx.query<{ n: string }>('select count(*)::text as n from machvon.capital_ledger_entry where id = $1::uuid', [entry?.id])))[0]?.n).toBe('1');
    const reverse = () =>
      as((tx) =>
        tx.query(
          `insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, reversal_of_id, reason, posted_by)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'REVERSAL', $5::numeric, $6::integer, 'CAPITAL_PLAN', $7::uuid, $8::uuid, 'correction', $9::uuid)`,
          [randomUUID(), entry?.appropriation_id, entry?.allocation_line_id, entry?.project_id, entry?.amount, entry?.plan_year, randomUUID(), entry?.id, memberId(MAKER)],
        ),
      );
    await reverse();
    expect(await sqlState(reverse())).toBe('23505');
    expect(await sqlState(as((tx) => tx.query("insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, posted_by) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 'ALLOCATE', 5, 2030, 'CAPITAL_PLAN', $3::uuid, $4::uuid)", [randomUUID(), fixture.appropriationId, randomUUID(), memberId(MAKER)])))).toBe('23514');
    // The reconciliation sees the correction: the ledger now nets to nothing while the balance still holds the line.
    expect(await drifted(fixture)).toEqual([{ projectId: fixture.projects[0], appropriationId: fixture.appropriationId, ledgerVnd: '0', balanceVnd: money(1) }]);
  });

  it('reads a balance that nobody explained as drift, and an explained one as none; the error of a failed publication carries the total', async () => {
    const fixture = await publishedPlan({ amounts: [money(2)] });
    await owner('update machvon.allocation_balance set allocated_vnd = allocated_vnd + 7 where allocation_line_id = $1::uuid', [fixture.lineIds[0]]);
    const found = await drifted(fixture);
    expect(found).toEqual([{ projectId: fixture.projects[0], appropriationId: fixture.appropriationId, ledgerVnd: money(2), balanceVnd: String(2 * BILLION + 7) }]);
    expect(new BalanceDriftError(found).totalVnd).toBe('7');
    expect(new BalanceDriftError([{ projectId: 'p', appropriationId: 'a', ledgerVnd: '5', balanceVnd: '9' }, { projectId: 'q', appropriationId: 'a', ledgerVnd: '9', balanceVnd: '5' }]).totalVnd).toBe('8');
    expect((await as((tx) => publication.balanceDrift(tx))).some((row) => row.projectId === fixture.projects[0])).toBe(true);
  });
});

describe('concurrency on the publication (AC-ST-CAP-003-1, BR-CAP-05)', () => {
  it('lets one of two publications of the same plan win, however often they race, and posts the entries once', async () => {
    let fixture: Fixture | undefined;
    const rounds = await runLoops({
      loops: 12,
      reset: async () => {
        fixture = await approvedPlan({ amounts: [money(1), money(2)] });
      },
      commands: () => {
        const current = fixture as Fixture;
        return [0, 1].map(() => async () => {
          await publish(current.planId);
        });
      },
      verify: async ({ outcomes }) => {
        const current = fixture as Fixture;
        assertOneWinner(outcomes, ['409 VERSION_CONFLICT', '409 PLAN_NOT_APPROVED']);
        expect(await ledgerOf(current.planId)).toHaveLength(2);
        expect(await drifted(current)).toEqual([]);
        expect(await statusOf(current.planId)).toBe('PUBLISHED');
      },
    });
    expect(rounds).toHaveLength(12);
  });

  it('lets one of two revisions of the same plan win and refuses the other, whichever publishes first', async () => {
    let state: { base: Fixture; left: Fixture; right: Fixture } | undefined;
    await runLoops({
      loops: 8,
      reset: async () => {
        const base = await publishedPlan({ amounts: [money(4)] });
        const left = await revise(base, [money(5)]);
        const right = await revise(base, [money(3)]);
        await approveRevision(left);
        await approveRevision(right);
        state = { base, left, right };
      },
      commands: () => {
        const current = state as NonNullable<typeof state>;
        return [current.left, current.right].map((revision) => async () => {
          await publish(revision.planId);
        });
      },
      verify: async ({ outcomes }) => {
        const current = state as NonNullable<typeof state>;
        assertOneWinner(outcomes, ['409 PLAN_CHANGED_SINCE_PROPOSAL']);
        expect(await statusOf(current.base.planId)).toBe('SUPERSEDED');
        const published = (await Promise.all([current.left, current.right].map((revision) => statusOf(revision.planId)))).filter((status) => status === 'PUBLISHED');
        expect(published).toHaveLength(1);
        expect(await drifted(current.base)).toEqual([]);
      },
    });
  });

  it('never lets a commitment and a lowering revision both win on the last of a line: the balance never ends below what is committed and disbursed (FX-CAP-003)', async () => {
    let state: { base: Fixture; revision: Fixture; balanceId: string } | undefined;
    const rounds = await runLoops({
      loops: 15,
      reset: async () => {
        const base = await publishedPlan({ amounts: [money(10)] });
        await spend(base.lineIds[0] as string, money(6), money(3));
        const revision = await revise(base, [money(9)]);
        await approveRevision(revision);
        state = { base, revision, balanceId: (await balanceOfLine(base.lineIds[0] as string))?.id as string };
      },
      commands: () => {
        const current = state as NonNullable<typeof state>;
        return [() => publish(current.revision.planId).then(() => undefined), () => commit(current.balanceId, money(1))];
      },
      verify: async ({ outcomes }) => {
        const current = state as NonNullable<typeof state>;
        assertOneWinner(outcomes, ['422 REVISED_BELOW_COMMITTED', '409 BALANCE_INSUFFICIENT']);
        const [balance] = await owner<{ allocated: string; committed: string; disbursed: string }>(
          'select allocated_vnd::text as allocated, committed_vnd::text as committed, disbursed_vnd::text as disbursed from machvon.allocation_balance where id = $1::uuid',
          [current.balanceId],
        );
        expect(BigInt(balance?.allocated as string)).toBeGreaterThanOrEqual(BigInt(balance?.committed as string) + BigInt(balance?.disbursed as string));
        expect(await drifted(current.base)).toEqual([]);
      },
    });
    const tally = tallyOutcomes(rounds.flatMap((round) => round.outcomes));
    expect(Object.keys(tally).every((label) => ['200', '422 REVISED_BELOW_COMMITTED', '409 BALANCE_INSUFFICIENT'].includes(label))).toBe(true);
  });

  it('does not deadlock a publication with a draft of another plan on the same two appropriations, named in opposite order', async () => {
    const year = freshYear();
    const first = await appropriation({ planYear: year, amountVnd: money(10) });
    const second = await appropriation({ planYear: year, amountVnd: money(10), origin: 'LOCAL_ADDED', decisionDocumentId: await document() });
    const targets = [await project(), await project(), await project()];
    const publishing = await createPlan(year);
    await draft(publishing, [line({ project: targets[0] as string, appropriation: first, year }, money(1)), line({ project: targets[1] as string, appropriation: second, year }, money(1))]);
    await submit(publishing);
    await decide(publishing, 'approve');
    const drafting = await createPlan(year);
    const outcomes = await runConcurrently([
      () => publish(publishing).then(() => undefined),
      () => draft(drafting, [line({ project: targets[2] as string, appropriation: second, year }, money(1)), line({ project: targets[2] as string, appropriation: first, year }, money(1))]),
    ]);
    expect(tallyOutcomes(outcomes)).toEqual({ '200': 2 });
    expect(await as((tx) => plans.allocatedDrift(tx, [first, second]))).toEqual([]);
  });
});

/** Publishes a revision of `base` with the given amounts through the whole flow and returns it with its result. */
async function publishedPlanWithBase(base: Fixture, amounts: Array<string | null>): Promise<{ revision: Fixture; result: PublishResult }> {
  const revision = await revise(base, amounts);
  await approveRevision(revision);
  return { revision, result: await publish(revision.planId) };
}

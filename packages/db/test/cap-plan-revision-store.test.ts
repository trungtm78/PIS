import { randomUUID } from 'node:crypto';
import { assertOneWinner, runLoops, tallyOutcomes, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { CapAppropriationStore } from '../src/cap-appropriation-store';
import type { AppropriationInput } from '../src/cap-appropriation-store';
import { CapPlanApprovalStore } from '../src/cap-plan-approval-store';
import type { PlanAuthorizer } from '../src/cap-plan-approval-store';
import { CapPlanPublicationStore } from '../src/cap-plan-publication-store';
import type { PlanReadScope } from '../src/cap-plan-reads';
import { planReadScope } from '../src/cap-plan-reads';
import { CapPlanRevisionStore, momentOf } from '../src/cap-plan-revision-store';
import { CapPlanStore } from '../src/cap-plan-store';
import type { DraftScopes, LineInput } from '../src/cap-plan-store';
import { WORKER_MEMBERSHIP_ID } from '../src/consumer-inbox';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { PrjProjectStore } from '../src/prj-project-store';
import type { ProjectStatus } from '../src/prj-project-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const appropriations = new CapAppropriationStore();
const plans = new CapPlanStore();
const approvals = new CapPlanApprovalStore();
const publication = new CapPlanPublicationStore();
const revisions = new CapPlanRevisionStore();
const projects = new PrjProjectStore();
const MAKER = 1;
const APPROVER = 2;
const PUBLISHER = 3;
const ROOT = 1;
const BQL1 = 2;
const BQL2 = 3;
const BILLION = 1_000_000_000;
const TODAY = vietnamDateOf(new Date());

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const allDrafts: PlanReadScope = { lines: everything, drafts: true };
const scopes: DraftScopes = { write: everything, read: allDrafts };
const allow: PlanAuthorizer = () => undefined;
const money = (billions: number): string => String(billions * BILLION);
const tenthOfBillion = (tenths: number): string => String(tenths * 100_000_000);

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

async function appropriation(planYear: number, amount = money(10)): Promise<string> {
  const input: AppropriationInput = {
    fundSourceVersionId: versions.nstw as string,
    planYear,
    origin: 'PM_ASSIGNED',
    budgetLevel: 'CENTRAL',
    amountVnd: amount,
    decisionDocumentId: await document(),
    issuingAuthority: 'Thủ tướng Chính phủ',
    sourceYear: planYear,
  };
  const draft = await as((tx) => appropriations.register(tx, input, memberId(MAKER), TODAY));
  await as((tx) => appropriations.decide(tx, draft.id, draft.version, 'approve', memberId(APPROVER), TODAY), TENANT_A, APPROVER);
  return draft.id;
}

async function project(unit = BQL1, status: ProjectStatus = 'PIPELINE'): Promise<string> {
  counter += 1;
  const code = `RV-${counter}-${randomUUID().slice(0, 6)}`;
  const created = await as((tx) =>
    projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(unit), areaMasterVersionId: versions.area as string, totalInvestmentVnd: '500000000000' }, memberId(MAKER), TODAY),
  );
  await owner('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, status, 'B', String(7000000 + counter)]);
  return created.id;
}

const planRow = async (id: string) =>
  (
    await owner<{ version: string; status: string; revision: number; supersedes_id: string | null; plan_code: string; effective_at: string | null }>(
      `select version::text as version, status, revision, supersedes_id, plan_code, to_char(effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as effective_at from machvon.capital_plan where id = $1::uuid`,
      [id],
    )
  )[0] as { version: string; status: string; revision: number; supersedes_id: string | null; plan_code: string; effective_at: string | null };
const versionOf = async (id: string): Promise<number> => Number((await planRow(id)).version);
const allocated = async (appropriationId: string): Promise<string> =>
  (await owner<{ allocated: string }>('select allocated_total_vnd::text as allocated from machvon.appropriation where id = $1::uuid', [appropriationId]))[0]?.allocated ?? '';
const linesOf = (planId: string) =>
  owner<{ id: string; project_id: string; appropriation_id: string; amount: string; previous_line_id: string | null; version_status: string }>(
    `select al.id, al.project_id, al.appropriation_id, al.amount_vnd::text as amount, al.previous_line_id, pv.status as version_status
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

async function createPlan(year: number): Promise<string> {
  counter += 1;
  const created = await as((tx) =>
    plans.createPlan(tx, { planCode: `RV-${counter}-${randomUUID().slice(0, 6)}`, planKind: 'ANNUAL', planYear: year, periodFromYear: year, periodToYear: year, scopeUnitId: unitId(ROOT) }, memberId(MAKER), allow),
  );
  return created.id;
}

async function draft(planId: string, lines: LineInput[], remove: string[] = []): Promise<void> {
  const version = await versionOf(planId);
  await as((tx) => plans.draft(tx, planId, version, { lines, removeLineIds: remove }, memberId(MAKER), scopes, TODAY));
}

async function submitAndApprove(planId: string): Promise<void> {
  const submitVersion = await versionOf(planId);
  await as((tx) => approvals.submit(tx, planId, submitVersion, memberId(MAKER), allow));
  const decideVersion = await versionOf(planId);
  await as((tx) => approvals.decide(tx, planId, decideVersion, 'approve', 'Reviewed against the decision', memberId(APPROVER), allow), TENANT_A, APPROVER);
}

async function publish(planId: string, effectiveAt?: string): Promise<void> {
  const version = await versionOf(planId);
  const decisionDocumentId = await document();
  await as((tx) => publication.publish(tx, planId, version, { decisionDocumentId, effectiveAt }, memberId(PUBLISHER), allow, TODAY), TENANT_A, PUBLISHER);
}

interface Fixture {
  planId: string;
  year: number;
  appropriationId: string;
  projects: string[];
}

/** A plan with one line per project, published at `effectiveAt`. */
async function publishedPlan(amounts: string[], effectiveAt = '2026-01-15T03:00:00.000Z', options: { appropriationAmount?: string; units?: number[] } = {}): Promise<Fixture> {
  const year = freshYear();
  const appropriationId = await appropriation(year, options.appropriationAmount ?? money(10));
  const members: string[] = [];
  for (let index = 0; index < amounts.length; index += 1) members.push(await project(options.units?.[index] ?? BQL1));
  const planId = await createPlan(year);
  await draft(
    planId,
    members.map((member, index) => line({ project: member, appropriation: appropriationId, year }, amounts[index] as string)),
  );
  await submitAndApprove(planId);
  await publish(planId, effectiveAt);
  return { planId, year, appropriationId, projects: members };
}

async function revise(base: Fixture, authorize: PlanAuthorizer = allow) {
  const version = await versionOf(base.planId);
  return as((tx) => revisions.create(tx, base.planId, version, memberId(MAKER), authorize));
}

async function editRevision(revisionId: string, base: Fixture, amounts: Array<[number, string]>): Promise<void> {
  await draft(
    revisionId,
    amounts.map(([index, amount]) => line({ project: base.projects[index] as string, appropriation: base.appropriationId, year: base.year }, amount)),
  );
}

async function publishRevision(revisionId: string, effectiveAt: string): Promise<void> {
  await submitAndApprove(revisionId);
  await publish(revisionId, effectiveAt);
}

const asOf = (planId: string, at: string | undefined, scope: PlanReadScope = allDrafts, projectId?: string, now?: Date) => as((tx) => revisions.asOf(tx, planId, at, projectId, scope, now));

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
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

jest.setTimeout(240_000);

describe('CapPlanRevisionStore.create (createCapitalPlanRevision, ST-CAP-004)', () => {
  it('opens revision 2 as a DRAFT that supersedes the plan in force and carries a copy of its lines, each pointing at the line it copied, with no ceiling moved', async () => {
    const base = await publishedPlan([money(5), money(2)]);
    const before = await allocated(base.appropriationId);
    const created = await revise(base);
    expect(created).toMatchObject({ revision: 2, supersedesId: base.planId, status: 'DRAFT', version: 1, projects: 2, lines: 2 });
    expect(await planRow(created.id)).toMatchObject({ status: 'DRAFT', revision: 2, supersedes_id: base.planId, plan_code: (await planRow(base.planId)).plan_code, version: '1' });
    const original = await linesOf(base.planId);
    const copy = await linesOf(created.id);
    expect(copy.map((row) => row.amount).sort()).toEqual(original.map((row) => row.amount).sort());
    expect(copy.every((row) => row.version_status === 'DRAFT')).toBe(true);
    expect(copy.map((row) => row.previous_line_id).sort()).toEqual(original.map((row) => row.id).sort());
    // The copy takes nothing from the appropriation: a revision counts only its difference to the plan it replaces.
    expect(await allocated(base.appropriationId)).toBe(before);
    expect((await planRow(base.planId)).status).toBe('PUBLISHED');
  });

  it('refuses a second revision while one is in work (AC-ST-CAP-004-3), and lets the plan be revised again once that one is published', async () => {
    const base = await publishedPlan([money(5)]);
    const first = await revise(base);
    expect(await refusal(revise(base))).toEqual({ code: 'REVISION_PENDING_EXISTS', status: 409, detail: 'status' });
    await publishRevision(first.id, '2026-07-01T00:00:00.000Z');
    expect((await planRow(base.planId)).status).toBe('SUPERSEDED');
    // The superseded revision cannot be revised; the one in force can, and numbers on from the highest.
    expect(await refusal(revise(base))).toEqual({ code: 'PLAN_NOT_PUBLISHED', status: 409, detail: 'status' });
    const second = await as((tx) => revisions.create(tx, first.id, 0, memberId(MAKER), allow).catch((error: unknown) => error));
    expect((second as { code?: string }).code).toBe('VERSION_CONFLICT');
    const third = await as(async (tx) => revisions.create(tx, first.id, await versionNow(first.id), memberId(MAKER), allow));
    expect(third).toMatchObject({ revision: 3, supersedesId: first.id });
  });

  it('refuses a plan that is not published, a stale version, an unknown plan, a unit the caller may not plan for and a locked year', async () => {
    const year = freshYear();
    const draftOnly = await createPlan(year);
    expect(await refusal(as((tx) => revisions.create(tx, draftOnly, 1, memberId(MAKER), allow)))).toEqual({ code: 'PLAN_NOT_PUBLISHED', status: 409, detail: 'status' });
    const base = await publishedPlan([money(1)]);
    expect((await refusal(as((tx) => revisions.create(tx, base.planId, 99, memberId(MAKER), allow)))).code).toBe('VERSION_CONFLICT');
    expect(await refusal(as((tx) => revisions.create(tx, randomUUID(), 1, memberId(MAKER), allow)))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await refusal(revise(base, () => { throw Object.assign(new Error('no'), { code: 'SCOPE_DENIED', status: 403 }); }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
    await owner(`insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, locked_at, locked_by, created_by, updated_by) values ($1, $2, $3, 'LOCKED', now(), $4, $4, $4)`, [TENANT_A, randomUUID(), base.year, memberId(MAKER)]);
    expect(await refusal(revise(base))).toEqual({ code: 'FISCAL_YEAR_LOCKED', status: 409, detail: 'plan_year' });
    expect(await refusal(as((tx) => revisions.create(tx, base.planId, 1, memberId(MAKER), allow), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
  });

  it('lets exactly one of several planners open the revision at the same moment', async () => {
    let base!: Fixture;
    const rounds = await runLoops({
      loops: 6,
      reset: async () => {
        base = await publishedPlan([money(1)]);
      },
      commands: () => {
        const planId = base.planId;
        return [0, 1, 2, 3].map(() => async () => {
          const version = await versionOf(planId);
          await as((tx) => revisions.create(tx, planId, version, memberId(MAKER), allow));
        });
      },
      verify: async ({ outcomes }) => {
        assertOneWinner(outcomes, ['409 REVISION_PENDING_EXISTS']);
        const drafts = await owner<{ n: string }>("select count(*)::text as n from machvon.capital_plan where plan_code = (select plan_code from machvon.capital_plan where id = $1::uuid) and status = 'DRAFT'", [base.planId]);
        expect(drafts[0]?.n).toBe('1');
      },
    });
    expect(tallyOutcomes(rounds.flatMap((round) => round.outcomes))).toEqual({ '200': 6, '409 REVISION_PENDING_EXISTS': 18 });
  }, 240_000);
});

const versionNow = (id: string): Promise<number> => versionOf(id);

describe('a revision draws on the ceiling by its difference only (ST-CAP-004, I6 of docs/capital-balances.md)', () => {
  it('moves 0.8 billion from one project to another without changing the total, the ceiling or what is left (AC-ST-CAP-004-2)', async () => {
    const base = await publishedPlan([money(5), money(2)]);
    const ceilingBefore = await allocated(base.appropriationId);
    const revision = await revise(base);
    await editRevision(revision.id, base, [
      [0, tenthOfBillion(42)],
      [1, tenthOfBillion(28)],
    ]);
    expect(await allocated(base.appropriationId)).toBe(ceilingBefore);
    await publishRevision(revision.id, '2026-07-01T00:00:00.000Z');
    expect(await allocated(base.appropriationId)).toBe(ceilingBefore);
    const current = await asOf(base.planId, '2026-12-31');
    expect(current).toMatchObject({ revision: 2, totals: { amountVnd: money(7), initialVnd: money(7), adjustmentVnd: '0', disbursedVnd: '0' } });
    const byProject = new Map((current?.lines ?? []).map((row) => [row.line.project.id, row]));
    expect(byProject.get(base.projects[0] as string)).toMatchObject({ initialVnd: money(5), adjustmentVnd: `-${tenthOfBillion(8)}` });
    expect(byProject.get(base.projects[1] as string)).toMatchObject({ initialVnd: money(2), adjustmentVnd: tenthOfBillion(8) });
    expect(byProject.get(base.projects[0] as string)?.line.amountVnd).toBe(tenthOfBillion(42));
  });

  it('takes the difference only when a line is added or dropped, and refuses a revision that would take more than the appropriation has left', async () => {
    const base = await publishedPlan([money(5)], undefined, { appropriationAmount: money(6) });
    const revision = await revise(base);
    const extra = await project();
    // 5 billion are in force; 1 billion is left. A second project may take 1 billion, not more.
    await draft(revision.id, [line({ project: extra, appropriation: base.appropriationId, year: base.year }, money(1))]);
    expect(await allocated(base.appropriationId)).toBe(money(6));
    const more = await project();
    expect((await refusal(draft(revision.id, [line({ project: more, appropriation: base.appropriationId, year: base.year }, '1')]))).code).toBe('APPROPRIATION_EXCEEDED');
    const stored = await linesOf(revision.id);
    const copied = stored.find((row) => row.project_id === base.projects[0]);
    await draft(revision.id, [], [copied?.id as string]);
    expect(await allocated(base.appropriationId)).toBe(money(1));
  });

  it('gives the difference back when the revision is rejected', async () => {
    const base = await publishedPlan([money(5)]);
    const before = await allocated(base.appropriationId);
    const revision = await revise(base);
    await editRevision(revision.id, base, [[0, money(7)]]);
    expect(await allocated(base.appropriationId)).toBe(String(BigInt(before) + BigInt(money(2))));
    const submitVersion = await versionOf(revision.id);
    await as((tx) => approvals.submit(tx, revision.id, submitVersion, memberId(MAKER), allow));
    const decideVersion = await versionOf(revision.id);
    await as((tx) => approvals.decide(tx, revision.id, decideVersion, 'reject', 'Not justified', memberId(APPROVER), allow), TENANT_A, APPROVER);
    expect(await allocated(base.appropriationId)).toBe(before);
    // A rejected revision is final: the plan can be revised again.
    expect(await revise(base)).toMatchObject({ revision: 3 });
  });
});

describe('CapPlanRevisionStore.asOf (getCapitalPlanAsOf, BR-CAP-10)', () => {
  it('reads the plan as it stood: revision 1 until 30 June, revision 2 from 1 July, each with its own decision document (AC-ST-CAP-004-1)', async () => {
    const base = await publishedPlan([money(5)], '2026-01-15T03:00:00.000Z');
    const revision = await revise(base);
    await editRevision(revision.id, base, [[0, tenthOfBillion(42)]]);
    await publishRevision(revision.id, '2026-07-01T03:00:00.000Z');
    const documents = await owner<{ id: string; decision_document_id: string }>('select id, decision_document_id from machvon.capital_plan where id = any($1::uuid[])', [[base.planId, revision.id]]);
    const documentOf = (id: string): string => documents.find((row) => row.id === id)?.decision_document_id ?? '';

    const june = await asOf(base.planId, '2026-06-30');
    expect(june).toMatchObject({ capitalPlanId: base.planId, revision: 1, status: 'SUPERSEDED', decisionDocumentId: documentOf(base.planId), totals: { amountVnd: money(5) } });
    const july = await asOf(base.planId, '2026-07-02');
    expect(july).toMatchObject({ capitalPlanId: revision.id, revision: 2, status: 'PUBLISHED', decisionDocumentId: documentOf(revision.id), totals: { amountVnd: tenthOfBillion(42) } });
    // Any revision of the plan answers the same: the plan is the code, not the revision.
    expect((await asOf(revision.id, '2026-06-30'))?.capitalPlanId).toBe(base.planId);
    // A day stands for its end in Vietnam: revision 2 came into force at 10:00 on 1 July (UTC+7), so that day already has it.
    expect((await asOf(base.planId, '2026-07-01'))?.revision).toBe(2);
    expect((await asOf(base.planId, '2026-07-01T02:00:00Z'))?.revision).toBe(1);
    expect((await asOf(base.planId, '2026-07-01T03:00:00Z'))?.revision).toBe(2);
    // Without a moment it is now: the revision in force.
    expect((await asOf(base.planId, undefined))?.revision).toBe(2);
  });

  it('has nothing to say about a moment before the first revision came into force, a plan that was never published, and a plan of another tenant', async () => {
    const base = await publishedPlan([money(1)], '2026-01-15T03:00:00.000Z');
    expect(await asOf(base.planId, '2026-01-14')).toBeUndefined();
    const year = freshYear();
    expect(await asOf(await createPlan(year), '2030-01-01')).toBeUndefined();
    expect(await asOf(randomUUID(), '2030-01-01')).toBeUndefined();
    expect(await as((tx) => revisions.asOf(tx, base.planId, '2030-01-01', undefined, allDrafts), TENANT_B)).toBeUndefined();
  });

  it('shows a planner only the lines of the projects in the scope of the read, and one project when asked (AC-ST-CAP-004-4)', async () => {
    const base = await publishedPlan([money(3), money(2)], undefined, { units: [BQL1, BQL2] });
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
    const scope = planReadScope(access, 'capital.read', new Date());
    const mine = await asOf(base.planId, '2030-01-01', scope);
    expect(mine?.lines.map((row) => row.line.project.id)).toEqual([base.projects[0]]);
    expect(mine?.totals.amountVnd).toBe(money(3));
    const wide = await asOf(base.planId, '2030-01-01', allDrafts);
    expect(wide?.lines).toHaveLength(2);
    const one = await asOf(base.planId, '2030-01-01', allDrafts, base.projects[1]);
    expect(one?.lines.map((row) => row.line.project.id)).toEqual([base.projects[1]]);
  });

  it('counts what was paid by the moment asked for, not what was paid after it, and not a payment that was undone', async () => {
    const base = await publishedPlan([money(5)]);
    const target = base.projects[0] as string;
    // A payment is posted against the allocation line of its project (capital_ledger_payment_line_chk).
    const allocationLineId = (await linesOf(base.planId)).find((row) => row.project_id === target)?.id as string;
    const pay = async (amount: string, postedAt: string, reversalOf?: string): Promise<string> => {
      const id = randomUUID();
      await owner(
        `insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, project_id, allocation_line_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, reversal_of_id, posted_at, posted_by)
         values ($1, $2, $3, $4, $12, $5, $6::numeric, $7, 'PAYMENT_REQUEST', $8, $9, $10::timestamptz, $11)`,
        [TENANT_A, id, base.appropriationId, target, reversalOf === undefined ? 'DISBURSE' : 'REVERSAL', amount, base.year, randomUUID(), reversalOf ?? null, postedAt, memberId(MAKER), allocationLineId],
      );
      return id;
    };
    const first = await pay(money(1), '2026-03-01T03:00:00.000Z');
    await pay(tenthOfBillion(5), '2026-05-01T03:00:00.000Z');
    await pay(money(1), '2026-08-01T03:00:00.000Z', first);
    expect((await asOf(base.planId, '2026-02-01'))?.totals.disbursedVnd).toBe('0');
    expect((await asOf(base.planId, '2026-04-01'))?.totals.disbursedVnd).toBe(money(1));
    expect((await asOf(base.planId, '2026-06-01'))?.totals.disbursedVnd).toBe(String(BigInt(money(1)) + BigInt(tenthOfBillion(5))));
    // After the correction the first payment no longer counts.
    expect((await asOf(base.planId, '2026-12-01'))?.totals.disbursedVnd).toBe(tenthOfBillion(5));
  });

  it('cuts nothing for an ordinary plan and rejects a moment that is not a date or an instant', async () => {
    const base = await publishedPlan([money(1)]);
    expect((await asOf(base.planId, undefined))?.truncated).toBe(false);
    for (const bad of ['yesterday', '2026-02-30', '2026-13-01', '2026-06-30T25:00:00Z', '30/06/2026', '']) {
      expect(await refusal(asOf(base.planId, bad))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'at' });
    }
    expect(momentOf('2026-06-30', new Date('2030-01-01T00:00:00Z'))).toBe('2026-06-30T16:59:59.999Z');
    expect(momentOf('2026-06-30T10:00:00+07:00', new Date())).toBe('2026-06-30T03:00:00.000Z');
    expect(momentOf(undefined, new Date('2030-01-01T00:00:00Z'))).toBe('2030-01-01T00:00:00.000Z');
  });

  it('reads the lines page by page and says when it stopped at the bound of one answer', async () => {
    const base = await publishedPlan([money(1), money(1), money(1), money(1), money(1)]);
    const narrow = new CapPlanRevisionStore({ page: 2, maxLines: 3 });
    const cut = await as((tx) => narrow.asOf(tx, base.planId, undefined, undefined, allDrafts));
    expect(cut?.truncated).toBe(true);
    expect(cut?.lines.length).toBe(4);
    // The same plan under a page that fits it reads all five lines in three pages and cuts nothing.
    const paged = await as((tx) => new CapPlanRevisionStore({ page: 2, maxLines: 100 }).asOf(tx, base.planId, undefined, undefined, allDrafts));
    expect(paged).toMatchObject({ truncated: false });
    expect(paged?.lines.length).toBe(5);
    expect(paged?.totals.amountVnd).toBe(money(5));
  });

  it('turns a unique violation of the insert into REVISION_PENDING_EXISTS and leaves the transaction usable', async () => {
    const base = await publishedPlan([money(1)]);
    const version = await versionOf(base.planId);
    // A planner whose check saw nothing in work while another committed in between: the index answers, and the answer is the same as the check's.
    const refused = await as(async (tx) => {
      const racing: TenantTx = {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('insert into machvon.capital_plan')) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
          return tx.query(sql, params);
        },
      } as TenantTx;
      const outcome = await refusal(revisions.create(racing, base.planId, version, memberId(MAKER), allow));
      // The savepoint was rolled back to: the transaction still reads.
      expect((await tx.query<{ n: string }>('select count(*)::text as n from machvon.capital_plan where id = $1::uuid', [base.planId]))[0]?.n).toBe('1');
      return outcome;
    });
    expect(refused).toEqual({ code: 'REVISION_PENDING_EXISTS', status: 409, detail: 'status' });
    expect(await owner('select 1 from machvon.capital_plan where supersedes_id = $1::uuid', [base.planId])).toEqual([]);
  });
});

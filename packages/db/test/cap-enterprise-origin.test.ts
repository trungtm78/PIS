import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import { CapAppropriationStore } from '../src/cap-appropriation-store';
import type { AppropriationInput } from '../src/cap-appropriation-store';
import { CapPlanStore } from '../src/cap-plan-store';
import type { DraftScopes } from '../src/cap-plan-store';
import type { PlanReadScope } from '../src/cap-plan-reads';
import type { ScopeBuilder } from '../src/scope-version';
import { APPROVER, BQL1, CapWorld, MAKER, ROOT, money } from './support/cap-fixtures';
import { memberId, unitId } from './support/authz-fixtures';

/**
 * The enterprise origins of the appropriation register and of the plan lines (ENT-3e, CN.01): the resolution of the group and the decision of the company are two origins, each backed by its own kind of document, the lines
 * of the plan keep the origin and the pack, and the view of the split per project reads them. The public pack keeps behaving as it always did.
 */
const world = new CapWorld();
const appropriations = new CapAppropriationStore();
const plans = new CapPlanStore();
const TODAY = vietnamDateOf(new Date());
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const allDrafts: PlanReadScope = { lines: everything, drafts: true };
const scopes: DraftScopes = { write: everything, read: allDrafts };
const allow = (): undefined => undefined;

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

async function sqlState(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? '';
  }
  throw new Error('expected the database to refuse');
}

async function enterpriseInput(overrides: Partial<AppropriationInput> = {}): Promise<AppropriationInput> {
  const year = overrides.planYear ?? world.freshYear();
  return {
    fundSourceVersionId: world.defaultFundVersionId,
    planYear: year,
    origin: 'GROUP_ASSIGNED',
    budgetLevel: 'ALL',
    amountVnd: money(10),
    decisionDocumentId: await world.document(),
    issuingAuthority: 'Hoi dong thanh vien PVN',
    decisionKind: 'GROUP_RESOLUTION',
    sourceYear: year,
    ...overrides,
  };
}

const registerEnterprise = async (overrides: Partial<AppropriationInput> = {}) => {
  const input = await enterpriseInput(overrides);
  const draft = await world.as((tx) => appropriations.register(tx, input, memberId(MAKER), TODAY, 'ENTERPRISE'));
  return { draft, year: input.planYear };
};

const publishEnterprise = async (overrides: Partial<AppropriationInput> = {}) => {
  const { draft, year } = await registerEnterprise(overrides);
  const done = await world.as((tx) => appropriations.decide(tx, draft.id, draft.version, 'approve', memberId(APPROVER), TODAY), APPROVER);
  return { id: draft.id, year, version: done.version };
};

describe('the enterprise origins of the appropriation register (ENT-3e, CN.01)', () => {
  beforeAll(() => world.start(), 240_000);
  afterAll(() => world.stop());

  it('registers the resolution of the group and the decision of the company, each with its own kind of document, in the enterprise pack', async () => {
    const group = await registerEnterprise({ origin: 'GROUP_ASSIGNED', decisionKind: 'GROUP_RESOLUTION' });
    const company = await registerEnterprise({ origin: 'BOARD_APPROVED', decisionKind: 'COMPANY_DECISION', issuingAuthority: 'Tong cong ty' });
    const first = await world.as((tx) => appropriations.find(tx, group.draft.id));
    const second = await world.as((tx) => appropriations.find(tx, company.draft.id));
    expect(first).toMatchObject({ origin: 'GROUP_ASSIGNED', budgetLevel: 'ALL', taxonomyPack: 'ENTERPRISE', decisionKind: 'GROUP_RESOLUTION', status: 'DRAFT' });
    expect(second).toMatchObject({ origin: 'BOARD_APPROVED', budgetLevel: 'ALL', taxonomyPack: 'ENTERPRISE', decisionKind: 'COMPANY_DECISION' });
  });

  it('refuses a kind of document that belongs to the other origin, a missing kind, a public level and a public origin in the enterprise pack', async () => {
    expect(await refusal(registerEnterprise({ origin: 'GROUP_ASSIGNED', decisionKind: 'COMPANY_DECISION' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'decision_kind' });
    expect(await refusal(registerEnterprise({ origin: 'BOARD_APPROVED', decisionKind: 'GROUP_RESOLUTION' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'decision_kind' });
    expect(await refusal(registerEnterprise({ decisionKind: undefined }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'decision_kind' });
    expect(await refusal(registerEnterprise({ budgetLevel: 'CENTRAL' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'budget_level' });
    expect(await refusal(registerEnterprise({ origin: 'PM_ASSIGNED' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'origin' });
  });

  it('keeps the public pack as it was: five origins, two levels, no kind of document', async () => {
    const input = await enterpriseInput({ origin: 'PM_ASSIGNED', budgetLevel: 'CENTRAL', decisionKind: undefined, issuingAuthority: 'Thu tuong Chinh phu' });
    const draft = await world.as((tx) => appropriations.register(tx, input, memberId(MAKER), TODAY));
    expect(await world.as((tx) => appropriations.find(tx, draft.id))).toMatchObject({ origin: 'PM_ASSIGNED', taxonomyPack: 'PUBLIC', decisionKind: null });
    expect(await refusal(world.as(async (tx) => appropriations.register(tx, await enterpriseInput({ origin: 'GROUP_ASSIGNED', budgetLevel: 'CENTRAL', decisionKind: undefined }), memberId(MAKER), TODAY)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'origin' });
    expect(await refusal(world.as(async (tx) => appropriations.register(tx, await enterpriseInput({ origin: 'PM_ASSIGNED', budgetLevel: 'CENTRAL', decisionKind: 'GROUP_RESOLUTION' }), memberId(MAKER), TODAY)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'decision_kind' });
  });

  it('the database keeps the two sides apart even for a writer that goes around the store', async () => {
    const { draft } = await registerEnterprise();
    expect(await sqlState(world.owner('update machvon.appropriation set decision_kind = null where id = $1::uuid', [draft.id]))).toBe('23514');
    const publicOne = await world.appropriation();
    expect(await sqlState(world.owner("update machvon.appropriation set decision_kind = 'GROUP_RESOLUTION' where id = $1::uuid", [publicOne.id]))).toBe('23514');
  });

  it('publishes an enterprise appropriation (the decision is the maker-checker of the register) and posts it to the ledger', async () => {
    const published = await publishEnterprise({ origin: 'BOARD_APPROVED', decisionKind: 'COMPANY_RESOLUTION' });
    const row = await world.as((tx) => appropriations.find(tx, published.id));
    expect(row).toMatchObject({ status: 'PUBLISHED', origin: 'BOARD_APPROVED', taxonomyPack: 'ENTERPRISE' });
    const entries = await world.owner<{ entry_type: string }>('select entry_type from machvon.capital_ledger_entry where appropriation_id = $1::uuid', [published.id]);
    expect(entries.map((one) => one.entry_type)).toEqual(['APPROPRIATE']);
  });

  describe('the plan lines of the enterprise appropriations and the split per project', () => {
    async function draftLines(year: number, lines: Array<{ projectId: string; appropriationId: string; bucket: 'EQUITY' | 'LOAN' | 'OTHER' | 'CURRENT_YEAR'; amount: string; subset?: string }>) {
      const created = await world.as((tx) =>
        plans.createPlan(tx, { planCode: `ENT-${randomUUID().slice(0, 8)}`, planKind: 'ANNUAL', planYear: year, periodFromYear: year, periodToYear: year, scopeUnitId: unitId(ROOT) }, memberId(MAKER), allow),
      );
      const [row] = await world.owner<{ version: string }>('select version::text as version from machvon.capital_plan where id = $1::uuid', [created.id]);
      return {
        planId: created.id,
        draft: () =>
          world.as((tx) =>
            plans.draft(
              tx,
              created.id,
              Number(row?.version),
              { lines: lines.map((one) => ({ projectId: one.projectId, appropriationId: one.appropriationId, bucket: one.bucket, sourceYear: year, amountVnd: one.amount, ...(one.subset === undefined ? {} : { ctmtqgSubsetVnd: one.subset }) })), removeLineIds: [] },
              memberId(MAKER),
              scopes,
              TODAY,
            ),
          ),
      };
    }

    it('draws the lines of one project on both origins in the classes of the enterprise pack and reads the split with the document of each', async () => {
      const year = world.freshYear();
      const group = await publishEnterprise({ planYear: year, sourceYear: year, origin: 'GROUP_ASSIGNED', decisionKind: 'GROUP_RESOLUTION' });
      const company = await publishEnterprise({ planYear: year, sourceYear: year, origin: 'BOARD_APPROVED', decisionKind: 'COMPANY_DECISION' });
      const projectId = await world.project({ unitNumber: BQL1 });
      const plan = await draftLines(year, [
        { projectId, appropriationId: group.id, bucket: 'EQUITY', amount: money(3) },
        { projectId, appropriationId: company.id, bucket: 'LOAN', amount: money(2) },
      ]);
      await plan.draft();
      const split = await world.owner<{ origin: string; taxonomy_pack: string; decision_kind: string; bucket: string; amount_vnd: string; decision_symbol: string | null; plan_status: string }>(
        'select origin, taxonomy_pack, decision_kind, bucket, amount_vnd::text as amount_vnd, decision_symbol, plan_status from machvon.v_project_origin_decision where project_id = $1::uuid order by origin',
        [projectId],
      );
      expect(split.map((one) => [one.origin, one.taxonomy_pack, one.decision_kind, one.bucket, one.amount_vnd, one.plan_status])).toEqual([
        ['BOARD_APPROVED', 'ENTERPRISE', 'COMPANY_DECISION', 'LOAN', money(2), 'DRAFT'],
        ['GROUP_ASSIGNED', 'ENTERPRISE', 'GROUP_RESOLUTION', 'EQUITY', money(3), 'DRAFT'],
      ]);
      for (const one of split) expect(one.decision_symbol).toMatch(/^QD-/);
      const lines = await world.owner<{ taxonomy_pack: string }>('select distinct al.taxonomy_pack from machvon.allocation_line al where al.project_id = $1::uuid', [projectId]);
      expect(lines).toEqual([{ taxonomy_pack: 'ENTERPRISE' }]);
    });

    it('refuses a public class on an enterprise appropriation, an enterprise class on a public one, and a subset of the national target programmes', async () => {
      const year = world.freshYear();
      const group = await publishEnterprise({ planYear: year, sourceYear: year });
      const publicOne = await world.appropriation({ planYear: year });
      const projectId = await world.project({ unitNumber: BQL1 });
      const refusedBy = async (line: { appropriationId: string; bucket: 'EQUITY' | 'CURRENT_YEAR'; subset?: string }) => {
        const plan = await draftLines(year, [{ projectId, ...line, amount: money(1) }]);
        return refusal(plan.draft());
      };
      expect(await refusedBy({ appropriationId: group.id, bucket: 'CURRENT_YEAR' })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'bucket' });
      expect(await refusedBy({ appropriationId: publicOne.id, bucket: 'EQUITY' })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'bucket' });
      expect(await refusedBy({ appropriationId: group.id, bucket: 'EQUITY', subset: money(1) })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'ctmtqg_subset_vnd' });
    });

    it('a public plan line is what it was: the public pack, the public classes', async () => {
      const line = await world.publishedLine({ allocated: money(1) });
      const rows = await world.owner<{ taxonomy_pack: string; bucket: string }>('select taxonomy_pack, bucket from machvon.allocation_line where id = $1::uuid', [line.lineId]);
      expect(rows).toEqual([{ taxonomy_pack: 'PUBLIC', bucket: 'CURRENT_YEAR' }]);
    });
  });
});

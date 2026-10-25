import { randomUUID } from 'node:crypto';
import { assertOneWinner, runConcurrently, vietnamDateOf } from '@machvon/kernel';
import { CapAllocationExtensionStore } from '../src/cap-allocation-extension-store';
import type { ExtensionRow } from '../src/cap-allocation-extension-store';
import { CapPlanApprovalStore } from '../src/cap-plan-approval-store';
import type { PlanAuthorizer } from '../src/cap-plan-approval-store';
import { CapPlanPublicationStore } from '../src/cap-plan-publication-store';
import { CapPlanRevisionStore } from '../src/cap-plan-revision-store';
import { TENANT_A, TENANT_B, memberId } from './support/authz-fixtures';
import { APPROVER, CapWorld, MAKER, PUBLISHER, money } from './support/cap-fixtures';
import type { PublishedLine } from './support/cap-fixtures';

const TODAY = vietnamDateOf(new Date());
const world = new CapWorld();
const store = new CapAllocationExtensionStore();
const publication = new CapPlanPublicationStore();
const approvals = new CapPlanApprovalStore();
const revisions = new CapPlanRevisionStore();
const allow: PlanAuthorizer = () => undefined;
const REASON = 'Approved on the strength of the decision on the carry-over of capital';

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

/** A request for `line`, by default for all of 3 billion, until the end of March of the year after its plan year. */
const ask = (line: PublishedLine, overrides: { amountVnd?: string; extendedTo?: string; reasonCode?: string; justification?: string } = {}, member = MAKER): Promise<ExtensionRow> =>
  world.as(
    (tx) =>
      store.request(tx, { allocationLineId: line.lineId, amountVnd: money(3), extendedTo: `${line.year + 1}-03-31`, reasonCode: 'GPMB_CHAM', requestedBy: memberId(member), ...overrides }, allow),
    member,
  );

const decide = async (
  row: ExtensionRow,
  options: { decision?: 'approve' | 'reject'; member?: number; documentId?: string | null; reason?: string; version?: number; today?: string } = {},
) => {
  const documentId = options.documentId === undefined ? await world.document() : (options.documentId ?? undefined);
  return world.as(
    (tx) =>
      store.decide(
        tx,
        { extensionId: row.id, decision: options.decision ?? 'approve', decidedBy: memberId(options.member ?? APPROVER), reason: options.reason ?? REASON, approvingDocumentId: documentId, expectedVersion: options.version ?? row.version },
        allow,
        options.today ?? TODAY,
      ),
    options.member ?? APPROVER,
  );
};

const lineRow = async (id: string) =>
  (
    await world.owner<{ bucket: string; source_year: number; is_extended: boolean; extended_to: string | null; extension_document_id: string | null; amount_vnd: string; appropriation_id: string; project_id: string; origin: string }>(
      'select bucket, source_year, is_extended, extended_to::text as extended_to, extension_document_id, amount_vnd::text as amount_vnd, appropriation_id, project_id, origin from machvon.allocation_line where id = $1::uuid',
      [id],
    )
  )[0];
const appropriationRow = async (id: string) =>
  (
    await world.owner<{ origin: string; plan_year: number; source_year: number; status: string; amount_vnd: string; allocated_total_vnd: string; is_extended: boolean; extended_to: string | null; supersedes_id: string | null; decision_document_id: string }>(
      'select origin, plan_year, source_year, status, amount_vnd::text as amount_vnd, allocated_total_vnd::text as allocated_total_vnd, is_extended, extended_to::text as extended_to, supersedes_id, decision_document_id from machvon.appropriation where id = $1::uuid',
      [id],
    )
  )[0];
const entriesOf = (extensionId: string) =>
  world.owner<{ entry_type: string; amount_vnd: string; allocation_line_id: string; appropriation_id: string; plan_year: number; source_ref_kind: string; project_id: string }>(
    "select entry_type, amount_vnd::text as amount_vnd, allocation_line_id, appropriation_id, plan_year, source_ref_kind, project_id from machvon.capital_ledger_entry where source_ref_id = $1::uuid order by entry_type",
    [extensionId],
  );
const drift = () => world.as((tx) => publication.balanceDrift(tx));
const lockYear = (year: number) =>
  world.owner(
    "insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, locked_at, created_by, updated_by) values ($3::uuid, gen_random_uuid(), $1::integer, 'LOCKED', now(), $2::uuid, $2::uuid)",
    [year, memberId(MAKER), TENANT_A],
  );

describe('CapAllocationExtensionStore (ST-CAP-007)', () => {
  beforeAll(async () => {
    await world.start();
  }, 180_000);
  afterAll(async () => {
    await world.stop();
  }, 60_000);

  describe('request', () => {
    it('writes a request for the undisbursed part of a line in force, waiting for a decision', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      const row = await ask(line, { justification: 'Mặt bằng chưa bàn giao do vướng hộ dân' });
      expect(row).toMatchObject({
        allocationLineId: line.lineId,
        projectId: line.projectId,
        fromPlanYear: line.year,
        extendedTo: `${line.year + 1}-03-31`,
        amountVnd: money(3),
        reasonCode: 'GPMB_CHAM',
        justification: 'Mặt bằng chưa bàn giao do vướng hộ dân',
        status: 'REQUESTED',
        approvingDocumentId: null,
        newAllocationLineId: null,
        decidedBy: null,
        version: 1,
      });
      expect(row.createdBy).toBe(memberId(MAKER));
    });

    it('refuses more than allocated less committed and disbursed with 422 AMOUNT_EXCEEDS_UNDISBURSED and says what is left (AC-ST-CAP-007-3, UAT-PLAN-61)', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      await world.setFigures(line.balanceId, { committed: money(1), disbursed: '500000000' });
      const refused = await refusal(ask(line, { amountVnd: money(2) }));
      expect(refused).toMatchObject({ code: 'AMOUNT_EXCEEDS_UNDISBURSED', status: 422, detail: 'amount_vnd', extensions: { undisbursed_vnd: '1500000000', requested_vnd: money(2) } });
      expect((await ask(line, { amountVnd: '1500000000' })).status).toBe('REQUESTED');
    });

    it('does not promise the same capital twice: the open requests of a line count against it', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      await ask(line, { amountVnd: money(2) });
      expect(await refusal(ask(line, { amountVnd: money(2) }))).toMatchObject({ code: 'AMOUNT_EXCEEDS_UNDISBURSED', extensions: { undisbursed_vnd: money(1) } });
      expect((await ask(line, { amountVnd: money(1) })).status).toBe('REQUESTED');
    });

    it('refuses what is wrong with the form with 422 VALIDATION_FAILED naming the first field and listing every issue', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      expect(await refusal(ask(line, { amountVnd: '0' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'amount_vnd' });
      expect(await refusal(ask(line, { extendedTo: `${line.year}-12-31` }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'extended_to', extensions: { reason: 'EXTENDED_TO_TOO_EARLY' } });
      expect(await refusal(ask(line, { extendedTo: `${line.year + 2}-01-01` }))).toMatchObject({ detail: 'extended_to', extensions: { reason: 'EXTENDED_TO_TOO_LATE' } });
      expect(await refusal(ask(line, { reasonCode: 'KHAC' }))).toMatchObject({ detail: 'justification', extensions: { reason: 'JUSTIFICATION_REQUIRED' } });
      expect(await refusal(ask(line, { amountVnd: '1.5', reasonCode: 'WHIM' }))).toMatchObject({ detail: 'amount_vnd', extensions: { issues: [{ field: 'amount_vnd', reason: 'AMOUNT_INVALID' }, { field: 'reason_code', reason: 'REASON_UNKNOWN' }] } });
      expect(await world.owner('select 1 from machvon.allocation_extension where allocation_line_id = $1::uuid', [line.lineId])).toEqual([]);
    });

    it('answers 404 for a line of another tenant or none, and 422 EXTENSION_NOT_ALLOWED for a line that is not in force in a published annual plan', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      const foreign = await refusal(
        world.harness.tenants.withTenant({ tenantId: TENANT_B, membershipId: memberId(MAKER), scopeVersion: 1 }, (tx) =>
          store.request(tx, { allocationLineId: line.lineId, amountVnd: money(1), extendedTo: `${line.year + 1}-03-31`, reasonCode: 'GPMB_CHAM', requestedBy: memberId(MAKER) }, allow),
        ),
      );
      expect(foreign).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(world.as((tx) => store.request(tx, { allocationLineId: randomUUID(), amountVnd: money(1), extendedTo: '2030-03-31', reasonCode: 'GPMB_CHAM', requestedBy: memberId(MAKER) }, allow)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      // A plan that is no longer the one in force is not carried over from.
      await world.owner("update machvon.capital_plan set status = 'SUPERSEDED' where id = $1::uuid", [line.planId]);
      expect(await refusal(ask(line))).toMatchObject({ code: 'EXTENSION_NOT_ALLOWED', status: 422, extensions: { reason: 'LINE_NOT_IN_FORCE' } });
    });

    it('refuses the year that is locked, for the plan year and for the next, with 409 FISCAL_YEAR_LOCKED', async () => {
      // A year that is locked stays locked: the cases use years of their own that no other case of the file uses.
      const planYearLocked = await world.publishedLine({ allocated: money(3), year: 2010 });
      await lockYear(2010);
      expect(await refusal(ask(planYearLocked))).toMatchObject({ code: 'FISCAL_YEAR_LOCKED', status: 409 });
      const nextYearLocked = await world.publishedLine({ allocated: money(3), year: 2012 });
      await lockYear(2013);
      expect(await refusal(ask(nextYearLocked))).toMatchObject({ code: 'FISCAL_YEAR_LOCKED', status: 409 });
    });
  });

  describe('decide: approval', () => {
    it('carries the capital over: a CARRYOVER line of the next year with the source year and the last day, the capital of the plan year not increased, and two entries of one extension (AC-ST-CAP-007-1, UAT-AC229)', async () => {
      const line = await world.publishedLine({ allocated: money(3), appropriationAmount: money(10) });
      const asked = await ask(line, { extendedTo: `${line.year + 1}-01-31` });
      const sourceBefore = await appropriationRow(line.appropriationId);
      const { row, applied } = await decide(asked);
      expect(row).toMatchObject({ status: 'APPLIED', version: 2, decidedBy: memberId(APPROVER), decisionReason: REASON });
      expect(row.approvingDocumentId).not.toBeNull();
      if (applied === undefined) throw new Error('an approval is applied');
      expect(row.newAllocationLineId).toBe(applied.newAllocationLineId);
      expect(row.newAppropriationId).toBe(applied.newAppropriationId);

      // The new line.
      const carried = await lineRow(applied.newAllocationLineId);
      expect(carried).toMatchObject({ bucket: 'CARRYOVER', source_year: line.year, is_extended: true, extended_to: `${line.year + 1}-01-31`, extension_document_id: row.approvingDocumentId, amount_vnd: money(3), origin: 'CARRYOVER', project_id: line.projectId });
      // The appropriation of the next year it draws on.
      expect(await appropriationRow(applied.newAppropriationId)).toMatchObject({ origin: 'CARRYOVER', plan_year: line.year + 1, source_year: line.year, status: 'PUBLISHED', amount_vnd: money(3), allocated_total_vnd: money(3), is_extended: true, extended_to: `${line.year + 1}-01-31` });
      // The capital of the plan year is not increased: its appropriation holds the same, its line gave up the 3 billion.
      expect(await appropriationRow(line.appropriationId)).toEqual(sourceBefore);
      expect(await world.balanceOf(line.balanceId)).toMatchObject({ allocated: '0' });
      const [balance] = await world.owner<{ allocated_vnd: string; committed_vnd: string }>('select allocated_vnd::text, committed_vnd::text from machvon.allocation_balance where allocation_line_id = $1::uuid', [applied.newAllocationLineId]);
      expect(balance).toMatchObject({ allocated_vnd: money(3), committed_vnd: '0' });
      // The two entries of the one extension.
      const entries = await entriesOf(asked.id);
      expect(entries).toEqual([
        { entry_type: 'EXTEND_IN', amount_vnd: money(3), allocation_line_id: applied.newAllocationLineId, appropriation_id: applied.newAppropriationId, plan_year: line.year + 1, source_ref_kind: 'EXTENSION', project_id: line.projectId },
        { entry_type: 'EXTEND_OUT', amount_vnd: money(3), allocation_line_id: line.lineId, appropriation_id: line.appropriationId, plan_year: line.year, source_ref_kind: 'EXTENSION', project_id: line.projectId },
      ]);
      expect(applied.extendOutEntryId).not.toBe(applied.extendInEntryId);
      expect(await drift()).toEqual([]);
    });

    it('lives in a plan of its own for the year and the unit, published by the approval, with a version for the project', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      const { applied } = await decide(await ask(line));
      const [plan] = await world.owner<{ plan_code: string; plan_kind: string; plan_year: number; status: string; revision: number }>(
        'select plan_code, plan_kind, plan_year, status, revision from machvon.capital_plan where id = $1::uuid',
        [applied?.carryOverPlanId],
      );
      expect(plan).toMatchObject({ plan_kind: 'ANNUAL', plan_year: line.year + 1, status: 'PUBLISHED', revision: 1 });
      expect(plan?.plan_code.startsWith(`CARRYOVER-${line.year + 1}-`)).toBe(true);
      const [version] = await world.owner<{ status: string; fiscal_year: number; project_id: string }>(
        'select pv.status, pv.fiscal_year, pv.project_id from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where al.id = $1::uuid',
        [applied?.newAllocationLineId],
      );
      expect(version).toMatchObject({ status: 'PUBLISHED', fiscal_year: line.year + 1, project_id: line.projectId });
    });

    it('can be asked for the part that is left after a first extension, and the carried-over line is not carried over again (EXTENSION_NOT_ALLOWED)', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      const first = await decide(await ask(line, { amountVnd: money(1) }));
      expect((await ask(line, { amountVnd: money(2) })).status).toBe('REQUESTED');
      // 2 billion is left on the line and 2 billion of it is already asked for.
      expect(await refusal(ask(line, { amountVnd: money(1) }))).toMatchObject({ code: 'AMOUNT_EXCEEDS_UNDISBURSED', extensions: { undisbursed_vnd: '0' } });
      // A line that is itself capital carried over has no plan year of its own to carry over from.
      const carriedLine = first.applied?.newAllocationLineId ?? '';
      const refused = await refusal(world.as((tx) => store.request(tx, { allocationLineId: carriedLine, amountVnd: money(1), extendedTo: `${line.year + 2}-03-31`, reasonCode: 'GPMB_CHAM', requestedBy: memberId(MAKER) }, allow)));
      expect(refused).toMatchObject({ code: 'EXTENSION_NOT_ALLOWED', extensions: { reason: 'ALREADY_EXTENDED' } });
    });

    it('registers one appropriation for the decision and revises it for the next line of the same decision, source year and level: its amount grows, the earlier one is superseded and the lines follow', async () => {
      const documentId = await world.document();
      const fund = world.defaultFundVersionId;
      const first = await world.publishedLine({ allocated: money(3), year: 2090, fundVersionId: fund });
      const second = await world.publishedLine({ allocated: money(2), year: 2090, fundVersionId: fund });
      const one = await decide(await ask(first), { documentId });
      const two = await decide(await ask(second, { amountVnd: money(2), extendedTo: '2091-06-30' }), { documentId });
      expect(one.applied?.revisedAppropriation).toBe(false);
      expect(two.applied?.revisedAppropriation).toBe(true);
      const earlier = await appropriationRow(one.applied?.newAppropriationId ?? '');
      const later = await appropriationRow(two.applied?.newAppropriationId ?? '');
      expect(earlier).toMatchObject({ status: 'SUPERSEDED', amount_vnd: money(3) });
      expect(later).toMatchObject({ status: 'PUBLISHED', amount_vnd: money(5), allocated_total_vnd: money(5), supersedes_id: one.applied?.newAppropriationId, extended_to: '2091-06-30' });
      // The first line followed its appropriation to the revision; each line keeps its own last day.
      expect((await lineRow(one.applied?.newAllocationLineId ?? ''))?.appropriation_id).toBe(two.applied?.newAppropriationId);
      expect((await lineRow(one.applied?.newAllocationLineId ?? ''))?.extended_to).toBe('2091-03-31');
      expect((await lineRow(two.applied?.newAllocationLineId ?? ''))?.extended_to).toBe('2091-06-30');
      expect(await drift()).toEqual([]);
    });

    it('gives the project one carried-over line per decision and source: a second one on the same appropriation is refused with 409 APPROPRIATION_DUPLICATE and nothing stays', async () => {
      const documentId = await world.document();
      const line = await world.publishedLine({ allocated: money(4), year: 2085 });
      await decide(await ask(line, { amountVnd: money(1) }), { documentId });
      const before = await world.balanceOf(line.balanceId);
      const second = await ask(line, { amountVnd: money(1) });
      expect(await refusal(decide(second, { documentId }))).toMatchObject({ code: 'APPROPRIATION_DUPLICATE', status: 409 });
      expect(await world.balanceOf(line.balanceId)).toEqual(before);
      expect((await world.owner<{ status: string }>('select status from machvon.allocation_extension where id = $1::uuid', [second.id]))[0]?.status).toBe('REQUESTED');
      expect(await drift()).toEqual([]);
    });

    it('does not carry over what the line has since committed: 422 AMOUNT_EXCEEDS_UNDISBURSED at the decision, and nothing is written (UAT-PLAN-61)', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      const asked = await ask(line, { amountVnd: money(3) });
      await world.setFigures(line.balanceId, { committed: money(1) });
      expect(await refusal(decide(asked))).toMatchObject({ code: 'AMOUNT_EXCEEDS_UNDISBURSED', status: 422, extensions: { undisbursed_vnd: money(2) } });
      expect(await entriesOf(asked.id)).toEqual([]);
      expect(await world.balanceOf(line.balanceId)).toMatchObject({ allocated: money(3), committed: money(1) });
    });
  });

  describe('decide: refusals and rejection', () => {
    it('refuses the person who asked: 403 SELF_APPROVAL_DENIED, the request still waits', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      const asked = await ask(line);
      expect(await refusal(decide(asked, { member: MAKER }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(decide(asked, { member: MAKER, decision: 'reject' }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect((await world.owner<{ status: string }>('select status from machvon.allocation_extension where id = $1::uuid', [asked.id]))[0]?.status).toBe('REQUESTED');
    });

    it('needs the document that allows it: 422 EXTENSION_DOCUMENT_REQUIRED without one, with one of another tenant or one that was recalled (UAT-AC239)', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      const asked = await ask(line);
      expect(await refusal(decide(asked, { documentId: null }))).toMatchObject({ code: 'EXTENSION_DOCUMENT_REQUIRED', status: 422, detail: 'approving_document_id' });
      expect(await refusal(decide(asked, { documentId: randomUUID() }))).toMatchObject({ code: 'EXTENSION_DOCUMENT_REQUIRED' });
      const recalled = await world.document();
      await world.owner("update machvon.document set effect_status = 'RECALLED' where id = $1::uuid", [recalled]);
      expect(await refusal(decide(asked, { documentId: recalled }))).toMatchObject({ code: 'EXTENSION_DOCUMENT_REQUIRED' });
      expect(await entriesOf(asked.id)).toEqual([]);
    });

    it('holds the same rules in the database: no approval without a document, no carry-over line without its document, no carry-over from a later year', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      const asked = await ask(line);
      expect(await sqlState(world.owner("update machvon.allocation_extension set status = 'APPLIED', approved_by = $2::uuid, decided_by = $2::uuid, decided_at = now(), decision_reason = 'reason', new_allocation_line_id = $3::uuid, new_appropriation_id = $4::uuid where id = $1::uuid", [asked.id, memberId(APPROVER), line.lineId, line.appropriationId]))).toBe('23514');
      expect(await sqlState(world.owner("update machvon.allocation_extension set status = 'REJECTED', decided_by = created_by, decided_at = now(), decision_reason = 'reason' where id = $1::uuid", [asked.id]))).toBe('23514');
      expect(
        await sqlState(
          world.owner(
            `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, project_id, budget_level, origin, is_extended, created_by, updated_by)
             select tenant_id, gen_random_uuid(), plan_version_id, fund_source_version_id, 'CARRYOVER', 1999, 1, 0, appropriation_id, project_id, 'CENTRAL', 'CARRYOVER', true, created_by, updated_by from machvon.allocation_line where id = $1::uuid`,
            [line.lineId],
          ),
        ),
      ).toBe('23514');
      expect(
        await sqlState(
          world.owner(
            `insert into machvon.appropriation (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, decision_document_id, issuing_authority, is_extended, extended_to, extension_document_id, source_year, revision, status, created_by, updated_by)
             select tenant_id, gen_random_uuid(), fund_source_version_id, plan_year, 'CARRYOVER', budget_level, 1, decision_document_id, 'Authority', true, '2200-01-01', decision_document_id, plan_year, 1, 'DRAFT', created_by, updated_by from machvon.appropriation where id = $1::uuid`,
            [line.appropriationId],
          ),
        ),
      ).toBe('23514');
    });

    it('rejects with a reason: the request ends and nothing moves', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      const asked = await ask(line);
      const { row, applied } = await decide(asked, { decision: 'reject', documentId: null, reason: 'The decision does not allow it' });
      expect(applied).toBeUndefined();
      expect(row).toMatchObject({ status: 'REJECTED', decidedBy: memberId(APPROVER), decisionReason: 'The decision does not allow it', approvingDocumentId: null, version: 2 });
      expect(await world.balanceOf(line.balanceId)).toMatchObject({ allocated: money(3) });
      expect(await entriesOf(asked.id)).toEqual([]);
      // The capital is free to be asked for again.
      expect((await ask(line)).status).toBe('REQUESTED');
    });

    it('answers 409 VERSION_CONFLICT to a stale version, 409 STAGE_TRANSITION_DENIED to one decided, 404 to none and 422 to a reason that is too short', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      const asked = await ask(line);
      expect(await refusal(decide(asked, { version: 7 }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 1 } });
      expect(await refusal(decide(asked, { reason: 'no' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      await decide(asked, { decision: 'reject', documentId: null });
      expect(await refusal(decide(asked, { version: 2 }))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      expect(await refusal(decide({ ...asked, id: randomUUID() }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('refuses to approve once the last day has passed (422), and when the year of the capital was locked meanwhile (409 FISCAL_YEAR_LOCKED)', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      const asked = await ask(line, { extendedTo: `${line.year + 1}-01-31` });
      expect(await refusal(decide(asked, { today: `${line.year + 1}-02-01` }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'extended_to', extensions: { reason: 'ALREADY_ENDED' } });
      await lockYear(line.year + 1);
      expect(await refusal(decide(asked))).toMatchObject({ code: 'FISCAL_YEAR_LOCKED', status: 409 });
    });

    it('lets exactly one of two concurrent approvals through, and moves the capital once', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      const asked = await ask(line);
      const documentId = await world.document();
      const outcomes = await runConcurrently(
        [0, 1].map(() => async () => {
          await decide(asked, { documentId });
        }),
      );
      assertOneWinner(outcomes, ['409 VERSION_CONFLICT', '409 STAGE_TRANSITION_DENIED']);
      expect(await world.balanceOf(line.balanceId)).toMatchObject({ allocated: '0' });
      expect((await entriesOf(asked.id)).map((entry) => entry.entry_type)).toEqual(['EXTEND_IN', 'EXTEND_OUT']);
      expect(await drift()).toEqual([]);
    });
  });

  describe('a revision of the plan after the capital was carried over', () => {
    it('does not put the carried-over capital back: the line is judged against its amount less what left, and never below it', async () => {
      const line = await world.publishedLine({ allocated: money(3), year: 2080 });
      await decide(await ask(line, { amountVnd: money(1) }));
      expect(await world.balanceOf(line.balanceId)).toMatchObject({ allocated: money(2) });

      // A revision of the plan with the same line is published: the balance stays 2 billion, no ALLOCATE of the carried-over billion.
      const versionOf = async (id: string): Promise<number> => Number((await world.owner<{ version: string }>('select version::text as version from machvon.capital_plan where id = $1::uuid', [id]))[0]?.version);
      const revised = await world.as(async (tx) => revisions.create(tx, line.planId, await versionOf(line.planId), memberId(MAKER), allow));
      await world.as((tx) => approvals.submit(tx, revised.id, revised.version, memberId(MAKER), allow));
      await world.as(async (tx) => approvals.decide(tx, revised.id, await versionOf(revised.id), 'approve', 'Reviewed against the decision', memberId(APPROVER), allow), APPROVER);
      const decisionDocumentId = await world.document();
      const published = await world.as(async (tx) => publication.publish(tx, revised.id, await versionOf(revised.id), { decisionDocumentId, effectiveAt: undefined }, memberId(PUBLISHER), allow, TODAY), PUBLISHER);
      // Nothing is allocated again: the carried-over billion is not on the line any more.
      expect(published.ledger).toEqual([]);
      expect(await world.owner<{ allocated_vnd: string }>('select b.allocated_vnd::text from machvon.allocation_balance b join machvon.allocation_line l on l.id = b.allocation_line_id join machvon.plan_version pv on pv.id = l.plan_version_id where pv.capital_plan_id = $1::uuid', [revised.id])).toEqual([{ allocated_vnd: money(2) }]);
      expect(await drift()).toEqual([]);
    });
  });

  describe('the daily lapse, the reads and the guards of the table', () => {
    it('lets a request that nobody decided lapse once its last day has passed, so it can no longer be approved', async () => {
      const line = await world.publishedLine({ allocated: money(3), year: 2020 });
      const asked = await ask(line, { extendedTo: '2021-03-31' });
      const open = await ask(await world.publishedLine({ allocated: money(3) }));
      expect(await world.as((tx) => store.lapseDue(tx, TODAY, memberId(APPROVER)))).toBeGreaterThanOrEqual(1);
      expect((await world.owner<{ status: string }>('select status from machvon.allocation_extension where id = $1::uuid', [asked.id]))[0]?.status).toBe('LAPSED');
      expect((await world.owner<{ status: string }>('select status from machvon.allocation_extension where id = $1::uuid', [open.id]))[0]?.status).toBe('REQUESTED');
      expect(await world.as((tx) => store.lapseDue(tx, TODAY, memberId(APPROVER)))).toBe(0);
      expect(await refusal(decide(asked, { version: 2, today: '2021-03-01' }))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });
    });

    it('lists the requests of the tenant, the latest first, by keyset, with a filter on the state or the line, and reads one', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      const a = await ask(line, { amountVnd: money(1) });
      const b = await ask(line, { amountVnd: money(1) });
      await decide(b, { decision: 'reject', documentId: null });
      const all = await world.as((tx) => store.list(tx, { allocationLineId: line.lineId }, { limit: 10, after: undefined }));
      expect(all.map((row) => row.id)).toEqual([b.id, a.id]);
      const page = await world.as((tx) => store.list(tx, { allocationLineId: line.lineId }, { limit: 1, after: undefined }));
      const next = await world.as((tx) => store.list(tx, { allocationLineId: line.lineId }, { limit: 5, after: { code: page[0]?.createdAtKey ?? '', id: page[0]?.id ?? '' } }));
      expect(next.map((row) => row.id)).toEqual([a.id]);
      expect((await world.as((tx) => store.list(tx, { allocationLineId: line.lineId, status: 'REJECTED' }, { limit: 10, after: undefined }))).map((row) => row.id)).toEqual([b.id]);
      expect(await world.as((tx) => store.find(tx, a.id))).toMatchObject({ id: a.id, status: 'REQUESTED' });
      expect(await world.as((tx) => store.find(tx, randomUUID()))).toBeUndefined();
    });

    it('never changes what was asked for, moves forward only and is never deleted', async () => {
      const line = await world.publishedLine({ allocated: money(3) });
      const asked = await ask(line);
      for (const assignment of ["amount_vnd = amount_vnd + 1", "extended_to = extended_to + 1", "reason_code = 'KHAC'", "justification = 'a justification of twenty characters'", 'created_by = gen_random_uuid()', 'allocation_line_id = gen_random_uuid()']) {
        expect(await sqlState(world.owner(`update machvon.allocation_extension set ${assignment} where id = $1::uuid`, [asked.id]))).toBe('23514');
      }
      expect(await sqlState(world.owner('delete from machvon.allocation_extension where id = $1::uuid', [asked.id]))).toBe('23514');
      await decide(asked, { decision: 'reject', documentId: null });
      expect(await sqlState(world.owner("update machvon.allocation_extension set status = 'REQUESTED' where id = $1::uuid", [asked.id]))).toBe('23514');
      expect(await sqlState(world.owner("update machvon.allocation_extension set decision_reason = 'another reason' where id = $1::uuid", [asked.id]))).toBe('23514');
    });
  });
});

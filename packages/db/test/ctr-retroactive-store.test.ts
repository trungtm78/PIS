import { randomUUID } from 'node:crypto';
import { CtrAcceptanceStore } from '../src/ctr-acceptance-store';
import { CtrChangeChainStore } from '../src/ctr-change-chain-store';
import type { ChangeResult } from '../src/ctr-change-chain-store';
import type { DecisionHooks } from '../src/ctr-change-decision-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import { retroactiveRecordsOf } from '../src/ctr-retroactive-reads';
import { CtrRetroactiveStore } from '../src/ctr-retroactive-store';
import type { RetroactiveInput, RetroactiveResult } from '../src/ctr-retroactive-store';
import { PayLedgerStore } from '../src/pay-ledger-store';
import type { TenantTx } from '../src/tenant-database';
import { AcceptanceWorld } from './support/acceptance-fixtures';
import type { ApprovedAcceptance, SeededContract } from './support/acceptance-fixtures';
import { everything, seedAs } from './support/bid-proposal-fixtures';
import { TENANT_A, id, memberId } from './support/authz-fixtures';

jest.setTimeout(600_000);

const fixtures = new AcceptanceWorld();
const chain = new CtrChangeChainStore();
const retroactive = new CtrRetroactiveStore();
const ledger = new PayLedgerStore();
const MAKER = 1;
const EVALUATOR = 2;
const APPROVER = 3;
const DOCUMENT_MAKER = 4;
const SETTLER = 6;
const VERSION = id(0xb1, 31);
const TODAY = '2026-08-10';
let counter = 0;
const contractScopes: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const invisible: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) };

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = APPROVER): Promise<T> => fixtures.as(work, member);
const owner = fixtures.owner.bind(fixtures);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<{ message: string; sqlstate: string }> => {
  try {
    await work;
  } catch (error) {
    const e = error as { message: string; code?: string };
    return { message: e.message, sqlstate: e.code ?? '' };
  }
  throw new Error('expected the database to refuse');
};

const hooks = (overrides: Partial<DecisionHooks> = {}): DecisionHooks & { authorise: jest.Mock; available: jest.Mock } =>
  ({ authorise: jest.fn(async () => undefined), available: jest.fn(async () => undefined), ...overrides }) as DecisionHooks & { authorise: jest.Mock; available: jest.Mock };

/** The BOQ of the seeded contract with a new price for B02 (500 m3 at 2,000,000 under revision 1). */
const boqFor = (perM3: string, lump = '1000000') => [
  { business_key: 'B01', description: 'Item B01', unit_code: 'M3', quantity: '8000', unit_price: lump },
  { business_key: 'B02', description: 'Item B02', unit_code: 'M3', quantity: '500', unit_price: perM3 },
  { business_key: 'B03', description: 'Item B03', unit_code: 'M3', quantity: '10', unit_price: '1234.5' },
];

interface Scenario {
  contract: SeededContract;
  approved: ApprovedAcceptance;
  co: ChangeResult;
}

/** A contract with an approved acceptance of 500 m3 of B02 (one billion, dated 25 July) on the ledger, and a CO that was assessed. */
async function scenario(options: { delta?: string; recognise?: boolean; stage?: boolean } = {}): Promise<Scenario> {
  const contract = await fixtures.seedContract();
  const approved = await fixtures.approve(contract, [{ item: 1, quantity: '500' }]);
  if (options.recognise !== false) await as((tx) => ledger.recognize(tx, { acceptanceId: approved.acceptance.id, requestId: randomUUID(), actor: memberId(MAKER) }), MAKER);
  const co = await evaluatedCo(contract, options.delta ?? '100000000');
  return { contract, approved, co };
}

async function evaluatedCo(contract: SeededContract, delta: string, baselineRevisionId: string = contract.revisionId): Promise<ChangeResult> {
  const event = await as((tx) => chain.create(tx, contract.contractId, { stage: 'EVENT', baselineRevisionId, reason: 'The owner agreed a new price.', estimatedDeltaVnd: delta, scheduleImpactDays: 0 }, memberId(MAKER), contractScopes), MAKER);
  const pco = await as((tx) => chain.promote(tx, event.id, 1, 'It is a change.', memberId(MAKER), contractScopes), MAKER);
  const co = await as((tx) => chain.promote(tx, pco.id, 1, 'Priced.', memberId(MAKER), contractScopes), MAKER);
  return as(
    (tx) =>
      chain.evaluate(tx, co.id, 1, { evaluatedDeltaVnd: delta, scheduleImpactDays: 0, fundingImpactNote: 'Paid from the plan.', ...(BigInt(delta) > 0n ? { allocationLineId: fixtures.lineId } : {}) }, memberId(EVALUATOR), contractScopes, {
        available: async () => undefined,
      }),
    EVALUATOR,
  );
}

const input = (target: Scenario, overrides: Partial<RetroactiveInput> = {}): RetroactiveInput => ({
  adjustmentBasis: 'The owner agreed the new price from 1 June.',
  decisionDocumentVersionId: VERSION,
  affectedAcceptanceIds: [target.approved.acceptance.id],
  effectiveOn: '2026-06-01',
  boqLines: boqFor('2100000'),
  ...overrides,
});

const approve = (target: Scenario, overrides: Partial<RetroactiveInput> = {}, options: { version?: number; member?: number; scopes?: ContractScopes; hooks?: DecisionHooks; today?: string } = {}): Promise<RetroactiveResult> =>
  as(
    (tx) => retroactive.approve(tx, target.co.id, options.version ?? target.co.version, input(target, overrides), memberId(options.member ?? APPROVER), options.scopes ?? contractScopes, options.today ?? TODAY, options.hooks ?? hooks()),
    options.member ?? APPROVER,
  );

const entriesOf = (contractId: string, kind = 'ADJUSTMENT') =>
  owner<{ id: string; ledger_id: string; accepted_delta_vnd: string; requested_delta_vnd: string; paid_delta_vnd: string; adjustment_line_id: string | null; reason: string | null; acceptance_id: string; boq_item_id: string }>(
    'select id, ledger_id, accepted_delta_vnd::text, requested_delta_vnd::text, paid_delta_vnd::text, adjustment_line_id, reason, acceptance_id, boq_item_id from machvon.cumulative_ledger_entry where contract_id = $1::uuid and entry_kind = $2 order by posted_at, id',
    [contractId, kind],
  );
const balanceOf = async (acceptanceId: string) =>
  (await owner<{ accepted_vnd: string; requested_vnd: string; paid_vnd: string }>('select sum(accepted_vnd)::text as accepted_vnd, sum(requested_vnd)::text as requested_vnd, sum(paid_vnd)::text as paid_vnd from machvon.cumulative_ledger where acceptance_id = $1::uuid', [acceptanceId]))[0];
const contractRow = async (contractId: string) =>
  (await owner<{ contract_value_vnd: string; accepted_total_vnd: string; current_revision_id: string | null; version: string }>('select contract_value_vnd::text, accepted_total_vnd::text, current_revision_id, version::text from machvon.contract where id = $1::uuid', [contractId]))[0];
const revisionsOf = (contractId: string) =>
  owner<{ id: string; revision: number; status: string; retroactive: boolean; amount_vnd: string; valid_from: string; valid_until: string | null; supersedes_id: string | null }>(
    'select id, revision, status, retroactive, amount_vnd::text, valid_from::text, valid_until::text, supersedes_id from machvon.contract_revision where contract_id = $1::uuid order by revision',
    [contractId],
  );
const requestRow = async (requestId: string) =>
  (await owner<{ status: string; version: string; approved_delta_vnd: string | null; effective_on: string | null; retroactive: boolean; resulting_revision_id: string | null }>(
    'select status, version::text, approved_delta_vnd::text, effective_on::text, retroactive, resulting_revision_id from machvon.change_request where id = $1::uuid',
    [requestId],
  ))[0];
/** The acceptance and its lines exactly as they are stored. */
const frozen = async (acceptanceId: string) => ({
  acceptance: (await owner<{ row: unknown }>('select to_jsonb(a) as row from machvon.acceptance a where id = $1::uuid', [acceptanceId]))[0]?.row,
  lines: (await owner<{ row: unknown }>('select to_jsonb(l) as row from machvon.acceptance_line l where acceptance_id = $1::uuid order by id', [acceptanceId])).map((each) => each.row),
});
const adjustmentRows = async (contractId: string) => (await owner<{ n: string }>('select count(*)::text as n from machvon.retroactive_adjustment where contract_id = $1::uuid', [contractId]))[0]?.n;

/** A settlement of the project that was verified or closed, or one that is only being worked. */
async function settlement(projectId: string, options: { status: string; scope?: 'CONTRACT' | 'PROJECT' | 'ANNUAL'; contractId?: string; year?: number }): Promise<string> {
  const settlementId = randomUUID();
  const scope = options.scope ?? 'CONTRACT';
  const sent = options.status !== 'DRAFT';
  const verified = options.status === 'VERIFIED' || options.status === 'CLOSED';
  const closed = options.status === 'CLOSED';
  counter += 1;
  await seedAs(fixtures.harness, [[
    `insert into machvon.settlement_revision
       (tenant_id, id, project_id, contract_id, revision, settled_amount_vnd, outstanding_vnd, unrecovered_advance_vnd, audit_finding_refs, status, settlement_scope, fiscal_year, project_group,
        submitted_by, submitted_at, submitted_on, deadline_rule_version_id, deadline_days, verification_due_on, verified_by, verified_at, verified_on,
        closed_by, closed_at, close_reason, decision_document_version_id, created_by, updated_by, version)
     values ($1, $2, $3, $4, $5, 0, 0, 0, '[]'::jsonb, $6, $7, $8, ${sent ? "'B'" : 'null'},
             $9, ${sent ? 'now()' : 'null'}, ${sent ? "date '2026-08-01'" : 'null'}, ${sent ? 'gen_random_uuid()' : 'null'}, ${sent ? '120' : 'null'}, ${sent ? "date '2026-12-01'" : 'null'},
             nullif($10::text, '')::uuid, ${verified ? 'now()' : 'null'}, ${verified ? "date '2026-08-05'" : 'null'},
             nullif($11::text, '')::uuid, ${closed ? 'now()' : 'null'}, ${closed ? "'Closed.'" : 'null'}, nullif($12::text, '')::uuid, $13, $13, 1)`,
    [TENANT_A, settlementId, projectId, scope === 'CONTRACT' ? options.contractId : null, counter, options.status, scope, scope === 'ANNUAL' ? (options.year ?? 2026) : null, memberId(MAKER), verified ? memberId(EVALUATOR) : '', closed ? memberId(SETTLER) : '', closed ? VERSION : '', memberId(APPROVER)],
  ]]);
  return settlementId;
}

describe('the retroactive adjustment of a change order (ST-CTR-016)', () => {
  beforeAll(async () => {
    await fixtures.start();
    for (const member of [DOCUMENT_MAKER, SETTLER]) await fixtures.harness.seedMembership(TENANT_A, member, 1);
    await as((tx) => chain.setTiers(tx, fixtures.projectId, 3, memberId(MAKER), everything), MAKER);
  }, 240_000);

  // A settlement that was approved closes every adjustment of the project: each case starts without one.
  afterEach(async () => {
    await seedAs(fixtures.harness, [['delete from machvon.settlement_revision', []]]);
  });

  afterAll(async () => {
    await fixtures.stop();
  }, 60_000);

  describe('the adjustment that is made (AC-ST-CTR-016-1, UAT-AC58)', () => {
    it('AC-ST-CTR-016-1, UAT-AC58: leaves the acceptance as it was approved and puts the difference on the ledger as an adjustment', async () => {
      const target = await scenario();
      const before = await frozen(target.approved.acceptance.id);
      expect(await balanceOf(target.approved.acceptance.id)).toMatchObject({ accepted_vnd: '1000000000' });
      const done = await approve(target);

      expect(done).toMatchObject({
        status: 'APPROVED',
        fromStatus: 'EVALUATED',
        effectiveOn: '2026-06-01',
        approvedOn: TODAY,
        approvedDeltaVnd: '100000000',
        totalAdjustmentVnd: '50000000',
        fromValueVnd: '9000000000',
        toValueVnd: '9100000000',
        acceptedTotalVnd: '1050000000',
        affectedAcceptanceIds: [target.approved.acceptance.id],
      });
      expect(done.balances).toHaveLength(1);
      expect(done.balances[0]).toMatchObject({ acceptanceId: target.approved.acceptance.id, oldAmountVnd: '1000000000', newUnitPrice: '2100000.000000', newAmountVnd: '1050000000', deltaVnd: '50000000', quantity: '500.000000' });

      // What was approved is untouched: the acceptance and its lines are the same rows, byte for byte.
      expect(await frozen(target.approved.acceptance.id)).toEqual(before);
      // The difference is a new entry of the ledger, named after its line, with the basis; the balance follows it and nothing else on the balance moves.
      const entries = await entriesOf(target.contract.contractId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ accepted_delta_vnd: '50000000', requested_delta_vnd: '0', paid_delta_vnd: '0', adjustment_line_id: done.balances[0]?.id, reason: 'The owner agreed the new price from 1 June.', acceptance_id: target.approved.acceptance.id });
      expect(await balanceOf(target.approved.acceptance.id)).toEqual({ accepted_vnd: '1050000000', requested_vnd: '0', paid_vnd: '0' });
      expect(await contractRow(target.contract.contractId)).toMatchObject({ contract_value_vnd: '9100000000', accepted_total_vnd: '1050000000', current_revision_id: done.revision.id });
    });

    it('AC-ST-CTR-016-1: records the decision document, the basis, the effective day and the affected acceptances, and makes the revision that is in force', async () => {
      const target = await scenario();
      const done = await approve(target);
      const revisions = await revisionsOf(target.contract.contractId);
      expect(revisions).toEqual([
        { id: target.contract.revisionId, revision: 1, status: 'SUPERSEDED', retroactive: false, amount_vnd: '9000000000', valid_from: '2026-01-02', valid_until: TODAY, supersedes_id: null },
        { id: done.revision.id, revision: 2, status: 'EFFECTIVE', retroactive: true, amount_vnd: '9100000000', valid_from: TODAY, valid_until: null, supersedes_id: target.contract.revisionId },
      ]);
      expect(await requestRow(target.co.id)).toMatchObject({ status: 'APPROVED', approved_delta_vnd: '100000000', effective_on: '2026-06-01', retroactive: true, resulting_revision_id: done.revision.id });

      const records = await as((tx) => retroactiveRecordsOf(tx, target.contract.contractId));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        id: done.adjustmentId,
        changeRequestId: target.co.id,
        revisionId: done.revision.id,
        effectiveOn: '2026-06-01',
        approvedOn: TODAY,
        basis: 'The owner agreed the new price from 1 June.',
        decisionDocumentVersionId: VERSION,
        totalDeltaVnd: '50000000',
        approvedBy: memberId(APPROVER),
      });
      expect(records[0]?.affected).toEqual([
        {
          id: done.balances[0]?.id,
          acceptanceId: target.approved.acceptance.id,
          acceptanceNo: target.approved.acceptance.acceptanceNo,
          boqItemId: target.contract.items[1],
          boqItemKey: 'B02',
          partyId: null,
          quantity: '500.000000',
          oldAmountVnd: '1000000000',
          newUnitPrice: '2100000.000000',
          newAmountVnd: '1050000000',
          deltaVnd: '50000000',
        },
      ]);
      expect(await as((tx) => retroactiveRecordsOf(tx, randomUUID()))).toEqual([]);
    });

    it('prices later work under the revision it made, and the job has nothing left to do for it', async () => {
      const target = await scenario();
      const done = await approve(target);
      const pending = await owner<{ n: string }>("select count(*)::text as n from machvon.contract_revision where contract_id = $1::uuid and status = 'PENDING_EFFECTIVE'", [target.contract.contractId]);
      expect(pending[0]?.n).toBe('0');
      const price = await owner<{ unit_price: string }>('select unit_price::text from machvon.boq_line where contract_revision_id = $1::uuid and business_key = $2', [done.revision.id, 'B02']);
      expect(price[0]?.unit_price).toBe('2100000.000000');
    });

    it('makes a negative entry when the price falls, and takes it off the accepted amount only', async () => {
      const target = await scenario({ delta: '-40000000' });
      const done = await approve(target, { boqLines: boqFor('1900000') });
      expect(done).toMatchObject({ totalAdjustmentVnd: '-50000000', toValueVnd: '8960000000', acceptedTotalVnd: '950000000' });
      expect(await balanceOf(target.approved.acceptance.id)).toEqual({ accepted_vnd: '950000000', requested_vnd: '0', paid_vnd: '0' });
      expect((await entriesOf(target.contract.contractId))[0]).toMatchObject({ accepted_delta_vnd: '-50000000', requested_delta_vnd: '0', paid_delta_vnd: '0' });
      expect(await contractRow(target.contract.contractId)).toMatchObject({ accepted_total_vnd: '950000000' });
    });

    it('refuses a fall that would take the accepted amount below what was already requested, and leaves nothing behind', async () => {
      const target = await scenario({ delta: '-40000000' });
      const balance = await owner<{ id: string }>('select id from machvon.cumulative_ledger where acceptance_id = $1::uuid', [target.approved.acceptance.id]);
      await as(
        (tx) =>
          ledger.post(tx, {
            ledgerId: balance[0]?.id as string,
            kind: 'CLAIM',
            delta: { accepted: '0', requested: '1000000000', paid: '0', advanceRecovery: '0', retention: '0' },
            requestId: randomUUID(),
            actor: memberId(MAKER),
            advanceOutstandingVnd: '0',
          }),
        MAKER,
      );
      const before = await revisionsOf(target.contract.contractId);
      const failure = await refusal(approve(target, { boqLines: boqFor('1900000') }));
      expect(failure).toMatchObject({ code: 'VALUE_EXCEEDED', status: 409, extensions: { rule: 'REQUESTED_LE_ACCEPTED' } });
      expect(await revisionsOf(target.contract.contractId)).toEqual(before);
      expect(await adjustmentRows(target.contract.contractId)).toBe('0');
      expect(await entriesOf(target.contract.contractId)).toEqual([]);
      expect(await requestRow(target.co.id)).toMatchObject({ status: 'EVALUATED' });
      expect(await contractRow(target.contract.contractId)).toMatchObject({ contract_value_vnd: '9000000000', accepted_total_vnd: '1000000000' });
    });

    it('raises a balance that was claimed, because the accepted amount may go up past what was requested', async () => {
      const target = await scenario();
      const balance = await owner<{ id: string }>('select id from machvon.cumulative_ledger where acceptance_id = $1::uuid', [target.approved.acceptance.id]);
      await as(
        (tx) =>
          ledger.post(tx, {
            ledgerId: balance[0]?.id as string,
            kind: 'CLAIM',
            delta: { accepted: '0', requested: '1000000000', paid: '0', advanceRecovery: '0', retention: '0' },
            requestId: randomUUID(),
            actor: memberId(MAKER),
            advanceOutstandingVnd: '0',
          }),
        MAKER,
      );
      await approve(target);
      expect(await balanceOf(target.approved.acceptance.id)).toEqual({ accepted_vnd: '1050000000', requested_vnd: '1000000000', paid_vnd: '0' });
    });

    it('lets the accepted total of the contract go above the value it had, because the revision that carries it is in force before the total moves (contract_ledger_order_chk)', async () => {
      const target = await scenario();
      await seedAs(fixtures.harness, [['update machvon.contract set accepted_total_vnd = contract_value_vnd where id = $1::uuid', [target.contract.contractId]]]);
      const done = await approve(target);
      expect(done).toMatchObject({ fromValueVnd: '9000000000', toValueVnd: '9100000000', acceptedTotalVnd: '9050000000' });
      expect(await contractRow(target.contract.contractId)).toMatchObject({ contract_value_vnd: '9100000000', accepted_total_vnd: '9050000000' });
    });

    it('AC-ST-CTR-016-1: lets the value of the contract fall below the accepted total it had when the adjustment brings the accepted total under the new value (contract_ledger_order_chk judges the figures at the end)', async () => {
      // 1,000,000,000 accepted; the price falls to 1,900,000 (950,000,000 accepted) and the contract to 960,000,000: below the old accepted total, above the new one.
      const target = await scenario({ delta: '-8040000000' });
      const before = await contractRow(target.contract.contractId);
      expect(before).toMatchObject({ contract_value_vnd: '9000000000', accepted_total_vnd: '1000000000' });
      const done = await approve(target, { boqLines: boqFor('1900000', '1') });
      expect(done).toMatchObject({ fromValueVnd: '9000000000', toValueVnd: '960000000', totalAdjustmentVnd: '-50000000', acceptedTotalVnd: '950000000' });
      const after = await contractRow(target.contract.contractId);
      expect(after).toMatchObject({ contract_value_vnd: '960000000', accepted_total_vnd: '950000000', current_revision_id: done.revision.id });
      // Two updates of the contract (the accepted total, the revision taking over), and the answer carries the version the contract ended at.
      expect(Number(after?.version)).toBe(Number(before?.version) + 2);
      expect(done.contractVersion).toBe(Number(after?.version));
      expect(await revisionsOf(target.contract.contractId)).toMatchObject([{ status: 'SUPERSEDED', valid_until: TODAY }, { id: done.revision.id, status: 'EFFECTIVE', amount_vnd: '960000000' }]);
      expect(await balanceOf(target.approved.acceptance.id)).toEqual({ accepted_vnd: '950000000', requested_vnd: '0', paid_vnd: '0' });
    });

    it('re-prices only the items whose unit price the change moves: an acceptance of an item at the same price is not affected', async () => {
      const target = await scenario();
      const other = await fixtures.approve(target.contract, [{ item: 0, quantity: '10' }]);
      await as((tx) => ledger.recognize(tx, { acceptanceId: other.acceptance.id, requestId: randomUUID(), actor: memberId(MAKER) }), MAKER);
      const mismatch = await refusal(approve(target, { affectedAcceptanceIds: [target.approved.acceptance.id, other.acceptance.id] }));
      expect(mismatch).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'affected_acceptance_ids', extensions: { reason: 'AFFECTED_MISMATCH', missing_acceptance_ids: [], unexpected_acceptance_ids: [other.acceptance.id] } });
      await approve(target);
      expect(await balanceOf(other.acceptance.id)).toMatchObject({ accepted_vnd: '10000000' });
    });

    it('leaves an acceptance before the effective day alone', async () => {
      const target = await scenario();
      // The acceptance is dated 25 July: a change that applies from 1 August does not reach it.
      const outcome = await refusal(approve(target, { effectiveOn: '2026-08-01' }));
      expect(outcome).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'affected_acceptance_ids', extensions: { reason: 'AFFECTED_MISMATCH', missing_acceptance_ids: [], unexpected_acceptance_ids: [target.approved.acceptance.id] } });
      const done = await approve(target, { effectiveOn: '2026-08-01', affectedAcceptanceIds: [] });
      expect(done).toMatchObject({ totalAdjustmentVnd: '0', balances: [], affectedAcceptanceIds: [] });
      expect(await entriesOf(target.contract.contractId)).toEqual([]);
      expect(await balanceOf(target.approved.acceptance.id)).toMatchObject({ accepted_vnd: '1000000000' });
      expect(await contractRow(target.contract.contractId)).toMatchObject({ contract_value_vnd: '9100000000', accepted_total_vnd: '1000000000' });
    });
  });

  describe('a balance adjusted again by a later change order (AC-ST-CTR-016-1: no double counting)', () => {
    /** The first adjustment (2,000,000 to 2,100,000, +50,000,000 on the balance), then a second change order on the revision it made, approved the day after. */
    async function adjustedOnce(): Promise<{ target: Scenario; first: RetroactiveResult }> {
      const target = await scenario();
      const first = await approve(target);
      return { target, first };
    }
    const nextDay = '2026-08-11';
    const secondCo = async (target: Scenario, first: RetroactiveResult, delta: string): Promise<Scenario> => ({ contract: target.contract, approved: target.approved, co: await evaluatedCo(target.contract, delta, first.revision.id) });
    const again = (target: Scenario, overrides: Partial<RetroactiveInput>) => approve(target, overrides, { today: nextDay });

    it('moves the balance from what it is worth after the first adjustment: 1,000 then 1,050 then 1,100 million posts +50 million and not +100 million', async () => {
      const { target, first } = await adjustedOnce();
      const second = await secondCo(target, first, '100000000');
      const done = await again(second, { boqLines: boqFor('2200000') });
      expect(done).toMatchObject({ totalAdjustmentVnd: '50000000', acceptedTotalVnd: '1100000000', affectedAcceptanceIds: [target.approved.acceptance.id] });
      expect(done.balances[0]).toMatchObject({ oldAmountVnd: '1050000000', newAmountVnd: '1100000000', deltaVnd: '50000000' });
      expect(await balanceOf(target.approved.acceptance.id)).toEqual({ accepted_vnd: '1100000000', requested_vnd: '0', paid_vnd: '0' });
      expect((await entriesOf(target.contract.contractId)).map((entry) => entry.accepted_delta_vnd)).toEqual(['50000000', '50000000']);
      expect(await contractRow(target.contract.contractId)).toMatchObject({ contract_value_vnd: '9200000000', accepted_total_vnd: '1100000000' });
      // The record of the second adjustment says what the balance was worth, so the lines of both read as a chain.
      const lines = await owner<{ old_amount_vnd: string; new_amount_vnd: string; delta_vnd: string }>(
        'select l.old_amount_vnd::text, l.new_amount_vnd::text, l.delta_vnd::text from machvon.retroactive_adjustment_line l join machvon.retroactive_adjustment a on a.tenant_id = l.tenant_id and a.id = l.adjustment_id where l.contract_id = $1::uuid order by a.approved_on',
        [target.contract.contractId],
      );
      expect(lines).toEqual([
        { old_amount_vnd: '1000000000', new_amount_vnd: '1050000000', delta_vnd: '50000000' },
        { old_amount_vnd: '1050000000', new_amount_vnd: '1100000000', delta_vnd: '50000000' },
      ]);
    });

    it('takes the first adjustment back when the later price returns to the price of the acceptance: the balance is -50 million although the line differs from its original by nothing', async () => {
      const { target, first } = await adjustedOnce();
      const second = await secondCo(target, first, '-50000000');
      // The list the old computation would have found is empty; the acceptance is affected.
      expect(await refusal(again(second, { boqLines: boqFor('2000000'), affectedAcceptanceIds: [] }))).toMatchObject({ extensions: { reason: 'AFFECTED_MISMATCH', missing_acceptance_ids: [target.approved.acceptance.id], unexpected_acceptance_ids: [] } });
      const done = await again(second, { boqLines: boqFor('2000000') });
      expect(done).toMatchObject({ totalAdjustmentVnd: '-50000000', acceptedTotalVnd: '1000000000' });
      expect(done.balances[0]).toMatchObject({ oldAmountVnd: '1050000000', newAmountVnd: '1000000000', deltaVnd: '-50000000' });
      expect(await balanceOf(target.approved.acceptance.id)).toEqual({ accepted_vnd: '1000000000', requested_vnd: '0', paid_vnd: '0' });
      expect(await contractRow(target.contract.contractId)).toMatchObject({ contract_value_vnd: '9050000000', accepted_total_vnd: '1000000000' });
    });

    it('posts nothing for a balance that is already worth what the new price makes it, and the acceptance is not in the list', async () => {
      const { target, first } = await adjustedOnce();
      const second = await secondCo(target, first, '1');
      // 2,100,000.0004 is another price than the one in force, and 500 of it is 1,050,000,000.2: the same amount.
      expect(await refusal(again(second, { boqLines: boqFor('2100000.0004') }))).toMatchObject({ extensions: { reason: 'AFFECTED_MISMATCH', missing_acceptance_ids: [], unexpected_acceptance_ids: [target.approved.acceptance.id] } });
      const done = await again(second, { boqLines: boqFor('2100000.0004'), affectedAcceptanceIds: [] });
      expect(done).toMatchObject({ totalAdjustmentVnd: '0', balances: [], affectedAcceptanceIds: [], acceptedTotalVnd: '1050000000' });
      expect(await entriesOf(target.contract.contractId)).toHaveLength(1);
      expect(await balanceOf(target.approved.acceptance.id)).toMatchObject({ accepted_vnd: '1050000000' });
    });

    it('raises a balance that was claimed after the first adjustment, from what it is worth then', async () => {
      const { target, first } = await adjustedOnce();
      const balance = await owner<{ id: string }>('select id from machvon.cumulative_ledger where acceptance_id = $1::uuid', [target.approved.acceptance.id]);
      await as(
        (tx) =>
          ledger.post(tx, { ledgerId: balance[0]?.id as string, kind: 'CLAIM', delta: { accepted: '0', requested: '1050000000', paid: '0', advanceRecovery: '0', retention: '0' }, requestId: randomUUID(), actor: memberId(MAKER), advanceOutstandingVnd: '0' }),
        MAKER,
      );
      const second = await secondCo(target, first, '100000000');
      const done = await again(second, { boqLines: boqFor('2200000') });
      expect(done.balances[0]).toMatchObject({ oldAmountVnd: '1050000000', deltaVnd: '50000000' });
      expect(await balanceOf(target.approved.acceptance.id)).toEqual({ accepted_vnd: '1100000000', requested_vnd: '1050000000', paid_vnd: '0' });
    });
  });

  describe('what refuses it', () => {
    it('AC-ST-CTR-016-1, UAT-AC58: is refused when a settlement that read the ledger is approved, and not by one that is still being worked', async () => {
      const target = await scenario();
      const projectId = fixtures.projectId;
      const closed = await settlement(projectId, { status: 'VERIFIED', contractId: target.contract.contractId });
      const failure = await refusal(approve(target));
      expect(failure).toMatchObject({ code: 'SETTLEMENT_ALREADY_APPROVED', status: 409, extensions: { settlement_id: closed, settlement_scope: 'CONTRACT', settlement_status: 'VERIFIED' } });
      expect(await adjustmentRows(target.contract.contractId)).toBe('0');
      expect(await requestRow(target.co.id)).toMatchObject({ status: 'EVALUATED' });
    });

    it('is not refused by a settlement that is still being worked, whatever its stage', async () => {
      for (const status of ['DRAFT', 'SUBMITTED', 'VERIFYING']) {
        const target = await scenario();
        await settlement(fixtures.projectId, { status, contractId: target.contract.contractId });
        await expect(approve(target)).resolves.toMatchObject({ status: 'APPROVED' });
        await seedAs(fixtures.harness, [['delete from machvon.settlement_revision', []]]);
      }
    });

    it('is refused by an approved settlement of the project, and by one of the year of the posting, but not by one of another contract or of a year that is over', async () => {
      const projectId = fixtures.projectId;
      const first = await scenario();
      const other = await fixtures.seedContract();
      await settlement(projectId, { status: 'CLOSED', contractId: other.contractId });
      await settlement(projectId, { status: 'CLOSED', scope: 'ANNUAL', year: 2025 });
      await expect(approve(first)).resolves.toMatchObject({ status: 'APPROVED' });

      const second = await scenario();
      const annual = await settlement(projectId, { status: 'VERIFIED', scope: 'ANNUAL', year: 2026 });
      await expect(approve(second)).rejects.toMatchObject({ code: 'SETTLEMENT_ALREADY_APPROVED', extensions: { settlement_id: annual, settlement_scope: 'ANNUAL' } });

      await seedAs(fixtures.harness, [['delete from machvon.settlement_revision where id = $1::uuid', [annual]]]);
      const third = await scenario();
      const whole = await settlement(projectId, { status: 'CLOSED', scope: 'PROJECT' });
      await expect(approve(third)).rejects.toMatchObject({ code: 'SETTLEMENT_ALREADY_APPROVED', extensions: { settlement_id: whole, settlement_scope: 'PROJECT', settlement_status: 'CLOSED' } });
    });

    it('is refused for whoever raised, promoted or assessed the change, or made the decision document (403 SELF_APPROVAL_DENIED)', async () => {
      const target = await scenario();
      for (const member of [MAKER, EVALUATOR]) {
        expect(await refusal(approve(target, {}, { member }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      }
      // The document of the approval was made by member 4; member 4 does not approve on it.
      const document = randomUUID();
      const version = randomUUID();
      await owner(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', $3, $3)`, [TENANT_A, document, memberId(DOCUMENT_MAKER)]);
      await owner(
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/retro.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, version, document],
      );
      expect(await refusal(approve(target, { decisionDocumentVersionId: version }, { member: DOCUMENT_MAKER }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await adjustmentRows(target.contract.contractId)).toBe('0');
    });

    it('asks for a decision document, refuses an unknown one, and takes the basis in words', async () => {
      const target = await scenario();
      expect(await refusal(approve(target, { decisionDocumentVersionId: undefined }))).toMatchObject({ code: 'DECISION_DOCUMENT_REQUIRED', status: 422, detail: 'decision_document_version_id' });
      expect(await refusal(approve(target, { decisionDocumentVersionId: randomUUID() }))).toMatchObject({ code: 'DECISION_DOCUMENT_REQUIRED', status: 422 });
      for (const adjustmentBasis of ['', '   ', 'x'.repeat(2001)]) expect(await refusal(approve(target, { adjustmentBasis }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'adjustment_basis' });
    });

    it('takes only a day before today and not before the contract began (a change from today or later is decided the ordinary way)', async () => {
      const target = await scenario();
      for (const effectiveOn of [TODAY, '2026-09-01']) {
        expect(await refusal(approve(target, { effectiveOn }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_on', extensions: { reason: 'NOT_RETROACTIVE' } });
      }
      expect(await refusal(approve(target, { effectiveOn: '2026-01-01' }))).toMatchObject({ detail: 'effective_on', extensions: { reason: 'BEFORE_CONTRACT', contract_began_on: '2026-01-02' } });
      for (const effectiveOn of ['2026-02-30', 'yesterday', '']) expect(await refusal(approve(target, { effectiveOn }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'effective_on' });
    });

    it('takes a list of acceptances that is exactly the one the change reaches', async () => {
      const target = await scenario();
      expect(await refusal(approve(target, { affectedAcceptanceIds: [] }))).toMatchObject({
        code: 'VALIDATION_FAILED',
        detail: 'affected_acceptance_ids',
        extensions: { reason: 'AFFECTED_MISMATCH', missing_acceptance_ids: [target.approved.acceptance.id], unexpected_acceptance_ids: [] },
      });
      const stranger = randomUUID();
      expect(await refusal(approve(target, { affectedAcceptanceIds: [target.approved.acceptance.id, stranger] }))).toMatchObject({ extensions: { unexpected_acceptance_ids: [stranger] } });
      for (const bad of [['not-a-uuid'], Array.from({ length: 501 }, () => randomUUID())]) expect(await refusal(approve(target, { affectedAcceptanceIds: bad }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'affected_acceptance_ids' });
      // The same acceptance named twice, in capitals, is named once.
      await expect(approve(target, { affectedAcceptanceIds: [target.approved.acceptance.id, target.approved.acceptance.id.toUpperCase()] })).resolves.toMatchObject({ status: 'APPROVED' });
    });

    it('acts on a CO that was assessed, once, at the version the caller read', async () => {
      const target = await scenario();
      expect(await refusal(approve(target, {}, { version: target.co.version + 1 }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(approve(target, {}, { scopes: invisible }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => retroactive.approve(tx, randomUUID(), 1, input(target), memberId(APPROVER), contractScopes, TODAY, hooks())))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      const done = await approve(target);
      expect(await refusal(approve(target, {}, { version: done.version }))).toMatchObject({ code: 'CHANGE_STATE_INVALID', status: 409, extensions: { change_status: 'APPROVED' } });

      const event = await as((tx) => chain.create(tx, target.contract.contractId, { stage: 'EVENT', baselineRevisionId: done.revision.id, reason: 'Not yet assessed.', estimatedDeltaVnd: '1', scheduleImpactDays: 0 }, memberId(MAKER), contractScopes), MAKER);
      expect(await refusal(as((tx) => retroactive.approve(tx, event.id, event.version, input(target), memberId(APPROVER), contractScopes, TODAY, hooks())))).toMatchObject({ code: 'CHANGE_STAGE_NOT_ALLOWED', status: 422 });
    });

    it('is refused for a CO that has not been assessed or for a contract that is not being performed', async () => {
      const target = await scenario();
      const pco = await as((tx) => chain.create(tx, target.contract.contractId, { stage: 'EVENT', baselineRevisionId: target.contract.revisionId, reason: 'x', estimatedDeltaVnd: '1', scheduleImpactDays: 0 }, memberId(MAKER), contractScopes), MAKER);
      const promoted = await as((tx) => chain.promote(tx, pco.id, pco.version, 'It is a change.', memberId(MAKER), contractScopes), MAKER);
      const co = await as((tx) => chain.promote(tx, promoted.id, promoted.version, 'Priced.', memberId(MAKER), contractScopes), MAKER);
      expect(await refusal(as((tx) => retroactive.approve(tx, co.id, co.version, input(target), memberId(APPROVER), contractScopes, TODAY, hooks())))).toMatchObject({ code: 'CHANGE_STATE_INVALID', status: 409, extensions: { change_status: 'SUBMITTED' } });
      await seedAs(fixtures.harness, [["update machvon.contract set status = 'DRAFT' where id = $1::uuid", [target.contract.contractId]]]);
      expect(await refusal(approve(target))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409 });
    });

    it('is refused while a revision waits for its day, and when the revision in force began today or later', async () => {
      const pending = await scenario();
      await seedAs(fixtures.harness, [
        [
          `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
           values ($1, gen_random_uuid(), $2, 2, 9000000000, $3, date '2026-09-01', 'PENDING_EFFECTIVE', 'AMENDMENT', 1, $4, $4, $4, now())`,
          [TENANT_A, pending.contract.contractId, VERSION, memberId(MAKER)],
        ],
      ]);
      expect(await refusal(approve(pending))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { reason: 'REVISION_PENDING' } });

      const began = await scenario();
      await seedAs(fixtures.harness, [
        ["update machvon.contract_revision set status = 'SUPERSEDED', valid_until = $2::date where id = $1::uuid", [began.contract.revisionId, TODAY]],
        [
          `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
           values ($1, gen_random_uuid(), $2, 2, 9000000000, $3, $5::date, 'EFFECTIVE', 'AMENDMENT', 1, $4, $4, $4, now())`,
          [TENANT_A, began.contract.contractId, VERSION, memberId(MAKER), TODAY],
        ],
      ]);
      expect(await refusal(approve(began))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_on', extensions: { reason: 'NOT_AFTER_REVISION', after: TODAY } });
    });

    it('keeps the value of the contract at or above what was accepted and paid, counting what the adjustment adds (BR-CTR-06)', async () => {
      const target = await scenario({ delta: '-7500000000' });
      await seedAs(fixtures.harness, [['update machvon.contract set advance_paid_vnd = 2000000000 where id = $1::uuid', [target.contract.contractId]]]);
      const failure = await refusal(approve(target, { boqLines: boqFor('2100000', '1') }));
      expect(failure).toMatchObject({ code: 'ACCEPTANCE_VALUE_EXCEEDS_CONTRACT', status: 422, extensions: { new_value_vnd: '1500000000', floor_vnd: '2000000000', accepted_total_vnd: '1050000000' } });
      expect(await adjustmentRows(target.contract.contractId)).toBe('0');
      expect(await refusal(approve(await scenario({ delta: '-9000000000' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'approved_delta_vnd' });
    });

    it('asks the delegation of the matrix for the larger of the change and the adjustment, and the capital for an increase', async () => {
      const target = await scenario();
      const asked = hooks();
      await approve(target, {}, { hooks: asked });
      expect(asked.authorise).toHaveBeenCalledWith(expect.objectContaining({ amountVnd: '100000000', contractId: target.contract.contractId }));
      expect(asked.available).toHaveBeenCalledWith(fixtures.lineId, '100000000');

      const falling = await scenario({ delta: '-40000000' });
      const second = hooks();
      await approve(falling, { boqLines: boqFor('1900000') }, { hooks: second });
      expect(second.authorise).toHaveBeenCalledWith(expect.objectContaining({ amountVnd: '50000000' }));
      expect(second.available).not.toHaveBeenCalled();

      const denied = await scenario();
      const failure = await refusal(approve(denied, {}, { hooks: hooks({ authorise: jest.fn(async () => Promise.reject(Object.assign(new Error('x'), { code: 'SCOPE_DENIED', status: 403 }))) }) }));
      expect(failure).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await adjustmentRows(denied.contract.contractId)).toBe('0');
      const unavailable = await scenario();
      expect(await refusal(approve(unavailable, {}, { hooks: hooks({ available: jest.fn(async () => Promise.reject(Object.assign(new Error('x'), { code: 'ALLOCATION_UNAVAILABLE', status: 422 }))) }) }))).toMatchObject({ code: 'ALLOCATION_UNAVAILABLE' });
      expect(await requestRow(unavailable.co.id)).toMatchObject({ status: 'EVALUATED' });
    });

    it('needs the line of capital an increase is paid from', async () => {
      const target = await scenario();
      await seedAs(fixtures.harness, [['update machvon.change_request set evaluation_allocation_line_id = null where id = $1::uuid', [target.co.id]]]);
      expect(await refusal(approve(target))).toMatchObject({ code: 'ALLOCATION_UNAVAILABLE', extensions: { reason: 'ALLOCATION_LINE_REQUIRED' } });
    });

    it('refuses to adjust an acceptance the ledger has not recognised yet (409, to be retried), and a BOQ that does not fit the value', async () => {
      const target = await scenario({ recognise: false });
      expect(await refusal(approve(target))).toMatchObject({ code: 'ACCEPTANCE_STATE_INVALID', status: 409, extensions: { reason: 'NOT_ON_LEDGER', acceptance_id: target.approved.acceptance.id } });
      const small = await scenario({ delta: '10000000' });
      expect(await refusal(approve(small))).toMatchObject({ code: 'BOQ_TOTAL_MISMATCH', status: 422 });
    });
  });

  describe('the acceptances of a joint venture', () => {
    it('adjusts the balance of each member separately', async () => {
      const venture = await fixtures.seedContract();
      const approved = await fixtures.approve(venture, [{ item: 1, quantity: '300', party: true }, { item: 1, quantity: '200' }]);
      await as((tx) => ledger.recognize(tx, { acceptanceId: approved.acceptance.id, requestId: randomUUID(), actor: memberId(MAKER) }), MAKER);
      const co = await evaluatedCo(venture, '100000000');
      const target2: Scenario = { contract: venture, approved, co };
      const done = await approve(target2);
      expect(done.balances.map((balance) => [balance.partyId, balance.quantity, balance.deltaVnd]).sort()).toEqual(
        [
          [null, '200.000000', '20000000'],
          [venture.partyId, '300.000000', '30000000'],
        ].sort(),
      );
      expect((await entriesOf(venture.contractId)).map((entry) => entry.accepted_delta_vnd).sort()).toEqual(['20000000', '30000000']);
    });
  });

  describe('what the database keeps when the application is bypassed', () => {
    it('does not let an adjustment, its lines or its entries be changed or deleted, by anyone', async () => {
      const target = await scenario();
      const done = await approve(target);
      for (const table of ['retroactive_adjustment', 'retroactive_adjustment_line']) {
        for (const statement of [`update machvon.${table} set created_by = created_by`, `delete from machvon.${table}`, `truncate machvon.${table} cascade`]) {
          expect((await databaseRefusal(owner(statement))).message).toMatch(/RETROACTIVE_ADJUSTMENT_IMMUTABLE|immutable|cannot truncate/i);
        }
      }
      expect((await databaseRefusal(owner(`update machvon.cumulative_ledger_entry set reason = 'x' where id = $1::uuid`, [(await entriesOf(target.contract.contractId))[0]?.id]))).message).toMatch(/LEDGER_ENTRY_IMMUTABLE/);
      expect(done.adjustmentId).toBeDefined();
    });

    it('refuses an entry of adjustment that names no line, moves anything but the accepted amount, or does not carry the difference of its line', async () => {
      const target = await scenario();
      const done = await approve(target);
      const balance = (await entriesOf(target.contract.contractId))[0] as { ledger_id: string; acceptance_id: string; boq_item_id: string };
      const insert = (kind: string, accepted: string, requested: string, line: string | null) =>
        owner(
          `insert into machvon.cumulative_ledger_entry (tenant_id, id, ledger_id, contract_id, boq_item_id, acceptance_id, entry_kind, accepted_delta_vnd, requested_delta_vnd, paid_delta_vnd, advance_recovery_delta_vnd, retention_delta_vnd,
                advance_outstanding_after_vnd, request_id, created_by, adjustment_line_id)
           values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7::numeric, $8::numeric, 0, 0, 0, 0, gen_random_uuid(), $9, $10::uuid)`,
          [TENANT_A, balance.ledger_id, target.contract.contractId, balance.boq_item_id, balance.acceptance_id, kind, accepted, requested, memberId(MAKER), line],
        );
      expect((await databaseRefusal(insert('ADJUSTMENT', '5', '0', null))).sqlstate).toBe('23514');
      expect((await databaseRefusal(insert('RECOGNIZE_ACCEPTANCE', '5', '0', done.balances[0]?.id as string))).sqlstate).toBe('23514');
      expect((await databaseRefusal(insert('ADJUSTMENT', '5', '1', done.balances[0]?.id as string))).sqlstate).toBe('23514');
      expect((await databaseRefusal(insert('ADJUSTMENT', '0', '0', done.balances[0]?.id as string))).sqlstate).toBe('23514');
      // Of the right shape but not the difference of its line: the balance and the line must agree.
      const unmatched = await databaseRefusal(insert('ADJUSTMENT', '5', '0', done.balances[0]?.id as string));
      expect(unmatched.sqlstate).toBe('23514');
      expect(unmatched.message).toMatch(/moves the balance its line is about/);
      // The right amount for the line, but the line already has its entry.
      expect((await databaseRefusal(insert('ADJUSTMENT', '50000000', '0', done.balances[0]?.id as string))).sqlstate).toBe('23505');
      // A forward entry that is not an adjustment still cannot take away.
      expect((await databaseRefusal(insert('CLAIM', '-5', '0', null))).sqlstate).toBe('23514');
    });

    it('refuses a header that counts wrongly, a line the header does not count, and a line about another contract or an acceptance that is not approved', async () => {
      const target = await scenario();
      const other = await scenario();
      const done = await approve(target);
      const header = await databaseRefusal(
        owner(
          `insert into machvon.retroactive_adjustment (tenant_id, id, contract_id, change_request_id, revision_id, effective_on, approved_on, basis, decision_document_version_id, line_count, acceptance_count, total_delta_vnd, created_by)
           values ($1, gen_random_uuid(), $2, $3, $4, date '2026-06-01', date '2026-08-01', 'x', $5, 0, 1, 0, $6)`,
          [TENANT_A, other.contract.contractId, other.co.id, done.revision.id, VERSION, memberId(MAKER)],
        ),
      );
      expect(header.sqlstate).toBe('23514');
      const line = (adjustmentId: string, contractId: string, acceptanceId: string, delta: string, item: string) =>
        owner(
          `insert into machvon.retroactive_adjustment_line (tenant_id, id, adjustment_id, contract_id, acceptance_id, boq_item_id, party_id, quantity, old_amount_vnd, new_unit_price, new_amount_vnd, delta_vnd, created_by)
           values ($1, gen_random_uuid(), $2, $3, $4, $5, null, 1, 100, 1, $6::numeric + 100, $6::numeric, $7)`,
          [TENANT_A, adjustmentId, contractId, acceptanceId, item, delta, memberId(MAKER)],
        );
      expect((await databaseRefusal(line(done.adjustmentId, other.contract.contractId, other.approved.acceptance.id, '5', other.contract.items[1]))).sqlstate).toBe('23514');
      expect((await databaseRefusal(line(done.adjustmentId, target.contract.contractId, other.approved.acceptance.id, '5', target.contract.items[1]))).sqlstate).toBe('23514');
      expect((await databaseRefusal(line(done.adjustmentId, target.contract.contractId, target.approved.acceptance.id, '0', target.contract.items[0]))).sqlstate).toBe('23514');
      // A well-formed line that the header does not count, and that has no entry, is refused when the transaction ends.
      const uncounted = await databaseRefusal(line(done.adjustmentId, target.contract.contractId, target.approved.acceptance.id, '5', target.contract.items[0]));
      expect(uncounted.sqlstate).toBe('23514');
      expect(uncounted.message).toMatch(/ADJUSTMENT_SUM_MISMATCH/);
      expect(await adjustmentRows(target.contract.contractId)).toBe('1');
    });

    it('refuses a record that reaches back to no day before its approval, one that is not the difference of its amounts, and a second record of the same change order or revision', async () => {
      const target = await scenario();
      const other = await scenario();
      const done = await approve(target);
      const header = (day: string, changeRequestId: string, revisionId: string) =>
        owner(
          `insert into machvon.retroactive_adjustment (tenant_id, id, contract_id, change_request_id, revision_id, effective_on, approved_on, basis, decision_document_version_id, line_count, acceptance_count, total_delta_vnd, created_by)
           values ($1, gen_random_uuid(), $2, $3, $4, $5::date, date '2026-08-10', 'x', $6, 0, 0, 0, $7)`,
          [TENANT_A, other.contract.contractId, changeRequestId, revisionId, day, VERSION, memberId(MAKER)],
        );
      // The day does not precede the approval: the check says so before anything else is looked at.
      expect((await databaseRefusal(header('2026-08-10', other.co.id, randomUUID()))).sqlstate).toBe('23514');
      expect((await databaseRefusal(header('2026-09-01', other.co.id, randomUUID()))).sqlstate).toBe('23514');
      // The change order of the first adjustment, and its revision, are taken.
      expect((await databaseRefusal(header('2026-06-01', target.co.id, randomUUID()))).sqlstate).toBe('23505');
      expect((await databaseRefusal(header('2026-06-01', other.co.id, done.revision.id))).sqlstate).toBe('23505');
      const wrongDelta = await databaseRefusal(
        owner(
          `insert into machvon.retroactive_adjustment_line (tenant_id, id, adjustment_id, contract_id, acceptance_id, boq_item_id, party_id, quantity, old_amount_vnd, new_unit_price, new_amount_vnd, delta_vnd, created_by)
           values ($1, gen_random_uuid(), $2, $3, $4, $5, null, 1, 100, 1, 150, 49, $6)`,
          [TENANT_A, done.adjustmentId, target.contract.contractId, target.approved.acceptance.id, target.contract.items[0], memberId(MAKER)],
        ),
      );
      expect(wrongDelta.sqlstate).toBe('23514');
      expect(wrongDelta.message).toMatch(/retroactive_adjustment_line_delta_chk/);
    });

    it('lets a balance that an earlier adjustment brought to nothing be adjusted again: the old amount of a line may be zero', async () => {
      const target = await scenario();
      const done = await approve(target);
      const zeroOld = owner(
        `insert into machvon.retroactive_adjustment_line (tenant_id, id, adjustment_id, contract_id, acceptance_id, boq_item_id, party_id, quantity, old_amount_vnd, new_unit_price, new_amount_vnd, delta_vnd, created_by)
         values ($1, gen_random_uuid(), $2, $3, $4, $5, null, 1, 0, 150, 150, 150, $6)`,
        [TENANT_A, done.adjustmentId, target.contract.contractId, target.approved.acceptance.id, target.contract.items[0], memberId(MAKER)],
      );
      // Whatever else refuses this row (the append-only guard), the amount check is not what does.
      expect((await databaseRefusal(zeroOld)).message).not.toMatch(/retroactive_adjustment_line_amount_chk/);
    });

    it('does not let an acceptance with an adjustment be withdrawn, by the command or by SQL', async () => {
      const target = await scenario();
      await approve(target);
      const revoke = as(
        (tx) => new CtrAcceptanceStore().revoke(tx, target.approved.acceptance.id, target.approved.acceptance.version, { reason: 'The measurements were found wrong.', approvalDocumentVersionId: VERSION }, memberId(5), contractScopes),
        5,
      );
      expect(await refusal(revoke)).toMatchObject({ code: 'ACCEPTANCE_STATE_INVALID', status: 409, extensions: { reason: 'RETROACTIVELY_ADJUSTED' } });
      const bypass = await databaseRefusal(owner("update machvon.acceptance set status = 'REVOKED' where id = $1::uuid", [target.approved.acceptance.id]));
      expect(bypass.message).toMatch(/ACCEPTANCE_ADJUSTED|revoke|guard|withdraw|may move|moves|kept/i);
      expect(bypass.sqlstate).toBe('23514');
    });
  });
});

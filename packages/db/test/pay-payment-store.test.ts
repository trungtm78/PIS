import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PayPaymentStore } from '../src/pay-payment-store';
import type { CreatePaymentInput, PaymentResult } from '../src/pay-payment-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';
import { AcceptanceWorld } from './support/acceptance-fixtures';
import type { ApprovedAcceptance, SeededContract } from './support/acceptance-fixtures';

const fixtures = new AcceptanceWorld();
const payments = new PayPaymentStore();
const ACCOUNTANT = 1;
const OTHER = 2;
const TODAY = '2026-07-25';
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const readOnly: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const invisible: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) };
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = ACCOUNTANT): Promise<T> => fixtures.as(work, member);
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

async function databaseRefusal(work: Promise<unknown>): Promise<{ message: string; sqlstate: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { message: string; code?: string };
    return { message: e.message, sqlstate: e.code ?? '' };
  }
  throw new Error('expected the database to refuse');
}

const requestNo = (): string => `DNTT-${String((counter += 1)).padStart(4, '0')}`;

/** A contract whose sole party's work is worth `value`, with an approved acceptance of 2,000 m3 of B01 (2bn) and 500 m3 of B02 (1bn): a gross of 3bn, a retention of 5 percent. */
async function approvedThreeBillion(value = '10000000000'): Promise<ApprovedAcceptance> {
  const contract = await fixtures.seedContract();
  await owner('update machvon.contract_party set work_value_vnd = $2::numeric where contract_id = $1::uuid', [contract.contractId, value]);
  return fixtures.approve(contract, [
    { item: 0, quantity: '2000' },
    { item: 1, quantity: '500' },
  ]);
}

/** An advance of the party that is paid, with the threshold given and some of it recovered already. */
async function paidAdvance(contract: SeededContract, paid: string, thresholdPct = '80', recovered = '0', trancheNo = 1): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.contract_advance
       (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, recovered_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
     values ($1, $2, $3, $4, $5, 'GPMB', $6::numeric, $6::numeric, 'PAID', $6::numeric, $7::numeric, date '2026-06-01', $8::numeric, date '2026-12-31', $9, $9)`,
    [TENANT_A, id, contract.contractId, contract.partyId, trancheNo, paid, recovered, thresholdPct, memberId(ACCOUNTANT)],
  );
  return id;
}

const input = (approved: ApprovedAcceptance, overrides: Partial<CreatePaymentInput> = {}): CreatePaymentInput => ({
  contractId: approved.contract.contractId,
  requestKind: 'INTERIM',
  acceptanceId: approved.acceptance.id,
  allocationLineId: fixtures.lineId,
  requestNo: requestNo(),
  ...overrides,
});
const create = (approved: ApprovedAcceptance, overrides: Partial<CreatePaymentInput> = {}, scopes: ContractScopes = everything, today = TODAY, member = ACCOUNTANT): Promise<PaymentResult> =>
  as((tx) => payments.create(tx, input(approved, overrides), memberId(member), scopes, today), member);
const stored = async (id: string) =>
  (
    await owner<{ status: string; version: string; gross_vnd: string; advance_recovery_vnd: string; retention_vnd: string; tax_adjustment_vnd: string; net_vnd: string; plan_year: number | null; request_no: string | null; claims_acceptance: boolean }>(
      'select status, version::text, gross_vnd::text, advance_recovery_vnd::text, retention_vnd::text, tax_adjustment_vnd::text, net_vnd::text, plan_year, request_no, claims_acceptance from machvon.payment_request where id = $1::uuid',
      [id],
    )
  )[0];
const linesOf = (id: string) =>
  owner<{ boq_item_id: string; gross_vnd: string; advance_recovery_vnd: string; retention_vnd: string; net_vnd: string; party_id: string | null }>(
    'select boq_item_id, gross_vnd::text, advance_recovery_vnd::text, retention_vnd::text, net_vnd::text, party_id from machvon.payment_request_line where payment_request_id = $1::uuid order by gross_vnd desc',
    [id],
  );

describe('the draft of a payment request (ST-PAY-002)', () => {
  beforeAll(async () => {
    await fixtures.start();
  }, 240_000);

  afterAll(async () => {
    await fixtures.stop();
  }, 60_000);

  describe('the money the server computes', () => {
    it('AC-ST-PAY-002-1, UAT-AC323: gross 3bn, recovery floor(2bn x 3/8) = 750m, retention 150m, net 2.1bn, and the lines B01 and B02', async () => {
      const approved = await approvedThreeBillion();
      await paidAdvance(approved.contract, '2000000000');
      const made = await create(approved);
      expect(made).toMatchObject({ status: 'DRAFT', version: 1, grossVnd: '3000000000', advanceRecoveryVnd: '750000000', retentionVnd: '150000000', taxAdjustmentVnd: '0', netVnd: '2100000000', lineCount: 2 });
      expect(await stored(made.id)).toMatchObject({ status: 'DRAFT', claims_acceptance: false, plan_year: expect.any(Number) });
      const lines = await linesOf(made.id);
      expect(lines).toEqual([
        { boq_item_id: approved.contract.items[0], gross_vnd: '2000000000', advance_recovery_vnd: '500000000', retention_vnd: '100000000', net_vnd: '1400000000', party_id: null },
        { boq_item_id: approved.contract.items[1], gross_vnd: '1000000000', advance_recovery_vnd: '250000000', retention_vnd: '50000000', net_vnd: '700000000', party_id: null },
      ]);
      // A draft takes no claim on the acceptance: another draft of it can be made, and says so.
      const another = await create(approved);
      expect(another.warnings).toEqual([{ code: 'OTHER_DRAFTS_FOR_ACCEPTANCE', detail: { payment_request_ids: [made.id] } }]);
    });

    it('a tax adjustment moves the net of the header and needs its basis; a request without an advance recovers nothing', async () => {
      const approved = await approvedThreeBillion();
      const plain = await create(approved);
      expect(plain).toMatchObject({ advanceRecoveryVnd: '0', retentionVnd: '150000000', netVnd: '2850000000' });
      const taxed = await create(approved, { taxAdjustmentVnd: '-1000000', taxAdjustmentBasis: 'Thông báo thuế số 12/TB' });
      expect(taxed).toMatchObject({ taxAdjustmentVnd: '-1000000', netVnd: '2849000000' });
      expect(await stored(taxed.id)).toMatchObject({ tax_adjustment_vnd: '-1000000', net_vnd: '2849000000' });
      expect(await refusal(create(approved, { taxAdjustmentVnd: '5' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'tax_adjustment_basis' });
      expect(await refusal(create(approved, { taxAdjustmentVnd: '1.5', taxAdjustmentBasis: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'tax_adjustment_vnd' });
      // A basis without an adjustment is not kept.
      const none = await create(approved, { taxAdjustmentVnd: '0', taxAdjustmentBasis: 'unused' });
      expect(none.taxAdjustmentVnd).toBe('0');
      expect((await owner<{ tax_adjustment_basis: string | null }>('select tax_adjustment_basis from machvon.payment_request where id = $1::uuid', [none.id]))[0]?.tax_adjustment_basis).toBeNull();
    });

    it('AC-ST-PAY-002-2, UAT-AC324: a recovery of 100 (then 101) is shared 33/67 (34/67) over lines of gross 1:2, repeatably', async () => {
      const shares = async (recovery: string): Promise<string[]> => {
        const contract = await fixtures.seedContract();
        await owner('update machvon.contract_party set work_value_vnd = 3000000000 where contract_id = $1::uuid', [contract.contractId]);
        const approved = await fixtures.approve(contract, [
          { item: 0, quantity: '1000' },
          { item: 1, quantity: '1000' },
        ]);
        await paidAdvance(contract, recovery, '100');
        const made = await create(approved);
        expect(made.advanceRecoveryVnd).toBe(recovery);
        return (await linesOf(made.id)).sort((a, b) => (a.boq_item_id === contract.items[0] ? -1 : b.boq_item_id === contract.items[0] ? 1 : 0)).map((line) => line.advance_recovery_vnd);
      };
      expect(await shares('100')).toEqual(['33', '67']);
      expect(await shares('101')).toEqual(['34', '67']);
      expect(await shares('101')).toEqual(['34', '67']);
    });

    it('takes what earlier requests did not: the gross asked for before counts toward the threshold, and what is already recovered is not recovered twice', async () => {
      const approved = await approvedThreeBillion();
      await paidAdvance(approved.contract, '2000000000', '80', '750000000');
      // Gross to date is 3bn (this request) + 3bn (asked before, in the ledger of another item): the target is floor(2bn x 6/8) = 1.5bn, of which 750m is recovered already.
      await as(async (tx) => {
        const ledgerId = randomUUID();
        await tx.query(
          `insert into machvon.cumulative_ledger (tenant_id, id, contract_id, boq_item_id, acceptance_id, accepted_vnd, requested_vnd, created_by, updated_by)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, 3000000000, 3000000000, $5, $5)`,
          [ledgerId, approved.contract.contractId, approved.contract.items[2], approved.acceptance.id, memberId(ACCOUNTANT)],
        );
        for (const [kind, accepted, requested] of [
          ['RECOGNIZE_ACCEPTANCE', '3000000000', '0'],
          ['CLAIM', '0', '3000000000'],
        ] as const) {
          await tx.query(
            `insert into machvon.cumulative_ledger_entry (tenant_id, id, ledger_id, contract_id, boq_item_id, acceptance_id, entry_kind, accepted_delta_vnd, requested_delta_vnd, advance_outstanding_after_vnd, request_id, created_by)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4, $5, $6::numeric, $7::numeric, 0, gen_random_uuid(), $8)`,
            [ledgerId, approved.contract.contractId, approved.contract.items[2], approved.acceptance.id, kind, accepted, requested, memberId(ACCOUNTANT)],
          );
        }
      });
      const later = await create(approved);
      expect(later).toMatchObject({ advanceRecoveryVnd: '750000000', grossVnd: '3000000000' });
      // With the 1.5bn already recovered, the target of this request is met and nothing more is taken.
      const met = await approvedThreeBillion();
      await paidAdvance(met.contract, '2000000000', '80', '750000000');
      await owner('update machvon.contract_advance set recovered_vnd = 1500000000 where contract_id = $1::uuid', [met.contract.contractId]);
      expect((await create(met)).advanceRecoveryVnd).toBe('0');
    });

    it('recovers extra on top of the formula within the room that is left, and refuses more', async () => {
      const approved = await approvedThreeBillion();
      await paidAdvance(approved.contract, '2000000000');
      const made = await create(approved, { advanceRecoveryExtraVnd: '100000000' });
      expect(made).toMatchObject({ advanceRecoveryVnd: '850000000', netVnd: '2000000000' });
      expect(await stored(made.id)).toBeDefined();
      expect(await refusal(create(approved, { advanceRecoveryExtraVnd: '1250000001' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'advance_recovery_extra_vnd', extensions: { reason: 'EXTRA_EXCEEDS_OUTSTANDING' } });
    });
  });

  describe('the guards before the money', () => {
    it('refuses what the contract in its state does not take (BR-PAY-09)', async () => {
      const approved = await approvedThreeBillion();
      const paper = (await fixtures.documentVersion()).id;
      await owner('update machvon.contract set status = $2::text, status_reason = $3, status_decision_document_version_id = $4::uuid, suspended_from = $5::date where id = $1::uuid', [
        approved.contract.contractId,
        'SUSPENDED',
        'Stopped.',
        paper,
        '2026-12-31',
      ]);
      // Approved today, before the suspension: an interim request is taken; an advance is not.
      expect(await create(approved)).toMatchObject({ status: 'DRAFT' });
      expect(await refusal(create(approved, { requestKind: 'ADVANCE', acceptanceId: undefined, advanceId: randomUUID() }))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', extensions: { reason: 'KIND_NOT_ALLOWED_WHILE_SUSPENDED' } });
      await owner('update machvon.contract set suspended_from = $2::date where id = $1::uuid', [approved.contract.contractId, '2026-01-01']);
      expect(await refusal(create(approved))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { contract_status: 'SUSPENDED', reason: 'ACCEPTED_AFTER_SUSPENSION' } });
    });

    it('refuses an acceptance that is not approved, not of the contract, or already claimed, and a number already used in the contract', async () => {
      const approved = await approvedThreeBillion();
      const draft = await fixtures.draft(approved.contract, [{ item: 2, quantity: '4' }]);
      expect(await refusal(create(approved, { acceptanceId: draft.id }))).toMatchObject({ code: 'ACCEPTANCE_NOT_APPROVED', status: 422, extensions: { acceptance_status: 'DRAFT' } });
      const other = await approvedThreeBillion();
      expect(await refusal(create(approved, { acceptanceId: other.acceptance.id }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'acceptance_id' });
      expect(await refusal(create(approved, { acceptanceId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'acceptance_id' });
      const made = await create(approved, { requestNo: 'DNTT-SAME' });
      expect(await refusal(create(approved, { requestNo: 'DNTT-SAME' }))).toMatchObject({ code: 'PAYMENT_REFERENCE_DUPLICATE', status: 409, extensions: { payment_request_id: made.id } });
      // The same number in another contract is another reference.
      expect((await create(other, { requestNo: 'DNTT-SAME' })).status).toBe('DRAFT');
      // A request that holds the claim stops a new one.
      await owner(`update machvon.payment_request set status = 'SUBMITTED', claims_acceptance = true, submitted_by = created_by, submitted_at = now() where id = $1::uuid`, [made.id]);
      expect(await refusal(create(approved))).toMatchObject({ code: 'ACCEPTANCE_ALREADY_CLAIMED', status: 409, extensions: { payment_request_id: made.id } });
    });

    it('UAT-AC342: the line of capital is of the project, in force, of a year the acceptance can be paid from and still open (BR-PAY-14)', async () => {
      const approved = await approvedThreeBillion();
      expect(await refusal(create(approved, { allocationLineId: randomUUID() }))).toMatchObject({ code: 'ALLOCATION_UNAVAILABLE', extensions: { reason: 'NOT_FOUND' } });
      const foreign = await fixtures.world.publishedLine();
      expect(await refusal(create(approved, { allocationLineId: foreign.lineId }))).toMatchObject({ code: 'ALLOCATION_UNAVAILABLE', extensions: { reason: 'OTHER_PROJECT' } });
      // A line of an earlier year than the acceptance (drawn up on 25 July 2026).
      const earlier = await fixtures.world.publishedLine({ year: 2025 });
      const contract = await fixtures.seedContract({ projectId: earlier.projectId, lineId: earlier.lineId });
      const old = await fixtures.approve(contract, [{ item: 0, quantity: '10' }]);
      expect(await refusal(create(old, { allocationLineId: earlier.lineId }))).toMatchObject({ code: 'PLAN_YEAR_MISMATCH', status: 422, extensions: { reason: 'BEFORE_ACCEPTANCE', plan_year: 2025, acceptance_year: 2026 } });
      // A line of 2026 is open until the end of the year, and later only with an extension.
      const current = await fixtures.world.publishedLine({ year: 2026 });
      const next = await fixtures.seedContract({ projectId: current.projectId, lineId: current.lineId });
      const fresh = await fixtures.approve(next, [{ item: 0, quantity: '10' }]);
      expect(await create(fresh, { allocationLineId: current.lineId })).toMatchObject({ status: 'DRAFT', planYear: 2026 });
      expect(await refusal(create(fresh, { allocationLineId: current.lineId }, everything, '2027-02-01'))).toMatchObject({ code: 'PLAN_YEAR_MISMATCH', extensions: { reason: 'DISBURSEMENT_CLOSED', open_until: '2026-12-31' } });
      const decision = await fixtures.world.document();
      // The extension is CAP's to grant; here the table is written the way its command leaves it, past the guard that keeps the appropriation as it was published.
      const admin = new Client({ connectionString: fixtures.harness.database.adminUrl });
      await admin.connect();
      try {
        await admin.query('set session_replication_role = replica');
        await admin.query('update machvon.appropriation set is_extended = true, extended_to = $2::date, extension_document_id = $3::uuid where id = $1::uuid', [current.appropriationId, '2027-03-31', decision]);
      } finally {
        await admin.end();
      }
      expect(await create(fresh, { allocationLineId: current.lineId }, everything, '2027-02-01')).toMatchObject({ status: 'DRAFT', planYear: 2026 });
    });

    it('AC-ST-PAY-002-5, UAT-PLAN-19: a project without a national code is refused where the rule of the day requires it, and the word of the rule decides', async () => {
      const approved = await approvedThreeBillion();
      const [original] = await owner<{ code: string }>('select national_project_code as code from machvon.project where id = $1::uuid', [fixtures.projectId]);
      await owner('update machvon.project set national_project_code = null where id = $1::uuid', [fixtures.projectId]);
      try {
        const refused = await refusal(create(approved));
        expect(refused).toMatchObject({ code: 'NATIONAL_CODE_REQUIRED', status: 422, detail: 'national_project_code' });
        expect(await owner('select 1 from machvon.payment_request where contract_id = $1::uuid', [approved.contract.contractId])).toEqual([]);
      } finally {
        await owner('update machvon.project set national_project_code = $2 where id = $1::uuid', [fixtures.projectId, original?.code ?? null]);
      }
    });

    it('draws an advance from a planned one (gross is its amount, nothing to recover or hold) and refuses one that is not of the contract or not planned', async () => {
      const contract = await fixtures.seedContract();
      const planned = randomUUID();
      await owner(
        `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, created_by, updated_by)
         values ($1, $2, $3, $4, 1, 'GPMB', 500000000, 500000000, 'PLANNED', $5, $5)`,
        [TENANT_A, planned, contract.contractId, contract.partyId, memberId(ACCOUNTANT)],
      );
      const made = await as((tx) =>
        payments.create(tx, { contractId: contract.contractId, requestKind: 'ADVANCE', advanceId: planned, allocationLineId: fixtures.lineId, requestNo: requestNo(), taxAdjustmentVnd: '-100', taxAdjustmentBasis: 'Phí' }, memberId(ACCOUNTANT), everything, TODAY),
      );
      expect(made).toMatchObject({ status: 'DRAFT', grossVnd: '500000000', advanceRecoveryVnd: '0', retentionVnd: '0', netVnd: '499999900', lineCount: 0, acceptanceId: null });
      const other = await fixtures.seedContract();
      const ask = (contractId: string, advanceId: string) => as((tx) => payments.create(tx, { contractId, requestKind: 'ADVANCE', advanceId, allocationLineId: fixtures.lineId, requestNo: requestNo() }, memberId(ACCOUNTANT), everything, TODAY));
      expect(await refusal(ask(other.contractId, planned))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'advance_id' });
      await owner("update machvon.contract_advance set status = 'REQUESTED' where id = $1::uuid", [planned]);
      expect(await refusal(ask(contract.contractId, planned))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', extensions: { advance_status: 'REQUESTED' } });
      // The kind decides what must be named.
      expect(await refusal(as((tx) => payments.create(tx, { contractId: contract.contractId, requestKind: 'ADVANCE', allocationLineId: fixtures.lineId, requestNo: requestNo() }, memberId(ACCOUNTANT), everything, TODAY)))).toMatchObject({ detail: 'advance_id' });
      expect(await refusal(as((tx) => payments.create(tx, { contractId: contract.contractId, requestKind: 'FINAL', acceptanceId: randomUUID(), allocationLineId: fixtures.lineId, requestNo: requestNo() }, memberId(ACCOUNTANT), everything, TODAY)))).toMatchObject({ detail: 'settlement_revision_id' });
      expect(await refusal(as((tx) => payments.create(tx, { contractId: contract.contractId, requestKind: 'NOPE', allocationLineId: fixtures.lineId, requestNo: requestNo() }, memberId(ACCOUNTANT), everything, TODAY)))).toMatchObject({ detail: 'request_kind' });
    });

    it('a final request names a settlement of its contract', async () => {
      const approved = await approvedThreeBillion();
      await owner("update machvon.contract set status = 'COMPLETED' where id = $1::uuid", [approved.contract.contractId]).catch(() => undefined);
      const settlement = randomUUID();
      await owner('insert into machvon.settlement_revision (tenant_id, id, project_id, contract_id, revision, settled_amount_vnd, outstanding_vnd, unrecovered_advance_vnd, audit_finding_refs, status) values ($1, $2, $3, $4, 1, 0, 0, 0, \'[]\'::jsonb, \'DRAFT\')', [
        TENANT_A,
        settlement,
        fixtures.projectId,
        approved.contract.contractId,
      ]);
      const other = await approvedThreeBillion();
      expect(await refusal(create(other, { requestKind: 'FINAL', settlementRevisionId: settlement }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'settlement_revision_id' });
      expect(await refusal(create(approved, { requestKind: 'FINAL', settlementRevisionId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'settlement_revision_id' });
    });
  });

  describe('revising and cancelling', () => {
    it('revises what the client decides and computes the money again, once, with the version moving', async () => {
      const approved = await approvedThreeBillion();
      await paidAdvance(approved.contract, '2000000000');
      const made = await create(approved);
      const revised = await as((tx) => payments.revise(tx, made.id, 1, { taxAdjustmentVnd: '-3000', taxAdjustmentBasis: 'Điều chỉnh', advanceRecoveryExtraVnd: '10', requestNo: 'DNTT-REVISED' }, memberId(ACCOUNTANT), everything, TODAY));
      expect(revised).toMatchObject({ status: 'DRAFT', fromStatus: 'DRAFT', version: 2, requestNo: 'DNTT-REVISED', advanceRecoveryVnd: '750000010', taxAdjustmentVnd: '-3000', netVnd: String(3000000000 - 750000010 - 150000000 - 3000) });
      expect(await linesOf(made.id)).toHaveLength(2);
      // A stale version is a conflict; an empty change keeps the figures.
      expect(await refusal(as((tx) => payments.revise(tx, made.id, 1, {}, memberId(ACCOUNTANT), everything, TODAY)))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      const same = await as((tx) => payments.revise(tx, made.id, 2, {}, memberId(ACCOUNTANT), everything, TODAY));
      expect(same).toMatchObject({ version: 3, taxAdjustmentVnd: '-3000', requestNo: 'DNTT-REVISED' });
      // The number of another request of the contract is refused, one's own is not.
      const second = await create(approved);
      expect(await refusal(as((tx) => payments.revise(tx, second.id, 1, { requestNo: 'DNTT-REVISED' }, memberId(ACCOUNTANT), everything, TODAY)))).toMatchObject({ code: 'PAYMENT_REFERENCE_DUPLICATE' });
      expect((await as((tx) => payments.revise(tx, made.id, 3, { requestNo: 'DNTT-REVISED' }, memberId(ACCOUNTANT), everything, TODAY))).version).toBe(4);
      // The tax adjustment can be taken back, and its basis goes with it.
      const clear = await as((tx) => payments.revise(tx, made.id, 4, { taxAdjustmentVnd: '0' }, memberId(ACCOUNTANT), everything, TODAY));
      expect(clear).toMatchObject({ taxAdjustmentVnd: '0' });
    });

    it('opens a returned request again as a draft, and refuses to revise or cancel one that was sent or is over', async () => {
      const approved = await approvedThreeBillion();
      const made = await create(approved);
      await owner(`update machvon.payment_request set status = 'SUBMITTED', claims_acceptance = true, submitted_by = created_by, submitted_at = now() where id = $1::uuid`, [made.id]);
      expect(await refusal(as((tx) => payments.revise(tx, made.id, 1, {}, memberId(ACCOUNTANT), everything, TODAY)))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409 });
      expect(await refusal(as((tx) => payments.cancel(tx, made.id, 1, 'Wrong', memberId(ACCOUNTANT), everything)))).toMatchObject({ code: 'PAYMENT_STATE_INVALID' });
      await owner(`update machvon.payment_request set status = 'RETURNED', claims_acceptance = false, return_reason = 'Fix the invoice.', returned_by = created_by, returned_at = now() where id = $1::uuid`, [made.id]);
      const reopened = await as((tx) => payments.revise(tx, made.id, 1, { taxAdjustmentVnd: '7', taxAdjustmentBasis: 'Làm tròn' }, memberId(ACCOUNTANT), everything, TODAY));
      expect(reopened).toMatchObject({ status: 'DRAFT', fromStatus: 'RETURNED', version: 2 });
      const cancelled = await as((tx) => payments.cancel(tx, made.id, 2, '  Duplicate request.  ', memberId(ACCOUNTANT), everything));
      expect(cancelled).toMatchObject({ status: 'CANCELLED', fromStatus: 'DRAFT', version: 3 });
      expect((await owner<{ cancel_reason: string }>('select cancel_reason from machvon.payment_request where id = $1::uuid', [made.id]))[0]?.cancel_reason).toBe('Duplicate request.');
      expect(await refusal(as((tx) => payments.revise(tx, made.id, 3, {}, memberId(ACCOUNTANT), everything, TODAY)))).toMatchObject({ code: 'PAYMENT_STATE_INVALID' });
      expect(await refusal(as((tx) => payments.cancel(tx, made.id, 3, ' ', memberId(ACCOUNTANT), everything)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      // A request that holds a claim (it was sent and has not been returned) is not cancelled, even in a state the guards of the status would let through.
      const held = await create(approved);
      await owner(`update machvon.payment_request set claims_acceptance = false where id = $1::uuid`, [held.id]);
      expect(await stored(held.id)).toMatchObject({ status: 'DRAFT' });
    });

    it('answers 404 for a request outside the scope and 403 for one the caller reads and may not change', async () => {
      const approved = await approvedThreeBillion();
      const made = await create(approved);
      const ghost = randomUUID();
      expect(await refusal(as((tx) => payments.revise(tx, ghost, 1, {}, memberId(ACCOUNTANT), everything, TODAY)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => payments.revise(tx, made.id, 1, {}, memberId(ACCOUNTANT), invisible, TODAY)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => payments.revise(tx, made.id, 1, {}, memberId(ACCOUNTANT), readOnly, TODAY)))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(as((tx) => payments.cancel(tx, made.id, 1, 'x', memberId(ACCOUNTANT), readOnly)))).toMatchObject({ code: 'SCOPE_DENIED' });
      expect(await refusal(create(approved, {}, readOnly))).toMatchObject({ code: 'SCOPE_DENIED' });
      expect(await refusal(create(approved, {}, invisible))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('serialises thirty requests for one number at once: exactly one is drawn up, the others are 409 PAYMENT_REFERENCE_DUPLICATE', async () => {
      const approved = await approvedThreeBillion();
      const outcomes = await Promise.allSettled(Array.from({ length: 30 }, () => create(approved, { requestNo: 'DNTT-RACE' })));
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const failed = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      expect(failed.map((outcome) => (outcome.reason as { code: string }).code)).toEqual(Array(29).fill('PAYMENT_REFERENCE_DUPLICATE'));
      expect(await owner('select 1 from machvon.payment_request where contract_id = $1::uuid', [approved.contract.contractId])).toHaveLength(1);
    });
  });

  describe('the documents', () => {
    const attach = (id: string, overrides: Record<string, unknown>, options: { member?: number; mayOverride?: boolean; scopes?: ContractScopes } = {}) =>
      as(
        (tx) => payments.attachDocument(tx, id, overrides as never, memberId(options.member ?? ACCOUNTANT), options.scopes ?? everything, { mayOverride: () => options.mayOverride ?? false }),
        options.member ?? ACCOUNTANT,
      );
    const invoice = async (overrides: Record<string, unknown> = {}) => ({ documentVersionId: (await fixtures.documentVersion()).id, docKind: 'INVOICE', invoiceNo: 'HD-0001234', invoiceDate: '2026-07-01', ...overrides });

    it('AC-ST-PAY-002-4, UAT-AC60: an invoice number used in the contract is blocked, let through with a reason by an approver who did not draft it, and only a warning in another contract', async () => {
      const approved = await approvedThreeBillion();
      const first = await create(approved);
      const second = await create(approved);
      const number = `HD-${randomUUID().slice(0, 8)}`;
      expect(await attach(first.id, await invoice({ invoiceNo: number }))).toMatchObject({ status: 'DRAFT', warnings: [] });
      const duplicate = await invoice({ invoiceNo: number });
      expect(await refusal(attach(second.id, duplicate))).toMatchObject({ code: 'INVOICE_DUPLICATE', status: 409, extensions: { payment_request_id: first.id } });
      // The override needs the right to it, a reason, and a person other than the one who drafted the request.
      const reason = { ...duplicate, duplicateOverrideReason: 'Hóa đơn điều chỉnh theo thông báo 12/TB' };
      expect(await refusal(attach(second.id, reason, { member: OTHER, mayOverride: false }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(attach(second.id, reason, { member: ACCOUNTANT, mayOverride: true }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await attach(second.id, reason, { member: OTHER, mayOverride: true })).toMatchObject({ status: 'DRAFT' });
      const kept = await owner<{ duplicate_override_reason: string; duplicate_override_by: string; invoice_no: string }>(
        'select duplicate_override_reason, duplicate_override_by, invoice_no from machvon.payment_document where payment_request_id = $1::uuid',
        [second.id],
      );
      expect(kept).toEqual([{ duplicate_override_reason: 'Hóa đơn điều chỉnh theo thông báo 12/TB', duplicate_override_by: memberId(OTHER), invoice_no: number }]);
      // A reason for something that is not a duplicate is refused; the same number in another contract is a warning.
      expect(await refusal(attach(first.id, await invoice({ invoiceNo: `${number}-NEW`, duplicateOverrideReason: 'x' }), { member: OTHER, mayOverride: true }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'duplicate_override_reason', extensions: { reason: 'NO_DUPLICATE' } });
      const elsewhere = await approvedThreeBillion();
      const third = await create(elsewhere);
      const warned = await attach(third.id, await invoice({ invoiceNo: number }));
      expect(warned.warnings).toEqual([{ code: 'DUPLICATE_INVOICE_OTHER_CONTRACT', detail: { invoice_no: number, contract_ids: [approved.contract.contractId] } }]);
    });

    it('takes a clean version of a file only, once, with the checksum of the file, and an invoice names its number and date', async () => {
      const approved = await approvedThreeBillion();
      const made = await create(approved);
      const dirty = await fixtures.documentVersion('PENDING');
      expect(await refusal(attach(made.id, { documentVersionId: dirty.id, docKind: 'OTHER' }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN', status: 422 });
      expect(await refusal(attach(made.id, { documentVersionId: randomUUID(), docKind: 'OTHER' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'document_version_id', extensions: { reason: 'NOT_FOUND' } });
      const clean = await fixtures.documentVersion();
      expect(await attach(made.id, { documentVersionId: clean.id, docKind: 'ACCEPTANCE_MINUTES', signed: true })).toMatchObject({ status: 'DRAFT' });
      expect((await owner<{ checksum: string; signed: boolean; doc_kind: string }>('select checksum, signed, doc_kind from machvon.payment_document where payment_request_id = $1::uuid', [made.id]))[0]).toEqual({ checksum: clean.checksum, signed: true, doc_kind: 'ACCEPTANCE_MINUTES' });
      expect(await refusal(attach(made.id, { documentVersionId: clean.id, docKind: 'OTHER' }))).toMatchObject({ code: 'VALIDATION_FAILED', extensions: { reason: 'ALREADY_ATTACHED' } });
      expect(await refusal(attach(made.id, { documentVersionId: (await fixtures.documentVersion()).id, docKind: 'INVOICE' }))).toMatchObject({ detail: 'invoice_no' });
      expect(await refusal(attach(made.id, { documentVersionId: (await fixtures.documentVersion()).id, docKind: 'INVOICE', invoiceNo: 'HD-1' }))).toMatchObject({ detail: 'invoice_date' });
      expect(await refusal(attach(made.id, { documentVersionId: (await fixtures.documentVersion()).id, docKind: 'OTHER', invoiceNo: 'HD-1' }))).toMatchObject({ detail: 'doc_kind', extensions: { reason: 'NOT_AN_INVOICE' } });
      expect(await refusal(attach(made.id, { documentVersionId: (await fixtures.documentVersion()).id, docKind: 'PHOTO' }))).toMatchObject({ detail: 'doc_kind' });
      expect(await refusal(attach(made.id, { documentVersionId: 'x', docKind: 'OTHER' }))).toMatchObject({ detail: 'document_version_id' });
      expect(await refusal(attach(randomUUID(), { documentVersionId: clean.id, docKind: 'OTHER' }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(await refusal(attach(made.id, await invoice({ invoiceNo: 'HD-9' }), { scopes: readOnly }))).toMatchObject({ code: 'SCOPE_DENIED' });
    });

    it('refuses a document for a request that was sent', async () => {
      const approved = await approvedThreeBillion();
      const made = await create(approved);
      await owner(`update machvon.payment_request set status = 'SUBMITTED', claims_acceptance = true, submitted_by = created_by, submitted_at = now() where id = $1::uuid`, [made.id]);
      expect(await refusal(attach(made.id, { documentVersionId: (await fixtures.documentVersion()).id, docKind: 'OTHER' }))).toMatchObject({ code: 'PAYMENT_STATE_INVALID' });
    });
  });

  describe('the rules the database keeps when the application is bypassed', () => {
    it('AC-ST-PAY-002-3, UAT-AC64: a header or a line whose net does not add up, a sent request whose amounts change and lines that are not the acceptance are refused', async () => {
      const approved = await approvedThreeBillion();
      const made = await create(approved);
      const [line] = await linesOf(made.id);
      expect((await databaseRefusal(owner('update machvon.payment_request set net_vnd = net_vnd + 1 where id = $1::uuid', [made.id]))).message).toContain('payment_request_net_chk');
      expect((await databaseRefusal(owner('update machvon.payment_request_line set net_vnd = net_vnd + 1 where payment_request_id = $1::uuid and boq_item_id = $2::uuid', [made.id, line!.boq_item_id]))).message).toContain('payment_request_line_net_chk');
      // The two agree line by line and still do not add up to the header at the commit.
      expect(
        (
          await databaseRefusal(
            owner(
              'update machvon.payment_request set gross_vnd = gross_vnd + 1, net_vnd = net_vnd + 1 where id = $1::uuid',
              [made.id],
            ),
          )
        ).message,
      ).toContain('PAYMENT_NET_MISMATCH');
      expect((await databaseRefusal(owner('update machvon.payment_request_line set gross_vnd = gross_vnd + 1, net_vnd = net_vnd + 1 where payment_request_id = $1::uuid and boq_item_id = $2::uuid', [made.id, line!.boq_item_id]))).message).toContain('line of its acceptance');
      expect((await databaseRefusal(owner('delete from machvon.payment_request_line where payment_request_id = $1::uuid and boq_item_id = $2::uuid', [made.id, line!.boq_item_id]))).message).toContain('PAYMENT_NET_MISMATCH');
      expect(await stored(made.id)).toMatchObject({ gross_vnd: '3000000000', net_vnd: '2850000000' });
      // Once sent, the amounts, the number and the capital line are fixed, and the status moves along the edges only.
      await owner(`update machvon.payment_request set status = 'SUBMITTED', claims_acceptance = true, submitted_by = created_by, submitted_at = now() where id = $1::uuid`, [made.id]);
      expect((await databaseRefusal(owner('update machvon.payment_request set tax_adjustment_vnd = 1, tax_adjustment_basis = $2, net_vnd = net_vnd + 1 where id = $1::uuid', [made.id, 'x']))).message).toContain('PAYMENT_STATE_INVALID');
      expect((await databaseRefusal(owner("update machvon.payment_request set status = 'SETTLED' where id = $1::uuid", [made.id]))).message).toContain('PAYMENT_STATE_INVALID');
      expect((await databaseRefusal(owner('delete from machvon.payment_request_line where payment_request_id = $1::uuid', [made.id]))).message).toContain('PAYMENT_STATE_INVALID');
      expect((await databaseRefusal(owner("update machvon.payment_request set contract_id = gen_random_uuid() where id = $1::uuid", [made.id]))).message).toContain('never changes');
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.payment_request where id = $1::uuid', [made.id])))).sqlstate).toBe('42501');
    });

    it('a request is drawn only from an approved acceptance of its contract, for the project of the contract; a cancelled request is kept as it is', async () => {
      const approved = await approvedThreeBillion();
      const draft = await fixtures.draft(approved.contract, [{ item: 2, quantity: '3' }]);
      const insert = (acceptanceId: string, projectId: string) =>
        owner(
          `insert into machvon.payment_request (tenant_id, id, project_id, contract_id, acceptance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version, request_kind, request_no)
           values ($1, gen_random_uuid(), $2, $3, $4, 'VND', 0, 0, 0, 0, 0, 'SUBMITTED', 1, 'INTERIM', $5)`,
          [TENANT_A, projectId, approved.contract.contractId, acceptanceId, requestNo()],
        );
      expect((await databaseRefusal(insert(draft.id, fixtures.projectId))).message).toContain('ACCEPTANCE_NOT_APPROVED');
      expect((await databaseRefusal(insert(approved.acceptance.id, randomUUID()))).message).toContain('for the project of its contract');
      const made = await create(approved);
      await as((tx) => payments.cancel(tx, made.id, 1, 'Wrong', memberId(ACCOUNTANT), everything));
      expect((await databaseRefusal(owner("update machvon.payment_request set status = 'DRAFT' where id = $1::uuid", [made.id]))).message).toContain('PAYMENT_STATE_INVALID');
      const open = await create(approved);
      expect((await databaseRefusal(owner("update machvon.payment_request set status = 'CANCELLED' where id = $1::uuid", [open.id]))).message).toContain('payment_request_cancel_chk');
    });

    it('says what the database refused in the words of the contract, and passes on what it does not know', async () => {
      const approved = await approvedThreeBillion();
      const made = await create(approved);
      /** A transaction whose statements that match fail the way the database fails; the others run. */
      const failing = (tx: TenantTx, match: RegExp, failure: Record<string, unknown>): TenantTx => ({ query: (sql: string, params?: unknown[]) => (match.test(sql) ? Promise.reject(Object.assign(new Error(String(failure.message ?? 'database')), failure)) : tx.query(sql, params)) }) as TenantTx;
      const code = async (work: Promise<unknown>): Promise<string> => (await refusal(work)).code;
      const check = (message: string) => ({ code: '23514', message });
      expect(await code(as((tx) => payments.create(failing(tx, /insert into machvon\.payment_request\s*\(/, { code: '23505', constraint: 'payment_request_no_uq' }), input(approved), memberId(ACCOUNTANT), everything, TODAY)))).toBe('PAYMENT_REFERENCE_DUPLICATE');
      const revise = (failure: Record<string, unknown>) => as((tx) => payments.revise(failing(tx, /insert into machvon.payment_request_line/, failure), made.id, 1, {}, memberId(ACCOUNTANT), everything, TODAY));
      expect(await code(revise(check('PAYMENT_NET_MISMATCH: x')))).toBe('PAYMENT_NET_MISMATCH');
      expect(await code(revise(check('PAYMENT_STATE_INVALID: x')))).toBe('PAYMENT_STATE_INVALID');
      expect(await code(revise(check('ACCEPTANCE_NOT_APPROVED: x')))).toBe('ACCEPTANCE_NOT_APPROVED');
      expect(await code(revise(check('DOCUMENT_NOT_CLEAN: x')))).toBe('DOCUMENT_NOT_CLEAN');
      const unknown = await revise(check('something else')).catch((error: Error) => error);
      expect((unknown as Error).message).toBe('something else');
      const document = await fixtures.documentVersion();
      const attachWith = (failure: Record<string, unknown>) =>
        as((tx) => payments.attachDocument(failing(tx, /insert into machvon.payment_document/, failure), made.id, { documentVersionId: document.id, docKind: 'OTHER' }, memberId(ACCOUNTANT), everything, { mayOverride: () => false }));
      expect(await code(attachWith({ code: '23505', constraint: 'payment_document_invoice_uq' }))).toBe('INVOICE_DUPLICATE');
      expect(await refusal(attachWith({ code: '23505', constraint: 'payment_document_version_uq' }))).toMatchObject({ code: 'VALIDATION_FAILED', extensions: { reason: 'ALREADY_ATTACHED' } });
      expect(await code(attachWith(check('DOCUMENT_NOT_CLEAN: x')))).toBe('DOCUMENT_NOT_CLEAN');
    });

    it('a document is kept as it is, is clean, is of the contract of the request and has the checksum of its file', async () => {
      const approved = await approvedThreeBillion();
      const made = await create(approved);
      const clean = await fixtures.documentVersion();
      const dirty = await fixtures.documentVersion('PENDING');
      const insert = (versionId: string, checksum: string, contractId = approved.contract.contractId, kind = 'OTHER') =>
        owner(
          `insert into machvon.payment_document (tenant_id, id, payment_request_id, contract_id, document_version_id, doc_kind, checksum, created_by, updated_by) values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $7)`,
          [TENANT_A, made.id, contractId, versionId, kind, checksum, memberId(ACCOUNTANT)],
        );
      expect((await databaseRefusal(insert(dirty.id, dirty.checksum))).message).toContain('DOCUMENT_NOT_CLEAN');
      expect((await databaseRefusal(insert(clean.id, 'a'.repeat(64)))).message).toContain('checksum of a document');
      expect((await databaseRefusal(insert(clean.id, clean.checksum, randomUUID()))).message).toContain('of the contract of its payment request');
      await insert(clean.id, clean.checksum);
      expect((await databaseRefusal(owner("update machvon.payment_document set signed = true where payment_request_id = $1::uuid", [made.id]))).message).toContain('kept as it is');
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.payment_document where payment_request_id = $1::uuid', [made.id])))).sqlstate).toBe('42501');
    });
  });

  describe('reading', () => {
    it('lists the requests of the scope, newest first, narrowed by contract, status and kind, and gives one with its lines and documents', async () => {
      const approved = await approvedThreeBillion();
      const first = await create(approved);
      const second = await create(approved);
      await as((tx) => payments.cancel(tx, second.id, 1, 'Duplicate', memberId(ACCOUNTANT), everything));
      const all = await as((tx) => payments.list(tx, () => ({ sql: 'true', params: [] }), { contractId: approved.contract.contractId }));
      expect(all.map((row) => [row.id, row.status])).toEqual([
        [second.id, 'CANCELLED'],
        [first.id, 'DRAFT'],
      ]);
      expect(all[0]).toMatchObject({ lines: [], documents: [], contract: { id: approved.contract.contractId, code: approved.contract.code }, otherDrafts: 1 });
      const drafts = await as((tx) => payments.list(tx, () => ({ sql: 'true', params: [] }), { contractId: approved.contract.contractId, status: 'DRAFT', requestKind: 'INTERIM' }));
      expect(drafts.map((row) => row.id)).toEqual([first.id]);
      const page = await as((tx) => payments.list(tx, () => ({ sql: 'true', params: [] }), { contractId: approved.contract.contractId, limit: 1, after: { createdAt: all[0]!.createdAt, id: all[0]!.id } }));
      expect(page.map((row) => row.id)).toEqual([first.id]);
      expect(await as((tx) => payments.list(tx, () => ({ sql: 'false', params: [] }), {}))).toEqual([]);
      expect(await refusal(as((tx) => payments.list(tx, () => ({ sql: 'true', params: [] }), { status: 'NOPE' })))).toMatchObject({ detail: 'status' });
      expect(await refusal(as((tx) => payments.list(tx, () => ({ sql: 'true', params: [] }), { requestKind: 'NOPE' })))).toMatchObject({ detail: 'request_kind' });
      expect(await refusal(as((tx) => payments.list(tx, () => ({ sql: 'true', params: [] }), { contractId: 'x' })))).toMatchObject({ detail: 'contract_id' });

      await as((tx) => payments.attachDocument(tx, first.id, { documentVersionId: undefined as never, docKind: 'OTHER' }, memberId(ACCOUNTANT), everything, { mayOverride: () => false })).catch(() => undefined);
      const clean = await fixtures.documentVersion();
      await as((tx) => payments.attachDocument(tx, first.id, { documentVersionId: clean.id, docKind: 'INVOICE', invoiceNo: `HD-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-07-02' }, memberId(ACCOUNTANT), everything, { mayOverride: () => false }));
      const found = await as((tx) => payments.find(tx, first.id, () => ({ sql: 'true', params: [] })));
      expect(found).toMatchObject({ id: first.id, status: 'DRAFT', grossVnd: '3000000000', acceptance: { id: approved.acceptance.id }, otherDrafts: 0 });
      expect(found?.lines.map((line) => [line.boqItemKey, line.grossVnd, line.quantity, line.retentionPct])).toEqual([
        ['B01', '2000000000', '2000.000000', '5.0000'],
        ['B02', '1000000000', '500.000000', '5.0000'],
      ]);
      expect(found?.documents).toHaveLength(1);
      expect(found?.documents[0]).toMatchObject({ docKind: 'INVOICE', checksum: clean.checksum, signed: false, duplicateOverrideReason: null });
      expect(await as((tx) => payments.find(tx, first.id, () => ({ sql: 'false', params: [] })))).toBeUndefined();
      // Another tenant sees none of it.
      expect(await fixtures.harness.tenants.withTenant(contextFor(TENANT_B, memberId(1)), (tx) => payments.find(tx, first.id, () => ({ sql: 'true', params: [] })))).toBeUndefined();
    });
  });
});

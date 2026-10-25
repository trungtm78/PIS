import { randomUUID } from 'node:crypto';
import { PayAdvanceStore } from '../src/pay-advance-store';
import type { RecordRecoveryInput, RequestAdvanceInput } from '../src/pay-advance-store';
import { PayClaimStore } from '../src/pay-claim-store';
import { PayPaymentStore } from '../src/pay-payment-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, memberId } from './support/authz-fixtures';
import { seedAs, seedContractor } from './support/bid-proposal-fixtures';
import { AcceptanceWorld } from './support/acceptance-fixtures';
import type { SeededContract } from './support/acceptance-fixtures';

jest.setTimeout(600_000);

const fixtures = new AcceptanceWorld();
const advances = new PayAdvanceStore();
const payments = new PayPaymentStore();
const claims = new PayClaimStore();
const MAKER = 1;
const CHECKER = 3;
const NOW = new Date('2026-07-25T05:00:00Z');
const TODAY = '2026-07-25';
const EXPIRES = '2027-03-01T00:00:00Z';
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const readOnly: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER): Promise<T> => fixtures.as(work, member);
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

/** A contract being performed: its category and value, the work of its one member, and an advance guarantee as asked for. */
async function contractOf(options: { category?: string; valueVnd?: string; workVnd?: string; guarantee?: 'VERIFIED' | 'UNVERIFIED' | 'EXPIRED' | 'SMALL' | 'NONE'; effectiveFrom?: string; status?: string } = {}): Promise<SeededContract> {
  const contract = await fixtures.seedContract();
  const value = options.valueVnd ?? '10000000000';
  await owner('update machvon.contract set advance_category = $2, contract_value_vnd = $3::numeric, estimate_ceiling_vnd = null where id = $1::uuid', [contract.contractId, options.category ?? 'CONSTRUCTION', value]);
  await owner('update machvon.contract_party set work_value_vnd = $2::numeric where contract_id = $1::uuid', [contract.contractId, options.workVnd ?? value]);
  if (options.effectiveFrom !== undefined) await owner('update machvon.contract set effective_from = $2::date where id = $1::uuid', [contract.contractId, options.effectiveFrom]);
  if (options.status !== undefined) {
    const paper = (await fixtures.documentVersion()).id;
    await owner('update machvon.contract set status = $2, status_reason = $3, status_decision_document_version_id = $4::uuid, suspended_from = date \'2026-07-01\' where id = $1::uuid', [contract.contractId, options.status, 'Stopped.', paper]);
  }
  if (options.guarantee !== undefined && options.guarantee !== 'NONE') await guaranteeFor(contract, options.guarantee);
  return contract;
}

async function guaranteeFor(contract: SeededContract, kind: 'VERIFIED' | 'UNVERIFIED' | 'EXPIRED' | 'SMALL', partyId?: string): Promise<string> {
  const paper = (await fixtures.documentVersion()).id;
  const id = randomUUID();
  const checked = kind !== 'UNVERIFIED';
  await owner(
    `insert into machvon.guarantee
       (tenant_id, id, contract_id, kind, issuer, guarantee_no, party_id, amount_vnd, currency, valid_from, expires_at, status, verification_status, document_version_id, verified_by, verified_at,
        verification_method, verification_evidence_id, created_by, updated_by)
     values ($1, $2::uuid, $3::uuid, 'ADVANCE', 'Bank', $4, $5::uuid, $6::numeric, 'VND', date '2026-01-02', $7::timestamptz, $8, $9, $10::uuid, $11::uuid, $12::timestamptz, $13, $14::uuid, $15::uuid, $15::uuid)`,
    [
      TENANT_A,
      id,
      contract.contractId,
      `BL-${id.slice(0, 8)}`,
      partyId ?? null,
      kind === 'SMALL' ? '500000000' : '5000000000',
      kind === 'EXPIRED' ? '2026-06-01T00:00:00Z' : EXPIRES,
      checked ? 'ACTIVE' : 'PENDING_VERIFICATION',
      checked ? 'VERIFIED' : 'UNVERIFIED',
      paper,
      checked ? memberId(CHECKER) : null,
      checked ? '2026-01-03T00:00:00Z' : null,
      checked ? 'BANK_CONFIRMATION' : null,
      checked ? paper : null,
      memberId(MAKER),
    ],
  );
  return id;
}

const request = (contract: SeededContract, amount: string, overrides: Partial<RequestAdvanceInput> = {}, options: { scopes?: ContractScopes; member?: number } = {}) =>
  as(
    (tx) =>
      advances.request(
        tx,
        contract.contractId,
        { partyId: contract.partyId, kind: 'CONTRACT', amountVnd: amount, allocationLineId: fixtures.lineId, ...overrides },
        memberId(options.member ?? MAKER),
        options.scopes ?? everything,
        NOW,
      ),
    options.member ?? MAKER,
  );
const rowOf = async (id: string) =>
  (
    await owner<{ status: string; amount: string; cap: string; paid: string; recovered: string; outstanding: string; rule: string | null; guarantee: string | null; tranche: number; version: string; threshold: string }>(
      `select status, amount_vnd::text as amount, cap_vnd::text as cap, paid_vnd::text as paid, recovered_vnd::text as recovered, outstanding_vnd::text as outstanding, cap_rule_version_id as rule,
              guarantee_id as guarantee, tranche_no as tranche, version::text, recovery_threshold_pct::text as threshold
         from machvon.contract_advance where id = $1::uuid`,
      [id],
    )
  )[0];
const entriesOf = (advanceId: string) =>
  owner<{ entry_kind: string; amount: string; outstanding_after: string; basis: string | null; evidence: string | null; payment_request_id: string | null }>(
    `select entry_kind, amount_vnd::text as amount, outstanding_after_vnd::text as outstanding_after, basis, evidence_document_version_id as evidence, payment_request_id
       from machvon.advance_ledger_entry where advance_id = $1::uuid order by posted_at, id`,
    [advanceId],
  );
const contractRow = async (contractId: string) =>
  (await owner<{ paid: string; recovered: string; version: string }>('select advance_paid_vnd::text as paid, advance_recovered_vnd::text as recovered, version::text from machvon.contract where id = $1::uuid', [contractId]))[0];

/** An advance that has been paid (the Treasury story will do this): a row in the state the commands of the Treasury leave it. */
async function paid(contract: SeededContract, amount: string, trancheNo: number, kind: 'CONTRACT' | 'GPMB' = 'GPMB', deadline = '2026-12-31'): Promise<string> {
  const id = randomUUID();
  const guarantee = kind === 'CONTRACT' ? await guaranteeFor(contract, 'VERIFIED') : null;
  await owner(
    `insert into machvon.contract_advance
       (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, guarantee_id, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
     values ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::numeric, $7::numeric, $10::uuid, 'PAID', $7::numeric, date '2026-07-01', 80, $8::date, $9::uuid, $9::uuid)`,
    [TENANT_A, id, contract.contractId, contract.partyId, trancheNo, kind, amount, deadline, memberId(MAKER), guarantee],
  );
  await owner('update machvon.contract set advance_paid_vnd = advance_paid_vnd + $2::numeric where id = $1::uuid', [contract.contractId, amount]);
  return id;
}

const recover = (advanceId: string, version: number, amount: string, overrides: Partial<RecordRecoveryInput> = {}, scopes: ContractScopes = everything) =>
  as(async (tx) => {
    const evidence = overrides.evidenceDocumentVersionId ?? (await fixtures.documentVersion()).id;
    return advances.recordRecovery(tx, advanceId, version, { amountVnd: amount, basis: 'REFUND', evidenceDocumentVersionId: evidence, requestId: randomUUID(), ...overrides }, memberId(MAKER), scopes);
  });
const cancel = (advanceId: string, version: number, scopes: ContractScopes = everything) => as((tx) => advances.cancel(tx, advanceId, version, 'The advance is not needed.', memberId(MAKER), scopes));

describe('the advance of a contract (ST-PAY-004)', () => {
  beforeAll(async () => {
    await fixtures.start();
  }, 240_000);

  afterAll(async () => {
    await fixtures.stop();
  }, 60_000);

  describe('asking for an advance', () => {
    it('AC-ST-PAY-004-1, UAT-AC325: refuses a contract not in force and a guarantee that is missing, not verified, expired or too small, and plans the one that is eligible with nothing on the journal', async () => {
      const early = await contractOf({ guarantee: 'VERIFIED', effectiveFrom: '2026-09-01' });
      expect(await refusal(request(early, '1000000000'))).toMatchObject({ code: 'ADVANCE_CONTRACT_NOT_EFFECTIVE', status: 422, extensions: { contract_status: 'ACTIVE', effective_from: '2026-09-01' } });
      const suspended = await contractOf({ guarantee: 'VERIFIED', status: 'SUSPENDED' });
      expect(await refusal(request(suspended, '1000000000'))).toMatchObject({ code: 'ADVANCE_CONTRACT_NOT_EFFECTIVE', extensions: { contract_status: 'SUSPENDED' } });
      expect(await refusal(request(await contractOf({}), '1000000000'))).toMatchObject({ code: 'ADVANCE_GUARANTEE_REQUIRED', status: 422, extensions: { reason: 'NO_GUARANTEE' } });
      expect(await refusal(request(await contractOf({ guarantee: 'UNVERIFIED' }), '1000000000'))).toMatchObject({ code: 'ADVANCE_GUARANTEE_REQUIRED', extensions: { reason: 'NOT_VERIFIED' } });
      expect(await refusal(request(await contractOf({ guarantee: 'EXPIRED' }), '1000000000'))).toMatchObject({ code: 'ADVANCE_GUARANTEE_REQUIRED', extensions: { reason: 'EXPIRED' } });
      expect(await refusal(request(await contractOf({ guarantee: 'SMALL' }), '1000000000'))).toMatchObject({ code: 'ADVANCE_GUARANTEE_REQUIRED', extensions: { reason: 'TOO_SMALL' } });

      const good = await contractOf({ guarantee: 'VERIFIED' });
      const planned = await request(good, '1000000000');
      expect(planned.fromStatus).toBeNull();
      expect(planned.view).toMatchObject({ status: 'PLANNED', amountVnd: '1000000000', capVnd: '2000000000', capPct: '20', kind: 'CONTRACT', trancheNo: 1, thresholdPct: '80', paidVnd: '0', recoveredVnd: '0', outstandingVnd: '0' });
      expect(planned.view.contract).toMatchObject({ code: good.code, advanceCategory: 'CONSTRUCTION', valueVnd: '10000000000' });
      expect(planned.view.guaranteeId).not.toBeNull();
      expect(planned.view.allocationLineId).toBe(fixtures.lineId);
      expect(await entriesOf(planned.view.id)).toEqual([]);
      expect(await contractRow(good.contractId)).toMatchObject({ paid: '0', recovered: '0' });
    });

    it('takes the guarantee that is named if it covers, and says which one does not', async () => {
      const contract = await contractOf({});
      const small = await guaranteeFor(contract, 'SMALL');
      const big = await guaranteeFor(contract, 'VERIFIED');
      const stale = await guaranteeFor(contract, 'EXPIRED');
      expect(await refusal(request(contract, '1000000000', { guaranteeId: small }))).toMatchObject({ code: 'ADVANCE_GUARANTEE_REQUIRED', extensions: { reason: 'TOO_SMALL' } });
      expect(await refusal(request(contract, '1000000000', { guaranteeId: stale }))).toMatchObject({ code: 'ADVANCE_GUARANTEE_REQUIRED', extensions: { reason: 'EXPIRED' } });
      expect(await refusal(request(contract, '1000000000', { guaranteeId: randomUUID() }))).toMatchObject({ code: 'ADVANCE_GUARANTEE_REQUIRED', extensions: { reason: 'NOT_FOUND' } });
      const other = await contractOf({});
      expect(await refusal(request(other, '1000000000', { guaranteeId: big }))).toMatchObject({ code: 'ADVANCE_GUARANTEE_REQUIRED', extensions: { reason: 'NOT_FOUND' } });
      expect((await request(contract, '1000000000', { guaranteeId: big })).view.guaranteeId).toBe(big);
      // A guarantee of another member of the contract does not cover this one.
      const member = await contractOf({});
      const stranger = (await contractOf({})).partyId;
      await guaranteeFor(member, 'VERIFIED', stranger);
      expect(await refusal(request(member, '1000000000'))).toMatchObject({ code: 'ADVANCE_GUARANTEE_REQUIRED' });
    });

    it('AC-ST-PAY-004-2, UAT-AC326: the cap is the share of the work of the member less what is advanced, to the dong, and the refusal names the rule and what it waits for', async () => {
      const exact = await contractOf({ guarantee: 'VERIFIED' });
      expect((await request(exact, '2000000000')).view).toMatchObject({ status: 'PLANNED', capVnd: '2000000000' });
      const over = await contractOf({ guarantee: 'VERIFIED' });
      const refused = await refusal(request(over, '2000000001'));
      expect(refused).toMatchObject({ code: 'ADVANCE_CAP_EXCEEDED', status: 422, extensions: { cap_vnd: '2000000000', cap_pct: '20', rule_awaiting_confirmation: true, cxn: 'CXN-02' } });
      expect(refused.extensions?.cap_rule_version_id).toEqual(expect.any(String));
      expect(await owner('select 1 from machvon.contract_advance where contract_id = $1::uuid', [over.contractId])).toEqual([]);

      // The first tranche is paid: 1.5bn of the 2bn is spoken for, so 600m is too much and 500m is exactly right.
      const second = await contractOf({ guarantee: 'VERIFIED' });
      await paid(second, '1500000000', 1, 'CONTRACT');
      expect(await refusal(request(second, '600000000'))).toMatchObject({ code: 'ADVANCE_CAP_EXCEEDED', extensions: { cap_vnd: '500000000' } });
      expect((await request(second, '500000000')).view).toMatchObject({ trancheNo: 2, capVnd: '500000000' });

      const consulting = await contractOf({ category: 'CONSULTING', valueVnd: '1000000000', guarantee: 'VERIFIED' });
      expect((await request(consulting, '300000000')).view).toMatchObject({ capPct: '30', capVnd: '300000000' });
      const consultingOver = await contractOf({ category: 'CONSULTING', valueVnd: '1000000000', guarantee: 'VERIFIED' });
      expect(await refusal(request(consultingOver, '300000001'))).toMatchObject({ code: 'ADVANCE_CAP_EXCEEDED', extensions: { cap_vnd: '300000000', cap_pct: '30' } });
    });

    it('does not guess a cap: a category with no rule, and a value under every tier, are 422 ADVANCE_RULE_UNCONFIRMED', async () => {
      const other = await contractOf({ category: 'EQUIPMENT', guarantee: 'VERIFIED' });
      expect(await refusal(request(other, '1000'))).toMatchObject({ code: 'ADVANCE_RULE_UNCONFIRMED', status: 422, extensions: { reason: 'NO_RULE', advance_category: 'EQUIPMENT' } });
      const small = await contractOf({ valueVnd: '9999999999', guarantee: 'VERIFIED' });
      expect(await refusal(request(small, '1000'))).toMatchObject({ code: 'ADVANCE_RULE_UNCONFIRMED', extensions: { reason: 'NO_TIER' } });
    });

    it('counts an advance that is planned under the cap, and gives the place back when it is cancelled', async () => {
      const contract = await contractOf({ guarantee: 'VERIFIED' });
      const first = await request(contract, '1500000000');
      expect(await refusal(request(contract, '600000000'))).toMatchObject({ code: 'ADVANCE_CAP_EXCEEDED', extensions: { cap_vnd: '500000000' } });
      const cancelled = await cancel(first.view.id, first.view.version);
      expect(cancelled).toMatchObject({ fromStatus: 'PLANNED', view: { status: 'CANCELLED', version: first.view.version + 1 } });
      expect((await request(contract, '2000000000')).view).toMatchObject({ trancheNo: 2, capVnd: '2000000000' });
    });

    it('AC-ST-PAY-004-1: a land clearance advance needs no guarantee, and the allocation, the amount and the tranche are judged', async () => {
      const contract = await contractOf({});
      const planned = await request(contract, '1000000000', { kind: 'GPMB' });
      expect(planned.view).toMatchObject({ kind: 'GPMB', guaranteeId: null, status: 'PLANNED' });
      expect(await refusal(request(contract, '1000', { kind: 'GPMB', allocationLineId: randomUUID() }))).toMatchObject({ code: 'ALLOCATION_UNAVAILABLE', status: 422 });
      expect(await refusal(request(contract, '0', { kind: 'GPMB' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount_vnd' });
      expect(await refusal(request(contract, '1.5', { kind: 'GPMB' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount_vnd' });
      expect(await refusal(request(contract, '1000', { kind: 'SOMETHING' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'kind' });
      expect(await refusal(request(contract, '1000', { kind: 'GPMB', trancheNo: 0 }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'tranche_no' });
      expect(await refusal(request(contract, '1000', { kind: 'GPMB', partyId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'party_id', extensions: { reason: 'NOT_A_MEMBER' } });
      expect(await refusal(request(contract, '1000', { kind: 'GPMB', trancheNo: 1 }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'tranche_no', extensions: { reason: 'TRANCHE_EXISTS' } });
      expect(await refusal(request(contract, '1000', { kind: 'GPMB', partyId: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'party_id' });
    });

    it('is not advanced again while an earlier advance of the member is overdue, nor above what the contract may pay out', async () => {
      const late = await contractOf({});
      await paid(late, '1000000000', 1, 'GPMB', '2026-07-24');
      expect(await refusal(request(late, '1000', { kind: 'GPMB' }))).toMatchObject({ code: 'ADVANCE_OUTSTANDING_PRIOR', status: 422, extensions: { outstanding_vnd: '1000000000' } });
      const onTime = await contractOf({});
      await paid(onTime, '1000000000', 1, 'GPMB', '2026-07-25');
      expect((await request(onTime, '1000', { kind: 'GPMB' })).view.status).toBe('PLANNED');

      const small = await contractOf({ valueVnd: '10000000000', guarantee: 'VERIFIED' });
      await owner('update machvon.contract set advance_paid_vnd = 9000000000, advance_recovered_vnd = 0 where id = $1::uuid', [small.contractId]);
      expect(await refusal(request(small, '1500000000'))).toMatchObject({ code: 'VALUE_EXCEEDED', status: 409, extensions: { rule: 'contract_cash_out_chk', contract_value_vnd: '10000000000', cash_out_vnd: '10500000000' } });
    });

    it('is a command of the scope of the caller: a contract outside it is not found, one that is read-only is refused, and nothing is planned', async () => {
      const contract = await contractOf({ guarantee: 'VERIFIED' });
      expect(await refusal(request(contract, '1000000000', {}, { scopes: readOnly }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      const none: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) };
      expect(await refusal(request(contract, '1000000000', {}, { scopes: none }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => advances.request(tx, randomUUID(), { partyId: contract.partyId, kind: 'CONTRACT', amountVnd: '1', allocationLineId: fixtures.lineId }, memberId(MAKER), everything, NOW)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(await owner('select 1 from machvon.contract_advance where contract_id = $1::uuid', [contract.contractId])).toEqual([]);
    });

    it('serialises two requests for one member under the lock of the contract: of two that together go above the cap, one is planned', async () => {
      for (let round = 0; round < 6; round += 1) {
        const contract = await contractOf({ guarantee: 'VERIFIED' });
        const outcomes = await Promise.allSettled([request(contract, '1500000000'), request(contract, '1500000000', {}, { member: 2 })]);
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        const lost = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
        expect((lost?.reason as { code: string }).code).toBe('ADVANCE_CAP_EXCEEDED');
        expect(await owner("select 1 from machvon.contract_advance where contract_id = $1::uuid and status = 'PLANNED'", [contract.contractId])).toHaveLength(1);
      }
    });
  });

  describe('cancelling an advance', () => {
    it('cancels one that is planned, once, with the version the caller saw', async () => {
      const contract = await contractOf({ guarantee: 'VERIFIED' });
      const planned = await request(contract, '1000000000');
      expect(await refusal(cancel(planned.view.id, planned.view.version + 3))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(cancel(planned.view.id, planned.view.version, readOnly))).toMatchObject({ code: 'SCOPE_DENIED' });
      expect(await refusal(as((tx) => advances.cancel(tx, planned.view.id, planned.view.version, '  ', memberId(MAKER), everything)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      const done = await cancel(planned.view.id, planned.view.version);
      expect(done.view.status).toBe('CANCELLED');
      expect((await rowOf(planned.view.id))?.status).toBe('CANCELLED');
      expect(await refusal(cancel(planned.view.id, done.view.version))).toMatchObject({ code: 'ADVANCE_STATE_INVALID', status: 409, extensions: { status: 'CANCELLED' } });
      expect(await refusal(as((tx) => advances.cancel(tx, randomUUID(), 1, 'x', memberId(MAKER), everything)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('does not cancel an advance that was paid, or one a payment request still stands on', async () => {
      const contract = await contractOf({ guarantee: 'VERIFIED' });
      const gpmb = await request(contract, '1000000000', { kind: 'GPMB' });
      const draft = await as((tx) =>
        payments.create(tx, { contractId: contract.contractId, requestKind: 'ADVANCE', advanceId: gpmb.view.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-A-${randomUUID().slice(0, 6)}` }, memberId(MAKER), everything, TODAY),
      );
      expect(await refusal(cancel(gpmb.view.id, gpmb.view.version))).toMatchObject({ code: 'ADVANCE_STATE_INVALID', extensions: { reason: 'PAYMENT_REQUEST_OPEN', payment_request_id: draft.id } });
      const paidOne = await paid(contract, '1000000000', 5);
      expect(await refusal(cancel(paidOne, 1))).toMatchObject({ code: 'ADVANCE_STATE_INVALID', extensions: { status: 'PAID' } });
    });
  });

  describe('the payment request of an advance', () => {
    it('sending it asks for the advance, a second request cannot ask for the same one, and returning it plans the advance again', async () => {
      const contract = await contractOf({});
      const planned = await request(contract, '1000000000', { kind: 'GPMB' });
      const draft = (suffix: string) =>
        as((tx) => payments.create(tx, { contractId: contract.contractId, requestKind: 'ADVANCE', advanceId: planned.view.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-A-${suffix}-${randomUUID().slice(0, 5)}` }, memberId(MAKER), everything, TODAY));
      const first = await draft('1');
      const second = await draft('2');
      const send = (made: { id: string; version: number; grossVnd: string; netVnd: string }) =>
        as((tx) => claims.submit(tx, made.id, made.version, { expectedGrossVnd: made.grossVnd, expectedNetVnd: made.netVnd, requestId: randomUUID() }, memberId(2), everything, TODAY), 2);
      await send(first);
      expect(await rowOf(planned.view.id)).toMatchObject({ status: 'REQUESTED', version: String(planned.view.version + 1), paid: '0' });
      expect(await refusal(send(second))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409, extensions: { reason: 'ADVANCE_NOT_PLANNED' } });
      expect(await refusal(cancel(planned.view.id, planned.view.version + 1))).toMatchObject({ code: 'ADVANCE_STATE_INVALID', extensions: { reason: 'PAYMENT_REQUEST_OPEN' } });
      // Nothing was put on the books of the contract: an advance moves money when the Treasury pays it.
      expect(await contractRow(contract.contractId)).toMatchObject({ paid: '0', recovered: '0' });
      const returned = await as((tx) => claims.returnRequest(tx, first.id, first.version + 1, { reason: 'The form is wrong.', requestId: randomUUID() }, memberId(CHECKER), everything), CHECKER);
      expect(returned).toMatchObject({ status: 'RETURNED' });
      expect(await rowOf(planned.view.id)).toMatchObject({ status: 'PLANNED', version: String(planned.view.version + 2) });
    });
  });

  describe('recovering an advance outside the payments', () => {
    it('AC-ST-PAY-004-4, UAT-AC61: takes up to what is still owed, with its basis and evidence, and never more', async () => {
      const contract = await contractOf({});
      const id = await paid(contract, '2000000000', 1);
      await owner("update machvon.contract_advance set recovered_vnd = 750000000, status = 'RECOVERING' where id = $1::uuid", [id]);
      await owner('update machvon.contract set advance_recovered_vnd = 750000000 where id = $1::uuid', [contract.contractId]);
      const version = Number((await rowOf(id))?.version);

      const over = await refusal(recover(id, version, '1300000000'));
      expect(over).toMatchObject({ code: 'ADVANCE_RECOVERY_EXCEEDED', status: 422, extensions: { outstanding_vnd: '1250000000', exceeds_by_vnd: '50000000' } });
      expect(await entriesOf(id)).toEqual([]);
      expect(await contractRow(contract.contractId)).toMatchObject({ recovered: '750000000' });

      const evidence = (await fixtures.documentVersion()).id;
      const done = await recover(id, version, '1250000000', { evidenceDocumentVersionId: evidence, basis: 'COMPENSATION_PAYMENT', sourceRefId: randomUUID() });
      expect(done).toMatchObject({ fromStatus: 'RECOVERING', view: { status: 'FULLY_RECOVERED', recoveredVnd: '2000000000', outstandingVnd: '0', version: version + 1 } });
      expect(await contractRow(contract.contractId)).toMatchObject({ paid: '2000000000', recovered: '2000000000' });
      const [entry] = await entriesOf(id);
      expect(entry).toMatchObject({ entry_kind: 'RECOVER', amount: '1250000000', outstanding_after: '0', basis: 'COMPENSATION_PAYMENT', evidence, payment_request_id: null });
      expect(await refusal(recover(id, version + 1, '1'))).toMatchObject({ code: 'ADVANCE_STATE_INVALID', extensions: { status: 'FULLY_RECOVERED' } });

      // Behind the application the database refuses the same thing, and the journal cannot be changed.
      const bypass = await databaseRefusal(as((tx) => tx.query('update machvon.contract_advance set recovered_vnd = 2000000001 where id = $1::uuid', [id])));
      expect(bypass).toMatchObject({ sqlstate: '23514' });
      expect(bypass.message).toContain('contract_advance_amounts_chk');
      expect((await databaseRefusal(owner('update machvon.advance_ledger_entry set reason = $2 where advance_id = $1::uuid', [id, 'x']))).message).toContain('LEDGER_ENTRY_IMMUTABLE');
      expect((await rowOf(id))?.recovered).toBe('2000000000');
    });

    it('records part of it and leaves the advance recovering, and the entry says how much is left', async () => {
      const contract = await contractOf({});
      const id = await paid(contract, '1000000000', 1);
      const first = await recover(id, 1, '400000000', { basis: 'REFUND' });
      expect(first).toMatchObject({ fromStatus: 'PAID', view: { status: 'RECOVERING', recoveredVnd: '400000000', outstandingVnd: '600000000' } });
      const second = await recover(id, first.view.version, '100000000', { basis: 'OTHER' });
      expect(second.view).toMatchObject({ status: 'RECOVERING', recoveredVnd: '500000000' });
      expect((await entriesOf(id)).map((entry) => [entry.amount, entry.outstanding_after, entry.basis])).toEqual([
        ['400000000', '600000000', 'REFUND'],
        ['100000000', '500000000', 'OTHER'],
      ]);
      expect(await contractRow(contract.contractId)).toMatchObject({ recovered: '500000000' });
    });

    it('asks for the basis, the evidence and a clean file, and is not made on an advance that is not being repaid', async () => {
      const contract = await contractOf({ guarantee: 'VERIFIED' });
      const id = await paid(contract, '1000000000', 1);
      expect(await refusal(recover(id, 1, '1', { basis: 'GIFT' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'basis' });
      expect(await refusal(recover(id, 1, '1', { evidenceDocumentVersionId: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evidence_document_version_id' });
      expect(await refusal(recover(id, 1, '1', { evidenceDocumentVersionId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evidence_document_version_id', extensions: { reason: 'NOT_FOUND' } });
      expect(await refusal(recover(id, 1, '1', { evidenceDocumentVersionId: (await fixtures.documentVersion('INFECTED')).id }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN', status: 422 });
      expect(await refusal(recover(id, 1, '0'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount_vnd' });
      expect(await refusal(recover(id, 7, '1'))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(recover(id, 1, '1', {}, readOnly))).toMatchObject({ code: 'SCOPE_DENIED' });
      const planned = await request(contract, '1000000000');
      expect(await refusal(recover(planned.view.id, planned.view.version, '1'))).toMatchObject({ code: 'ADVANCE_STATE_INVALID', extensions: { status: 'PLANNED' } });
      expect(await entriesOf(id)).toEqual([]);
    });
  });

  describe('what the database keeps behind the application', () => {
    it('refuses a planned advance on a contract that is not in force, without a covering guarantee, for a stranger to the contract, and without the rule it was capped by', async () => {
      const contract = await contractOf({ guarantee: 'VERIFIED', effectiveFrom: '2099-01-01' });
      const insert = (target: SeededContract, overrides: { guarantee?: string | null; party?: string; rule?: string | null; kind?: string } = {}) =>
        owner(
          `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, cap_rule_version_id, guarantee_id, allocation_line_id, status, created_by, updated_by)
           values ($1, gen_random_uuid(), $2::uuid, $3::uuid, 1, $4, 1000, 2000, $5::uuid, $6::uuid, $7::uuid, 'PLANNED', $8::uuid, $8::uuid)`,
          [
            TENANT_A,
            target.contractId,
            overrides.party ?? target.partyId,
            overrides.kind ?? 'GPMB',
            overrides.rule === undefined ? (rule ?? null) : overrides.rule,
            overrides.guarantee ?? null,
            fixtures.lineId,
            memberId(MAKER),
          ],
        );
      const rule = (await owner<{ id: string }>("select v.id from machvon.master_record_version v where v.master_type = 'PAY_ADVANCE_CAP' and v.code = 'CONSTRUCTION' order by v.revision desc limit 1"))[0]?.id;
      expect(rule).toEqual(expect.any(String));
      expect((await databaseRefusal(insert(contract))).message).toContain('ADVANCE_CONTRACT_NOT_EFFECTIVE');
      const inForce = await contractOf({});
      expect((await databaseRefusal(insert(inForce, { rule: null }))).message).toContain('keeps the version of the rule');
      expect((await databaseRefusal(insert(inForce, { kind: 'CONTRACT', guarantee: await guaranteeFor(await contractOf({}), 'VERIFIED') }))).message).toContain('ADVANCE_GUARANTEE_REQUIRED');
      expect((await databaseRefusal(insert(inForce, { party: randomUUID() }))).sqlstate).not.toBe('');
      expect((await databaseRefusal(insert(inForce, { kind: 'CONTRACT', guarantee: await guaranteeFor(inForce, 'UNVERIFIED') }))).message).toContain('ADVANCE_GUARANTEE_REQUIRED');
      await insert(inForce);
    });

    it('moves the status along its edges only, fixes what an advance is about, sets the amount paid once and agrees the status with the amounts', async () => {
      const contract = await contractOf({});
      const planned = await request(contract, '1000000000', { kind: 'GPMB' });
      const id = planned.view.id;
      const update = (sql: string) => databaseRefusal(owner(`update machvon.contract_advance set ${sql} where id = $1::uuid`, [id]));
      expect((await update("status = 'PAID', paid_vnd = 1000000000, paid_on = date '2026-07-25', recovery_deadline = date '2026-08-24'")).message).toContain('ADVANCE_STATE_INVALID');
      expect((await update('amount_vnd = 5, cap_vnd = 5')).message).toContain('what an advance is about never changes');
      expect((await update('tranche_no = 9')).message).toContain('what an advance is about never changes');
      expect((await update('paid_vnd = 1')).message).toContain('the amount paid is set once');
      await owner("update machvon.contract_advance set status = 'REQUESTED' where id = $1::uuid", [id]);
      expect((await update("status = 'RECOVERING', paid_vnd = 1000000000, recovered_vnd = 1, paid_on = date '2026-07-25', recovery_deadline = date '2026-08-24'")).message).toContain('ADVANCE_STATE_INVALID');
      await owner("update machvon.contract_advance set status = 'PAID', paid_vnd = 1000000000, paid_on = date '2026-07-25', recovery_deadline = date '2026-08-24' where id = $1::uuid", [id]);
      expect((await update('paid_vnd = 2000000000')).message).toContain('the amount paid is set once');
      // A paid advance goes back to planned only when its payment is reversed (V1568, ST-PAY-008); it never goes to cancelled, and its amount paid is never changed otherwise.
      expect((await update("status = 'CANCELLED', paid_vnd = 0")).message).toContain('ADVANCE_STATE_INVALID');
      expect((await update("status = 'RECOVERING', recovered_vnd = 0")).message).toContain('contract_advance_status_amounts_chk');
      expect((await update("status = 'FULLY_RECOVERED', recovered_vnd = 5")).message).toContain('contract_advance_status_amounts_chk');
    });

    it('is never deleted, by the runtime role or by a truncate', async () => {
      const contract = await contractOf({});
      const planned = await request(contract, '1000000000', { kind: 'GPMB' });
      const refused = await databaseRefusal(as((tx) => tx.query('delete from machvon.contract_advance where id = $1::uuid', [planned.view.id])));
      expect(refused.sqlstate).toBe('42501');
      expect((await databaseRefusal(as((tx) => tx.query('truncate machvon.contract_advance')))).sqlstate).toBe('42501');
      expect(await rowOf(planned.view.id)).toBeDefined();
    });

    it('keeps the journal honest: a recovery that no payment makes says its basis and has evidence', async () => {
      const contract = await contractOf({});
      const id = await paid(contract, '1000000000', 1);
      const post = (basis: string | null, evidence: string | null) =>
        owner(
          `insert into machvon.advance_ledger_entry (tenant_id, id, contract_id, payment_request_id, entry_kind, amount_vnd, posted_at, advance_id, party_id, outstanding_after_vnd, basis, evidence_document_version_id)
           values ($1, gen_random_uuid(), $2::uuid, null, 'RECOVER', 10, now(), $3::uuid, $4::uuid, 990, $5, $6::uuid)`,
          [TENANT_A, contract.contractId, id, contract.partyId, basis, evidence],
        );
      expect((await databaseRefusal(post(null, null))).message).toContain('advance_ledger_entry_outside_chk');
      expect((await databaseRefusal(post('REFUND', null))).message).toContain('advance_ledger_entry_outside_chk');
      expect((await databaseRefusal(post('GIFT', (await fixtures.documentVersion()).id))).message).toContain('advance_ledger_entry_basis_chk');
      expect((await databaseRefusal(post('REFUND', randomUUID()))).sqlstate).toBe('23503');
      await post('REFUND', (await fixtures.documentVersion()).id);
    });
  });

  describe('what the database refuses behind the checks of the application', () => {
    it('is told in the words of the contract, and what it does not know is not explained', () => {
      const map = (error: unknown): unknown => (advances as unknown as { mapRefusal(error: unknown): unknown }).mapRefusal(error);
      const check = (message: string, constraint?: string) => map({ code: '23514', message, constraint });
      expect(check('ADVANCE_CONTRACT_NOT_EFFECTIVE: a contract that is in force')).toMatchObject({ code: 'ADVANCE_CONTRACT_NOT_EFFECTIVE', status: 422 });
      expect(check('ADVANCE_GUARANTEE_REQUIRED: covered')).toMatchObject({ code: 'ADVANCE_GUARANTEE_REQUIRED', status: 422 });
      expect(check('ADVANCE_STATE_INVALID: this move')).toMatchObject({ code: 'ADVANCE_STATE_INVALID', status: 409 });
      expect(check('violates', 'contract_advance_amounts_chk')).toMatchObject({ code: 'ADVANCE_RECOVERY_EXCEEDED', status: 422 });
      expect(check('violates', 'contract_advance_order_chk')).toMatchObject({ code: 'ADVANCE_RECOVERY_EXCEEDED' });
      expect(check('violates', 'contract_cash_out_chk')).toMatchObject({ code: 'VALUE_EXCEEDED', status: 409, extensions: { rule: 'contract_cash_out_chk' } });
      expect(map({ code: '23505', constraint: 'contract_advance_tranche_uq' })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'tranche_no', extensions: { reason: 'TRANCHE_EXISTS' } });
      const other = new Error('something else');
      expect(check('some other check', 'some_chk')).toEqual({ code: '23514', message: 'some other check', constraint: 'some_chk' });
      expect(map(other)).toBe(other);
      expect(map({ code: '23514' })).toEqual({ code: '23514' });
    });

    it('is told when a guard of the database refuses a command that passed the checks of the application', async () => {
      // The contract stops being in force between the check and the write: the guard of the table speaks in the words of the contract.
      const contract = await contractOf({ guarantee: 'VERIFIED' });
      const planned = await request(contract, '1000000000');
      const racing = new PayAdvanceStore();
      const cancelling = as(async (tx) => {
        const original = tx.query.bind(tx);
        (tx as { query: typeof tx.query }).query = ((text: string, params?: unknown[]) => (text.includes("set status = 'CANCELLED'") ? original("update machvon.contract_advance set status = 'PAID' where id = $1::uuid", [planned.view.id]) : original(text, params))) as typeof tx.query;
        return racing.cancel(tx, planned.view.id, planned.view.version, 'The advance is not needed.', memberId(MAKER), everything);
      });
      expect(await refusal(cancelling)).toMatchObject({ code: 'ADVANCE_STATE_INVALID', status: 409 });
      expect((await rowOf(planned.view.id))?.status).toBe('PLANNED');
    });
  });

  describe('reading the advances', () => {
    it('lists the advances in the scope, the newest first, by contract and status, and finds one; one outside the scope is not there', async () => {
      const contract = await contractOf({ guarantee: 'VERIFIED' });
      const first = await request(contract, '500000000');
      const second = await request(contract, '600000000');
      const listed = await as((tx) => advances.list(tx, () => ({ sql: 'true', params: [] }), { contractId: contract.contractId }));
      expect(listed.map((view) => view.id)).toEqual([second.view.id, first.view.id]);
      expect(listed[0]).toMatchObject({ trancheNo: 2, status: 'PLANNED', capRuleAwaitingConfirmation: true, capRuleCxn: 'CXN-02', capPct: '20', party: { workValueVnd: '10000000000' } });
      const page = await as((tx) => advances.list(tx, () => ({ sql: 'true', params: [] }), { contractId: contract.contractId, limit: 1, after: { createdAt: listed[0]!.createdAt, id: listed[0]!.id } }));
      expect(page.map((view) => view.id)).toEqual([first.view.id]);
      await cancel(first.view.id, first.view.version);
      expect((await as((tx) => advances.list(tx, () => ({ sql: 'true', params: [] }), { contractId: contract.contractId, status: 'CANCELLED' }))).map((view) => view.id)).toEqual([first.view.id]);
      expect(await refusal(as((tx) => advances.list(tx, () => ({ sql: 'true', params: [] }), { status: 'NOPE' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'status' });
      expect(await refusal(as((tx) => advances.list(tx, () => ({ sql: 'true', params: [] }), { contractId: 'x' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contract_id' });
      expect((await as((tx) => advances.find(tx, second.view.id, () => ({ sql: 'true', params: [] }))))?.id).toBe(second.view.id);
      expect(await as((tx) => advances.find(tx, second.view.id, () => ({ sql: 'false', params: [] })))).toBeUndefined();
      expect(await as((tx) => advances.plan(tx, randomUUID(), () => ({ sql: 'true', params: [] })))).toBeUndefined();
    });
  });

  describe('the recovery of a joint venture, member by member', () => {
    it('AC-ST-PAY-004-3, UAT-AC327: each member recovers by its own work and its own advance; the first is recovered in full at 80 percent of its work and the second is not touched by it', async () => {
      const contract = await fixtures.seedContract();
      const second = randomUUID();
      const secondContractor = await seedContractor(fixtures.harness);
      // The shares add up to a hundred at the end of the statement, so the lead and the member are written together.
      await owner(
        `with lead as (update machvon.contract_party set role = 'LEAD', share_pct = 60, work_value_vnd = 6000000000 where contract_id = $1::uuid returning 1)
         insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
         values ($2, $3::uuid, $1::uuid, $4::uuid, 'MEMBER', 40, 4000000000, 'ACTIVE', date '2026-01-02', $5::uuid, $5::uuid)`,
        [contract.contractId, TENANT_A, second, secondContractor, memberId(MAKER)],
      );
      await owner('update machvon.contract set advance_paid_vnd = 1500000000, is_joint_venture = true where id = $1::uuid', [contract.contractId]);
      for (const [party, amount, tranche] of [[contract.partyId, '900000000', 1], [second, '600000000', 1]] as const) {
        await owner(
          `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
           values ($1, gen_random_uuid(), $2::uuid, $3::uuid, $4, 'GPMB', $5::numeric, $5::numeric, 'PAID', $5::numeric, date '2026-07-01', 80, date '2026-12-31', $6::uuid, $6::uuid)`,
          [TENANT_A, contract.contractId, party, tranche, amount, memberId(MAKER)],
        );
      }
      let revision = 0;
      const measure = async (item: 0 | 1, quantity: string, party: string): Promise<string> => {
        revision += 1;
        const measurementId = randomUUID();
        const lineId = (await owner<{ id: string }>('select id from machvon.boq_line where contract_id = $1::uuid and boq_item_id = $2::uuid limit 1', [contract.contractId, contract.items[item]]))[0]?.id;
        const paper = (await fixtures.documentVersion()).id;
        await seedAs(fixtures.harness, [
          [
            `insert into machvon.measurement
               (tenant_id, id, contract_id, contract_revision_id, boq_line_id, boq_item_id, party_id, period_id, quantity_period, quantity_cumulative, revision, status, evidence_refs, reference_no,
                created_by, updated_by, submitted_by, submitted_at, decided_by, decided_at, version)
             values ($1, $2, $3, $4, $5, $6, $7, (select id from machvon.reporting_period limit 1), $8::numeric, $8::numeric, $9, 'APPROVED', jsonb_build_array(jsonb_build_object('document_version_id', $10::text)), $11,
                     $12, $12, $12, now(), $13, now(), 1)`,
            [TENANT_A, measurementId, contract.contractId, contract.revisionId, lineId, contract.items[item], party, quantity, revision, paper, `NK-JV-${randomUUID().slice(0, 8)}`, memberId(MAKER), memberId(CHECKER)],
          ],
        ]);
        return measurementId;
      };
      const approve = async (item: 0 | 1, quantity: string, party: string) => {
        const measurementId = await measure(item, quantity, party);
        const period = (await owner<{ id: string }>('select id from machvon.reporting_period limit 1'))[0]?.id as string;
        const paper = (await fixtures.documentVersion()).id;
        const drafted = await fixtures.as((tx) => fixtures.acceptances.create(tx, contract.contractId, { measurementIds: [measurementId], periodId: period, documentVersionId: paper }, memberId(1), everything, TODAY), 1);
        const sent = await fixtures.as((tx) => fixtures.acceptances.submit(tx, drafted.id, drafted.version, { signerRefs: [{ name: 'Owner', role: 'OWNER' }] }, memberId(2), everything), 2);
        return fixtures.as((tx) => fixtures.acceptances.decide(tx, sent.id, sent.version, { decision: 'approve', reason: 'Checked.', evidenceIds: [] }, memberId(3), everything), 3);
      };
      const pay = async (acceptanceId: string): Promise<void> => {
        const made = await as((tx) =>
          payments.create(tx, { contractId: contract.contractId, requestKind: 'INTERIM', acceptanceId, allocationLineId: fixtures.lineId, requestNo: `DNTT-JV-${randomUUID().slice(0, 6)}` }, memberId(MAKER), everything, TODAY),
        );
        const document = await fixtures.documentVersion();
        await as((tx) => payments.attachDocument(tx, made.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-JV-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-07-01' }, memberId(MAKER), everything, { mayOverride: () => false }));
        await as((tx) => claims.submit(tx, made.id, made.version, { expectedGrossVnd: made.grossVnd, expectedNetVnd: made.netVnd, requestId: randomUUID() }, memberId(2), everything, TODAY), 2);
      };
      const planOf = (tranche: { id: string } | undefined) => as((tx) => advances.plan(tx, tranche?.id as string, () => ({ sql: 'true', params: [] })));
      const m1 = async () => (await owner<{ id: string; recovered: string; status: string; outstanding: string }>("select id, recovered_vnd::text as recovered, status, outstanding_vnd::text as outstanding from machvon.contract_advance where party_id = $1::uuid", [contract.partyId]))[0];
      const m2 = async () => (await owner<{ id: string; recovered: string; status: string; outstanding: string }>("select id, recovered_vnd::text as recovered, status, outstanding_vnd::text as outstanding from machvon.contract_advance where party_id = $1::uuid", [second]))[0];

      // M1's work is 6bn and the threshold 80 percent, so its advance is recovered in full at 4.8bn; each payment of 2.4bn recovers half. M2 asks for 1bn of 3.2bn.
      await pay((await approve(0, '2400', contract.partyId)).id);
      expect(await m1()).toMatchObject({ recovered: '450000000', status: 'RECOVERING' });
      const midway = await planOf(await m1());
      expect(midway?.plan).toMatchObject({ thresholdValueVnd: '4800000000', grossToDateVnd: '2400000000', targetRecoveredVnd: '450000000', recoveredVnd: '450000000', outstandingVnd: '450000000', behindVnd: '0', remainingToThresholdVnd: '2400000000' });
      await pay((await approve(0, '2400', contract.partyId)).id);
      expect(await m1()).toMatchObject({ recovered: '900000000', status: 'FULLY_RECOVERED', outstanding: '0' });
      expect(await m2()).toMatchObject({ recovered: '0', status: 'PAID' });
      await pay((await approve(1, '500', second)).id);
      expect(await m2()).toMatchObject({ recovered: '187500000', status: 'RECOVERING', outstanding: '412500000' });
      expect(await m1()).toMatchObject({ recovered: '900000000' });
      const done = await planOf(await m1());
      expect(done?.plan).toMatchObject({ remainingToThresholdVnd: '0', outstandingVnd: '0', targetRecoveredVnd: '900000000' });
      const other = await planOf(await m2());
      expect(other?.plan).toMatchObject({ thresholdValueVnd: '3200000000', grossToDateVnd: '1000000000', targetRecoveredVnd: '187500000', outstandingVnd: '412500000' });
      expect(other?.plan.milestones.map((milestone) => milestone.recoveredVnd)).toEqual(['150000000', '300000000', '450000000', '600000000']);

      // A member who has asked to be paid up to the threshold and still owes an advance is not advanced again.
      await owner("update machvon.contract set advance_category = 'CONSTRUCTION', contract_value_vnd = 10000000000 where id = $1::uuid", [contract.contractId]);
      await owner(
        `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, guarantee_id, status, paid_vnd, paid_on, recovery_threshold_pct, created_by, updated_by)
         values ($1, gen_random_uuid(), $2::uuid, $3::uuid, 2, 'CONTRACT', 100000000, 100000000, $4::uuid, 'PAID', 100000000, date '2026-07-20', 80, $5::uuid, $5::uuid)`,
        [TENANT_A, contract.contractId, contract.partyId, await guaranteeFor(contract, 'VERIFIED'), memberId(MAKER)],
      );
      await owner('update machvon.contract set advance_paid_vnd = advance_paid_vnd + 100000000 where id = $1::uuid', [contract.contractId]);
      expect(await refusal(request(contract, '1000', { kind: 'GPMB' }))).toMatchObject({ code: 'ADVANCE_OUTSTANDING_PRIOR', extensions: { outstanding_vnd: '100000000' } });
      // The other member is not held back by it.
      expect((await request(contract, '1000', { kind: 'GPMB', partyId: second })).view.status).toBe('PLANNED');
    });
  });
});

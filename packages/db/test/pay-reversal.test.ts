import { randomUUID } from 'node:crypto';
import { PayAdvanceStore } from '../src/pay-advance-store';
import { PayClaimStore } from '../src/pay-claim-store';
import type { ReversePaymentInput } from '../src/pay-claim-store';
import { PayPaymentStore } from '../src/pay-payment-store';
import { PaySettlementStore } from '../src/pay-settlement-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, memberId } from './support/authz-fixtures';
import { AcceptanceWorld } from './support/acceptance-fixtures';

jest.setTimeout(600_000);

const fixtures = new AcceptanceWorld();
const payments = new PayPaymentStore();
const claims = new PayClaimStore();
const settlements = new PaySettlementStore();
const advances = new PayAdvanceStore();
const MAKER = 1;
const SENDER = 2;
const CHECKER = 3;
const MATCHER = 4;
const REVERSER = 5;
const NOW = new Date('2026-07-25T05:00:00Z');
const TODAY = '2026-07-25';
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

interface Settled {
  id: string;
  contractId: string;
  acceptanceId: string;
  transactionId: string;
  version: number;
}

let counter = 0;
/** A payment request that is with the Treasury: gross 3bn (B01 2bn, B02 1bn), recovery 750m, retention 150m, net 2.1bn. */
async function sentToTreasury(): Promise<{ id: string; contractId: string; acceptanceId: string; version: number }> {
  counter += 1;
  const contract = await fixtures.seedContract();
  await owner('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [contract.contractId]);
  await owner('update machvon.contract set advance_paid_vnd = 2000000000 where id = $1::uuid', [contract.contractId]);
  await owner(
    `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
     values ($1, gen_random_uuid(), $2::uuid, $3::uuid, 1, 'GPMB', 2000000000, 2000000000, 'PAID', 2000000000, date '2026-06-01', 80, date '2026-12-31', $4::uuid, $4::uuid)`,
    [TENANT_A, contract.contractId, contract.partyId, memberId(MAKER)],
  );
  const approved = await fixtures.approve(contract, [
    { item: 0, quantity: '2000' },
    { item: 1, quantity: '500' },
  ]);
  const made = await as((tx) => payments.create(tx, { contractId: contract.contractId, requestKind: 'INTERIM', acceptanceId: approved.acceptance.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-R-${counter}-${randomUUID().slice(0, 6)}` }, memberId(MAKER), everything, TODAY));
  const document = await fixtures.documentVersion();
  await as((tx) => payments.attachDocument(tx, made.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-R-${counter}-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-07-01' }, memberId(MAKER), everything, { mayOverride: () => false }));
  const sent = await as((tx) => claims.submit(tx, made.id, made.version, { expectedGrossVnd: made.grossVnd, expectedNetVnd: made.netVnd, requestId: randomUUID() }, memberId(SENDER), everything, TODAY), SENDER);
  await as((tx) => claims.verify(tx, made.id, sent.version, undefined, memberId(CHECKER), everything), CHECKER);
  await fixtures.sendToTreasury(made.id);
  const [row] = await owner<{ version: string }>('select version::text as version from machvon.payment_request where id = $1::uuid', [made.id]);
  return { id: made.id, contractId: contract.contractId, acceptanceId: approved.acceptance.id, version: Number(row?.version) };
}

/** The same request, settled by a transaction of 2.1bn. */
async function settled(): Promise<Settled> {
  const sent = await sentToTreasury();
  const transactionId = await transaction('2100000000');
  const done = await as((tx) => settlements.match(tx, { transactionId, paymentRequestId: sent.id, actor: memberId(MATCHER), requestId: randomUUID(), scopes: everything, now: NOW }), MATCHER);
  if (done.kind !== 'SETTLED') throw new Error('the fixture was not settled');
  return { id: sent.id, contractId: sent.contractId, acceptanceId: sent.acceptanceId, transactionId, version: done.result.version };
}

async function transaction(amount: string, options: { direction?: 'PAYMENT' | 'REFUND'; reversalOf?: string } = {}): Promise<string> {
  // The payment was confirmed on the evening of 24 July in UTC, which is 25 July in Vietnam; the refund came on 30 July.
  const confirmedAt = options.direction === 'REFUND' ? '2026-07-30T03:00:00Z' : '2026-07-24T18:30:00Z';
  counter += 1;
  const id = randomUUID();
  await owner(
    `insert into machvon.treasury_transaction
       (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, row_hash, direction, reversal_of_id, document_no, document_date, source_kind, provider_event_id, match_status)
     values ($1, $2::uuid, $3::uuid, $4, 'MOCKKB', $5::numeric, $9::timestamptz, repeat('a', 64), repeat('a', 64), $6, $7::uuid, $4, date '2026-07-30', 'CALLBACK_MOCK', $8, 'UNMATCHED')`,
    [TENANT_A, id, fixtures.projectId, `CT-V-${counter}`, amount, options.direction ?? 'PAYMENT', options.reversalOf ?? null, `EVT-V-${counter}`, confirmedAt],
  );
  return id;
}

/** The refund the Treasury confirmed for the payment that settled a request. */
const refundOf = (target: Settled, amount = '2100000000') => transaction(amount, { direction: 'REFUND', reversalOf: target.transactionId });

const reverse = (target: { id: string; version: number }, input: Partial<ReversePaymentInput>, member = REVERSER, scopes: ContractScopes = everything) =>
  as(
    (tx) => claims.reverse(tx, target.id, target.version, { reason: 'Kho bạc hoàn trả do sai số tài khoản thụ hưởng', approvalDocumentVersionId: undefined, refundTransactionId: undefined, requestId: randomUUID(), ...input }, memberId(member), scopes),
    member,
  );

const requestRow = async (id: string) =>
  (
    await owner<{ status: string; claims: boolean; by: string | null; reason: string | null; approval: string | null; refund: string | null; version: string; paid_on: string | null }>(
      'select status, claims_acceptance as claims, reversed_by as by, reversal_reason as reason, reversal_approval_document_version_id as approval, refund_transaction_id as refund, version::text, treasury_paid_on::text as paid_on from machvon.payment_request where id = $1::uuid',
      [id],
    )
  )[0];
const contractRow = async (id: string) =>
  (
    await owner<{ requested: string; paid: string; recovered: string; held: string; advance_paid: string }>(
      'select requested_total_vnd::text as requested, paid_total_vnd::text as paid, advance_recovered_vnd::text as recovered, retention_held_vnd::text as held, advance_paid_vnd::text as advance_paid from machvon.contract where id = $1::uuid',
      [id],
    )
  )[0];
const entriesOf = (requestId: string) =>
  owner<{ id: string; kind: string; reversal_of: string | null; accepted: string; requested: string; paid: string; recovered: string; retention: string; reason: string | null }>(
    `select id, entry_kind as kind, reversal_of_id as reversal_of, accepted_delta_vnd::text as accepted, requested_delta_vnd::text as requested, paid_delta_vnd::text as paid,
            advance_recovery_delta_vnd::text as recovered, retention_delta_vnd::text as retention, reason
       from machvon.cumulative_ledger_entry where payment_request_id = $1::uuid order by created_at, id`,
    [requestId],
  );
const balances = (contractId: string) =>
  owner<{ item: string; accepted: string; requested: string; paid: string; recovered: string; held: string }>(
    `select i.business_key as item, l.accepted_vnd::text as accepted, l.requested_vnd::text as requested, l.paid_vnd::text as paid, l.advance_recovered_vnd::text as recovered, l.retention_held_vnd::text as held
       from machvon.cumulative_ledger l join machvon.boq_item i on i.id = l.boq_item_id where l.contract_id = $1::uuid order by i.business_key`,
    [contractId],
  );

describe('reversing a payment that was settled (ST-PAY-008)', () => {
  beforeAll(async () => {
    await fixtures.start();
    await fixtures.harness.seedMembership(TENANT_A, MATCHER, 1);
  }, 240_000);

  afterAll(async () => {
    await fixtures.stop();
  }, 60_000);

  describe('what a reversal asks for (UAT-AC331)', () => {
    it('asks first for the reason, then for the refund the Treasury confirmed, then for the approving document, then for a person who did not match the payment', async () => {
      const target = await settled();
      const paper = (await fixtures.documentVersion()).id;
      expect(await refusal(reverse(target, { reason: undefined }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect(await refusal(reverse(target, { reason: '   ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(reverse(target, {}))).toMatchObject({ code: 'REFUND_NOT_CONFIRMED', status: 422, extensions: { reason: 'MISSING' } });
      const refund = await refundOf(target);
      expect(await refusal(reverse(target, { refundTransactionId: refund }))).toMatchObject({ code: 'APPROVAL_REQUIRED', status: 422 });
      expect(await refusal(reverse(target, { refundTransactionId: refund, approvalDocumentVersionId: (await fixtures.documentVersion('PENDING')).id }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN', status: 422 });
      expect(await refusal(reverse(target, { refundTransactionId: refund, approvalDocumentVersionId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'approval_document_version_id' });
      expect(await refusal(reverse(target, { refundTransactionId: refund, approvalDocumentVersionId: paper }, MATCHER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      // The person who sent the file to the Treasury (the fixtures send it as member 1) may not reverse it either.
      expect(await refusal(reverse(target, { refundTransactionId: refund, approvalDocumentVersionId: paper }, MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await requestRow(target.id)).toMatchObject({ status: 'SETTLED', by: null, refund: null });
      expect(await contractRow(target.contractId)).toMatchObject({ paid: '3000000000', requested: '3000000000' });
    });

    it('names why a refund is not the refund of this payment', async () => {
      const target = await settled();
      const other = await settled();
      const paper = (await fixtures.documentVersion()).id;
      const attempt = (refundTransactionId: string) => refusal(reverse(target, { refundTransactionId, approvalDocumentVersionId: paper }));
      expect(await attempt(randomUUID())).toMatchObject({ code: 'REFUND_NOT_CONFIRMED', extensions: { reason: 'NOT_FOUND' } });
      expect(await attempt(await transaction('2100000000'))).toMatchObject({ code: 'REFUND_NOT_CONFIRMED', extensions: { reason: 'NOT_A_REFUND' } });
      expect(await attempt(await refundOf(other))).toMatchObject({ code: 'REFUND_NOT_CONFIRMED', extensions: { reason: 'OTHER_PAYMENT' } });
      expect(await attempt(await refundOf(target, '2099999999'))).toMatchObject({ code: 'REFUND_NOT_CONFIRMED', extensions: { reason: 'AMOUNT', refund_vnd: '2099999999', net_vnd: '2100000000' } });
      const used = await refundOf(target);
      await owner("update machvon.treasury_transaction set match_status = 'EXCEPTION' where id = $1::uuid", [used]);
      expect(await attempt(used)).toMatchObject({ code: 'REFUND_NOT_CONFIRMED', extensions: { reason: 'ALREADY_USED' } });
      expect(await refusal(reverse(target, { refundTransactionId: 'x', approvalDocumentVersionId: paper }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'refund_treasury_transaction_id' });
    });

    it('refuses a request that is not settled, a stale version and a caller without the right', async () => {
      const target = await settled();
      const refund = await refundOf(target);
      const paper = (await fixtures.documentVersion()).id;
      const input = { refundTransactionId: refund, approvalDocumentVersionId: paper };
      expect(await refusal(reverse({ id: target.id, version: target.version + 5 }, input))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(reverse(target, input, REVERSER, readOnly))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(reverse({ id: randomUUID(), version: 1 }, input))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const other = await sentToTreasury();
      expect(await refusal(reverse(other, input))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409, extensions: { status: 'SENT_TREASURY' } });
    });
  });

  describe('the reversal (AC-ST-PAY-008-1, UAT-AC331)', () => {
    it('undoes every effect by new entries that name the ones they undo, brings the totals and the tranche back, lets the acceptance be claimed again and matches the refund', async () => {
      const target = await settled();
      const before = await entriesOf(target.id);
      const refund = await refundOf(target);
      const paper = (await fixtures.documentVersion()).id;

      const done = await reverse(target, { refundTransactionId: refund, approvalDocumentVersionId: paper });
      expect(done).toMatchObject({ refundTransactionId: refund, originalPaidOn: '2026-07-25', paymentEntries: 2, advanceId: null, result: { id: target.id, status: 'REVERSED', fromStatus: 'SETTLED', netVnd: '2100000000' } });
      expect(done.refundConfirmedAt).toBe('2026-07-30T03:00:00.000000Z');

      expect(await requestRow(target.id)).toMatchObject({ status: 'REVERSED', claims: false, by: memberId(REVERSER), reason: 'Kho bạc hoàn trả do sai số tài khoản thụ hưởng', approval: paper, refund, paid_on: '2026-07-25' });
      expect(await owner('select match_status, payment_request_id, matched_by from machvon.treasury_transaction where id = $1::uuid', [refund])).toEqual([{ match_status: 'MATCHED', payment_request_id: target.id, matched_by: memberId(REVERSER) }]);

      // Nothing was updated or deleted: the entries of before are all there, and each is undone exactly once by an entry that is its opposite.
      const after = await entriesOf(target.id);
      expect(after.filter((entry) => before.some((original) => original.id === entry.id))).toEqual(before);
      const added = after.filter((entry) => !before.some((original) => original.id === entry.id));
      expect(added.map((entry) => entry.kind).sort()).toEqual(['ADVANCE_RECOVERY_REVERSAL', 'ADVANCE_RECOVERY_REVERSAL', 'CLAIM_RELEASE', 'CLAIM_RELEASE', 'PAYMENT_REVERSAL', 'PAYMENT_REVERSAL', 'RETENTION_RELEASE', 'RETENTION_RELEASE']);
      expect(added.every((entry) => entry.reason === 'The payment was reversed.')).toBe(true);
      for (const [kind, undoes] of [['PAYMENT_REVERSAL', 'PAYMENT'], ['ADVANCE_RECOVERY_REVERSAL', 'ADVANCE_RECOVERY'], ['CLAIM_RELEASE', 'CLAIM']] as const) {
        for (const entry of added.filter((candidate) => candidate.kind === kind)) {
          const original = before.find((candidate) => candidate.id === entry.reversal_of);
          expect(original?.kind).toBe(undoes);
          expect([entry.accepted, entry.requested, entry.paid, entry.recovered, entry.retention]).toEqual([original?.accepted, original?.requested, original?.paid, original?.recovered, original?.retention].map((value) => (value === '0' ? '0' : `-${value}`)));
        }
      }
      expect(added.filter((entry) => entry.kind === 'PAYMENT_REVERSAL').map((entry) => entry.paid).sort()).toEqual(['-1000000000', '-2000000000']);

      // The balances are as before the payment was asked for, and the totals of the contract are back.
      expect((await balances(target.contractId)).filter((balance) => balance.item !== 'B03')).toEqual([
        { item: 'B01', accepted: '2000000000', requested: '0', paid: '0', recovered: '0', held: '0' },
        { item: 'B02', accepted: '1000000000', requested: '0', paid: '0', recovered: '0', held: '0' },
      ]);
      expect(await contractRow(target.contractId)).toEqual({ requested: '0', paid: '0', recovered: '0', held: '0', advance_paid: '2000000000' });
      expect(await owner('select status, recovered_vnd::text as recovered from machvon.contract_advance where contract_id = $1::uuid', [target.contractId])).toEqual([{ status: 'PAID', recovered: '0' }]);
      expect(
        await owner("select entry_kind from machvon.advance_ledger_entry where payment_request_id = $1::uuid and entry_kind = 'REVERSE_RECOVER'", [target.id]),
      ).toHaveLength(1);
      expect(await owner('select 1 from machvon.retention_hold where payment_request_id = $1::uuid', [target.id])).toEqual([]);
    });

    it('lets the acceptance be claimed again once the payment is reversed (AC-ST-PAY-008-2)', async () => {
      const target = await settled();
      const refund = await refundOf(target);
      const paper = (await fixtures.documentVersion()).id;
      const again = (suffix: string) =>
        as((tx) => payments.create(tx, { contractId: target.contractId, requestKind: 'INTERIM', acceptanceId: target.acceptanceId, allocationLineId: fixtures.lineId, requestNo: `DNTT-RR-${suffix}-${randomUUID().slice(0, 6)}` }, memberId(MAKER), everything, TODAY));
      // While the payment stands, the acceptance is claimed.
      expect(await refusal(again('before'))).toMatchObject({ code: 'ACCEPTANCE_ALREADY_CLAIMED', status: 409 });
      await reverse(target, { refundTransactionId: refund, approvalDocumentVersionId: paper });
      const draft = await again('after');
      const document = await fixtures.documentVersion();
      await as((tx) => payments.attachDocument(tx, draft.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-RR-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-07-01' }, memberId(MAKER), everything, { mayOverride: () => false }));
      const [fresh] = await owner<{ version: string }>('select version::text as version from machvon.payment_request where id = $1::uuid', [draft.id]);
      const sent = await as((tx) => claims.submit(tx, draft.id, Number(fresh?.version), { expectedGrossVnd: draft.grossVnd, expectedNetVnd: draft.netVnd, requestId: randomUUID() }, memberId(SENDER), everything, TODAY), SENDER);
      expect(sent).toMatchObject({ status: 'SUBMITTED', grossVnd: '3000000000' });
      expect(await contractRow(target.contractId)).toMatchObject({ requested: '3000000000', paid: '0' });
    });

    it('reverses a payment once: a second reversal is refused, and the ledger refuses an entry that undoes the same entry twice (AC-ST-PAY-008-2)', async () => {
      const target = await settled();
      const refund = await refundOf(target);
      const paper = (await fixtures.documentVersion()).id;
      const input = { refundTransactionId: refund, approvalDocumentVersionId: paper };
      const done = await reverse(target, input);
      expect(await refusal(reverse({ id: target.id, version: done.result.version }, { ...input, refundTransactionId: await refundOf(target) }))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409, extensions: { status: 'REVERSED' } });
      const [payment] = await owner<{ id: string; ledger_id: string; contract_id: string; boq_item_id: string; acceptance_id: string }>(
        "select id, ledger_id, contract_id, boq_item_id, acceptance_id from machvon.cumulative_ledger_entry where payment_request_id = $1::uuid and entry_kind = 'PAYMENT' order by id limit 1",
        [target.id],
      );
      const duplicate = await databaseRefusal(
        owner(
          `insert into machvon.cumulative_ledger_entry (tenant_id, id, ledger_id, contract_id, boq_item_id, acceptance_id, payment_request_id, entry_kind, paid_delta_vnd, advance_outstanding_after_vnd, reversal_of_id, request_id, created_by)
           select tenant_id, gen_random_uuid(), ledger_id, contract_id, boq_item_id, acceptance_id, payment_request_id, 'PAYMENT_REVERSAL', -paid_delta_vnd, 0, id, gen_random_uuid(), created_by
             from machvon.cumulative_ledger_entry where id = $1::uuid`,
          [payment?.id],
        ),
      );
      expect(duplicate.sqlstate).toBe('23505');
      expect(duplicate.message).toContain('cumulative_ledger_entry_reversal_uq');
      // A refund undoes one payment once.
      expect(await owner('select count(*)::text as n from machvon.treasury_transaction where payment_request_id = $1::uuid and direction = \'REFUND\' and match_status = \'MATCHED\'', [target.id])).toEqual([{ n: '1' }]);
    });
  });

  describe('the refusals of the database in the words of the contract', () => {
    const tell = (error: unknown): unknown => (claims as unknown as { mapReversalRefusal(error: unknown): unknown }).mapReversalRefusal(error);

    it('names the rule that a check or a key refused, and leaves any other failure as it is', () => {
      expect(tell({ code: '23505' })).toMatchObject({ code: 'REFUND_NOT_CONFIRMED', status: 422, extensions: { reason: 'ALREADY_USED' } });
      expect(tell({ code: '23514', message: 'REFUND_NOT_CONFIRMED: a payment is reversed against the refund matched to it' })).toMatchObject({ code: 'REFUND_NOT_CONFIRMED', status: 422 });
      expect(tell({ code: '23514', message: 'ADVANCE_STATE_INVALID: the advance of a reversed payment is planned again' })).toMatchObject({ code: 'ADVANCE_STATE_INVALID', status: 409 });
      expect(tell({ code: '23514', message: 'PAYMENT_STATE_INVALID: a payment request that is over' })).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409 });
      expect(tell({ code: '23514', message: 'a hold of retention goes only with the request that is returned or reversed' })).toMatchObject({ code: 'PAYMENT_STATE_INVALID', extensions: { reason: 'RETENTION_RELEASED' } });
      const other = { code: '23514', message: 'something else' };
      expect(tell(other)).toBe(other);
      const unrelated = { code: '40001', message: 'serialization failure' };
      expect(tell(unrelated)).toBe(unrelated);
      expect(tell({ code: '23514' })).toEqual({ code: '23514' });
    });

    it('refuses to reverse a payment whose retention was already paid out', async () => {
      const target = await settled();
      const refund = await refundOf(target);
      await owner("update machvon.retention_hold set released_vnd = 1, status = 'PARTIALLY_RELEASED', released_by = $2::uuid, released_at = now(), release_reason = 'Released by the contract office.' where payment_request_id = $1::uuid and id = (select id from machvon.retention_hold where payment_request_id = $1::uuid order by id limit 1)", [target.id, memberId(REVERSER)]);
      const paper = (await fixtures.documentVersion()).id;
      expect(await refusal(reverse(target, { refundTransactionId: refund, approvalDocumentVersionId: paper }))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409, extensions: { reason: 'RETENTION_RELEASED' } });
      expect(await requestRow(target.id)).toMatchObject({ status: 'SETTLED' });
      expect(await contractRow(target.contractId)).toMatchObject({ paid: '3000000000' });
    });
  });

  describe('the payment of an advance', () => {
    async function paidAdvance(): Promise<{ id: string; version: number; transactionId: string; contractId: string; advanceId: string }> {
      const contract = await fixtures.seedContract();
      await owner('update machvon.contract set advance_category = $2, contract_value_vnd = $3::numeric, estimate_ceiling_vnd = null where id = $1::uuid', [contract.contractId, 'CONSTRUCTION', '10000000000']);
      await owner('update machvon.contract_party set work_value_vnd = $2::numeric where contract_id = $1::uuid', [contract.contractId, '10000000000']);
      const planned = await as((tx) => advances.request(tx, contract.contractId, { partyId: contract.partyId, kind: 'GPMB', amountVnd: '1000000000', allocationLineId: fixtures.lineId }, memberId(MAKER), everything, NOW));
      const made = await as((tx) => payments.create(tx, { contractId: contract.contractId, requestKind: 'ADVANCE', advanceId: planned.view.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-RA-${randomUUID().slice(0, 8)}` }, memberId(MAKER), everything, TODAY));
      const sent = await as((tx) => claims.submit(tx, made.id, made.version, { expectedGrossVnd: made.grossVnd, expectedNetVnd: made.netVnd, requestId: randomUUID() }, memberId(SENDER), everything, TODAY), SENDER);
      await as((tx) => claims.verify(tx, made.id, sent.version, undefined, memberId(CHECKER), everything), CHECKER);
      await fixtures.sendToTreasury(made.id);
      const transactionId = await transaction('1000000000');
      const done = await as((tx) => settlements.match(tx, { transactionId, paymentRequestId: made.id, actor: memberId(MATCHER), requestId: randomUUID(), scopes: everything, now: NOW }), MATCHER);
      if (done.kind !== 'SETTLED') throw new Error('the advance was not paid');
      return { id: made.id, version: done.result.version, transactionId, contractId: contract.contractId, advanceId: planned.view.id };
    }

    it('gives the advance back to planned and takes the money out of the contract by an entry that undoes the disbursement', async () => {
      const target = await paidAdvance();
      const refund = await transaction('1000000000', { direction: 'REFUND', reversalOf: target.transactionId });
      const paper = (await fixtures.documentVersion()).id;
      const done = await reverse(target, { refundTransactionId: refund, approvalDocumentVersionId: paper });
      expect(done).toMatchObject({ advanceId: target.advanceId, paymentEntries: 0, result: { status: 'REVERSED', requestKind: 'ADVANCE' } });
      expect(await owner('select status, paid_vnd::text as paid, paid_on::text, recovery_deadline::text as deadline from machvon.contract_advance where id = $1::uuid', [target.advanceId])).toEqual([{ status: 'PLANNED', paid: '0', paid_on: null, deadline: null }]);
      expect(await contractRow(target.contractId)).toMatchObject({ advance_paid: '0' });
      expect(await owner('select entry_kind, amount_vnd::text as amount, reversal_of_id is not null as undoes from machvon.advance_ledger_entry where payment_request_id = $1::uuid order by posted_at, entry_kind', [target.id])).toEqual([
        { entry_kind: 'DISBURSE', amount: '1000000000', undoes: false },
        { entry_kind: 'REVERSE_DISBURSE', amount: '1000000000', undoes: true },
      ]);
    });

    it('refuses to reverse the payment of an advance of which something was recovered', async () => {
      const target = await paidAdvance();
      const refund = await transaction('1000000000', { direction: 'REFUND', reversalOf: target.transactionId });
      await owner("update machvon.contract_advance set recovered_vnd = 1, status = 'RECOVERING' where id = $1::uuid", [target.advanceId]);
      const paper = (await fixtures.documentVersion()).id;
      expect(await refusal(reverse(target, { refundTransactionId: refund, approvalDocumentVersionId: paper }))).toMatchObject({ code: 'ADVANCE_STATE_INVALID', status: 409, extensions: { status: 'RECOVERING', recovered_vnd: '1' } });
      expect(await requestRow(target.id)).toMatchObject({ status: 'SETTLED' });
    });
  });

  describe('the database holds the rules when the application does not (V1568)', () => {
    it('lets a request be REVERSED only against the refund matched to it, and a refund be matched only to the settled request whose payment it undoes', async () => {
      const target = await settled();
      const refund = await refundOf(target);
      const paper = (await fixtures.documentVersion()).id;
      const reversedColumns = `status = 'REVERSED', claims_acceptance = false, reversed_by = $2::uuid, reversed_at = now(), reversal_reason = 'x', reversal_approval_document_version_id = $3::uuid, refund_transaction_id = $4::uuid`;
      expect((await databaseRefusal(owner(`update machvon.payment_request set ${reversedColumns} where id = $1::uuid`, [target.id, memberId(REVERSER), paper, refund]))).message).toContain('REFUND_NOT_CONFIRMED');
      expect((await databaseRefusal(owner("update machvon.payment_request set status = 'REVERSED', claims_acceptance = false where id = $1::uuid", [target.id]))).message).toContain('a request that is reversed says who reversed it');
      // A refund for another amount is not matched to the request.
      const wrong = await refundOf(target, '1');
      expect((await databaseRefusal(owner("update machvon.treasury_transaction set match_status = 'MATCHED', payment_request_id = $2::uuid, matched_at = now(), matched_by = $3::uuid where id = $1::uuid", [wrong, target.id, memberId(REVERSER)]))).message).toContain('REFUND_NOT_CONFIRMED');
      // Matched with the right amount but a request that is not the one the refund undoes.
      const other = await settled();
      expect((await databaseRefusal(owner("update machvon.treasury_transaction set match_status = 'MATCHED', payment_request_id = $2::uuid, matched_at = now(), matched_by = $3::uuid where id = $1::uuid", [refund, other.id, memberId(REVERSER)]))).message).toContain('REFUND_NOT_CONFIRMED');
      await owner("update machvon.treasury_transaction set match_status = 'MATCHED', payment_request_id = $2::uuid, matched_at = now(), matched_by = $3::uuid where id = $1::uuid", [refund, target.id, memberId(REVERSER)]);
      const second = await refundOf(target);
      expect((await databaseRefusal(owner("update machvon.treasury_transaction set match_status = 'MATCHED', payment_request_id = $2::uuid, matched_at = now(), matched_by = $3::uuid where id = $1::uuid", [second, target.id, memberId(REVERSER)]))).sqlstate).toBe('23505');
    });

    it('keeps what reversed a request, and keeps a reversed request as it is', async () => {
      const target = await settled();
      const refund = await refundOf(target);
      const paper = (await fixtures.documentVersion()).id;
      const done = await reverse(target, { refundTransactionId: refund, approvalDocumentVersionId: paper });
      expect((await databaseRefusal(owner("update machvon.payment_request set reversal_reason = 'rewritten' where id = $1::uuid", [target.id]))).message).toContain('a payment request that is over is kept as it is');
      expect((await databaseRefusal(owner("update machvon.payment_request set status = 'SETTLED' where id = $1::uuid", [target.id]))).message).toContain('PAYMENT_STATE_INVALID');
      expect(done.result.version).toBeGreaterThan(target.version);
    });

    it('takes the amount paid of an advance back only when its payment is reversed before anything was recovered', async () => {
      const contract = await fixtures.seedContract();
      const advanceId = randomUUID();
      await owner(
        `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
         values ($1, $2::uuid, $3::uuid, $4::uuid, 7, 'GPMB', 100, 100, 'PAID', 100, date '2026-07-01', 80, date '2026-12-31', $5::uuid, $5::uuid)`,
        [TENANT_A, advanceId, contract.contractId, contract.partyId, memberId(MAKER)],
      );
      expect((await databaseRefusal(owner("update machvon.contract_advance set paid_vnd = 50, status = 'PAID' where id = $1::uuid", [advanceId]))).message).toContain('the amount paid is set once');
      await owner("update machvon.contract_advance set status = 'PLANNED', paid_vnd = 0, paid_on = null where id = $1::uuid", [advanceId]);
      expect(await owner('select status from machvon.contract_advance where id = $1::uuid', [advanceId])).toEqual([{ status: 'PLANNED' }]);
    });
  });
});

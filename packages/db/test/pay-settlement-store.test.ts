import { randomUUID } from 'node:crypto';
import type { MetricsSink } from '@machvon/kernel';
import { PayAdvanceStore } from '../src/pay-advance-store';
import { PayClaimStore } from '../src/pay-claim-store';
import { PayPaymentStore } from '../src/pay-payment-store';
import { PAY_MATCH_METRIC, PaySettlementStore } from '../src/pay-settlement-store';
import type { MatchOutcome } from '../src/pay-settlement-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, memberId } from './support/authz-fixtures';
import { AcceptanceWorld } from './support/acceptance-fixtures';
import type { SeededContract } from './support/acceptance-fixtures';

jest.setTimeout(600_000);

const fixtures = new AcceptanceWorld();
const counted: Array<{ name: string; outcome: string | undefined }> = [];
const metrics: MetricsSink = {
  increment: (name, labels) => void counted.push({ name, outcome: labels?.outcome }),
  gauge: () => undefined,
};
const settlements = new PaySettlementStore(metrics);
const payments = new PayPaymentStore();
const claims = new PayClaimStore();
const advances = new PayAdvanceStore();
const MAKER = 1;
const SENDER = 2;
const CHECKER = 3;
const MATCHER = 4;
const NOW = new Date('2026-07-25T05:00:00Z');
const TODAY = '2026-07-25';
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const readOnly: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const nothing: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) };

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

interface Request {
  id: string;
  contractId: string;
}

let counter = 0;
/** A payment request that is with the Treasury: gross 3bn (B01 2bn, B02 1bn), recovery 750m, retention 150m, net 2.1bn. */
async function sentToTreasury(): Promise<Request> {
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
  const made = await as((tx) => payments.create(tx, { contractId: contract.contractId, requestKind: 'INTERIM', acceptanceId: approved.acceptance.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-S-${counter}-${randomUUID().slice(0, 6)}` }, memberId(MAKER), everything, TODAY));
  const document = await fixtures.documentVersion();
  await as((tx) => payments.attachDocument(tx, made.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-S-${counter}-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-07-01' }, memberId(MAKER), everything, { mayOverride: () => false }));
  const sent = await as((tx) => claims.submit(tx, made.id, made.version, { expectedGrossVnd: made.grossVnd, expectedNetVnd: made.netVnd, requestId: randomUUID() }, memberId(SENDER), everything, TODAY), SENDER);
  await as((tx) => claims.verify(tx, made.id, sent.version, undefined, memberId(CHECKER), everything), CHECKER);
  await fixtures.sendToTreasury(made.id);
  return { id: made.id, contractId: contract.contractId };
}

/** A transaction the Treasury confirmed, as a callback leaves it, not yet matched. */
async function transaction(amount: string, options: { confirmedAt?: string; direction?: 'PAYMENT' | 'REFUND'; reversalOf?: string } = {}): Promise<string> {
  counter += 1;
  const id = randomUUID();
  await owner(
    `insert into machvon.treasury_transaction
       (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, row_hash, direction, reversal_of_id, document_no, document_date, source_kind, provider_event_id, match_status)
     values ($1, $2::uuid, $3::uuid, $4, 'MOCKKB', $5::numeric, $6::timestamptz, repeat('a', 64), repeat('a', 64), $7, $8::uuid, $9, date '2026-07-24', 'CALLBACK_MOCK', $10, 'UNMATCHED')`,
    [TENANT_A, id, fixtures.projectId, `CT-S-${counter}`, amount, options.confirmedAt ?? '2026-07-24T18:30:00Z', options.direction ?? 'PAYMENT', options.reversalOf ?? null, `CT-S-${counter}`, `EVT-S-${counter}`],
  );
  return id;
}

const match = (transactionId: string, paymentRequestId: string, scopes: ContractScopes = everything): Promise<MatchOutcome> =>
  as((tx) => settlements.match(tx, { transactionId, paymentRequestId, actor: memberId(MATCHER), requestId: randomUUID(), scopes, now: NOW }), MATCHER);

const requestRow = async (id: string) =>
  (
    await owner<{ status: string; paid_on: string | null; tx: string | null; by: string | null; version: string }>(
      'select status, treasury_paid_on::text as paid_on, settled_transaction_id as tx, settled_by as by, version::text from machvon.payment_request where id = $1::uuid',
      [id],
    )
  )[0];
const transactionRow = async (id: string) =>
  (await owner<{ match_status: string; payment_request_id: string | null; matched_by: string | null; matched_at: string | null }>('select match_status, payment_request_id, matched_by, matched_at::text from machvon.treasury_transaction where id = $1::uuid', [id]))[0];
const contractRow = async (id: string) =>
  (await owner<{ paid_total: string; advance_paid: string; advance_recovered: string; version: string }>('select paid_total_vnd::text as paid_total, advance_paid_vnd::text as advance_paid, advance_recovered_vnd::text as advance_recovered, version::text from machvon.contract where id = $1::uuid', [id]))[0];
const ledgerPaid = (contractId: string) =>
  owner<{ item: string; paid: string; requested: string }>(
    'select i.business_key as item, l.paid_vnd::text as paid, l.requested_vnd::text as requested from machvon.cumulative_ledger l join machvon.boq_item i on i.id = l.boq_item_id where l.contract_id = $1::uuid order by i.business_key',
    [contractId],
  );
const paymentEntries = (requestId: string) =>
  owner<{ entry_kind: string; paid: string; item: string }>(
    `select e.entry_kind, e.paid_delta_vnd::text as paid, i.business_key as item from machvon.cumulative_ledger_entry e join machvon.boq_item i on i.id = e.boq_item_id
      where e.payment_request_id = $1::uuid and e.entry_kind = 'PAYMENT' order by i.business_key`,
    [requestId],
  );
const itemsOf = (transactionId: string) =>
  owner<{ id: string; kind: string; status: string; internal: string; confirmed: string; difference: string; owner: string; due_at: string; payment_request_id: string }>(
    `select id, kind, status, internal_amount_vnd::text as internal, confirmed_amount_vnd::text as confirmed, difference_vnd::text as difference, owner_membership_id as owner, due_at::text,
            payment_request_id from machvon.reconciliation_item where treasury_transaction_id = $1::uuid order by created_at`,
    [transactionId],
  );

describe('matching a Treasury transaction to a payment request (ST-PAY-007)', () => {
  beforeAll(async () => {
    await fixtures.start();
    await fixtures.harness.seedMembership(TENANT_A, MATCHER, 1);
  }, 240_000);

  afterAll(async () => {
    await fixtures.stop();
  }, 60_000);

  describe('an amount that is the net of the request settles it (UAT-AC335, AC-ST-PAY-007-1)', () => {
    it('puts the gross of each balance paid on the ledger once, moves the paid total of the contract once and keeps the advance already recovered', async () => {
      const target = await sentToTreasury();
      const before = await contractRow(target.contractId);
      expect(before).toMatchObject({ paid_total: '0', advance_recovered: '750000000' });
      const confirmed = await transaction('2100000000');

      const done = await match(confirmed, target.id);

      expect(done).toMatchObject({
        kind: 'SETTLED',
        transactionId: confirmed,
        amountVnd: '2100000000',
        treasuryPaidOn: '2026-07-25',
        ledgerEntries: 2,
        advanceId: null,
        result: { id: target.id, status: 'SETTLED', fromStatus: 'SENT_TREASURY', grossVnd: '3000000000', netVnd: '2100000000' },
      });
      expect(await requestRow(target.id)).toMatchObject({ status: 'SETTLED', paid_on: '2026-07-25', tx: confirmed, by: memberId(MATCHER) });
      expect(await transactionRow(confirmed)).toMatchObject({ match_status: 'MATCHED', payment_request_id: target.id, matched_by: memberId(MATCHER) });
      expect((await transactionRow(confirmed))?.matched_at).not.toBeNull();
      expect(await ledgerPaid(target.contractId)).toEqual(expect.arrayContaining([expect.objectContaining({ item: 'B01', paid: '2000000000' }), expect.objectContaining({ item: 'B02', paid: '1000000000' })]));
      expect(await paymentEntries(target.id)).toEqual([
        { entry_kind: 'PAYMENT', paid: '2000000000', item: 'B01' },
        { entry_kind: 'PAYMENT', paid: '1000000000', item: 'B02' },
      ]);
      expect(await contractRow(target.contractId)).toMatchObject({ paid_total: '3000000000', advance_recovered: '750000000', advance_paid: '2000000000' });
      expect(counted).toContainEqual({ name: PAY_MATCH_METRIC, outcome: 'settled' });
    });

    it('counts the day in Vietnam time: a payment confirmed late at night in UTC is the next day', async () => {
      const early = await sentToTreasury();
      const late = await sentToTreasury();
      const first = await match(await transaction('2100000000', { confirmedAt: '2026-07-24T16:59:59.999999Z' }), early.id);
      const second = await match(await transaction('2100000000', { confirmedAt: '2026-07-24T17:00:00Z' }), late.id);
      expect([first, second].map((done) => (done.kind === 'SETTLED' ? done.treasuryPaidOn : done.kind))).toEqual(['2026-07-24', '2026-07-25']);
    });

    it('settles a request only once: the transaction cannot be matched again, to the same or to another request (UAT-AC335 step 4)', async () => {
      const target = await sentToTreasury();
      const other = await sentToTreasury();
      const confirmed = await transaction('2100000000');
      await match(confirmed, target.id);
      expect(await refusal(match(confirmed, other.id))).toMatchObject({ code: 'TRANSACTION_ALREADY_MATCHED', status: 409 });
      expect(await refusal(match(confirmed, target.id))).toMatchObject({ code: 'TRANSACTION_ALREADY_MATCHED', status: 409 });
      expect(await requestRow(other.id)).toMatchObject({ status: 'SENT_TREASURY', tx: null });
      expect(await contractRow(other.contractId)).toMatchObject({ paid_total: '0' });
      // Another transaction for the request that is settled does not settle it again.
      expect(await refusal(match(await transaction('2100000000'), target.id))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409, extensions: { status: 'SETTLED' } });
      expect(await contractRow(target.contractId)).toMatchObject({ paid_total: '3000000000' });
      expect(await paymentEntries(target.id)).toHaveLength(2);
    });

    it('settles two requests of one contract at the same time without losing a dong: the writers are serialised by the lock of the contract', async () => {
      const first = await sentToTreasury();
      const second = await sentToTreasury();
      const [a, b] = await Promise.all([match(await transaction('2100000000'), first.id), match(await transaction('2100000000'), second.id)]);
      expect([a.kind, b.kind]).toEqual(['SETTLED', 'SETTLED']);
      expect(await contractRow(first.contractId)).toMatchObject({ paid_total: '3000000000' });
      expect(await contractRow(second.contractId)).toMatchObject({ paid_total: '3000000000' });
    });

    it('lets two attempts to match one transaction to two requests end with one settlement', async () => {
      const first = await sentToTreasury();
      const second = await sentToTreasury();
      const confirmed = await transaction('2100000000');
      const results = await Promise.allSettled([match(confirmed, first.id), match(confirmed, second.id)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect((failed.reason as { code: string }).code).toBe('TRANSACTION_ALREADY_MATCHED');
      const settled = await owner<{ n: string }>("select count(*)::text as n from machvon.payment_request where id = any($1::uuid[]) and status = 'SETTLED'", [[first.id, second.id]]);
      expect(settled[0]?.n).toBe('1');
    });
  });

  describe('an amount that is not the net opens a difference and settles nothing (UAT-AC12, AC-ST-PAY-007-2)', () => {
    it('shows both figures and the signed difference, keeps the request with the Treasury and moves no money', async () => {
      const target = await sentToTreasury();
      const confirmed = await transaction('2090000000');
      const done = await match(confirmed, target.id);
      expect(done).toMatchObject({
        kind: 'MISMATCH',
        itemOpened: true,
        transactionId: confirmed,
        internalVnd: '2100000000',
        confirmedVnd: '2090000000',
        differenceVnd: '-10000000',
        ownerMembershipId: memberId(MATCHER),
        result: { id: target.id, status: 'SENT_TREASURY' },
      });
      const items = await itemsOf(confirmed);
      expect(items).toEqual([expect.objectContaining({ kind: 'AMOUNT_MISMATCH', status: 'OPEN', internal: '2100000000', confirmed: '2090000000', difference: '-10000000', owner: memberId(MATCHER), payment_request_id: target.id })]);
      expect(items[0]?.due_at).toBeTruthy();
      expect(await requestRow(target.id)).toMatchObject({ status: 'SENT_TREASURY', paid_on: null, tx: null });
      expect(await transactionRow(confirmed)).toMatchObject({ match_status: 'EXCEPTION', payment_request_id: target.id, matched_by: null });
      expect(await contractRow(target.contractId)).toMatchObject({ paid_total: '0' });
      expect(await paymentEntries(target.id)).toEqual([]);
      expect(counted).toContainEqual({ name: PAY_MATCH_METRIC, outcome: 'mismatch' });
    });

    it('never chooses the larger figure: a payment over the net is a positive difference, and nothing is settled either', async () => {
      const target = await sentToTreasury();
      const confirmed = await transaction('2200000000');
      expect(await match(confirmed, target.id)).toMatchObject({ kind: 'MISMATCH', differenceVnd: '100000000', internalVnd: '2100000000', confirmedVnd: '2200000000' });
      expect(await requestRow(target.id)).toMatchObject({ status: 'SENT_TREASURY' });
      expect(await contractRow(target.contractId)).toMatchObject({ paid_total: '0' });
    });

    it('is one difference for the pair however often the match is tried, and the second try tells the same item', async () => {
      const target = await sentToTreasury();
      const confirmed = await transaction('2090000000');
      const first = await match(confirmed, target.id);
      const again = await match(confirmed, target.id);
      expect(first.kind === 'MISMATCH' && again.kind === 'MISMATCH' && again.itemId === first.itemId && !again.itemOpened).toBe(true);
      expect(await itemsOf(confirmed)).toHaveLength(1);
    });

    it('keeps the transaction tied to the request it differs from: another request cannot take it', async () => {
      const target = await sentToTreasury();
      const other = await sentToTreasury();
      const confirmed = await transaction('2000000000');
      await match(confirmed, target.id);
      expect(await refusal(match(confirmed, other.id))).toMatchObject({ code: 'TRANSACTION_ALREADY_MATCHED', status: 409, extensions: { reason: 'TIED_TO_ANOTHER_REQUEST' } });
    });
  });

  describe('what the match refuses', () => {
    it('is 404 for a request or a transaction that is not there, and for a contract outside the scope of the caller', async () => {
      const target = await sentToTreasury();
      const confirmed = await transaction('2100000000');
      expect(await refusal(match(confirmed, randomUUID()))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(match(randomUUID(), target.id))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(match(confirmed, target.id, nothing))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(match(confirmed, target.id, readOnly))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(match('x', target.id))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'id' });
      expect(await refusal(match(confirmed, 'x'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'payment_request_id' });
      expect(await requestRow(target.id)).toMatchObject({ status: 'SENT_TREASURY' });
    });

    it('is 409 PAYMENT_STATE_INVALID for a request that is not with the Treasury', async () => {
      const target = await sentToTreasury();
      const confirmed = await transaction('2100000000');
      await owner("update machvon.payment_request set status = 'RETURNED', claims_acceptance = false, return_reason = 'x', returned_by = created_by, returned_at = now(), returned_by_treasury = true where id = $1::uuid", [target.id]);
      expect(await refusal(match(confirmed, target.id))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409, extensions: { status: 'RETURNED' } });
    });

    it('is 422 for a refund: only a payment settles a request', async () => {
      const target = await sentToTreasury();
      const paid = await transaction('2100000000');
      const other = await sentToTreasury();
      await match(paid, other.id);
      const refund = await transaction('100', { direction: 'REFUND', reversalOf: paid });
      expect(await refusal(match(refund, target.id))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'id', extensions: { reason: 'NOT_A_PAYMENT' } });
    });
  });

  describe('the database holds the rules when the application does not (V1567)', () => {
    it('refuses to settle a request without the transaction matched to it, for exactly its net', async () => {
      const target = await sentToTreasury();
      const refused = await databaseRefusal(owner("update machvon.payment_request set status = 'SETTLED', treasury_paid_on = date '2026-07-25', settled_by = created_by, settled_at = now() where id = $1::uuid", [target.id]));
      expect(refused.sqlstate).toBe('23514');
      const confirmed = await transaction('2100000000');
      const matched = await databaseRefusal(owner("update machvon.treasury_transaction set match_status = 'MATCHED', payment_request_id = $2::uuid, matched_at = now(), matched_by = $3::uuid where id = $1::uuid", [await transaction('2099999999'), target.id, memberId(MATCHER)]));
      expect(matched.message).toContain('TRANSACTION_NOT_MATCHABLE');
      // The right amount, but the request settled by a transaction that is not the one matched to it.
      await owner("update machvon.treasury_transaction set match_status = 'MATCHED', payment_request_id = $2::uuid, matched_at = now(), matched_by = $3::uuid where id = $1::uuid", [confirmed, target.id, memberId(MATCHER)]);
      const other = await sentToTreasury();
      const wrong = await databaseRefusal(
        owner("update machvon.payment_request set status = 'SETTLED', treasury_paid_on = date '2026-07-25', settled_transaction_id = $2::uuid, settled_by = created_by, settled_at = now() where id = $1::uuid", [other.id, confirmed]),
      );
      expect(wrong.message).toContain('TRANSACTION_NOT_MATCHABLE');
    });

    it('refuses a day of payment that is not the day the Treasury confirmed it, and a settlement that does not say who and when', async () => {
      const target = await sentToTreasury();
      const confirmed = await transaction('2100000000');
      await owner("update machvon.treasury_transaction set match_status = 'MATCHED', payment_request_id = $2::uuid, matched_at = now(), matched_by = $3::uuid where id = $1::uuid", [confirmed, target.id, memberId(MATCHER)]);
      const wrongDay = await databaseRefusal(
        owner("update machvon.payment_request set status = 'SETTLED', treasury_paid_on = date '2026-07-30', settled_transaction_id = $2::uuid, settled_by = created_by, settled_at = now() where id = $1::uuid", [target.id, confirmed]),
      );
      expect(wrongDay.message).toContain('the day a payment counts from');
      const anonymous = await databaseRefusal(owner("update machvon.payment_request set status = 'SETTLED', treasury_paid_on = date '2026-07-25', settled_transaction_id = $2::uuid where id = $1::uuid", [target.id, confirmed]));
      expect(anonymous.message).toContain('payment_request_settled_chk');
    });

    it('keeps what settled a request, and a settled request without a transaction cannot exist', async () => {
      const target = await sentToTreasury();
      const confirmed = await transaction('2100000000');
      await match(confirmed, target.id);
      expect((await databaseRefusal(owner('update machvon.payment_request set treasury_paid_on = date \'2026-07-26\' where id = $1::uuid', [target.id]))).message).toContain('what settled a request is kept as it is');
      expect((await databaseRefusal(owner('update machvon.treasury_transaction set amount_vnd = 5 where id = $1::uuid', [confirmed]))).message).toContain('keeps what it says');
      expect((await databaseRefusal(owner("update machvon.treasury_transaction set match_status = 'EXCEPTION' where id = $1::uuid", [confirmed]))).message).toContain('TRANSACTION_ALREADY_MATCHED');
      const loose = await databaseRefusal(owner("update machvon.payment_request set status = 'SENT_TREASURY' where id = $1::uuid", [target.id]));
      expect(loose.sqlstate).toBe('23514');
    });

    it('lets one transaction settle one request: a second transaction cannot be matched to a request that has a matched one', async () => {
      const target = await sentToTreasury();
      const first = await transaction('2100000000');
      await owner("update machvon.treasury_transaction set match_status = 'MATCHED', payment_request_id = $2::uuid, matched_at = now(), matched_by = $3::uuid where id = $1::uuid", [first, target.id, memberId(MATCHER)]);
      const second = await transaction('2100000000');
      const refused = await databaseRefusal(owner("update machvon.treasury_transaction set match_status = 'MATCHED', payment_request_id = $2::uuid, matched_at = now(), matched_by = $3::uuid where id = $1::uuid", [second, target.id, memberId(MATCHER)]));
      expect(refused.sqlstate).toBe('23505');
    });

    it('settles on the line of capital of the year the request was asked for: the year of the line is judged again at the settlement (AC-ST-PAY-007-4, UAT-AC342)', async () => {
      const target = await sentToTreasury();
      const confirmed = await transaction('2100000000');
      // The request carries the year it was asked for; the line of capital it stands on is of another year (a state the commands of PAY never leave, so the guard is switched off to make it).
      await fixtures.harness.owner(TENANT_A, [
        ['alter table machvon.payment_request disable trigger payment_request_guard', []],
        ['update machvon.payment_request set plan_year = plan_year - 1 where id = $1::uuid', [target.id]],
        ['alter table machvon.payment_request enable trigger payment_request_guard', []],
      ]);
      expect(await refusal(match(confirmed, target.id))).toMatchObject({ code: 'PLAN_YEAR_MISMATCH', status: 422 });
      expect(await requestRow(target.id)).toMatchObject({ status: 'SENT_TREASURY' });
      expect(await transactionRow(confirmed)).toMatchObject({ match_status: 'UNMATCHED' });
      expect(await contractRow(target.contractId)).toMatchObject({ paid_total: '0' });
    });
  });

  describe('the refusals of the database in the words of the contract', () => {
    const tell = (error: unknown): unknown => (settlements as unknown as { mapRefusal(error: unknown): unknown }).mapRefusal(error);

    it('names the rule that a check refused, and leaves any other failure as it is', () => {
      expect(tell({ code: '23514', message: 'PLAN_YEAR_MISMATCH: a payment' })).toMatchObject({ code: 'PLAN_YEAR_MISMATCH', status: 422 });
      expect(tell({ code: '23514', message: 'TRANSACTION_ALREADY_MATCHED: a Treasury transaction is tied' })).toMatchObject({ code: 'TRANSACTION_ALREADY_MATCHED', status: 409 });
      expect(tell({ code: '23514', message: 'TRANSACTION_NOT_MATCHABLE: a request' })).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409, extensions: { reason: 'TRANSACTION_NOT_MATCHABLE' } });
      expect(tell({ code: '23514', message: 'ADVANCE_STATE_INVALID: an advance request' })).toMatchObject({ code: 'ADVANCE_STATE_INVALID', status: 409 });
      const other = { code: '23514', message: 'something else' };
      expect(tell(other)).toBe(other);
      const unrelated = { code: '40001', message: 'serialization failure' };
      expect(tell(unrelated)).toBe(unrelated);
      expect(tell({ code: '23514' })).toEqual({ code: '23514' });
    });
  });

  describe('the payment of an advance (PAY 3.2 step 2)', () => {
    async function advanceRequest(): Promise<{ id: string; contract: SeededContract; advanceId: string }> {
      const contract = await fixtures.seedContract();
      await owner('update machvon.contract set advance_category = $2, contract_value_vnd = $3::numeric, estimate_ceiling_vnd = null where id = $1::uuid', [contract.contractId, 'CONSTRUCTION', '10000000000']);
      await owner('update machvon.contract_party set work_value_vnd = $2::numeric where contract_id = $1::uuid', [contract.contractId, '10000000000']);
      const planned = await as((tx) =>
        advances.request(tx, contract.contractId, { partyId: contract.partyId, kind: 'GPMB', amountVnd: '1000000000', allocationLineId: fixtures.lineId }, memberId(MAKER), everything, NOW),
      );
      const made = await as((tx) => payments.create(tx, { contractId: contract.contractId, requestKind: 'ADVANCE', advanceId: planned.view.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-AS-${randomUUID().slice(0, 8)}` }, memberId(MAKER), everything, TODAY));
      const sent = await as((tx) => claims.submit(tx, made.id, made.version, { expectedGrossVnd: made.grossVnd, expectedNetVnd: made.netVnd, requestId: randomUUID() }, memberId(SENDER), everything, TODAY), SENDER);
      await as((tx) => claims.verify(tx, made.id, sent.version, undefined, memberId(CHECKER), everything), CHECKER);
      await fixtures.sendToTreasury(made.id);
      return { id: made.id, contract, advanceId: planned.view.id };
    }
    const advanceRow = async (id: string) =>
      (await owner<{ status: string; paid: string; paid_on: string | null; deadline: string | null }>('select status, paid_vnd::text as paid, paid_on::text, recovery_deadline::text as deadline from machvon.contract_advance where id = $1::uuid', [id]))[0];

    it('pays the advance on the day the Treasury confirmed it, fixes the last day of a land clearance advance from the rule of that day and puts the money out on the contract', async () => {
      const target = await advanceRequest();
      const done = await match(await transaction('1000000000'), target.id);
      expect(done).toMatchObject({ kind: 'SETTLED', ledgerEntries: 0, advanceId: target.advanceId, treasuryPaidOn: '2026-07-25', result: { requestKind: 'ADVANCE', status: 'SETTLED' } });
      expect(await advanceRow(target.advanceId)).toEqual({ status: 'PAID', paid: '1000000000', paid_on: '2026-07-25', deadline: '2026-08-24' });
      expect(await contractRow(target.contract.contractId)).toMatchObject({ advance_paid: '1000000000', paid_total: '0' });
      expect(
        await owner('select entry_kind, amount_vnd::text as amount, outstanding_after_vnd::text as outstanding, payment_request_id from machvon.advance_ledger_entry where advance_id = $1::uuid', [target.advanceId]),
      ).toEqual([{ entry_kind: 'DISBURSE', amount: '1000000000', outstanding: '1000000000', payment_request_id: target.id }]);
    });

    it('opens a difference for an advance in the same way and pays nothing', async () => {
      const target = await advanceRequest();
      const done = await match(await transaction('990000000'), target.id);
      expect(done).toMatchObject({ kind: 'MISMATCH', differenceVnd: '-10000000' });
      expect(await advanceRow(target.advanceId)).toMatchObject({ status: 'REQUESTED', paid: '0' });
      expect(await contractRow(target.contract.contractId)).toMatchObject({ advance_paid: '0' });
    });

    it('refuses to settle when the advance is no longer the one that was asked for', async () => {
      const target = await advanceRequest();
      const confirmed = await transaction('1000000000');
      await owner("update machvon.contract_advance set status = 'CANCELLED' where id = $1::uuid", [target.advanceId]);
      expect(await refusal(match(confirmed, target.id))).toMatchObject({ code: 'ADVANCE_STATE_INVALID', status: 409 });
      expect(await requestRow(target.id)).toMatchObject({ status: 'SENT_TREASURY' });
    });
  });
});

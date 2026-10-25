import { randomUUID } from 'node:crypto';
import type { MetricsSink } from '@machvon/kernel';
import { PayClaimStore } from '../src/pay-claim-store';
import { PayLedgerStore } from '../src/pay-ledger-store';
import { PayPaymentStore } from '../src/pay-payment-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, memberId } from './support/authz-fixtures';
import { AcceptanceWorld } from './support/acceptance-fixtures';
import type { ApprovedAcceptance } from './support/acceptance-fixtures';

jest.setTimeout(600_000);

const fixtures = new AcceptanceWorld();
const payments = new PayPaymentStore();
const MAKER = 1;
const SENDER = 2;
const CHECKER = 3;
const TODAY = '2026-07-25';
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const readOnly: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };
let counter = 0;

const counted = new Map<string, number>();
const gauged = new Map<string, number>();
const metrics: MetricsSink = {
  increment: (name, labels) => void counted.set(`${name}${labels === undefined ? '' : JSON.stringify(labels)}`, (counted.get(`${name}${labels === undefined ? '' : JSON.stringify(labels)}`) ?? 0) + 1),
  gauge: (name, value) => void gauged.set(name, value),
};
const claims = new PayClaimStore(metrics);
const unchecked = new PayClaimStore(metrics, { applicationChecks: false });

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

interface Ready {
  approved: ApprovedAcceptance;
  id: string;
  version: number;
  gross: string;
  net: string;
}

/**
 * A contract whose sole party's work is worth 10bn, with an advance of 2bn paid (also on the header), an approved acceptance of 3bn, and a draft of a payment request for it with an invoice
 * attached: gross 3bn, recovery 750m, retention 150m, net 2.1bn.
 */
async function ready(options: { withInvoice?: boolean; advance?: boolean } = {}): Promise<Ready> {
  counter += 1;
  const contract = await fixtures.seedContract();
  await owner('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [contract.contractId]);
  if (options.advance !== false) {
    await owner('update machvon.contract set advance_paid_vnd = 2000000000 where id = $1::uuid', [contract.contractId]);
    await owner(
      `insert into machvon.contract_advance
         (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
       values ($1, gen_random_uuid(), $2, $3, 1, 'GPMB', 2000000000, 2000000000, 'PAID', 2000000000, date '2026-06-01', 80, date '2026-12-31', $4, $4)`,
      [TENANT_A, contract.contractId, contract.partyId, memberId(MAKER)],
    );
  }
  const approved = await fixtures.approve(contract, [
    { item: 0, quantity: '2000' },
    { item: 1, quantity: '500' },
  ]);
  const made = await as((tx) => payments.create(tx, { contractId: contract.contractId, requestKind: 'INTERIM', acceptanceId: approved.acceptance.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-C-${counter}-${randomUUID().slice(0, 6)}` }, memberId(MAKER), everything, TODAY));
  if (options.withInvoice !== false) {
    const document = await fixtures.documentVersion();
    await as((tx) =>
      payments.attachDocument(tx, made.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-C-${counter}-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-07-01' }, memberId(MAKER), everything, { mayOverride: () => false }),
    );
  }
  return { approved, id: made.id, version: made.version, gross: made.grossVnd, net: made.netVnd };
}

const submit = (target: Ready, options: { member?: number; version?: number; gross?: string; net?: string; scopes?: ContractScopes; store?: PayClaimStore } = {}) =>
  as(
    (tx) =>
      (options.store ?? claims).submit(tx, target.id, options.version ?? target.version, { expectedGrossVnd: options.gross ?? target.gross, expectedNetVnd: options.net ?? target.net, requestId: randomUUID() }, memberId(options.member ?? SENDER), options.scopes ?? everything, TODAY),
    options.member ?? SENDER,
  );
const verify = (id: string, version: number, member = CHECKER, note?: string, scopes: ContractScopes = everything) => as((tx) => claims.verify(tx, id, version, note, memberId(member), scopes), member);
const giveBack = (id: string, version: number, reason = 'The invoice is wrong.', options: { member?: number; treasury?: boolean } = {}) =>
  as((tx) => claims.returnRequest(tx, id, version, { reason, returnedByTreasury: options.treasury, requestId: randomUUID() }, memberId(options.member ?? CHECKER), everything), options.member ?? CHECKER);

const requestRow = async (id: string) =>
  (await owner<{ status: string; version: string; claims_acceptance: boolean; submitted_by: string | null; verified_by: string | null; returned_by: string | null; return_reason: string | null; verification_note: string | null }>(
    'select status, version::text, claims_acceptance, submitted_by, verified_by, returned_by, return_reason, verification_note from machvon.payment_request where id = $1::uuid',
    [id],
  ))[0];
const contractRow = async (contractId: string) =>
  (await owner<{ requested: string; recovered: string; held: string; version: string }>(
    'select requested_total_vnd::text as requested, advance_recovered_vnd::text as recovered, retention_held_vnd::text as held, version::text from machvon.contract where id = $1::uuid',
    [contractId],
  ))[0];
const entriesOf = (id: string) =>
  owner<{ entry_kind: string; requested: string; recovered: string; retention: string; reversal: boolean }>(
    `select entry_kind, requested_delta_vnd::text as requested, advance_recovery_delta_vnd::text as recovered, retention_delta_vnd::text as retention, reversal_of_id is not null as reversal
       from machvon.cumulative_ledger_entry where payment_request_id = $1::uuid order by entry_kind, requested_delta_vnd, advance_recovery_delta_vnd, retention_delta_vnd`,
    [id],
  );
const balancesOf = (acceptanceId: string) =>
  owner<{ requested: string; recovered: string; held: string }>(
    'select requested_vnd::text as requested, advance_recovered_vnd::text as recovered, retention_held_vnd::text as held from machvon.cumulative_ledger where acceptance_id = $1::uuid order by requested_vnd desc',
    [acceptanceId],
  );
const trancheOf = async (contractId: string) =>
  (await owner<{ recovered: string; status: string }>('select recovered_vnd::text as recovered, status from machvon.contract_advance where contract_id = $1::uuid', [contractId]))[0];

describe('sending, checking and returning a payment request (ST-PAY-003)', () => {
  beforeAll(async () => {
    await fixtures.start();
  }, 240_000);

  afterAll(async () => {
    await fixtures.stop();
  }, 60_000);

  describe('sending', () => {
    it('takes the claim and puts the request on the ledger, the contract, the advance and the holds of retention, in one transaction', async () => {
      const target = await ready();
      const sent = await submit(target);
      expect(sent).toMatchObject({ status: 'SUBMITTED', fromStatus: 'DRAFT', version: target.version + 1, grossVnd: '3000000000', netVnd: '2100000000' });
      expect(await requestRow(target.id)).toMatchObject({ status: 'SUBMITTED', claims_acceptance: true, submitted_by: memberId(SENDER) });
      expect(await contractRow(target.approved.contract.contractId)).toMatchObject({ requested: '3000000000', recovered: '750000000', held: '150000000' });
      expect(await balancesOf(target.approved.acceptance.id)).toEqual([
        { requested: '2000000000', recovered: '500000000', held: '100000000' },
        { requested: '1000000000', recovered: '250000000', held: '50000000' },
      ]);
      expect(await entriesOf(target.id)).toEqual([
        { entry_kind: 'ADVANCE_RECOVERY', requested: '0', recovered: '250000000', retention: '0', reversal: false },
        { entry_kind: 'ADVANCE_RECOVERY', requested: '0', recovered: '500000000', retention: '0', reversal: false },
        { entry_kind: 'CLAIM', requested: '1000000000', recovered: '0', retention: '0', reversal: false },
        { entry_kind: 'CLAIM', requested: '2000000000', recovered: '0', retention: '0', reversal: false },
        { entry_kind: 'RETENTION_HOLD', requested: '0', recovered: '0', retention: '100000000', reversal: false },
        { entry_kind: 'RETENTION_HOLD', requested: '0', recovered: '0', retention: '50000000' , reversal: false },
      ].sort((a, b) => (a.entry_kind === b.entry_kind ? Number(BigInt(a.requested) - BigInt(b.requested)) || Number(BigInt(a.recovered) - BigInt(b.recovered)) || Number(BigInt(a.retention) - BigInt(b.retention)) : a.entry_kind < b.entry_kind ? -1 : 1)));
      expect(await trancheOf(target.approved.contract.contractId)).toEqual({ recovered: '750000000', status: 'RECOVERING' });
      expect(await owner('select amount_vnd::text, entry_kind, outstanding_after_vnd::text from machvon.advance_ledger_entry where payment_request_id = $1::uuid', [target.id])).toEqual([{ amount_vnd: '750000000', entry_kind: 'RECOVER', outstanding_after_vnd: '1250000000' }]);
      expect((await owner<{ held_vnd: string; release_condition: string; status: string }>('select held_vnd::text, release_condition, status from machvon.retention_hold where payment_request_id = $1::uuid order by retention_hold.held_vnd desc', [target.id]))).toEqual([
        { held_vnd: '100000000', release_condition: 'COMPLETION', status: 'HELD' },
        { held_vnd: '50000000', release_condition: 'COMPLETION', status: 'HELD' },
      ]);
    });

    it('AC-ST-PAY-003-6: puts the acceptance on the ledger itself when the consumer of its approval has not run, and the consumer later posts nothing a second time', async () => {
      const target = await ready();
      expect(await balancesOf(target.approved.acceptance.id)).toEqual([]);
      await submit(target);
      expect(await owner('select 1 from machvon.cumulative_ledger_entry where acceptance_id = $1::uuid and entry_kind = $2', [target.approved.acceptance.id, 'RECOGNIZE_ACCEPTANCE'])).toHaveLength(2);
      const later = await as((tx) => new PayLedgerStore().recognize(tx, { acceptanceId: target.approved.acceptance.id, requestId: randomUUID(), actor: memberId(MAKER) }));
      expect(later).toMatchObject({ outcome: 'unchanged', entries: 0 });
    });

    it('AC-ST-PAY-003-3, UAT-AC322: returned and sent again, the ledger tells CLAIM, then the CLAIM_RELEASE that reverses it, then a new CLAIM; nothing is updated or deleted', async () => {
      const target = await ready();
      await submit(target);
      gauged.clear();
      const returned = await giveBack(target.id, target.version + 1);
      // The wait for the lock of the contract is measured on the way (alert PAY_LEDGER_LOCK_WAIT, above 2 s).
      expect(gauged.get('pay_ledger_lock_wait_seconds')).toBeGreaterThanOrEqual(0);
      expect(returned).toMatchObject({ status: 'RETURNED', fromStatus: 'SUBMITTED', version: target.version + 2 });
      expect(await requestRow(target.id)).toMatchObject({ status: 'RETURNED', claims_acceptance: false, returned_by: memberId(CHECKER), return_reason: 'The invoice is wrong.' });
      // Everything it put on the books is back, and what stands on the ledger is the entries that undid it.
      expect(await contractRow(target.approved.contract.contractId)).toMatchObject({ requested: '0', recovered: '0', held: '0' });
      expect(await balancesOf(target.approved.acceptance.id)).toEqual([
        { requested: '0', recovered: '0', held: '0' },
        { requested: '0', recovered: '0', held: '0' },
      ]);
      expect(await trancheOf(target.approved.contract.contractId)).toEqual({ recovered: '0', status: 'PAID' });
      expect(await owner('select 1 from machvon.retention_hold where payment_request_id = $1::uuid', [target.id])).toEqual([]);
      const kinds = (await entriesOf(target.id)).map((entry) => `${entry.entry_kind}${entry.reversal ? '*' : ''}`).sort();
      expect(kinds).toEqual(['ADVANCE_RECOVERY', 'ADVANCE_RECOVERY', 'ADVANCE_RECOVERY_REVERSAL*', 'ADVANCE_RECOVERY_REVERSAL*', 'CLAIM', 'CLAIM', 'CLAIM_RELEASE*', 'CLAIM_RELEASE*', 'RETENTION_HOLD', 'RETENTION_HOLD', 'RETENTION_RELEASE', 'RETENTION_RELEASE']);
      expect(await owner<{ entry_kind: string }>('select entry_kind from machvon.advance_ledger_entry where payment_request_id = $1::uuid order by entry_kind', [target.id])).toEqual([{ entry_kind: 'RECOVER' }, { entry_kind: 'REVERSE_RECOVER' }]);
      // The reversal says which entry it reverses and is exactly its opposite.
      const pairs = await owner<{ claim: string; release: string }>(
        `select c.requested_delta_vnd::text as claim, r.requested_delta_vnd::text as release from machvon.cumulative_ledger_entry r
           join machvon.cumulative_ledger_entry c on c.id = r.reversal_of_id where r.payment_request_id = $1::uuid and r.entry_kind = 'CLAIM_RELEASE' order by c.requested_delta_vnd`,
        [target.id],
      );
      expect(pairs).toEqual([
        { claim: '1000000000', release: '-1000000000' },
        { claim: '2000000000', release: '-2000000000' },
      ]);
      // It is revised and sent again: the claim is laid on the acceptance once more.
      const revised = await as((tx) => payments.revise(tx, target.id, target.version + 2, {}, memberId(MAKER), everything, TODAY));
      expect(revised).toMatchObject({ status: 'DRAFT', fromStatus: 'RETURNED', netVnd: '2100000000' });
      await submit({ ...target, version: revised.version });
      expect((await entriesOf(target.id)).filter((entry) => entry.entry_kind === 'CLAIM')).toHaveLength(4);
      expect(await requestRow(target.id)).toMatchObject({ status: 'SUBMITTED', claims_acceptance: true });
      expect(await contractRow(target.approved.contract.contractId)).toMatchObject({ requested: '3000000000', recovered: '750000000', held: '150000000' });
      // Returned a second time, the retention it held again is let go again (the release of the first round does not stand for it).
      const again = await giveBack(target.id, revised.version + 1);
      expect(again).toMatchObject({ status: 'RETURNED', fromStatus: 'SUBMITTED' });
      expect(await contractRow(target.approved.contract.contractId)).toMatchObject({ requested: '0', recovered: '0', held: '0' });
      expect(await balancesOf(target.approved.acceptance.id)).toEqual([
        { requested: '0', recovered: '0', held: '0' },
        { requested: '0', recovered: '0', held: '0' },
      ]);
      expect((await entriesOf(target.id)).filter((entry) => entry.entry_kind === 'RETENTION_RELEASE')).toHaveLength(4);
      // Not one entry of the ledger can be changed or deleted, by the application or by anyone else.
      expect((await databaseRefusal(owner('update machvon.cumulative_ledger_entry set reason = $2 where payment_request_id = $1::uuid', [target.id, 'x']))).message).toContain('LEDGER_ENTRY_IMMUTABLE');
      expect((await databaseRefusal(owner('delete from machvon.advance_ledger_entry where payment_request_id = $1::uuid', [target.id]))).message).toContain('LEDGER_ENTRY_IMMUTABLE');
      expect((await databaseRefusal(as((tx) => tx.query('update machvon.advance_ledger_entry set reason = $2 where payment_request_id = $1::uuid', [target.id, 'x'])))).sqlstate).toBe('42501');
    });

    it('refuses what is not ready to be sent, in the order the spec names, and leaves nothing behind', async () => {
      const target = await ready();
      const before = async () => ({ contract: await contractRow(target.approved.contract.contractId), balances: await balancesOf(target.approved.acceptance.id), request: await requestRow(target.id) });
      const start = await before();
      expect(await refusal(submit(target, { version: target.version + 5 }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      // A screen that is out of date is told what the request is worth now.
      expect(await refusal(submit(target, { gross: '2999999999' }))).toMatchObject({ code: 'PAYMENT_NET_MISMATCH', status: 422, extensions: { gross_vnd: '3000000000', net_vnd: '2100000000' } });
      expect(await refusal(submit(target, { net: '1' }))).toMatchObject({ code: 'PAYMENT_NET_MISMATCH' });
      expect(await refusal(submit(target, { gross: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'expected_gross_vnd' });
      expect(await refusal(submit(target, { scopes: readOnly }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(as((tx) => claims.submit(tx, randomUUID(), 1, { expectedGrossVnd: '1', expectedNetVnd: '1', requestId: randomUUID() }, memberId(SENDER), everything, TODAY)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      const bare = await ready({ withInvoice: false });
      expect(await refusal(submit(bare))).toMatchObject({ code: 'INVOICE_REQUIRED', status: 422 });
      expect(await before()).toEqual(start);
      // The state of the contract is judged when the request is sent too.
      const paper = (await fixtures.documentVersion()).id;
      await owner("update machvon.contract set status = 'SUSPENDED', status_reason = 'Stopped.', status_decision_document_version_id = $2::uuid, suspended_from = date '2026-01-01' where id = $1::uuid", [target.approved.contract.contractId, paper]);
      expect(await refusal(submit(target))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { reason: 'ACCEPTED_AFTER_SUSPENSION' } });
      expect(await before()).toEqual(start);
    });

    it('AC-ST-PAY-003-7, UAT-AC344: a suspended contract takes an interim request for an acceptance approved before it was suspended and no other; a terminated one takes an interim request no more', async () => {
      const paper = (await fixtures.documentVersion()).id;
      const before = await ready();
      await owner("update machvon.contract set status = 'SUSPENDED', status_reason = 'Stopped.', status_decision_document_version_id = $2::uuid, suspended_from = date '2099-01-01' where id = $1::uuid", [before.approved.contract.contractId, paper]);
      expect(await submit(before)).toMatchObject({ status: 'SUBMITTED' });
      const after = await ready();
      await owner("update machvon.contract set status = 'SUSPENDED', status_reason = 'Stopped.', status_decision_document_version_id = $2::uuid, suspended_from = date '2026-01-01' where id = $1::uuid", [after.approved.contract.contractId, paper]);
      expect(await refusal(submit(after))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', extensions: { reason: 'ACCEPTED_AFTER_SUSPENSION' } });
      const ended = await ready();
      await owner("update machvon.contract set status = 'TERMINATED', status_reason = 'Ended.', status_decision_document_version_id = $2::uuid, terminated_on = date '2099-01-01' where id = $1::uuid", [ended.approved.contract.contractId, paper]);
      expect(await refusal(submit(ended))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409 });
      expect(await requestRow(ended.id)).toMatchObject({ status: 'DRAFT', claims_acceptance: false });
    });

    it('is refused for a request that is not a draft, for an acceptance that was revoked since, and for a line of capital with too little left', async () => {
      const target = await ready();
      await submit(target);
      expect(await refusal(submit({ ...target, version: target.version + 1 }))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409, extensions: { status: 'SUBMITTED' } });
      const revoked = await ready();
      await fixtures.revoke(revoked.approved);
      expect(await refusal(submit(revoked))).toMatchObject({ code: 'ACCEPTANCE_NOT_APPROVED', status: 422 });
      expect(await owner('select 1 from machvon.cumulative_ledger_entry where acceptance_id = $1::uuid', [revoked.approved.acceptance.id])).toEqual([]);
      // A line with too little left: UAT-AC342 steps 2 (nothing on the ledger after the refusal).
      const poor = await fixtures.world.publishedLine({ allocated: '1000000000' });
      const contract = await fixtures.seedContract({ projectId: poor.projectId, lineId: poor.lineId });
      const approved = await fixtures.approve(contract, [
        { item: 0, quantity: '2000' },
        { item: 1, quantity: '500' },
      ]);
      const made = await as((tx) => payments.create(tx, { contractId: contract.contractId, requestKind: 'INTERIM', acceptanceId: approved.acceptance.id, allocationLineId: poor.lineId, requestNo: `DNTT-LOW-${counter}` }, memberId(MAKER), everything, TODAY));
      const document = await fixtures.documentVersion();
      await as((tx) => payments.attachDocument(tx, made.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-LOW-${counter}`, invoiceDate: '2026-07-01' }, memberId(MAKER), everything, { mayOverride: () => false }));
      expect(await refusal(submit({ approved, id: made.id, version: made.version, gross: made.grossVnd, net: made.netVnd }))).toMatchObject({
        code: 'ALLOCATION_UNAVAILABLE',
        status: 422,
        extensions: { reason: 'INSUFFICIENT', available_vnd: '1000000000' },
      });
      expect(await owner('select 1 from machvon.cumulative_ledger_entry where acceptance_id = $1::uuid', [approved.acceptance.id])).toEqual([]);
      expect(await requestRow(made.id)).toMatchObject({ status: 'DRAFT', claims_acceptance: false });
    });

    it('AC-ST-PAY-003-4, UAT-AC330: a payment that would go above what the contract accepted is 409 VALUE_EXCEEDED with no change on the ledger, and the refusal is counted', async () => {
      const target = await ready();
      await owner('update machvon.contract set accepted_total_vnd = 1000000000 where id = $1::uuid', [target.approved.contract.contractId]);
      counted.clear();
      const refused = await refusal(submit(target));
      expect(refused).toMatchObject({ code: 'VALUE_EXCEEDED', status: 409, extensions: { rule: 'contract_ledger_order_chk' } });
      expect(counted.get('pay_value_exceeded_total{"rule":"contract_ledger_order_chk"}')).toBe(1);
      expect(counted.get('pay_submit_total{"outcome":"refused","problem_code":"VALUE_EXCEEDED"}')).toBe(1);
      expect(await owner('select 1 from machvon.cumulative_ledger_entry where acceptance_id = $1::uuid', [target.approved.acceptance.id])).toEqual([]);
      expect(await contractRow(target.approved.contract.contractId)).toMatchObject({ requested: '0', recovered: '0', held: '0' });
      expect(await requestRow(target.id)).toMatchObject({ status: 'DRAFT', claims_acceptance: false, submitted_by: null });
    });

    it('is 422 ADVANCE_RECOVERY_EXCEEDED when the advance has less outstanding than the request recovers', async () => {
      const target = await ready();
      // Another request recovered the advance in the meantime: the tranche holds less than this draft takes.
      await owner('update machvon.contract set advance_recovered_vnd = 1900000000 where id = $1::uuid', [target.approved.contract.contractId]);
      await owner('update machvon.contract_advance set recovered_vnd = 1900000000, status = $2 where contract_id = $1::uuid', [target.approved.contract.contractId, 'RECOVERING']);
      expect(await refusal(submit(target))).toMatchObject({ code: 'ADVANCE_RECOVERY_EXCEEDED', status: 422, extensions: { short_by_vnd: '650000000' } });
      expect(await requestRow(target.id)).toMatchObject({ status: 'DRAFT' });
    });

    it('sends a request without an advance with nothing taken from any tranche, and recovers across tranches, the earliest first', async () => {
      const plain = await ready({ advance: false });
      const sent = await submit(plain);
      expect(sent).toMatchObject({ status: 'SUBMITTED', advanceRecoveryVnd: '0', netVnd: '2850000000' });
      expect(await owner('select 1 from machvon.advance_ledger_entry where payment_request_id = $1::uuid', [plain.id])).toEqual([]);
      expect((await entriesOf(plain.id)).map((entry) => entry.entry_kind)).toEqual(['CLAIM', 'CLAIM', 'RETENTION_HOLD', 'RETENTION_HOLD']);
      // Two tranches of 500m each at the same threshold: the formula wants 750m, which takes all of the first and half of the second.
      const split = await ready({ advance: false });
      await owner('update machvon.contract set advance_paid_vnd = 1000000000 where id = $1::uuid', [split.approved.contract.contractId]);
      for (const n of [1, 2]) {
        await owner(
          `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
           values ($1, gen_random_uuid(), $2, $3, $4, 'GPMB', 500000000, 500000000, 'PAID', 500000000, date '2026-06-01', 80, date '2026-12-31', $5, $5)`,
          [TENANT_A, split.approved.contract.contractId, split.approved.contract.partyId, n, memberId(MAKER)],
        );
      }
      const revised = await as((tx) => payments.revise(tx, split.id, split.version, { advanceRecoveryExtraVnd: '300000000' }, memberId(MAKER), everything, TODAY));
      // The formula takes 187.5m of each tranche (3/8 of 500m); with the extra 300m asked for, 675m comes out: all of the first tranche and 175m of the second.
      expect(revised.advanceRecoveryVnd).toBe('675000000');
      await submit({ ...split, version: revised.version, gross: revised.grossVnd, net: revised.netVnd });
      expect(await owner<{ tranche_no: number; recovered: string; status: string }>('select tranche_no, recovered_vnd::text as recovered, status from machvon.contract_advance where contract_id = $1::uuid order by tranche_no', [split.approved.contract.contractId])).toEqual([
        { tranche_no: 1, recovered: '500000000', status: 'FULLY_RECOVERED' },
        { tranche_no: 2, recovered: '175000000', status: 'RECOVERING' },
      ]);
      expect(await owner<{ amount: string }>("select amount_vnd::text as amount from machvon.advance_ledger_entry where payment_request_id = $1::uuid and entry_kind = 'RECOVER' order by amount_vnd::numeric desc", [split.id])).toEqual([{ amount: '500000000' }, { amount: '175000000' }]);
    });
  });

  describe('two people sending at once', () => {
    /** Two drafts of one acceptance by two people, each with an invoice. */
    async function pair(): Promise<{ first: Ready; second: Ready }> {
      const first = await ready();
      const made = await as((tx) => payments.create(tx, { contractId: first.approved.contract.contractId, requestKind: 'INTERIM', acceptanceId: first.approved.acceptance.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-P-${counter}-${randomUUID().slice(0, 6)}` }, memberId(CHECKER), everything, TODAY), CHECKER);
      const document = await fixtures.documentVersion();
      await as(
        (tx) => payments.attachDocument(tx, made.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-P-${counter}-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-07-01' }, memberId(CHECKER), everything, { mayOverride: () => false }),
        CHECKER,
      );
      return { first, second: { ...first, id: made.id, version: made.version, gross: made.grossVnd, net: made.netVnd } };
    }

    it('AC-ST-PAY-003-1, UAT-AC320: of two requests sent together for one acceptance, with different people and different keys, exactly one wins and the other is 409 ACCEPTANCE_ALREADY_CLAIMED, over thirty rounds', async () => {
      for (let round = 0; round < 30; round += 1) {
        const { first, second } = await pair();
        const outcomes = await Promise.allSettled([submit(first, { member: SENDER }), submit(second, { member: 4 })]);
        const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
        const lost = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
        expect(won).toHaveLength(1);
        expect(lost.map((outcome) => (outcome.reason as { code: string }).code)).toEqual(['ACCEPTANCE_ALREADY_CLAIMED']);
        // The ledger took the request once: what was requested is the gross, once, and there is one claim for each item.
        expect(await balancesOf(first.approved.acceptance.id)).toEqual([
          { requested: '2000000000', recovered: '500000000', held: '100000000' },
          { requested: '1000000000', recovered: '250000000', held: '50000000' },
        ]);
        expect(await owner('select 1 from machvon.cumulative_ledger_entry where acceptance_id = $1::uuid and entry_kind = $2', [first.approved.acceptance.id, 'CLAIM'])).toHaveLength(2);
        expect((await contractRow(first.approved.contract.contractId))?.requested).toBe('3000000000');
      }
    });

    it('AC-ST-PAY-003-2, UAT-AC321: with the checks of the application off, the database refuses the second claim and a payment above what the contract accepted, and counts it', async () => {
      const { first, second } = await pair();
      counted.clear();
      const outcomes = await Promise.allSettled([submit(first, { store: unchecked }), submit(second, { store: unchecked, member: 4 })]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const lost = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      expect((lost?.reason as { code: string }).code).toBe('ACCEPTANCE_ALREADY_CLAIMED');
      expect(counted.get('pay_claim_conflict_total')).toBe(1);
      expect((await balancesOf(first.approved.acceptance.id)).map((row) => row.requested)).toEqual(['2000000000', '1000000000']);
      // A ledger that cannot take the claim: the CHECK of the ledger refuses and the refusal is the same 409.
      const over = await ready();
      await owner('update machvon.contract set accepted_total_vnd = 1000000000 where id = $1::uuid', [over.approved.contract.contractId]);
      counted.clear();
      expect(await refusal(submit(over, { store: unchecked }))).toMatchObject({ code: 'VALUE_EXCEEDED', status: 409 });
      expect(counted.get('pay_value_exceeded_total{"rule":"contract_ledger_order_chk"}')).toBe(1);
      // And the unique index alone holds the claim when the check of the application is the one that is off.
      const raw = await ready();
      const other = await ready();
      const row = await owner<{ id: string }>('select id from machvon.payment_request where id = $1::uuid', [other.id]);
      expect(row).toHaveLength(1);
      await submit(raw);
      expect((await databaseRefusal(owner(`update machvon.payment_request set status = 'SUBMITTED', claims_acceptance = true, submitted_by = created_by, submitted_at = now(), acceptance_id = $2::uuid where id = $1::uuid`, [other.id, raw.approved.acceptance.id]))).message).toContain('never changes');
    });
  });

  describe('checking', () => {
    it('AC-ST-PAY-003-5, UAT-AC332: the person who drew the request up and the person who sent it are refused as checkers; an independent checker moves it to VERIFIED', async () => {
      const target = await ready();
      await submit(target, { member: SENDER });
      const version = target.version + 1;
      expect(await refusal(verify(target.id, version, MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(verify(target.id, version, SENDER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await requestRow(target.id)).toMatchObject({ status: 'SUBMITTED', verified_by: null });
      expect(await refusal(verify(target.id, version, CHECKER, '  '))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'note' });
      expect(await refusal(verify(target.id, version + 4))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(verify(target.id, version, CHECKER, undefined, readOnly))).toMatchObject({ code: 'SCOPE_DENIED' });
      const checked = await verify(target.id, version, CHECKER, ' Checked against the minutes. ');
      expect(checked).toMatchObject({ status: 'VERIFIED', fromStatus: 'SUBMITTED', version: version + 1 });
      expect(await requestRow(target.id)).toMatchObject({ status: 'VERIFIED', verified_by: memberId(CHECKER), verification_note: 'Checked against the minutes.', claims_acceptance: true });
      expect(await refusal(verify(target.id, version + 1, CHECKER))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409 });
      // The database holds it too: a checker who drew it up or sent it is refused whatever the application did.
      const fresh = await ready();
      await submit(fresh);
      expect((await databaseRefusal(owner("update machvon.payment_request set status = 'VERIFIED', verified_by = created_by, verified_at = now() where id = $1::uuid", [fresh.id]))).message).toContain('payment_request_checker_chk');
      expect((await databaseRefusal(owner("update machvon.payment_request set status = 'VERIFIED' where id = $1::uuid", [fresh.id]))).message).toContain('says who checked it');
    });
  });

  describe('returning', () => {
    it('returns a checked request and refuses one that is not sent, one already with the Treasury, and a reason that is empty', async () => {
      const target = await ready();
      expect(await refusal(giveBack(target.id, target.version))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409, extensions: { status: 'DRAFT' } });
      await submit(target);
      expect(await refusal(giveBack(target.id, target.version + 1, ' '))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(giveBack(target.id, target.version + 9))).toMatchObject({ code: 'VERSION_CONFLICT' });
      await verify(target.id, target.version + 1);
      expect(await giveBack(target.id, target.version + 2)).toMatchObject({ status: 'RETURNED', fromStatus: 'VERIFIED' });
      expect(await refusal(giveBack(target.id, target.version + 3))).toMatchObject({ code: 'PAYMENT_STATE_INVALID' });
      // With the Treasury a request is returned only when the Treasury returned it.
      const sentOn = await ready();
      await submit(sentOn);
      await verify(sentOn.id, sentOn.version + 1);
      await fixtures.sendToTreasury(sentOn.id);
      expect(await refusal(giveBack(sentOn.id, sentOn.version + 2))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', extensions: { status: 'SENT_TREASURY' } });
      expect(await giveBack(sentOn.id, sentOn.version + 2, 'The Treasury rejected the form.', { treasury: true })).toMatchObject({ status: 'RETURNED', fromStatus: 'SENT_TREASURY' });
      expect((await owner<{ returned_by_treasury: boolean }>('select returned_by_treasury from machvon.payment_request where id = $1::uuid', [sentOn.id]))[0]?.returned_by_treasury).toBe(true);
      const bare = await ready();
      await submit(bare);
      expect((await databaseRefusal(owner("update machvon.payment_request set status = 'RETURNED' where id = $1::uuid", [bare.id]))).message).toContain('says who returned it');
      expect((await databaseRefusal(owner("update machvon.payment_request set status = 'SUBMITTED', submitted_by = null where id = $1::uuid", [target.id]))).message).toMatch(/PAYMENT_STATE_INVALID|says who sent/);
    });

    it('a hold of retention goes only with the request that is returned', async () => {
      const target = await ready();
      await submit(target);
      expect((await databaseRefusal(owner('delete from machvon.retention_hold where payment_request_id = $1::uuid', [target.id]))).message).toContain('goes only with the request that is returned');
      await giveBack(target.id, target.version + 1);
      expect(await owner('select 1 from machvon.retention_hold where payment_request_id = $1::uuid', [target.id])).toEqual([]);
    });
  });
});

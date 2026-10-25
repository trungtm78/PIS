import { randomUUID } from 'node:crypto';
import { PayLedgerStore } from '../src/pay-ledger-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';
import { AcceptanceWorld } from './support/acceptance-fixtures';
import type { ApprovedAcceptance } from './support/acceptance-fixtures';

const fixtures = new AcceptanceWorld();
const ledger = new PayLedgerStore();
const WORKER = memberId(1);
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });

const as = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => fixtures.as(work);
const owner = fixtures.owner.bind(fixtures);
const recognize = (approved: ApprovedAcceptance, requestId = randomUUID()) => as((tx) => ledger.recognize(tx, { acceptanceId: approved.acceptance.id, requestId, actor: WORKER }));
const revoke = (approved: ApprovedAcceptance, requestId = randomUUID()) => as((tx) => ledger.revoke(tx, { acceptanceId: approved.acceptance.id, requestId, actor: WORKER }));

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

const balances = (acceptanceId: string) =>
  owner<{ id: string; boq_item_id: string; accepted_vnd: string; requested_vnd: string; paid_vnd: string; version: string }>(
    'select id, boq_item_id, accepted_vnd::text, requested_vnd::text, paid_vnd::text, version::text from machvon.cumulative_ledger where acceptance_id = $1::uuid order by boq_item_id',
    [acceptanceId],
  );
const entriesOf = (acceptanceId: string) =>
  owner<{ id: string; ledger_id: string; entry_kind: string; accepted_delta_vnd: string; reversal_of_id: string | null }>(
    'select id, ledger_id, entry_kind, accepted_delta_vnd::text, reversal_of_id from machvon.cumulative_ledger_entry where acceptance_id = $1::uuid order by posted_at, id',
    [acceptanceId],
  );
const contractVersion = async (contractId: string) => Number((await owner<{ version: string }>('select version::text from machvon.contract where id = $1::uuid', [contractId]))[0]?.version);

/** An approved acceptance of two items (B01: 100 m3 = 100,000,000; B02: 50 m3 = 100,000,000) worth 200,000,000. */
const approvedTwoItems = async (): Promise<ApprovedAcceptance> => {
  const contract = await fixtures.seedContract();
  return fixtures.approve(contract, [
    { item: 0, quantity: '100' },
    { item: 1, quantity: '50' },
  ]);
};

describe('the cumulative ledger (ST-PAY-001)', () => {
  beforeAll(async () => {
    await fixtures.start();
  }, 240_000);

  afterAll(async () => {
    await fixtures.stop();
  }, 60_000);

  describe('recognising an approved acceptance', () => {
    it('AC-ST-PAY-001-1, UAT-AC322: posts exactly one entry for each item whoever delivers the event and however often, worth the lines of the item', async () => {
      const approved = await approvedTwoItems();
      const before = await contractVersion(approved.contract.contractId);
      const first = await recognize(approved);
      expect(first).toEqual({ outcome: 'posted', entries: 2, acceptedVnd: '200000000' });
      // The same event again, and the same acceptance told by another event: nothing more is posted.
      expect(await recognize(approved)).toMatchObject({ outcome: 'unchanged', entries: 0 });
      expect(await recognize(approved, randomUUID())).toMatchObject({ outcome: 'unchanged', entries: 0 });
      const entries = await entriesOf(approved.acceptance.id);
      expect(entries).toHaveLength(2);
      expect(entries.every((entry) => entry.entry_kind === 'RECOGNIZE_ACCEPTANCE')).toBe(true);
      const rows = await balances(approved.acceptance.id);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row).toMatchObject({ accepted_vnd: approved.amounts.get(row.boq_item_id), requested_vnd: '0', paid_vnd: '0', version: '2' });
      expect(rows.reduce((sum, row) => sum + BigInt(row.accepted_vnd), 0n)).toBe(200000000n);
      expect(await contractVersion(approved.contract.contractId)).toBe(before + 1);
    });

    it('keeps a balance for each item and party of the acceptance', async () => {
      const contract = await fixtures.seedContract();
      const approved = await fixtures.approve(contract, [
        { item: 0, quantity: '10', party: true },
        { item: 0, quantity: '5' },
        { item: 2, quantity: '4' },
      ]);
      expect(await recognize(approved)).toMatchObject({ outcome: 'posted', entries: 3, acceptedVnd: '15004938' });
      const rows = await owner<{ boq_item_id: string; party_id: string | null; accepted_vnd: string }>(
        'select boq_item_id, party_id, accepted_vnd::text from machvon.cumulative_ledger where acceptance_id = $1::uuid order by accepted_vnd::numeric desc',
        [approved.acceptance.id],
      );
      expect(rows).toEqual([
        { boq_item_id: contract.items[0], party_id: contract.partyId, accepted_vnd: '10000000' },
        { boq_item_id: contract.items[0], party_id: null, accepted_vnd: '5000000' },
        { boq_item_id: contract.items[2], party_id: null, accepted_vnd: '4938' },
      ]);
    });

    it('reads the state of the acceptance, not the order of the events: an acceptance that is not approved is not recognised, and one that was revoked is not recognised late', async () => {
      const contract = await fixtures.seedContract();
      const draft = await fixtures.draft(contract, [{ item: 0, quantity: '1' }]);
      expect(await as((tx) => ledger.recognize(tx, { acceptanceId: draft.id, requestId: randomUUID(), actor: WORKER }))).toEqual({ outcome: 'skipped', entries: 0, acceptedVnd: '0' });
      const approved = await approvedTwoItems();
      expect(await revoke(approved)).toMatchObject({ outcome: 'skipped' });
      await fixtures.revoke(approved);
      expect(await recognize(approved)).toMatchObject({ outcome: 'skipped' });
      expect(await balances(approved.acceptance.id)).toEqual([]);
    });

    it('answers 404 for an acceptance that does not exist and 422 for an identifier that is not one', async () => {
      expect(await refusal(as((tx) => ledger.recognize(tx, { acceptanceId: randomUUID(), requestId: randomUUID(), actor: WORKER })))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => ledger.recognize(tx, { acceptanceId: 'x', requestId: randomUUID(), actor: WORKER })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'acceptance_id' });
      expect(await refusal(as((tx) => ledger.recognize(tx, { acceptanceId: randomUUID(), requestId: 'x', actor: WORKER })))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('serialises thirty deliveries of the same event at once into exactly one entry for each item', async () => {
      const approved = await approvedTwoItems();
      const outcomes = await Promise.all(Array.from({ length: 30 }, () => recognize(approved)));
      expect(outcomes.filter((outcome) => outcome.outcome === 'posted')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.outcome === 'unchanged')).toHaveLength(29);
      expect(await entriesOf(approved.acceptance.id)).toHaveLength(2);
      expect((await balances(approved.acceptance.id)).map((row) => row.accepted_vnd)).toEqual(['100000000', '100000000']);
    });
  });

  describe('revoking an acceptance', () => {
    it('takes the acceptance back with entries that are the opposite of the first, once', async () => {
      const approved = await approvedTwoItems();
      await recognize(approved);
      await fixtures.revoke(approved);
      expect(await revoke(approved)).toEqual({ outcome: 'posted', entries: 2, acceptedVnd: '200000000' });
      expect(await revoke(approved)).toMatchObject({ outcome: 'unchanged', entries: 0 });
      const entries = await entriesOf(approved.acceptance.id);
      expect(entries.map((entry) => entry.entry_kind)).toEqual(['RECOGNIZE_ACCEPTANCE', 'RECOGNIZE_ACCEPTANCE', 'REVOKE_ACCEPTANCE', 'REVOKE_ACCEPTANCE']);
      for (const reversal of entries.filter((entry) => entry.entry_kind === 'REVOKE_ACCEPTANCE')) {
        const original = entries.find((entry) => entry.id === reversal.reversal_of_id)!;
        expect(BigInt(reversal.accepted_delta_vnd)).toBe(-BigInt(original.accepted_delta_vnd));
        expect(reversal.ledger_id).toBe(original.ledger_id);
      }
      expect((await balances(approved.acceptance.id)).map((row) => [row.accepted_vnd, row.version])).toEqual([
        ['0', '3'],
        ['0', '3'],
      ]);
    });

    it('is refused as VALUE_EXCEEDED while a claim stands on what it would take back, and leaves the ledger as it was', async () => {
      const approved = await approvedTwoItems();
      await recognize(approved);
      const [row] = await balances(approved.acceptance.id);
      await as((tx) => ledger.post(tx, { ledgerId: row!.id, kind: 'CLAIM', delta: { accepted: '0', requested: '40000000', paid: '0', advanceRecovery: '0', retention: '0' }, requestId: randomUUID(), actor: WORKER, advanceOutstandingVnd: '0' }));
      await fixtures.revoke(approved).catch(() => undefined);
      const refused = await refusal(revoke(approved));
      expect(refused).toMatchObject({ code: 'VALUE_EXCEEDED', status: 409, extensions: { rule: 'REQUESTED_LE_ACCEPTED' } });
      expect((await balances(approved.acceptance.id)).map((entry) => entry.accepted_vnd)).toEqual(['100000000', '100000000']);
    });
  });

  describe('the rules of the ledger', () => {
    it('AC-ST-PAY-001-2, UAT-AC321: the database refuses a balance that breaks a rule and an entry that is changed or deleted, behind the checks of the store', async () => {
      const approved = await approvedTwoItems();
      await recognize(approved);
      const [row] = await balances(approved.acceptance.id);
      const [entry] = await entriesOf(approved.acceptance.id);
      expect((await databaseRefusal(owner('update machvon.cumulative_ledger set requested_vnd = accepted_vnd + 1 where id = $1::uuid', [row!.id]))).message).toContain('cumulative_ledger_requested_le_accepted_chk');
      expect((await databaseRefusal(owner('update machvon.cumulative_ledger set requested_vnd = 10, paid_vnd = 11 where id = $1::uuid', [row!.id]))).message).toContain('cumulative_ledger_paid_le_requested_chk');
      expect((await databaseRefusal(owner('update machvon.cumulative_ledger set requested_vnd = 10, retention_held_vnd = 11 where id = $1::uuid', [row!.id]))).message).toContain('cumulative_ledger_deductions_chk');
      expect((await databaseRefusal(owner('update machvon.cumulative_ledger set accepted_vnd = -1 where id = $1::uuid', [row!.id]))).message).toContain('cumulative_ledger_nonneg_chk');
      // The runtime role holds no right to change or delete an entry; whoever else does is stopped by the trigger.
      expect((await databaseRefusal(as((tx) => tx.query('update machvon.cumulative_ledger_entry set reason = $2 where id = $1::uuid', [entry!.id, 'x'])))).sqlstate).toBe('42501');
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.cumulative_ledger_entry where id = $1::uuid', [entry!.id])))).sqlstate).toBe('42501');
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.cumulative_ledger where id = $1::uuid', [row!.id])))).sqlstate).toBe('42501');
      expect((await databaseRefusal(owner('update machvon.cumulative_ledger_entry set reason = $2 where id = $1::uuid', [entry!.id, 'x']))).message).toContain('LEDGER_ENTRY_IMMUTABLE');
      expect((await databaseRefusal(owner('delete from machvon.cumulative_ledger_entry where id = $1::uuid', [entry!.id]))).message).toContain('LEDGER_ENTRY_IMMUTABLE');
      expect((await databaseRefusal(owner('truncate machvon.cumulative_ledger_entry'))).message).toContain('LEDGER_ENTRY_IMMUTABLE');
      // The contract keeps the same order of what it accepted, requested and paid, and what it pays out never goes above its value.
      expect((await databaseRefusal(owner('update machvon.contract set requested_total_vnd = accepted_total_vnd + 1 where id = $1::uuid', [approved.contract.contractId]))).message).toContain('contract_ledger_order_chk');
      expect((await databaseRefusal(owner('update machvon.contract set accepted_total_vnd = contract_value_vnd, requested_total_vnd = contract_value_vnd, paid_total_vnd = contract_value_vnd, advance_paid_vnd = 1 where id = $1::uuid', [approved.contract.contractId]))).message).toContain('contract_cash_out_chk');
      expect((await databaseRefusal(owner('update machvon.contract set advance_recovered_vnd = advance_paid_vnd + 1 where id = $1::uuid', [approved.contract.contractId]))).message).toContain('contract_advance_order_chk');
      expect((await entriesOf(approved.acceptance.id))).toHaveLength(2);
    });

    it('a balance is the sum of its entries at every commit: one that moves without an entry, or an entry without its balance, is refused when the transaction ends', async () => {
      const approved = await approvedTwoItems();
      await recognize(approved);
      const [row] = await balances(approved.acceptance.id);
      expect((await databaseRefusal(owner('update machvon.cumulative_ledger set accepted_vnd = accepted_vnd + 1 where id = $1::uuid', [row!.id]))).message).toContain('LEDGER_SUM_MISMATCH');
      expect(
        (
          await databaseRefusal(
            owner(
              `insert into machvon.cumulative_ledger_entry (tenant_id, id, ledger_id, contract_id, boq_item_id, acceptance_id, entry_kind, retention_delta_vnd, advance_outstanding_after_vnd, request_id, created_by)
               select tenant_id, gen_random_uuid(), id, contract_id, boq_item_id, acceptance_id, 'RETENTION_HOLD', 5, 0, gen_random_uuid(), created_by from machvon.cumulative_ledger where id = $1::uuid`,
              [row!.id],
            ),
          )
        ).message,
      ).toContain('LEDGER_SUM_MISMATCH');
      expect((await balances(approved.acceptance.id)).map((entry) => entry.accepted_vnd)).toEqual(['100000000', '100000000']);
    });

    it('an entry belongs to the balance it names, and an entry that reverses another is its exact opposite, of the right kind, on the same balance', async () => {
      const approved = await approvedTwoItems();
      const other = await approvedTwoItems();
      await recognize(approved);
      await recognize(other);
      const [row, second] = await balances(approved.acceptance.id);
      const [theirs] = await balances(other.acceptance.id);
      const [recognised] = (await entriesOf(approved.acceptance.id)).filter((entry) => entry.ledger_id === row!.id);
      const insert = (ledgerId: string, kind: string, reversalOf: string | null, accepted: string, contractId = approved.contract.contractId, itemId = row!.boq_item_id, acceptanceId = approved.acceptance.id) =>
        owner(
          `insert into machvon.cumulative_ledger_entry (tenant_id, id, ledger_id, contract_id, boq_item_id, acceptance_id, entry_kind, accepted_delta_vnd, advance_outstanding_after_vnd, reversal_of_id, request_id, created_by)
           values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7::numeric, 0, $8, gen_random_uuid(), $9)`,
          [TENANT_A, ledgerId, contractId, itemId, acceptanceId, kind, accepted, reversalOf, WORKER],
        );
      expect((await databaseRefusal(insert(theirs!.id, 'RECOGNIZE_ACCEPTANCE', null, '1'))).message).toContain('an entry belongs to the balance it names');
      expect((await databaseRefusal(insert(row!.id, 'REVOKE_ACCEPTANCE', recognised!.id, '-1'))).message).toContain('its exact opposite');
      expect((await databaseRefusal(insert(second!.id, 'REVOKE_ACCEPTANCE', recognised!.id, '-100000000', approved.contract.contractId, second!.boq_item_id))).message).toContain('its exact opposite');
      expect((await databaseRefusal(insert(row!.id, 'CLAIM_RELEASE', recognised!.id, '-100000000'))).message).toContain('its exact opposite');
    });

    it('the store holds an entry to the rules before the database does: a claim above what was accepted is 409 VALUE_EXCEEDED naming the rule and the figures', async () => {
      const approved = await approvedTwoItems();
      await recognize(approved);
      const [row] = await balances(approved.acceptance.id);
      const claim = (requested: string) =>
        as((tx) => ledger.post(tx, { ledgerId: row!.id, kind: 'CLAIM', delta: { accepted: '0', requested, paid: '0', advanceRecovery: '0', retention: '0' }, requestId: randomUUID(), actor: WORKER, advanceOutstandingVnd: '5' }));
      expect(await refusal(claim('100000001'))).toMatchObject({ code: 'VALUE_EXCEEDED', status: 409, extensions: { rule: 'REQUESTED_LE_ACCEPTED', accepted_vnd: '100000000', requested_vnd: '100000001' } });
      expect(await claim('100000000')).toMatchObject({ kind: 'CLAIM', balance: { acceptedVnd: '100000000', requestedVnd: '100000000' } });
      expect(await refusal(as((tx) => ledger.post(tx, { ledgerId: row!.id, kind: 'CLAIM', delta: { accepted: '0', requested: '-1', paid: '0', advanceRecovery: '0', retention: '0' }, requestId: randomUUID(), actor: WORKER, advanceOutstandingVnd: '0' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'delta' });
      expect(await refusal(as((tx) => ledger.post(tx, { ledgerId: randomUUID(), kind: 'CLAIM', delta: { accepted: '0', requested: '1', paid: '0', advanceRecovery: '0', retention: '0' }, requestId: randomUUID(), actor: WORKER, advanceOutstandingVnd: '0' })))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect((await owner<{ advance_outstanding_after_vnd: string }>('select advance_outstanding_after_vnd::text from machvon.cumulative_ledger_entry where entry_kind = $1 and ledger_id = $2::uuid', ['CLAIM', row!.id]))[0]).toEqual({ advance_outstanding_after_vnd: '5' });
    });

    it('serialises claims on one balance: of ten parallel claims of 30,000,000 on a balance of 100,000,000, three are posted and seven are refused, and the balance never goes over', async () => {
      const approved = await approvedTwoItems();
      await recognize(approved);
      const [row] = await balances(approved.acceptance.id);
      const outcomes = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          as((tx) => ledger.post(tx, { ledgerId: row!.id, kind: 'CLAIM', delta: { accepted: '0', requested: '30000000', paid: '0', advanceRecovery: '0', retention: '0' }, requestId: randomUUID(), actor: WORKER, advanceOutstandingVnd: '0' })),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(3);
      const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      expect(failures.map((failure) => (failure.reason as { code: string }).code)).toEqual(Array(7).fill('VALUE_EXCEEDED'));
      expect((await balances(approved.acceptance.id)).find((entry) => entry.id === row!.id)?.requested_vnd).toBe('90000000');
    });
  });

  describe('reading the ledger of a contract', () => {
    it('AC-ST-PAY-001-4, UAT-AC341: gives the balances with their entries and totals inside the scope of the caller, and a contract outside it is not found', async () => {
      const approved = await approvedTwoItems();
      await recognize(approved);
      const page = await as((tx) => ledger.page(tx, approved.contract.contractId, everything));
      expect(page.header).toMatchObject({ contractId: approved.contract.contractId, contractCode: approved.contract.code, contractValueVnd: '9000000000', acceptedTotalVnd: '200000000', advanceOutstandingVnd: '0' });
      expect(page.items.map((item) => [item.boqItemKey, item.acceptedVnd, item.acceptanceNo !== null]).sort()).toEqual([
        ['B01', '100000000', true],
        ['B02', '100000000', true],
      ]);
      expect(page.items[0]!.entries).toHaveLength(1);
      expect(page.items[0]!.entries[0]).toMatchObject({ kind: 'RECOGNIZE_ACCEPTANCE', acceptedDeltaVnd: '100000000', reversalOfId: null });
      expect(page.total).toEqual({ acceptedVnd: '200000000', requestedVnd: '0', paidVnd: '0', advanceRecoveredVnd: '0', retentionHeldVnd: '0' });
      expect(page).toMatchObject({ reconciled: true, hasMore: false });
      expect(await refusal(as((tx) => ledger.page(tx, approved.contract.contractId, nothing)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      // Another tenant does not see the contract, whatever scope it asks with.
      const foreign = await refusal(fixtures.harness.tenants.withTenant(contextFor(TENANT_B, memberId(1)), (tx) => ledger.page(tx, approved.contract.contractId, everything)));
      expect(foreign).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      // Another tenant sees no balance and no entry at all, and a statement without a tenant sees none either.
      const counts = `select (select count(*) from machvon.cumulative_ledger)::int as balances, (select count(*) from machvon.cumulative_ledger_entry)::int as entries`;
      expect(await fixtures.harness.tenants.withTenant(contextFor(TENANT_B, memberId(1)), (tx) => tx.query(counts))).toEqual([{ balances: 0, entries: 0 }]);
      expect((await fixtures.harness.appPool.query(counts)).rows).toEqual([{ balances: 0, entries: 0 }]);
    });

    it('filters by item and acceptance, totals what the filter keeps, and reports a contract whose balances do not add up to what it accepted', async () => {
      const approved = await approvedTwoItems();
      await recognize(approved);
      const key = approved.contract.items[1];
      const filtered = await as((tx) => ledger.page(tx, approved.contract.contractId, everything, { boqItemId: key.toUpperCase(), acceptanceId: approved.acceptance.id }));
      expect(filtered.items.map((item) => item.boqItemId)).toEqual([key]);
      expect(filtered.total.acceptedVnd).toBe('100000000');
      expect(filtered.reconciled).toBe(true);
      expect((await as((tx) => ledger.page(tx, approved.contract.contractId, everything, { acceptanceId: randomUUID() }))).items).toEqual([]);
      await owner('update machvon.contract set accepted_total_vnd = accepted_total_vnd + 1 where id = $1::uuid', [approved.contract.contractId]);
      expect((await as((tx) => ledger.page(tx, approved.contract.contractId, everything))).reconciled).toBe(false);
      expect(await refusal(as((tx) => ledger.page(tx, approved.contract.contractId, everything, { boqItemId: 'x' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'boq_item_id' });
      expect(await refusal(as((tx) => ledger.page(tx, 'x', everything)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contract_id' });
    });

    it('pages the balances in a stable order, resuming after the last one seen', async () => {
      const contract = await fixtures.seedContract();
      const acceptance = await fixtures.approve(contract, [
        { item: 0, quantity: '1' },
        { item: 1, quantity: '1' },
        { item: 2, quantity: '1' },
      ]);
      await recognize(acceptance);
      const first = await as((tx) => ledger.page(tx, contract.contractId, everything, { limit: 2 }));
      expect(first.items).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      const last = first.items[1]!;
      const second = await as((tx) => ledger.page(tx, contract.contractId, everything, { limit: 2, after: { createdAt: last.createdAt, id: last.id } }));
      expect(second.hasMore).toBe(false);
      expect([...first.items, ...second.items].map((item) => item.id)).toHaveLength(new Set([...first.items, ...second.items].map((item) => item.id)).size);
      expect(first.items.length + second.items.length).toBe(3);
      expect(first.total.acceptedVnd).toBe(second.total.acceptedVnd);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { ENTRY_KINDS, availableVnd, dateTimeText, filterOptions, isReversal, joinPages, ledgerLink, toLedger } from './model';
import { acceptanceId, contractId, entry, itemId, line, page } from './test-support';

describe('the model of the cumulative ledger (PAY-10)', () => {
  it('links to the ledger of a contract, narrowed to an item and an acceptance when asked', () => {
    expect(ledgerLink(contractId(1))).toBe(`/pay/pay-10?contract=${contractId(1)}`);
    expect(ledgerLink(contractId(1), { itemId: itemId(1), acceptanceId: acceptanceId(1) })).toBe(`/pay/pay-10?contract=${contractId(1)}&item=${itemId(1)}&acceptance=${acceptanceId(1)}`);
  });

  it('reads a page of the ledger with exact amounts, the lines and their entries', () => {
    const read = toLedger(page([line(1), line(2, { party_id: itemId(9), acceptance_no: null })], { next_cursor: 'c' }));
    expect(read?.contract).toMatchObject({ code: 'HD-A-001', contractValueVnd: '10200000000', acceptedTotalVnd: '800000000', advanceOutstandingVnd: '30000000' });
    expect(read?.total).toEqual({ acceptedVnd: '800000000', requestedVnd: '300000000', paidVnd: '200000000', advanceRecoveredVnd: '40000000', retentionHeldVnd: '20000000' });
    expect(read).toMatchObject({ reconciled: true, nextCursor: 'c', asOf: '2026-10-25T03:00:00.000Z' });
    expect(read?.items[0]).toMatchObject({ boqItemKey: 'B01', acceptanceNo: 'NT-001', partyId: null, acceptedVnd: '400000000', unitCode: 'M3' });
    expect(read?.items[1]).toMatchObject({ acceptanceNo: null, partyId: itemId(9) });
    expect(read?.items[0]?.entries.map((item) => item.kind)).toEqual(['RECOGNIZE_ACCEPTANCE', 'CLAIM']);
    expect(read?.items[0]?.entries[1]).toMatchObject({ requestedDeltaVnd: '150000000', advanceOutstandingAfterVnd: '30000000', reason: 'Claim 1', reversalOfId: null });
  });

  it('keeps the sign of a reversal and drops what is not a line, an entry or a page', () => {
    const reversal = entry(3, { kind: 'REVOKE_ACCEPTANCE', accepted_delta_vnd: '-400000000', reversal_of_id: entry(1).id });
    const read = toLedger(page([line(1, { entries: [entry(1), reversal, { id: 'x' }, entry(4, { kind: 'NOT_A_KIND' }), entry(5, { accepted_delta_vnd: '1.5' })] }), { id: 'broken' }]));
    expect(read?.items).toHaveLength(1);
    expect(read?.items[0]?.entries.map((item) => item.acceptedDeltaVnd)).toEqual(['400000000', '-400000000']);
    expect(isReversal(read!.items[0]!.entries[0]!)).toBe(false);
    expect(isReversal(read!.items[0]!.entries[1]!)).toBe(true);
    expect(toLedger(null)).toBeUndefined();
    expect(toLedger({ contract: {}, items: [], total: {} })).toBeUndefined();
    expect(toLedger({ ...page([]), items: 'x' })).toBeUndefined();
    expect(toLedger({ ...page([]), total: { accepted_vnd: 'x' } })).toBeUndefined();
    expect(toLedger({ ...page([]), contract: { ...page([]).contract, code: undefined } })).toBeUndefined();
    expect(toLedger({ ...page([line(1, { entries: 'x' })]) })?.items[0]?.entries).toEqual([]);
    expect(toLedger({ ...page([]), reconciled: undefined, as_of: undefined, next_cursor: undefined })).toMatchObject({ reconciled: false, asOf: '', nextCursor: null });
  });

  it('joins the pages read so far: the contract and totals of the first, the lines of all, the cursor of the last', () => {
    const first = toLedger(page([line(1)], { next_cursor: 'a' }))!;
    const second = toLedger(page([line(2)], { next_cursor: null }))!;
    const joined = joinPages([first, second]);
    expect(joined?.items.map((item) => item.boqItemKey)).toEqual(['B01', 'B02']);
    expect(joined?.nextCursor).toBeNull();
    expect(joined?.total).toEqual(first.total);
    expect(joinPages([])).toBeUndefined();
  });

  it('counts what is free to request on a balance, never below zero', () => {
    const balance = { acceptedVnd: '400000000', requestedVnd: '150000000', paidVnd: '0', advanceRecoveredVnd: '0', retentionHeldVnd: '0' };
    expect(availableVnd(balance)).toBe('250000000');
    expect(availableVnd({ ...balance, requestedVnd: '400000000' })).toBe('0');
    expect(availableVnd({ ...balance, requestedVnd: '500000000' })).toBe('0');
  });

  it('offers each item and acceptance once, in the order they come', () => {
    const lines = toLedger(page([line(1), line(2), line(1, { id: 'x1', acceptance_id: acceptanceId(2), acceptance_no: null })]))!.items;
    const options = filterOptions(lines);
    expect(options.items.map((option) => option.label)).toEqual(['B01', 'B02']);
    expect(options.acceptances).toEqual([
      { id: acceptanceId(1), label: 'NT-001' },
      { id: acceptanceId(2), label: acceptanceId(2) },
    ]);
  });

  it('names every kind of entry once and writes the time of an entry in the time of Vietnam', () => {
    expect(new Set(ENTRY_KINDS).size).toBe(10);
    expect(dateTimeText('2026-10-25T20:30:00.000Z', 'en')).toContain('26');
    expect(dateTimeText('not a time', 'en')).toBe('not a time');
  });
});

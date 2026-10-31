import { LEDGER_COLUMNS, foldBalance, ledgerEffect } from '../src/cap-ledger';

describe('the capital ledger as balances (ST-CAP-014, BR-CAP-06)', () => {
  it('moves one column by every kind of entry, up or down', () => {
    expect(['APPROPRIATE', 'ALLOCATE', 'REDUCE', 'TRANSFER_IN', 'TRANSFER_OUT', 'EXTEND_IN', 'EXTEND_OUT', 'LAPSE', 'RESERVE', 'RELEASE', 'COMMIT', 'UNCOMMIT', 'DISBURSE'].map((type) => ledgerEffect(type, null))).toEqual([
      { column: 'appropriated', sign: 1 },
      { column: 'allocated', sign: 1 },
      { column: 'allocated', sign: -1 },
      { column: 'allocated', sign: 1 },
      { column: 'allocated', sign: -1 },
      { column: 'allocated', sign: 1 },
      { column: 'allocated', sign: -1 },
      { column: 'allocated', sign: -1 },
      { column: 'reserved', sign: 1 },
      { column: 'reserved', sign: -1 },
      { column: 'committed', sign: 1 },
      { column: 'committed', sign: -1 },
      { column: 'disbursed', sign: 1 },
    ]);
    expect(LEDGER_COLUMNS).toHaveLength(5);
  });

  it('undoes the entry it reverses with a reversal, and knows nothing of a type the ledger does not have', () => {
    expect(ledgerEffect('REVERSAL', 'DISBURSE')).toEqual({ column: 'disbursed', sign: -1 });
    expect(ledgerEffect('REVERSAL', 'UNCOMMIT')).toEqual({ column: 'committed', sign: 1 });
    expect(ledgerEffect('REVERSAL', null)).toBeUndefined();
    expect(ledgerEffect('REVERSAL', 'REVERSAL')).toBeUndefined();
    expect(ledgerEffect('NOPE', null)).toBeUndefined();
  });

  it('UAT-AC227: adds the entries up column by column, so a reservation that was released once leaves nothing reserved', () => {
    expect(
      foldBalance([
        { entryType: 'APPROPRIATE', reversedType: null, amountVnd: '100000000000' },
        { entryType: 'ALLOCATE', reversedType: null, amountVnd: '40000000000' },
        { entryType: 'RESERVE', reversedType: null, amountVnd: '5000000000' },
        { entryType: 'RELEASE', reversedType: null, amountVnd: '5000000000' },
        { entryType: 'COMMIT', reversedType: null, amountVnd: '30000000000' },
        { entryType: 'DISBURSE', reversedType: null, amountVnd: '12000000000' },
        { entryType: 'REVERSAL', reversedType: 'DISBURSE', amountVnd: '2000000000' },
        { entryType: 'MYSTERY', reversedType: null, amountVnd: '1' },
      ]),
    ).toEqual({ appropriated: '100000000000', allocated: '40000000000', reserved: '0', committed: '30000000000', disbursed: '10000000000' });
    expect(foldBalance([])).toEqual({ appropriated: '0', allocated: '0', reserved: '0', committed: '0', disbursed: '0' });
    expect(foldBalance([{ entryType: 'REDUCE', reversedType: null, amountVnd: '7' }]).allocated).toBe('-7');
  });
});

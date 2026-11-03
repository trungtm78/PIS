import type { DomainError } from '../src/errors';
import {
  APPROVED_SETTLEMENT_STATUSES,
  adjustmentLedgerDelta,
  affectedAcceptanceIds,
  assertAffectedMatches,
  assertNoApprovedSettlement,
  assertNotBeforeContract,
  assertRetroactiveDay,
  groupByBalance,
  repricedItems,
  repriceAcceptedLines,
  settlementBlocks,
  totalDelta,
} from '../src/ctr-retroactive';
import type { AcceptedLine, Repricing, SettlementFact } from '../src/ctr-retroactive';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const line = (overrides: Partial<AcceptedLine> = {}): AcceptedLine => ({
  acceptanceId: 'A1',
  acceptanceNo: 'NT-001',
  acceptedOn: '2026-07-25',
  lineId: 'L1',
  boqItemId: 'B02',
  partyId: null,
  quantity: '500.000000',
  unitPriceSnapshot: '2000000.000000',
  amountVnd: '1000000000',
  ...overrides,
});

const price = (unitPrice: string, roundingRule: Repricing['roundingRule'] = 'HALF_UP'): Repricing => ({ unitPrice, roundingRule });

describe('the day of a retroactive change (ST-CTR-016, BR-CTR-03)', () => {
  it('AC-ST-CTR-016-1, UAT-AC58: takes only a day before the day of the approval; a day that is not past goes through the ordinary decision', () => {
    expect(() => assertRetroactiveDay('2026-06-01', '2026-07-20')).not.toThrow();
    expect(() => assertRetroactiveDay('2026-07-19', '2026-07-20')).not.toThrow();
    for (const day of ['2026-07-20', '2026-08-01']) {
      expect(refusal(() => assertRetroactiveDay(day, '2026-07-20'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_on', extensions: { reason: 'NOT_RETROACTIVE', approved_on: '2026-07-20' } });
    }
  });

  it('does not reach back before the contract began', () => {
    expect(() => assertNotBeforeContract('2026-01-01', '2026-01-01')).not.toThrow();
    expect(refusal(() => assertNotBeforeContract('2025-12-31', '2026-01-01'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'effective_on', extensions: { reason: 'BEFORE_CONTRACT', contract_began_on: '2026-01-01' } });
  });
});

describe('which items a change order re-prices (ST-CTR-016, price difference)', () => {
  const head = [
    { boqItemId: 'B01', unitPrice: '1500000.000000', roundingRule: 'HALF_UP' as const },
    { boqItemId: 'B02', unitPrice: '2100000.000000', roundingRule: 'HALF_UP' as const },
    { boqItemId: 'B03', unitPrice: '10.500000', roundingRule: 'DOWN' as const },
  ];

  it('is the items whose unit price in the new BOQ differs from the price in the BOQ in force; an equal price (however written), a new rounding rule alone and a new item change nothing', () => {
    const next = [
      { boqItemId: 'B01', unitPrice: '1500000', roundingRule: 'HALF_UP' as const },
      { boqItemId: 'B02', unitPrice: '2200000.000000', roundingRule: 'DOWN' as const },
      { boqItemId: 'B03', unitPrice: '10.500000', roundingRule: 'UP' as const },
      { boqItemId: 'B04', unitPrice: '5.000000', roundingRule: 'HALF_UP' as const },
    ];
    const items = repricedItems(head, next);
    expect([...items.keys()]).toEqual(['B02']);
    expect(items.get('B02')).toEqual({ unitPrice: '2200000.000000', roundingRule: 'DOWN' });
  });

  it('leaves out an item that the new BOQ no longer prices', () => {
    expect(repricedItems(head, [{ boqItemId: 'B01', unitPrice: '1600000.000000', roundingRule: 'HALF_UP' }]).size).toBe(1);
  });
});

describe('the difference of an accepted line when its price changes (ST-CTR-016)', () => {
  it('AC-ST-CTR-016-1, UAT-AC58: is the quantity at the new price, rounded as the new line is, less what the line was accepted for, with the sign of the change of price', () => {
    const rise = repriceAcceptedLines([line()], new Map([['B02', price('2100000.000000')]]), '2026-06-01');
    expect(rise).toEqual([{ ...line(), newUnitPrice: '2100000.000000', newAmountVnd: '1050000000', deltaVnd: '50000000' }]);
    const fall = repriceAcceptedLines([line()], new Map([['B02', price('1900000.000000')]]), '2026-06-01');
    expect(fall[0]).toMatchObject({ newAmountVnd: '950000000', deltaVnd: '-50000000' });
  });

  it('is the difference of the amounts, not of the prices times the quantity, so a rounded line ends exactly where a line accepted at the new price would', () => {
    // 3 at 1234.5 was accepted for 3704 (HALF_UP of 3703.5); at 1235.5 it is 3706.5, 3707: the difference is 3, not 3.
    const accepted = line({ quantity: '3.000000', unitPriceSnapshot: '1234.500000', amountVnd: '3704' });
    expect(repriceAcceptedLines([accepted], new Map([['B02', price('1235.500000', 'HALF_UP')]]), '2026-06-01')[0]).toMatchObject({ newAmountVnd: '3707', deltaVnd: '3' });
    expect(repriceAcceptedLines([accepted], new Map([['B02', price('1235.500000', 'DOWN')]]), '2026-06-01')[0]).toMatchObject({ newAmountVnd: '3706', deltaVnd: '2' });
  });

  it('leaves out a line before the day, a line of an item that is not re-priced, and a line whose amount does not change', () => {
    const lines = [
      line({ lineId: 'L1', acceptedOn: '2026-05-31' }),
      line({ lineId: 'L2', acceptedOn: '2026-06-01' }),
      line({ lineId: 'L3', boqItemId: 'B09' }),
      line({ lineId: 'L4', unitPriceSnapshot: '2100000.000000', amountVnd: '1050000000' }),
    ];
    expect(repriceAcceptedLines(lines, new Map([['B02', price('2100000.000000')]]), '2026-06-01').map((each) => each.lineId)).toEqual(['L2']);
  });

  it('prices a line accepted after a later revision against the same new price (the change order stands over every revision since its day)', () => {
    const later = line({ lineId: 'L9', acceptanceId: 'A2', acceptedOn: '2026-08-02', quantity: '100.000000', unitPriceSnapshot: '2100000.000000', amountVnd: '210000000' });
    expect(repriceAcceptedLines([later], new Map([['B02', price('2200000.000000')]]), '2026-06-01')[0]).toMatchObject({ deltaVnd: '10000000' });
  });
});

describe('the adjustment of each balance of the ledger (ST-CTR-016)', () => {
  const repriced = repriceAcceptedLines(
    [
      line({ lineId: 'L1', acceptanceId: 'A2', acceptanceNo: 'NT-002', acceptedOn: '2026-08-02', quantity: '100.000000', unitPriceSnapshot: '2000000.000000', amountVnd: '200000000' }),
      line({ lineId: 'L2', quantity: '300.000000', amountVnd: '600000000' }),
      line({ lineId: 'L3', quantity: '200.000000', amountVnd: '400000000' }),
      line({ lineId: 'L4', boqItemId: 'B05', partyId: 'P2', quantity: '10.000000', unitPriceSnapshot: '1000.000000', amountVnd: '10000' }),
      line({ lineId: 'L5', boqItemId: 'B05', partyId: 'P1', quantity: '10.000000', unitPriceSnapshot: '1000.000000', amountVnd: '10000' }),
    ],
    new Map([
      ['B02', price('2100000.000000')],
      ['B05', price('900.000000')],
    ]),
    '2026-06-01',
  );

  it('adds the lines of one item of one acceptance (and member) into one adjustment, in a stable order', () => {
    const groups = groupByBalance(repriced);
    expect(groups.map((group) => [group.acceptanceId, group.boqItemId, group.partyId, group.deltaVnd])).toEqual([
      ['A1', 'B02', null, '50000000'],
      ['A1', 'B05', 'P1', '-1000'],
      ['A1', 'B05', 'P2', '-1000'],
      ['A2', 'B02', null, '10000000'],
    ]);
    expect(groups[0]).toEqual({
      acceptanceId: 'A1',
      acceptanceNo: 'NT-001',
      boqItemId: 'B02',
      partyId: null,
      lineIds: ['L2', 'L3'],
      quantity: '500.000000',
      oldAmountVnd: '1000000000',
      newUnitPrice: '2100000.000000',
      newAmountVnd: '1050000000',
      deltaVnd: '50000000',
    });
  });

  it('adds the differences with their signs and names each acceptance once', () => {
    const groups = groupByBalance(repriced);
    expect(totalDelta(groups)).toBe('59998000');
    expect(totalDelta([])).toBe('0');
    expect(affectedAcceptanceIds(groups)).toEqual(['A1', 'A2']);
  });

  it('puts the whole difference on the accepted amount of the balance and on nothing else', () => {
    expect(adjustmentLedgerDelta('50000000')).toEqual({ accepted: '50000000', requested: '0', paid: '0', advanceRecovery: '0', retention: '0' });
    expect(adjustmentLedgerDelta('-1000')).toEqual({ accepted: '-1000', requested: '0', paid: '0', advanceRecovery: '0', retention: '0' });
  });
});

describe('the list of affected acceptances (ST-CTR-016: the affected acceptances are recorded)', () => {
  it('AC-ST-CTR-016-1: must be exactly the acceptances the change re-prices, however it is ordered or repeated', () => {
    expect(() => assertAffectedMatches(['b', 'a', 'b'], ['a', 'b'])).not.toThrow();
    expect(() => assertAffectedMatches([], [])).not.toThrow();
  });

  it('says which acceptances were left out and which were named without being affected', () => {
    expect(refusal(() => assertAffectedMatches(['a', 'x'], ['a', 'b', 'c']))).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'affected_acceptance_ids',
      extensions: { reason: 'AFFECTED_MISMATCH', missing_acceptance_ids: ['b', 'c'], unexpected_acceptance_ids: ['x'] },
    });
    expect(refusal(() => assertAffectedMatches([], ['a']))).toMatchObject({ extensions: { missing_acceptance_ids: ['a'], unexpected_acceptance_ids: [] } });
  });
});

describe('a settlement that was approved closes the adjustment (ST-CTR-016, UAT-AC58)', () => {
  const settlement = (overrides: Partial<SettlementFact> = {}): SettlementFact => ({ id: 'S1', scope: 'CONTRACT', status: 'VERIFIED', contractId: 'C1', projectId: 'P1', fiscalYear: null, ...overrides });
  const target = { contractId: 'C1', projectId: 'P1', postingYear: 2026 };

  it('counts a settlement as approved once its figures were verified or it was closed, and not before', () => {
    expect(APPROVED_SETTLEMENT_STATUSES).toEqual(['VERIFIED', 'CLOSED']);
    for (const status of ['DRAFT', 'SUBMITTED', 'VERIFYING', 'RETURNED', 'SUPERSEDED']) expect(settlementBlocks(settlement({ status }), target)).toBe(false);
    for (const status of ['VERIFIED', 'CLOSED']) expect(settlementBlocks(settlement({ status }), target)).toBe(true);
  });

  it('is read by the settlement of the contract, of its project, and of a year that is not over before the entry is posted', () => {
    expect(settlementBlocks(settlement({ scope: 'CONTRACT', contractId: 'C2' }), target)).toBe(false);
    expect(settlementBlocks(settlement({ scope: 'PROJECT', contractId: null }), target)).toBe(true);
    expect(settlementBlocks(settlement({ scope: 'PROJECT', contractId: null, projectId: 'P2' }), target)).toBe(false);
    expect(settlementBlocks(settlement({ scope: 'ANNUAL', contractId: null, fiscalYear: 2026 }), target)).toBe(true);
    expect(settlementBlocks(settlement({ scope: 'ANNUAL', contractId: null, fiscalYear: 2027 }), target)).toBe(true);
    expect(settlementBlocks(settlement({ scope: 'ANNUAL', contractId: null, fiscalYear: 2025 }), target)).toBe(false);
    expect(settlementBlocks(settlement({ scope: 'ANNUAL', contractId: null, fiscalYear: 2026, projectId: 'P2' }), target)).toBe(false);
  });

  it('AC-ST-CTR-016-1: refuses with 409 SETTLEMENT_ALREADY_APPROVED, naming the first settlement that blocks it', () => {
    expect(() => assertNoApprovedSettlement([settlement({ status: 'DRAFT' }), settlement({ id: 'S2', scope: 'CONTRACT', contractId: 'C2' })], target)).not.toThrow();
    expect(refusal(() => assertNoApprovedSettlement([settlement({ status: 'DRAFT' }), settlement({ id: 'S3', status: 'CLOSED' })], target))).toMatchObject({
      code: 'SETTLEMENT_ALREADY_APPROVED',
      status: 409,
      detail: 'settlement',
      extensions: { settlement_id: 'S3', settlement_scope: 'CONTRACT', settlement_status: 'CLOSED' },
    });
  });
});

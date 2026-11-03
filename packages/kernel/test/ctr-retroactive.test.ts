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
import type { AcceptedLine, PriorAdjustment, Repricing, SettlementFact } from '../src/ctr-retroactive';

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

/** What the adjustment posts: the balances the new price moves, given the differences earlier adjustments already posted on them. */
const balancesOf = (lines: readonly AcceptedLine[], repricing: ReadonlyMap<string, Repricing>, effectiveOn: string, prior: readonly PriorAdjustment[] = []) =>
  groupByBalance(repriceAcceptedLines(lines, repricing, effectiveOn), prior);
const earlier = (deltaVnd: string, overrides: Partial<PriorAdjustment> = {}): PriorAdjustment => ({ acceptanceId: 'A1', boqItemId: 'B02', partyId: null, deltaVnd, ...overrides });

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

describe('the lines a change of price reaches (ST-CTR-016)', () => {
  it('AC-ST-CTR-016-1, UAT-AC58: is the quantity at the new price, rounded as the new line is, beside the amount the line was accepted for', () => {
    expect(repriceAcceptedLines([line()], new Map([['B02', price('2100000.000000')]]), '2026-06-01')).toEqual([{ ...line(), newUnitPrice: '2100000.000000', newAmountVnd: '1050000000' }]);
    expect(repriceAcceptedLines([line()], new Map([['B02', price('1900000.000000')]]), '2026-06-01')[0]).toMatchObject({ newAmountVnd: '950000000' });
  });

  it('leaves out a line before the day and a line of an item that is not re-priced, and keeps a line whose amount does not change (its balance may still differ)', () => {
    const lines = [
      line({ lineId: 'L1', acceptedOn: '2026-05-31' }),
      line({ lineId: 'L2', acceptedOn: '2026-06-01' }),
      line({ lineId: 'L3', boqItemId: 'B09' }),
      line({ lineId: 'L4', unitPriceSnapshot: '2100000.000000', amountVnd: '1050000000' }),
    ];
    expect(repriceAcceptedLines(lines, new Map([['B02', price('2100000.000000')]]), '2026-06-01').map((each) => each.lineId)).toEqual(['L2', 'L4']);
  });
});

describe('the difference of a balance when its price changes (ST-CTR-016)', () => {
  it('AC-ST-CTR-016-1, UAT-AC58: is the amount at the new price less what the balance is worth, with the sign of the change of price', () => {
    const rise = balancesOf([line()], new Map([['B02', price('2100000.000000')]]), '2026-06-01');
    expect(rise).toHaveLength(1);
    expect(rise[0]).toMatchObject({ oldAmountVnd: '1000000000', newAmountVnd: '1050000000', deltaVnd: '50000000' });
    const fall = balancesOf([line()], new Map([['B02', price('1900000.000000')]]), '2026-06-01');
    expect(fall[0]).toMatchObject({ newAmountVnd: '950000000', deltaVnd: '-50000000' });
  });

  it('is the difference of the amounts, not of the prices times the quantity, so a rounded line ends exactly where a line accepted at the new price would', () => {
    // 3 at 1234.5 was accepted for 3704 (HALF_UP of 3703.5); at 1235.5 it is 3706.5, 3707: the difference is 3, not 3.
    const accepted = line({ quantity: '3.000000', unitPriceSnapshot: '1234.500000', amountVnd: '3704' });
    expect(balancesOf([accepted], new Map([['B02', price('1235.500000', 'HALF_UP')]]), '2026-06-01')[0]).toMatchObject({ newAmountVnd: '3707', deltaVnd: '3' });
    expect(balancesOf([accepted], new Map([['B02', price('1235.500000', 'DOWN')]]), '2026-06-01')[0]).toMatchObject({ newAmountVnd: '3706', deltaVnd: '2' });
  });

  it('has no adjustment for a line before the day, an item that is not re-priced, or a balance whose amount does not change', () => {
    const lines = [
      line({ lineId: 'L1', acceptedOn: '2026-05-31', acceptanceId: 'A0' }),
      line({ lineId: 'L2', acceptedOn: '2026-06-01' }),
      line({ lineId: 'L3', boqItemId: 'B09', acceptanceId: 'A3' }),
      line({ lineId: 'L4', acceptanceId: 'A4', unitPriceSnapshot: '2100000.000000', amountVnd: '1050000000' }),
    ];
    expect(balancesOf(lines, new Map([['B02', price('2100000.000000')]]), '2026-06-01').map((each) => each.acceptanceId)).toEqual(['A1']);
  });

  it('prices a line accepted after a later revision against the same new price (the change order stands over every revision since its day)', () => {
    const later = line({ lineId: 'L9', acceptanceId: 'A2', acceptedOn: '2026-08-02', quantity: '100.000000', unitPriceSnapshot: '2100000.000000', amountVnd: '210000000' });
    expect(balancesOf([later], new Map([['B02', price('2200000.000000')]]), '2026-06-01')[0]).toMatchObject({ deltaVnd: '10000000' });
  });
});

describe('a balance that an earlier adjustment already moved (ST-CTR-016: no double counting)', () => {
  // 100 m3 accepted for 100 dong (1 per m3): +20 by a first adjustment to 1.2, so the balance is worth 120.
  const hundred = line({ quantity: '100.000000', unitPriceSnapshot: '1.000000', amountVnd: '100' });
  const to = (unitPrice: string) => new Map([['B02', price(unitPrice)]]);

  it('AC-ST-CTR-016-1: is moved from what it is worth now, not from the amount it was accepted for: 100, then 120, then 130 posts +10 and ends at 130', () => {
    const [second] = balancesOf([hundred], to('1.300000'), '2026-06-01', [earlier('20')]);
    expect(second).toMatchObject({ oldAmountVnd: '120', newAmountVnd: '130', deltaVnd: '10' });
    // Without the earlier adjustment the same price would post +30 and leave the ledger at 150.
    expect(balancesOf([hundred], to('1.300000'), '2026-06-01')[0]).toMatchObject({ oldAmountVnd: '100', deltaVnd: '30' });
  });

  it('AC-ST-CTR-016-1: takes back an earlier adjustment when the price returns to the price of the acceptance (the difference against the original is nothing, the balance is not)', () => {
    const balances = balancesOf([hundred], to('1.000000'), '2026-06-01', [earlier('20')]);
    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({ oldAmountVnd: '120', newAmountVnd: '100', deltaVnd: '-20' });
    expect(affectedAcceptanceIds(balances)).toEqual(['A1']);
  });

  it('counts a balance that is already worth what the new price makes it as unaffected: no line, and its acceptance is not in the list', () => {
    const balances = balancesOf([hundred], to('1.200000'), '2026-06-01', [earlier('20')]);
    expect(balances).toEqual([]);
    expect(affectedAcceptanceIds(balances)).toEqual([]);
    expect(totalDelta(balances)).toBe('0');
  });

  it('adds every earlier difference of the balance, with its sign, and reads them on the whole balance and not on each line', () => {
    const lines = [
      line({ lineId: 'L1', quantity: '60.000000', unitPriceSnapshot: '1.000000', amountVnd: '60' }),
      line({ lineId: 'L2', quantity: '40.000000', unitPriceSnapshot: '1.000000', amountVnd: '40' }),
    ];
    // +20, then -5, then +3: the balance is worth 118.
    const [balance] = balancesOf(lines, to('1.500000'), '2026-06-01', [earlier('20'), earlier('-5'), earlier('3')]);
    expect(balance).toMatchObject({ lineIds: ['L1', 'L2'], oldAmountVnd: '118', newAmountVnd: '150', deltaVnd: '32' });
  });

  it('reads the earlier differences of its own balance only: another acceptance, item or member does not move it', () => {
    const others = [earlier('999', { acceptanceId: 'A2' }), earlier('999', { boqItemId: 'B05' }), earlier('999', { partyId: 'P1' })];
    expect(balancesOf([hundred], to('1.300000'), '2026-06-01', others)[0]).toMatchObject({ oldAmountVnd: '100', deltaVnd: '30' });
    const member = line({ partyId: 'P1', quantity: '100.000000', unitPriceSnapshot: '1.000000', amountVnd: '100' });
    expect(balancesOf([member], to('1.300000'), '2026-06-01', [earlier('20'), earlier('7', { partyId: 'P1' })])[0]).toMatchObject({ oldAmountVnd: '107', deltaVnd: '23' });
  });

  it('leaves alone a balance an earlier adjustment moved if the change does not reach its day', () => {
    expect(balancesOf([line({ acceptedOn: '2026-05-31' })], to('1.300000'), '2026-06-01', [earlier('20')])).toEqual([]);
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
    const groups = groupByBalance(repriced, []);
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
    const groups = groupByBalance(repriced, []);
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

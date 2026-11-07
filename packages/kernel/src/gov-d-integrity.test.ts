import {
  acceptedCeilingFinding,
  blockingCode,
  contractCeilingFinding,
  diaryFindings,
  duplicateFindings,
  exceptionFor,
  exceptionWindowEnd,
  judgeIntegrity,
  microUnits,
  normalizedNumber,
  parsePaymentIntegrityParams,
  paymentIntegrityFallback,
  planCeilingFinding,
  robustCentre,
  unitPriceFindings,
} from './gov-d-integrity.ts';
import type { ClaimIdentity, ContractCeilingFacts, IntegrityFinding, LiveException } from './gov-d-integrity.ts';

const RULE = paymentIntegrityFallback().params;
const claim = (over: Partial<ClaimIdentity> = {}): ClaimIdentity => ({ id: 'r1', numbers: ['INV-001'], supplierId: 's1', grossVnd: '1000', invoiceDates: ['2026-07-01'], ...over });
const problem = (work: () => unknown): string | undefined => {
  try {
    work();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return undefined;
};

describe('the rule of payment integrity', () => {
  it('has a built-in default that is flagged as not confirmed and that the schema accepts', () => {
    const fallback = paymentIntegrityFallback();
    expect(fallback.unverified).toBe(true);
    expect(fallback.params.duplicate.block_attrs).toEqual(['NUMBER', 'SUPPLIER', 'AMOUNT']);
    expect(fallback.params.ceilings).toEqual({ plan: 'BLOCK', contract: 'BLOCK', accepted: 'BLOCK' });
  });
  it('refuses params that the registered schema does not know, naming the field', () => {
    expect(problem(() => parsePaymentIntegrityParams({ ...RULE, exception_max_days: 1000 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
    expect(problem(() => parsePaymentIntegrityParams({}))).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
  });
});

describe('DUPLICATE_CLAIM', () => {
  it('compares numbers by letters and digits only', () => {
    expect(normalizedNumber('inv - 001')).toBe('INV001');
  });
  it('blocks when every attribute of the rule matches, even when the number is written another way', () => {
    const found = duplicateFindings(claim(), [claim({ id: 'r2', numbers: ['inv 001'], invoiceDates: ['2026-08-01'] })], RULE.duplicate);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: 'DUPLICATE_CLAIM', kind: 'INVARIANT', severity: 'BLOCK', subject: { other_request_id: 'r2' } });
    expect(found[0]?.params.matched).toEqual(['NUMBER', 'SUPPLIER', 'AMOUNT']);
  });
  it('signals when three attributes match without the ones the rule blocks on', () => {
    const found = duplicateFindings(claim(), [claim({ id: 'r2', numbers: ['OTHER'], invoiceDates: ['2026-07-01'] })], RULE.duplicate);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'SIGNAL', severity: 'WARN' });
    expect(found[0]?.params.matched).toEqual(['SUPPLIER', 'AMOUNT', 'DATE']);
  });
  it('says nothing below the signal count, and never about the request itself', () => {
    expect(duplicateFindings(claim(), [claim({ id: 'r2', numbers: ['X'], supplierId: 's2', invoiceDates: [] })], RULE.duplicate)).toEqual([]);
    expect(duplicateFindings(claim(), [claim()], RULE.duplicate)).toEqual([]);
  });
  it('does not match a missing supplier or a missing number to another missing one', () => {
    const found = duplicateFindings(claim({ numbers: [], supplierId: null }), [claim({ id: 'r2', numbers: [], supplierId: null })], { ...RULE.duplicate, signal_min_matches: 3 });
    expect(found).toEqual([]);
  });
  it('lists the blocking ones first', () => {
    const found = duplicateFindings(claim(), [claim({ id: 'a', numbers: ['Z'], invoiceDates: ['2026-07-01'] }), claim({ id: 'b' })], RULE.duplicate);
    expect(found.map((one) => one.kind)).toEqual(['INVARIANT', 'SIGNAL']);
  });
});

describe('UNIT_PRICE_OUTLIER', () => {
  const line = (over: object = {}) => ({ lineId: 'l1', boqKey: 'B1', unitCode: 'm3', unitPrice: '100', contractUnitPrice: '100', peerPrices: [] as string[], ...over });
  it('reads six decimals exactly', () => {
    expect(microUnits('1.5', 'p')).toBe(1_500_000n);
    expect(problem(() => microUnits('1.1234567', 'p'))).toBe('VALIDATION_FAILED');
  });
  it('is quiet at the tolerance and signals just above it', () => {
    expect(unitPriceFindings([line({ unitPrice: '115' })], RULE.unit_price)).toEqual([]);
    const found = unitPriceFindings([line({ unitPrice: '115.000001' })], RULE.unit_price);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: 'UNIT_PRICE_OUTLIER', kind: 'SIGNAL', params: { reasons: ['CONTRACT_PRICE'] } });
  });
  it('compares with the peers by a robust z-score only with enough of them', () => {
    const peers = ['100', '101', '99', '100', '102'];
    expect(unitPriceFindings([line({ unitPrice: '100', contractUnitPrice: null, peerPrices: peers })], RULE.unit_price)).toEqual([]);
    const found = unitPriceFindings([line({ unitPrice: '180', contractUnitPrice: null, peerPrices: peers })], RULE.unit_price);
    expect(found[0]?.params.reasons).toEqual(['PEER_PRICES']);
    expect(unitPriceFindings([line({ unitPrice: '180', contractUnitPrice: null, peerPrices: peers.slice(0, 4) })], RULE.unit_price)).toEqual([]);
  });
  it('handles peers that all agree by the percentage tolerance against their median', () => {
    const same = ['100', '100', '100', '100', '100'];
    expect(unitPriceFindings([line({ unitPrice: '110', contractUnitPrice: null, peerPrices: same })], RULE.unit_price)).toEqual([]);
    expect(unitPriceFindings([line({ unitPrice: '120', contractUnitPrice: null, peerPrices: same })], RULE.unit_price)[0]?.params.reasons).toEqual(['PEER_PRICES']);
    expect(robustCentre(same)).toEqual({ median: 100, mad: 0 });
  });
  it('treats a contract price of nothing as different from any price above nothing', () => {
    expect(unitPriceFindings([line({ unitPrice: '1', contractUnitPrice: '0' })], RULE.unit_price)).toHaveLength(1);
    expect(unitPriceFindings([line({ unitPrice: '0', contractUnitPrice: '0' })], RULE.unit_price)).toEqual([]);
  });
  it('reports both reasons together', () => {
    const found = unitPriceFindings([line({ unitPrice: '300', peerPrices: ['100', '101', '99', '100', '102'] })], RULE.unit_price);
    expect(found[0]?.params.reasons).toEqual(['CONTRACT_PRICE', 'PEER_PRICES']);
  });
});

describe('QUANTITY_VS_DIARY', () => {
  const period = { periodFrom: '2026-07-01', periodTo: '2026-07-31', workingDays: 20, withDiary: 20, quantities: [] as Array<{ boqKey: string; measured: string; recorded: string | null }> };
  it('is quiet when the diary covers the period and no quantity is recorded', () => {
    expect(diaryFindings([period], RULE.diary)).toEqual([]);
  });
  it('signals a period that the diary covers too little (half the days is the line)', () => {
    expect(diaryFindings([{ ...period, withDiary: 10 }], RULE.diary)).toEqual([]);
    const found = diaryFindings([{ ...period, withDiary: 9 }], RULE.diary);
    expect(found[0]).toMatchObject({ code: 'QUANTITY_VS_DIARY', kind: 'SIGNAL', params: { reason: 'COVERAGE_LOW', working_days: 20, days_with_diary: 9 } });
  });
  it('has nothing to judge in a period with no working day', () => {
    expect(diaryFindings([{ ...period, workingDays: 0, withDiary: 0 }], RULE.diary)).toEqual([]);
  });
  it('signals a quantity above what the diaries record by more than the tolerance, and only when they record one', () => {
    const quantities = [
      { boqKey: 'B1', measured: '110', recorded: '100' },
      { boqKey: 'B2', measured: '110.000001', recorded: '100' },
      { boqKey: 'B3', measured: '999', recorded: null },
    ];
    const found = diaryFindings([{ ...period, quantities }], RULE.diary);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ subject: { boq_key: 'B2' }, params: { reason: 'QUANTITY_ABOVE_DIARY' } });
  });
});

describe('the ceilings', () => {
  const facts = (over: Partial<ContractCeilingFacts> = {}): ContractCeilingFacts => ({
    currentPriceVnd: '1000',
    originalPriceVnd: '1000',
    requestedTotalVnd: '500',
    paidTotalVnd: '200',
    advancePaidVnd: '100',
    advanceRecoveredVnd: '0',
    pendingIncreaseVnd: '0',
    requestKind: 'INTERIM',
    grossVnd: '400',
    advanceRecoveryVnd: '0',
    onBooks: false,
    ...over,
  });
  it('EXCEEDS_CONTRACT is quiet at the price and tells how far above past it', () => {
    expect(contractCeilingFinding(facts({ grossVnd: '500' }), 'BLOCK')).toBeUndefined();
    const above = contractCeilingFinding(facts({ grossVnd: '501' }), 'BLOCK');
    expect(above).toMatchObject({ code: 'EXCEEDS_CONTRACT', kind: 'INVARIANT', params: { basis: 'REQUESTED', over_by_vnd: '1', projected_requested_vnd: '1001' } });
  });
  it('EXCEEDS_CONTRACT counts the advances not yet recovered as cash out', () => {
    const above = contractCeilingFinding(facts({ requestedTotalVnd: '300', paidTotalVnd: '700', advancePaidVnd: '300', grossVnd: '100' }), 'BLOCK');
    expect(above).toMatchObject({ params: { basis: 'CASH_OUT', projected_cash_out_vnd: '1100', over_by_vnd: '100' } });
    expect(contractCeilingFinding(facts({ requestedTotalVnd: '300', paidTotalVnd: '700', advancePaidVnd: '300', advanceRecoveredVnd: '300', grossVnd: '100' }), 'BLOCK')).toBeUndefined();
  });
  it('EXCEEDS_CONTRACT does not count a request twice once it is on the books, and an advance adds cash, not a claim', () => {
    expect(contractCeilingFinding(facts({ requestedTotalVnd: '900', grossVnd: '400', onBooks: true }), 'BLOCK')).toBeUndefined();
    expect(contractCeilingFinding(facts({ requestKind: 'ADVANCE', grossVnd: '300', paidTotalVnd: '600' }), 'BLOCK')).toBeUndefined();
    expect(contractCeilingFinding(facts({ requestKind: 'ADVANCE', grossVnd: '300', paidTotalVnd: '700' }), 'BLOCK')).toMatchObject({ params: { basis: 'CASH_OUT', projected_requested_vnd: '500', over_by_vnd: '100' } });
  });
  it('a ceiling the rule sets to WARN is a signal, not an invariant', () => {
    expect(contractCeilingFinding(facts({ grossVnd: '900' }), 'WARN')).toMatchObject({ kind: 'SIGNAL', severity: 'WARN' });
  });
  it('EXCEEDS_PLAN compares the net with what the line has left after what is disbursed and in flight', () => {
    const base = { allocatedVnd: '1000', disbursedVnd: '300', inFlightVnd: '200' };
    expect(planCeilingFinding({ ...base, netVnd: '500' }, 'BLOCK')).toBeUndefined();
    expect(planCeilingFinding({ ...base, netVnd: '501' }, 'BLOCK')).toMatchObject({ code: 'EXCEEDS_PLAN', params: { available_vnd: '500', over_by_vnd: '1' } });
    expect(planCeilingFinding({ ...base, netVnd: '-50' }, 'BLOCK')).toBeUndefined();
    expect(planCeilingFinding({ allocatedVnd: '100', disbursedVnd: '300', inFlightVnd: '0', netVnd: '10' }, 'BLOCK')).toMatchObject({ params: { available_vnd: '0', over_by_vnd: '10' } });
  });
  it('EXCEEDS_ACCEPTED adds what others hold on the acceptance to this request', () => {
    expect(acceptedCeilingFinding({ acceptedVnd: '1000', claimedByOthersVnd: '600', grossVnd: '400' }, 'BLOCK')).toBeUndefined();
    expect(acceptedCeilingFinding({ acceptedVnd: '1000', claimedByOthersVnd: '600', grossVnd: '401' }, 'BLOCK')).toMatchObject({ code: 'EXCEEDS_ACCEPTED', params: { over_by_vnd: '1' } });
  });
  it('refuses an amount that is not whole dong', () => {
    expect(problem(() => planCeilingFinding({ allocatedVnd: '1.5', disbursedVnd: '0', inFlightVnd: '0', netVnd: '1' }, 'BLOCK'))).toBe('VALIDATION_FAILED');
  });
});

describe('exceptions and the outcome', () => {
  const exceed = (code: 'EXCEEDS_PLAN' | 'EXCEEDS_CONTRACT' | 'EXCEEDS_ACCEPTED', over: string): IntegrityFinding => ({ code, kind: 'INVARIANT', severity: 'BLOCK', subject: {}, params: { over_by_vnd: over } });
  const exception = (over: Partial<LiveException> = {}): LiveException => ({ id: 'e1', ceiling: 'EXCEEDS_PLAN', allowedAmountVnd: '100', validTo: '2026-12-31', ...over });
  const signal: IntegrityFinding = { code: 'UNIT_PRICE_OUTLIER', kind: 'SIGNAL', severity: 'WARN', subject: {}, params: {} };

  it('an exception covers the ceiling it names, up to its amount and until its day', () => {
    expect(exceptionFor(exceed('EXCEEDS_PLAN', '100'), [exception()], '2026-12-31')?.id).toBe('e1');
    expect(exceptionFor(exceed('EXCEEDS_PLAN', '101'), [exception()], '2026-12-31')).toBeUndefined();
    expect(exceptionFor(exceed('EXCEEDS_PLAN', '100'), [exception()], '2027-01-01')).toBeUndefined();
    expect(exceptionFor(exceed('EXCEEDS_CONTRACT', '1'), [exception()], '2026-12-01')).toBeUndefined();
    expect(exceptionFor(exceed('EXCEEDS_ACCEPTED', '1'), [exception({ ceiling: 'EXCEEDS_PLAN' })], '2026-12-01')).toBeUndefined();
    expect(exceptionFor(signal, [exception()], '2026-12-01')).toBeUndefined();
  });
  it('BLOCKED while an invariant stands; the code of the refusal is the ceiling first', () => {
    const verdict = judgeIntegrity([signal, exceed('EXCEEDS_PLAN', '5'), exceed('EXCEEDS_CONTRACT', '5')], [], [], '2026-11-08');
    expect(verdict).toMatchObject({ outcome: 'BLOCKED', invariantCount: 2, signalCount: 1, excusedCount: 0 });
    expect(blockingCode(verdict)).toBe('EXCEEDS_CONTRACT');
  });
  it('SIGNALS once the exception covers every invariant, and the finding says by which', () => {
    const verdict = judgeIntegrity([exceed('EXCEEDS_PLAN', '5')], [exception()], [], '2026-11-08');
    expect(verdict.outcome).toBe('SIGNALS');
    expect(verdict.findings[0]?.excusedBy).toBe('e1');
    expect(verdict.excusedCount).toBe(1);
    expect(blockingCode(verdict)).toBeUndefined();
  });
  it('PASSED only when nothing was found and every source was read; a source that was not read makes it PARTIAL', () => {
    expect(judgeIntegrity([], [], [], '2026-11-08').outcome).toBe('PASSED');
    const partial = judgeIntegrity([], [], ['DIARY', 'DIARY'], '2026-11-08');
    expect(partial).toMatchObject({ outcome: 'PARTIAL', unavailable: ['DIARY'] });
    expect(judgeIntegrity([signal], [], ['DIARY'], '2026-11-08').outcome).toBe('SIGNALS');
  });
  it('the window of an exception ends the number of days of the rule after today', () => {
    expect(exceptionWindowEnd('2026-11-08', 30)).toBe('2026-12-08');
    expect(exceptionWindowEnd('2026-12-20', 30)).toBe('2027-01-19');
    expect(exceptionWindowEnd('2026-11-08', 0)).toBe('2026-11-08');
  });
});

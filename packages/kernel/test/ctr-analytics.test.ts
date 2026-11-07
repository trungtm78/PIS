import {
  CTR_INDICATORS,
  INDICATOR_CODES,
  acceptedToRequested,
  advanceOutstanding,
  advanceOutstandingRatio,
  bidPriceVariance,
  bidPriceVarianceOfSums,
  changeGrowth,
  concentrationOf,
  contractHealthDefaults,
  contractHealthRag,
  contractHealthRagParams,
  daysLate,
  guaranteeCoverage,
  hhiOfValues,
  maxDaysLate,
  paidToAccepted,
  analyticsPercent,
  retentionHeld,
  retentionReleasedRatio,
  singleBidderRate,
  spreadByWeight,
} from '../src/ctr-analytics.ts';
import type { ConcentrationRow, IndicatorResult } from '../src/ctr-analytics.ts';

const thrown = (run: () => unknown): { code?: string; status?: number; detail?: string } | undefined => {
  try {
    run();
  } catch (error) {
    return error as { code?: string; status?: number; detail?: string };
  }
  return undefined;
};

const row = (over: Partial<ConcentrationRow> & { contractId: string; valueVnd: string }): ConcentrationRow => ({ status: 'ACTIVE', investorKey: null, unitKey: null, fundKey: null, contractorId: null, ...over });
const ok = (value: string): Partial<IndicatorResult> => ({ status: 'OK', value, reason: null });

describe('CA-1 the meaning of every indicator is written once', () => {
  it('has a definition for every code, with a formula, the sources and the null policy', () => {
    expect(Object.keys(CTR_INDICATORS).sort()).toEqual([...INDICATOR_CODES].sort());
    for (const code of INDICATOR_CODES) {
      const definition = CTR_INDICATORS[code];
      expect(definition.code).toBe(code);
      expect(definition.name.length).toBeGreaterThan(5);
      expect(definition.formula.length).toBeGreaterThan(5);
      expect(definition.numerator.length).toBeGreaterThan(3);
      expect(definition.sourceTables.length).toBeGreaterThan(0);
      expect(definition.nullPolicy.length).toBeGreaterThan(5);
      // A percent is a ratio and so has a denominator; an amount, a count of days and an index may not.
      if (definition.unit === 'PERCENT') expect(definition.denominator).not.toBeNull();
    }
    expect(Object.isFrozen(CTR_INDICATORS)).toBe(true);
  });

  it('writes a percent half away from zero with two decimals, in either sign, with no float', () => {
    expect(analyticsPercent(1n, 3n)).toBe('33.33');
    expect(analyticsPercent(2n, 3n)).toBe('66.67');
    expect(analyticsPercent(5n, 800n)).toBe('0.63');
    expect(analyticsPercent(-5n, 800n)).toBe('-0.63');
    expect(analyticsPercent(1n, 8000n)).toBe('0.01');
    expect(analyticsPercent(0n, 7n)).toBe('0.00');
    expect(analyticsPercent(-1n, 100000n)).toBe('0.00');
    expect(analyticsPercent(123456789012345678901234n, 1n)).toBe('12345678901234567890123400.00');
  });
});

describe('CA-1 bid against contract price', () => {
  it('is (contract - bid) / bid: 950 against a bid of 1000 is -5.00 percent, and the portfolio is from sums, not the mean of the ratios', () => {
    expect(bidPriceVariance([{ contractValueVnd: '950', winningBidVnd: '1000' }])).toMatchObject({ ...ok('-5.00'), numerator: '-50', denominator: '1000' });
    // 950/1000 is -5%, 2200/2000 is +10%, the mean of the two would be 2.5; the sums give (-50 + 200) / 3000 = 5.00. A contract with no bid is not in either sum.
    const portfolio = bidPriceVariance([
      { contractValueVnd: '950', winningBidVnd: '1000' },
      { contractValueVnd: '2200', winningBidVnd: '2000' },
      { contractValueVnd: '777', winningBidVnd: null },
    ]);
    expect(portfolio).toMatchObject({ ...ok('5.00'), numerator: '150', denominator: '3000' });
  });

  it('is NOT_APPLICABLE, never 0, with no bid on record or a bid of zero', () => {
    expect(bidPriceVariance([{ contractValueVnd: '10', winningBidVnd: null }])).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_WINNING_BID', value: null });
    expect(bidPriceVariance([])).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_WINNING_BID' });
    expect(bidPriceVariance([{ contractValueVnd: '10', winningBidVnd: '0' }])).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'ZERO_DENOMINATOR', value: null });
    expect(bidPriceVarianceOfSums({ contractValueVnd: '1000', winningBidVnd: '1000', rows: 1 })).toMatchObject(ok('0.00'));
  });

  it('refuses a figure that is not whole dong', () => {
    expect(thrown(() => bidPriceVariance([{ contractValueVnd: '9.5', winningBidVnd: '10' }]))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'contract_value_vnd' });
    expect(thrown(() => bidPriceVariance([{ contractValueVnd: '10', winningBidVnd: '1e3' }]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'winning_bid_vnd' });
  });
});

describe('CA-1 change growth, payment, advance, retention', () => {
  it('growth is the approved deltas over the original value: +100 and -20 on 1000 is 8.00; two contracts 80/1000 and 120/3000 are 200/4000 = 5.00', () => {
    expect(changeGrowth([{ originalValueVnd: '1000', approvedDeltasVnd: ['100', '-20'] }])).toMatchObject({ ...ok('8.00'), numerator: '80', denominator: '1000' });
    expect(changeGrowth([{ originalValueVnd: '1000', approvedDeltasVnd: ['80'] }, { originalValueVnd: '3000', approvedDeltasVnd: ['120'] }])).toMatchObject({ ...ok('5.00'), numerator: '200', denominator: '4000' });
    expect(changeGrowth([{ originalValueVnd: '1000', approvedDeltasVnd: [] }])).toMatchObject(ok('0.00'));
    expect(changeGrowth([{ originalValueVnd: '1000', approvedDeltasVnd: ['-250'] }])).toMatchObject(ok('-25.00'));
    expect(changeGrowth([])).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_ROWS' });
    expect(changeGrowth([{ originalValueVnd: '0', approvedDeltasVnd: ['5'] }])).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'ZERO_DENOMINATOR', value: null });
  });

  it('paid over accepted and accepted over requested are ratios of sums; nothing accepted (or requested) is NOT_APPLICABLE', () => {
    const rows = [
      { requestedVnd: '500', acceptedVnd: '400', paidVnd: '300' },
      { requestedVnd: '500', acceptedVnd: '100', paidVnd: '150' },
    ];
    expect(paidToAccepted(rows)).toMatchObject({ ...ok('90.00'), numerator: '450', denominator: '500' });
    expect(acceptedToRequested(rows)).toMatchObject({ ...ok('50.00'), numerator: '500', denominator: '1000' });
    expect(paidToAccepted([{ requestedVnd: '10', acceptedVnd: '0', paidVnd: '5' }])).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'ZERO_DENOMINATOR' });
    expect(acceptedToRequested([{ requestedVnd: '0', acceptedVnd: '0', paidVnd: '0' }])).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'ZERO_DENOMINATOR' });
    expect(paidToAccepted([{ requestedVnd: '10', acceptedVnd: '100', paidVnd: '0' }])).toMatchObject(ok('0.00'));
  });

  it('the advance outstanding is paid less recovered; a contract with no advance is not in it, and none at all is NOT_APPLICABLE', () => {
    const rows = [
      { advancePaidVnd: '1000', advanceRecoveredVnd: '400' },
      { advancePaidVnd: null, advanceRecoveredVnd: null },
      { advancePaidVnd: '500', advanceRecoveredVnd: null },
    ];
    expect(advanceOutstanding(rows)).toMatchObject({ ...ok('1100'), unit: 'VND' });
    expect(advanceOutstandingRatio(rows)).toMatchObject({ ...ok('73.33'), numerator: '1100', denominator: '1500' });
    expect(advanceOutstanding([{ advancePaidVnd: '700', advanceRecoveredVnd: '700' }])).toMatchObject(ok('0'));
    expect(advanceOutstandingRatio([{ advancePaidVnd: '700', advanceRecoveredVnd: '700' }])).toMatchObject(ok('0.00'));
    expect(advanceOutstanding([{ advancePaidVnd: null, advanceRecoveredVnd: null }])).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_ADVANCE', value: null });
    expect(advanceOutstandingRatio([{ advancePaidVnd: '0', advanceRecoveredVnd: '0' }])).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'ZERO_DENOMINATOR' });
  });

  it('the retention held is withheld less released, and the released share its ratio', () => {
    const rows = [
      { retentionWithheldVnd: '50', retentionReleasedVnd: '20' },
      { retentionWithheldVnd: null, retentionReleasedVnd: null },
      { retentionWithheldVnd: '150', retentionReleasedVnd: '0' },
    ];
    expect(retentionHeld(rows)).toMatchObject(ok('180'));
    expect(retentionReleasedRatio(rows)).toMatchObject({ ...ok('10.00'), numerator: '20', denominator: '200' });
    expect(retentionHeld([{ retentionWithheldVnd: null, retentionReleasedVnd: null }])).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_RETENTION' });
    expect(retentionReleasedRatio([{ retentionWithheldVnd: '0', retentionReleasedVnd: null }])).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'ZERO_DENOMINATOR' });
  });
});

describe('CA-1 days late against the original completion date', () => {
  it('counts calendar days from the original due date to the completion, or to the as-of date while open, never below 0', () => {
    expect(daysLate({ originalDueDate: '2026-03-01', completedOn: '2026-03-11' }, '2026-12-31')).toMatchObject(ok('10'));
    expect(daysLate({ originalDueDate: '2026-03-01', completedOn: null }, '2026-03-31')).toMatchObject(ok('30'));
    expect(daysLate({ originalDueDate: '2026-03-01', completedOn: null }, '2026-02-20')).toMatchObject(ok('0'));
    expect(daysLate({ originalDueDate: '2026-03-01', completedOn: '2026-02-01' }, '2026-12-31')).toMatchObject(ok('0'));
    expect(daysLate({ originalDueDate: '2028-02-28', completedOn: '2028-03-01' }, '2028-12-31')).toMatchObject(ok('2'));
    expect(daysLate({ originalDueDate: '2027-02-28', completedOn: '2027-03-01' }, '2027-12-31')).toMatchObject(ok('1'));
  });

  it('is NOT_APPLICABLE without an original due date (0 is on time, not unknown), and a day that does not exist is refused', () => {
    expect(daysLate({ originalDueDate: null, completedOn: null }, '2026-03-01')).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_ORIGINAL_DUE_DATE', value: null });
    expect(thrown(() => daysLate({ originalDueDate: '2026-02-30', completedOn: null }, '2026-03-01'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'original_due_date' });
    expect(thrown(() => daysLate({ originalDueDate: '2026-02-01', completedOn: null }, 'tomorrow'))).toMatchObject({ detail: 'as_of' });
  });

  it('a group is as late as its latest contract, and unknown contracts are left out', () => {
    expect(
      maxDaysLate(
        [
          { originalDueDate: '2026-03-01', completedOn: '2026-03-04' },
          { originalDueDate: '2026-02-01', completedOn: null },
          { originalDueDate: null, completedOn: null },
        ],
        '2026-03-01',
      ),
    ).toMatchObject(ok('28'));
    expect(maxDaysLate([], '2026-03-01')).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_ROWS' });
    expect(maxDaysLate([{ originalDueDate: null, completedOn: null }], '2026-03-01')).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_ORIGINAL_DUE_DATE' });
  });
});

describe('CA-1 guarantee coverage and single-bidder rate', () => {
  it('coverage is what is in force over what is required: 800 of 1000 is 80.00; a contract that requires none is left out', () => {
    expect(guaranteeCoverage([{ requiredVnd: '1000', validVnd: '800' }, { requiredVnd: null, validVnd: '5' }, { requiredVnd: '0', validVnd: null }])).toMatchObject({ ...ok('80.00'), numerator: '800', denominator: '1000' });
    expect(guaranteeCoverage([{ requiredVnd: '1000', validVnd: null }])).toMatchObject(ok('0.00'));
    expect(guaranteeCoverage([{ requiredVnd: '1000', validVnd: '1200' }])).toMatchObject(ok('120.00'));
    expect(guaranteeCoverage([{ requiredVnd: null, validVnd: null }])).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_GUARANTEE_REQUIRED', value: null });
  });

  it('the single-bidder rate is over the contracts whose bidder count is known: 1, 1, 3 and an unknown are 2 of 3 = 66.67', () => {
    expect(singleBidderRate([{ bidderCount: 1 }, { bidderCount: 1 }, { bidderCount: 3 }, { bidderCount: null }])).toMatchObject({ ...ok('66.67'), numerator: '2', denominator: '3' });
    expect(singleBidderRate([{ bidderCount: 4 }])).toMatchObject(ok('0.00'));
    expect(singleBidderRate([{ bidderCount: null }])).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_BIDDER_COUNT' });
    expect(singleBidderRate([])).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_BIDDER_COUNT' });
    expect(thrown(() => singleBidderRate([{ bidderCount: 0 }]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'bidder_count' });
  });
});

describe('CA-1 concentration: top N share and HHI over the ACTIVE value', () => {
  const investors = [
    row({ contractId: 'a', valueVnd: '600', investorKey: 'I1', unitKey: 'U1', fundKey: 'F1' }),
    row({ contractId: 'b', valueVnd: '300', investorKey: 'I2', unitKey: 'U1', fundKey: 'F2' }),
    row({ contractId: 'c', valueVnd: '100', investorKey: 'I2', unitKey: 'U2', fundKey: null }),
    row({ contractId: 'd', valueVnd: '999999', status: 'DRAFT', investorKey: 'I3', unitKey: 'U3', fundKey: 'F3' }),
    row({ contractId: 'e', valueVnd: '5', status: 'CLOSED', investorKey: 'I4' }),
  ];

  it('per investor: 600 and 400 of 1000 are shares of 60 and 40, the top 5 hold all of it and HHI = 60^2 + 40^2 = 5200; draft and closed contracts do not count', () => {
    const result = concentrationOf(investors, 'investor');
    expect(result.groups).toEqual([
      { key: 'I1', valueVnd: '600', sharePct: '60.00' },
      { key: 'I2', valueVnd: '400', sharePct: '40.00' },
    ]);
    expect(result.totalVnd).toBe('1000');
    expect(result.top).toMatchObject({ ...ok('100.00'), numerator: '1000', denominator: '1000' });
    expect(result.hhi).toMatchObject({ ...ok('5200.00'), unit: 'INDEX' });
    expect(concentrationOf(investors, 'investor', 1).top).toMatchObject(ok('60.00'));
  });

  it('per unit and per fund; a contract with no fund is a group of its own so the groups add up to the whole', () => {
    const unit = concentrationOf(investors, 'unit');
    expect(unit.groups.map((group) => [group.key, group.valueVnd])).toEqual([['U1', '900'], ['U2', '100']]);
    expect(unit.hhi).toMatchObject(ok('8200.00'));
    const fund = concentrationOf(investors, 'fund');
    expect(fund.groups.map((group) => [group.key, group.valueVnd])).toEqual([['F1', '600'], ['F2', '300'], ['(none)', '100']]);
    expect(fund.groups.reduce((sum, group) => sum + BigInt(group.valueVnd), 0n)).toBe(BigInt(fund.totalVnd));
    // 0.6^2 + 0.3^2 + 0.1^2 = 0.46
    expect(fund.hhi).toMatchObject(ok('4600.00'));
  });

  it('the top N is the N largest groups, and equal values are told apart by key so the answer is the same on every run', () => {
    const rows = ['d', 'c', 'b', 'a'].map((key) => row({ contractId: key, valueVnd: '100', investorKey: key }));
    const result = concentrationOf(rows, 'investor', 2);
    expect(result.groups.map((group) => group.key)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.top).toMatchObject({ ...ok('50.00'), numerator: '200', denominator: '400' });
    expect(result.hhi).toMatchObject(ok('2500.00'));
    expect(thrown(() => concentrationOf(rows, 'investor', 0))).toMatchObject({ detail: 'top_n' });
    expect(thrown(() => concentrationOf(rows, 'region' as never))).toMatchObject({ detail: 'dimension' });
  });

  it('a joint venture is attributed to its contractors by contract_party.share_pct: 1000 at 60/40 and a sole contract of 500 give P1 600 and P2 900, HHI 5200', () => {
    const rows = [
      row({
        contractId: 'jv',
        valueVnd: '1000',
        contractorId: 'P1',
        parties: [
          { contractorId: 'P1', sharePct: '60.0000', status: 'ACTIVE' },
          { contractorId: 'P2', sharePct: '40.0000', status: 'ACTIVE' },
          { contractorId: 'P3', sharePct: '10.0000', status: 'WITHDRAWN' },
        ],
      }),
      row({ contractId: 'sole', valueVnd: '500', contractorId: 'P2' }),
      row({ contractId: 'orphan', valueVnd: '1', contractorId: null }),
    ];
    const result = concentrationOf(rows, 'contractor');
    expect(result.groups).toEqual([
      { key: 'P2', valueVnd: '900', sharePct: '59.96' },
      { key: 'P1', valueVnd: '600', sharePct: '39.97' },
      { key: '(none)', valueVnd: '1', sharePct: '0.07' },
    ]);
    expect(result.totalVnd).toBe('1501');
    expect(result.shareAnomalies).toEqual([]);
    const clean = concentrationOf(rows.slice(0, 2), 'contractor');
    expect(clean.totalVnd).toBe('1500');
    // (600^2 + 900^2) / 1500^2 = 0.52
    expect(clean.hhi).toMatchObject(ok('5200.00'));
    // The value of a joint venture is the same under every other dimension: it is attributed only to contractors.
    expect(concentrationOf([row({ contractId: 'jv', valueVnd: '1000', investorKey: 'I1', parties: [{ contractorId: 'P1', sharePct: '50', status: 'ACTIVE' }, { contractorId: 'P2', sharePct: '50', status: 'ACTIVE' }] })], 'investor').groups).toEqual([
      { key: 'I1', valueVnd: '1000', sharePct: '100.00' },
    ]);
  });

  it('spreads by the largest remainder so the parts always add up: a third each of 100 is 34, 33, 33; shares that do not add up to 100 are spread in proportion and flagged', () => {
    expect(spreadByWeight(100n, [{ key: 'a', weight: 1n }, { key: 'b', weight: 1n }, { key: 'c', weight: 1n }])).toEqual([
      { key: 'a', amount: 34n },
      { key: 'b', amount: 33n },
      { key: 'c', amount: 33n },
    ]);
    const thirds = concentrationOf(
      [row({ contractId: 'jv3', valueVnd: '100', parties: ['x', 'y', 'z'].map((contractorId) => ({ contractorId, sharePct: '33.3333', status: 'ACTIVE' })) })],
      'contractor',
    );
    expect(thirds.groups.map((group) => group.valueVnd)).toEqual(['34', '33', '33']);
    expect(thirds.shareAnomalies).toEqual(['jv3']);
    const off = concentrationOf([row({ contractId: 'jv', valueVnd: '100', parties: [{ contractorId: 'p1', sharePct: '50', status: 'ACTIVE' }, { contractorId: 'p2', sharePct: '30', status: 'ACTIVE' }] })], 'contractor');
    expect(off.groups.map((group) => [group.key, group.valueVnd])).toEqual([['p1', '63'], ['p2', '37']]);
    expect(off.shareAnomalies).toEqual(['jv']);
    expect(thrown(() => spreadByWeight(10n, [{ key: 'a', weight: 0n }]))).toMatchObject({ detail: 'share_pct' });
    expect(thrown(() => concentrationOf([row({ contractId: 'x', valueVnd: '1', parties: [{ contractorId: 'p', sharePct: '101', status: 'ACTIVE' }] })], 'contractor'))).toMatchObject({ detail: 'share_pct' });
  });

  it('HHI is bounded: n equal groups give 10000 / n, one group gives 10000, and for any shares 10000 / n <= HHI <= 10000', () => {
    expect(hhiOfValues([5n])).toMatchObject(ok('10000.00'));
    expect(hhiOfValues([1n, 1n, 1n, 1n])).toMatchObject(ok('2500.00'));
    expect(hhiOfValues([1n, 1n, 1n])).toMatchObject(ok('3333.33'));
    expect(hhiOfValues([7n, 0n, 0n])).toMatchObject(ok('10000.00'));
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 200; round += 1) {
      const n = 1 + (next() % 12);
      const values = Array.from({ length: n }, () => BigInt(1 + (next() % 1_000_000)) * 1_000_000_000n);
      const index = Number(hhiOfValues(values).value?.replace('.', '')) / 100;
      expect(index).toBeLessThanOrEqual(10000);
      expect(index).toBeGreaterThanOrEqual(Math.floor((10000 / n) * 100) / 100 - 0.01);
    }
  });

  it('is NOT_APPLICABLE, never 0, when nothing is ACTIVE or the value is zero; HHI of nothing is NOT_APPLICABLE too', () => {
    expect(concentrationOf([row({ contractId: 'a', valueVnd: '5', status: 'DRAFT' })], 'investor')).toMatchObject({ groups: [], totalVnd: '0', top: { status: 'NOT_APPLICABLE', reason: 'NO_ACTIVE_CONTRACT' }, hhi: { status: 'NOT_APPLICABLE', reason: 'NO_ACTIVE_CONTRACT' } });
    expect(concentrationOf([], 'unit').hhi).toMatchObject({ status: 'NOT_APPLICABLE', value: null });
    expect(concentrationOf([row({ contractId: 'a', valueVnd: '0', investorKey: 'I1' })], 'investor')).toMatchObject({ top: { reason: 'ZERO_TOTAL' }, hhi: { reason: 'ZERO_TOTAL', value: null } });
    expect(hhiOfValues([])).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_ROWS' });
    expect(thrown(() => concentrationOf([row({ contractId: 'a', valueVnd: '-5' })], 'unit'))).toMatchObject({ detail: 'value_vnd' });
  });

  it('agrees with a recomputation from the raw rows: the groups add up to the total and every share is its value over the total (R16)', () => {
    const rows = Array.from({ length: 40 }, (_, index) => row({ contractId: `c${index}`, valueVnd: String((index + 1) * 1_000_003), investorKey: `I${index % 7}`, unitKey: `U${index % 3}` }));
    for (const dimension of ['investor', 'unit'] as const) {
      const result = concentrationOf(rows, dimension);
      const raw = rows.reduce((sum, item) => sum + BigInt(item.valueVnd), 0n);
      expect(BigInt(result.totalVnd)).toBe(raw);
      expect(result.groups.reduce((sum, group) => sum + BigInt(group.valueVnd), 0n)).toBe(raw);
      for (const group of result.groups) expect(group.sharePct).toBe(analyticsPercent(BigInt(group.valueVnd), raw));
      const squares = result.groups.reduce((sum, group) => sum + BigInt(group.valueVnd) ** 2n, 0n);
      expect(BigInt(result.hhi.numerator as string)).toBe(squares * 10_000n);
      expect(BigInt(result.hhi.denominator as string)).toBe(raw * raw);
    }
  });
});

describe('CA-1 the colour of a contract by the rule CONTRACT_HEALTH_RAG', () => {
  const none = (code: IndicatorResult['code']): IndicatorResult => ({ code, unit: 'PERCENT', value: null, status: 'NOT_APPLICABLE', reason: 'ZERO_DENOMINATOR', numerator: null, denominator: null });
  const input = (over: { late?: string; growth?: string; coverage?: string; paid?: string } = {}) => ({
    daysLate: over.late === undefined ? none('DAYS_LATE') : daysLateOf(over.late),
    changeGrowth: over.growth === undefined ? none('CHANGE_GROWTH') : { ...none('CHANGE_GROWTH'), status: 'OK' as const, reason: null, value: over.growth },
    guaranteeCoverage: over.coverage === undefined ? none('GUARANTEE_COVERAGE') : { ...none('GUARANTEE_COVERAGE'), status: 'OK' as const, reason: null, value: over.coverage },
    paidToAccepted: over.paid === undefined ? none('PAID_TO_ACCEPTED') : { ...none('PAID_TO_ACCEPTED'), status: 'OK' as const, reason: null, value: over.paid },
  });
  function daysLateOf(days: string): IndicatorResult {
    return { code: 'DAYS_LATE', unit: 'DAYS', value: days, status: 'OK', reason: null, numerator: days, denominator: null };
  }

  it('is as bad as the worst indicator that applies, with the dimensions that gave it', () => {
    expect(contractHealthRag(input({ late: '0', growth: '1.00', coverage: '100.00', paid: '90.00' }))).toMatchObject({ level: 'GREEN', drivers: [], ruleCode: 'CONTRACT_HEALTH_RAG' });
    expect(contractHealthRag(input({ late: '1', growth: '1.00', coverage: '100.00', paid: '90.00' }))).toMatchObject({ level: 'AMBER', drivers: ['DAYS_LATE'] });
    expect(contractHealthRag(input({ late: '29', growth: '5.00', coverage: '100.00' }))).toMatchObject({ level: 'AMBER', drivers: ['DAYS_LATE', 'CHANGE_GROWTH'] });
    expect(contractHealthRag(input({ late: '30', growth: '9.99', coverage: '79.99' }))).toMatchObject({ level: 'RED', drivers: ['DAYS_LATE', 'GUARANTEE_COVERAGE'] });
    expect(contractHealthRag(input({ growth: '10.00' }))).toMatchObject({ level: 'RED', drivers: ['CHANGE_GROWTH'] });
    expect(contractHealthRag(input({ coverage: '99.99' }))).toMatchObject({ level: 'AMBER', drivers: ['GUARANTEE_COVERAGE'] });
    expect(contractHealthRag(input({ coverage: '80.00' }))).toMatchObject({ level: 'AMBER' });
    expect(contractHealthRag(input({ paid: '100.01' }))).toMatchObject({ level: 'AMBER', drivers: ['PAID_TO_ACCEPTED'] });
    expect(contractHealthRag(input({ paid: '110.00' }))).toMatchObject({ level: 'RED' });
    expect(contractHealthRag(input({ growth: '-30.00' }))).toMatchObject({ level: 'GREEN' });
  });

  it('leaves out what is NOT_APPLICABLE, and a contract with nothing that applies has no colour (which is not green)', () => {
    const only = contractHealthRag(input({ growth: '1.00' }));
    expect(only.level).toBe('GREEN');
    expect(only.readings.filter((reading) => reading.level === null).map((reading) => reading.dimension)).toEqual(['DAYS_LATE', 'GUARANTEE_COVERAGE', 'PAID_TO_ACCEPTED']);
    expect(contractHealthRag(input())).toMatchObject({ level: null, drivers: [] });
  });

  it('reads the thresholds from the params it is given, and says which thresholds a colour was held to', () => {
    const strict = { ...contractHealthDefaults(), days_late_amber: 5, days_late_red: 10 };
    expect(contractHealthRag(input({ late: '4' }), strict).level).toBe('GREEN');
    expect(contractHealthRag(input({ late: '5' }), strict).level).toBe('AMBER');
    expect(contractHealthRag(input({ late: '10' }), strict)).toMatchObject({ level: 'RED', readings: [{ dimension: 'DAYS_LATE', amber: 5, red: 10, direction: 'HIGHER_IS_WORSE', value: '10', level: 'RED' }, expect.anything(), expect.anything(), expect.anything()] });
    expect(contractHealthRag(input({ coverage: '95.00' }), { ...contractHealthDefaults(), guarantee_coverage_amber_pct: 90 }).level).toBe('GREEN');
  });

  it('judges the params: a key that is missing, unknown, not a number, out of line or not whole days is refused naming the field', () => {
    const base = contractHealthDefaults();
    expect(contractHealthRagParams(base)).toEqual(base);
    expect(thrown(() => contractHealthRagParams(null))).toMatchObject({ code: 'GOVERNANCE_RULE_PARAMS_INVALID', status: 422, detail: 'params' });
    expect(thrown(() => contractHealthRagParams({ ...base, days_late_extra: 1 }))).toMatchObject({ detail: 'days_late_extra' });
    const missing: Record<string, unknown> = { ...base };
    delete missing.days_late_red;
    expect(thrown(() => contractHealthRagParams(missing))).toMatchObject({ detail: 'days_late_red' });
    expect(thrown(() => contractHealthRagParams({ ...base, change_growth_red_pct: '10' }))).toMatchObject({ detail: 'change_growth_red_pct' });
    expect(thrown(() => contractHealthRagParams({ ...base, change_growth_red_pct: Number.NaN }))).toMatchObject({ detail: 'change_growth_red_pct' });
    expect(thrown(() => contractHealthRagParams({ ...base, days_late_amber: 1.5 }))).toMatchObject({ detail: 'days_late_amber' });
    expect(thrown(() => contractHealthRagParams({ ...base, days_late_amber: 40 }))).toMatchObject({ detail: 'days_late_red' });
    expect(thrown(() => contractHealthRagParams({ ...base, change_growth_amber_pct: 11 }))).toMatchObject({ detail: 'change_growth_red_pct' });
    expect(thrown(() => contractHealthRagParams({ ...base, guarantee_coverage_red_pct: 101 }))).toMatchObject({ detail: 'guarantee_coverage_red_pct' });
    expect(thrown(() => contractHealthRagParams({ ...base, paid_to_accepted_red_pct: 99 }))).toMatchObject({ detail: 'paid_to_accepted_red_pct' });
    expect(thrown(() => contractHealthRagParams({ ...base, paid_to_accepted_red_pct: 110.005 }))).toMatchObject({ detail: 'paid_to_accepted_red_pct' });
    expect(thrown(() => contractHealthRag(input(), { ...base, days_late_red: -1 }))).toMatchObject({ code: 'GOVERNANCE_RULE_PARAMS_INVALID' });
  });
});

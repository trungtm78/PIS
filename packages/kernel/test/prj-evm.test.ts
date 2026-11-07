import type { DomainError } from '../src/errors';
import { EAC_METHODS } from '../src/gov-b1-policy';
import type { EacMethod } from '../src/gov-b1-policy';
import {
  EVM_METRICS,
  acceptedUpTo,
  certifiedUpTo,
  computeEvm,
  eacAgainstTotal,
  lineEvm,
  ragOf,
  rollupLines,
  sCurve,
  sCurveDays,
} from '../src/prj-evm';
import type { AcceptanceFact, EvmLineFacts, PaymentFact } from '../src/prj-evm';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const rag = { amberBelow: 0.95, redBelow: 0.85 };
const AS_OF = '2026-01-05';

const line = (over: Partial<EvmLineFacts> = {}): EvmLineFacts => ({
  key: 'L1',
  code: 'L1',
  name: 'Gói 1',
  bacVnd: '1000',
  plannedStart: '2026-01-01',
  plannedFinish: '2026-01-10',
  contracts: [{ contractId: 'C1', valueVnd: '900' }],
  ...over,
});
const accepted = (amountVnd: string, day: string, contractId = 'C1'): AcceptanceFact => ({ contractId, day, amountVnd });
const paid = (grossVnd: string, day: string, reversedDay: string | null = null, contractId = 'C1'): PaymentFact => ({ contractId, day, reversedDay, grossVnd });

describe('what a contract accepted and what it was certified to pay up to a day', () => {
  const ids = new Set(['C1']);
  it('counts only the contracts of the package and only up to the end of the day', () => {
    const facts = [accepted('100', '2026-01-02'), accepted('50', '2026-01-05'), accepted('999', '2026-01-06'), accepted('777', '2026-01-02', 'OTHER')];
    expect(acceptedUpTo(ids, '2026-01-05', facts)).toBe(150n);
    expect(acceptedUpTo(ids, '2026-01-01', facts)).toBe(0n);
  });
  it('lets a reversed payment take nothing from the day it was reversed, and counts it before', () => {
    const facts = [paid('400', '2026-01-02', '2026-01-05'), paid('100', '2026-01-03'), paid('900', '2026-01-09'), paid('5', '2026-01-02', null, 'OTHER')];
    expect(certifiedUpTo(ids, '2026-01-04', facts)).toBe(500n);
    expect(certifiedUpTo(ids, '2026-01-05', facts)).toBe(100n);
  });
});

describe('the figures of one work package on a day (G1-4)', () => {
  it('has the planned value of the baseline, the earned value from what was accepted and the cost from what was certified', () => {
    // budget 1000 on a contract of 900: 450 accepted is half the package
    const result = lineEvm(line(), AS_OF, [accepted('450', '2026-01-04')], [paid('400', '2026-01-04')]);
    expect(result).toMatchObject({ bacVnd: 1000n, pvVnd: 500n, evVnd: 500n, acVnd: 400n, missing: [] });
  });
  it('earns the whole budget when the contract is accepted in full, and no more when more is accepted', () => {
    expect(lineEvm(line(), AS_OF, [accepted('900', '2026-01-02')], []).evVnd).toBe(1000n);
    expect(lineEvm(line(), AS_OF, [accepted('5000', '2026-01-02')], []).evVnd).toBe(1000n);
  });
  it('rounds the earned value to the nearest dong, half up, and not down', () => {
    // 1000 * 2 / 3 = 666.67
    expect(lineEvm(line({ contracts: [{ contractId: 'C1', valueVnd: '3' }] }), AS_OF, [accepted('2', '2026-01-02')], []).evVnd).toBe(667n);
    // 1000 * 1 / 3 = 333.33
    expect(lineEvm(line({ contracts: [{ contractId: 'C1', valueVnd: '3' }] }), AS_OF, [accepted('1', '2026-01-02')], []).evVnd).toBe(333n);
  });
  it('ignores an acceptance or a payment after the day, and a payment reversed by the day', () => {
    const result = lineEvm(line(), AS_OF, [accepted('450', '2026-01-06')], [paid('400', '2026-01-02', '2026-01-05'), paid('50', '2026-01-06')]);
    expect(result).toMatchObject({ evVnd: 0n, acVnd: 0n, missing: [] });
  });
  it('shares the budget over several contracts by their values', () => {
    const two = line({ contracts: [{ contractId: 'C1', valueVnd: '600' }, { contractId: 'C2', valueVnd: '400' }] });
    expect(lineEvm(two, AS_OF, [accepted('300', '2026-01-02', 'C1'), accepted('400', '2026-01-02', 'C2')], []).evVnd).toBe(700n);
  });
  it('has earned and spent nothing, as a fact, for a package with no contract and nothing yet planned', () => {
    expect(lineEvm(line({ contracts: [] }), '2025-12-01', [], [])).toMatchObject({ pvVnd: 0n, evVnd: 0n, acVnd: 0n, missing: [] });
  });
  it('does not know the earned value of a package with no contract once money is planned for it: unknown, never zero', () => {
    const result = lineEvm(line({ contracts: [] }), AS_OF, [], []);
    expect(result).toMatchObject({ pvVnd: 500n, evVnd: null, acVnd: null, missing: ['NO_CONTRACT_LINK'] });
  });
  it('does not know it either for contracts that add up to no value', () => {
    expect(lineEvm(line({ contracts: [{ contractId: 'C1', valueVnd: '0' }] }), AS_OF, [], [])).toMatchObject({ evVnd: null, acVnd: null, missing: ['CONTRACT_VALUE_ZERO'] });
  });
});

describe('the sum of the packages', () => {
  const known = (bac: bigint, pv: bigint, ev: bigint, ac: bigint) => ({ key: 'k', code: 'k', name: 'k', bacVnd: bac, pvVnd: pv, evVnd: ev, acVnd: ac, missing: [] });
  it('adds every figure when every package is known', () => {
    expect(rollupLines([known(100n, 40n, 30n, 35n), known(200n, 100n, 50n, 45n)])).toEqual({ bac: 300n, pv: 140n, ev: 80n, ac: 80n, missing: [] });
  });
  it('is unknown, not a partial sum, as soon as one package is, and gathers each reason once', () => {
    const unknown = { key: 'u', code: 'u', name: 'u', bacVnd: 50n, pvVnd: 10n, evVnd: null, acVnd: null, missing: ['NO_CONTRACT_LINK' as const] };
    const result = rollupLines([known(100n, 40n, 30n, 35n), unknown, { ...unknown, key: 'u2' }]);
    expect(result).toEqual({ bac: 200n, pv: 60n, ev: null, ac: null, missing: ['NO_CONTRACT_LINK'] });
  });
  it('has no baseline to stand on when there is no package at all', () => {
    expect(rollupLines([])).toEqual({ bac: null, pv: null, ev: null, ac: null, missing: ['NO_BASELINE'] });
  });
});

describe('the figures of earned value (G1-4, F01 F02)', () => {
  // The worked example: budget 1000, planned 800 so far, earned 500, spent 625.
  const inputs = { bac: 1000n, pv: 800n, ev: 500n, ac: 625n, missing: [] };

  it('has CPI = EV / AC and SPI = EV / PV with four decimals, and the colours against the lines of the policy', () => {
    const result = computeEvm(inputs, 'CPI_CUMULATIVE', rag, AS_OF);
    expect(result).toMatchObject({ status: 'OK', asOf: AS_OF, eacMethod: 'CPI_CUMULATIVE', bacVnd: '1000', pvVnd: '800', evVnd: '500', acVnd: '625', cpi: '0.8000', spi: '0.6250', ragCpi: 'RED', ragSpi: 'RED', unavailable: {}, missing: [] });
  });
  it('has TCPI = (BAC - EV) / (BAC - AC): the efficiency the rest of the work must reach', () => {
    // 500 / 375
    expect(computeEvm(inputs, 'CPI_CUMULATIVE', rag, AS_OF).tcpi).toBe('1.3333');
  });

  it('estimates at completion as BAC over the cumulative CPI: 1000 x 625 / 500', () => {
    expect(computeEvm(inputs, 'CPI_CUMULATIVE', rag, AS_OF)).toMatchObject({ eacVnd: '1250', etcVnd: '625', vacVnd: '-250' });
  });
  it('estimates at completion as the cost so far plus the work left at the budgeted rate: 625 + 500', () => {
    expect(computeEvm(inputs, 'AC_PLUS_REMAINING', rag, AS_OF)).toMatchObject({ eacVnd: '1125', etcVnd: '500', vacVnd: '-125' });
  });
  it('estimates at completion as the cost so far plus the work left over CPI x SPI: 625 + 500 x 625 x 800 / 500^2', () => {
    expect(computeEvm(inputs, 'AC_PLUS_REMAINING_OVER_CPI_SPI', rag, AS_OF)).toMatchObject({ eacVnd: '1625', etcVnd: '1000', vacVnd: '-625' });
  });
  it('writes the method it used into the answer, for all three formulas, and the three differ on this project', () => {
    const results = EAC_METHODS.map((method: EacMethod) => computeEvm(inputs, method, rag, AS_OF));
    expect(results.map((result) => result.eacMethod)).toEqual([...EAC_METHODS]);
    expect(new Set(results.map((result) => result.eacVnd)).size).toBe(3);
  });
  it('rounds the estimate to the nearest dong', () => {
    // 1000 x 100 / 300 = 333.33 ; 1000 x 200 / 300 = 666.67
    expect(computeEvm({ bac: 1000n, pv: 500n, ev: 300n, ac: 100n, missing: [] }, 'CPI_CUMULATIVE', rag, AS_OF).eacVnd).toBe('333');
    expect(computeEvm({ bac: 1000n, pv: 500n, ev: 300n, ac: 200n, missing: [] }, 'CPI_CUMULATIVE', rag, AS_OF).eacVnd).toBe('667');
  });
  it('is a project ahead of schedule and under cost: both indices above one, green, EAC under the budget', () => {
    const result = computeEvm({ bac: 1000n, pv: 400n, ev: 500n, ac: 400n, missing: [] }, 'CPI_CUMULATIVE', rag, AS_OF);
    expect(result).toMatchObject({ cpi: '1.2500', spi: '1.2500', ragCpi: 'GREEN', ragSpi: 'GREEN', eacVnd: '800', vacVnd: '200' });
  });

  describe('the colours', () => {
    it('is green at the amber line and above, amber from the red line up to it, red below, by whole numbers and not floats', () => {
      expect(ragOf('0.9500', rag)).toBe('GREEN');
      expect(ragOf('1.2000', rag)).toBe('GREEN');
      expect(ragOf('0.9499', rag)).toBe('AMBER');
      expect(ragOf('0.8500', rag)).toBe('AMBER');
      expect(ragOf('0.8499', rag)).toBe('RED');
      expect(ragOf('0.0000', rag)).toBe('RED');
    });
    it('has no colour for an index that is not there', () => {
      expect(ragOf(null, rag)).toBeNull();
    });
  });

  describe('chưa đủ dữ liệu: a figure that cannot be known is never shown as zero', () => {
    it('empties every figure when one of the four measures is unknown, keeps the ones that are known and names the reasons', () => {
      const result = computeEvm({ bac: 1000n, pv: 800n, ev: null, ac: null, missing: ['NO_CONTRACT_LINK'] }, 'CPI_CUMULATIVE', rag, AS_OF);
      expect(result).toMatchObject({ status: 'INSUFFICIENT', bacVnd: '1000', pvVnd: '800', evVnd: null, acVnd: null, cpi: null, spi: null, eacVnd: null, etcVnd: null, vacVnd: null, tcpi: null, ragCpi: null, ragSpi: null, missing: ['NO_CONTRACT_LINK'] });
      expect(result.unavailable).toEqual({ ev: 'NO_DATA', ac: 'NO_DATA', cpi: 'NO_DATA', spi: 'NO_DATA', eac: 'NO_DATA', etc: 'NO_DATA', vac: 'NO_DATA', tcpi: 'NO_DATA' });
    });
    it('has no budget and no plan either when there is no baseline: every metric unavailable, none a zero', () => {
      const result = computeEvm({ bac: null, pv: null, ev: null, ac: null, missing: ['NO_BASELINE'] }, 'CPI_CUMULATIVE', rag, AS_OF);
      expect(result.status).toBe('INSUFFICIENT');
      expect(Object.keys(result.unavailable).sort()).toEqual([...EVM_METRICS].sort());
      for (const field of ['bacVnd', 'pvVnd', 'evVnd', 'acVnd', 'cpi', 'spi', 'eacVnd', 'etcVnd', 'vacVnd', 'tcpi'] as const) expect(result[field]).toBeNull();
    });
  });

  describe('a division by zero is a reason, not an index of zero', () => {
    it('has no CPI and no cumulative-CPI estimate when nothing was spent, and says AC_ZERO', () => {
      const result = computeEvm({ bac: 1000n, pv: 800n, ev: 500n, ac: 0n, missing: [] }, 'CPI_CUMULATIVE', rag, AS_OF);
      expect(result).toMatchObject({ status: 'OK', cpi: null, ragCpi: null, eacVnd: null, etcVnd: null, vacVnd: null, spi: '0.6250' });
      expect(result.unavailable).toEqual({ cpi: 'AC_ZERO', eac: 'AC_ZERO', etc: 'AC_ZERO', vac: 'AC_ZERO' });
    });
    it('has no SPI when nothing was planned, and says PV_ZERO', () => {
      const result = computeEvm({ bac: 1000n, pv: 0n, ev: 0n, ac: 0n, missing: [] }, 'AC_PLUS_REMAINING', rag, AS_OF);
      expect(result).toMatchObject({ spi: null, ragSpi: null, cpi: null });
      expect(result.unavailable).toMatchObject({ spi: 'PV_ZERO', cpi: 'AC_ZERO' });
    });
    it('has a real CPI of zero, red, when money was spent and nothing was earned, but no estimate from a cumulative CPI of zero (EV_ZERO)', () => {
      const result = computeEvm({ bac: 1000n, pv: 800n, ev: 0n, ac: 100n, missing: [] }, 'CPI_CUMULATIVE', rag, AS_OF);
      expect(result).toMatchObject({ cpi: '0.0000', ragCpi: 'RED', spi: '0.0000', eacVnd: null });
      expect(result.unavailable).toMatchObject({ eac: 'EV_ZERO', etc: 'EV_ZERO', vac: 'EV_ZERO' });
    });
    it('keeps the estimate of the budgeted-rate formula when the others cannot divide, since it divides by nothing', () => {
      const result = computeEvm({ bac: 1000n, pv: 800n, ev: 0n, ac: 100n, missing: [] }, 'AC_PLUS_REMAINING', rag, AS_OF);
      expect(result).toMatchObject({ eacVnd: '1100', etcVnd: '1000', vacVnd: '-100' });
      expect(result.unavailable.eac).toBeUndefined();
    });
    it('names the first thing the CPI x SPI formula cannot divide by: EV, then AC, then PV', () => {
      const method = 'AC_PLUS_REMAINING_OVER_CPI_SPI';
      expect(computeEvm({ bac: 1000n, pv: 0n, ev: 0n, ac: 0n, missing: [] }, method, rag, AS_OF).unavailable.eac).toBe('EV_ZERO');
      expect(computeEvm({ bac: 1000n, pv: 0n, ev: 10n, ac: 0n, missing: [] }, method, rag, AS_OF).unavailable.eac).toBe('AC_ZERO');
      expect(computeEvm({ bac: 1000n, pv: 0n, ev: 10n, ac: 10n, missing: [] }, method, rag, AS_OF).unavailable.eac).toBe('PV_ZERO');
    });
    it('has no TCPI when the whole budget was spent (BAC = AC)', () => {
      const result = computeEvm({ bac: 1000n, pv: 1000n, ev: 900n, ac: 1000n, missing: [] }, 'CPI_CUMULATIVE', rag, AS_OF);
      expect(result.tcpi).toBeNull();
      expect(result.unavailable.tcpi).toBe('BAC_EQUALS_AC');
    });
  });

  it('refuses a day that is not a calendar day, unknown inputs or not', () => {
    expect(refusal(() => computeEvm(inputs, 'CPI_CUMULATIVE', rag, '2026-13-01')).detail).toBe('as_of');
    expect(refusal(() => computeEvm({ bac: null, pv: null, ev: null, ac: null, missing: [] }, 'CPI_CUMULATIVE', rag, 'x')).code).toBe('VALIDATION_FAILED');
  });
});

describe('the estimate against the approved total investment (F03)', () => {
  it('says how far the estimate goes over the total in dong and percent, and under it with a sign', () => {
    expect(eacAgainstTotal('1100', '1000')).toEqual({ overVnd: '100', overPct: '10.0000' });
    expect(eacAgainstTotal('900', '1000')).toEqual({ overVnd: '-100', overPct: '-10.0000' });
    expect(eacAgainstTotal('1000', '1000')).toEqual({ overVnd: '0', overPct: '0.0000' });
  });
  it('is nothing when the estimate is unknown, and has no percent of a total of nothing', () => {
    expect(eacAgainstTotal(null, '1000')).toBeNull();
    expect(eacAgainstTotal('50', '0')).toEqual({ overVnd: '50', overPct: null });
  });
});

describe('the days the S-curve is drawn at', () => {
  it('has the first day, the end of every month after it up to the last day, the last day and the day of the view, in order', () => {
    expect(sCurveDays('2026-01-15', '2026-04-10', '2026-02-20')).toEqual(['2026-01-15', '2026-01-31', '2026-02-20', '2026-02-28', '2026-03-31', '2026-04-10']);
  });
  it('goes on to the day of the view when it is after the last day, and stops there', () => {
    expect(sCurveDays('2026-01-01', '2026-01-20', '2026-02-10')).toEqual(['2026-01-01', '2026-01-20', '2026-01-31', '2026-02-10']);
  });
  it('knows a leap year and lists a day that is both month end and a bound once', () => {
    expect(sCurveDays('2028-02-01', '2028-03-15', '2028-02-10')).toEqual(['2028-02-01', '2028-02-10', '2028-02-29', '2028-03-15']);
    expect(sCurveDays('2026-01-31', '2026-02-28', '2026-02-28')).toEqual(['2026-01-31', '2026-02-28']);
  });
  it('leaves out a day of the view before the first day, and ends when the loop is bounded for a plan of absurd length', () => {
    expect(sCurveDays('2026-03-01', '2026-03-05', '2026-01-01')).toEqual(['2026-03-01', '2026-03-05']);
    expect(sCurveDays('2000-01-01', '2200-01-01', '2000-01-01').length).toBeLessThan(700);
  });
});

describe('the S-curve of a project (G1-5)', () => {
  const v0 = line();
  // the plan was revised: the same package now finishes on the 20th
  const current = line({ plannedFinish: '2026-01-20' });
  const acceptances = [accepted('450', '2026-01-03')];
  const payments = [paid('400', '2026-01-04')];

  it('plots the plan of version 0 and the plan now, over the whole life, and earned value and cost only up to the day of the view', () => {
    const curve = sCurve({ v0: [v0], current: [current], asOf: AS_OF, acceptances, payments });
    expect(curve.asOf).toBe(AS_OF);
    expect(curve.missing).toEqual([]);
    expect(curve.points).toEqual([
      { day: '2026-01-01', pvV0Vnd: '100', pvCurrentVnd: '50', evVnd: '0', acVnd: '0' },
      { day: '2026-01-05', pvV0Vnd: '500', pvCurrentVnd: '250', evVnd: '500', acVnd: '400' },
      { day: '2026-01-20', pvV0Vnd: '1000', pvCurrentVnd: '1000', evVnd: null, acVnd: null },
    ]);
  });
  it('does not draw earned value where it cannot be known, and says why, rather than drawing a zero', () => {
    const curve = sCurve({ v0: [v0], current: [line({ contracts: [] })], asOf: AS_OF, acceptances: [], payments: [] });
    expect(curve.missing).toEqual(['NO_CONTRACT_LINK']);
    const first = curve.points[0];
    expect(first).toMatchObject({ day: '2026-01-01', evVnd: null, acVnd: null });
    expect(curve.points.filter((point) => point.evVnd === '0' || point.acVnd === '0')).toEqual([]);
  });
  it('refuses a project with no version 0 and no plan at all (BASELINE_MISSING), not a flat line', () => {
    const error = refusal(() => sCurve({ v0: [], current: [], asOf: AS_OF, acceptances: [], payments: [] }));
    expect([error.code, error.status, error.detail]).toEqual(['BASELINE_MISSING', 422, 'baseline']);
  });
  it('refuses a day of the view that is not a calendar day', () => {
    expect(refusal(() => sCurve({ v0: [v0], current: [current], asOf: '2026-02-31', acceptances, payments })).code).toBe('VALIDATION_FAILED');
  });
  it('reaches the last month end of a plan that runs for a year and keeps the planned value non-decreasing', () => {
    const long = line({ plannedStart: '2026-01-01', plannedFinish: '2026-12-31', bacVnd: '12000000000' });
    const curve = sCurve({ v0: [long], current: [long], asOf: '2026-06-15', acceptances: [], payments: [] });
    expect(curve.points[0]?.day).toBe('2026-01-01');
    expect(curve.points.at(-1)?.day).toBe('2026-12-31');
    expect(curve.points.at(-1)?.pvV0Vnd).toBe('12000000000');
    const series = curve.points.map((point) => BigInt(point.pvV0Vnd));
    expect(series.every((value, index) => index === 0 || value >= (series[index - 1] as bigint))).toBe(true);
    expect(curve.points.map((point) => point.day)).toContain('2026-06-15');
  });
});

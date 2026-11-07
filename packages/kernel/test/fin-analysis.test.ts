import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DomainError } from '../src/errors';
import {
  FIN_DEFAULT_SCENARIOS,
  FIN_FORMULA_VERSION,
  FIN_REASON_TEXT,
  analyse,
  assertScenarios,
  buildReport,
  canonicalModel,
  decimalOf,
  inputsHash,
  isqrt,
  normalizeModel,
  parseScaled,
  reportHash,
} from '../src/fin-analysis';
import type { FinAnalysis, FinLineInput, FinModelInput, FinScenarioInput } from '../src/fin-analysis';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const model = (rate: string, lines: FinLineInput[], convention: 'END' | 'MID' = 'END'): FinModelInput => ({ periodUnit: 'YEAR', discountRatePct: rate, convention, lines });
const textbook = (rate = '10', convention: 'END' | 'MID' = 'END'): FinModelInput =>
  model(rate, [{ period: 0, capex: '1000' }, { period: 1, benefit: '300' }, { period: 2, benefit: '400' }, { period: 3, benefit: '500' }, { period: 4, benefit: '600' }], convention);

// ---- The reference results (KT.02): hand-computed cases in packages/kernel/test/fixtures/fin ---------------------------------------------------

interface Fixture {
  id: string;
  title: string;
  hand_computation: string[];
  tolerance: string;
  input: FinModelInput;
  expected: {
    npv?: string;
    npv_reason?: string;
    irr_pct?: string;
    irr_reason?: string;
    irr_candidates_pct?: string[];
    payback?: string;
    payback_reason?: string;
    discounted_payback?: string;
    discounted_payback_reason?: string;
    bcr?: string;
    bcr_reason?: string;
    tco_reason?: string;
    tco?: { nominal: string; present_value: string; equivalent_per_period?: string; capex_share_pct?: string; by_kind?: Record<string, [string, string]> };
  };
}

const FIXTURES = join(__dirname, 'fixtures', 'fin');
const fixtures: Fixture[] = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Fixture);

describe('the reference results of the formula module (KT.02)', () => {
  it('has the cases the customer asked for, each with its hand computation and its tolerance rule', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(12);
    for (const fixture of fixtures) {
      expect(fixture.id).toMatch(/^FIN-REF-\d{3}$/);
      expect(fixture.hand_computation.length).toBeGreaterThan(0);
      expect(fixture.tolerance).toContain('half away from zero');
    }
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(fixtures.length);
  });

  it.each(fixtures.map((fixture) => [fixture.id, fixture.title, fixture] as const))('%s: %s', (_id, _title, fixture) => {
    const result = analyse(fixture.input);
    const { expected } = fixture;
    if (expected.npv !== undefined) expect(result.npv.value).toBe(expected.npv);
    if (expected.npv_reason !== undefined) expect([result.npv.status, result.npv.reason]).toEqual(['NOT_APPLICABLE', expected.npv_reason]);
    if (expected.irr_pct !== undefined) expect(result.irr.value).toBe(expected.irr_pct);
    if (expected.irr_reason !== undefined) expect([result.irr.status, result.irr.reason]).toEqual(['NOT_APPLICABLE', expected.irr_reason]);
    if (expected.irr_candidates_pct !== undefined) expect(result.irr.detail['candidates_pct']).toEqual(expected.irr_candidates_pct);
    if (expected.payback !== undefined) expect(result.payback.value).toBe(expected.payback);
    if (expected.payback_reason !== undefined) expect(result.payback.reason).toBe(expected.payback_reason);
    if (expected.discounted_payback !== undefined) expect(result.discountedPayback.value).toBe(expected.discounted_payback);
    if (expected.discounted_payback_reason !== undefined) expect(result.discountedPayback.reason).toBe(expected.discounted_payback_reason);
    if (expected.bcr !== undefined) expect(result.bcr.value).toBe(expected.bcr);
    if (expected.bcr_reason !== undefined) expect(result.bcr.reason).toBe(expected.bcr_reason);
    if (expected.tco_reason !== undefined) expect(result.tco.reason).toBe(expected.tco_reason);
    if (expected.tco !== undefined) {
      const tco = result.tco.value;
      expect(tco).not.toBeNull();
      expect(tco?.nominalTotal).toBe(expected.tco.nominal);
      expect(tco?.presentValueTotal).toBe(expected.tco.present_value);
      if (expected.tco.equivalent_per_period !== undefined) expect(tco?.equivalentPerPeriod).toBe(expected.tco.equivalent_per_period);
      if (expected.tco.capex_share_pct !== undefined) expect(tco?.capexSharePct).toBe(expected.tco.capex_share_pct);
      for (const [kind, [nominal, presentValue]] of Object.entries(expected.tco.by_kind ?? {})) {
        expect(tco?.byKind[kind as 'capex']).toEqual({ nominal, presentValue });
      }
    }
  });
});

// ---- Decimal exactness -------------------------------------------------------------------------------------------------------------------

describe('money is exact', () => {
  it('does not carry the float error of 0.1 + 0.2 - 0.3', () => {
    const exact = analyse(model('0', [{ period: 0, capex: '0.30' }, { period: 1, benefit: '0.10' }, { period: 2, benefit: '0.20' }]));
    expect(0.1 + 0.2 - 0.3).not.toBe(0);
    expect(exact.npv.value).toBe('0.00');
    expect(exact.irr.value).toBe('0.000000');
    expect(exact.payback.value).toBe('2.0000');
    expect(exact.table[2]?.cumulativeNet).toBe('0.00');
  });

  it('keeps every digit of a very large amount', () => {
    const big = analyse(model('0', [{ period: 0, capex: '123456789012345678.99' }, { period: 1, benefit: '123456789012345678.99' }]));
    expect(big.npv.value).toBe('0.00');
    const more = analyse(model('0', [{ period: 0, capex: '123456789012345678.98' }, { period: 1, benefit: '123456789012345678.99' }]));
    expect(more.npv.value).toBe('0.01');
  });

  it('rounds half away from zero, once, at the end', () => {
    expect(decimalOf({ n: 5n, d: 2n }, 0)).toBe('3');
    expect(decimalOf({ n: -5n, d: 2n }, 0)).toBe('-3');
    expect(decimalOf({ n: 1n, d: 8n }, 2)).toBe('0.13');
    expect(decimalOf({ n: -1n, d: 8n }, 2)).toBe('-0.13');
    expect(decimalOf({ n: -1n, d: 1000n }, 2)).toBe('0.00');
    expect(decimalOf({ n: 7n, d: 1n }, 2)).toBe('7.00');
  });

  it('takes the integer square root exactly', () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(10n ** 72n * 4n)).toBe(2n * 10n ** 36n);
    expect(isqrt(10n ** 72n * 4n - 1n)).toBe(2n * 10n ** 36n - 1n);
    expect(() => isqrt(-1n)).toThrow(RangeError);
  });

  it('refuses what is not an amount, a rate or a period, naming the field and never the value', () => {
    const reasonOf = (work: () => unknown): unknown => refusal(work).extensions?.['reason'];
    expect(reasonOf(() => parseScaled('1e3', 2, 'x', false))).toBe('NOT_A_DECIMAL');
    expect(reasonOf(() => parseScaled('1,5', 2, 'x', false))).toBe('NOT_A_DECIMAL');
    expect(reasonOf(() => parseScaled('01', 2, 'x', false))).toBe('NOT_A_DECIMAL');
    expect(reasonOf(() => parseScaled('1.001', 2, 'x', false))).toBe('TOO_MANY_DECIMALS');
    expect(reasonOf(() => parseScaled('-1', 2, 'x', false))).toBe('MUST_NOT_BE_NEGATIVE');
    expect(parseScaled('-0', 2, 'x', false)).toBe(0n);
    expect(parseScaled('-1.5', 2, 'x', true)).toBe(-150n);
    expect(reasonOf(() => parseScaled('1'.repeat(19), 2, 'x', false))).toBe('TOO_LARGE');
    expect(reasonOf(() => parseScaled(10 as unknown as string, 2, 'x', false))).toBe('NOT_A_DECIMAL');
    expect(refusal(() => normalizeModel(model('10', [{ period: 1, benefit: '1e3' }]))).detail).toBe('lines[0].benefit');
    expect(refusal(() => normalizeModel(model('10', []))).detail).toBe('lines');
    expect(refusal(() => normalizeModel(model('10', [{ period: 0 }, { period: 0 }]))).extensions?.['reason']).toBe('DUPLICATE_PERIOD');
    expect(refusal(() => normalizeModel(model('10', [{ period: 101 }]))).extensions?.['reason']).toBe('OUT_OF_RANGE');
    expect(refusal(() => normalizeModel(model('10', [{ period: 1.5 }]))).extensions?.['reason']).toBe('OUT_OF_RANGE');
    expect(refusal(() => normalizeModel(model('1000.0001', [{ period: 0 }]))).detail).toBe('discount_rate_pct');
    expect(refusal(() => normalizeModel(model('10.00001', [{ period: 0 }]))).extensions?.['reason']).toBe('TOO_MANY_DECIMALS');
    expect(refusal(() => normalizeModel({ ...textbook(), convention: 'BEGIN' as 'END' })).detail).toBe('convention');
    expect(refusal(() => normalizeModel({ ...textbook(), periodUnit: 'WEEK' as 'YEAR' })).detail).toBe('period_unit');
  });
});

// ---- An independent floating point oracle ---------------------------------------------------------------------------------------------------

/** Not the code under test: the plain textbook formulas on floats, used to check the exact module within a tolerance. */
const oracle = {
  npv: (rate: number, flows: number[]): number => flows.reduce((sum, flow, t) => sum + flow / (1 + rate) ** t, 0),
  npvMid: (rate: number, flows: number[]): number => flows.reduce((sum, flow, t) => sum + flow / (1 + rate) ** (t === 0 ? 0 : t - 0.5), 0),
};

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('against an independent floating point oracle', () => {
  it('gives the NPV of 300 random cash flows within the float tolerance, in both conventions', () => {
    const random = seeded(2026);
    for (let run = 0; run < 300; run += 1) {
      const periods = 1 + Math.floor(random() * 12);
      const rateCents = Math.floor(random() * 3000);
      const lines: FinLineInput[] = [];
      const flows: number[] = [];
      for (let t = 0; t <= periods; t += 1) {
        const benefit = Math.floor(random() * 100000);
        const capex = t === 0 ? 50000 + Math.floor(random() * 100000) : Math.floor(random() * 30000);
        lines.push({ period: t, benefit: (benefit / 100).toFixed(2), capex: (capex / 100).toFixed(2) });
        flows.push((benefit - capex) / 100);
      }
      const rate = rateCents / 10000;
      const rateText = (rateCents / 100).toFixed(2);
      const scale = flows.reduce((sum, flow) => sum + Math.abs(flow), 1);
      const end = analyse(model(rateText, lines));
      const mid = analyse(model(rateText, lines, 'MID'));
      expect(Math.abs(Number(end.npv.value) - oracle.npv(rate, flows))).toBeLessThan(0.005 + 1e-9 * scale);
      expect(Math.abs(Number(mid.npv.value) - oracle.npvMid(rate, flows))).toBeLessThan(0.005 + 1e-9 * scale);
    }
  });

  it('finds an IRR at which the float NPV is zero, and reports no IRR only for a reason', () => {
    const random = seeded(7);
    let found = 0;
    for (let run = 0; run < 150; run += 1) {
      const periods = 2 + Math.floor(random() * 8);
      const lines: FinLineInput[] = [{ period: 0, capex: (1000 + Math.floor(random() * 9000)).toFixed(2) }];
      const flows = [-Number(lines[0]?.capex)];
      for (let t = 1; t <= periods; t += 1) {
        const benefit = Math.floor(random() * 400000) / 100;
        lines.push({ period: t, benefit: benefit.toFixed(2) });
        flows.push(benefit);
      }
      const result = analyse(model('8', lines));
      if (result.irr.status === 'OK') {
        found += 1;
        const rate = Number(result.irr.value) / 100;
        // The rate is rounded to 1e-6 percent (1e-8 as a rate, so an error up to 5e-9): the float NPV may differ from zero by that rate error times the slope of the NPV. Floats are only trusted where the discount factors are not extreme.
        if (rate > -0.5 && rate < 10) {
          const slope = flows.reduce((sum, flow, t) => sum + (t * Math.abs(flow)) / (1 + rate) ** (t + 1), 0);
          expect(Math.abs(oracle.npv(rate, flows))).toBeLessThan(1e-6 + 6e-9 * slope + 1e-12 * flows.reduce((sum, flow) => sum + Math.abs(flow), 0));
        }
        expect(Object.keys(result.irr.detail)).toContain('bracket_pct');
      } else {
        expect(result.irr.reason).not.toBeNull();
        expect(FIN_REASON_TEXT[result.irr.reason as keyof typeof FIN_REASON_TEXT]).toBeTruthy();
      }
    }
    expect(found).toBeGreaterThan(50);
  });

  it('has the simple payback where the cumulative of the table crosses zero', () => {
    const result = analyse(textbook());
    const table = result.table;
    expect(table.map((row) => row.cumulativeNet)).toEqual(['-1000.00', '-700.00', '-300.00', '200.00', '800.00']);
    expect(result.payback.detail).toMatchObject({ recovered_in_period: 3, cumulative_before: '-300.00', cumulative_after: '200.00', falls_below_zero_again: false });
    expect(table.map((row) => row.cumulativePresentValue)).toEqual(['-1000.00', '-727.27', '-396.69', '-21.04', '388.77']);
    expect(table[1]?.factor).toBe('0.90909091');
    expect(table[1]?.presentValue).toBe('272.73');
    expect(table[4]?.factor).toBe('0.68301346');
  });
});

// ---- IRR edges ---------------------------------------------------------------------------------------------------------------------------

describe('IRR', () => {
  it('does not apply without a change of sign, and says why', () => {
    const none = analyse(model('10', [{ period: 0, benefit: '100' }, { period: 1, benefit: '50' }]));
    expect(none.irr).toMatchObject({ status: 'NOT_APPLICABLE', value: null, reason: 'NO_SIGN_CHANGE' });
    const zeros = analyse(model('10', [{ period: 0 }, { period: 3 }]));
    expect(zeros.irr.reason).toBe('NO_SIGN_CHANGE');
    expect(zeros.npv.value).toBe('0.00');
    expect(zeros.payback.reason).toBe('NO_OUTLAY');
    expect(zeros.bcr.reason).toBe('NO_COSTS');
  });

  it('does not pick between several roots, and lists them', () => {
    const result = analyse(model('10', [{ period: 0, capex: '1000' }, { period: 1, benefit: '5000' }, { period: 2, opex: '6000' }]));
    expect(result.irr).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'MULTIPLE_ROOTS' });
    expect(result.irr.detail['sign_changes']).toBe(2);
  });

  it('says when the root lies outside the range that is scanned', () => {
    const below = analyse(model('10', [{ period: 0, capex: '1000' }, { period: 1, benefit: '0.5' }]));
    expect(below.irr.reason).toBe('NO_ROOT_IN_RANGE');
    const above = analyse(model('10', [{ period: 0, capex: '1' }, { period: 1, benefit: '200' }]));
    expect(above.irr.reason).toBe('NO_ROOT_IN_RANGE');
    const edge = analyse(model('10', [{ period: 0, capex: '1000' }, { period: 1, benefit: '1' }]));
    expect(edge.irr.value).toBe('-99.900000');
  });

  it('is the same in both conventions and independent of the discount rate', () => {
    const values = [analyse(textbook('0')).irr.value, analyse(textbook('10', 'MID')).irr.value, analyse(textbook('-100')).irr.value, analyse(textbook('500')).irr.value];
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBe('24.888336');
  });

  it('finds a negative IRR, a root at the grid and a root between grid points', () => {
    const loss = analyse(model('10', [{ period: 0, capex: '100' }, { period: 1, benefit: '40' }, { period: 2, benefit: '40' }]));
    // 40x^2 + 40x - 100 = 0 has no positive root with x = 1/(1+r) < 1... the rate is negative (the flows do not return the outlay)
    expect(Number(loss.irr.value)).toBeLessThan(0);
    const at = analyse(model('10', [{ period: 0, capex: '100' }, { period: 1, benefit: '110' }]));
    expect(at.irr.value).toBe('10.000000');
    expect(at.irr.detail['bracket_pct']).toEqual(['10.000000', '10.000000']);
  });
});

// ---- Payback edges ---------------------------------------------------------------------------------------------------------------------

describe('payback', () => {
  it('is zero periods of waiting for a project with no outlay', () => {
    const free = analyse(model('10', [{ period: 0, benefit: '10' }, { period: 1, benefit: '10' }]));
    expect(free.payback.reason).toBe('NO_OUTLAY');
    expect(free.discountedPayback.reason).toBe('NO_OUTLAY');
  });

  it('starts counting at the first outlay, even when it is not in period 0', () => {
    const late = analyse(model('0', [{ period: 0, benefit: '5' }, { period: 1, capex: '100' }, { period: 2, benefit: '50' }, { period: 3, benefit: '50' }]));
    // cumulative 5, -95, -45, +5: back to zero in period 3 after 45 of the 50
    expect(late.payback.value).toBe('2.9000');
  });

  it('is the last period when the money returns exactly at its end', () => {
    const exact = analyse(model('0', [{ period: 0, capex: '100' }, { period: 1, benefit: '100' }]));
    expect(exact.payback.value).toBe('1.0000');
  });

  it('says when the capital is never recovered and how far it is', () => {
    const never = analyse(model('0', [{ period: 0, capex: '100' }, { period: 1, benefit: '30' }]));
    expect(never.payback).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NOT_RECOVERED', detail: { cumulative_at_end: '-70.00' } });
  });
});

// ---- Benefit/cost ratio and TCO edges -----------------------------------------------------------------------------------------------

describe('benefit/cost ratio and total cost of ownership', () => {
  it('has no ratio when the net cost is not positive, and no per-period cost for a single period', () => {
    const free = analyse(model('5', [{ period: 0, benefit: '100', capex: '10', residual: '50' }]));
    expect(free.bcr.reason).toBe('NO_COSTS');
    expect(free.tco.value?.equivalentPerPeriod).toBeNull();
    expect(free.tco.value?.nominalTotal).toBe('-40.00');
  });

  it('counts the residual value against the cost, in the ratio and in the TCO', () => {
    const result = analyse(model('0', [{ period: 0, capex: '1000' }, { period: 1, benefit: '1200' }, { period: 2, residual: '200' }]));
    expect(result.bcr.value).toBe('1.5000');
    expect(result.tco.value?.nominalTotal).toBe('800.00');
  });

  it('does not depend on how the lines are ordered or split', () => {
    const one = analyse(model('7.5', [{ period: 0, capex: '10.50' }, { period: 1, benefit: '4' }, { period: 2, benefit: '9' }]));
    const two = analyse(model('7.5', [{ period: 2, benefit: '9' }, { period: 1, benefit: '4' }, { period: 0, capex: '10.50' }]));
    expect(two).toEqual(one);
  });
});

// ---- Every measure says how it was made ---------------------------------------------------------------------------------------------

describe('every result carries its formula, its inputs and its assumptions', () => {
  const result: FinAnalysis = analyse(textbook());
  it.each(['npv', 'irr', 'payback', 'discountedPayback', 'bcr', 'tco'] as const)('%s', (name) => {
    const measure = result[name];
    expect(measure.formula.length).toBeGreaterThan(10);
    expect(Object.keys(measure.inputs).length).toBeGreaterThan(0);
    expect(measure.assumptions.length).toBeGreaterThan(0);
    for (const assumption of measure.assumptions) expect(assumption.text.length).toBeGreaterThan(10);
    expect(measure.code.length).toBeGreaterThan(0);
  });

  it('echoes the rate, the convention and the net flows', () => {
    expect(result.npv.inputs).toMatchObject({ discount_rate_pct: '10.0000', convention: 'END', period_unit: 'YEAR', last_period: '4', net_flows: '-1000.00 | 300.00 | 400.00 | 500.00 | 600.00' });
    expect(result.npv.assumptions.map((assumption) => assumption.code)).toEqual(['END_PERIOD', 'RATE_PER_PERIOD', 'EXACT_ARITHMETIC']);
    expect(analyse(textbook('10', 'MID')).npv.assumptions[0]?.code).toBe('MID_PERIOD');
  });

  it('gives a reason in words for every reason it can give', () => {
    for (const text of Object.values(FIN_REASON_TEXT)) expect(text.length).toBeGreaterThan(20);
  });
});

// ---- Scenarios and sensitivity -------------------------------------------------------------------------------------------------------

const scenarioList: FinScenarioInput[] = [...FIN_DEFAULT_SCENARIOS];

describe('scenarios', () => {
  it('runs the base case and the scenarios as deltas to the inputs, never to the results', () => {
    const report = buildReport({ model: textbook(), scenarios: scenarioList });
    expect(report.scenarios.map((scenario) => scenario.code)).toEqual(['BASE', 'FAVOURABLE', 'ADVERSE']);
    const base = report.scenarios[0];
    expect(base?.headline.npv).toBe('388.77');
    const favourable = Number(report.scenarios[1]?.headline.npv);
    const adverse = Number(report.scenarios[2]?.headline.npv);
    expect(favourable).toBeGreaterThan(388.77);
    expect(adverse).toBeLessThan(388.77);
    expect(report.analysis.npv.value).toBe(base?.headline.npv);
  });

  it('equals the model written out by hand with the deltas applied', () => {
    // benefits +10% and capex -5%, rate -1 point: 330, 440, 550, 660 and an outlay of 950 at 9%
    const by = analyse(model('9', [{ period: 0, capex: '950' }, { period: 1, benefit: '330' }, { period: 2, benefit: '440' }, { period: 3, benefit: '550' }, { period: 4, benefit: '660' }]));
    const report = buildReport({ model: textbook(), scenarios: [{ code: 'HAND', label: 'By hand', deltas: { benefitPct: '10', capexPct: '-5', discountRatePp: '-1' } }] });
    const hand = report.scenarios[1];
    expect(hand?.headline.npv).toBe(by.npv.value);
    expect(hand?.headline.irrPct).toBe(by.irr.value);
    expect(hand?.headline.paybackPeriods).toBe(by.payback.value);
    expect(hand?.headline.discountedPaybackPeriods).toBe(by.discountedPayback.value);
    expect(hand?.headline.bcr).toBe(by.bcr.value);
    expect(hand?.headline.tcoPresentValue).toBe(by.tco.value?.presentValueTotal);
  });

  it('delays the benefits and loses what goes past the last period', () => {
    const report = buildReport({ model: textbook('0'), scenarios: [{ code: 'LATE', label: 'Late', deltas: { benefitDelayPeriods: '1' } }] });
    // 300, 400, 500 now come one period later and the 600 of period 4 falls away: -1000 + 1200 = 200
    expect(report.scenarios[1]?.headline.npv).toBe('200.00');
    const shifted = buildReport({ model: textbook('0'), scenarios: [{ code: 'LATE', label: 'Late', deltas: { benefitDelayPeriods: '2' } }] });
    expect(shifted.scenarios[1]?.headline.npv).toBe('-300.00');
  });

  it('refuses a scenario that is not well formed', () => {
    const reasonOf = (scenarios: FinScenarioInput[]): unknown => refusal(() => assertScenarios(scenarios)).extensions?.['reason'];
    expect(reasonOf([{ code: 'BASE', label: 'x', deltas: {} }])).toBe('DUPLICATE_CODE');
    expect(reasonOf([{ code: 'A_B', label: 'x', deltas: {} }, { code: 'A_B', label: 'y', deltas: {} }])).toBe('DUPLICATE_CODE');
    expect(reasonOf([{ code: 'a', label: 'x', deltas: {} }])).toBe('NOT_A_CODE');
    expect(reasonOf([{ code: 'OK_1', label: ' ', deltas: {} }])).toBe('EMPTY');
    expect(reasonOf(Array.from({ length: 11 }, (_, index) => ({ code: `S_${index}`, label: 'x', deltas: {} })))).toBe('TOO_MANY');
    expect(reasonOf([{ code: 'OK_1', label: 'x', deltas: { capexPct: '-100.01' } }])).toBe('OUT_OF_RANGE');
    expect(reasonOf([{ code: 'OK_1', label: 'x', deltas: { benefitPct: '1000.01' } }])).toBe('OUT_OF_RANGE');
    expect(reasonOf([{ code: 'OK_1', label: 'x', deltas: { benefitDelayPeriods: '-1' } }])).toBe('OUT_OF_RANGE');
    expect(reasonOf([{ code: 'OK_1', label: 'x', deltas: { benefitPct: '1.234' } }])).toBe('TOO_MANY_DECIMALS');
    expect(reasonOf([{ code: 'OK_1', label: 'x', deltas: { nonsense: '1' } as never }])).toBe('UNKNOWN_PARAMETER');
    expect(() => assertScenarios([{ code: 'OK_1', label: 'x', deltas: { capexPct: '-100' } }])).not.toThrow();
  });

  it('puts a rate at -100% or below in the scenario as not applicable rather than failing', () => {
    const report = buildReport({ model: textbook('1'), scenarios: [{ code: 'ZERO', label: 'Minus 100', deltas: { discountRatePp: '-101' } }] });
    expect(report.scenarios[1]?.headline.npv).toBeNull();
    expect(report.scenarios[1]?.headline.irrPct).toBe('24.888336');
  });
});

describe('sensitivity', () => {
  const report = buildReport({ model: textbook(), scenarios: scenarioList });

  it('has a one-way table for every parameter, with the base point equal to the base case', () => {
    expect(report.oneWay.map((table) => table.parameter)).toEqual(['discountRatePp', 'benefitPct', 'capexPct', 'opexPct', 'maintenancePct', 'residualPct', 'benefitDelayPeriods']);
    for (const table of report.oneWay) {
      const zero = table.points.find((point) => point.delta === '0');
      expect(zero?.headline.npv).toBe('388.77');
    }
    const benefit = report.oneWay.find((table) => table.parameter === 'benefitPct');
    expect(benefit?.points.map((point) => point.delta)).toEqual(['-20', '-10', '0', '10', '20']);
    // NPV is affine in a percent change of a line: equal steps of 10 give equal differences of 138.88 (a tenth of the PV of the benefits)
    const npvs = (benefit?.points ?? []).map((point) => Number(point.headline.npv));
    const steps = npvs.slice(1).map((value, index) => value - (npvs[index] as number));
    for (const step of steps) expect(Math.abs(step - 138.88)).toBeLessThan(0.02);
  });

  it('has a two-way table whose centre is the base NPV and whose cells follow the axes', () => {
    expect(report.twoWay.xPoints).toEqual(['-20', '-10', '0', '10', '20']);
    expect(report.twoWay.npv).toHaveLength(5);
    expect(report.twoWay.npv[2]?.[2]).toBe('388.77');
    // benefits +20% (right), capex -20% (up): 1388.77 x 1.2 - 800 = 866.52 -> 866.53 rounded from 866.5255
    expect(report.twoWay.npv[0]?.[4]).toBe('866.53');
    expect(refusal(() => buildReport({ model: textbook(), scenarios: [], sensitivity: { twoWay: { x: 'capexPct', xPoints: ['0'], y: 'capexPct', yPoints: ['0'] } } })).extensions?.['reason']).toBe('SAME_PARAMETER');
  });

  it('orders the tornado by the size of the swing, largest first, ties by the order of the parameters', () => {
    const bars = report.tornado;
    expect(bars).toHaveLength(7);
    const swings = bars.map((bar) => Number(bar.swing));
    for (let index = 1; index < swings.length; index += 1) expect(swings[index - 1] as number).toBeGreaterThanOrEqual(swings[index] as number);
    // a one period delay of the benefits moves the NPV by 498.80, benefits +-10% by 277.75, capex +-10% by 200
    expect(bars.slice(0, 3).map((bar) => bar.parameter)).toEqual(['benefitDelayPeriods', 'benefitPct', 'capexPct']);
    expect(bars[0]).toMatchObject({ low: { delta: '0', npv: '388.77' }, high: { delta: '1', npv: '-110.03' }, swing: '498.80' });
    const capex = bars.find((bar) => bar.parameter === 'capexPct');
    expect(capex).toMatchObject({ low: { delta: '-10', npv: '488.77' }, high: { delta: '10', npv: '288.77' }, swing: '200.00' });
    const unused = bars.filter((bar) => bar.swing === '0.00').map((bar) => bar.parameter);
    expect(unused).toEqual(['opexPct', 'maintenancePct', 'residualPct']);
  });

  it('gives the switching value of each line exactly: the change that makes the NPV zero', () => {
    const switching = report.switching;
    expect(switching.map((entry) => entry.parameter)).toEqual(['benefitPct', 'capexPct', 'opexPct', 'maintenancePct', 'residualPct']);
    // benefits: -388.7713 / 1388.7713 x 100 = -27.9928%; capex: +388.7713 / 1000 x 100 = 38.8771%
    expect(switching[0]).toMatchObject({ status: 'OK', pct: '-27.99' });
    expect(switching[1]).toMatchObject({ status: 'OK', pct: '38.88' });
    expect(switching[2]).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'COMPONENT_ZERO' });
    const applied = buildReport({ model: textbook(), scenarios: [{ code: 'SWITCH', label: 'Switch', deltas: { benefitPct: '-27.99' } }] });
    expect(Math.abs(Number(applied.scenarios[1]?.headline.npv))).toBeLessThan(0.2);
  });

  it('can be run around a scenario instead of around the base case', () => {
    const around = buildReport({ model: textbook(), scenarios: [], sensitivity: { around: { capexPct: '10' } } });
    const zero = around.oneWay.find((table) => table.parameter === 'benefitPct')?.points.find((point) => point.delta === '0');
    expect(zero?.headline.npv).toBe('288.77');
  });

  it('refuses a table that is not well formed', () => {
    const reasonOf = (sensitivity: Parameters<typeof buildReport>[0]['sensitivity']): unknown => refusal(() => buildReport({ model: textbook(), scenarios: [], sensitivity })).extensions?.['reason'];
    expect(reasonOf({ oneWay: { nonsense: ['1'] } as never })).toBe('UNKNOWN_PARAMETER');
    expect(reasonOf({ oneWay: { capexPct: [] } })).toBe('POINTS_OUT_OF_RANGE');
    expect(reasonOf({ oneWay: { capexPct: Array.from({ length: 16 }, () => '1') } })).toBe('POINTS_OUT_OF_RANGE');
    expect(reasonOf({ twoWay: { x: 'nonsense' as never, xPoints: ['0'], y: 'capexPct', yPoints: ['0'] } })).toBe('UNKNOWN_PARAMETER');
  });
});

// ---- The fingerprint ---------------------------------------------------------------------------------------------------------------------

describe('the fingerprint of a report', () => {
  it('is the same for the same inputs, whatever the order of the lines, and changes with any input', () => {
    const one = buildReport({ model: textbook(), scenarios: scenarioList });
    const again = buildReport({ model: { ...textbook(), lines: [...textbook().lines].reverse() }, scenarios: scenarioList });
    expect(reportHash(one)).toMatch(/^[0-9a-f]{64}$/);
    expect(reportHash(again)).toBe(reportHash(one));
    expect(one.formulaVersion).toBe(FIN_FORMULA_VERSION);
    const changed = buildReport({ model: textbook('10.0001'), scenarios: scenarioList });
    expect(reportHash(changed)).not.toBe(reportHash(one));
    const other = buildReport({ model: textbook(), scenarios: [] });
    expect(reportHash(other)).not.toBe(reportHash(one));
  });

  it('has a hash of the inputs that ignores how an amount was spelled with trailing nothing and the order of the lines', () => {
    const a = inputsHash({ model: textbook(), scenarios: scenarioList });
    const b = inputsHash({ model: { ...textbook(), lines: [...textbook().lines].reverse() }, scenarios: scenarioList });
    expect(a).toBe(b);
    expect(inputsHash({ model: textbook('11'), scenarios: scenarioList })).not.toBe(a);
    expect(canonicalModel({ ...textbook(), lines: [{ period: 1, benefit: '', capex: '5' }, { period: 0 }] }).lines).toEqual([{ period: 0 }, { period: 1, capex: '5' }]);
  });

  it('is computed in a reasonable time for the longest life cycle', () => {
    const lines: FinLineInput[] = [{ period: 0, capex: '1000000000' }];
    for (let t = 1; t <= 100; t += 1) lines.push({ period: t, benefit: '40000000', opex: '5000000', maintenance: t % 5 === 0 ? '3000000' : '0' });
    const started = Date.now();
    const report = buildReport({ model: model('8.25', lines, 'MID'), scenarios: scenarioList });
    expect(Date.now() - started).toBeLessThan(20000);
    expect(report.analysis.npv.status).toBe('OK');
    expect(report.analysis.irr.status).toBe('OK');
  });
});

import { builtInPack } from '../src/fnd-taxonomy.ts';
import type { FundingPack } from '../src/fnd-taxonomy.ts';
import type { FigureStatus, StoredFigure } from '../src/fnd-actuals.ts';
import { cellFigures, figuresOfProject, percentOf, ratioOf, sumKnown, tmdtInForce, yearPlanOf } from '../src/fnd-figures.ts';
import type { FigureBook, FigureQuery } from '../src/fnd-figures.ts';
import { indicatorsOf, moneyIndicatorsOf } from '../src/fnd-indicators.ts';

const ENTERPRISE = builtInPack('ENTERPRISE');
let counter = 0;

const fig = (over: Partial<StoredFigure> & Pick<StoredFigure, 'kind' | 'amountVnd'>): StoredFigure => {
  counter += 1;
  return {
    id: `f-${counter}`,
    classCode: 'EQUITY',
    tierCode: 'ALL',
    measure: 'DISBURSED',
    grain: over.kind === 'PLAN_YEAR' || over.kind === 'PLAN_ADJUSTED' ? 'YEAR' : 'MONTH',
    planYear: 2026,
    ordinal: over.kind === 'PLAN_YEAR' || over.kind === 'PLAN_ADJUSTED' ? 0 : 1,
    basis: over.kind === 'ACTUAL' ? 'REPORTED' : over.kind === 'ESTIMATE' ? 'OWNER_ESTIMATE' : 'PLAN_DECISION',
    asOfDate: '2026-01-10',
    revision: 1,
    status: 'ACCEPTED',
    ...over,
  };
};
const month = (ordinal: number, amountVnd: string, over: Partial<StoredFigure> = {}): StoredFigure => fig({ kind: 'ACTUAL', ordinal, amountVnd, asOfDate: `2026-${String(ordinal + 1).padStart(2, '0')}-05`, ...over });

const book = (figures: StoredFigure[], over: Partial<FigureBook> = {}): FigureBook => ({ pack: ENTERPRISE, figures, tmdt: [], yearsClosed: new Set<number>(), ...over });
const query = (grain: 'MONTH' | 'QUARTER' | 'YEAR', ordinal: number, asOf: string, over: Partial<FigureQuery> = {}): FigureQuery => ({ period: { grain, planYear: 2026, ordinal }, asOf, measure: 'DISBURSED', view: 'AS_REPORTED', ...over });
const cell = (b: FigureBook, q: FigureQuery, classCode = 'EQUITY') => cellFigures(b, classCode, 'ALL', q);

describe('exact arithmetic of the figure engine', () => {
  it('computes a percent with four decimals, half up, from whole dong, never through a float', () => {
    expect(percentOf(1n, 128n)).toBe('0.7813');
    expect(percentOf(1n, 3n)).toBe('33.3333');
    expect(percentOf(2n, 3n)).toBe('66.6667');
    expect(percentOf(123456789012345678n, 987654321098765432n)).toBe('12.5000');
    expect(percentOf(110n, 100n)).toBe('110.0000');
  });

  it('a ratio with nothing to divide by is ZERO_DENOMINATOR, one with nothing to divide or below zero is NO_DATA, never zero and never infinite', () => {
    expect(ratioOf('5', '0')).toEqual({ ratePct: null, nullReason: 'ZERO_DENOMINATOR' });
    expect(ratioOf('5', null)).toEqual({ ratePct: null, nullReason: 'ZERO_DENOMINATOR' });
    expect(ratioOf(null, '100')).toEqual({ ratePct: null, nullReason: 'NO_DATA' });
    expect(ratioOf('-1', '100')).toEqual({ ratePct: null, nullReason: 'NO_DATA' });
    expect(ratioOf('0', '100')).toEqual({ ratePct: '0.0000', nullReason: null });
    expect(sumKnown([null, null])).toBeNull();
    expect(sumKnown([null, '0'])).toBe('0');
  });
});

describe('PLAN_IN_FORCE around the day of an adjustment (5.2)', () => {
  const figures = [fig({ kind: 'PLAN_YEAR', amountVnd: '1000', asOfDate: '2026-01-10' }), fig({ kind: 'PLAN_ADJUSTED', amountVnd: '1200', asOfDate: '2026-07-01' })];

  it('the first published plan is in force until the day the adjustment takes effect; the adjusted plan from that day, the original stays visible', () => {
    expect(yearPlanOf(figures, 2026, '2026-06-30')).toMatchObject({ planYear: '1000', planAdjusted: null, inForce: '1000' });
    expect(yearPlanOf(figures, 2026, '2026-07-01')).toMatchObject({ planYear: '1000', planAdjusted: '1200', inForce: '1200' });
    expect(yearPlanOf(figures, 2026, '2026-01-09')).toMatchObject({ planYear: null, inForce: null });
  });

  it('the money indicators show the adjustment as a delta and the year ratios divide by the plan in force or by the original', () => {
    const b = book([...figures, month(1, '100', { asOfDate: '2026-02-05' }), month(2, '150', { asOfDate: '2026-03-05' })]);
    const q = query('MONTH', 2, '2026-07-15');
    const projects = [figuresOfProject(b, 'p1', q)];
    const money = Object.fromEntries(moneyIndicatorsOf(ENTERPRISE, projects, q).map((one) => [one.code, one.valueVnd]));
    expect(money).toMatchObject({ PLAN_YEAR: '1000', PLAN_ADJUSTED: '1200', PLAN_ADJUSTMENT_DELTA: '200', PLAN_IN_FORCE: '1200', CUMULATIVE_YTD: '250', REMAINING_YEAR: '950' });
    const rates = Object.fromEntries(indicatorsOf(ENTERPRISE, projects, q).map((one) => [one.code, one]));
    expect(rates['RATE_YEAR_IN_FORCE']).toMatchObject({ numeratorVnd: '250', denominatorVnd: '1200', ratePct: '20.8333', nullReason: null });
    expect(rates['RATE_YEAR_ORIGINAL']).toMatchObject({ denominatorVnd: '1000', ratePct: '25.0000' });
    expect(rates['RATE_YEAR_IN_FORCE']?.numeratorTerm).toBe('CUMULATIVE_YTD');
    expect(rates['RATE_YEAR_IN_FORCE']?.packCode).toBe('ENTERPRISE');
  });

  it('an absent plan is zero in a denominator: the ratio is null with ZERO_DENOMINATOR, and the remaining of the year has no figure', () => {
    const b = book([month(1, '100')]);
    const q = query('MONTH', 1, '2026-03-01');
    const projects = [figuresOfProject(b, 'p1', q)];
    expect(indicatorsOf(ENTERPRISE, projects, q).find((one) => one.code === 'RATE_YEAR_IN_FORCE')).toMatchObject({ ratePct: null, nullReason: 'ZERO_DENOMINATOR', denominatorVnd: '0' });
    expect(moneyIndicatorsOf(ENTERPRISE, projects, q).find((one) => one.code === 'REMAINING_YEAR')?.valueVnd).toBeNull();
  });

  it('a remaining year below zero is shown, never clamped', () => {
    const b = book([fig({ kind: 'PLAN_YEAR', amountVnd: '100' }), month(1, '130', { asOfDate: '2026-02-05' })]);
    const q = query('MONTH', 1, '2026-03-01');
    expect(moneyIndicatorsOf(ENTERPRISE, [figuresOfProject(b, 'p1', q)], q).find((one) => one.code === 'REMAINING_YEAR')?.valueVnd).toBe('-30');
  });
});

describe('knowledge date and status (5.2, I1)', () => {
  it('reads a figure only when its knowledge date is not after the day asked, and never a draft, a submitted or a withdrawn figure', () => {
    const base = fig({ kind: 'PLAN_YEAR', amountVnd: '500', asOfDate: '2026-03-01' });
    const draft = fig({ kind: 'PLAN_ADJUSTED', amountVnd: '900', asOfDate: '2026-03-01', status: 'DRAFT' as FigureStatus });
    const submitted = fig({ kind: 'PLAN_ADJUSTED', amountVnd: '910', asOfDate: '2026-03-01', status: 'SUBMITTED' });
    const withdrawn = fig({ kind: 'PLAN_ADJUSTED', amountVnd: '920', asOfDate: '2026-03-01', status: 'WITHDRAWN' });
    expect(yearPlanOf([base, draft, submitted, withdrawn], 2026, '2026-12-31')).toMatchObject({ planAdjusted: null, inForce: '500' });
  });

  it('a superseded revision is still the truth as of its own day: a correction later does not change what was known before it', () => {
    const first = fig({ kind: 'ACTUAL', ordinal: 1, amountVnd: '100', asOfDate: '2026-02-05', revision: 1, status: 'SUPERSEDED' });
    const corrected = fig({ kind: 'ACTUAL', ordinal: 1, amountVnd: '110', asOfDate: '2026-02-20', revision: 2 });
    const b = book([first, corrected]);
    expect(cell(b, query('MONTH', 1, '2026-02-10')).actual).toBe('100');
    expect(cell(b, query('MONTH', 1, '2026-02-25')).actual).toBe('110');
    expect(cell(b, query('MONTH', 1, '2026-02-01')).actual).toBeNull();
  });

  it('a figure of another measure or another class is never added into the cell asked for', () => {
    const b = book([month(1, '100'), month(1, '77', { measure: 'EXECUTED' }), month(1, '33', { classCode: 'LOAN' })]);
    expect(cell(b, query('MONTH', 1, '2026-03-01')).actual).toBe('100');
    expect(cell(b, query('MONTH', 1, '2026-03-01', { measure: 'EXECUTED' })).actual).toBe('77');
    expect(cell(b, query('MONTH', 1, '2026-03-01'), 'LOAN').actual).toBe('33');
  });
});

describe('cumulative figures and the identity I-CUM (5.2)', () => {
  const months = [100, 250, -40, 0, 75, 300, 10, 20, 30, 40, 50, 60];
  const b = book(months.map((amount, index) => month(index + 1, String(amount), { asOfDate: '2026-01-31' })));

  it('year to date is the running sum of the months: CUMULATIVE_YTD(p) = CUMULATIVE_YTD(p-1) + ACTUAL(p), and the first month is its own actual', () => {
    let running = 0n;
    for (let ordinal = 1; ordinal <= 12; ordinal += 1) {
      const result = cell(b, query('MONTH', ordinal, '2026-12-31'));
      running += BigInt(months[ordinal - 1] ?? 0);
      expect(result.cumulativeYtd).toBe(running.toString());
      expect(result.actual).toBe(String(months[ordinal - 1]));
    }
  });

  it('a negative actual is kept as it is (a reversal), never forced to zero; a zero month is a figure, not a gap', () => {
    expect(cell(b, query('MONTH', 3, '2026-12-31')).actual).toBe('-40');
    expect(cell(b, query('MONTH', 4, '2026-12-31'))).toMatchObject({ actual: '0', gapMonths: [] });
  });

  it('a quarter figure is the sum of its three months and its year to date is the year to date of its last month', () => {
    const quarter = cell(b, query('QUARTER', 2, '2026-12-31'));
    expect(quarter.actual).toBe(String(0 + 75 + 300));
    expect(quarter.cumulativeYtd).toBe(cell(b, query('MONTH', 6, '2026-12-31')).cumulativeYtd);
    expect(cell(b, query('YEAR', 0, '2026-12-31')).actual).toBe(String(months.reduce((total, one) => total + one, 0)));
  });

  it('a quarter or a year with a month missing has no actual, names the month, and its year to date counts what is known', () => {
    const gappy = book(months.filter((_one, index) => index !== 4).map((amount, index) => month(index < 4 ? index + 1 : index + 2, String(amount), { asOfDate: '2026-01-31' })));
    const quarter = cell(gappy, query('QUARTER', 2, '2026-12-31'));
    expect(quarter.actual).toBeNull();
    expect(quarter.gapMonths).toEqual([5]);
    expect(quarter.cumulativeYtd).not.toBeNull();
    expect(cell(gappy, query('YEAR', 0, '2026-12-31')).actual).toBeNull();
  });

  it('a quarter entered whole stands for its months when the months are absent, and counts in the year to date', () => {
    const whole = book([fig({ kind: 'ACTUAL', grain: 'QUARTER', ordinal: 1, amountVnd: '900', asOfDate: '2026-04-05' }), month(4, '10', { asOfDate: '2026-05-05' })]);
    expect(cell(whole, query('QUARTER', 1, '2026-06-01')).actual).toBe('900');
    expect(cell(whole, query('MONTH', 4, '2026-06-01')).cumulativeYtd).toBe('910');
  });

  it('property (seeded): for random years the identity holds in every month and the sum of the quarters is the year', () => {
    let state = 424242;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    for (let round = 0; round < 100; round += 1) {
      const amounts = Array.from({ length: 12 }, () => Math.floor(next() * 2_000_000) - 500_000);
      const random = book(amounts.map((amount, index) => month(index + 1, String(amount), { asOfDate: '2026-01-31' })));
      let previous: bigint | null = null;
      for (let ordinal = 1; ordinal <= 12; ordinal += 1) {
        const result = cell(random, query('MONTH', ordinal, '2026-12-31'));
        const expected: bigint = (previous ?? 0n) + BigInt(amounts[ordinal - 1] ?? 0);
        expect(result.cumulativeYtd).toBe(expected.toString());
        previous = expected;
      }
      const quarters = [1, 2, 3, 4].map((q) => BigInt(cell(random, query('QUARTER', q, '2026-12-31')).actual ?? '0'));
      expect(quarters.reduce((total, one) => total + one, 0n).toString()).toBe(cell(random, query('YEAR', 0, '2026-12-31')).actual);
    }
  });
});

describe('since the start of the project (5.2, 5.3)', () => {
  it('is the opening balance plus every month since the first period, across years, and the ratio divides by the total investment in force', () => {
    const b = book(
      [
        fig({ kind: 'ACTUAL', grain: 'YEAR', planYear: 2024, ordinal: 0, basis: 'OPENING_BALANCE', amountVnd: '500', asOfDate: '2026-01-01' }),
        fig({ kind: 'ACTUAL', grain: 'YEAR', planYear: 2025, ordinal: 0, basis: 'OPENING_BALANCE', amountVnd: '300', asOfDate: '2026-01-01' }),
        ...[1, 2, 3].map((ordinal) => month(ordinal, '100', { planYear: 2026, asOfDate: '2026-04-05' })),
        month(12, '40', { planYear: 2025, asOfDate: '2026-01-02' }),
      ],
      { tmdt: [{ effectiveOn: '2026-01-01', amountVnd: '10000' }, { effectiveOn: '2026-03-01', amountVnd: '12000' }] },
    );
    const q = query('MONTH', 3, '2026-04-10');
    const result = cell(b, q);
    expect(result.cumulativeSinceStart).toBe(String(500 + 300 + 40 + 300));
    expect(tmdtInForce(b, '2026-02-28')).toBe('10000');
    expect(tmdtInForce(b, '2026-04-10')).toBe('12000');
    expect(tmdtInForce(b, '2025-12-31')).toBeNull();
    const rate = indicatorsOf(ENTERPRISE, [figuresOfProject(b, 'p1', q)], q).find((one) => one.code === 'RATE_SINCE_START');
    expect(rate).toMatchObject({ numeratorVnd: '1140', denominatorVnd: '12000', ratePct: '9.5000' });
  });

  it('without an approved total investment the ratio is null with ZERO_DENOMINATOR', () => {
    const b = book([month(1, '100')]);
    const q = query('MONTH', 1, '2026-03-01');
    expect(indicatorsOf(ENTERPRISE, [figuresOfProject(b, 'p1', q)], q).find((one) => one.code === 'RATE_SINCE_START')).toMatchObject({ ratePct: null, nullReason: 'ZERO_DENOMINATOR' });
  });
});

describe('estimate and actual, with the history kept (5.2, 7.3)', () => {
  const march = (over: Partial<StoredFigure> & { amountVnd: string }): StoredFigure => fig({ kind: 'ESTIMATE', ordinal: 3, ...over });
  const figures = [
    march({ amountVnd: '100', asOfDate: '2026-03-10', revision: 1, status: 'SUPERSEDED' }),
    march({ amountVnd: '120', asOfDate: '2026-03-25', revision: 2, status: 'SUPERSEDED' }),
    march({ amountVnd: '130', asOfDate: '2026-04-02', revision: 3, status: 'SUPERSEDED' }),
    fig({ kind: 'ACTUAL', ordinal: 3, amountVnd: '125', asOfDate: '2026-04-05', convertedFromId: 'x', estimateAmountVnd: '130', conversionReason: 'PERIOD_ACTUAL_IN' }),
  ];
  const b = book(figures);

  it('the current estimate is the latest one known on the day asked, and only while the actual is not in', () => {
    expect(cell(b, query('MONTH', 3, '2026-03-12')).estimate).toBe('100');
    expect(cell(b, query('MONTH', 3, '2026-03-31')).estimate).toBe('120');
    expect(cell(b, query('MONTH', 3, '2026-04-03')).estimate).toBe('130');
    expect(cell(b, query('MONTH', 3, '2026-04-10')).estimate).toBeNull();
  });

  it('the estimate as reported is the last one not after the end of the period, whatever was estimated later', () => {
    expect(cell(b, query('MONTH', 3, '2026-04-10')).estimateAsReported).toBe('120');
    expect(cell(b, query('MONTH', 3, '2026-03-12')).estimateAsReported).toBe('100');
  });

  it('the conversion delta and the accuracy of the estimate come from the actual and the estimate as reported', () => {
    const q = query('MONTH', 3, '2026-04-10');
    const projects = [figuresOfProject(b, 'p1', q)];
    expect(moneyIndicatorsOf(ENTERPRISE, projects, q).find((one) => one.code === 'CONVERSION_DELTA')?.valueVnd).toBe('5');
    expect(indicatorsOf(ENTERPRISE, projects, q).find((one) => one.code === 'ESTIMATE_ACCURACY')).toMatchObject({ numeratorVnd: '125', denominatorVnd: '120', ratePct: '104.1667' });
  });

  it('a period with an actual and no estimate has no conversion delta and no accuracy', () => {
    const only = book([fig({ kind: 'ACTUAL', ordinal: 3, amountVnd: '125' })]);
    const q = query('MONTH', 3, '2026-04-10');
    const projects = [figuresOfProject(only, 'p1', q)];
    expect(moneyIndicatorsOf(ENTERPRISE, projects, q).find((one) => one.code === 'CONVERSION_DELTA')?.valueVnd).toBeNull();
    expect(indicatorsOf(ENTERPRISE, projects, q).find((one) => one.code === 'ESTIMATE_ACCURACY')).toMatchObject({ ratePct: null, nullReason: 'ZERO_DENOMINATOR' });
  });
});

describe('ESTIMATE_YEAR with and without gaps (5.3)', () => {
  const plan = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((ordinal) => fig({ kind: 'PLAN_MONTH', ordinal, amountVnd: '100' }));

  it('adds the actual of the months that have one, the estimate of the month, then its plan; the whole year is then a figure', () => {
    const b = book([fig({ kind: 'PLAN_YEAR', amountVnd: '1200' }), ...plan, month(1, '90'), month(2, '95'), fig({ kind: 'ESTIMATE', ordinal: 3, amountVnd: '130' })]);
    const q = query('MONTH', 2, '2026-03-15');
    const result = cell(b, q);
    expect(result.estimateYear).toBe(String(90 + 95 + 130 + 9 * 100));
    const outlook = indicatorsOf(ENTERPRISE, [figuresOfProject(b, 'p1', q)], q).find((one) => one.code === 'RATE_OUTLOOK_YEAR');
    expect(outlook).toMatchObject({ numeratorVnd: '1215', denominatorVnd: '1200', ratePct: '101.2500' });
  });

  it('is null with ESTIMATE_GAP when a month has no actual, no estimate and no plan, and names the month (no silent fill with history)', () => {
    const b = book([fig({ kind: 'PLAN_YEAR', amountVnd: '1200' }), ...plan.filter((one) => one.ordinal !== 7), month(1, '90')]);
    const result = cell(b, query('MONTH', 1, '2026-02-15'));
    expect(result.estimateYear).toBeNull();
    expect(result.estimateYearReason).toBe('ESTIMATE_GAP');
  });

  it('a quarter estimate stands for a quarter whose months have neither figure, as long as no month of it has an actual', () => {
    const months = plan.filter((one) => one.ordinal !== 4 && one.ordinal !== 5 && one.ordinal !== 6);
    const b = book([...months, fig({ kind: 'ESTIMATE', grain: 'QUARTER', ordinal: 2, amountVnd: '333' })]);
    expect(cell(b, query('MONTH', 1, '2026-02-15')).estimateYear).toBe(String(9 * 100 + 333));
  });
});

describe('the phased plan (5.2, 5.3)', () => {
  it('RATE_PERIOD divides by the plan of the same grain: the month plan, the quarter plan, or the sum of its months when only those exist', () => {
    const figures = [fig({ kind: 'PLAN_YEAR', amountVnd: '1200' }), fig({ kind: 'PLAN_MONTH', ordinal: 1, amountVnd: '50' }), fig({ kind: 'PLAN_MONTH', ordinal: 2, amountVnd: '50' }), fig({ kind: 'PLAN_MONTH', ordinal: 3, amountVnd: '100' }), month(1, '25'), month(2, '50'), month(3, '75')];
    const b = book(figures);
    expect(cell(b, query('MONTH', 1, '2026-06-01')).planPeriod).toBe('50');
    expect(cell(b, query('QUARTER', 1, '2026-06-01')).planPeriod).toBe('200');
    const q = query('QUARTER', 1, '2026-06-01');
    expect(indicatorsOf(ENTERPRISE, [figuresOfProject(b, 'p1', q)], q).find((one) => one.code === 'RATE_PERIOD')).toMatchObject({ numeratorVnd: '150', denominatorVnd: '200', ratePct: '75.0000' });
    expect(cell(book([month(1, '25')]), query('MONTH', 1, '2026-06-01')).planPeriod).toBeNull();
  });

  it('RATE_YTD_PHASED divides by the plan up to the end of the period, taking a closed quarter from its quarter plan when its months are absent', () => {
    const figures = [fig({ kind: 'PLAN_QUARTER', grain: 'QUARTER', ordinal: 1, amountVnd: '300' }), fig({ kind: 'PLAN_MONTH', ordinal: 4, amountVnd: '60' }), fig({ kind: 'PLAN_MONTH', ordinal: 5, amountVnd: '70' }), month(1, '100'), month(2, '100'), month(3, '100'), month(4, '50'), month(5, '60')];
    const b = book(figures);
    const q = query('MONTH', 5, '2026-06-10');
    const result = cell(b, q);
    expect(result.planToDate).toBe('430');
    expect(indicatorsOf(ENTERPRISE, [figuresOfProject(b, 'p1', q)], q).find((one) => one.code === 'RATE_YTD_PHASED')).toMatchObject({ numeratorVnd: '410', denominatorVnd: '430', ratePct: '95.3488' });
    expect(cell(book([month(1, '100')]), query('MONTH', 1, '2026-06-10')).planToDate).toBeNull();
  });
});

describe('sources of the actual and the two views (6.3, 5.4)', () => {
  const reported = (ordinal: number, amountVnd: string, over: Partial<StoredFigure> = {}): StoredFigure => month(ordinal, amountVnd, { basis: 'REPORTED', ...over });
  const erp = (ordinal: number, amountVnd: string, over: Partial<StoredFigure> = {}): StoredFigure => month(ordinal, amountVnd, { basis: 'ERP', ...over });

  it('while the period is open the accepted reported figure is official; with none, the books (flash or not); with neither, null and not zero', () => {
    expect(cell(book([reported(1, '100'), erp(1, '90')]), query('MONTH', 1, '2026-06-01')).actual).toBe('100');
    expect(cell(book([erp(1, '90', { flash: true })]), query('MONTH', 1, '2026-06-01'))).toMatchObject({ actual: '90', actualFlash: true, actualBases: ['ERP'] });
    expect(cell(book([]), query('MONTH', 1, '2026-06-01')).actual).toBeNull();
  });

  it('in a year that closed the books are the record of the year (YEAR_END_ERP_WINS)', () => {
    const b = book([reported(1, '100'), erp(1, '90')], { yearsClosed: new Set([2026]) });
    expect(cell(b, query('MONTH', 1, '2026-12-31')).actual).toBe('90');
  });

  it('a pack headed by the Treasury takes the Treasury figure, else the reported one', () => {
    const publicPack: FundingPack = builtInPack('PUBLIC');
    const b = book([month(1, '70', { classCode: 'CURRENT_YEAR', tierCode: 'CENTRAL', basis: 'TREASURY' }), month(1, '60', { classCode: 'CURRENT_YEAR', tierCode: 'CENTRAL', basis: 'REPORTED' })], { pack: publicPack });
    expect(cellFigures(b, 'CURRENT_YEAR', 'CENTRAL', query('MONTH', 1, '2026-06-01')).actual).toBe('70');
  });

  it('a late adjustment counts in the period it was booked in (as reported) or in the period it corrects (restated); the year to date at the end of the year is the same in both', () => {
    const figures = [
      reported(1, '100', { asOfDate: '2026-02-05' }),
      reported(2, '200', { asOfDate: '2026-03-05' }),
      reported(3, '300', { asOfDate: '2026-04-05' }),
      // booked in March, corrects January: +15
      month(3, '15', { basis: 'ADJUSTMENT', adjusts: { planYear: 2026, ordinal: 1 }, asOfDate: '2026-04-06' }),
    ];
    const b = book(figures);
    const asReported = (ordinal: number): string | null => cell(b, query('MONTH', ordinal, '2026-12-31', { view: 'AS_REPORTED' })).actual;
    const restated = (ordinal: number): string | null => cell(b, query('MONTH', ordinal, '2026-12-31', { view: 'RESTATED' })).actual;
    expect([asReported(1), asReported(2), asReported(3)]).toEqual(['100', '200', '315']);
    expect([restated(1), restated(2), restated(3)]).toEqual(['115', '200', '300']);
    expect(cell(b, query('MONTH', 3, '2026-12-31', { view: 'AS_REPORTED' })).cumulativeYtd).toBe(cell(b, query('MONTH', 3, '2026-12-31', { view: 'RESTATED' })).cumulativeYtd);
    // The period in between differs: after January and before the adjustment is booked.
    expect(cell(b, query('MONTH', 2, '2026-12-31', { view: 'AS_REPORTED' })).cumulativeYtd).toBe('300');
    expect(cell(b, query('MONTH', 2, '2026-12-31', { view: 'RESTATED' })).cumulativeYtd).toBe('315');
  });

  it('property (seeded): both views agree at the end of every period after the last adjustment, for random adjustments', () => {
    let state = 31337;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    for (let round = 0; round < 80; round += 1) {
      const base = Array.from({ length: 12 }, (_one, index) => reported(index + 1, String(Math.floor(next() * 1000)), { asOfDate: '2026-01-31' }));
      const adjustments = Array.from({ length: 1 + Math.floor(next() * 3) }, () => {
        const corrected = 1 + Math.floor(next() * 11);
        const booked = corrected + 1 + Math.floor(next() * (12 - corrected));
        return month(booked, String(Math.floor(next() * 100) - 50), { basis: 'ADJUSTMENT', adjusts: { planYear: 2026, ordinal: corrected }, asOfDate: '2026-01-31' });
      });
      const unique = new Map(adjustments.map((one) => [`${one.ordinal}>${one.adjusts?.ordinal}`, one]));
      const b = book([...base, ...unique.values()]);
      const lastBooked = Math.max(...[...unique.values()].map((one) => one.ordinal));
      for (let ordinal = lastBooked; ordinal <= 12; ordinal += 1) {
        expect(cell(b, query('MONTH', ordinal, '2026-12-31', { view: 'AS_REPORTED' })).cumulativeYtd).toBe(cell(b, query('MONTH', ordinal, '2026-12-31', { view: 'RESTATED' })).cumulativeYtd);
      }
    }
  });
});

describe('groups: sums over sums, never the mean of the rates (BR-DIS-04), and the structure of the classes', () => {
  it('the rate of two projects is the sum of the cumulatives over the sum of the plans', () => {
    const a = book([fig({ kind: 'PLAN_YEAR', amountVnd: '100' }), month(1, '50')]);
    const c = book([fig({ kind: 'PLAN_YEAR', amountVnd: '900' }), month(1, '90')]);
    const q = query('MONTH', 1, '2026-06-01');
    const projects = [figuresOfProject(a, 'a', q), figuresOfProject(c, 'c', q)];
    const found = indicatorsOf(ENTERPRISE, projects, q).find((one) => one.code === 'RATE_YEAR_IN_FORCE');
    expect(found).toMatchObject({ numeratorVnd: '140', denominatorVnd: '1000', ratePct: '14.0000', projects: 2 });
    expect(indicatorsOf(ENTERPRISE, [projects[0] as (typeof projects)[number]], q).find((one) => one.code === 'RATE_YEAR_IN_FORCE')?.ratePct).toBe('50.0000');
  });

  it('the structure share is one rate for each additive class over the sum of the classes; a class without figures is null with NO_DATA', () => {
    const b = book([month(1, '300'), month(1, '700', { classCode: 'LOAN' })]);
    const q = query('MONTH', 1, '2026-06-01');
    const shares = indicatorsOf(ENTERPRISE, [figuresOfProject(b, 'p', q)], q).filter((one) => one.code === 'STRUCTURE_SHARE');
    expect(shares.map((one) => [one.classCode, one.ratePct])).toEqual([['EQUITY', '30.0000'], ['LOAN', '70.0000'], ['OTHER', null]]);
    expect(shares[2]?.nullReason).toBe('NO_DATA');
  });

  it('the additive figures of a class add up to the figure of the whole (reconciles to parent)', () => {
    const b = book([fig({ kind: 'PLAN_YEAR', amountVnd: '100' }), fig({ kind: 'PLAN_YEAR', amountVnd: '300', classCode: 'LOAN' }), month(1, '10'), month(1, '30', { classCode: 'LOAN' })]);
    const q = query('MONTH', 1, '2026-06-01');
    const projects = [figuresOfProject(b, 'p', q)];
    const total = Object.fromEntries(moneyIndicatorsOf(ENTERPRISE, projects, q).map((one) => [one.code, one.valueVnd]));
    const equity = Object.fromEntries(moneyIndicatorsOf(ENTERPRISE, projects, q, 'EQUITY').map((one) => [one.code, one.valueVnd]));
    const loan = Object.fromEntries(moneyIndicatorsOf(ENTERPRISE, projects, q, 'LOAN').map((one) => [one.code, one.valueVnd]));
    for (const code of ['PLAN_IN_FORCE', 'CUMULATIVE_YTD', 'ACTUAL']) expect((BigInt(equity[code] as string) + BigInt(loan[code] as string)).toString()).toBe(total[code]);
  });

  it('the pack decides which ratios exist: the public pack publishes none through the book (its three come from the lines of a snapshot)', () => {
    const publicPack = builtInPack('PUBLIC');
    const q = query('MONTH', 1, '2026-06-01');
    expect(indicatorsOf(publicPack, [], q)).toEqual([]);
  });
});

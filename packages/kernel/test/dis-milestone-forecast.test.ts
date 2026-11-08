import { DomainError } from '../src/errors';
import {
  accuracyDefaults,
  accuracyPolicyOf,
  cutoffMonthOf,
  forecastAccuracy,
  isMonthDay,
  milestoneDefaults,
  milestonePolicyOf,
  percent2,
  readMilestone,
  readMilestones,
} from '../src/dis-milestone-forecast';
import type { MilestoneInput, MonthFigure } from '../src/dis-milestone-forecast';
import { estimateYear, mergeEstimates } from '../src/dis-forecast';

const policy = milestonePolicyOf(milestoneDefaults());
const failure = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error.detail ?? error.code;
  }
  return 'none';
};

const monthsOf = (amount: string, from = 7): MonthFigure[] => Array.from({ length: 13 - from }, (_, index) => ({ month: from + index, amountVnd: amount, complete: true }));
const base = (over: Partial<MilestoneInput> = {}): MilestoneInput => ({
  planYear: 2026,
  milestone: { code: 'M_0930', monthDay: '09-30', targetPct: 75 },
  atRiskMarginPct: 5,
  cutoffDate: '2026-06-30',
  disbursedVnd: '500',
  planTotalVnd: '1000',
  months: monthsOf('100'),
  actualToDateVnd: null,
  ...over,
});

describe('milestone rule params', () => {
  it('accepts the defaults and reads them back', () => {
    expect(policy.milestones.map((entry) => entry.code)).toEqual(['M_0630', 'M_0930', 'M_1231']);
    expect(policy.atRiskMarginPct).toBe(5);
  });

  it.each([
    ['a repeated code', { ...milestoneDefaults(), milestones: [{ code: 'A_ONE', month_day: '01-31', target_pct: 1 }, { code: 'A_ONE', month_day: '02-28', target_pct: 2 }] }, 'milestones'],
    ['a day that does not exist', { ...milestoneDefaults(), milestones: [{ code: 'A_ONE', month_day: '02-30', target_pct: 1 }] }, 'milestones[0].month_day'],
    ['dates that do not grow', { ...milestoneDefaults(), milestones: [{ code: 'A_ONE', month_day: '09-30', target_pct: 1 }, { code: 'B_TWO', month_day: '06-30', target_pct: 2 }] }, 'milestones[1].month_day'],
    ['a later target that asks for less', { ...milestoneDefaults(), milestones: [{ code: 'A_ONE', month_day: '06-30', target_pct: 50 }, { code: 'B_TWO', month_day: '09-30', target_pct: 40 }] }, 'milestones[1].target_pct'],
    ['no milestone', { ...milestoneDefaults(), milestones: [] }, 'milestones'],
    ['a target above 100', { ...milestoneDefaults(), milestones: [{ code: 'A_ONE', month_day: '06-30', target_pct: 101 }] }, 'milestones[0].target_pct'],
    ['a margin below zero', { ...milestoneDefaults(), at_risk_margin_pct: -1 }, 'at_risk_margin_pct'],
  ])('refuses %s', (_name, params, field) => {
    expect(failure(() => milestonePolicyOf(params))).toBe(field);
  });

  it('knows which month-days exist', () => {
    expect(isMonthDay('02-29')).toBe(true);
    expect(isMonthDay('04-31')).toBe(false);
    expect(isMonthDay('13-01')).toBe(false);
  });
});

describe('percent2', () => {
  it('rounds half up to two decimals from whole numbers', () => {
    expect(percent2(1n, 3n)).toBe('33.33');
    expect(percent2(2n, 3n)).toBe('66.67');
    expect(percent2(5n, 8n)).toBe('62.50');
    expect(percent2(-1n, 3n)).toBe('-33.33');
    expect(percent2(1n, 0n)).toBeNull();
  });
});

describe('readMilestone', () => {
  it('projects the figure of the cutoff plus the forecast months up to the day, month ends exact', () => {
    const reading = readMilestone(base());
    // 500 paid, July, August and September forecast 100 each: 800 of 1000, the target is 750.
    expect(reading).toMatchObject({ projectedVnd: '800', projectedPct: '80.00', targetVnd: '750', gapPct: '5.00', status: 'ON_TRACK', coverage: 'COMPLETE', basis: 'FORECAST', date: '2026-09-30' });
  });

  it('puts a day inside a month pro rata by days, rounded down', () => {
    const reading = readMilestone(base({ milestone: { code: 'M_MID', monthDay: '07-16', targetPct: 55 }, disbursedVnd: '500', months: monthsOf('310') }));
    // July has 31 days: 16/31 of 310 is 160.
    expect(reading.projectedVnd).toBe('660');
    expect(reading.status).toBe('ON_TRACK');
  });

  it('calls the projection AT_RISK within the margin below the target and OFF_TRACK further below', () => {
    expect(readMilestone(base({ months: monthsOf('80') })).status).toBe('AT_RISK'); // 740 of 1000, target 750, margin 5 points
    expect(readMilestone(base({ months: monthsOf('50') })).status).toBe('OFF_TRACK'); // 650
  });

  it('never invents a missing month: a lower bound that does not reach the target is NO_DATA, one that does is ON_TRACK', () => {
    const months = monthsOf('100').map((month) => (month.month === 8 ? { month: 8, amountVnd: null, complete: false } : month));
    const short = readMilestone(base({ months }));
    expect(short).toMatchObject({ projectedVnd: '700', coverage: 'PARTIAL', status: 'NO_DATA' });
    const enough = readMilestone(base({ months, disbursedVnd: '600' }));
    expect(enough).toMatchObject({ coverage: 'PARTIAL', status: 'ON_TRACK' });
  });

  it('treats a month that only some projects forecast as incomplete', () => {
    const months = monthsOf('100').map((month) => (month.month === 9 ? { ...month, complete: false } : month));
    expect(readMilestone(base({ months })).coverage).toBe('PARTIAL');
  });

  it('judges a day that is past on what was paid: ACHIEVED or MISSED, NO_DATA when unknown', () => {
    const past = { milestone: { code: 'M_0630', monthDay: '06-30', targetPct: 50 } };
    expect(readMilestone(base({ ...past, disbursedVnd: '500' }))).toMatchObject({ basis: 'ACTUAL', status: 'ACHIEVED', coverage: 'COMPLETE' });
    expect(readMilestone(base({ ...past, disbursedVnd: '499' })).status).toBe('MISSED');
    const earlier = { milestone: { code: 'M_0331', monthDay: '03-31', targetPct: 30 } };
    expect(readMilestone(base({ ...earlier, actualToDateVnd: '310' })).status).toBe('ACHIEVED');
    expect(readMilestone(base({ ...earlier, actualToDateVnd: null })).status).toBe('NO_DATA');
  });

  it('has no data for a project set with no plan or with no Treasury figure', () => {
    expect(readMilestone(base({ planTotalVnd: '0' })).status).toBe('NO_DATA');
    expect(readMilestone(base({ disbursedVnd: null })).status).toBe('NO_DATA');
  });

  it('a milestone inside the cutoff month after the cutoff is a lower bound', () => {
    const reading = readMilestone(base({ cutoffDate: '2026-06-10', milestone: { code: 'M_0630', monthDay: '06-30', targetPct: 60 } }));
    expect(reading).toMatchObject({ coverage: 'PARTIAL', projectedVnd: '500', status: 'NO_DATA' });
  });

  it('never counts the adjustment month before the end of the year', () => {
    const months = [...monthsOf('10', 10), { month: 13, amountVnd: '900', complete: true }];
    const reading = readMilestone(base({ cutoffDate: '2026-09-30', disbursedVnd: '500', milestone: { code: 'M_1231', monthDay: '12-31', targetPct: 95 }, months }));
    expect(reading.projectedVnd).toBe('530');
  });
});

describe('reading the milestones of an estimate', () => {
  it('agrees with the estimate of the year for the end of the year (the forecast to 31/12 is the estimate)', () => {
    const estimate = estimateYear({ disbursedVnd: '500', cutoffMonth: 6, forecasts: new Map([[7, '100'], [8, '100']]), registered: new Map([[9, '100'], [10, '50'], [11, '50'], [12, '50'], [13, '25']]), planTotalVnd: '1000' });
    const [, , december] = readMilestones(policy, { planYear: 2026, cutoffDate: '2026-06-30', disbursedVnd: estimate.disbursedVnd, planTotalVnd: estimate.planTotalVnd, months: estimate.months }, () => null);
    // The estimate adds the adjustment month, the milestone of 31/12 does not.
    expect(estimate.eacVnd).toBe('975');
    expect(december?.projectedVnd).toBe('950');
    expect(december?.status).toBe('ON_TRACK');
  });

  it('merges projects through mergeEstimates: the months of the group are complete only when every project has them', () => {
    const one = estimateYear({ disbursedVnd: '100', cutoffMonth: 6, forecasts: new Map([[7, '10']]), registered: new Map(), planTotalVnd: '500' });
    const two = estimateYear({ disbursedVnd: '100', cutoffMonth: 6, forecasts: new Map(), registered: new Map([[7, '10']]), planTotalVnd: '500' });
    const merged = mergeEstimates([one, two]);
    expect(merged.months.find((month) => month.month === 7)).toMatchObject({ amountVnd: '20', complete: true });
    expect(merged.months.find((month) => month.month === 8)).toMatchObject({ amountVnd: null, complete: false });
  });

  it('reads the cutoff month of a plan year', () => {
    expect(cutoffMonthOf(2026, '2026-06-30')).toBe(6);
    expect(cutoffMonthOf(2026, '2027-01-15')).toBe(13);
    expect(cutoffMonthOf(2026, '2025-12-31')).toBe(0);
  });
});

describe('forecast accuracy', () => {
  const rule = accuracyPolicyOf(accuracyDefaults());
  const pair = (investorId: string | null, month: number, forecastVnd: string, actualVnd: string, projectId = 'p1') => ({ investorId, projectId, month, forecastVnd, actualVnd });
  const million = (n: number): string => (BigInt(n) * 1_000_000n).toString();

  it('measures the weighted absolute error and the bias of each investor, worst first', () => {
    const pairs = [
      pair('a', 1, million(100), million(100)),
      pair('a', 2, million(100), million(110)),
      pair('a', 3, million(100), million(90)),
      pair('b', 1, million(200), million(100)),
      pair('b', 2, million(200), million(100)),
      pair('b', 3, million(200), million(100)),
    ];
    const report = forecastAccuracy(pairs, rule);
    expect(report.rows.map((row) => row.investorId)).toEqual(['b', 'a']);
    const a = report.rows.find((row) => row.investorId === 'a');
    expect(a).toMatchObject({ pairs: 3, months: 3, forecastVnd: million(300), actualVnd: million(300), absErrorVnd: million(20), wapePct: '6.67', biasPct: '0.00', band: 'GOOD', biasFlag: null });
    const b = report.rows.find((row) => row.investorId === 'b');
    expect(b).toMatchObject({ wapePct: '100.00', biasPct: '100.00', band: 'POOR', biasFlag: 'OVER' });
    expect(report.overall.pairs).toBe(6);
    expect(report.byMonth.map((row) => row.month)).toEqual([1, 2, 3]);
  });

  it('gives no band with too little history or nothing paid, and drops noise', () => {
    const short = forecastAccuracy([pair('a', 1, million(10), million(10)), pair('a', 2, million(10), million(12))], rule);
    expect(short.rows[0]?.band).toBe('INSUFFICIENT');
    const nothing = forecastAccuracy([pair('a', 1, million(10), '0'), pair('a', 2, million(10), '0'), pair('a', 3, million(10), '0')], rule);
    expect(nothing.rows[0]).toMatchObject({ wapePct: null, biasPct: null, band: 'INSUFFICIENT' });
    const noise = forecastAccuracy([pair('a', 1, '10', '20')], rule);
    expect(noise.rows).toEqual([]);
  });

  it('calls out under-forecasting', () => {
    const rows = forecastAccuracy([pair('a', 1, million(50), million(100)), pair('a', 2, million(50), million(100)), pair('a', 3, million(50), million(100))], rule).rows;
    expect(rows[0]).toMatchObject({ biasPct: '-50.00', biasFlag: 'UNDER', band: 'POOR' });
  });

  it('refuses params that contradict each other', () => {
    expect(failure(() => accuracyPolicyOf({ ...accuracyDefaults(), good_wape_pct: 30 }))).toBe('fair_wape_pct');
    expect(failure(() => accuracyPolicyOf({ ...accuracyDefaults(), lead_months: 0 }))).toBe('lead_months');
  });
});

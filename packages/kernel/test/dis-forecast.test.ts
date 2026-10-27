import { REALLOCATION_THRESHOLD_PCT, estimateYear, mergeEstimates, monthOf } from '../src/dis-forecast.ts';
import type { EstimateInput } from '../src/dis-forecast.ts';

const input = (over: Partial<EstimateInput> = {}): EstimateInput => ({
  disbursedVnd: '400000000',
  cutoffMonth: 10,
  forecasts: new Map([[11, '100000000'], [12, '150000000']]),
  registered: new Map(),
  planTotalVnd: '1000000000',
  ...over,
});

describe('the year-end estimate of a project (ST-DIS-018, BR-DIS-11, an assumption until D03 is signed)', () => {
  it('AC-ST-DIS-018-1 / UAT-AC255: 400 million disbursed to October with forecasts of 100 and 150 million for November and December is 650 million, the gap to the plan is the estimate less the plan, and under 80% of the plan is a candidate for reallocation', () => {
    const estimate = estimateYear(input());
    expect(estimate).toMatchObject({ eacVnd: '650000000', gapVnd: '-350000000', coverage: 'COMPLETE', reallocationCandidate: true, ratioPct: '65.0', method: 'FORECAST_AND_REGISTERED' });
    expect(estimate.months).toEqual([
      { month: 11, amountVnd: '100000000', source: 'FORECAST', complete: true },
      { month: 12, amountVnd: '150000000', source: 'FORECAST', complete: true },
    ]);
  });

  it('is a candidate only below 80% of the plan: 80% itself is not, and a plan of 800 million with 650 million is above it', () => {
    expect(REALLOCATION_THRESHOLD_PCT).toBe(80);
    expect(estimateYear(input({ planTotalVnd: '812500000' })).reallocationCandidate).toBe(false);
    expect(estimateYear(input({ planTotalVnd: '812500001' })).reallocationCandidate).toBe(true);
    expect(estimateYear(input({ planTotalVnd: '800000000' })).reallocationCandidate).toBe(false);
    expect(estimateYear(input({ planTotalVnd: '500000000' })).gapVnd).toBe('150000000');
  });

  it('takes the forecast of a month when there is one, the registration when there is none, and says which it took', () => {
    const estimate = estimateYear(input({ forecasts: new Map([[12, '150000000']]), registered: new Map([[11, '90000000'], [12, '1']]) }));
    expect(estimate.months).toEqual([
      { month: 11, amountVnd: '90000000', source: 'REGISTERED', complete: true },
      { month: 12, amountVnd: '150000000', source: 'FORECAST', complete: true },
    ]);
    expect(estimate.eacVnd).toBe('640000000');
    expect(estimate.method).toBe('FORECAST_AND_REGISTERED');
  });

  it('has nothing to say of a month that has neither: it is missing, not zero, the estimate is then only a lower bound that is told as partial, and no reallocation is called for it', () => {
    const estimate = estimateYear(input({ forecasts: new Map([[11, '100000000']]) }));
    expect(estimate.months[1]).toEqual({ month: 12, amountVnd: null, source: 'MISSING', complete: false });
    expect(estimate).toMatchObject({ eacVnd: '500000000', coverage: 'PARTIAL', reallocationCandidate: null, method: 'FORECAST_AND_REGISTERED_PARTIAL' });
    const none = estimateYear(input({ forecasts: new Map() }));
    expect(none).toMatchObject({ eacVnd: '400000000', coverage: 'NONE', reallocationCandidate: null });
  });

  it('has no estimate for a project the Treasury booked nothing for (no data is not zero), and counts a year that ended at the cutoff as the disbursement itself', () => {
    expect(estimateYear(input({ disbursedVnd: null }))).toMatchObject({ eacVnd: null, gapVnd: null, ratioPct: null, coverage: 'NONE', reallocationCandidate: null, method: 'NO_TREASURY_DATA' });
    expect(estimateYear(input({ cutoffMonth: 12, forecasts: new Map([[11, '5']]) }))).toMatchObject({ eacVnd: '400000000', months: [], coverage: 'COMPLETE', reallocationCandidate: true });
  });

  it('keeps a month 13 (the adjustment month) only when a row names it, and never calls it missing', () => {
    const estimate = estimateYear(input({ forecasts: new Map([[11, '100000000'], [12, '150000000'], [13, '25000000']]) }));
    expect(estimate.months.map((month) => month.month)).toEqual([11, 12, 13]);
    expect(estimate.eacVnd).toBe('675000000');
    expect(estimateYear(input({ forecasts: new Map([[11, '100000000'], [12, '150000000']]) })).months.map((month) => month.month)).toEqual([11, 12]);
  });

  it('does not add the schedule of the adjustment month to a figure that already holds it: a cutoff in the adjustment month ends the year at the disbursement', () => {
    const estimate = estimateYear(input({ cutoffMonth: 13, forecasts: new Map([[13, '25000000']]), registered: new Map([[13, '1']]) }));
    expect(estimate).toMatchObject({ eacVnd: '400000000', months: [], coverage: 'COMPLETE' });
  });

  it('has no ratio and no candidate when there is no plan, and a negative net disbursement is kept as it is', () => {
    expect(estimateYear(input({ planTotalVnd: '0' }))).toMatchObject({ gapVnd: '650000000', ratioPct: null, reallocationCandidate: null });
    expect(estimateYear(input({ disbursedVnd: '-1000' })).eacVnd).toBe('249999000');
  });

  it('adds up estimates for a unit or the whole scope from the sums, and is only as complete as the least complete project', () => {
    const complete = estimateYear(input());
    const partial = estimateYear(input({ disbursedVnd: '200000000', forecasts: new Map([[11, '50000000']]), planTotalVnd: '500000000' }));
    const total = mergeEstimates([complete, partial]);
    expect(total).toMatchObject({ disbursedVnd: '600000000', planTotalVnd: '1500000000', eacVnd: '900000000', gapVnd: '-600000000', coverage: 'PARTIAL', reallocationCandidate: null });
    expect(total.months).toEqual([
      { month: 11, amountVnd: '150000000', source: 'FORECAST', complete: true },
      { month: 12, amountVnd: '150000000', source: 'MIXED', complete: false },
    ]);
    // A project with no Treasury data keeps the others' estimate a lower bound and says so.
    const unknown = estimateYear(input({ disbursedVnd: null }));
    expect(mergeEstimates([complete, unknown])).toMatchObject({ eacVnd: '650000000', coverage: 'PARTIAL', reallocationCandidate: null });
    expect(mergeEstimates([])).toMatchObject({ disbursedVnd: null, eacVnd: null, coverage: 'NONE' });
  });

  it('adds up the months only of the projects that have Treasury data, so that the last month of the curve is the estimate and not a baseline that is not there', () => {
    const known = estimateYear(input());
    const unknown = estimateYear(input({ disbursedVnd: null, forecasts: new Map([[11, '10'], [12, '10']]) }));
    const total = mergeEstimates([known, unknown]);
    expect(total.eacVnd).toBe('650000000');
    expect(total.months).toEqual([
      { month: 11, amountVnd: '100000000', source: 'FORECAST', complete: true },
      { month: 12, amountVnd: '150000000', source: 'FORECAST', complete: true },
    ]);
  });

  it('keeps for each month whether every project that it adds up has a figure for it: a month that is a sum of only some of them is not complete', () => {
    const december = estimateYear(input());
    const none = estimateYear(input({ forecasts: new Map([[11, '100000000']]) }));
    expect(mergeEstimates([december, none]).months).toEqual([
      { month: 11, amountVnd: '200000000', source: 'FORECAST', complete: true },
      { month: 12, amountVnd: '150000000', source: 'MIXED', complete: false },
    ]);
    // The adjustment month is never required.
    const adjusted = estimateYear(input({ forecasts: new Map([[11, '1'], [12, '1'], [13, '1']]) }));
    expect(mergeEstimates([adjusted, december]).months.find((month) => month.month === 13)).toMatchObject({ complete: true });
  });

  it('reads the month of a cutoff date', () => {
    expect(monthOf('2027-10-31')).toBe(10);
    expect(monthOf('2027-01-01')).toBe(1);
  });
});

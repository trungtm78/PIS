import { addSums, rateOfSums } from '../src/dis-rates.ts';
import type { RateSums } from '../src/dis-rates.ts';
import { ratesOf } from '../src/dis-snapshot.ts';

const sums = (over: Partial<RateSums> = {}): RateSums => ({ projects: 1, planPmVnd: '0', planLocalVnd: '0', treasuryVnd: null, reportedVnd: null, ctmtqgVnd: null, allNone: false, allComplete: true, ...over });

describe('the two rates of a group (ST-DIS-010, BR-DIS-04, BR-DIS-05, BR-DIS-08, proposals until D03 is signed)', () => {
  it('AC-ST-DIS-010-1 / FX-DIS-004 / UAT-AC243: 600 million over a plan of 1 billion given by the Prime Minister and 250 million added by the province are 60.0000% and 48.0000%, with one numerator', () => {
    const figures = rateOfSums(sums({ planPmVnd: '1000000000', planLocalVnd: '250000000', treasuryVnd: '600000000' }), 'CURRENT_YEAR');
    expect(figures).toMatchObject({ numeratorVnd: '600000000', planTotalVnd: '1250000000', ratePmPct: '60.0000', rateTotalPct: '48.0000', rateNullReason: null, treasuryCoverage: 'COMPLETE' });
  });

  it('AC-ST-DIS-010-2 / FX-DIS-003 / UAT-AC242: the rate of a unit is the sum of the numerators over the sum of the denominators: 50/100 and 90/900 are 140/1000 = 14%, not the mean of 50% and 10%', () => {
    const one = sums({ planPmVnd: '100000000', treasuryVnd: '50000000' });
    const two = sums({ planPmVnd: '900000000', treasuryVnd: '90000000' });
    const unit = rateOfSums(addSums([one, two]), 'CURRENT_YEAR');
    expect(unit).toMatchObject({ projects: 2, numeratorVnd: '140000000', planPmVnd: '1000000000', ratePmPct: '14.0000', rateTotalPct: '14.0000' });
    expect(rateOfSums(one, 'CURRENT_YEAR').ratePmPct).toBe('50.0000');
    expect(rateOfSums(two, 'CURRENT_YEAR').ratePmPct).toBe('10.0000');
  });

  it('adds up groups without a figure as groups that have none: a figure is null only when no group has it, and zero is a figure', () => {
    const total = addSums([sums({ treasuryVnd: null, reportedVnd: '5' }), sums({ treasuryVnd: '0', reportedVnd: null }), sums({ treasuryVnd: null })]);
    expect(total).toMatchObject({ projects: 3, treasuryVnd: '0', reportedVnd: '5', ctmtqgVnd: null });
    expect(addSums([])).toMatchObject({ projects: 0, treasuryVnd: null, allNone: true });
  });

  it('AC-ST-DIS-010-3 / UAT-AC04 / BR-DIS-08: a project with no plan of either kind has no rate, with ZERO_DENOMINATOR, never 0% and never infinite, even when nothing was paid either', () => {
    expect(rateOfSums(sums({ planPmVnd: '0', planLocalVnd: '0', treasuryVnd: null, allNone: true }), 'CURRENT_YEAR')).toMatchObject({ ratePmPct: null, rateTotalPct: null, rateNullReason: 'ZERO_DENOMINATOR', treasuryCoverage: 'NONE' });
    expect(rateOfSums(sums({ planPmVnd: '0', planLocalVnd: '0', treasuryVnd: '5' }), 'CURRENT_YEAR')).toMatchObject({ ratePmPct: null, rateTotalPct: null, rateNullReason: 'ZERO_DENOMINATOR' });
  });

  it('BR-DIS-08: nothing paid and no report is NO_DATA, and a Treasury that booked nothing for every line is TREASURY_COVERAGE_NONE', () => {
    expect(rateOfSums(sums({ planPmVnd: '100', treasuryVnd: null, allNone: false }), 'CURRENT_YEAR')).toMatchObject({ ratePmPct: null, rateNullReason: 'NO_DATA' });
    expect(rateOfSums(sums({ planPmVnd: '100', treasuryVnd: null, allNone: true }), 'CURRENT_YEAR')).toMatchObject({ ratePmPct: null, rateNullReason: 'TREASURY_COVERAGE_NONE', treasuryCoverage: 'NONE' });
    // Paid zero is a figure: the rate is 0, not missing.
    expect(rateOfSums(sums({ planPmVnd: '100', treasuryVnd: '0' }), 'CURRENT_YEAR')).toMatchObject({ ratePmPct: '0.0000', rateNullReason: null });
  });

  it('the rate on the Prime Minister plan can pass 100% when the province adds, and the rate on the whole plan stays under it', () => {
    expect(rateOfSums(sums({ planPmVnd: '100', planLocalVnd: '100', treasuryVnd: '150' }), 'CURRENT_YEAR')).toMatchObject({ ratePmPct: '150.0000', rateTotalPct: '75.0000' });
  });

  it('keeps the capital carried over apart: its rate is what was reported over its own plan, not mixed with the year plan', () => {
    const carryover = rateOfSums(sums({ planPmVnd: '200', planLocalVnd: '0', treasuryVnd: '999', reportedVnd: '50' }), 'CARRYOVER');
    expect(carryover).toMatchObject({ numeratorVnd: '50', ratePmPct: '25.0000', rateTotalPct: '25.0000' });
  });

  it('the coverage of a group is none when the Treasury booked nothing for any line, complete when it agrees on every line, and partial in between; a group with no project has none', () => {
    expect(rateOfSums(sums({ allNone: true, allComplete: false }), 'CURRENT_YEAR').treasuryCoverage).toBe('NONE');
    expect(rateOfSums(sums({ allNone: false, allComplete: true }), 'CURRENT_YEAR').treasuryCoverage).toBe('COMPLETE');
    expect(rateOfSums(sums({ allNone: false, allComplete: false }), 'CURRENT_YEAR').treasuryCoverage).toBe('PARTIAL');
    expect(rateOfSums(sums({ projects: 0, allNone: false, allComplete: true }), 'CURRENT_YEAR').treasuryCoverage).toBe('NONE');
    expect(addSums([sums({ allNone: true, allComplete: false }), sums({ allNone: false, allComplete: true })])).toMatchObject({ allNone: false, allComplete: false });
  });

  it('keeps a Treasury net below zero without a rate, as the snapshot does', () => {
    expect(rateOfSums(sums({ planPmVnd: '1000', treasuryVnd: '-100' }), 'CURRENT_YEAR')).toMatchObject({ numeratorVnd: '-100', ratePmPct: null, rateNullReason: 'NO_DATA' });
    expect(ratesOf({ disbursedVnd: null, planPmVnd: '0', planLocalVnd: '0', coverage: 'NONE' }).nullReason).toBe('ZERO_DENOMINATOR');
  });
});

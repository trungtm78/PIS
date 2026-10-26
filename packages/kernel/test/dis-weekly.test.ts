import { weeklyActual, weeklyDifference } from '../src/dis-weekly.ts';

const week = (periodId: string, endDate: string, cumulativeVnd: string | null) => ({ periodId, endDate, cumulativeVnd });

describe('the weekly plan against what the Treasury paid (ST-DIS-014, Directive 162)', () => {
  it('AC-ST-DIS-014-1 / UAT-AC256: a week is what the Treasury paid in it: the cumulative at the end of the week less the one at the end of the week before, and the plan is never added to it', () => {
    // W39 120 million paid, W40 120 + 100 = 220 million at the end of the week after.
    const weeks = [week('w39', '2026-09-27', '120000000'), week('w40', '2026-10-04', '220000000')];
    expect(weeklyActual(weeks, 'w40')).toEqual({ actualVnd: '100000000', fromYearStart: false });
    expect(weeklyActual(weeks, 'w39')).toEqual({ actualVnd: '120000000', fromYearStart: true });
    // The commitments of the two weeks were 200 and 250 million: the weeks fell short by 80 and 150.
    expect(weeklyDifference('120000000', '200000000')).toBe('-80000000');
    expect(weeklyDifference('100000000', '250000000')).toBe('-150000000');
  });

  it('takes the weeks in the order of their end whatever the order they are given in, and leaves a week that is not frozen with no actual (unknown is not zero)', () => {
    const weeks = [week('w41', '2026-10-11', '300'), week('w39', '2026-09-27', '100'), week('w40', '2026-10-04', '250')];
    expect(weeklyActual(weeks, 'w41')).toEqual({ actualVnd: '50', fromYearStart: false });
    expect(weeklyActual(weeks, 'w40')).toEqual({ actualVnd: '150', fromYearStart: false });
    expect(weeklyActual(weeks, 'w42')).toEqual({ actualVnd: null, fromYearStart: false });
    expect(weeklyDifference(null, '5')).toBeNull();
  });

  it('counts a week that was frozen with no figure for the project as a week of nothing paid, and keeps a week that a refund made negative', () => {
    expect(weeklyActual([week('a', '2026-01-10', '100'), week('b', '2026-01-17', null)], 'b')).toEqual({ actualVnd: '-100', fromYearStart: false });
    expect(weeklyActual([week('a', '2026-01-10', null), week('b', '2026-01-17', '40')], 'b')).toEqual({ actualVnd: '40', fromYearStart: false });
    expect(weeklyActual([week('a', '2026-01-10', null)], 'a')).toEqual({ actualVnd: '0', fromYearStart: true });
    expect(weeklyActual([week('a', '2026-01-10', '100'), week('b', '2026-01-17', '60')], 'b')).toEqual({ actualVnd: '-40', fromYearStart: false });
    expect(weeklyDifference('-40', '10')).toBe('-50');
  });
});

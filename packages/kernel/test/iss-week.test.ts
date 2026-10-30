import { isoWeekOf, isoWeekRange, weeksInYear } from '../src/iss-week';

const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};

describe('the ISO weeks of the weekly matrix of the issues (ST-ISS-006, BR-ISS-08)', () => {
  it('begins a week on a Monday and ends it on the Sunday after it', () => {
    expect(isoWeekRange('2026-W42')).toEqual({ week: '2026-W42', from: '2026-10-12', to: '2026-10-18' });
    expect(isoWeekRange('2026-W01')).toEqual({ week: '2026-W01', from: '2025-12-29', to: '2026-01-04' });
    expect(isoWeekRange('2027-W01')).toEqual({ week: '2027-W01', from: '2027-01-04', to: '2027-01-10' });
  });

  it('knows the years that have 53 weeks: 2026 has, 2027 has not', () => {
    expect(weeksInYear(2026)).toBe(53);
    expect(weeksInYear(2027)).toBe(52);
    expect(weeksInYear(2020)).toBe(53);
    expect(weeksInYear(2024)).toBe(52);
    expect(isoWeekRange('2026-W53')).toEqual({ week: '2026-W53', from: '2026-12-28', to: '2027-01-03' });
    expect(refusal(() => isoWeekRange('2027-W53'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'week', status: 422 });
  });

  it('refuses what is not a week: a name of another shape, week 0, a week past the year, a year out of the range', () => {
    for (const bad of [undefined, null, 5, '', '2026-42', '2026-W4', '2026-W00', '2026-W54', '1999-W10', '2101-W01', '2026-w42', ' 2026-W42']) {
      expect(refusal(() => isoWeekRange(bad))).toEqual({ code: 'VALIDATION_FAILED', detail: 'week', status: 422 });
    }
  });

  it('names the week a day lies in, the year of the week being the year of its Thursday', () => {
    expect(isoWeekOf('2026-10-12')).toBe('2026-W42');
    expect(isoWeekOf('2026-10-18')).toBe('2026-W42');
    expect(isoWeekOf('2026-10-19')).toBe('2026-W43');
    expect(isoWeekOf('2025-12-29')).toBe('2026-W01');
    expect(isoWeekOf('2027-01-03')).toBe('2026-W53');
    expect(isoWeekOf('2027-01-04')).toBe('2027-W01');
    expect(isoWeekOf('2024-12-30')).toBe('2025-W01');
    for (let n = 1; n <= 53; n += 1) {
      const range = isoWeekRange(`2026-W${String(n).padStart(2, '0')}`);
      expect([isoWeekOf(range.from), isoWeekOf(range.to)]).toEqual([range.week, range.week]);
    }
  });
});

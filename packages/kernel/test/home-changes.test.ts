import { CHANGE_LINES_MAX, weeklyChanges } from '../src/home-changes';
import type { UnitWeek, WeekFigures } from '../src/home-changes';

const unit = (band: UnitWeek['band'], criticalWarnings: number | null = 0, overdueExplanations: number | null = 0): UnitWeek => ({ band, criticalWarnings, overdueExplanations });
const week = (over: Partial<Omit<WeekFigures, 'units'>> & { units?: Array<[string, UnitWeek]> } = {}): WeekFigures => {
  const { units, ...rest } = over;
  return { asOfDate: '2026-11-01', ratePmPct: '60.0000', disbursedVnd: '1000000', projectsWithoutData: 2, units: new Map(units ?? []), ...rest };
};

describe('the changes since last week (G3-4)', () => {
  it('has no line and says why when there is no week before, instead of comparing with nothing', () => {
    expect(weeklyChanges(week(), null)).toEqual({ lines: [], previousAsOf: null, reason: 'NO_PREVIOUS_WEEK' });
  });

  it('has no line, but a week before, when nothing moved', () => {
    const same = week({ units: [['u1', unit('GREEN', 1, 1)]] });
    expect(weeklyChanges({ ...same, asOfDate: '2026-11-08' }, same)).toEqual({ lines: [], previousAsOf: '2026-11-01', reason: null });
  });

  describe('with a week of everything moving', () => {
    const previous = week({
      units: [
        ['u1', unit('GREEN', 1, 0)],
        ['u2', unit('AMBER', 2, 1)],
        ['u3', unit('RED', 3, 2)],
        ['u4', unit('NO_DATA', null, null)],
      ],
    });
    const current = week({
      asOfDate: '2026-11-08',
      ratePmPct: '61.5000',
      disbursedVnd: '1500000',
      projectsWithoutData: 1,
      units: [
        ['u1', unit('RED', 2, 0)],
        ['u2', unit('AMBER', 2, 3)],
        ['u3', unit('GREEN', 0, 2)],
        ['u4', unit('RED', 0, 0)],
        ['u5', unit('RED', 0, 0)],
      ],
    });

    it('writes at most five lines, the ones that matter most first, and drops the rest', () => {
      const result = weeklyChanges(current, previous);
      expect(CHANGE_LINES_MAX).toBe(5);
      expect(result.previousAsOf).toBe('2026-11-01');
      expect(result.lines.map((line) => line.kind)).toEqual(['UNITS_TO_RED', 'RATE_CHANGE', 'WARNINGS_DELTA', 'DISBURSED_WEEK', 'OVERDUE_DELTA']);
    });

    it('counts a unit as turned red only when it was read in both weeks: one that came this week, or had no data before, is not "turned red"', () => {
      const [first] = weeklyChanges(current, previous).lines;
      expect(first).toEqual({ kind: 'UNITS_TO_RED', direction: 'UP', params: { count: 1 }, link: 'RAG', metricCode: null });
    });

    it('says how far the rate moved in points, with the direction on its own, and links to the tile of the rate', () => {
      const rate = weeklyChanges(current, previous).lines[1];
      expect(rate).toEqual({ kind: 'RATE_CHANGE', direction: 'UP', params: { from: '60.00', to: '61.50', delta: '1.50' }, link: 'DRILL', metricCode: 'DISBURSEMENT_RATE_PM' });
    });

    it('sums the warnings and the overdue explanations over the units that have a figure and compares the sums', () => {
      const lines = weeklyChanges(current, previous).lines;
      expect(lines[2]).toEqual({ kind: 'WARNINGS_DELTA', direction: 'DOWN', params: { from: 6, to: 4, delta: 2 }, link: 'WARNINGS', metricCode: null });
      expect(lines[4]).toEqual({ kind: 'OVERDUE_DELTA', direction: 'UP', params: { from: 3, to: 5, delta: 2 }, link: 'MY_WORK', metricCode: null });
    });

    it('has what was disbursed in the week as the difference of the two cumulative figures, in whole dong', () => {
      expect(weeklyChanges(current, previous).lines[3]).toEqual({ kind: 'DISBURSED_WEEK', direction: 'UP', params: { amount_vnd: '500000' }, link: 'DRILL', metricCode: 'DISBURSED_TREASURY' });
    });

    it('writes the lines that were cut for room when there is room: projects without data and units that recovered', () => {
      const quiet = { ...current, ratePmPct: previous.ratePmPct, disbursedVnd: previous.disbursedVnd, units: new Map([['u1', unit('GREEN', 1, 0)], ['u2', unit('AMBER', 2, 1)], ['u3', unit('GREEN', 3, 2)]]) };
      const result = weeklyChanges(quiet, previous);
      expect(result.lines).toEqual([
        { kind: 'NO_DATA_DELTA', direction: 'DOWN', params: { from: 2, to: 1, delta: 1 }, link: 'RANKING', metricCode: null },
        { kind: 'UNITS_RECOVERED', direction: 'DOWN', params: { count: 1 }, link: 'RAG', metricCode: null },
      ]);
    });
  });

  describe('the rate', () => {
    const rateLines = (from: string | null, to: string | null) => weeklyChanges(week({ asOfDate: '2026-11-08', ratePmPct: to }), week({ ratePmPct: from })).lines;

    it('is news only when it moved by a whole hundredth of a point: a change that rounds away is not written', () => {
      expect(rateLines('60.0000', '60.0099')).toEqual([]);
      expect(rateLines('60.0000', '60.0100')).toHaveLength(1);
      expect(rateLines('60.0100', '60.0000')).toHaveLength(1);
    });
    it('goes down as well, with the amount unsigned and the direction saying which way', () => {
      expect(rateLines('61.5000', '60.0000')[0]).toMatchObject({ kind: 'RATE_CHANGE', direction: 'DOWN', params: { from: '61.50', to: '60.00', delta: '1.50' } });
    });
    it('writes places below one point with the leading zero and rounds the hundredth the way the register does', () => {
      expect(rateLines('0.0000', '0.0100')[0]?.params).toEqual({ from: '0.00', to: '0.01', delta: '0.01' });
      expect(rateLines('60.0000', '60.0149')[0]?.params).toMatchObject({ to: '60.01', delta: '0.01' });
      expect(rateLines('60.0000', '60.0150')[0]?.params).toMatchObject({ to: '60.02' });
    });
    it('reads a rate with fewer places and is not written at all when either week has none', () => {
      expect(rateLines('60', '61.5')[0]?.params).toMatchObject({ from: '60.00', to: '61.50', delta: '1.50' });
      expect(rateLines(null, '61.5000')).toEqual([]);
      expect(rateLines('61.5000', null)).toEqual([]);
    });
  });

  describe('the money', () => {
    const moneyLines = (from: string | null, to: string | null) => weeklyChanges(week({ asOfDate: '2026-11-08', disbursedVnd: to }), week({ disbursedVnd: from })).lines;
    it('is written only when more was disbursed, never for less or the same or an unknown figure', () => {
      expect(moneyLines('1000', '1001')).toHaveLength(1);
      expect(moneyLines('1000', '1000')).toEqual([]);
      expect(moneyLines('1000', '900')).toEqual([]);
      expect(moneyLines(null, '900')).toEqual([]);
      expect(moneyLines('1000', null)).toEqual([]);
    });
    it('is exact beyond what a double holds', () => {
      expect(moneyLines('9007199254740993', '9007199254741993')[0]?.params).toEqual({ amount_vnd: '1000' });
    });
  });

  describe('the counts', () => {
    it('writes no line for a count that has no figure in one of the weeks, never a comparison with zero', () => {
      const before = week({ units: [['u1', unit('GREEN', null, null)]] });
      const after = week({ asOfDate: '2026-11-08', units: [['u1', unit('GREEN', 5, 5)]] });
      expect(weeklyChanges(after, before).lines).toEqual([]);
    });
    it('writes the count of projects without data in both directions', () => {
      const up = weeklyChanges(week({ asOfDate: '2026-11-08', projectsWithoutData: 5 }), week({ projectsWithoutData: 2 })).lines;
      expect(up).toEqual([{ kind: 'NO_DATA_DELTA', direction: 'UP', params: { from: 2, to: 5, delta: 3 }, link: 'RANKING', metricCode: null }]);
    });
    it('does not count a unit that went from red to no data as recovered, nor one that went from red to red', () => {
      const before = week({ units: [['u1', unit('RED')], ['u2', unit('RED')]] });
      const after = week({ asOfDate: '2026-11-08', units: [['u1', unit('NO_DATA')], ['u2', unit('RED')]] });
      expect(weeklyChanges(after, before).lines).toEqual([]);
    });
  });

  it('puts no name of a unit or a project in any line: a line carries numbers and a link, and the scope is judged again where the link goes', () => {
    const before = week({ units: [['Sở Tài chính', unit('GREEN', 1, 1)]] });
    const after = week({ asOfDate: '2026-11-08', ratePmPct: '70', units: [['Sở Tài chính', unit('RED', 4, 4)]] });
    const text = JSON.stringify(weeklyChanges(after, before));
    expect(text).not.toContain('Sở Tài chính');
  });
});

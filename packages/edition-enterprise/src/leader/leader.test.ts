import { addSums, rateOfSums } from '@machvon/kernel';
import type { RateSums } from '@machvon/kernel';
import { blockedBoard, daysFrom } from './tiles.ts';
import type { BlockFact } from './tiles.ts';
import { leaderRateBoard, pointsBetween, priorSnapshotOf, sameDayLastYear, trendOf, wholeOf } from './rates.ts';
import type { RateGroup } from './rates.ts';

const sums = (planPm: string, planLocal: string, treasury: string | null, extra: Partial<RateSums> = {}): RateSums => ({
  projects: 1,
  planPmVnd: planPm,
  planLocalVnd: planLocal,
  treasuryVnd: treasury,
  reportedVnd: treasury,
  ctmtqgVnd: null,
  allNone: treasury === null,
  allComplete: treasury !== null,
  ...extra,
});
const group = (code: string, value: RateSums): RateGroup => ({ id: `id-${code}`, code, name: `Name ${code}`, sums: value });
const cuts = (snapshotId: string, asOfDate: string, units: RateGroup[], projects: RateGroup[]) => ({ snapshotId, asOfDate, units, projects });

describe('leaderRateBoard', () => {
  const unitA = group('A', sums('600', '400', '500'));
  const unitB = group('B', sums('300', '200', '100'));
  const projectA1 = group('P1', sums('600', '400', '500'));
  const projectB1 = group('P2', sums('300', '200', '100'));
  const current = cuts('s-now', '2026-10-31', [unitA, unitB], [projectA1, projectB1]);
  const whole = wholeOf([unitA, unitB]);

  it('gives the rate of the group as the sum of the numerators over the sum of the denominators, the code HOME uses, never the mean of the rates', () => {
    const board = leaderRateBoard({ current, whole, previous: undefined, denominator: 'TOTAL' });
    // 500 over 1000 is 50 percent and 100 over 500 is 20 percent; the company is 600 over 1500, not the mean 35.
    expect(board.units.map((row) => row.ratePct)).toEqual(['50.0000', '20.0000']);
    expect(board.company.ratePct).toBe('40.0000');
    expect(board.company.ratePct).toBe(rateOfSums(addSums([unitA.sums, unitB.sums]), 'CURRENT_YEAR').rateTotalPct);
    expect(board.company.planVnd).toBe('1500');
    expect(board.company.disbursedVnd).toBe('600');
    expect(board.company.level).toBe('COMPANY');
    expect(board.projects.map((row) => row.code)).toEqual(['P1', 'P2']);
  });

  it('over the plan the parent body assigned, the rate is over that plan only', () => {
    const board = leaderRateBoard({ current, whole, previous: undefined, denominator: 'PM_ASSIGNED' });
    expect(board.units[0]?.planVnd).toBe('600');
    expect(board.units[0]?.ratePct).toBe('83.3333');
  });

  it('compares each group with the same group a year before, in percentage points, exactly', () => {
    const previous = { ...cuts('s-prior', '2025-10-31', [group('A', sums('600', '400', '300')), group('B', sums('300', '200', '150'))], [group('P1', sums('600', '400', '300'))]), whole: sums('900', '600', '450') };
    const board = leaderRateBoard({ current, whole, previous, denominator: 'TOTAL' });
    expect(board.priorSnapshotId).toBe('s-prior');
    expect(board.units[0]?.lastYear.ratePct).toBe('30.0000');
    expect(board.units[0]?.deltaPoints).toBe('20.0000');
    expect(board.units[0]?.trend).toBe('UP');
    expect(board.units[1]?.deltaPoints).toBe('-10.0000');
    expect(board.units[1]?.trend).toBe('DOWN');
    expect(board.company.lastYear.ratePct).toBe('30.0000');
    expect(board.company.deltaPoints).toBe('10.0000');
  });

  it('says a project that was not in the snapshot of last year, and never gives it a rate of 0', () => {
    const previous = { ...cuts('s-prior', '2025-10-31', [group('A', sums('600', '400', '300')), group('B', sums('300', '200', '150'))], [group('P1', sums('600', '400', '300'))]), whole: sums('900', '600', '450') };
    const board = leaderRateBoard({ current, whole, previous, denominator: 'TOTAL' });
    const added = board.projects.find((row) => row.code === 'P2');
    expect(added?.lastYear).toEqual({ ratePct: null, disbursedVnd: null, nullReason: 'NOT_IN_PRIOR_SNAPSHOT' });
    expect(added?.deltaPoints).toBeNull();
    expect(added?.trend).toBeNull();
  });

  it('says there is no snapshot of last year for every row when there is none', () => {
    const board = leaderRateBoard({ current, whole, previous: undefined, denominator: 'TOTAL' });
    for (const row of [board.company, ...board.units, ...board.projects]) {
      expect(row.lastYear.nullReason).toBe('NO_PRIOR_SNAPSHOT');
      expect(row.lastYear.ratePct).toBeNull();
      expect(row.deltaPoints).toBeNull();
    }
    expect(board.priorSnapshotId).toBeNull();
  });

  it('a group the Treasury booked nothing for has no rate and says why, not 0', () => {
    const none = group('C', sums('100', '0', null));
    const board = leaderRateBoard({ current: cuts('s', '2026-10-31', [none], [none]), whole: none.sums, previous: undefined, denominator: 'TOTAL' });
    expect(board.units[0]?.ratePct).toBeNull();
    expect(board.units[0]?.nullReason).toBe('TREASURY_COVERAGE_NONE');
    expect(board.units[0]?.disbursedVnd).toBeNull();
  });

  it('a group with no plan has no rate (zero denominator)', () => {
    const empty = group('D', sums('0', '0', '50'));
    const board = leaderRateBoard({ current: cuts('s', '2026-10-31', [empty], []), whole: empty.sums, previous: undefined, denominator: 'TOTAL' });
    expect(board.units[0]?.ratePct).toBeNull();
    expect(board.units[0]?.nullReason).toBe('ZERO_DENOMINATOR');
  });

  it('keeps a project that belongs to no unit in the company figure (the whole is given, not rebuilt from the units)', () => {
    const lone = sums('100', '0', '10');
    const board = leaderRateBoard({ current, whole: addSums([wholeOf([unitA, unitB]), lone]), previous: undefined, denominator: 'TOTAL' });
    expect(board.company.planVnd).toBe('1600');
    expect(board.company.disbursedVnd).toBe('610');
  });

  it('can be wrong in a way the test sees: swapping the two years flips the sign of every delta', () => {
    const prior = { ...cuts('s-prior', '2025-10-31', [group('A', sums('600', '400', '300')), group('B', sums('300', '200', '150'))], []), whole: sums('900', '600', '450') };
    const forward = leaderRateBoard({ current, whole, previous: prior, denominator: 'TOTAL' });
    const swapped = leaderRateBoard({ current: { ...prior, snapshotId: 's-prior' }, whole: prior.whole, previous: { ...current, whole }, denominator: 'TOTAL' });
    expect(forward.units[0]?.deltaPoints).toBe('20.0000');
    expect(swapped.units[0]?.deltaPoints).toBe('-20.0000');
  });
});

describe('percentage points and the period of last year', () => {
  it('subtracts exactly, with four places', () => {
    expect(pointsBetween('12.3456', '10.0001')).toBe('2.3455');
    expect(pointsBetween('10.0000', '12.5000')).toBe('-2.5000');
    expect(pointsBetween('0.0001', '0.0001')).toBe('0.0000');
    expect(trendOf('0.0000')).toBe('FLAT');
    expect(trendOf(null)).toBeNull();
  });

  it('refuses a rate that is not a four-place percent', () => {
    expect(() => pointsBetween('12.3', '10.0000')).toThrow();
  });

  it('is the same day a year before, with 29 February on 28 February', () => {
    expect(sameDayLastYear('2026-10-31')).toBe('2025-10-31');
    expect(sameDayLastYear('2024-02-29')).toBe('2023-02-28');
    expect(() => sameDayLastYear('2026-13-01')).toThrow();
  });

  it('takes the latest closing on or before that day within forty days, as BAN-01 does', () => {
    const candidates = [{ asOfDate: '2025-09-15' }, { asOfDate: '2025-10-25' }, { asOfDate: '2025-10-31' }, { asOfDate: '2025-11-02' }];
    expect(priorSnapshotOf('2026-10-31', candidates)?.asOfDate).toBe('2025-10-31');
    expect(priorSnapshotOf('2026-10-30', candidates)?.asOfDate).toBe('2025-10-25');
    expect(priorSnapshotOf('2026-10-31', [{ asOfDate: '2025-09-15' }])).toBeUndefined();
    expect(priorSnapshotOf('2026-10-31', [{ asOfDate: '2025-11-02' }])).toBeUndefined();
  });
});

describe('blockedBoard', () => {
  const fact = (over: Partial<BlockFact>): BlockFact => ({ projectId: 'p1', projectCode: 'DA-01', projectName: 'Project 1', unitId: 'u1', unitName: 'Unit 1', source: 'PERMIT', sourceId: 's1', since: '2026-10-01', ...over });

  it('counts projects, not holds: a project with three late permits is one', () => {
    const board = blockedBoard([fact({ sourceId: 'a' }), fact({ sourceId: 'b' }), fact({ sourceId: 'c', source: 'ISSUE', since: '2026-10-20' })], '2026-11-09');
    expect(board.total).toBe(1);
    expect(board.projects[0]).toMatchObject({ projectId: 'p1', items: 3, sources: ['PERMIT', 'ISSUE'], since: '2026-10-01', days: 39 });
    expect(board.bySource).toEqual({ PERMIT: 1, ISSUE: 1, LAND: 0, PROCUREMENT: 0 });
  });

  it('a hold due today or later is not late yet', () => {
    const board = blockedBoard([fact({ since: '2026-11-09' }), fact({ projectId: 'p2', sourceId: 'x', since: '2026-11-10' })], '2026-11-09');
    expect(board.total).toBe(0);
  });

  it('counts a thing read twice once', () => {
    const board = blockedBoard([fact({}), fact({})], '2026-11-09');
    expect(board.projects[0]?.items).toBe(1);
  });

  it('orders the longest hold first, then the code, whatever the order of the facts', () => {
    const facts = [fact({ projectId: 'p2', projectCode: 'DA-02', sourceId: 'x', since: '2026-10-01' }), fact({ projectId: 'p3', projectCode: 'DA-00', sourceId: 'y', since: '2026-09-01' }), fact({})];
    const forward = blockedBoard(facts, '2026-11-09').projects.map((project) => project.projectCode);
    const backward = blockedBoard([...facts].reverse(), '2026-11-09').projects.map((project) => project.projectCode);
    expect(forward).toEqual(['DA-00', 'DA-01', 'DA-02']);
    expect(backward).toEqual(forward);
  });

  it('cuts the list but not the count', () => {
    const facts = Array.from({ length: 5 }, (_, index) => fact({ projectId: `p${index}`, projectCode: `DA-0${index}`, sourceId: `s${index}` }));
    const board = blockedBoard(facts, '2026-11-09', 2);
    expect(board.total).toBe(5);
    expect(board.projects).toHaveLength(2);
    expect(board.truncated).toBe(true);
  });

  it('refuses a day that is not a day', () => {
    expect(() => blockedBoard([fact({ since: '2026-02-30' })], '2026-11-09')).toThrow();
    expect(() => blockedBoard([], 'today')).toThrow();
    expect(daysFrom('2026-11-01', '2026-11-09')).toBe(8);
  });
});

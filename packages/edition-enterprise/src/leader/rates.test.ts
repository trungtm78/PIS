import { EnterpriseFigureReader, builtInPack, projectRowsFromBook } from '@machvon/kernel';
import type { EnterpriseSnapshotView, FigureBook, FigureQuery, StoredFigure } from '@machvon/kernel';
import { cutsOf } from './rates-reader.ts';
import { leaderRateBoard, pointsBetween, priorSnapshotOf, sameDayLastYear, trendOf } from './rates.ts';
import type { RateCuts, RateGroup, RateReading } from './rates.ts';

const PACK = builtInPack('ENTERPRISE');
let counter = 0;

const fig = (over: Partial<StoredFigure> & Pick<StoredFigure, 'kind' | 'amountVnd'>): StoredFigure => {
  counter += 1;
  const yearly = over.kind === 'PLAN_YEAR' || over.kind === 'PLAN_ADJUSTED';
  return {
    id: `f-${counter}`,
    classCode: 'EQUITY',
    tierCode: 'ALL',
    measure: 'DISBURSED',
    grain: yearly ? 'YEAR' : 'MONTH',
    planYear: 2026,
    ordinal: yearly ? 0 : 1,
    basis: over.kind === 'ACTUAL' ? 'REPORTED' : 'PLAN_DECISION',
    asOfDate: '2026-01-10',
    revision: 1,
    status: 'ACCEPTED',
    ...over,
  };
};
const actual = (ordinal: number, amountVnd: string): StoredFigure => fig({ kind: 'ACTUAL', ordinal, amountVnd, asOfDate: `2026-${String(ordinal + 1).padStart(2, '0')}-05` });
const book = (figures: readonly StoredFigure[]): FigureBook => ({ pack: PACK, figures, tmdt: [], yearsClosed: new Set<number>() });
const March: Omit<FigureQuery, 'measure'> = { period: { grain: 'MONTH', planYear: 2026, ordinal: 3 }, asOf: '2026-04-05', view: 'AS_REPORTED' };

/** Two units: u1 holds p1 (plan 1000, disbursed 450 to March) and p2 (plan 500, disbursed 50); u2 holds p3 (plan 2000, disbursed 750). */
const books: Record<string, { unitId: string; book: FigureBook }> = {
  p1: { unitId: 'u1', book: book([fig({ kind: 'PLAN_YEAR', amountVnd: '1000' }), actual(1, '100'), actual(2, '150'), actual(3, '200')]) },
  p2: { unitId: 'u1', book: book([fig({ kind: 'PLAN_YEAR', amountVnd: '500' }), actual(1, '10'), actual(2, '20'), actual(3, '20')]) },
  p3: { unitId: 'u2', book: book([fig({ kind: 'PLAN_YEAR', amountVnd: '2000' }), actual(1, '200'), actual(2, '250'), actual(3, '300')]) },
};
const viewOf = (snapshotId: string, ids: string[], asOfDate: string): EnterpriseSnapshotView => ({
  snapshotId,
  revision: 1,
  payloadSha256: `hash-${snapshotId}`,
  periodId: 'period-3',
  period: March.period,
  asOfDate,
  pack: PACK,
  taxonomyVersion: 1,
  figures: ids.flatMap((id) => projectRowsFromBook((books[id] as (typeof books)[string]).book, { projectId: id, unitId: (books[id] as (typeof books)[string]).unitId }, March)),
  indicators: [],
});
const directory = {
  units: new Map([
    ['u1', { code: 'BAN-1', name: 'Ban 1' }],
    ['u2', { code: 'BAN-2', name: 'Ban 2' }],
  ]),
  projects: new Map([
    ['p1', { code: 'DA-1', name: 'Project 1' }],
    ['p2', { code: 'DA-2', name: 'Project 2' }],
    ['p3', { code: 'DA-3', name: 'Project 3' }],
  ]),
};

describe('cutsOf: the three cuts through the one reader', () => {
  const reader = new EnterpriseFigureReader(viewOf('s-now', ['p1', 'p2', 'p3'], '2026-10-31'));

  it('gives the whole, each unit and each project, and the rate of a group is the sum over the sum, never the mean of the rates', () => {
    const cuts = cutsOf(reader, directory, undefined);
    // 450 + 50 + 750 over 1000 + 500 + 2000 is 35.7143 percent; the mean of 45, 10 and 37.5 would be 30.8333.
    expect(cuts.whole).toMatchObject({ projects: 3, planVnd: '3500', disbursedVnd: '1250', ratePct: '35.7143', nullReason: null });
    expect(cuts.units.map((group) => [group.code, group.reading.ratePct, group.reading.planVnd])).toEqual([
      ['BAN-1', '33.3333', '1500'],
      ['BAN-2', '37.5000', '2000'],
    ]);
    expect(cuts.projects.map((group) => group.code)).toEqual(['DA-1', 'DA-2', 'DA-3']);
    expect(cuts.projects[0]?.reading.ratePct).toBe('45.0000');
    expect(cuts.snapshotId).toBe('s-now');
    expect(cuts.hash).toBe('hash-s-now');
  });

  it('narrows every cut to the projects the reader may read, and lists no unit that has none', () => {
    const cuts = cutsOf(reader, directory, ['p1', 'p2']);
    expect(cuts.whole).toMatchObject({ projects: 2, planVnd: '1500', disbursedVnd: '500' });
    expect(cuts.units.map((group) => group.code)).toEqual(['BAN-1']);
    expect(cuts.projects.map((group) => group.code)).toEqual(['DA-1', 'DA-2']);
  });

  it('a reader who may read no project gets no row and a whole with nothing in it, never a rate of 0', () => {
    const cuts = cutsOf(reader, directory, []);
    expect(cuts.units).toEqual([]);
    expect(cuts.projects).toEqual([]);
    expect(cuts.whole.ratePct).toBeNull();
  });
});

const reading = (planVnd: string, disbursedVnd: string | null, ratePct: string | null, over: Partial<RateReading> = {}): RateReading => ({ projects: 1, planVnd, disbursedVnd, ratePct, nullReason: ratePct === null ? 'NO_DATA' : null, ...over });
const group = (code: string, value: RateReading): RateGroup => ({ id: `id-${code}`, code, name: `Name ${code}`, reading: value });
const cuts = (snapshotId: string, asOfDate: string, whole: RateReading, units: RateGroup[], projects: RateGroup[]): RateCuts => ({ snapshotId, asOfDate, revision: 1, hash: null, whole, units, projects });

describe('leaderRateBoard', () => {
  const now = cuts('s-now', '2026-10-31', reading('1500', '600', '40.0000'), [group('A', reading('1000', '500', '50.0000')), group('B', reading('500', '100', '20.0000'))], [group('P1', reading('1000', '500', '50.0000')), group('P2', reading('500', '100', '20.0000'))]);
  const before = cuts('s-prior', '2025-10-31', reading('1500', '450', '30.0000'), [group('A', reading('1000', '300', '30.0000')), group('B', reading('500', '150', '30.0000'))], [group('P1', reading('1000', '300', '30.0000'))]);

  it('compares each group with the same group a year before, in percentage points, exactly', () => {
    const board = leaderRateBoard({ current: now, previous: before });
    expect(board.priorSnapshotId).toBe('s-prior');
    expect(board.units[0]).toMatchObject({ code: 'A', deltaPoints: '20.0000', trend: 'UP', lastYear: { ratePct: '30.0000', disbursedVnd: '300', nullReason: null } });
    expect(board.units[1]).toMatchObject({ code: 'B', deltaPoints: '-10.0000', trend: 'DOWN' });
    expect(board.company).toMatchObject({ level: 'COMPANY', ratePct: '40.0000', deltaPoints: '10.0000', trend: 'UP', planVnd: '1500', disbursedVnd: '600' });
  });

  it('says a project that was not in the snapshot of last year, and never gives it a rate of 0', () => {
    const added = leaderRateBoard({ current: now, previous: before }).projects.find((row) => row.code === 'P2');
    expect(added?.lastYear).toEqual({ ratePct: null, disbursedVnd: null, nullReason: 'NOT_IN_PRIOR_SNAPSHOT' });
    expect(added?.deltaPoints).toBeNull();
    expect(added?.trend).toBeNull();
  });

  it('says there is no snapshot of last year for every row when there is none', () => {
    const board = leaderRateBoard({ current: now, previous: undefined });
    for (const row of [board.company, ...board.units, ...board.projects]) {
      expect(row.lastYear.nullReason).toBe('NO_PRIOR_SNAPSHOT');
      expect(row.lastYear.ratePct).toBeNull();
      expect(row.deltaPoints).toBeNull();
    }
    expect(board.priorSnapshotId).toBeNull();
  });

  it('a group nobody has a figure for has no rate and says why, not 0; a last year without a rate gives no change', () => {
    const empty = cuts('s', '2026-10-31', reading('0', null, null, { nullReason: 'ZERO_DENOMINATOR' }), [group('C', reading('100', null, null))], []);
    const board = leaderRateBoard({ current: empty, previous: undefined });
    expect(board.company).toMatchObject({ ratePct: null, nullReason: 'ZERO_DENOMINATOR', disbursedVnd: null });
    expect(board.units[0]).toMatchObject({ ratePct: null, nullReason: 'NO_DATA', disbursedVnd: null });
    const noRate = cuts('p', '2025-10-31', reading('0', null, null), [group('C', reading('100', null, null))], []);
    const compared = leaderRateBoard({ current: cuts('s', '2026-10-31', reading('10', '5', '50.0000'), [group('C', reading('10', '5', '50.0000'))], []), previous: noRate });
    expect(compared.units[0]?.lastYear).toEqual({ ratePct: null, disbursedVnd: null, nullReason: 'NO_DATA' });
    expect(compared.units[0]?.deltaPoints).toBeNull();
  });

  it('can be wrong in a way the test sees: swapping the two years flips the sign of every change', () => {
    const forward = leaderRateBoard({ current: now, previous: before });
    const swapped = leaderRateBoard({ current: before, previous: now });
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

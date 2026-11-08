import { INSIGHT_DEFAULTS, backtestThresholds, buildHeatmap, heatBand, insightParamsOf, trendRanking } from '../src/ana-insight';
import type { HeatInputCell, WeekScore } from '../src/ana-insight';

const params = insightParamsOf(INSIGHT_DEFAULTS as Record<string, unknown>);
const M = 1_000_000;
const cell = (rowKey: string, colKey: string, numerator: number | null, denominator: number, count: number): HeatInputCell => ({ rowKey, colKey, numeratorVnd: numerator === null ? null : String(numerator * M), denominatorVnd: String(denominator * M), count });

describe('the parameters of the insight (G3-10, G3-11)', () => {
  it('reads the defaults and refuses what is not whole', () => {
    expect(params).toMatchObject({ greenRatio: 0.95, amberRatio: 0.85, minCellCount: 3, backtestHorizonWeeks: 4, trendWeeks: 4 });
    expect(params.candidateShifts).toEqual([-10, -5, 0, 5, 10]);
    expect(() => insightParamsOf({ ...INSIGHT_DEFAULTS, amber_ratio: 1 })).toThrow();
    expect(() => insightParamsOf({ ...INSIGHT_DEFAULTS, ctr_amber_pct: 95 })).toThrow();
    expect(() => insightParamsOf({ ...INSIGHT_DEFAULTS, candidate_shifts: [] })).toThrow();
    expect(() => insightParamsOf({ ...INSIGHT_DEFAULTS, candidate_shifts: [5, 5] })).toThrow();
    expect(() => insightParamsOf({ ...INSIGHT_DEFAULTS, min_cell_count: 0 })).toThrow();
  });
});

describe('the heat-map (G3-10)', () => {
  it('golden: rate, band and totals of units by fund sources at a pace of 50 percent', () => {
    // U1/F1: 600 of 1000 = 60.0, 1.2 times the pace: green; U1/F2: 40.0 = 0.8 times: red; U2/F1: 45.0 = 0.9 times: amber; U2/F2 has two projects: not shown.
    const map = buildHeatmap('UNIT_FUND', [cell('U1', 'F1', 600, 1000, 5), cell('U1', 'F2', 400, 1000, 3), cell('U2', 'F1', 450, 1000, 4), cell('U2', 'F2', null, 500, 2)], 50, params);
    expect(map.cells.map((one) => [one.rowKey, one.colKey, one.ratePct, one.band, one.nullReason])).toEqual([
      ['U1', 'F1', '60.0', 'GREEN', null],
      ['U1', 'F2', '40.0', 'RED', null],
      ['U2', 'F1', '45.0', 'AMBER', null],
      ['U2', 'F2', null, null, 'SMALL_CELL'],
    ]);
    expect(map.hiddenCells).toBe(1);
    // The totals are sums of the cells shown, not an average of rates, and say how many were left out.
    expect(map.rowTotals).toEqual([
      { key: 'U1', numeratorVnd: String(1000 * M), denominatorVnd: String(2000 * M), ratePct: '50.0', cells: 2, hidden: 0 },
      { key: 'U2', numeratorVnd: String(450 * M), denominatorVnd: String(1000 * M), ratePct: '45.0', cells: 1, hidden: 1 },
    ]);
    expect(map.colTotals.map((one) => [one.key, one.ratePct, one.hidden])).toEqual([['F1', '52.5', 0], ['F2', '40.0', 1]]);
  });

  it('shows nothing of a small cell: no figure, no count, no band', () => {
    const [small] = buildHeatmap('UNIT_FUND', [cell('U', 'F', 900, 1000, 2)], 50, params).cells;
    expect(small).toEqual({ rowKey: 'U', colKey: 'F', numeratorVnd: null, denominatorVnd: null, count: null, ratePct: null, band: null, nullReason: 'SMALL_CELL' });
  });

  it('says why a cell has no rate and never makes it zero or green', () => {
    const map = buildHeatmap('UNIT_FUND', [cell('U', 'A', null, 1000, 3), cell('U', 'B', 10, 0, 3)], 50, params);
    expect(map.cells.map((one) => [one.nullReason, one.band, one.ratePct])).toEqual([['NO_FIGURE', null, null], ['NO_PLAN', null, null]]);
    const contractor = buildHeatmap('CONTRACTOR_UNIT', [cell('C', 'U', 10, 0, 3)], null, params);
    expect(contractor.cells[0]?.nullReason).toBe('NO_DENOMINATOR');
    // With no pace of the year a unit cell has a rate and no colour.
    expect(buildHeatmap('UNIT_FUND', [cell('U', 'F', 600, 1000, 3)], null, params).cells[0]).toMatchObject({ ratePct: '60.0', band: null });
  });

  it('colours the contractor views by the share of the accepted work that was paid', () => {
    expect([heatBand('CONTRACTOR_UNIT', '95.0', null, params), heatBand('CONTRACTOR_FUND', '90.0', null, params), heatBand('CONTRACTOR_UNIT', '75.0', null, params), heatBand('CONTRACTOR_UNIT', '69.9', null, params)]).toEqual(['GREEN', 'GREEN', 'AMBER', 'RED']);
    expect([heatBand('UNIT_FUND', '47.5', 50, params), heatBand('UNIT_FUND', '42.5', 50, params), heatBand('UNIT_FUND', '42.4', 50, params)]).toEqual(['GREEN', 'AMBER', 'RED']);
  });

  it('is the same whatever the order of the cells, and the totals add up to the shown cells', () => {
    const cells = [cell('U1', 'F1', 600, 1000, 5), cell('U1', 'F2', 400, 1000, 3), cell('U2', 'F1', 450, 1000, 4), cell('U2', 'F2', 100, 500, 3)];
    const one = buildHeatmap('UNIT_FUND', cells, 50, params);
    const two = buildHeatmap('UNIT_FUND', [...cells].reverse(), 50, params);
    expect([...two.cells].sort((a, b) => (a.rowKey + a.colKey < b.rowKey + b.colKey ? -1 : 1))).toEqual([...one.cells].sort((a, b) => (a.rowKey + a.colKey < b.rowKey + b.colKey ? -1 : 1)));
    expect(two.rowTotals).toEqual(one.rowTotals);
    const rowSum = one.rowTotals.reduce((sum, row) => sum + BigInt(row.denominatorVnd), 0n);
    const colSum = one.colTotals.reduce((sum, col) => sum + BigInt(col.denominatorVnd), 0n);
    expect(rowSum).toBe(colSum);
  });
});

const MONDAYS = ['2027-08-02', '2027-08-09', '2027-08-16', '2027-08-23', '2027-08-30', '2027-09-06', '2027-09-13', '2027-09-20', '2027-09-27', '2027-10-04'];
const series = (unitId: string, scores: Array<number | null>, bands: Array<WeekScore['band']>): WeekScore[] => scores.map((score, index) => ({ unitId, weekStart: MONDAYS[index] as string, score, band: bands[index] as WeekScore['band'] }));
const A = series('A', [10, 20, 35, 50, 65, 70, 40, 30, 20, 10], ['GREEN', 'GREEN', 'AMBER', 'AMBER', 'RED', 'RED', 'AMBER', 'AMBER', 'GREEN', 'GREEN']);
const B = series('B', Array(10).fill(5) as number[], Array(10).fill('GREEN') as WeekScore['band'][]);
const lines = { amberFrom: 30, redFrom: 60 };
const small = { backtestHorizonWeeks: 2, candidateShifts: [0], backtestMinPairs: 4 };

describe('the back-test of the early-warning thresholds (G3-11)', () => {
  it('golden: precision, recall and lead time of the line where amber begins (30) and where red begins (60)', () => {
    // Pairs: weeks 1 to 8 of two units (a pair needs the whole horizon of 2 weeks stored): 16. A is red in weeks 5 and 6, so its weeks 3, 4 and 5 are followed by a red week inside the horizon: 3 positives.
    const result = backtestThresholds([...A, ...B], lines, small);
    expect(result).toMatchObject({ horizonWeeks: 2, pairs: 16, positives: 3, weeksEvaluated: 8, unitsEvaluated: 2, nullReason: null });
    const amber = result.candidates.find((one) => one.line === 'AMBER') as (typeof result.candidates)[number];
    // Warns at 30 or more: weeks 3 to 8 of A (35, 50, 65, 70, 40, 30): 3 right (weeks 3, 4, 5) and 3 wrong; nothing missed; 10 right silences (A weeks 1 and 2, all of B).
    expect(amber).toMatchObject({ threshold: 30, isCurrent: true, tp: 3, fp: 3, fn: 0, tn: 10, precisionPct: '50.0', recallPct: '100.0', meanLeadWeeks: '2.0', missedUnits: 0, warnedEarlyUnits: 1 });
    const red = result.candidates.find((one) => one.line === 'RED') as (typeof result.candidates)[number];
    // Warns at 60 or more: weeks 5 and 6 of A: 1 right, 1 wrong, the 2 earlier positives missed; the run of warnings before the first red week is empty, so A was not warned early.
    expect(red).toMatchObject({ threshold: 60, isCurrent: false, tp: 1, fp: 1, fn: 2, tn: 12, precisionPct: '50.0', recallPct: '33.3', meanLeadWeeks: null, missedUnits: 1, warnedEarlyUnits: 0 });
  });

  it('makes one candidate for each shift of each line, sorted by threshold', () => {
    const result = backtestThresholds([...A, ...B], lines, { backtestHorizonWeeks: 2, candidateShifts: [-5, 0, 5], backtestMinPairs: 4 });
    expect(result.candidates.map((one) => [one.line, one.threshold])).toEqual([['AMBER', 25], ['AMBER', 30], ['AMBER', 35], ['RED', 55], ['RED', 60], ['RED', 65]]);
    expect(result.candidates.filter((one) => one.isCurrent)).toHaveLength(1);
  });

  it('gives no precision or recall when the sample is too small, and says so', () => {
    const result = backtestThresholds([...A, ...B], lines, { ...small, backtestMinPairs: 50 });
    expect(result.nullReason).toBe('TOO_FEW_PAIRS');
    expect(result.candidates.every((one) => one.precisionPct === null && one.recallPct === null && one.nullReason === 'TOO_FEW_PAIRS')).toBe(true);
    expect(backtestThresholds([], lines, small)).toMatchObject({ pairs: 0, nullReason: 'TOO_FEW_PAIRS' });
  });

  it('does not judge a week whose horizon is not complete, nor a week with no score, and never reads no data as red', () => {
    const gaps = series('A', [10, null, 35, 50, 65, 70], ['GREEN', 'NO_DATA', 'AMBER', 'AMBER', 'RED', 'NO_DATA']);
    const result = backtestThresholds(gaps, lines, { backtestHorizonWeeks: 2, candidateShifts: [0], backtestMinPairs: 1 });
    // Weeks 1, 3 and 4 have a score and a complete horizon of 2 weeks (the latest week is 6); week 2 has no score.
    expect(result.pairs).toBe(3);
    expect(result.positives).toBe(2);
  });

  it('a candidate that warns on nothing says it has no positive prediction instead of a precision of zero', () => {
    const result = backtestThresholds([...A, ...B], { amberFrom: 500, redFrom: 600 }, small);
    expect(result.candidates[0]).toMatchObject({ tp: 0, fp: 0, precisionPct: null, nullReason: 'NO_POSITIVE_PREDICTION' });
  });
});

describe('the ranking by trend (G3-11)', () => {
  it('golden: the most improving first, a unit with no score at an end has no position', () => {
    const rows = trendRanking([...A, ...B, ...series('D', [null, null, null, null, null, null, null, null, null, 40], Array(10).fill('NO_DATA') as WeekScore['band'][]).map((row, index) => (index === 9 ? { ...row, band: 'AMBER' as const } : row)), ...series('C', [10, 10, 10, 10, 10, 10, 10, 10, 10, null], Array(10).fill('GREEN') as WeekScore['band'][])], '2027-10-04', 4, (id) => id);
    // A: 10 now against 70 four weeks before: -60, improving. B: 5 and 5: steady. D has no score four weeks before, C none now.
    expect(rows.map((row) => [row.unitId, row.rank, row.delta, row.direction, row.nullReason])).toEqual([
      ['A', 1, -60, 'IMPROVING', null],
      ['B', 2, 0, 'STEADY', null],
      ['C', null, null, null, 'NO_SCORE_NOW'],
      ['D', null, null, null, 'NO_SCORE_BEFORE'],
    ]);
    expect(rows[0]?.series).toEqual([70, 40, 30, 20, 10]);
  });

  it('puts a worsening unit last of the ranked ones and breaks a tie by the code', () => {
    const worse = series('W', [10, 10, 10, 10, 10, 10, 10, 10, 10, 50], Array(10).fill('GREEN') as WeekScore['band'][]);
    const twin = series('T', Array(10).fill(5) as number[], Array(10).fill('GREEN') as WeekScore['band'][]);
    const rows = trendRanking([...worse, ...B, ...twin], '2027-10-04', 4, (id) => id);
    expect(rows.map((row) => [row.unitId, row.rank, row.direction])).toEqual([['B', 1, 'STEADY'], ['T', 2, 'STEADY'], ['W', 3, 'WORSENING']]);
    expect(trendRanking([...worse, ...B, ...twin].reverse(), '2027-10-04', 4, (id) => id)).toEqual(rows);
  });
});

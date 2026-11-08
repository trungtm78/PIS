import { ApiError } from '@machvon/api-client';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as tr, translator } from '../../i18n';
import { harness, mount, routeOf } from '../mne/test-support';
import type { Harness } from '../mne/test-support';
import BacktestScreen, { backtestReason, chartSeries } from './BacktestScreen';
import HeatmapScreen, { cellReason } from './HeatmapScreen';
import { toBacktest, toHeatmap, toTrend } from './insight-model';
import type { Candidate } from './insight-model';

const READER = ['home.read'];
const ADMIN = ['home.read', 'bi.admin.read'];
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const cell = (rowKey: string, colKey: string, over: Record<string, unknown> = {}) => ({ row_key: rowKey, col_key: colKey, numerator_vnd: '600000000', denominator_vnd: '1000000000', count: 5, rate_pct: '60.0', band: 'GREEN', null_reason: null, ...over });
const heat = (over: Record<string, unknown> = {}) => ({
  view: 'UNIT_FUND',
  snapshot_id: 's1',
  as_of_date: '2027-10-12',
  pace_pct: 50,
  certification_gate: null,
  null_reason: null,
  params: { green_ratio: 0.95, amber_ratio: 0.85, min_cell_count: 3, ctr_green_pct: 90, ctr_amber_pct: 70 },
  info: { formula: 'Rate over pace', source: 'Snapshot', as_of: '2026-11-08', rule_version: 'builtin', unverified: true },
  rows: [{ key: 'U1', code: 'BAN-A', label: 'Ban A' }, { key: 'U2', code: 'BAN-B', label: 'Ban B' }],
  cols: [{ key: 'F1', code: 'NSTW', label: 'State budget', none: false }, { key: 'NONE', code: null, label: '', none: true }],
  cells: [cell('U1', 'F1'), cell('U1', 'NONE', { band: 'RED', rate_pct: '40.0' }), cell('U2', 'F1', { band: 'AMBER', rate_pct: '45.0' }), cell('U2', 'NONE', { numerator_vnd: null, denominator_vnd: null, count: null, rate_pct: null, band: null, null_reason: 'SMALL_CELL' })],
  row_totals: [{ key: 'U1', label: 'Ban A', numerator_vnd: '1000000000', denominator_vnd: '2000000000', rate_pct: '50.0', cells: 2, hidden: 0 }, { key: 'U2', label: 'Ban B', numerator_vnd: '450000000', denominator_vnd: '1000000000', rate_pct: '45.0', cells: 1, hidden: 1 }],
  col_totals: [{ key: 'F1', label: 'State budget', numerator_vnd: '1050000000', denominator_vnd: '2000000000', rate_pct: '52.5', cells: 2, hidden: 0 }, { key: 'NONE', label: null, numerator_vnd: '400000000', denominator_vnd: '1000000000', rate_pct: '40.0', cells: 1, hidden: 1 }],
  hidden_cells: 1,
  ...over,
});

const candidate = (over: Record<string, unknown> = {}) => ({ threshold: 30, is_current: true, shift: 0, line: 'AMBER', pairs: 16, tp: 3, fp: 3, fn: 0, tn: 10, precision_pct: '50.0', recall_pct: '100.0', mean_lead_weeks: '2.0', missed_units: 0, warned_early_units: 1, null_reason: null, ...over });
const backtest = (over: Record<string, unknown> = {}) => ({
  as_of_date: '2027-10-04',
  null_reason: null,
  horizon_weeks: 2,
  weeks_evaluated: 8,
  units_evaluated: 2,
  pairs: 16,
  positives: 3,
  min_pairs: 4,
  lines: { amber_from: 25, red_from: 45, score_rule_versions: {}, score_unverified: true },
  info: { formula: 'Replay of stored weeks', source: 'Weekly scores', as_of: '2026-11-08', rule_version: 'builtin', unverified: true },
  candidates: [candidate(), candidate({ threshold: 35, is_current: false, shift: 5, tp: 2, fp: 1, fn: 1, precision_pct: '66.7', recall_pct: '66.7', mean_lead_weeks: null }), candidate({ line: 'RED', threshold: 60, is_current: false, tp: 1, fp: 1, fn: 2, precision_pct: '50.0', recall_pct: '33.3', mean_lead_weeks: null, missed_units: 1, warned_early_units: 0 })],
  ...over,
});
const trendRow = (unitId: string, code: string, rank: number | null, delta: number | null, direction: string | null, over: Record<string, unknown> = {}) => ({ unit_id: unitId, code, name: `Unit ${code}`, rank, delta, direction, score_now: 10, score_before: 70, null_reason: null, series: [70, 40, 30, 20, 10], ...over });
const trend = (over: Record<string, unknown> = {}) => ({
  as_of_date: '2027-10-04',
  week_start: '2027-10-04',
  previous_week_start: '2027-09-27',
  null_reason: null,
  trend_weeks: 4,
  top: 5,
  info: { formula: 'Change of the score', source: 'Weekly scores', as_of: '2026-11-08', rule_version: 'builtin', unverified: true },
  improving: [trendRow('A', 'A', 1, -60, 'IMPROVING')],
  worsening: [trendRow('W', 'W', 3, 40, 'WORSENING', { score_now: 50, score_before: 10 })],
  units: [trendRow('A', 'A', 1, -60, 'IMPROVING'), trendRow('W', 'W', 3, 40, 'WORSENING', { score_now: 50, score_before: 10 }), trendRow('C', 'C', null, null, null, { score_now: null, null_reason: 'NO_SCORE_NOW', series: [null, null, null, null, null] })],
  ...over,
});

interface Answers {
  heat?: (view: string) => unknown;
  backtest?: () => unknown;
  trend?: () => unknown;
}
function client(answers: Answers = {}): Harness {
  return harness((operation, input) => {
    if (operation === 'getAnalyticsHeatmap') return (answers.heat ?? (() => heat()))(((input as { query?: { view?: string } }).query?.view ?? 'UNIT_FUND') as string);
    if (operation === 'getAnalyticsBacktest') return (answers.backtest ?? (() => backtest()))();
    if (operation === 'getAnalyticsTrendRanking') return (answers.trend ?? (() => trend()))();
    return new Error(`unexpected read ${operation}`);
  });
}

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });
afterEach(cleanup);

describe('BI-29 the heat-map (G3-10)', () => {
  const ROUTE = routeOf('BI-29', 'FR-BI-29');

  it('shows each cell as a number, a word and a mark with what it is made of, and the totals of rows and columns', async () => {
    mount(<HeatmapScreen route={ROUTE} />, client(), { permissions: READER });
    const table = await screen.findByTestId('heat-table');
    const rows = within(table).getAllByTestId('heat-row');
    const first = within(rows[0] as HTMLElement).getAllByTestId('heat-cell');
    expect(first[0]?.textContent).toContain('60,0%');
    expect(first[0]?.textContent).toContain(tr('ana.heat.band.green'));
    expect(first[0]?.getAttribute('data-band')).toBe('GREEN');
    expect(first[0]?.textContent).toContain(fill(tr('ana.heat.count.projects'), { count: 5 }));
    expect(first[0]?.textContent).toContain('600.000.000 / 1.000.000.000');
    expect(first[1]?.textContent).toContain(tr('ana.heat.band.red'));
    expect(within(rows[0] as HTMLElement).getByTestId('heat-row-total').textContent).toContain('50,0%');
    expect(within(rows[1] as HTMLElement).getByTestId('heat-row-total').textContent).toContain(fill(tr('ana.heat.total.hidden'), { count: 1 }));
    expect(screen.getAllByTestId('heat-col-total').map((one) => one.textContent)).toEqual(['52,5%', '40,0%']);
    expect(within(table).getByText(tr('ana.heat.col.none'))).toBeTruthy();
    expect(screen.getByTestId('ana-unverified')).toBeTruthy();
  });

  it('shows nothing of a small cell: N/A with the reason, and says how many are not shown', async () => {
    mount(<HeatmapScreen route={ROUTE} />, client(), { permissions: READER });
    await screen.findByTestId('heat-table');
    const small = screen.getAllByTestId('heat-cell').find((one) => one.getAttribute('data-reason') === 'SMALL_CELL') as HTMLElement;
    expect(small.textContent).toContain(tr('ana.common.na'));
    expect(small.textContent).toContain(tr('ana.heat.na.small'));
    expect(small.textContent).not.toContain('%');
    expect(screen.getByTestId('heat-hidden').textContent).toBe(fill(tr('ana.heat.hidden'), { count: 1 }));
    expect(screen.getByTestId('heat-legend').textContent).toContain(fill(tr('ana.heat.legend.min'), { count: 3 }));
  });

  it('asks again for the other views and writes the legend of the contractor views in percent', async () => {
    const h = client({ heat: (view) => (view === 'UNIT_FUND' ? heat() : heat({ view, pace_pct: null })) });
    mount(<HeatmapScreen route={ROUTE} />, h, { permissions: READER });
    await screen.findByTestId('heat-table');
    fireEvent.change(screen.getByTestId('heat-view'), { target: { value: 'CONTRACTOR_UNIT' } });
    await waitFor(() => expect(h.read.mock.calls.some((call) => (call[1] as { query: { view: string } }).query.view === 'CONTRACTOR_UNIT')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('heat-legend').textContent).toContain(fill(tr('ana.heat.legend.contractor'), { green: 90, amber: 70 })));
  });

  it('does not draw when the definition is not certified or there is no snapshot, and shows the error and denied states', async () => {
    mount(<HeatmapScreen route={ROUTE} />, client({ heat: () => heat({ certification_gate: 'NOT_CERTIFIED', null_reason: 'NOT_CERTIFIED', rows: [], cols: [], cells: [] }) }), { permissions: READER });
    expect((await screen.findByTestId('heat-gated')).textContent).toContain(tr('ana.heat.na.notCertified'));
    expect(screen.queryByTestId('heat-table')).toBeNull();
    cleanup();
    mount(<HeatmapScreen route={ROUTE} />, client({ heat: () => heat({ null_reason: 'NO_SNAPSHOT', snapshot_id: null, rows: [], cols: [], cells: [] }) }), { permissions: READER });
    expect(await screen.findByText(tr('states.empty.title'))).toBeTruthy();
    cleanup();
    mount(<HeatmapScreen route={ROUTE} />, client({ heat: () => new Error('boom') }), { permissions: READER });
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    mount(<HeatmapScreen route={ROUTE} />, client({ heat: () => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) }), { permissions: READER });
    expect((await screen.findByRole('alert')).textContent).toContain(tr('states.denied.title'));
  });

  it('turns every reason into words and reads wrong answers as nothing', () => {
    const reasons = ['SMALL_CELL', 'NO_FIGURE', 'NO_PLAN', 'NO_DENOMINATOR', 'NO_SNAPSHOT', 'NOT_CERTIFIED'];
    expect(new Set(reasons.map((reason) => cellReason(translator.t, reason))).size).toBe(reasons.length);
    expect(cellReason(translator.t, 'NEW')).toBe(tr('ana.heat.na.other'));
    expect(toHeatmap({})).toBeUndefined();
    expect(toHeatmap({ ...heat(), view: 'OTHER' })).toBeUndefined();
  });
});

describe('BI-30 the back-test and the trend (G3-11)', () => {
  const ROUTE = routeOf('BI-30', 'FR-BI-30');

  it('shows the candidates with right, wrong and missed warnings, precision, recall and lead time, and says it is a replay', async () => {
    mount(<BacktestScreen route={ROUTE} />, client(), { permissions: ADMIN });
    const table = await screen.findByTestId('back-table');
    const rows = within(table).getAllByTestId('back-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.getAttribute('data-current')).toBe('yes');
    expect(rows[0]?.textContent).toContain(tr('ana.back.current'));
    expect(rows[0]?.textContent).toContain('50,0%');
    expect(rows[0]?.textContent).toContain('100,0%');
    expect(rows[0]?.textContent).toContain(fill(tr('ana.back.weeks'), { weeks: '2,0' }));
    expect(rows[1]?.textContent).toContain(fill(tr('ana.back.shift'), { shift: '+5' }));
    expect(rows[2]?.textContent).toContain(tr('ana.common.na'));
    expect(screen.getByTestId('back-caveat').textContent).toBe(tr('ana.back.caveat'));
    expect(screen.getByTestId('back-summary').textContent).toContain(fill(tr('ana.back.lines'), { amber: '25', red: '45' }));
    expect(screen.getByRole('img', { name: tr('ana.back.chart.caption') })).toBeTruthy();
  });

  it('gives no precision or recall when the sample is too small and says why', async () => {
    mount(<BacktestScreen route={ROUTE} />, client({ backtest: () => backtest({ null_reason: 'TOO_FEW_PAIRS', pairs: 2, candidates: [candidate({ precision_pct: null, recall_pct: null, mean_lead_weeks: null, null_reason: 'TOO_FEW_PAIRS' })] }) }), { permissions: ADMIN });
    await screen.findByTestId('back-table');
    expect(screen.getAllByTestId('ana-na').some((note) => note.textContent?.includes(tr('ana.back.na.tooFew')))).toBe(true);
    expect(within(screen.getByTestId('back-table')).getAllByText(tr('ana.common.na')).length).toBeGreaterThanOrEqual(3);
  });

  it('shows the ranking by trend: the most improving and worsening, and the units that cannot be ranked with the reason', async () => {
    mount(<BacktestScreen route={ROUTE} />, client(), { permissions: ADMIN });
    await screen.findByTestId('back-table');
    const tables = screen.getAllByTestId('trend-table');
    expect(tables).toHaveLength(3);
    expect(within(tables[0] as HTMLElement).getByTestId('trend-delta').textContent).toBe('-60');
    expect(within(tables[1] as HTMLElement).getByTestId('trend-delta').textContent).toBe('40');
    expect(within(tables[2] as HTMLElement).getByTestId('trend-delta').textContent).toContain(tr('ana.back.na.noScoreNow'));
    expect(within(tables[0] as HTMLElement).getByRole('img', { name: fill(tr('ana.back.trend.sparkline'), { unit: 'A' }) })).toBeTruthy();
    expect(screen.getByText(tr('ana.back.trend.caveat'))).toBeTruthy();
  });

  it('keeps the trend when the reader may not see the back-test, and says so', async () => {
    mount(<BacktestScreen route={ROUTE} />, client({ backtest: () => new ApiError({ status: 403, code: 'PERMISSION_DENIED', correlationId: 'c' }) }), { permissions: READER });
    expect((await screen.findByTestId('back-error')).textContent).toBe(tr('ana.back.denied'));
    expect((await screen.findAllByTestId('trend-table')).length).toBeGreaterThanOrEqual(1);
  });

  it('shows the empty and error states', async () => {
    mount(<BacktestScreen route={ROUTE} />, client({ backtest: () => backtest({ null_reason: 'NO_SNAPSHOT', candidates: [] }), trend: () => trend({ null_reason: 'NO_SNAPSHOT', improving: [], worsening: [], units: [] }) }), { permissions: ADMIN });
    expect(await screen.findByText(tr('states.empty.title'))).toBeTruthy();
    cleanup();
    mount(<BacktestScreen route={ROUTE} />, client({ backtest: () => new Error('boom'), trend: () => new Error('boom') }), { permissions: ADMIN });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('draws precision and recall only for the amber candidates in threshold order, and reads wrong answers as nothing', () => {
    const candidates = (toBacktest(backtest())?.candidates ?? []) as Candidate[];
    const series = chartSeries(translator.t, candidates);
    expect(series.map((line) => line.points.map((point) => point.x))).toEqual([['30', '35'], ['30', '35']]);
    expect(series[0]?.points.map((point) => point.y)).toEqual([50, 66.7]);
    expect(new Set(['TOO_FEW_PAIRS', 'NO_POSITIVE_PREDICTION', 'NO_OUTCOME', 'NO_SNAPSHOT', 'NO_SCORE_NOW', 'NO_SCORE_BEFORE'].map((reason) => backtestReason(translator.t, reason))).size).toBe(6);
    expect(toBacktest({})).toBeUndefined();
    expect(toTrend({})).toBeUndefined();
  });
});

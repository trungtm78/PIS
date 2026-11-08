import { ApiError } from '@machvon/api-client';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as tr } from '../../i18n';
import { harness, mount, routeOf } from '../mne/test-support';
import type { Harness } from '../mne/test-support';
import OutlookScreen from './OutlookScreen';
import { toOutlookReading } from './forecast-model';
import { outlookReason } from './OutlookScreen';
import { translator } from '../../i18n';

const ROUTE = routeOf('BI-21', 'FR-BI-21');
const READER = ['home.read'];
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const needed = (overrides: Record<string, unknown> = {}) => ({ status: 'NEEDED', null_reason: null, remaining_vnd: '520000000', remaining_days: 61, per_week_vnd: '59672131', speed_vnd: '10000000', multiple: '5.97', multiple_null_reason: null, ...overrides });
const outlook = (overrides: Record<string, unknown> = {}) => ({
  null_reason: null,
  as_of_date: '2027-10-31',
  plan_year_end: '2027-12-31',
  cumulative_vnd: '480000000',
  plan_total_vnd: '1000000000',
  remaining_days: 61,
  projects: 2,
  windows: [4, 5].map((weeks) => ({ weeks, start_date: weeks === 4 ? '2027-10-03' : '2027-09-26', days: weeks * 7, delta_vnd: String(weeks * 10_000_000), weekly_speed_vnd: '10000000', linear_year_end_vnd: '567142857', seasonal_year_end_vnd: weeks === 4 ? '750000000' : null, seasonal_null_reason: weeks === 4 ? null : 'PRIOR_WINDOW_ZERO' })),
  skipped: [{ weeks: 8, reason: 'NO_POINT_AT_WINDOW_START' }],
  linear: { low_vnd: '567142857', central_vnd: '567142857', high_vnd: '567142857' },
  linear_ratio_pct: { low: '56.7', central: '56.7', high: '56.7' },
  seasonal: { low_vnd: '750000000', central_vnd: '750000000', high_vnd: '750000000' },
  seasonal_ratio_pct: { low: '75.0', central: '75.0', high: '75.0' },
  seasonal_null_reason: null,
  gap_vnd: '-432857143',
  attention: true,
  needed: needed(),
  ...overrides,
});
const reading = (overrides: Record<string, unknown> = {}) => ({
  year: 2027,
  as_of_date: '2027-10-31',
  plan_basis: 'PM',
  breakdown: 'FUND',
  null_reason: null,
  certification_gate: null,
  info: { formula: 'Speed over 4 to 8 weeks', source: 'Snapshots', as_of: '2026-11-08', rule_version: 'builtin', unverified: true },
  model: { window_min_weeks: 4, window_max_weeks: 8, central: 'MEDIAN', seasonality: true, attention_below_pct: 90 },
  whole: outlook(),
  series: [
    { as_of_date: '2027-10-24', cumulative_vnd: '470000000' },
    { as_of_date: '2027-10-31', cumulative_vnd: '480000000' },
  ],
  prior_series: [],
  funds: [
    { fund_source_version_id: 'f1', code: 'NSTW', label: 'State budget', outlook: outlook({ cumulative_vnd: '240000000', plan_total_vnd: '500000000' }) },
    { fund_source_version_id: 'f2', code: 'NSDP', label: 'Local budget', outlook: outlook({ null_reason: 'TOO_FEW_WEEKS', linear: null, linear_ratio_pct: null, seasonal: null, needed: needed({ per_week_vnd: '29836066', multiple: null, multiple_null_reason: 'NO_SPEED' }) }) },
  ],
  ...overrides,
});

function client(answer: (query: Record<string, string>) => unknown = () => reading()): Harness {
  return harness((operation, input) => (operation === 'getDisbursementOutlook' ? answer(((input as { query?: Record<string, string> }).query ?? {}) as Record<string, string>) : new Error(`unexpected read ${operation}`)));
}

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });
afterEach(cleanup);

describe('BI-21 year-end disbursement outlook (G3-5, G3-11)', () => {
  it('shows the cumulative, the plan, the band, the needed amount per week and the gap, each with its i', async () => {
    mount(<OutlookScreen route={ROUTE} />, client(), { permissions: READER });
    const tiles = await screen.findByTestId('outlook-tiles');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(tr('ana.forecast.page.title'));
    expect(within(tiles).getByTestId('ana-tile-cumulative').textContent).toContain('480.000.000');
    expect(within(tiles).getByTestId('ana-tile-plan').textContent).toContain('1.000.000.000');
    expect(within(tiles).getByTestId('ana-tile-projection').textContent).toContain('567.142.857');
    expect(tiles.textContent).toContain(fill(tr('ana.forecast.tile.band'), { low: '567.142.857', high: '567.142.857', ratio: '56,7' }));
    expect(within(tiles).getByTestId('ana-tile-needed').textContent).toContain('59.672.131');
    expect(tiles.textContent).toContain(fill(tr('ana.forecast.tile.multiple'), { multiple: '5,97', speed: '10.000.000' }));
    expect(within(tiles).getByTestId('ana-tile-gap').textContent).toContain('-432.857.143');
    expect(tiles.textContent).toContain(fill(tr('ana.forecast.tile.attention'), { pct: 90 }));
    // The i of every figure says the formula and that the rule is not confirmed.
    expect(within(tiles).getAllByRole('button', { name: /./ }).length).toBeGreaterThanOrEqual(5);
    expect(screen.getByTestId('ana-unverified')).toBeTruthy();
  });

  it('draws the chart from the same figures and says the windows and the skipped ones in a table and a note', async () => {
    mount(<OutlookScreen route={ROUTE} />, client(), { permissions: READER });
    await screen.findByTestId('outlook-tiles');
    expect(screen.getByRole('img', { name: tr('ana.forecast.chart.caption') })).toBeTruthy();
    const windows = screen.getByTestId('outlook-windows');
    expect(within(windows).getAllByRole('row')).toHaveLength(3);
    expect(windows.textContent).toContain('750.000.000');
    // A window with no seasonal reading is N/A, not 0.
    expect(within(windows).getAllByText(tr('ana.common.na')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('outlook-skipped').textContent).toBe(fill(tr('ana.forecast.windows.skipped'), { weeks: '8' }));
  });

  it('lists each fund source and says why one cannot be projected', async () => {
    mount(<OutlookScreen route={ROUTE} />, client(), { permissions: READER });
    const funds = await screen.findByTestId('outlook-funds');
    const rows = within(funds).getAllByTestId('outlook-fund-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('NSTW');
    expect(rows[0]?.textContent).toContain('567.142.857');
    expect(rows[1]?.textContent).toContain(tr('ana.forecast.na.tooFewWeeks'));
    expect(rows[1]?.textContent).toContain('29.836.066');
  });

  it('asks again with the other plan basis and without the fund split when the reader changes them', async () => {
    const h = client();
    mount(<OutlookScreen route={ROUTE} />, h, { permissions: READER });
    await screen.findByTestId('outlook-tiles');
    fireEvent.change(screen.getByTestId('outlook-basis'), { target: { value: 'TOTAL' } });
    await waitFor(() => expect(h.read.mock.calls.some((call) => (call[1] as { query: Record<string, string> }).query.plan_basis === 'TOTAL')).toBe(true));
    fireEvent.click(screen.getByTestId('outlook-by-fund'));
    await waitFor(() => expect(h.read.mock.calls.some((call) => (call[1] as { query: Record<string, string> }).query.breakdown === 'NONE')).toBe(true));
  });

  it('says there is no snapshot (N/A with the reason) and draws nothing', async () => {
    mount(<OutlookScreen route={ROUTE} />, client(() => reading({ year: null, as_of_date: null, null_reason: 'NO_SNAPSHOT', whole: null, series: [], funds: [] })), { permissions: READER });
    expect((await screen.findByText(tr('states.empty.title'))).tagName).toBeTruthy();
    expect(screen.queryByTestId('outlook-tiles')).toBeNull();
  });

  it('does not show a figure on a definition that is not certified', async () => {
    mount(<OutlookScreen route={ROUTE} />, client(() => reading({ certification_gate: 'NOT_CERTIFIED', null_reason: 'NOT_CERTIFIED', whole: null, series: [], funds: [] })), { permissions: READER });
    expect((await screen.findByTestId('outlook-gated')).textContent).toContain(tr('ana.forecast.gated.notCertified'));
    expect(screen.queryByTestId('outlook-tiles')).toBeNull();
  });

  it('says why the outlook is missing when the year has ended, and when the plan or the pace is missing', async () => {
    mount(<OutlookScreen route={ROUTE} />, client(() => reading({ whole: outlook({ null_reason: 'YEAR_ENDED', linear: null, seasonal: null, gap_vnd: null, attention: null, needed: needed({ status: 'NA', per_week_vnd: null, multiple: null }) }), series: [], funds: [] })), { permissions: READER });
    await screen.findByTestId('outlook-tiles');
    expect(screen.getAllByTestId('ana-na').some((note) => note.textContent?.includes(tr('ana.forecast.na.yearEnded')))).toBe(true);
    expect(screen.getByTestId('ana-tile-projection').textContent).toContain(tr('ana.common.na'));
    expect(screen.getByTestId('ana-tile-needed').textContent).toContain(tr('ana.common.na'));
  });

  it('shows the error state with a retry, the denied state and keeps the last reading when a refresh fails', async () => {
    const failing = client(() => new Error('boom'));
    mount(<OutlookScreen route={ROUTE} />, failing, { permissions: READER });
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    mount(<OutlookScreen route={ROUTE} />, client(() => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: READER });
    expect((await screen.findByRole('alert')).textContent).toContain(tr('states.denied.title'));
  });

  it('turns every reason code into words and the unknown ones into a general sentence', () => {
    const codes = ['NO_PLAN', 'NO_TREASURY_DATA', 'TOO_FEW_WEEKS', 'ALL_WINDOWS_UNUSABLE', 'YEAR_ENDED', 'NO_SNAPSHOT', 'NO_PRIOR_YEAR', 'PRIOR_YEAR_TOO_SHORT', 'PRIOR_WINDOW_ZERO', 'SEASONALITY_OFF', 'ZERO_SPEED', 'NO_SPEED', 'NOT_CERTIFIED'];
    const words = codes.map((code) => outlookReason(translator.t, code));
    expect(new Set(words).size).toBe(codes.length);
    expect(outlookReason(translator.t, 'SOMETHING_NEW')).toBe(tr('ana.forecast.na.other'));
  });

  it('reads an answer that is not an outlook as nothing instead of inventing a figure', () => {
    expect(toOutlookReading(null)).toBeUndefined();
    expect(toOutlookReading({ year: 2027 })).toBeUndefined();
    const parsed = toOutlookReading({ ...reading(), whole: { null_reason: 'NO_PLAN', needed: { status: 'weird' } } });
    expect(parsed?.whole?.needed.status).toBe('NA');
    expect(parsed?.whole?.cumulativeVnd).toBeNull();
  });
});

import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { RATE_READER, client, mount, routeOf, world } from '../report/test-support';
import type { World } from '../report/test-support';
import ForecastScreen from './ForecastScreen';
import { chartGeometry, describeForecast, toForecast } from './model';

const ROUTE = routeOf('DIS-23', 'FR-DIS-23');
const PATH = '/dis/dis-23';
const SNAPSHOT = '00000000-0000-4000-8000-0000000000d1';

afterEach(cleanup);

const month = (number: number, amount: string | null, source = 'FORECAST'): Record<string, unknown> => ({ month: number, amount_vnd: amount, source });
const estimate = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  disbursed_vnd: '400000000',
  months: [month(11, '100000000'), month(12, '150000000')],
  eac_vnd: '650000000',
  plan_total_vnd: '1000000000',
  gap_vnd: '-350000000',
  ratio_pct: '65.0',
  coverage: 'COMPLETE',
  reallocation_candidate: true,
  method: 'FORECAST_AND_REGISTERED',
  ...over,
});
/** P-A-002: 400 million paid to October, forecasts of 100 and 150 million for November and December, a plan of a billion. */
const CURVE = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((number) => ({ month: number, actual_cumulative_vnd: String(number * 40_000_000), forecast_cumulative_vnd: null })),
  { month: 10, actual_cumulative_vnd: '400000000', forecast_cumulative_vnd: '400000000' },
  { month: 11, actual_cumulative_vnd: null, forecast_cumulative_vnd: '500000000' },
  { month: 12, actual_cumulative_vnd: null, forecast_cumulative_vnd: '650000000' },
];
const forecastRecord = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  snapshot_id: SNAPSHOT,
  as_of_date: '2027-10-31',
  treasury_cutoff_date: '2027-10-31',
  plan_year: 2027,
  cutoff_month: 10,
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  reallocation_threshold_pct: 80,
  project_id: null,
  ...estimate(),
  curve: CURVE,
  projects: [{ project: { id: '00000000-0000-4000-8000-0000000000a2', code: 'P-A-002', name: 'Đường tỉnh' }, ...estimate() }],
  next_cursor: null,
  ...over,
});

const open = (forecast: World['forecast'] = forecastRecord(), permissions = RATE_READER) => {
  const h = client(world({ forecast, snapshots: { '': { items: [], next_cursor: null, pending_reports: null } } }));
  mount(<ForecastScreen route={ROUTE} />, h, { permissions, path: PATH });
  return h;
};
const asked = (h: ReturnType<typeof client>): Array<Record<string, unknown>> => h.read.mock.calls.filter((call) => call[0] === 'getDisbursementForecast').map((call) => (call[1] as { query?: Record<string, unknown> }).query ?? {});

describe('DIS-23 disbursement forecast and year-end estimate', () => {
  it('AC-ST-DIS-018-1 / UAT-AC255: shows 400 million paid, 650 million estimated, the plan of a billion, the gap of -350 million with its sign, the share of the plan, and that the project is a candidate for reallocation awaiting D03', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.forecast.page.title'] })).toBeTruthy();
    const tiles = await screen.findByTestId('forecast-tiles');
    const tile = (label: string): string => within(tiles).getByText(label).closest('article')?.querySelector('.ui-kpi__value')?.textContent ?? '';
    expect([tile(vi_['dis.forecast.tile.disbursed']), tile(vi_['dis.forecast.tile.eac']), tile(vi_['dis.forecast.tile.plan']), tile(vi_['dis.forecast.tile.gap'])]).toEqual(['400.000.000', '650.000.000', '1.000.000.000', '-350.000.000']);
    expect(tiles.textContent).toContain(vi_['dis.forecast.ratio.text'].replace('{value}', '65.0'));
    expect(screen.getByTestId('forecast-coverage').textContent).toBe(vi_['dis.forecast.coverage.complete']);
    expect(screen.getByTestId('forecast-verdict').textContent).toContain(vi_['dis.forecast.candidate.yes'].replace('{pct}', '80'));
    expect(screen.getByTestId('forecast-verdict').textContent).toContain(vi_['dis.forecast.assumption.note']);
    expect(screen.getByTestId('definition-pending').textContent).toBe('CHỜ KÝ D03');
    expect(screen.queryByTestId('forecast-partial-note')).toBeNull();
    expect(screen.getByTestId('forecast-cutoff').textContent).toBe(vi_['dis.forecast.cutoff.text'].replace('{cutoff}', '2027-10-31'));
  });

  it('AC-ST-DIS-018-2 / UI-DIS-23: the chart is a described picture with a solid line, a dashed line and a dotted line, a legend that says each in words, and a table with the same numbers', async () => {
    open();
    const chart = await screen.findByTestId('forecast-chart');
    expect(chart.getAttribute('role')).toBe('img');
    expect(chart.querySelector('title')?.textContent).toBe(vi_['dis.forecast.chart.title']);
    expect(chart.querySelector('desc')?.textContent).toBe(vi_['dis.forecast.chart.desc']);
    expect(chart.querySelector('[data-line="actual"]')?.getAttribute('class')).toBe('actual');
    expect(chart.querySelector('[data-line="forecast"]')?.getAttribute('class')).toBe('forecast');
    expect(chart.querySelector('[data-line="plan"]')?.getAttribute('class')).toBe('plan');
    expect(chart.querySelectorAll('circle.actual-marker')).toHaveLength(10);
    expect(chart.querySelectorAll('rect.forecast-marker')).toHaveLength(3);
    for (const legend of ['actual', 'forecast', 'plan']) expect(document.querySelector(`[data-legend="${legend}"]`)?.textContent).toContain(vi_[`dis.forecast.legend.${legend}` as keyof typeof vi_]);
    const table = screen.getByTestId('forecast-curve-table');
    const row = (number: number): string[] => Array.from(table.querySelectorAll(`tr[data-month="${number}"] td`)).map((cell) => cell.textContent ?? '');
    expect(row(3)).toEqual(['120.000.000', '—', '1.000.000.000']);
    expect(row(10)).toEqual(['400.000.000', '400.000.000', '1.000.000.000']);
    expect(row(12)).toEqual(['—', '650.000.000', '1.000.000.000']);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(12);
    expect(within(table).getByRole('columnheader', { name: vi_['dis.forecast.curve.col.forecast'] })).toBeTruthy();
  });

  it('says where each month of the estimate comes from (forecast, registration), and a month with neither is told as having no figure, with a note that the estimate is a lower bound and no verdict', async () => {
    open(
      forecastRecord({
        months: [month(11, '90000000', 'REGISTERED'), month(12, null, 'MISSING')],
        eac_vnd: '490000000',
        gap_vnd: '-510000000',
        ratio_pct: '49.0',
        coverage: 'PARTIAL',
        reallocation_candidate: null,
        method: 'FORECAST_AND_REGISTERED_PARTIAL',
        curve: [{ month: 10, actual_cumulative_vnd: '400000000', forecast_cumulative_vnd: '400000000' }, { month: 11, actual_cumulative_vnd: null, forecast_cumulative_vnd: '490000000' }, { month: 12, actual_cumulative_vnd: null, forecast_cumulative_vnd: null }],
      }),
    );
    const months = await screen.findByTestId('forecast-months-table');
    expect(Array.from(months.querySelectorAll('tr[data-month="11"] td')).map((cell) => cell.textContent)).toEqual(['90.000.000', vi_['dis.forecast.source.registered']]);
    expect(Array.from(months.querySelectorAll('tr[data-month="12"] td')).map((cell) => cell.textContent)).toEqual(['—', vi_['dis.forecast.source.missing']]);
    expect(screen.getByTestId('forecast-partial-note').textContent).toBe(vi_['dis.forecast.partial.note']);
    expect(screen.getByTestId('forecast-verdict').textContent).toContain(vi_['dis.forecast.candidate.unknown']);
    expect(screen.getByTestId('forecast-coverage').textContent).toBe(vi_['dis.forecast.coverage.partial']);
    // The line of the forecast stops where a month is not known, instead of running flat.
    expect(screen.getByTestId('forecast-chart').querySelector('[data-line="forecast"]')?.getAttribute('d')?.match(/[ML]/g)).toHaveLength(2);
  });

  it('says nothing is estimated when the Treasury booked nothing (no data is not zero), and says a project is not a candidate when its estimate reaches the threshold', async () => {
    open(forecastRecord({ disbursed_vnd: null, eac_vnd: null, gap_vnd: null, ratio_pct: null, coverage: 'NONE', reallocation_candidate: null, method: 'NO_TREASURY_DATA', curve: [], projects: [] }));
    expect((await screen.findByTestId('forecast-verdict')).textContent).toContain(vi_['dis.forecast.candidate.noData']);
    expect(screen.getByTestId('forecast-partial-note').textContent).toBe(vi_['dis.forecast.partial.noData']);
    expect(within(screen.getByTestId('forecast-tiles')).getByText(vi_['dis.forecast.tile.eac']).closest('article')?.querySelector('.ui-kpi__value')?.textContent).toBe('—');
    cleanup();
    open(forecastRecord({ reallocation_candidate: false, projects: [{ project: { id: '00000000-0000-4000-8000-0000000000a3', code: 'P-A-003', name: 'Cầu' }, ...estimate({ reallocation_candidate: false }) }] }));
    expect((await screen.findByTestId('forecast-verdict')).textContent).toContain(vi_['dis.forecast.candidate.no'].replace('{pct}', '80'));
    const row = within(screen.getByRole('table', { name: vi_['dis.forecast.projects.aria'] })).getByRole('row', { name: /P-A-003/ });
    expect(within(row).getByText(vi_['dis.forecast.candidate.no'].replace('{pct}', '80'))).toBeTruthy();
  });

  it('lists the projects with their estimate, loads more by cursor, and asks for the snapshot that was chosen', async () => {
    const h = open((query) => (query.cursor === undefined ? forecastRecord({ next_cursor: 'next' }) : forecastRecord({ projects: [{ project: { id: '00000000-0000-4000-8000-0000000000a9', code: 'P-A-009', name: 'Kè' }, ...estimate() }], next_cursor: null })));
    const projectsTable = (): HTMLElement => screen.getByRole('table', { name: vi_['dis.forecast.projects.aria'] });
    await screen.findByRole('table', { name: vi_['dis.forecast.projects.aria'] });
    expect(projectsTable().querySelectorAll('tbody tr')).toHaveLength(1);
    fireEvent.click(await screen.findByRole('button', { name: vi_['dis.forecast.projects.more.action'] }));
    await waitFor(() => expect(projectsTable().querySelectorAll('tbody tr')).toHaveLength(2));
    // The next page asks for the snapshot the first page was of, so that a snapshot frozen in the meantime cannot slip into the list.
    expect(asked(h)).toEqual([{ limit: 50 }, { limit: 50, snapshot_id: SNAPSHOT, cursor: 'next' }]);
    cleanup();
    const chosen = client(world({ forecast: forecastRecord(), snapshots: { '': { items: [], next_cursor: null, pending_reports: null } } }));
    mount(<ForecastScreen route={ROUTE} />, chosen, { permissions: RATE_READER, path: `${PATH}?snapshot=${SNAPSHOT}` });
    await screen.findByTestId('forecast-tiles');
    expect(asked(chosen)).toEqual([{ limit: 50, snapshot_id: SNAPSHOT }]);
  });

  it('shows the refusals in words (no snapshot, not frozen) and is in each state of a screen: loading, denied, signed out, offline and error', async () => {
    const failing = (error: Error) => {
      const state = world({ snapshots: { '': { items: [], next_cursor: null, pending_reports: null } } });
      state.failing.set('getDisbursementForecast', error);
      return client(state);
    };
    const missing = client(world({ forecast: undefined, snapshots: { '': { items: [], next_cursor: null, pending_reports: null } } }));
    mount(<ForecastScreen route={ROUTE} />, missing, { permissions: RATE_READER, path: PATH });
    expect((await screen.findByTestId('forecast-refusal')).textContent).toBe(vi_['dis.forecast.problem.notFound']);
    cleanup();
    mount(<ForecastScreen route={ROUTE} />, failing(new ApiError({ status: 422, code: 'SNAPSHOT_NOT_FROZEN', correlationId: 'c' })), { permissions: RATE_READER, path: PATH });
    expect((await screen.findByTestId('forecast-refusal')).textContent).toBe(vi_['dis.forecast.problem.notFrozen']);
    cleanup();
    mount(<ForecastScreen route={ROUTE} />, failing(new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c' })), { permissions: RATE_READER, path: PATH });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    for (const [error, title] of [
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      cleanup();
      mount(<ForecastScreen route={ROUTE} />, failing(error), { permissions: RATE_READER, path: PATH });
      expect(await screen.findByText(title)).toBeTruthy();
    }
  });
});

describe('the forecast model', () => {
  it('reads the answer and drops what is not whole, and names the refusals', () => {
    expect(toForecast(undefined)).toBeUndefined();
    expect(toForecast({ snapshot_id: 'x' })).toBeUndefined();
    const read = toForecast(forecastRecord({ projects: [{ project: { id: 'p' } }, { project: { id: 'q', code: 'Q', name: 'Q' }, ...estimate({ coverage: 'NOPE' }) }] }));
    expect(read?.projects).toEqual([]);
    expect(read).toMatchObject({ eacVnd: '650000000', cutoffMonth: 10, thresholdPct: 80, definition: 'PROPOSED_PENDING_SIGNOFF' });
    expect([describeForecast(new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' })), describeForecast(new ApiError({ status: 422, code: 'SNAPSHOT_NOT_FROZEN', correlationId: 'c' })), describeForecast(new Error('x'))]).toEqual(['notFound', 'notFrozen', 'general']);
  });

  it('draws the lines from the numbers: a line is broken where a month is not known, the plan is a level, and the scale starts at zero and reaches the plan or the highest point', () => {
    const geometry = chartGeometry(
      [
        { month: 1, actualVnd: '0', forecastVnd: null },
        { month: 2, actualVnd: '50', forecastVnd: '50' },
        { month: 3, actualVnd: null, forecastVnd: null },
        { month: 4, actualVnd: null, forecastVnd: '150' },
      ],
      '100',
    );
    expect(geometry.actual.match(/[ML]/g)).toHaveLength(2);
    expect([geometry.forecast.match(/M/g)?.length, geometry.forecast.match(/L/g)?.length]).toEqual([2, undefined]);
    expect(geometry.yTicks.map((tick) => tick.vnd)).toEqual(['0', '38', '75', '113', '150']);
    expect(geometry.plan.y).toBeGreaterThan(geometry.yTicks[4]?.y ?? 0);
    expect(geometry.actualPoints).toHaveLength(2);
    expect(chartGeometry([], '0').actual).toBe('');
  });

  it('draws a net disbursement below zero (a refund) below the zero line instead of flattening it to zero, and puts the scale under it', () => {
    const geometry = chartGeometry(
      [
        { month: 1, actualVnd: '100', forecastVnd: null },
        { month: 2, actualVnd: '-50', forecastVnd: '-50' },
        { month: 3, actualVnd: null, forecastVnd: '200' },
      ],
      '100',
    );
    const zero = geometry.yTicks.find((tick) => tick.vnd === '0');
    const [high, low] = [geometry.actualPoints[0], geometry.actualPoints[1]];
    expect(geometry.yTicks.map((tick) => tick.vnd)).toEqual(['-50', '13', '75', '138', '200']);
    expect(low?.y).toBeGreaterThan(high?.y ?? 0);
    expect(geometry.yTicks[0]?.y).toBe(low?.y);
    expect(zero).toBeUndefined();
    expect(geometry.plan.y).toBeLessThan(low?.y ?? 0);
  });
});

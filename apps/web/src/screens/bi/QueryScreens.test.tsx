import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { translator } from '../../i18n';
import { harness, mount, routeOf } from '../mne/test-support';
import BoardScreen from './BoardScreen';
import { useRunQuery } from './hooks';
import { JOB_WAIT, QueryCancelled, QueryJobEnded, QueryStillRunning, describeQueryProblem, formatFigure, resolveQuery, toQueryResult, toQueuedQuery, toRunState } from './query-model';
import type { JobWatch } from './query-model';
import WorkbenchScreen from './WorkbenchScreen';
import { rawMetric } from './test-support';

const BOARD = routeOf('BI-02', 'FR-BI-02');
/** The figure of the tile of a metric on the board: the big number of its KPI tile. */
const figureOf = (id: string): HTMLElement | null => document.querySelector(`[data-metric-id="${id}"] .ui-kpi__value`);
const findFigure = (id: string) =>
  waitFor(() => {
    const element = figureOf(id);
    if (element === null) throw new Error(`the tile of ${id} has no figure yet`);
    return element;
  });
const BENCH = routeOf('BI-09', 'FR-BI-09');
const QUERIER = ['bi.query', 'metric_definition.read'];
const DATASET = '00000000-0000-4000-8000-0000000000d1';
const V1 = '00000000-0000-4000-8000-0000000000a1';
const V2 = '00000000-0000-4000-8000-0000000000a2';
const failure = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const RATE = rawMetric({ id: '00000000-0000-4000-8000-0000000000b1', code: 'disbursement_rate', aggregation_type: 'ratio', unit: 'percent' });
const DISBURSED = rawMetric({ id: '00000000-0000-4000-8000-0000000000b2', code: 'disbursed', aggregation_type: 'additive', unit: 'VND', numerator_ast: null, denominator_ast: null });
const DRAFT = rawMetric({ id: '00000000-0000-4000-8000-0000000000b3', code: 't_draft', status: 'DRAFT', origin: 'TENANT_UI' });

const dataset = {
  id: DATASET,
  dataset_code: 'DS-DISB',
  title: 'DISB',
  source_kind: 'PERIOD_SNAPSHOT',
  grain: 'project',
  join_paths: {},
  refresh_policy: 'ON_SNAPSHOT_FROZEN',
  status: 'ACTIVE',
  latest_version: null,
};
const version = (id: string, status = 'FROZEN', period = '2026-10') => ({
  id,
  dataset_id: DATASET,
  as_of_period: period,
  source_snapshot_id: null,
  built_at: '2026-11-01T01:00:00.000Z',
  row_count: 3,
  excluded_quarantine_rows: 0,
  quality_badge: 'PASSED',
  feeds_certified: true,
  status,
});

const group = (key: string | null, value: string | null, extra: Record<string, unknown> = {}) => ({
  key,
  label: key === null ? null : `Unit ${key}`,
  unclassified: key === null,
  value,
  numerator: null,
  denominator: null,
  null_reason: value === null ? 'NO_DATA' : null,
  drill_token: key === null ? null : `token-${key}`,
  ...extra,
});
const answer = (overrides: Record<string, unknown> = {}) => ({
  metric: { id: DISBURSED.id, code: 'disbursed', unit: 'VND', aggregation_type: 'additive' },
  as_of_period: '2026-10',
  snapshot_id: V1,
  quality_badge: 'WARNING',
  excluded_quarantine_rows: 12,
  feeds_certified: true,
  new_data_available: false,
  scope: { label: 'YOUR_SCOPE', full_tenant: false },
  served_from_cache: false,
  built_at: '2026-11-01T02:00:00.000Z',
  dimension: 'unit',
  total: { value: '10500000000', numerator: null, denominator: null, null_reason: null },
  reconciles_to_parent: true,
  non_additive_reason: null,
  truncated: false,
  children: [group('A', '10000000000'), group(null, '500000000')],
  drill_token: 'token-root',
  ...overrides,
});

interface World {
  metrics: unknown[] | Error;
  datasets: unknown[] | Error;
  versions: unknown[] | Error;
}

function client(
  world: World,
  command: (operation: string, input: unknown) => unknown,
  read: (input: unknown) => unknown = () => answer(),
  run: (input: unknown) => unknown = () => new Error('unexpected read getBiQueryRun'),
) {
  const h = harness((operation, input) => (operation === 'explainBiMetric' ? read(input) : operation === 'getBiQueryRun' ? run(input) : new Error(`unexpected read ${operation}`)), command);
  const readAll = vi.fn((operation: string) => {
    const result =
      operation === 'get_resources_metric_definition'
        ? world.metrics
        : operation === 'listBiDatasets'
          ? world.datasets
          : operation === 'listBiDatasetVersions'
            ? world.versions
            : new Error(`unexpected readAll ${operation}`);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}
const normal = (): World => ({ metrics: [RATE, DISBURSED, DRAFT], datasets: [dataset], versions: [version(V1), version(V2, 'SUPERSEDED')] });

afterEach(cleanup);

describe('BI-09 analysis workbench (ST-BI-004, BI F3, F4)', () => {
  const runIt = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: vi_['bi.workbench.run'] }));
    return screen.findByTestId('workbench-result');
  };

  it('AC-ST-BI-004-1: UAT-AC31 offers only certified metrics, runs the query on the snapshot chosen, and labels the figures with the period, snapshot, quality, cache and scope', async () => {
    const user = userEvent.setup();
    const h = client(normal(), () => answer());
    mount(<WorkbenchScreen route={BENCH} />, h, { permissions: QUERIER });
    const options = [...((await screen.findByLabelText(vi_['bi.workbench.metric'])) as HTMLSelectElement).options].map((option) => option.textContent);
    expect(options).toEqual(['Tỷ lệ giải ngân (disbursement_rate)', 'disbursed']);
    const result = await runIt(user);
    expect(h.command.mock.calls[0]).toMatchObject(['post_dashboard_queries', { body: { metric_version_id: RATE.id, snapshot_id: V1, dimensions: ['unit'], filters: [] } }]);
    expect(within(result).getByTestId('label-period').textContent).toBe(fill(vi_['bi.query.label.period'], { period: '2026-10' }));
    expect(within(result).getByTestId('label-snapshot').textContent).toBe(fill(vi_['bi.query.label.snapshot'], { id: V1.slice(0, 8) }));
    expect(within(result).getByTestId('label-quality').textContent).toContain(vi_['bi.dataset.badge.warning']);
    expect(within(result).getByTestId('label-cache').textContent).toBe(fill(vi_['bi.query.label.fresh'], { at: '2026-11-01T02:00:00.000Z' }));
    expect(within(result).getByTestId('label-scope').getAttribute('data-scope')).toBe('YOUR_SCOPE');
    expect(within(result).getByTestId('label-scope').textContent).toBe(vi_['bi.query.label.yourScope']);
    expect(within(result).getByText(fill(vi_['bi.versions.excluded'], { rows: 12 }))).toBeTruthy();
    expect(within(result).getByTestId('reconciles').getAttribute('data-reconciles')).toBe('true');
    expect(screen.queryByTestId('new-data-banner')).toBeNull();
  });

  it('names the period and the snapshot that will be asked in the context bar, and gives the result a card titled with its metric', async () => {
    const user = userEvent.setup();
    mount(<WorkbenchScreen route={BENCH} />, client(normal(), () => answer()), { permissions: QUERIER });
    await screen.findByLabelText(vi_['bi.workbench.metric']);
    const bar = screen.getByRole('group', { name: vi_['ui.contextBar.label'] });
    expect(within(bar).getByText('2026-10')).toBeTruthy();
    expect(within(bar).getByText(V1.slice(0, 8))).toBeTruthy();
    const result = await runIt(user);
    expect(within(result).getByRole('heading', { level: 2 }).textContent).toBe('disbursed');
  });

  it('AC-ST-BI-004-2: UAT-AC32 shows Unclassified as a group, a figure that cannot be given as "no data" or "not applicable" and never as 0, and a ratio with its numerator and denominator', async () => {
    const user = userEvent.setup();
    const ratio = answer({
      metric: { id: RATE.id, code: 'disbursement_rate', unit: 'percent', aggregation_type: 'ratio' },
      total: { value: '35.00', numerator: '10500000000', denominator: '30000000000', null_reason: null },
      children: [
        group('A', '45.00', { numerator: '4500000000', denominator: '10000000000' }),
        group('C', null, { null_reason: 'NOT_APPLICABLE', numerator: '0', denominator: '0' }),
        group(null, null),
      ],
    });
    mount(
      <WorkbenchScreen route={BENCH} />,
      client(normal(), () => ratio),
      { permissions: QUERIER },
    );
    const result = await runIt(user);
    expect(within(result).getByTestId('value-A').textContent).toBe('45,00%');
    expect(within(result).getByTestId('value-C').textContent).toBe(vi_['bi.query.notApplicable']);
    expect(within(result).getByTestId('value-unclassified').textContent).toBe(vi_['bi.query.noData']);
    expect(within(result).getByText(vi_['bi.query.unclassified'])).toBeTruthy();
    expect(within(result).getByTestId('group-total').textContent).toContain('35,00%');
    expect(within(result).getByTestId('group-total').textContent).toContain('10500000000');
    expect(within(result).getByRole('columnheader', { name: vi_['bi.query.column.numerator'] })).toBeTruthy();
    expect(result.textContent).not.toMatch(/(^|\s)0(,00)?%/);
  });

  it('AC-ST-BI-004-6: UAT-AC480 says the groups do not add up, and why, when one thing is in two of them', async () => {
    const user = userEvent.setup();
    mount(
      <WorkbenchScreen route={BENCH} />,
      client(normal(), () => answer({ reconciles_to_parent: false, non_additive_reason: 'DISTINCT_NOT_ADDITIVE' })),
      { permissions: QUERIER },
    );
    const result = await runIt(user);
    expect(within(result).getByTestId('reconciles').getAttribute('data-reconciles')).toBe('false');
    expect(within(result).getByTestId('reconciles').textContent).toBe(vi_['bi.query.notAdditive.distinct']);
  });

  it('AC-ST-BI-004-1: UAT-AC31 raises the banner when newer data exists, keeps the snapshot, and renews the context on a click and asks again on the newest snapshot', async () => {
    const user = userEvent.setup();
    const h = client(normal(), (operation, input) => {
      if (operation === 'refreshBiQueryContext') return { snapshot_id: V2, drill_token: 'renewed' };
      return (input as { body: { snapshot_id: string } }).body.snapshot_id === V2 ? answer({ snapshot_id: V2, new_data_available: false }) : answer({ new_data_available: true });
    });
    mount(<WorkbenchScreen route={BENCH} />, h, { permissions: QUERIER });
    const result = await runIt(user);
    expect(within(result).getByTestId('new-data-banner').textContent).toContain(vi_['bi.workbench.newData']);
    expect(within(result).getByTestId('label-snapshot').textContent).toContain(V1.slice(0, 8));
    await user.click(within(result).getByRole('button', { name: vi_['bi.workbench.renew'] }));
    await waitFor(() => expect(screen.getByTestId('label-snapshot').textContent).toContain(V2.slice(0, 8)));
    expect(h.command.mock.calls.map(([operation]) => operation)).toEqual(['post_dashboard_queries', 'refreshBiQueryContext', 'post_dashboard_queries']);
    expect(h.command.mock.calls[1]).toMatchObject(['refreshBiQueryContext', { body: { drill_token: 'token-root' } }]);
    expect(screen.queryByTestId('new-data-banner')).toBeNull();
  });

  it('renews with the metric of the analysis that is open and the renewed context, though the form shows another metric now', async () => {
    const user = userEvent.setup();
    const h = client(normal(), (operation) =>
      operation === 'refreshBiQueryContext'
        ? { snapshot_id: V2, drill_token: 'renewed' }
        : answer({ new_data_available: true, metric: { id: RATE.id, code: 'disbursement_rate', unit: 'percent', aggregation_type: 'ratio' } }),
    );
    mount(<WorkbenchScreen route={BENCH} />, h, { permissions: QUERIER });
    const result = await runIt(user);
    await user.selectOptions(screen.getByLabelText(vi_['bi.workbench.metric']), DISBURSED.id);
    await user.click(within(result).getByRole('button', { name: vi_['bi.workbench.renew'] }));
    await waitFor(() => expect(h.command.mock.calls.length).toBe(3));
    expect(h.command.mock.calls[2]).toMatchObject(['post_dashboard_queries', { body: { metric_version_id: RATE.id, snapshot_id: V2, dimensions: ['unit'], context_token: 'renewed' } }]);
  });

  it('goes down a group to the next dimension on the same snapshot, keeps the path, and goes back up from the path', async () => {
    const user = userEvent.setup();
    const child = answer({ dimension: 'fund_source', total: { value: '10000000000', numerator: null, denominator: null, null_reason: null }, children: [group('X', '10000000000')] });
    const h = client(
      normal(),
      () => answer(),
      () => child,
    );
    mount(<WorkbenchScreen route={BENCH} />, h, { permissions: QUERIER });
    await runIt(user);
    const row = document.querySelector('[data-group="A"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: vi_['bi.query.drill.action'] }));
    await waitFor(() => expect(within(screen.getByTestId('breadcrumb')).getAllByRole('button')).toHaveLength(2));
    expect(h.read.mock.calls[0]).toEqual(['explainBiMetric', { query: { drill_token: 'token-A', child_dimension: 'fund_source' } }]);
    expect(screen.getByTestId('group-table').getAttribute('aria-label')).toBe(vi_['bi.query.table.aria']);
    expect(screen.getByRole('columnheader', { name: vi_['bi.query.dimension.fundSource'] })).toBeTruthy();
    expect(within(screen.getByTestId('breadcrumb')).getByRole('button', { name: `Unit A › ${vi_['bi.query.dimension.fundSource']}` })).toBeTruthy();
    await user.click(within(screen.getByTestId('breadcrumb')).getAllByRole('button')[0] as HTMLElement);
    expect(screen.getByRole('columnheader', { name: vi_['bi.query.dimension.unit'] })).toBeTruthy();
    // The group with no value has no way down.
    expect(document.querySelector('[data-group="unclassified"] button')).toBeNull();
  });

  it('keeps the path while a step down is asked for: the way back up is closed until the answer comes, and the answer is put under the path it was asked from', async () => {
    const user = userEvent.setup();
    const fund = answer({ dimension: 'fund_source', total: { value: '10000000000', numerator: null, denominator: null, null_reason: null }, children: [group('X', '10000000000')] });
    const project = answer({
      dimension: 'project',
      total: { value: '10000000000', numerator: null, denominator: null, null_reason: null },
      children: [group('P', '10000000000', { drill_token: null })],
    });
    let release: (value: unknown) => void = () => undefined;
    let calls = 0;
    const h = client(
      normal(),
      () => answer(),
      () => {
        calls += 1;
        return calls === 1
          ? fund
          : new Promise((resolve) => {
              release = resolve;
            });
      },
    );
    mount(<WorkbenchScreen route={BENCH} />, h, { permissions: QUERIER });
    await runIt(user);
    await user.click(within(document.querySelector('[data-group="A"]') as HTMLElement).getByRole('button', { name: vi_['bi.query.drill.action'] }));
    await waitFor(() => expect(within(screen.getByTestId('breadcrumb')).getAllByRole('button')).toHaveLength(2));
    await user.click(within(document.querySelector('[data-group="X"]') as HTMLElement).getByRole('button', { name: vi_['bi.query.drill.action'] }));
    await waitFor(() => expect(calls).toBe(2));
    expect((within(screen.getByTestId('breadcrumb')).getAllByRole('button')[0] as HTMLButtonElement).disabled).toBe(true);
    release(project);
    await waitFor(() => expect(within(screen.getByTestId('breadcrumb')).getAllByRole('button')).toHaveLength(3));
    expect((within(screen.getByTestId('breadcrumb')).getAllByRole('button')[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ['ACCESS_POLICY_MISSING', 403, 'policy', vi_['bi.query.refused.policy']],
    ['METRIC_NOT_CERTIFIED', 422, 'metric', vi_['bi.query.refused.metric']],
    ['SNAPSHOT_NOT_FOUND', 422, 'snapshot', vi_['bi.query.refused.snapshot']],
    ['DIMENSION_NOT_IN_DATASET', 422, 'dimension', fill(vi_['bi.query.refused.dimension'], { field: 'project' })],
    ['INTERNAL_ERROR', 500, 'general', vi_['bi.query.refused.general']],
  ])('AC-ST-BI-003-1: UAT-AC473 says what the server refused when a query is run: %s', async (code, status, reason, message) => {
    const user = userEvent.setup();
    mount(
      <WorkbenchScreen route={BENCH} />,
      client(normal(), () => failure(status, code, 'project')),
      { permissions: QUERIER },
    );
    await user.click(await screen.findByRole('button', { name: vi_['bi.workbench.run'] }));
    const refused = await screen.findByTestId('query-refused');
    expect(refused.getAttribute('data-reason')).toBe(reason);
    expect(refused.textContent).toContain(message);
  });

  it.each([
    ['SCOPE_DENIED', 403, 'scope', false],
    ['DRILL_TOKEN_INVALID', 400, 'token', true],
    ['SNAPSHOT_EXPIRED', 409, 'expired', true],
  ])('AC-ST-BI-004-3 and -4: says what a drill was refused (%s), and offers to renew where renewing helps', async (code, status, reason, renewable) => {
    const user = userEvent.setup();
    mount(
      <WorkbenchScreen route={BENCH} />,
      client(
        normal(),
        () => answer(),
        () => failure(status, code),
      ),
      { permissions: QUERIER },
    );
    await runIt(user);
    await user.click(within(document.querySelector('[data-group="A"]') as HTMLElement).getByRole('button', { name: vi_['bi.query.drill.action'] }));
    const refused = await screen.findByTestId('query-refused');
    expect(refused.getAttribute('data-reason')).toBe(reason);
    expect(within(refused).queryByRole('button', { name: vi_['bi.workbench.renew'] }) !== null).toBe(renewable);
    // The refusal names nothing of the place.
    expect(refused.textContent).not.toContain('Unit A');
  });

  describe('the seven standard states', () => {
    it.each([
      ['empty', { ...normal(), metrics: [DRAFT] }, vi_['states.empty.title']],
      ['denied', { ...normal(), metrics: failure(403, 'SCOPE_DENIED') }, vi_['states.denied.title']],
      ['offline', { ...normal(), datasets: new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }) }, vi_['states.offline.title']],
      ['error', { ...normal(), versions: failure(500, 'INTERNAL_ERROR') }, vi_['states.error.title']],
      ['signed out', { ...normal(), metrics: failure(401, 'SESSION_EXPIRED') }, vi_['states.signedOut.title']],
    ] as Array<[string, World, string]>)('UI-BI-09 shows the %s state', async (_name, world, title) => {
      mount(
        <WorkbenchScreen route={BENCH} />,
        client(world, () => answer()),
        { permissions: QUERIER },
      );
      expect(await screen.findByText(title)).toBeTruthy();
    });

    it('UI-BI-09 shows the loading state first and names the page', () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<WorkbenchScreen route={BENCH} />, h, { permissions: QUERIER });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['bi.workbench.page.title'] })).toBeTruthy();
    });
  });
});

describe('BI-02 the board of certified metrics (ST-BI-004, BI F3)', () => {
  it('AC-ST-BI-004-1: UAT-AC31 draws a tile for each certified metric over the latest frozen version, with the labels of its figure, and a link to the workbench on the same snapshot', async () => {
    const h = client(normal(), (_operation, input) => {
      const body = (input as { body: { metric_version_id: string } }).body;
      return body.metric_version_id === RATE.id
        ? answer({
            metric: { id: RATE.id, code: 'disbursement_rate', unit: 'percent', aggregation_type: 'ratio' },
            total: { value: '35.00', numerator: '10500000000', denominator: '30000000000', null_reason: null },
          })
        : answer();
    });
    mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER });
    expect(await findFigure(RATE.id)).toBeTruthy();
    await waitFor(() => expect((figureOf(DISBURSED.id) as HTMLElement).textContent).toBe('10.500.000.000 ₫'));
    expect((figureOf(RATE.id) as HTMLElement).textContent).toBe('35,00%');
    expect(document.querySelector(`[data-metric-id="${DRAFT.id}"]`)).toBeNull();
    expect(h.command.mock.calls.every(([, input]) => (input as { body: { snapshot_id: string } }).body.snapshot_id === V1)).toBe(true);
    const tile = document.querySelector(`[data-metric-id="${RATE.id}"]`) as HTMLElement;
    expect(within(tile).getByTestId('label-quality').textContent).toContain(vi_['bi.dataset.badge.warning']);
    expect(within(tile).getByRole('link').getAttribute('href')).toBe(`/bi/bi-09?metric=${RATE.id}&snapshot=${V1}`);
  });

  it('names the period and the snapshot of the board in the context bar, and groups the tiles in a strip with a label', async () => {
    mount(<BoardScreen route={BOARD} />, client(normal(), () => answer()), { permissions: QUERIER });
    await findFigure(RATE.id);
    const bar = screen.getByRole('group', { name: vi_['ui.contextBar.label'] });
    expect(within(bar).getByText('2026-10')).toBeTruthy();
    expect(within(bar).getByText(V1.slice(0, 8))).toBeTruthy();
    const strip = screen.getByRole('group', { name: 'Chỉ tiêu đã chứng nhận của kỳ chọn' });
    expect(within(strip).getAllByRole('article').length).toBe(2);
  });

  it('shows a dash with the reason, and not 0, in the tile that cannot be given', async () => {
    const h = client(normal(), () => failure(403, 'ACCESS_POLICY_MISSING'));
    mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER });
    await waitFor(() => expect(document.querySelectorAll('[data-reason="policy"]').length).toBe(2));
    expect(figureOf(RATE.id)?.textContent).toBe('—');
  });

  it('says why a tile has no figure, tile by tile, and never draws 0', async () => {
    const h = client(normal(), (_operation, input) =>
      (input as { body: { metric_version_id: string } }).body.metric_version_id === RATE.id
        ? failure(403, 'ACCESS_POLICY_MISSING')
        : answer({ total: { value: null, numerator: null, denominator: null, null_reason: 'NO_DATA' } }),
    );
    mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER });
    const tile = await findFigure(DISBURSED.id);
    expect(tile.textContent).toBe(vi_['bi.query.noData']);
    await waitFor(() => expect(document.querySelector(`[data-metric-id="${RATE.id}"] [data-reason="policy"]`)?.textContent).toBe(vi_['bi.query.refused.policy']));
  });

  it('ENT-4d: presents the certified tiles a page at a time over the board, with the filter and the links left behind', async () => {
    const user = userEvent.setup();
    mount(<BoardScreen route={BOARD} />, client(normal(), () => answer()), { permissions: QUERIER });
    await findFigure(RATE.id);
    await user.click(screen.getByTestId('present-open'));
    const presentation = await screen.findByRole('dialog', { name: translator.t('bi.present.title.text', { period: '2026-10' }) });
    expect(within(presentation).getByRole('heading', { level: 2, name: translator.t('bi.present.page.text', { from: 1, to: 2 }) })).toBeTruthy();
    expect(presentation.querySelector(`[data-metric-id="${RATE.id}"]`)).not.toBeNull();
    expect(within(presentation).queryByLabelText(vi_['bi.board.period'])).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('draws the tiles of the period chosen, and says when no period is frozen', async () => {
    const user = userEvent.setup();
    const h = client({ ...normal(), versions: [version(V1), version(V2, 'FROZEN', '2026-09')] }, () => answer());
    mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER });
    await findFigure(RATE.id);
    await user.selectOptions(screen.getByLabelText(vi_['bi.board.period']), '2026-09');
    await waitFor(() => expect(h.command.mock.calls.some(([, input]) => (input as { body: { snapshot_id: string } }).body.snapshot_id === V2)).toBe(true));
    cleanup();
    mount(
      <BoardScreen route={BOARD} />,
      client({ ...normal(), versions: [] }, () => answer()),
      { permissions: QUERIER },
    );
    expect((await screen.findByTestId('board-no-period')).textContent).toBe(vi_['bi.board.noPeriod']);
  });

  describe('the seven standard states', () => {
    it.each([
      ['empty', { ...normal(), metrics: [] }, vi_['states.empty.title']],
      ['denied', { ...normal(), datasets: failure(403, 'SCOPE_DENIED') }, vi_['states.denied.title']],
      ['offline', { ...normal(), metrics: new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }) }, vi_['states.offline.title']],
      ['error', { ...normal(), metrics: failure(500, 'INTERNAL_ERROR') }, vi_['states.error.title']],
      ['signed out', { ...normal(), versions: failure(401, 'SESSION_EXPIRED') }, vi_['states.signedOut.title']],
    ] as Array<[string, World, string]>)('UI-BI-02 shows the %s state', async (_name, world, title) => {
      mount(
        <BoardScreen route={BOARD} />,
        client(world, () => answer()),
        { permissions: QUERIER },
      );
      expect(await screen.findByText(title)).toBeTruthy();
    });

    it('UI-BI-02 shows the loading state first and names the page', () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['bi.board.page.title'] })).toBeTruthy();
    });
  });
});

describe('the answer of a query as the screens read it', () => {
  it('leaves out an answer that lacks what the screens need, and reads the figures as they are', () => {
    expect(toQueryResult(null)).toBeUndefined();
    for (const broken of [
      { metric: undefined },
      { total: 'x' },
      { quality_badge: 'GOOD' },
      { children: 'x' },
      { as_of_period: 4 },
      { snapshot_id: undefined },
      { drill_token: undefined },
      { children: [5] },
    ]) {
      expect(toQueryResult(answer(broken as Record<string, unknown>))).toBeUndefined();
    }
    const read = toQueryResult(answer({ scope: { label: 'FULL_TENANT' }, truncated: true, excluded_quarantine_rows: 'x', feeds_certified: false, total: { value: null, null_reason: 'SOMETHING' } }));
    expect(read).toMatchObject({ scopeLabel: 'FULL_TENANT', truncated: true, excludedQuarantineRows: 0, feedsCertified: false, total: { value: null, nullReason: null } });
    expect(read?.children.map((item) => [item.key, item.label, item.unclassified])).toEqual([
      ['A', 'Unit A', false],
      [null, '', true],
    ]);
  });

  it('writes a figure by its unit: money in dong, a ratio in percent, a count, and no figure as the words for it', () => {
    const words = { noData: 'no data', notApplicable: 'n/a' };
    const figure = (value: string | null, nullReason: 'NO_DATA' | 'NOT_APPLICABLE' | null = null) => ({ value, numerator: null, denominator: null, nullReason });
    expect(formatFigure(figure('1234567890'), 'VND', 'vi', words)).toBe('1.234.567.890 ₫');
    expect(formatFigure(figure('12'), 'count', 'en', words)).toBe('12');
    expect(formatFigure(figure('35.5'), 'percent', 'en', words)).toBe('35.50%');
    expect(formatFigure(figure('x'), 'VND', 'en', words)).toBe('x');
    expect(formatFigure(figure(null), 'VND', 'en', words)).toBe('no data');
    expect(formatFigure(figure(null, 'NOT_APPLICABLE'), 'percent', 'en', words)).toBe('n/a');
  });

  it('maps a refusal of the server', () => {
    const refused = (code: string, detail?: string) => describeQueryProblem(new ApiError({ status: 422, code, correlationId: 'c', detail, extensions: {} }));
    expect([
      refused('ACCESS_POLICY_MISSING').reason,
      refused('DIMENSION_NOT_IN_DATASET', 'x').field,
      refused('METRIC_NOT_CERTIFIED').reason,
      refused('SNAPSHOT_NOT_FOUND').reason,
      refused('SCOPE_DENIED').reason,
      refused('DRILL_TOKEN_INVALID').reason,
      refused('SNAPSHOT_EXPIRED').reason,
      refused('FIELD_NOT_ALLOWED').reason,
      refused('SESSION_EXPIRED').reason,
      refused('OTHER').reason,
    ]).toEqual(['policy', 'x', 'metric', 'snapshot', 'scope', 'token', 'expired', 'invalid', 'session', 'general']);
    expect(describeQueryProblem(new Error('x'))).toEqual({ reason: 'general', field: '' });
  });
});

describe('a query that became a job (ST-BI-009, BI F3: 202 ASYNC_JOB)', () => {
  const RUN = '00000000-0000-4000-8000-0000000000c9';
  const QUEUED = { operation_id: 'r', status: 'ASYNC_JOB', resource_version: 1, resource_id: RUN, mode: 'ASYNC_JOB', run_id: RUN, estimated_cost: 240, as_of_period: '2026-10', snapshot_id: V1 };
  const state = (status: string, errorCode: string | null = null) => ({ id: RUN, status, error_code: errorCode });
  /** A watch that looks at the states one after the other (the last one stays), without waiting. */
  const watching = (states: unknown[], over: Partial<JobWatch> = {}): JobWatch & { polled: string[] } => {
    const polled: string[] = [];
    return {
      polled,
      poll: (id) => {
        polled.push(id);
        return Promise.resolve(states.length > 1 ? states.shift() : states[0]);
      },
      cancelled: () => false,
      intervalMs: 10,
      attempts: 4,
      waitBetweenPolls: () => Promise.resolve(),
      ...over,
    };
  };

  it('reads the answer of a query that is a job as a queued run, and the answer of any other as none', () => {
    expect(toQueuedQuery(QUEUED)).toEqual({ runId: RUN });
    expect(toQueuedQuery(answer())).toBeUndefined();
    expect(toQueuedQuery({ status: 'ASYNC_JOB' })).toBeUndefined();
    expect(toQueuedQuery(undefined)).toBeUndefined();
  });

  it('reads how a run stands, and a run that says nothing as none', () => {
    expect(toRunState(state('FAILED', 'QUERY_FAILED'))).toEqual({ status: 'FAILED', errorCode: 'QUERY_FAILED' });
    expect(toRunState(state('QUEUED'))).toEqual({ status: 'QUEUED', errorCode: null });
    expect(toRunState({ status: 3 })).toBeUndefined();
    expect(toRunState(undefined)).toBeUndefined();
  });

  it('looks at the run while it waits and runs, and asks the question again only when it completed, then gives the answer the job kept', async () => {
    const replies: unknown[] = [QUEUED, answer()];
    const ask = vi.fn(() => Promise.resolve(replies.shift()));
    const watch = watching([state('QUEUED'), state('RUNNING'), state('COMPLETED')]);
    const result = await resolveQuery(ask, watch);
    expect(result?.total.value).toBe('10500000000');
    expect(watch.polled).toEqual([RUN, RUN, RUN]);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('answers as soon as the first answer is an answer, without looking at any run', async () => {
    const ask = vi.fn(() => Promise.resolve(answer()));
    const watch = watching([state('QUEUED')]);
    await resolveQuery(ask, watch);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(watch.polled).toEqual([]);
  });

  it('waits for the job of its own when the answer a completed job kept is gone by the time it is asked for', async () => {
    const replies: unknown[] = [QUEUED, QUEUED, answer()];
    const ask = vi.fn(() => Promise.resolve(replies.shift()));
    const result = await resolveQuery(ask, watching([state('COMPLETED'), state('COMPLETED')]));
    expect(result?.total.value).toBe('10500000000');
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['FAILED', 'QUERY_FAILED', 'general'],
    ['TIMEOUT', 'QUERY_TIMEOUT', 'timeout'],
    ['DENIED', 'SCOPE_DENIED', 'scope'],
    ['DENIED', 'ACCESS_POLICY_MISSING', 'policy'],
    ['DENIED', 'SCOPE_CHANGED', 'changed'],
    ['FAILED', 'METRIC_NOT_CERTIFIED', 'metric'],
    ['CANCELLED', null, 'general'],
  ])('gives the reason a job ended %s with %s (%s) and does not ask the question again or make another job', async (status, code, reason) => {
    const ask = vi.fn(() => Promise.resolve(QUEUED));
    const error = await resolveQuery(ask, watching([state('RUNNING'), state(status, code)])).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QueryJobEnded);
    expect(describeQueryProblem(error)).toEqual({ reason, field: '' });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('says the query is still running, with its run, when the job has not ended in the time given, and is not a failure of the query', async () => {
    const ask = vi.fn(() => Promise.resolve(QUEUED));
    const watch = watching([state('RUNNING')]);
    const error = await resolveQuery(ask, watch).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QueryStillRunning);
    expect((error as QueryStillRunning).runId).toBe(RUN);
    expect(watch.polled).toHaveLength(4);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(describeQueryProblem(error)).toEqual({ reason: 'running', field: '' });
  });

  it('asks nothing more once the question is not wanted: not the run, not the question again', async () => {
    const ask = vi.fn(() => Promise.resolve(QUEUED));
    let wanted = true;
    const watch = watching([state('RUNNING'), state('COMPLETED')], {
      cancelled: () => !wanted,
      waitBetweenPolls: () => {
        wanted = false;
        return Promise.resolve();
      },
    });
    await expect(resolveQuery(ask, watch)).rejects.toBeInstanceOf(QueryCancelled);
    expect(watch.polled).toEqual([]);
    expect(ask).toHaveBeenCalledTimes(1);
    // A question that is dropped between the completed run and the question asked again is not asked.
    let calls = 0;
    const late = watching([state('COMPLETED')], { cancelled: () => ++calls > 1 });
    const again = vi.fn(() => Promise.resolve(QUEUED));
    await expect(resolveQuery(again, late)).rejects.toBeInstanceOf(QueryCancelled);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('lets a refusal of the server through at once, whatever the wait', async () => {
    const ask = vi.fn(() => Promise.reject(failure(403, 'ACCESS_POLICY_MISSING')));
    await expect(resolveQuery(ask, watching([state('RUNNING')]))).rejects.toMatchObject({ code: 'ACCESS_POLICY_MISSING' });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  describe('on the screens', () => {
    afterEach(() => vi.useRealTimers());
    const runs = (states: unknown[]) => () => (states.length > 1 ? states.shift() : states[0]);

    it('the tile of the board looks at the run while the job runs and then draws the figure of the answer the job kept', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let asked = 0;
      const h = client(
        normal(),
        (_operation, input) => {
          const body = (input as { body: { metric_version_id: string } }).body;
          if (body.metric_version_id !== DISBURSED.id)
            return answer({
              metric: { id: RATE.id, code: 'disbursement_rate', unit: 'percent', aggregation_type: 'ratio' },
              total: { value: '35.00', numerator: '1', denominator: '2', null_reason: null },
            });
          asked += 1;
          return asked === 1 ? QUEUED : answer();
        },
        () => answer(),
        runs([state('QUEUED'), state('RUNNING'), state('COMPLETED')]),
      );
      mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER });
      await findFigure(RATE.id);
      expect(figureOf(DISBURSED.id)).toBeNull();
      await vi.advanceTimersByTimeAsync(JOB_WAIT.intervalMs * 3);
      await waitFor(() => expect((figureOf(DISBURSED.id) as HTMLElement).textContent).toBe('10.500.000.000 ₫'));
      // One question, one job: the run was looked at, the question was not made again until the job had completed.
      expect(asked).toBe(2);
    });

    it('the tile says the query is still running when the job does not end in the time the screen waits', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mount(
        <BoardScreen route={BOARD} />,
        client(
          normal(),
          () => QUEUED,
          () => answer(),
          runs([state('RUNNING')]),
        ),
        { permissions: QUERIER },
      );
      await vi.advanceTimersByTimeAsync(JOB_WAIT.intervalMs * (JOB_WAIT.attempts + 2));
      const messages = await screen.findAllByText(vi_['bi.query.refused.running']);
      expect(messages[0]?.getAttribute('data-reason')).toBe('running');
    });

    it('the tile says why the job failed and does not make the question again', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const h = client(
        normal(),
        () => QUEUED,
        () => answer(),
        runs([state('FAILED', 'QUERY_FAILED')]),
      );
      mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER });
      await vi.advanceTimersByTimeAsync(JOB_WAIT.intervalMs * 2);
      expect((await screen.findAllByText(vi_['bi.query.refused.general']))[0]?.getAttribute('data-reason')).toBe('general');
      // One question for each tile (two certified metrics), none again after the failure.
      expect(h.command).toHaveBeenCalledTimes(2);
    });

    it('stops asking when the screen is left: no run is looked at after it', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const polled = vi.fn(runs([state('RUNNING')]));
      const view = mount(
        <BoardScreen route={BOARD} />,
        client(
          normal(),
          () => QUEUED,
          () => answer(),
          polled,
        ),
        { permissions: QUERIER },
      );
      await vi.advanceTimersByTimeAsync(JOB_WAIT.intervalMs * 2);
      const before = polled.mock.calls.length;
      expect(before).toBeGreaterThan(0);
      view.unmount();
      await vi.advanceTimersByTimeAsync(JOB_WAIT.intervalMs * 10);
      expect(polled.mock.calls.length).toBe(before);
    });

    it('stops asking when the tenant changes: the run of the old tenant is not looked at with the credentials of the new one', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const polled = vi.fn(runs([state('RUNNING')]));
      const view = mount(
        <WorkbenchScreen route={BENCH} />,
        client(
          normal(),
          () => QUEUED,
          () => answer(),
          polled,
        ),
        { permissions: QUERIER },
      );
      await user.click(await screen.findByRole('button', { name: vi_['bi.workbench.run'] }));
      await vi.advanceTimersByTimeAsync(JOB_WAIT.intervalMs * 2);
      const before = polled.mock.calls.length;
      expect(before).toBeGreaterThan(0);
      view.rerenderWith({ permissions: QUERIER, tenant: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Khác', membershipId: '00000000-0000-4000-8000-000000000001' } as never });
      await vi.advanceTimersByTimeAsync(JOB_WAIT.intervalMs * 10);
      expect(polled.mock.calls.length).toBe(before);
    });

    it('a screen that stays mounted when the member or the tenant changes does not go on asking in the name of the old one', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const polled = vi.fn(runs([state('RUNNING')]));
      function Probe() {
        const run = useRunQuery();
        return (
          <button type="button" onClick={() => run.mutate({ metricId: RATE.id as string, snapshotId: V1 })}>
            go
          </button>
        );
      }
      const view = mount(
        <Probe />,
        client(
          normal(),
          () => QUEUED,
          () => answer(),
          polled,
        ),
        { permissions: QUERIER },
      );
      await user.click(screen.getByRole('button', { name: 'go' }));
      await vi.advanceTimersByTimeAsync(JOB_WAIT.intervalMs * 2);
      const before = polled.mock.calls.length;
      expect(before).toBeGreaterThan(0);
      view.rerenderWith({ permissions: QUERIER, tenant: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Khác', membershipId: '00000000-0000-4000-8000-000000000001' } as never });
      await vi.advanceTimersByTimeAsync(JOB_WAIT.intervalMs * 10);
      expect(polled.mock.calls.length).toBe(before);
    });

    it('the workbench waits for the job and then shows the answer with its labels', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let asked = 0;
      mount(
        <WorkbenchScreen route={BENCH} />,
        client(
          normal(),
          () => (++asked === 1 ? QUEUED : answer()),
          () => answer(),
          runs([state('RUNNING'), state('COMPLETED')]),
        ),
        { permissions: QUERIER },
      );
      await user.click(await screen.findByRole('button', { name: vi_['bi.workbench.run'] }));
      await vi.advanceTimersByTimeAsync(JOB_WAIT.intervalMs * 3);
      const result = await screen.findByTestId('workbench-result');
      expect(within(result).getByTestId('label-period').textContent).toBe(fill(vi_['bi.query.label.period'], { period: '2026-10' }));
      expect(asked).toBe(2);
    });
  });
});

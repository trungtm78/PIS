import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import { harness, mount, routeOf } from '../mne/test-support';
import BoardScreen from './BoardScreen';
import DashboardLibraryScreen from './DashboardLibraryScreen';
import { BOARD_DASHBOARD_PARAM, BOARD_PATH, boardDashboards, boardMetricsOf, datasetIdsOf, pinnedSnapshotOf, publishedVersionOf } from './board-model';
import { toDashboard, toVersion } from './dashboard-model';
import { toMetric } from './bi-model';
import { rawMetric } from './test-support';

// The strings of this lane wait in a part of the catalogue until it is folded; the translator reads both.
const txt = (key: string): string => translator.t(key);
const BOARD = routeOf('BI-02', 'FR-BI-02');
const LIBRARY = routeOf('BI-01', 'FR-BI-01');
const QUERIER = ['bi.query', 'dashboard_version.read', 'metric_definition.read'];
const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const THIRD = '00000000-0000-4000-8000-0000000000c3';
const D1 = '00000000-0000-4000-8000-0000000000e1';
const D2 = '00000000-0000-4000-8000-0000000000e2';
const VP = '00000000-0000-4000-8000-0000000000f1';
const VD = '00000000-0000-4000-8000-0000000000f2';
const DATASET = '00000000-0000-4000-8000-0000000000d1';
const SNAP = '00000000-0000-4000-8000-0000000000a1';
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', detail: undefined, extensions: {} });

const RATE = rawMetric({ id: '00000000-0000-4000-8000-0000000000b1', code: 'disbursement_rate', aggregation_type: 'ratio', unit: 'percent' });
const DISBURSED = rawMetric({ id: '00000000-0000-4000-8000-0000000000b2', code: 'disbursed', aggregation_type: 'additive', unit: 'VND', numerator_ast: null, denominator_ast: null });
const WITHDRAWN = rawMetric({ id: '00000000-0000-4000-8000-0000000000b3', code: 't_withdrawn', status: 'RETIRED' });

const dataset = { id: DATASET, dataset_code: 'DS-DISB', title: 'DISB', source_kind: 'PERIOD_SNAPSHOT', grain: 'project', join_paths: {}, refresh_policy: 'ON_SNAPSHOT_FROZEN', status: 'ACTIVE', latest_version: null };
const frozen = { id: SNAP, dataset_id: DATASET, as_of_period: '2026-10', source_snapshot_id: null, built_at: '2026-11-01T01:00:00.000Z', row_count: 3, excluded_quarantine_rows: 0, quality_badge: 'PASSED', feeds_certified: true, status: 'FROZEN' };
const answer = {
  metric: { id: DISBURSED.id, code: 'disbursed', unit: 'VND', aggregation_type: 'additive' },
  as_of_period: '2026-10',
  snapshot_id: SNAP,
  quality_badge: 'PASSED',
  excluded_quarantine_rows: 0,
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
  children: [],
  drill_token: 'token-root',
};

const signOff = (overrides: Record<string, unknown> = {}) => ({
  version_id: VP,
  revision: 1,
  prepared_by: { id: OTHER, name: 'Lan', at: '2026-11-01T01:00:00.000Z' },
  checked_by: { id: THIRD, name: 'Minh', at: '2026-11-02T01:00:00.000Z' },
  approved_by: { id: ME, name: null, at: '2026-11-03T01:00:00.000Z' },
  state: 'APPROVED',
  complete: true,
  ...overrides,
});
const version = (id: string, revision: number, status: string, metrics: string[], sign?: Record<string, unknown>) => ({
  id,
  dashboard_id: D1,
  revision,
  layout_json: { columns: 12, widgets: [] },
  metric_versions: metrics,
  filter_mappings: {},
  breakpoints: {},
  dataset_version_policy: 'LATEST_FROZEN',
  pinned_dataset_version_ids: [],
  status,
  created_by: OTHER,
  created_at: '2026-11-01T01:00:00.000Z',
  published_by: status === 'PUBLISHED' ? ME : null,
  published_at: status === 'PUBLISHED' ? '2026-11-03T01:00:00.000Z' : null,
  ...(sign === undefined ? {} : { sign_off: sign }),
});
const dashboardRow = (id: string, code: string, overrides: Record<string, unknown> = {}) => ({
  id,
  code,
  title: `Dashboard ${code}`,
  owner: { id: OTHER, name: 'Lan' },
  audience: 'TENANT_LIBRARY',
  status: 'PUBLISHED',
  current_version: { id: VD, revision: 2, status: 'DRAFT', metric_count: 1, metrics_certified: true },
  mine: false,
  may_edit: false,
  version: 3,
  ...overrides,
});
/** A dashboard whose published version (revision 1, signed) is not its current one: a later save made a draft (revision 2, only prepared). */
const detail = (overrides: Record<string, unknown> = {}) => ({
  ...dashboardRow(D1, 'D-ONE'),
  sign_off: signOff({ version_id: VD, revision: 2, checked_by: null, approved_by: null, state: 'PREPARED', complete: false }),
  versions: [
    version(VD, 2, 'DRAFT', [RATE.id], signOff({ version_id: VD, revision: 2, checked_by: null, approved_by: null, state: 'PREPARED', complete: false })),
    version(VP, 1, 'PUBLISHED', [DISBURSED.id, WITHDRAWN.id], signOff()),
  ],
  shares: [],
  ...overrides,
});

interface World {
  dashboards?: unknown[] | Error;
  one?: unknown;
  metrics?: unknown[];
  /** The versions of each dataset by its id; the first dataset has the frozen one when nothing is said. */
  versions?: Record<string, unknown[]>;
  datasets?: unknown[];
}

function client(world: World = {}) {
  const h = harness(
    (operation) => (operation === 'getDashboard' ? (world.one ?? detail()) : operation === 'explainBiMetric' ? answer : new Error(`unexpected read ${operation}`)),
    () => answer,
  );
  const readAll = vi.fn((operation: string, input?: unknown) => {
    const result =
      operation === 'get_resources_metric_definition'
        ? (world.metrics ?? [RATE, DISBURSED, WITHDRAWN])
        : operation === 'listBiDatasets'
          ? (world.datasets ?? [dataset])
          : operation === 'listBiDatasetVersions'
            ? ((world.versions ?? { [DATASET]: [frozen] })[(input as { path: { id: string } }).path.id] ?? [])
            : operation === 'listDashboards'
              ? (world.dashboards ?? [dashboardRow(D1, 'D-ONE'), dashboardRow(D2, 'D-DRAFT', { status: 'DRAFT' })])
              : new Error(`unexpected readAll ${operation}`);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

const tileIds = (): Array<string | null> => [...document.querySelectorAll('[data-testid="board"] .bi-tile[data-metric-id]')].map((tile) => tile.getAttribute('data-metric-id'));

describe('the model of the board tied to a dashboard (BC.02)', () => {
  const dash = (status: string, versions: unknown[] = []) => toDashboard({ ...dashboardRow(D1, 'D'), status, versions }) as NonNullable<ReturnType<typeof toDashboard>>;
  const metrics = [RATE, DISBURSED, WITHDRAWN].flatMap((raw) => toMetric(raw) ?? []);

  it('offers only the dashboards that have a published version', () => {
    const list = [dash('PUBLISHED'), dash('DRAFT'), dash('ARCHIVED')];
    expect(boardDashboards(list).map((one) => one.status)).toEqual(['PUBLISHED']);
  });

  it('takes the published version, the newest of them, and not the current one', () => {
    const read = dash('PUBLISHED', [version(VD, 3, 'DRAFT', []), version(VP, 2, 'PUBLISHED', []), version('00000000-0000-4000-8000-0000000000f9', 1, 'SUPERSEDED', []), version('00000000-0000-4000-8000-0000000000f8', 1, 'PUBLISHED', [])]);
    expect(publishedVersionOf(read)?.id).toBe(VP);
    expect(publishedVersionOf(dash('DRAFT', [version(VD, 1, 'DRAFT', [])]))).toBeUndefined();
  });

  it('keeps the certified metrics of a version in its own order, once, and leaves out the withdrawn and the unknown', () => {
    const one = toVersion(version(VP, 1, 'PUBLISHED', [DISBURSED.id, WITHDRAWN.id, '00000000-0000-4000-8000-0000000000ff', RATE.id, DISBURSED.id]));
    expect(boardMetricsOf(one as NonNullable<typeof one>, metrics).map((metric) => metric.code)).toEqual(['disbursed', 'disbursement_rate']);
  });

  it('names the datasets a board reads once each, the metric own first and the default for a metric that names none', () => {
    expect(datasetIdsOf([{ datasetId: 'x' }, { datasetId: null }, { datasetId: 'x' }, { datasetId: 'y' }], 'd')).toEqual(['x', 'd', 'y']);
    expect(datasetIdsOf([{ datasetId: null }], undefined)).toEqual([]);
  });

  it('reads a metric of a pinned version at the pinned version of its own dataset, frozen or superseded, and at nothing else', () => {
    const versions = [
      { id: 'a', datasetId: 'x', status: 'FROZEN' },
      { id: 'b', datasetId: 'x', status: 'SUPERSEDED' },
      { id: 'c', datasetId: 'y', status: 'FROZEN' },
      { id: 'd', datasetId: 'y', status: 'FAILED' },
    ];
    expect(pinnedSnapshotOf({ datasetId: 'x' }, 'dd', ['b', 'c'], versions)?.id).toBe('b');
    expect(pinnedSnapshotOf({ datasetId: 'y' }, 'dd', ['b', 'c'], versions)?.id).toBe('c');
    // A metric that names no dataset is read in the default one; a pinned version that failed, an unpinned one and a dataset that is not loaded give nothing.
    expect(pinnedSnapshotOf({ datasetId: null }, 'y', ['c'], versions)?.id).toBe('c');
    expect(pinnedSnapshotOf({ datasetId: 'y' }, 'dd', ['d'], versions)).toBeUndefined();
    expect(pinnedSnapshotOf({ datasetId: 'x' }, 'dd', [], versions)).toBeUndefined();
    expect(pinnedSnapshotOf({ datasetId: 'z' }, 'dd', ['a'], versions)).toBeUndefined();
  });
});

describe('BI-02 read as a published dashboard (BC.02)', () => {
  it('without a dashboard it is the board of every certified metric and says in words that it is not a signed report', async () => {
    mount(<BoardScreen route={BOARD} />, client(), { permissions: QUERIER });
    await waitFor(() => expect(tileIds()).toEqual([RATE.id, DISBURSED.id]));
    expect((screen.getByTestId('sign-unbound')).textContent).toBe(txt('bi.board.sign.unbound'));
    expect(screen.queryByTestId('sign-off')).toBeNull();
    const choice = screen.getByLabelText(txt('bi.board.dashboard')) as HTMLSelectElement;
    // The draft-only dashboard has no published version, so it is not offered.
    expect([...choice.options].map((option) => option.textContent)).toEqual([txt('bi.board.dashboard.none'), 'Dashboard D-ONE']);
  });

  it('a person who cannot read dashboards still has the board, without the choice', async () => {
    mount(<BoardScreen route={BOARD} />, client({ dashboards: failure(403, 'FORBIDDEN') }), { permissions: QUERIER });
    await waitFor(() => expect(tileIds()).toEqual([RATE.id, DISBURSED.id]));
    expect(screen.queryByLabelText(txt('bi.board.dashboard'))).toBeNull();
    expect(screen.getByTestId('sign-unbound')).toBeTruthy();
  });

  it('choosing a dashboard shows the certified metrics of its PUBLISHED version and the three signatures of that version, not those of the draft', async () => {
    const user = userEvent.setup();
    const h = client();
    mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER });
    await user.selectOptions(await screen.findByLabelText(txt('bi.board.dashboard')), D1);
    await waitFor(() => expect(tileIds()).toEqual([DISBURSED.id]));
    const block = await screen.findByTestId('sign-off');
    expect(block.getAttribute('data-state')).toBe('APPROVED');
    expect(within(block).getByTestId('sign-prepared').textContent).toBe(translator.t('bi.sign.line', { name: 'Lan', date: '2026-11-01' }));
    expect(within(block).getByTestId('sign-checked').textContent).toBe(translator.t('bi.sign.line', { name: 'Minh', date: '2026-11-02' }));
    // A name the directory does not have is the identifier, never an invented name.
    expect(within(block).getByTestId('sign-approved').textContent).toBe(translator.t('bi.sign.line', { name: ME, date: '2026-11-03' }));
    expect(within(block).getByTestId('sign-complete')).toBeTruthy();
    expect(screen.queryByTestId('sign-unbound')).toBeNull();
    expect(h.client.read).toHaveBeenCalledWith('getDashboard', { path: { id: D1 } });
    // Back to none: every certified metric again, and the words that it is not signed.
    await user.selectOptions(screen.getByLabelText(txt('bi.board.dashboard')), '');
    await waitFor(() => expect(tileIds()).toEqual([RATE.id, DISBURSED.id]));
    expect(screen.getByTestId('sign-unbound')).toBeTruthy();
  });

  it('the address names the dashboard, and every page of the presentation carries the same three signatures', async () => {
    const user = userEvent.setup();
    mount(<BoardScreen route={BOARD} />, client(), { permissions: QUERIER }, `${BOARD_PATH}?${BOARD_DASHBOARD_PARAM}=${D1}`);
    await waitFor(() => expect(tileIds()).toEqual([DISBURSED.id]));
    await user.click(screen.getByTestId('present-open'));
    const presentation = await screen.findByRole('dialog', { name: translator.t('bi.present.title.dashboard', { dashboard: 'Dashboard D-ONE', period: '2026-10' }) });
    const strip = within(presentation).getByTestId('sign-off');
    expect(within(strip).getByTestId('sign-prepared').textContent).toContain('Lan');
    expect(within(strip).getByTestId('sign-checked').textContent).toContain('Minh');
    expect(within(strip).getByTestId('sign-approved').textContent).toContain('2026-11-03');
    expect(within(presentation).queryByRole('heading', { level: 3 })).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a version that skipped the check is shown as not complete, with the empty step in words', async () => {
    const one = detail({ versions: [version(VP, 1, 'PUBLISHED', [DISBURSED.id], signOff({ checked_by: null, state: 'APPROVED', complete: false }))] });
    mount(<BoardScreen route={BOARD} />, client({ one }), { permissions: QUERIER }, `${BOARD_PATH}?${BOARD_DASHBOARD_PARAM}=${D1}`);
    const block = await screen.findByTestId('sign-off');
    expect(within(block).getByTestId('sign-checked').textContent).toBe(txt('bi.sign.none'));
    expect(within(block).getByTestId('sign-incomplete')).toBeTruthy();
  });

  it('the presentation of the board that is not tied to a dashboard says it is not signed on every page', async () => {
    const user = userEvent.setup();
    mount(<BoardScreen route={BOARD} />, client(), { permissions: QUERIER });
    await waitFor(() => expect(tileIds()).toEqual([RATE.id, DISBURSED.id]));
    await user.click(screen.getByTestId('present-open'));
    const presentation = await screen.findByRole('dialog', { name: translator.t('bi.present.title.text', { period: '2026-10' }) });
    expect(within(presentation).getByTestId('sign-unbound').textContent).toBe(txt('bi.board.sign.unbound'));
  });

  it('a dashboard with no published version, and one whose metrics are no longer certified, say so and keep the choice reachable', async () => {
    const draftOnly = detail({ status: 'DRAFT', versions: [version(VD, 1, 'DRAFT', [DISBURSED.id], signOff({ state: 'PREPARED', complete: false }))] });
    mount(<BoardScreen route={BOARD} />, client({ one: draftOnly }), { permissions: QUERIER }, `${BOARD_PATH}?${BOARD_DASHBOARD_PARAM}=${D1}`);
    expect((await screen.findByTestId('board-dashboard-empty')).textContent).toBe(txt('bi.board.dashboard.unpublished'));
    expect(screen.getByTestId('sign-none').textContent).toBe(txt('bi.sign.noVersion'));
    expect(tileIds()).toEqual([]);
    expect(screen.getByLabelText(txt('bi.board.dashboard'))).toBeTruthy();
    cleanup();
    const retired = detail({ versions: [version(VP, 1, 'PUBLISHED', [WITHDRAWN.id], signOff())] });
    mount(<BoardScreen route={BOARD} />, client({ one: retired }), { permissions: QUERIER }, `${BOARD_PATH}?${BOARD_DASHBOARD_PARAM}=${D1}`);
    expect((await screen.findByTestId('board-dashboard-empty')).textContent).toBe(txt('bi.board.dashboard.noMetrics'));
    expect(screen.getByTestId('present-open').hasAttribute('disabled')).toBe(true);
  });

  const queried = (h: { client: { command: unknown } }): string => JSON.stringify((h.client.command as ReturnType<typeof vi.fn>).mock.calls.filter(([operation]) => operation === 'post_dashboard_queries'));
  const pin = (ids: string[], metrics = [DISBURSED.id]) => ({ ...version(VP, 1, 'PUBLISHED', metrics, signOff()), dataset_version_policy: 'PINNED', pinned_dataset_version_ids: ids });

  it('a published version that pins its dataset versions is read at the pinned snapshot only, never at a newer one with the same signatures', async () => {
    const user = userEvent.setup();
    const NEWER = '00000000-0000-4000-8000-0000000000a2';
    const newer = { ...frozen, id: NEWER, as_of_period: '2026-11' };
    const h = client({ one: detail({ versions: [pin([SNAP])] }), versions: { [DATASET]: [newer, frozen] } });
    mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER }, `${BOARD_PATH}?${BOARD_DASHBOARD_PARAM}=${D1}`);
    await waitFor(() => expect(tileIds()).toEqual([DISBURSED.id]));
    expect(screen.getByTestId('board-pinned').textContent).toBe(txt('bi.board.dashboard.pinned'));
    // Nothing to choose: the period is the pinned one, and it is the one the context bar says.
    expect(screen.queryByLabelText(txt('bi.board.period'))).toBeNull();
    expect(within(screen.getByRole('group', { name: txt('ui.contextBar.label') })).getByText('2026-10')).toBeTruthy();
    await waitFor(() => expect(queried(h)).toContain(SNAP));
    expect(queried(h)).not.toContain(NEWER);
    // The same board with no dashboard is read at the newest frozen snapshot and says nothing of a pin.
    await user.selectOptions(screen.getByLabelText(txt('bi.board.dashboard')), '');
    await waitFor(() => expect(tileIds()).toEqual([RATE.id, DISBURSED.id]));
    expect(screen.queryByTestId('board-pinned')).toBeNull();
    expect([...(screen.getByLabelText(txt('bi.board.period')) as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(['2026-11', '2026-10']);
  });

  it('a pinned snapshot that a newer build has since superseded still gives the signed board its figures', async () => {
    const OLD = '00000000-0000-4000-8000-0000000000a3';
    const superseded = { ...frozen, id: OLD, as_of_period: '2026-09', status: 'SUPERSEDED' };
    const h = client({ one: detail({ versions: [pin([OLD])] }), versions: { [DATASET]: [frozen, superseded] } });
    mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER }, `${BOARD_PATH}?${BOARD_DASHBOARD_PARAM}=${D1}`);
    await waitFor(() => expect(tileIds()).toEqual([DISBURSED.id]));
    await waitFor(() => expect(queried(h)).toContain(OLD));
    expect(within(screen.getByRole('group', { name: txt('ui.contextBar.label') })).getByText('2026-09')).toBeTruthy();
  });

  const DATASET2 = '00000000-0000-4000-8000-0000000000d2';
  const CONTRACT_SNAP = '00000000-0000-4000-8000-0000000000a5';
  const contractMetric = rawMetric({ id: '00000000-0000-4000-8000-0000000000b4', code: 'contract_value', aggregation_type: 'additive', unit: 'VND', numerator_ast: null, denominator_ast: null, dataset_id: DATASET2 });
  const twoDatasets = (): World => ({
    one: detail({ versions: [pin([SNAP, CONTRACT_SNAP], [DISBURSED.id, contractMetric.id])] }),
    metrics: [RATE, DISBURSED, WITHDRAWN, contractMetric],
    datasets: [dataset, { ...dataset, id: DATASET2, dataset_code: 'DS-CTR', source_kind: 'REGISTER' }],
    versions: { [DATASET]: [frozen], [DATASET2]: [{ ...frozen, id: CONTRACT_SNAP, dataset_id: DATASET2, as_of_period: '2026-08' }] },
  });

  it('a pinned dashboard on another dataset than the disbursement one is read at the snapshot pinned in that dataset, each metric at its own', async () => {
    const h = client(twoDatasets());
    mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER }, `${BOARD_PATH}?${BOARD_DASHBOARD_PARAM}=${D1}`);
    await waitFor(() => expect(tileIds()).toEqual([DISBURSED.id, contractMetric.id]));
    await waitFor(() => expect(queried(h)).toContain(CONTRACT_SNAP));
    const calls = (h.client.command as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([operation]) => operation === 'post_dashboard_queries').map(([, input]) => (input as { body: { metric_version_id: string; snapshot_id: string } }).body);
    expect(calls.find((one) => one.metric_version_id === contractMetric.id)?.snapshot_id).toBe(CONTRACT_SNAP);
    expect(calls.find((one) => one.metric_version_id === DISBURSED.id)?.snapshot_id).toBe(SNAP);
    expect(within(screen.getByRole('group', { name: txt('ui.contextBar.label') })).getByText('2026-10, 2026-08')).toBeTruthy();
  });

  it('a pin that names no readable snapshot leaves the board with no period, said in words, and no figure', async () => {
    const h = client({ one: detail({ versions: [pin(['00000000-0000-4000-8000-0000000000a9'])] }) });
    mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER }, `${BOARD_PATH}?${BOARD_DASHBOARD_PARAM}=${D1}`);
    expect((await screen.findByTestId('board-no-period')).textContent).toBe(txt('bi.board.noPeriod'));
    expect(screen.getByTestId('board-pinned')).toBeTruthy();
    expect(queried(h)).toBe('[]');
  });

  it('a pinned board whose datasets cannot be read is an error state with a retry that reads them again', async () => {
    const h = client(twoDatasets());
    const original = (h.client as unknown as { readAll: (operation: string, input?: unknown) => Promise<unknown[]> }).readAll;
    let broken = true;
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string, input?: unknown) =>
      operation === 'listBiDatasetVersions' && broken && (input as { path: { id: string } }).path.id === DATASET2 ? Promise.reject(failure(500, 'INTERNAL')) : original(operation, input),
    );
    mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER }, `${BOARD_PATH}?${BOARD_DASHBOARD_PARAM}=${D1}`);
    expect(await screen.findByText(txt('states.error.title'))).toBeTruthy();
    broken = false;
    await userEvent.setup().click(screen.getByRole('button', { name: txt('states.retry.action') }));
    await waitFor(() => expect(tileIds()).toEqual([DISBURSED.id, contractMetric.id]));
  });

  it('a dashboard that cannot be read is an error state, with the choice left to go back', async () => {
    const h = client();
    (h.client as unknown as { read: unknown }).read = vi.fn((operation: string) => (operation === 'getDashboard' ? Promise.reject(failure(404, 'RESOURCE_NOT_FOUND')) : Promise.resolve(answer)));
    mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER }, `${BOARD_PATH}?${BOARD_DASHBOARD_PARAM}=${D1}`);
    expect(await screen.findByText(txt('states.error.title'))).toBeTruthy();
    expect(screen.getByLabelText(txt('bi.board.dashboard'))).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: txt('states.retry.action') }));
    await waitFor(() => expect((h.client.read as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([operation]) => operation === 'getDashboard').length).toBeGreaterThan(1));
  });
});

describe('BI-01 leads a published dashboard to its board', () => {
  it('offers the link for a published dashboard only', async () => {
    mount(<DashboardLibraryScreen route={LIBRARY} />, client(), { permissions: QUERIER });
    const cards = within(await screen.findByTestId('library')).getAllByRole('listitem');
    const published = cards.find((card) => card.getAttribute('data-dashboard') === D1) as HTMLElement;
    const draft = cards.find((card) => card.getAttribute('data-dashboard') === D2) as HTMLElement;
    expect(within(published).getByRole('link', { name: txt('bi.dash.library.board') }).getAttribute('href')).toBe(`${BOARD_PATH}?${BOARD_DASHBOARD_PARAM}=${D1}`);
    expect(within(draft).queryByRole('link', { name: txt('bi.dash.library.board') })).toBeNull();
  });
});

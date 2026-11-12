import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import part from '../../i18n/parts/aud3.vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import ChartBuilderScreen from './ChartBuilderScreen';
import { ChartView, pointsOf } from './ChartView';
import DashboardBuilderScreen from './DashboardBuilderScreen';
import DashboardLibraryScreen from './DashboardLibraryScreen';
import { EMPTY_CREATE, EMPTY_VERSION, describeDashboardProblem, formFrom, hasVersionProblems, toDashboard, toVersion, validateCreate, validateVersion, versionBody, widgetOfChart } from './dashboard-model';
import type { VersionForm, WidgetForm } from './dashboard-model';
import { toQueryResult } from './query-model';
import { rawMetric } from './test-support';

const LIBRARY = routeOf('BI-01', 'FR-BI-01');
const BUILDER = routeOf('BI-03', 'FR-BI-03');
const CHART = routeOf('BI-04', 'FR-BI-04');
const VIEW = ['bi.query', 'dashboard_version.read', 'metric_definition.read'];
const MAKE = [...VIEW, 'bi.dashboard.manage'];
const ME = '00000000-0000-4000-8000-000000000001'; // the member of the session of the test support
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const D1 = '00000000-0000-4000-8000-0000000000e1';
const D2 = '00000000-0000-4000-8000-0000000000e2';
const V1 = '00000000-0000-4000-8000-0000000000f1';
const V2 = '00000000-0000-4000-8000-0000000000f2';
const DATASET = '00000000-0000-4000-8000-0000000000d1';
const SNAP = '00000000-0000-4000-8000-0000000000a1';
const SNAP2 = '00000000-0000-4000-8000-0000000000a2';
const failure = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const RATE = rawMetric({ id: '00000000-0000-4000-8000-0000000000b1', code: 'disbursement_rate', aggregation_type: 'ratio', unit: 'percent' });
const DISBURSED = rawMetric({ id: '00000000-0000-4000-8000-0000000000b2', code: 'disbursed', aggregation_type: 'additive', unit: 'VND', numerator_ast: null, denominator_ast: null });
const DRAFT = rawMetric({ id: '00000000-0000-4000-8000-0000000000b3', code: 't_draft', status: 'DRAFT', origin: 'TENANT_UI' });

const dataset = { id: DATASET, dataset_code: 'DS-DISB', title: 'DISB', source_kind: 'PERIOD_SNAPSHOT', grain: 'project', join_paths: {}, refresh_policy: 'ON_SNAPSHOT_FROZEN', status: 'ACTIVE', latest_version: null };
const datasetVersion = (id: string, status = 'FROZEN', period = '2026-10') => ({ id, dataset_id: DATASET, as_of_period: period, source_snapshot_id: null, built_at: '2026-11-01T01:00:00.000Z', row_count: 3, excluded_quarantine_rows: 0, quality_badge: 'PASSED', feeds_certified: true, status });

const widget = (id: string, metric: string, overrides: Record<string, unknown> = {}) => ({ id, kind: 'BAR', metric_version_id: metric, dimension_code: 'unit', grid: { x: 0, y: 0, w: 6, h: 4 }, ...overrides });
const version = (id: string, revision: number, overrides: Record<string, unknown> = {}) => ({
  id,
  dashboard_id: D1,
  revision,
  layout_json: { columns: 12, widgets: [widget('w1', RATE.id, { title: 'Giải ngân' })] },
  metric_versions: [RATE.id],
  filter_mappings: { period: 'bucket' },
  breakpoints: { sm: 640, md: 1024 },
  dataset_version_policy: 'LATEST_FROZEN',
  pinned_dataset_version_ids: [],
  status: 'DRAFT',
  created_by: ME,
  created_at: '2026-11-01T01:00:00.000Z',
  published_by: null,
  published_at: null,
  ...overrides,
});
const dashboard = (id: string, code: string, overrides: Record<string, unknown> = {}) => ({
  id,
  code,
  title: `Dashboard ${code}`,
  owner: { id: ME, name: 'Người dùng' },
  audience: 'PRIVATE',
  status: 'DRAFT',
  current_version: { id: V1, revision: 1, status: 'DRAFT', metric_count: 1, metrics_certified: true },
  mine: true,
  may_edit: true,
  version: 2,
  ...overrides,
});

interface World {
  dashboards: unknown[] | Error;
  one?: Record<string, unknown> | Error;
  metrics?: unknown[] | Error;
  datasets?: unknown[] | Error;
  versions?: unknown[] | Error;
}

function client(world: World, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 3, resource_id: D1, revision: 2 })) {
  const h = harness((operation) => {
    if (operation === 'getDashboard') return world.one ?? new Error('unexpected read');
    return new Error(`unexpected read ${operation}`);
  }, command);
  const readAll = vi.fn((operation: string) => {
    const result =
      operation === 'listDashboards' ? world.dashboards : operation === 'get_resources_metric_definition' ? (world.metrics ?? [RATE, DISBURSED, DRAFT]) : operation === 'listBiDatasets' ? (world.datasets ?? [dataset]) : operation === 'listBiDatasetVersions' ? (world.versions ?? [datasetVersion(SNAP), datasetVersion(SNAP2, 'BUILDING', '2026-11')]) : new Error(`unexpected readAll ${operation}`);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

describe('BI-01 library of dashboards (ST-BI-005)', () => {
  it('shows the dashboards of the caller with their owner, state and the version they point to, with whether its metrics are still certified', async () => {
    const h = client({
      dashboards: [
        dashboard(D1, 'D-ONE'),
        dashboard(D2, 'D-TWO', { mine: false, may_edit: false, owner: { id: OTHER, name: 'Người khác' }, audience: 'TENANT_LIBRARY', status: 'PUBLISHED', current_version: { id: V2, revision: 3, status: 'PUBLISHED', metric_count: 4, metrics_certified: false } }),
        dashboard('00000000-0000-4000-8000-0000000000e3', 'D-NEW', { current_version: null, owner: { id: OTHER, name: null }, mine: false }),
      ],
    });
    mount(<DashboardLibraryScreen route={LIBRARY} />, h, { permissions: MAKE });
    const cards = within(await screen.findByTestId('library')).getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bi.dash.library.title']);
    expect(within(cards[0] as HTMLElement).getByTestId('owner').textContent).toBe(vi_['bi.dash.library.mine']);
    expect(within(cards[0] as HTMLElement).getByTestId('current-version').textContent).toContain(fill(vi_['bi.dash.library.version'], { revision: 1, state: vi_['bi.dash.version.draft'], count: 1 }));
    expect(within(cards[0] as HTMLElement).getByTestId('certified')).toBeTruthy();
    expect(within(cards[0] as HTMLElement).getByRole('link', { name: vi_['bi.dash.library.edit'] }).getAttribute('href')).toBe(`/bi/bi-03?dashboard=${D1}`);
    expect(within(cards[1] as HTMLElement).getByTestId('owner').textContent).toBe(fill(vi_['bi.dash.library.owner'], { name: 'Người khác' }));
    expect(within(cards[1] as HTMLElement).getByTestId('not-certified').textContent).toBe(vi_['bi.dash.library.notCertified']);
    expect(within(cards[1] as HTMLElement).getByText(vi_['bi.dash.audience.library'])).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByRole('link', { name: vi_['bi.dash.library.view'] })).toBeTruthy();
    expect(within(cards[2] as HTMLElement).getByTestId('no-version').textContent).toBe(vi_['bi.dash.library.noVersion']);
    expect(within(cards[2] as HTMLElement).getByTestId('owner').textContent).toBe(fill(vi_['bi.dash.library.owner'], { name: OTHER }));
    expect(screen.getByRole('form', { name: vi_['bi.dash.create.title'] })).toBeTruthy();
  });

  it('makes a dashboard after the checks of the contract, and leads to the builder', async () => {
    const h = client({ dashboards: [] }, () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: D1, code: 'D-NEW' }));
    mount(<DashboardLibraryScreen route={LIBRARY} />, h, { permissions: MAKE });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.dash.create.title'] });
    await user.click(within(form).getByRole('button', { name: vi_['bi.dash.create.submit'] }));
    expect(await within(form).findByText(vi_['bi.dash.create.code.required'])).toBeTruthy();
    expect(within(form).getByText(vi_['bi.dash.create.title.required'])).toBeTruthy();
    await user.type(within(form).getByLabelText(vi_['bi.dash.create.code.label']), '-bad code');
    await user.type(within(form).getByLabelText(vi_['bi.dash.create.title.label']), 'x');
    await user.click(within(form).getByRole('button', { name: vi_['bi.dash.create.submit'] }));
    expect(await within(form).findByText(vi_['bi.dash.create.code.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.clear(within(form).getByLabelText(vi_['bi.dash.create.code.label']));
    await user.type(within(form).getByLabelText(vi_['bi.dash.create.code.label']), '  D-NEW ');
    await user.clear(within(form).getByLabelText(vi_['bi.dash.create.title.label']));
    await user.type(within(form).getByLabelText(vi_['bi.dash.create.title.label']), ' Giải ngân ');
    await user.click(within(form).getByRole('button', { name: vi_['bi.dash.create.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['createDashboard', { body: { code: 'D-NEW', title: 'Giải ngân' } }]);
    const saved = await screen.findByTestId('saved');
    expect(within(saved).getByRole('link', { name: vi_['bi.dash.create.open'] }).getAttribute('href')).toBe(`/bi/bi-03?dashboard=${D1}`);
    expect((within(form).getByLabelText(vi_['bi.dash.create.code.label']) as HTMLInputElement).value).toBe('');
  });

  it.each([
    ['DASHBOARD_CODE_DUPLICATE', 409, 'bi.dash.refusal.duplicate'],
    ['VALIDATION_FAILED', 422, 'bi.dash.refusal.invalid'],
    ['SCOPE_DENIED', 403, 'bi.dash.refusal.scope'],
    ['OTHER', 500, 'bi.dash.refusal.general'],
  ] as const)('says in words what the server refused: %s', async (code, status, key) => {
    const h = client({ dashboards: [] }, () => failure(status, code));
    mount(<DashboardLibraryScreen route={LIBRARY} />, h, { permissions: MAKE });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.dash.create.title'] });
    await user.type(within(form).getByLabelText(vi_['bi.dash.create.code.label']), 'D-NEW');
    await user.type(within(form).getByLabelText(vi_['bi.dash.create.title.label']), 'Giải ngân');
    await user.click(within(form).getByRole('button', { name: vi_['bi.dash.create.submit'] }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(vi_[key]);
  });

  it('shows the standard states, and takes no step while the session is read-only', async () => {
    const pending = client({ dashboards: [] });
    (pending.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
    mount(<DashboardLibraryScreen route={LIBRARY} />, pending, { permissions: MAKE });
    expect((await screen.findByRole('status', { name: vi_['states.loading.label'] })).getAttribute('aria-busy')).toBe('true');
    cleanup();
    mount(<DashboardLibraryScreen route={LIBRARY} />, client({ dashboards: [] }), { permissions: MAKE });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    for (const [error, title] of [
      [new Error('boom'), 'states.error.title'],
      [failure(403, 'SCOPE_DENIED'), 'states.denied.title'],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), 'states.offline.title'],
      [failure(401, 'SESSION_EXPIRED'), 'states.signedOut.title'],
    ] as const) {
      const h = client({ dashboards: error });
      mount(<DashboardLibraryScreen route={LIBRARY} />, h, { permissions: MAKE });
      expect(await screen.findByText(vi_[title])).toBeTruthy();
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      await waitFor(() => expect(h.readAll).toHaveBeenCalledTimes(2));
      cleanup();
    }
    mount(<DashboardLibraryScreen route={LIBRARY} />, client({ dashboards: [dashboard(D1, 'D-ONE')] }), { permissions: MAKE, mode: 'READ_ONLY' });
    await screen.findByTestId('library');
    expect(screen.queryByRole('form', { name: vi_['bi.dash.create.title'] })).toBeNull();
  });
});

describe('BI-03 builder of a dashboard (ST-BI-005)', () => {
  const open = (world: Partial<World> = {}, command?: (operation: string, input: unknown) => unknown, permissions = MAKE, path = `/bi/bi-03?dashboard=${D1}`) => {
    const h = client(
      {
        dashboards: [dashboard(D1, 'D-ONE')],
        one: { ...dashboard(D1, 'D-ONE'), versions: [version(V2, 2, { layout_json: { columns: 12, widgets: [widget('w1', RATE.id, { title: 'Giải ngân' }), widget('w2', DISBURSED.id, { kind: 'KPI', dimension_code: undefined, grid: { x: 6, y: 0, w: 6, h: 2 } })] }, metric_versions: [RATE.id, DISBURSED.id] }), version(V1, 1)] },
        ...world,
      },
      command,
    );
    mount(<DashboardBuilderScreen route={BUILDER} />, h, { permissions }, path);
    return h;
  };

  it('shows the three signatures of the version the dashboard points to, and the furthest step of each version (BC.02)', async () => {
    const block = (state: string, complete: boolean) => ({
      version_id: V2,
      revision: 2,
      prepared_by: { id: ME, name: 'Lan', at: '2026-11-01T01:00:00.000Z' },
      checked_by: state === 'PREPARED' ? null : { id: OTHER, name: 'Minh', at: '2026-11-02T01:00:00.000Z' },
      approved_by: state === 'APPROVED' ? { id: OTHER, name: null, at: '2026-11-03T01:00:00.000Z' } : null,
      state,
      complete,
    });
    open({
      one: {
        ...dashboard(D1, 'D-ONE'),
        sign_off: block('CHECKED', false),
        versions: [version(V2, 2, { sign_off: block('CHECKED', false) }), version(V1, 1, { sign_off: block('APPROVED', true) })],
      },
    });
    const signed = await screen.findByTestId('sign-off');
    expect(within(signed).getByTestId('sign-prepared').textContent).toContain('Lan');
    expect(within(signed).getByTestId('sign-checked').textContent).toContain('Minh');
    expect(within(signed).getByTestId('sign-approved').textContent).toContain(part['bi.sign.none']);
    expect(within(signed).getByTestId('sign-incomplete')).toBeTruthy();
    expect(screen.getAllByTestId('version-sign').map((cell) => cell.textContent)).toEqual([part['bi.sign.state.CHECKED'], part['bi.sign.state.APPROVED']]);
  });

  it('says a dashboard that gave no signatures is not signed, and has nobody made up', async () => {
    open();
    await screen.findByTestId('versions');
    expect(screen.getAllByTestId('version-sign').map((cell) => cell.textContent)).toEqual([part['bi.sign.state.UNSIGNED'], part['bi.sign.state.UNSIGNED']]);
    expect(screen.getByTestId('sign-none').textContent).toBe(part['bi.sign.noVersion']);
  });

  it('puts the versions, the preview and the form in section cards, each with its title as a level 2 heading', async () => {
    open();
    await screen.findByTestId('versions');
    const titles = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(titles).toEqual(expect.arrayContaining([vi_['bi.dash.builder.versions'], vi_['bi.dash.builder.preview'], vi_['bi.dash.builder.form']]));
    expect(screen.getByRole('form', { name: vi_['bi.dash.builder.form'] })).toBeTruthy();
  });

  it('opens the dashboard of the address with its versions and a form that starts from the latest, and previews the layout with a table of the tiles', async () => {
    open();
    const versions = within(await screen.findByTestId('versions')).getAllByRole('row').slice(1);
    expect(versions.map((row) => row.getAttribute('data-version'))).toEqual([V2, V1]);
    expect(versions[0]?.textContent).toContain(vi_['bi.dash.policy.latest']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bi.dash.builder.title']);
    const preview = screen.getByTestId('preview');
    expect([...preview.querySelectorAll('[data-widget]')].map((tile) => tile.getAttribute('data-widget'))).toEqual(['w1', 'w2']);
    expect(preview.querySelector('[data-widget="w1"]')?.textContent).toContain('Giải ngân');
    expect(preview.querySelector('[data-widget="w2"]')?.textContent).toContain('disbursed');
    const rows = within(screen.getByTestId('preview-table')).getAllByRole('row').slice(1);
    expect(rows[1]?.textContent).toContain(fill(vi_['bi.dash.col.placeValue'], { x: 6, y: 0, w: 6, h: 2 }));
    const form = screen.getByRole('form', { name: vi_['bi.dash.builder.form'] });
    expect(within(form).getAllByRole('group', { name: /Ô \d/ })).toHaveLength(2);
    expect((within(form).getByLabelText(fill(vi_['bi.dash.breakpoint.label'], { key: 'sm' })) as HTMLInputElement).value).toBe('640');
    expect((within(form).getByLabelText(vi_['bi.dash.filter.name']) as HTMLInputElement).value).toBe('period');
  });

  it('offers the certified metrics, judges the version before it sends and saves it whole under the version of the dashboard it read', async () => {
    const h = open({}, () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 3, resource_id: D1, revision: 3 }));
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.dash.builder.form'] });
    const metricOptions = [...(within(form).getAllByLabelText(vi_['bi.dash.tile.metric'])[0] as HTMLSelectElement).options].map((option) => option.textContent);
    expect(metricOptions).toEqual([fill(vi_['bi.dash.tile.metricOption'], { code: 'disbursement_rate', revision: 1 }), fill(vi_['bi.dash.tile.metricOption'], { code: 'disbursed', revision: 1 })]);
    // Overlapping tiles, a breakpoint out of range and a pinned policy without a version are refused before anything is sent.
    await user.clear(within(form).getAllByLabelText(fill(vi_['bi.dash.tile.side'], { side: vi_['bi.dash.side.x'] }))[1] as HTMLElement);
    await user.type(within(form).getAllByLabelText(fill(vi_['bi.dash.tile.side'], { side: vi_['bi.dash.side.x'] }))[1] as HTMLElement, '3');
    await user.type(within(form).getByLabelText(fill(vi_['bi.dash.breakpoint.label'], { key: 'lg' })), '100');
    await user.selectOptions(within(form).getByLabelText(vi_['bi.dash.policy.label']), 'PINNED');
    await user.click(within(form).getByRole('button', { name: vi_['bi.dash.builder.submit'] }));
    expect((await within(form).findAllByText(vi_['bi.dash.problem.overlap'])).length).toBe(2);
    expect(within(form).getByText(vi_['bi.dash.problem.breakpoint'])).toBeTruthy();
    expect(within(form).getByText(vi_['bi.dash.problem.pinned'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    // Put right: the tile moves to column 6, the breakpoint is cleared, and the policy goes back to the latest frozen version.
    await user.clear(within(form).getAllByLabelText(fill(vi_['bi.dash.tile.side'], { side: vi_['bi.dash.side.x'] }))[1] as HTMLElement);
    await user.type(within(form).getAllByLabelText(fill(vi_['bi.dash.tile.side'], { side: vi_['bi.dash.side.x'] }))[1] as HTMLElement, '6');
    await user.clear(within(form).getByLabelText(fill(vi_['bi.dash.breakpoint.label'], { key: 'lg' })));
    await user.selectOptions(within(form).getByLabelText(vi_['bi.dash.policy.label']), 'LATEST_FROZEN');
    await user.click(within(form).getByRole('button', { name: vi_['bi.dash.builder.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('saveDashboardVersion');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({
      path: { id: D1 },
      ifMatchVersion: 2,
      body: {
        layout_json: { columns: 12, widgets: [{ id: 'w1', kind: 'BAR', title: 'Giải ngân', metric_version_id: RATE.id, dimension_code: 'unit', grid: { x: 0, y: 0, w: 6, h: 4 } }, { id: 'w2', kind: 'KPI', metric_version_id: DISBURSED.id, grid: { x: 6, y: 0, w: 6, h: 2 } }] },
        breakpoints: { sm: 640, md: 1024 },
        metric_versions: [RATE.id, DISBURSED.id],
        filter_mappings: { period: 'bucket' },
        dataset_version_policy: 'LATEST_FROZEN',
      },
    });
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).not.toHaveProperty('pinned_dataset_version_ids');
    expect((await screen.findByTestId('saved')).textContent).toBe(fill(vi_['bi.dash.builder.saved'], { revision: 3 }));
  });

  it('edits the tiles and the filters: adds a tile over the first certified metric, removes one, and pins the frozen versions of a dataset', async () => {
    const h = open({}, () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 3, resource_id: D1, revision: 3 }));
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.dash.builder.form'] });
    await user.click(within(form).getByRole('button', { name: vi_['bi.dash.tile.add'] }));
    const groups = within(form).getAllByRole('group', { name: /Ô \d/ });
    expect(groups).toHaveLength(3);
    // The new tile goes under the others.
    expect((within(groups[2] as HTMLElement).getAllByLabelText(fill(vi_['bi.dash.tile.side'], { side: vi_['bi.dash.side.y'] }))[0] as HTMLInputElement).value).toBe('4');
    await user.click(within(groups[2] as HTMLElement).getByRole('button', { name: vi_['bi.dash.tile.remove'] }));
    expect(within(form).getAllByRole('group', { name: /Ô \d/ })).toHaveLength(2);
    await user.click(within(form).getByRole('button', { name: vi_['bi.dash.filter.add'] }));
    await user.click(within(form).getByRole('button', { name: vi_['bi.dash.builder.submit'] }));
    expect(await within(form).findByText(vi_['bi.dash.problem.filter'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    const names = within(form).getAllByLabelText(vi_['bi.dash.filter.name']);
    await user.type(names[1] as HTMLElement, 'period');
    await user.type(within(form).getAllByLabelText(vi_['bi.dash.filter.dimension'])[1] as HTMLElement, 'bucket');
    await user.click(within(form).getByRole('button', { name: vi_['bi.dash.builder.submit'] }));
    expect(await within(form).findByText(vi_['bi.dash.problem.filterTaken'])).toBeTruthy();
    await user.click(within(form).getAllByRole('button', { name: vi_['bi.dash.filter.remove'] })[1] as HTMLElement);
    // Pinned versions: only the frozen ones of the dataset are offered.
    await user.selectOptions(within(form).getByLabelText(vi_['bi.dash.policy.label']), 'PINNED');
    await user.selectOptions(await within(form).findByLabelText(vi_['bi.dash.pin.dataset']), DATASET);
    const options = await within(form).findByTestId('pin-options');
    await waitFor(() => expect(within(options).getAllByRole('checkbox')).toHaveLength(1));
    await user.click(within(options).getByRole('checkbox', { name: fill(vi_['bi.dash.pin.option'], { period: '2026-10' }) }));
    expect(within(form).getByTestId('pinned-count').textContent).toBe(fill(vi_['bi.dash.pin.count'], { count: 1 }));
    await user.click(within(form).getByRole('button', { name: vi_['bi.dash.builder.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { dataset_version_policy: 'PINNED', pinned_dataset_version_ids: [SNAP] } });
    // Un-pinning the last version is a policy the form refuses.
    await user.click(within(options).getByRole('checkbox', { name: fill(vi_['bi.dash.pin.option'], { period: '2026-10' }) }));
    expect(within(form).getByTestId('pinned-count').textContent).toBe(fill(vi_['bi.dash.pin.count'], { count: 0 }));
  });

  it('starts from the version chosen, and takes the tile the chart builder handed over', async () => {
    open({}, undefined, MAKE, `/bi/bi-03?dashboard=${D1}&metric=${DISBURSED.id}&kind=PIE&dimension=fund_source`);
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.dash.builder.form'] });
    // Two tiles of the latest version and the one handed over, under them, over the whole width.
    const groups = within(form).getAllByRole('group', { name: /Ô \d/ });
    expect(groups).toHaveLength(3);
    expect((within(groups[2] as HTMLElement).getByLabelText(vi_['bi.dash.tile.dimension']) as HTMLInputElement).value).toBe('fund_source');
    expect((within(groups[2] as HTMLElement).getByLabelText(vi_['bi.dash.tile.kind']) as HTMLSelectElement).value).toBe('PIE');
    expect((within(groups[2] as HTMLElement).getAllByLabelText(fill(vi_['bi.dash.tile.side'], { side: vi_['bi.dash.side.w'] }))[0] as HTMLInputElement).value).toBe('12');
    await user.selectOptions(within(form).getByLabelText(vi_['bi.dash.builder.start']), V1);
    expect(within(form).getAllByRole('group', { name: /Ô \d/ })).toHaveLength(1);
    const only = within(form).getByRole('group', { name: /Ô [0-9]/ });
    await user.selectOptions(within(only).getByLabelText(vi_['bi.dash.tile.kind']), 'KPI');
    expect((within(only).getByLabelText(vi_['bi.dash.tile.dimension']) as HTMLInputElement).disabled).toBe(true);
    expect((within(only).getByLabelText(vi_['bi.dash.tile.dimension']) as HTMLInputElement).value).toBe('');
  });

  it('keeps what was typed when another person saved and the dashboard is read again, judges the save against the version it started from, and starts over only on request', async () => {
    const h = open({}, () => failure(409, 'VERSION_CONFLICT'));
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.dash.builder.form'] });
    const title = within(form).getAllByLabelText(vi_['bi.dash.tile.title'])[0] as HTMLInputElement;
    await user.clear(title);
    await user.type(title, 'Đang sửa dở');
    await user.click(within(form).getByRole('button', { name: vi_['bi.dash.builder.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 2 });
    const refusal = await screen.findByTestId('refusal');
    expect(refusal.textContent).toContain(vi_['bi.dash.refusal.conflict']);
    // The dashboard was read again after the refusal; the form is the same one, with the same words.
    await waitFor(() => expect(h.client.read).toHaveBeenCalledTimes(2));
    expect((within(screen.getByRole('form', { name: vi_['bi.dash.builder.form'] })).getAllByLabelText(vi_['bi.dash.tile.title'])[0] as HTMLInputElement).value).toBe('Đang sửa dở');
    await user.click(within(refusal).getByRole('button', { name: vi_['bi.dash.builder.reload'] }));
    await waitFor(() => expect((within(screen.getByRole('form', { name: vi_['bi.dash.builder.form'] })).getAllByLabelText(vi_['bi.dash.tile.title'])[0] as HTMLInputElement).value).toBe('Giải ngân'));
    expect(screen.queryByTestId('refusal')).toBeNull();
  });

  it('keeps the tile of the chart builder for a dashboard it can be saved in: a dashboard that is only seen, or whose catalogue of metrics failed, does not take it', async () => {
    const address = `/bi/bi-03?dashboard=${D2}&metric=${DISBURSED.id}&kind=PIE&dimension=unit`;
    const viewed = { ...dashboard(D2, 'D-TWO', { mine: false, may_edit: false }), versions: [version(V2, 1)] };
    const h = client({ dashboards: [dashboard(D1, 'D-ONE'), dashboard(D2, 'D-TWO', { mine: false, may_edit: false })], one: viewed });
    mount(<DashboardBuilderScreen route={BUILDER} />, h, { permissions: MAKE }, address);
    const user = userEvent.setup();
    expect(await screen.findByTestId('read-only')).toBeTruthy();
    expect(screen.getByTestId('preview').querySelectorAll('[data-widget]')).toHaveLength(1);
    // Another dashboard, one that can be saved, takes it.
    (h.client.read as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve({ ...dashboard(D1, 'D-ONE'), versions: [version(V1, 1)] }));
    await user.selectOptions(screen.getByLabelText(vi_['bi.dash.builder.pick']), D1);
    const form = await screen.findByRole('form', { name: vi_['bi.dash.builder.form'] });
    expect(within(form).getAllByRole('group', { name: /Ô [0-9]/ })).toHaveLength(2);
    cleanup();
    const failed = client({ dashboards: [dashboard(D1, 'D-ONE')], one: { ...dashboard(D1, 'D-ONE'), versions: [version(V1, 1)] }, metrics: new Error('boom') });
    mount(<DashboardBuilderScreen route={BUILDER} />, failed, { permissions: MAKE }, `/bi/bi-03?dashboard=${D1}&metric=${DISBURSED.id}&kind=PIE&dimension=unit`);
    expect(await screen.findByTestId('metrics-failed')).toBeTruthy();
    expect(screen.getByTestId('preview').querySelectorAll('[data-widget]')).toHaveLength(1);
  });

  it('adds the tile of the chart builder once: a save and a new read do not add it again, and each save is judged against the version the last one made', async () => {
    const h = open({}, (_operation, input) => ({ operation_id: 'o', status: 'DRAFT', resource_version: (input as { ifMatchVersion: number }).ifMatchVersion + 1, resource_id: D1, revision: 3 }), MAKE, `/bi/bi-03?dashboard=${D1}&metric=${DISBURSED.id}&kind=PIE&dimension=fund_source`);
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.dash.builder.form'] });
    expect(within(form).getAllByRole('group', { name: /Ô [0-9]/ })).toHaveLength(3);
    await user.click(within(form).getByRole('button', { name: vi_['bi.dash.builder.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    await screen.findByTestId('saved');
    await waitFor(() => expect(h.client.read).toHaveBeenCalledTimes(2));
    expect(within(screen.getByRole('form', { name: vi_['bi.dash.builder.form'] })).getAllByRole('group', { name: /Ô [0-9]/ })).toHaveLength(3);
    await user.click(within(screen.getByRole('form', { name: vi_['bi.dash.builder.form'] })).getByRole('button', { name: vi_['bi.dash.builder.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    const widgetsOf = (call: number) => ((h.command.mock.calls[call]?.[1] as { body: { layout_json: { widgets: unknown[] } } }).body.layout_json.widgets);
    expect(widgetsOf(0)).toHaveLength(3);
    expect(widgetsOf(1)).toHaveLength(3);
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 2 });
    expect(h.command.mock.calls[1]?.[1]).toMatchObject({ ifMatchVersion: 3 });
  });

  it('only shows a dashboard the caller may not change, an archived one, and one in a read-only session', async () => {
    open({ one: { ...dashboard(D1, 'D-ONE', { mine: false, may_edit: false }), versions: [version(V1, 1)] } });
    expect((await screen.findByTestId('read-only')).textContent).toBe(vi_['bi.dash.builder.readOnly']);
    expect(screen.queryByRole('form', { name: vi_['bi.dash.builder.form'] })).toBeNull();
    cleanup();
    open({ one: { ...dashboard(D1, 'D-ONE', { status: 'ARCHIVED' }), versions: [version(V1, 1)] } });
    expect(await screen.findByTestId('read-only')).toBeTruthy();
    cleanup();
    const frozen = client({ dashboards: [dashboard(D1, 'D-ONE')], one: { ...dashboard(D1, 'D-ONE'), versions: [] } });
    mount(<DashboardBuilderScreen route={BUILDER} />, frozen, { permissions: MAKE, mode: 'READ_ONLY' }, `/bi/bi-03?dashboard=${D1}`);
    expect(await screen.findByTestId('no-versions')).toBeTruthy();
    expect(screen.queryByRole('form', { name: vi_['bi.dash.builder.form'] })).toBeNull();
  });

  it.each([
    ['METRIC_NOT_CERTIFIED', 422, 'bi.dash.refusal.notCertified'],
    ['DATASET_VERSION_NOT_FROZEN', 422, 'bi.dash.refusal.notFrozen'],
    ['VERSION_CONFLICT', 409, 'bi.dash.refusal.conflict'],
    ['STAGE_TRANSITION_DENIED', 409, 'bi.dash.refusal.archived'],
    ['VALIDATION_FAILED', 422, 'bi.dash.refusal.invalid'],
    ['SCOPE_DENIED', 403, 'bi.dash.refusal.scope'],
    ['RESOURCE_NOT_FOUND', 404, 'bi.dash.refusal.notFound'],
    ['OTHER', 500, 'bi.dash.refusal.general'],
  ] as const)('says in words what the server refused: %s', async (code, status, key) => {
    const h = open({}, () => failure(status, code));
    const form = await screen.findByRole('form', { name: vi_['bi.dash.builder.form'] });
    await userEvent.setup().click(within(form).getByRole('button', { name: vi_['bi.dash.builder.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    // A conflict also offers to load the latest.
    expect((await screen.findByTestId('refusal')).textContent).toContain(vi_[key]);
  });

  it('picks another dashboard from the list, keeps what the chart builder handed over, and says when the one asked for is not found', async () => {
    const h = open({ dashboards: [dashboard(D1, 'D-ONE'), dashboard(D2, 'D-TWO')] }, undefined, MAKE, `/bi/bi-03?metric=${RATE.id}&kind=BAR`);
    const user = userEvent.setup();
    expect(await screen.findByLabelText(vi_['bi.dash.builder.pick'])).toBeTruthy();
    expect(screen.queryByTestId('editor')).toBeNull();
    await user.selectOptions(screen.getByLabelText(vi_['bi.dash.builder.pick']), D1);
    const form = await screen.findByRole('form', { name: vi_['bi.dash.builder.form'] });
    // The metric of the chart is a tile of the version that is open: two tiles of the latest version and this one.
    expect(within(form).getAllByRole('group', { name: /Ô \d/ })).toHaveLength(3);
    await user.selectOptions(screen.getByLabelText(vi_['bi.dash.builder.pick']), '');
    await waitFor(() => expect(screen.queryByTestId('editor')).toBeNull());
    cleanup();
    const missing = client({ dashboards: [dashboard(D1, 'D-ONE')], one: failure(404, 'RESOURCE_NOT_FOUND') });
    mount(<DashboardBuilderScreen route={BUILDER} />, missing, { permissions: MAKE }, `/bi/bi-03?dashboard=${D2}`);
    expect((await screen.findByTestId('not-found')).textContent).toBe(vi_['bi.dash.refusal.notFound']);
    expect(h.readAll).toHaveBeenCalled();
  });

  it('shows the standard states, and a retry reads the metrics again too', async () => {
    const pending = client({ dashboards: [] });
    (pending.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
    mount(<DashboardBuilderScreen route={BUILDER} />, pending, { permissions: MAKE });
    expect((await screen.findByRole('status', { name: vi_['states.loading.label'] })).getAttribute('aria-busy')).toBe('true');
    cleanup();
    const h = client({ dashboards: new Error('boom') });
    mount(<DashboardBuilderScreen route={BUILDER} />, h, { permissions: MAKE });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    cleanup();
  });

  it('leads to the comparison of the versions only when there are two to compare', async () => {
    open();
    expect((await screen.findByRole('link', { name: vi_['bi.dash.builder.compare'] })).getAttribute('href')).toBe(`/bi/bi-10?dashboard=${D1}`);
    cleanup();
    open({ one: { ...dashboard(D1, 'D-ONE'), versions: [version(V1, 1)] } });
    await screen.findByTestId('versions');
    expect(screen.queryByRole('link', { name: vi_['bi.dash.builder.compare'] })).toBeNull();
  });

  it('gives the owner who no longer holds the right to make dashboards the view, not the form', async () => {
    open({}, undefined, VIEW);
    expect(await screen.findByTestId('versions')).toBeTruthy();
    expect(screen.getByTestId('read-only').textContent).toBe(vi_['bi.dash.builder.readOnly']);
    expect(screen.queryByRole('form', { name: vi_['bi.dash.builder.form'] })).toBeNull();
    cleanup();
    mount(<DashboardLibraryScreen route={LIBRARY} />, client({ dashboards: [dashboard(D1, 'D-ONE')] }), { permissions: VIEW });
    expect(await screen.findByRole('link', { name: vi_['bi.dash.library.view'] })).toBeTruthy();
    expect(screen.queryByRole('link', { name: vi_['bi.dash.library.edit'] })).toBeNull();
  });

  it('opens a dashboard without the right to read the catalogue of metrics, and does not edit blind when that read fails', async () => {
    const denied = client({ dashboards: [dashboard(D1, 'D-ONE', { mine: false, may_edit: false })], one: { ...dashboard(D1, 'D-ONE', { mine: false, may_edit: false }), versions: [version(V1, 1)] }, metrics: failure(403, 'SCOPE_DENIED') });
    mount(<DashboardBuilderScreen route={BUILDER} />, denied, { permissions: ['bi.query', 'dashboard_version.read'] }, `/bi/bi-03?dashboard=${D1}`);
    expect(await screen.findByTestId('versions')).toBeTruthy();
    expect(screen.getByTestId('preview').querySelector('[data-widget="w1"]')).not.toBeNull();
    expect((await screen.findByTestId('read-only')).textContent).toBe(vi_['bi.dash.builder.readOnly']);
    cleanup();
    const failed = client({ dashboards: [dashboard(D1, 'D-ONE')], one: { ...dashboard(D1, 'D-ONE'), versions: [version(V1, 1)] }, metrics: new Error('boom') });
    mount(<DashboardBuilderScreen route={BUILDER} />, failed, { permissions: MAKE }, `/bi/bi-03?dashboard=${D1}`);
    expect((await screen.findByTestId('metrics-failed')).textContent).toContain(vi_['bi.dash.builder.metricsFailed']);
    expect((await screen.findByTestId('read-only')).textContent).toBe(vi_['bi.dash.builder.metricsFailed']);
    expect(screen.queryByRole('form', { name: vi_['bi.dash.builder.form'] })).toBeNull();
    const metricCalls = () => failed.readAll.mock.calls.filter(([operation]) => operation === 'get_resources_metric_definition').length;
    const before = metricCalls();
    await userEvent.setup().click(within(screen.getByTestId('metrics-failed')).getByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(metricCalls()).toBeGreaterThan(before));
  });

  it('keeps the columns of the grid the version was saved with: the preview, the check of the place and the body follow them', async () => {
    const six = version(V1, 1, { layout_json: { columns: 6, widgets: [widget('w1', RATE.id, { grid: { x: 0, y: 0, w: 6, h: 4 } })] } });
    const wide = version(V2, 2, { layout_json: { columns: 24, widgets: [widget('w1', RATE.id, { grid: { x: 12, y: 0, w: 12, h: 4 } })] } });
    const h = open({ one: { ...dashboard(D1, 'D-ONE'), versions: [six] } });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.dash.builder.form'] });
    expect((screen.getByTestId('preview') as HTMLElement).style.gridTemplateColumns).toBe('repeat(6, 1fr)');
    await user.click(within(form).getByRole('button', { name: vi_['bi.dash.tile.add'] }));
    // The tile that is added takes the whole width of this grid.
    expect((within(form).getAllByLabelText(fill(vi_['bi.dash.tile.side'], { side: vi_['bi.dash.side.w'] }))[1] as HTMLInputElement).value).toBe('6');
    await user.click(within(form).getByRole('button', { name: vi_['bi.dash.builder.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { layout_json: { columns: 6 } } });
    cleanup();
    const w = open({ one: { ...dashboard(D1, 'D-ONE'), versions: [wide] } });
    const wideForm = await screen.findByRole('form', { name: vi_['bi.dash.builder.form'] });
    await userEvent.setup().click(within(wideForm).getByRole('button', { name: vi_['bi.dash.builder.submit'] }));
    await waitFor(() => expect(w.command).toHaveBeenCalledTimes(1));
    expect(w.command.mock.calls[0]?.[1]).toMatchObject({ body: { layout_json: { columns: 24, widgets: [{ grid: { x: 12, w: 12 } }] } } });
  });
});

describe('BI-04 builder of a chart (ST-BI-005, UAT-AC32)', () => {
  const ratio = (overrides: Record<string, unknown> = {}): Record<string, unknown> & { children: Array<Record<string, unknown>> } => ({
    metric: { id: RATE.id, code: 'disbursement_rate', unit: 'percent', aggregation_type: 'ratio' },
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
    total: { value: '37.5', numerator: '3000', denominator: '8000', null_reason: null },
    reconciles_to_parent: true,
    non_additive_reason: null,
    truncated: false,
    children: [
      { key: 'A', label: 'Unit A', unclassified: false, value: '25', numerator: '1000', denominator: '4000', null_reason: null, drill_token: 't1' },
      { key: 'B', label: 'Unit B', unclassified: false, value: '50', numerator: '2000', denominator: '4000', null_reason: null, drill_token: 't2' },
      { key: 'C', label: 'Unit C', unclassified: false, value: null, numerator: null, denominator: null, null_reason: 'NO_DATA', drill_token: null },
    ],
    drill_token: 'root',
    ...overrides,
  });

  it('colours the series by a class of the tokens of the design and not by a hex written in the picture, and names the period and the snapshot in the context bar', async () => {
    const h = client({ dashboards: [] }, () => ratio());
    mount(<ChartBuilderScreen route={CHART} />, h, { permissions: VIEW });
    const bar = await screen.findByRole('group', { name: vi_['ui.contextBar.label'] });
    await waitFor(() => expect(within(bar).getByText('2026-10')).toBeTruthy());
    await userEvent.setup().click(await screen.findByRole('button', { name: vi_['bi.chart.draw'] }));
    const result = await screen.findByTestId('chart-result');
    const bars = [...result.querySelectorAll('rect')];
    expect(bars.map((rect) => rect.getAttribute('class'))).toEqual(['bi-series-0', 'bi-series-1']);
    expect(bars.every((rect) => rect.getAttribute('fill') === null)).toBe(true);
    expect(within(result).getByRole('heading', { level: 2 })).toBeTruthy();
  });

  it('AC-ST-BI-005-2: UAT-AC32 draws a ratio from the sums of numerator and denominator, with the period and the snapshot on the chart and the table beside it', async () => {
    const h = client({ dashboards: [] }, () => ratio());
    mount(<ChartBuilderScreen route={CHART} />, h, { permissions: VIEW });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['bi.chart.draw'] }));
    const result = await screen.findByTestId('chart-result');
    expect(h.command.mock.calls[0]).toMatchObject(['post_dashboard_queries', { body: { metric_version_id: RATE.id, snapshot_id: SNAP, dimensions: ['unit'] } }]);
    expect(within(result).getByTestId('chart').getAttribute('data-kind')).toBe('BAR');
    expect(within(result).getByTestId('chart').getAttribute('aria-label')).toBe(fill(vi_['bi.chart.summary'], { kind: vi_['bi.dash.kind.bar'], count: 2, period: '2026-10' }));
    // Two groups have a figure, the third has none: it is not drawn as 0.
    expect([...result.querySelectorAll('rect')].map((bar) => bar.getAttribute('data-point'))).toEqual(['Unit A', 'Unit B']);
    expect(within(result).getByTestId('label-period').textContent).toBe(fill(vi_['bi.query.label.period'], { period: '2026-10' }));
    expect(within(result).getByTestId('label-snapshot').textContent).toBe(fill(vi_['bi.query.label.snapshot'], { id: SNAP.slice(0, 8) }));
    const table = within(result).getByTestId('group-table');
    const rows = within(table).getAllByRole('row');
    expect(rows[1]?.textContent).toContain('25,00%');
    expect(rows[1]?.textContent).toContain('1000');
    expect(rows[1]?.textContent).toContain('4000');
    expect(within(result).getByTestId('group-total').textContent).toContain('37,50%');
    expect(within(result).getByTestId('group-total').textContent).toContain('3000');
    expect(within(result).getByTestId('group-total').textContent).toContain('8000');
    expect(within(result).getByRole('link', { name: vi_['bi.chart.toDashboard'] }).getAttribute('href')).toBe(`/bi/bi-03?metric=${RATE.id}&kind=BAR&dimension=unit`);
  });

  it('draws each kind from the same answer: a line, an area, a pie, a figure and a table, and offers only certified metrics and frozen versions', async () => {
    const h = client({ dashboards: [] }, () => ratio());
    mount(<ChartBuilderScreen route={CHART} />, h, { permissions: VIEW });
    const user = userEvent.setup();
    expect([...((await screen.findByLabelText(vi_['bi.chart.metric'])) as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(['disbursement_rate', 'disbursed']);
    expect([...(screen.getByLabelText(vi_['bi.chart.snapshot']) as HTMLSelectElement).options]).toHaveLength(1);
    for (const [kind, selector] of [['LINE', 'polyline'], ['AREA', 'polygon'], ['PIE', 'path[data-point]']] as const) {
      await user.selectOptions(screen.getByLabelText(vi_['bi.chart.kind']), kind);
      await user.click(screen.getByRole('button', { name: vi_['bi.chart.draw'] }));
      await waitFor(() => expect(screen.getByTestId('chart').getAttribute('data-kind')).toBe(kind));
      expect(screen.getByTestId('chart').querySelector(selector)).not.toBeNull();
    }
    await user.selectOptions(screen.getByLabelText(vi_['bi.chart.kind']), 'KPI');
    expect((screen.getByLabelText(vi_['bi.chart.dimension']) as HTMLSelectElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: vi_['bi.chart.draw'] }));
    await waitFor(() => expect(screen.getByTestId('kpi-value').textContent).toBe('37,50%'));
    expect(h.command.mock.calls.at(-1)?.[1]).toMatchObject({ body: { dimensions: [] } });
    await user.selectOptions(screen.getByLabelText(vi_['bi.chart.kind']), 'TABLE');
    await user.click(screen.getByRole('button', { name: vi_['bi.chart.draw'] }));
    await waitFor(() => expect(screen.queryByTestId('chart')).toBeNull());
    expect(screen.queryByTestId('kpi-value')).toBeNull();
    expect(screen.getByTestId('group-table')).toBeTruthy();
  });

  it('warns when the answer was cut, and draws no pie of it', async () => {
    const h = client({ dashboards: [] }, () => ratio({ truncated: true }));
    mount(<ChartBuilderScreen route={CHART} />, h, { permissions: VIEW });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['bi.chart.draw'] }));
    expect((await screen.findByTestId('truncated')).textContent).toBe(vi_['bi.query.truncated']);
    expect(screen.getByTestId('chart')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText(vi_['bi.chart.kind']), 'PIE');
    await user.click(screen.getByRole('button', { name: vi_['bi.chart.draw'] }));
    expect((await screen.findByTestId('chart-partial')).textContent).toBe(vi_['bi.chart.partial']);
    expect(screen.queryByTestId('chart')).toBeNull();
    expect(screen.getByTestId('group-table')).toBeTruthy();
  });

  it('says why a query cannot be drawn and what it does when no group has a figure', async () => {
    const empty = client({ dashboards: [] }, () => ratio({ children: [{ key: 'C', label: 'Unit C', unclassified: false, value: null, numerator: null, denominator: null, null_reason: 'NO_DATA', drill_token: null }] }));
    mount(<ChartBuilderScreen route={CHART} />, empty, { permissions: VIEW });
    await userEvent.setup().click(await screen.findByRole('button', { name: vi_['bi.chart.draw'] }));
    expect((await screen.findByTestId('chart-empty')).textContent).toBe(vi_['bi.chart.empty']);
    cleanup();
    const refused = client({ dashboards: [] }, () => failure(403, 'ACCESS_POLICY_MISSING'));
    mount(<ChartBuilderScreen route={CHART} />, refused, { permissions: VIEW });
    await userEvent.setup().click(await screen.findByRole('button', { name: vi_['bi.chart.draw'] }));
    expect((await screen.findByTestId('chart-problem')).getAttribute('data-reason')).toBe('policy');
    cleanup();
    const none = client({ dashboards: [] }, () => ratio(), );
    (none.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => Promise.resolve(operation === 'get_resources_metric_definition' ? [RATE] : operation === 'listBiDatasets' ? [dataset] : []));
    mount(<ChartBuilderScreen route={CHART} />, none, { permissions: VIEW });
    expect((await screen.findByTestId('chart-no-period')).textContent).toBe(vi_['bi.board.noPeriod']);
    expect((screen.getByRole('button', { name: vi_['bi.chart.draw'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the standard states', async () => {
    const pending = client({ dashboards: [] });
    (pending.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
    mount(<ChartBuilderScreen route={CHART} />, pending, { permissions: VIEW });
    expect((await screen.findByRole('status', { name: vi_['states.loading.label'] })).getAttribute('aria-busy')).toBe('true');
    cleanup();
    const failed = client({ dashboards: [], metrics: new Error('boom') });
    mount(<ChartBuilderScreen route={CHART} />, failed, { permissions: VIEW });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(failed.readAll.mock.calls.filter(([operation]) => operation === 'get_resources_metric_definition').length).toBeGreaterThan(1));
  });

  it('turns the groups of an answer into points: the ones with a figure, in the order of the answer, named and written as the table writes them', () => {
    const result = toQueryResult(ratio({ children: [{ key: null, label: null, unclassified: true, value: '10', numerator: '1', denominator: '10', null_reason: null, drill_token: null }, ...ratio().children] })) as NonNullable<ReturnType<typeof toQueryResult>>;
    const words = { noData: 'n', notApplicable: 'a', unclassified: 'U' };
    expect(pointsOf(result, 'vi-VN', words).map((point) => [point.label, point.value, point.text])).toEqual([['U', 10, '10,00%'], ['Unit A', 25, '25,00%'], ['Unit B', 50, '50,00%']]);
    const { container } = render1(<ChartView kind="PIE" result={toQueryResult(ratio({ children: [ratio().children[1]] })) as never} />);
    // One slice is a whole circle.
    expect(container.querySelectorAll('path[data-point]')).toHaveLength(1);
    const negative = toQueryResult(ratio({ aggregation_type: 'additive', metric: { id: DISBURSED.id, code: 'disbursed', unit: 'VND', aggregation_type: 'additive' }, children: [{ key: 'A', label: 'A', unclassified: false, value: '-5', numerator: null, denominator: null, null_reason: null, drill_token: null }, { key: 'B', label: 'B', unclassified: false, value: '10', numerator: null, denominator: null, null_reason: null, drill_token: null }] })) as never;
    const bars = render1(<ChartView kind="BAR" result={negative} />);
    expect(bars.container.querySelectorAll('rect')).toHaveLength(2);
    const single = render1(<ChartView kind="LINE" result={toQueryResult(ratio({ children: [ratio().children[0]] })) as never} />);
    expect(single.container.querySelectorAll('circle')).toHaveLength(1);
    const zero = render1(<ChartView kind="PIE" result={toQueryResult(ratio({ children: [{ key: 'A', label: 'A', unclassified: false, value: '0', numerator: '0', denominator: '1', null_reason: null, drill_token: null }, ratio().children[0]] })) as never} />);
    expect(zero.container.querySelectorAll('path[data-point]')).toHaveLength(1);
  });
});

import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function render1(element: ReactElement) {
  const queries = new QueryClient();
  return render(
    <QueryClientProvider client={queries}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the model of the dashboards', () => {
  const metricSet = new Set([RATE.id, DISBURSED.id]);
  const base = (): VersionForm => formFrom(toVersion(version(V1, 1, { layout_json: { columns: 12, widgets: [widget('w1', RATE.id), widget('w2', DISBURSED.id, { grid: { x: 6, y: 0, w: 6, h: 4 } })] }, metric_versions: [RATE.id, DISBURSED.id] })));

  it('judges the form of a dashboard to make', () => {
    expect(validateCreate(EMPTY_CREATE)).toEqual({ code: 'codeRequired', title: 'titleRequired' });
    expect(validateCreate({ code: 'a', title: 'ab' })).toEqual({ code: 'codeInvalid', title: undefined });
    expect(validateCreate({ code: 'GIAI-NGAN', title: 'x'.repeat(301) })).toEqual({ code: undefined, title: 'titleLong' });
  });

  it('judges a version before it is sent: the id, the metric, the dimension, the place, the overlap, the breakpoints, the filters and the pinned versions', () => {
    expect(hasVersionProblems(validateVersion(base(), metricSet))).toBe(false);
    expect(hasVersionProblems(validateVersion(EMPTY_VERSION, metricSet))).toBe(false);
    const problems = (change: (form: VersionForm) => VersionForm) => validateVersion(change(base()), metricSet);
    const first = (form: VersionForm) => form.widgets[0]?.key as string;
    expect(problems((form) => ({ ...form, widgets: form.widgets.map((w, i) => (i === 0 ? { ...w, id: 'bad id' } : w)) })).widgets[base().widgets[0]?.key ?? '']).toBeUndefined();
    const badId = validateVersion({ ...base(), widgets: base().widgets.map((w, i) => (i === 0 ? { ...w, id: 'bad id' } : w)) }, metricSet);
    expect(Object.values(badId.widgets).flat()).toEqual(['widgetId']);
    const taken = validateVersion({ ...base(), widgets: base().widgets.map((w) => ({ ...w, id: 'same' })) }, metricSet);
    expect(Object.values(taken.widgets).flat()).toEqual(['widgetIdTaken', 'widgetIdTaken']);
    expect(Object.values(validateVersion({ ...base(), widgets: base().widgets.map((w, i) => (i === 0 ? { ...w, metricVersionId: '' } : w)) }, metricSet).widgets).flat()).toEqual(['metric']);
    expect(Object.values(validateVersion({ ...base(), widgets: base().widgets.map((w, i) => (i === 0 ? { ...w, dimensionCode: 'Bad' } : w)) }, metricSet).widgets).flat()).toEqual(['dimension']);
    expect(Object.values(validateVersion({ ...base(), widgets: base().widgets.map((w, i) => (i === 0 ? { ...w, kind: 'KPI' as const, dimensionCode: 'unit' } : w)) }, metricSet).widgets).flat()).toEqual(['dimension']);
    expect(Object.values(validateVersion({ ...base(), widgets: base().widgets.map((w, i) => (i === 0 ? { ...w, title: 'x'.repeat(201) } : w)) }, metricSet).widgets).flat()).toEqual(['title']);
    for (const patch of [{ x: '-1' }, { w: '0' }, { h: '0' }, { h: '51' }, { x: '8', w: '5' }, { y: '' }, { w: '1.5' }]) {
      expect([JSON.stringify(patch), Object.values(validateVersion({ ...base(), widgets: base().widgets.map((w, i) => (i === 0 ? { ...w, ...patch } : w)) }, metricSet).widgets).flat()]).toEqual([JSON.stringify(patch), ['grid']]);
    }
    expect(Object.values(validateVersion({ ...base(), widgets: base().widgets.map((w) => ({ ...w, x: '0' })) }, metricSet).widgets).flat()).toEqual(['overlap', 'overlap']);
    expect(validateVersion({ ...base(), widgets: Array.from({ length: 101 }, (_, i) => ({ ...(base().widgets[0] as WidgetForm), key: `k${i}`, id: `t${i}`, y: String(i), h: '1', w: '1' })) }, metricSet).tooMany).toBe('tooMany');
    expect(validateVersion({ ...base(), breakpoints: { sm: '100', md: '', lg: '', xl: '' } }, metricSet).breakpoints).toEqual({ sm: 'breakpoint' });
    expect(validateVersion({ ...base(), breakpoints: { sm: '1024', md: '1024', lg: '', xl: '5000' } }, metricSet).breakpoints).toEqual({ md: 'breakpoint', xl: 'breakpoint' });
    expect(validateVersion({ ...base(), breakpoints: { sm: 'x', md: '', lg: '', xl: '' } }, metricSet).breakpoints).toEqual({ sm: 'breakpoint' });
    const filters = validateVersion({ ...base(), filters: [{ key: 'a', filter: 'Bad', dimension: 'x' }, { key: 'b', filter: 'ok_one', dimension: 'bucket' }, { key: 'c', filter: 'ok_one', dimension: 'unit' }] }, metricSet).filters;
    expect(filters).toEqual({ a: 'filter', b: 'filterTaken', c: 'filterTaken' });
    expect(validateVersion({ ...base(), policy: 'PINNED' }, metricSet).pinned).toBe('pinned');
    expect(validateVersion({ ...base(), policy: 'LATEST_FROZEN', pinned: [SNAP] }, metricSet).pinned).toBe('pinned');
    expect(validateVersion({ ...base(), policy: 'PINNED', pinned: [SNAP] }, metricSet).pinned).toBeUndefined();
    expect(first(base())).toMatch(/^k\d+$/);
  });

  it('writes the body of a version as the contract has it, with each metric once and the pinned versions only for a pinned policy', () => {
    const form = { ...base(), widgets: [...base().widgets, { ...(base().widgets[0] as WidgetForm), key: 'z', id: 'w3', y: '8', title: ' Tên ', dimensionCode: ' ' }] };
    const body = versionBody(form);
    expect(body.metric_versions).toEqual([RATE.id, DISBURSED.id]);
    expect((body.layout_json as { widgets: Array<Record<string, unknown>> }).widgets[2]).toEqual({ id: 'w3', kind: 'BAR', title: 'Tên', metric_version_id: RATE.id, grid: { x: 0, y: 8, w: 6, h: 4 } });
    expect(body.breakpoints).toEqual({ sm: 640, md: 1024 });
    expect(body).not.toHaveProperty('pinned_dataset_version_ids');
    expect(versionBody({ ...base(), policy: 'PINNED', pinned: [SNAP] })).toMatchObject({ dataset_version_policy: 'PINNED', pinned_dataset_version_ids: [SNAP] });
    expect(widgetOfChart({ metricVersionId: RATE.id, kind: 'KPI', dimensionCode: 'unit' }, base().widgets)).toMatchObject({ id: 'w3', dimensionCode: '', y: '4', x: '0', w: '12' });
    expect(widgetOfChart({ metricVersionId: RATE.id, kind: 'BAR', dimensionCode: 'unit' }, [])).toMatchObject({ id: 'w1', dimensionCode: 'unit', y: '0' });
  });

  it('reads a dashboard and a version as the server gives them, with defaults for what is missing', () => {
    const read = toDashboard({ ...dashboard(D1, 'D-ONE'), versions: [version(V1, 1), 'junk', { no: 'id' }] });
    expect(read).toMatchObject({ id: D1, code: 'D-ONE', mine: true, mayEdit: true, current: { revision: 1, metricsCertified: true } });
    expect(read?.versions).toHaveLength(1);
    expect(toDashboard(undefined)).toBeUndefined();
    expect(toDashboard({ id: D1 })).toBeUndefined();
    expect(toDashboard({ id: D1, code: 'x', owner: 'bad', current_version: 5 })).toMatchObject({ title: '', ownerId: '', ownerName: null, audience: 'PRIVATE', status: 'DRAFT', current: null, mine: false, mayEdit: false, versions: [] });
    expect(toDashboard({ ...dashboard(D1, 'x'), current_version: { id: null, metrics_certified: false } })?.current).toMatchObject({ id: null, revision: 0, metricsCertified: false });
    expect(toVersion('x')).toBeUndefined();
    expect(toVersion({ id: V1, layout_json: 'bad', breakpoints: { sm: 'x', md: 800 }, filter_mappings: { a: 1, b: 'c' }, metric_versions: [1, 'm'], pinned_dataset_version_ids: 'x', layout: 1 })).toMatchObject({ columns: 12, widgets: [], breakpoints: { md: 800 }, filterMappings: { b: 'c' }, metricVersionIds: ['m'], pinnedDatasetVersionIds: [], policy: 'LATEST_FROZEN', status: 'DRAFT', publishedAt: null });
    expect(toVersion({ id: V1, layout_json: { columns: 8, widgets: ['x', { id: 'a', kind: 'NOPE', grid: 3 }] } })?.widgets).toEqual([{ id: 'a', kind: 'TABLE', title: null, metricVersionId: '', dimensionCode: null, grid: { x: 0, y: 0, w: 0, h: 0 } }]);
    expect(formFrom(undefined)).toBe(EMPTY_VERSION);
  });

  it('maps a refusal of the server to a reason, and any other failure to a general one', () => {
    expect(describeDashboardProblem(failure(422, 'METRIC_NOT_CERTIFIED', 'metric_versions'))).toEqual({ reason: 'notCertified', field: 'metric_versions' });
    expect(describeDashboardProblem(failure(409, 'DASHBOARD_CODE_DUPLICATE'))).toEqual({ reason: 'duplicate', field: '' });
    expect(describeDashboardProblem(new Error('x'))).toEqual({ reason: 'general', field: '' });
  });
});

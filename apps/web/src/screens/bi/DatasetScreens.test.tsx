import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import { describeBuildProblem, periodProblem, toDataset, toVersion } from './dataset-model';
import DatasetModelScreen from './DatasetModelScreen';
import DatasetVersionsScreen from './DatasetVersionsScreen';

const route = (id: string) => routeOf(id, `FR-${id}`);
const BUILDER = ['bi.dataset.build', 'bi.query'];
const QUERIER = ['bi.query'];
const DATASET = '00000000-0000-4000-8000-0000000000d1';
const OTHER = '00000000-0000-4000-8000-0000000000d2';
const DGV = '00000000-0000-4000-8000-0000000000e1';
const failure = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const dataset = (overrides: Record<string, unknown> = {}) => ({
  id: DATASET,
  dataset_code: 'DS-DISB',
  title: 'Giải ngân theo kỳ',
  source_kind: 'PERIOD_SNAPSHOT',
  grain: 'project',
  join_paths: { dimensions: ['project', 'unit'], joins: [{ from: 'period_snapshot_line.project_id', to: 'project.id' }] },
  dgv_dataset_id: DGV,
  classification: 'INTERNAL',
  refresh_policy: 'ON_SNAPSHOT_FROZEN',
  status: 'ACTIVE',
  latest_version: { as_of_period: '2026-10', quality_badge: 'WARNING', built_at: '2026-11-01T01:00:00.000Z' },
  version: 1,
  ...overrides,
});
const version = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000a0${n}`,
  dataset_id: DATASET,
  as_of_period: '2026-10',
  source_snapshot_id: '11111111-0000-4000-8000-000000000001',
  built_at: '2026-11-01T01:00:00.000Z',
  row_count: 1500,
  certified_row_count_min: 1488,
  excluded_quarantine_rows: 12,
  quality_run_id: '22222222-0000-4000-8000-000000000001',
  quality_badge: 'WARNING',
  feeds_certified: true,
  status: 'FROZEN',
  ...overrides,
});

interface World {
  datasets: unknown[] | Error;
  versions: unknown[] | Error;
}

function client(world: World, command: (operation: string, input: unknown) => unknown = () => ({ status: 'FROZEN', outcome: 'BUILT' })) {
  const h = harness(() => new Error('unexpected read'), command);
  const readAll = vi.fn((operation: string, input?: { path?: { id: string } }) => {
    const answer = operation === 'listBiDatasets' ? world.datasets : operation === 'listBiDatasetVersions' ? world.versions : new Error(`unexpected readAll ${operation}`);
    void input;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

describe('BI-07 sources and data model (ST-BI-002, BI 3 F2)', () => {
  it('AC-ST-BI-002-1: UAT-AC478 shows each dataset as a tree: its source, grain, dimensions, approved joins, refresh, entry in the DGV catalogue and the version in use with its badge', async () => {
    mount(<DatasetModelScreen route={route('BI-07')} />, client({ datasets: [dataset()], versions: [] }), { permissions: QUERIER });
    const card = await screen.findByRole('heading', { name: /Giải ngân theo kỳ/ });
    expect(card.textContent).toContain('DS-DISB');
    expect(screen.getByTestId('model-rule').textContent).toBe(vi_['bi.model.rule']);
    expect(screen.getByTestId(`dimensions-${DATASET}`).textContent).toContain('project, unit');
    expect(screen.getByTestId(`joins-${DATASET}`).textContent).toBe('period_snapshot_line.project_id → project.id');
    expect(screen.getByTestId(`latest-${DATASET}`).textContent).toContain(`2026-10 · ${vi_['bi.dataset.badge.warning']}`);
    expect(screen.getByText(new RegExp(vi_['bi.dataset.refresh.onFrozen']))).toBeTruthy();
    expect(screen.getByRole('link', { name: fill(vi_['bi.model.catalogue.aria'], { code: 'DS-DISB' }) }).getAttribute('href')).toBe(`/dgv/dgv-04?dataset=${DGV}`);
    expect(screen.getByRole('link', { name: vi_['bi.model.versions'] }).getAttribute('href')).toBe(`/bi/bi-18?dataset=${DATASET}`);
  });

  it('says a dataset has no joins, no catalogue entry, no dimension and no version yet, instead of leaving it blank', async () => {
    mount(<DatasetModelScreen route={route('BI-07')} />, client({ datasets: [dataset({ join_paths: {}, dgv_dataset_id: null, latest_version: null, refresh_policy: 'SCHEDULED' })], versions: [] }), { permissions: QUERIER });
    expect(await screen.findByText(vi_['bi.model.noJoins'])).toBeTruthy();
    expect(screen.getByTestId(`latest-${DATASET}`).textContent).toContain(vi_['bi.model.noVersion']);
    expect(screen.getByTestId(`dimensions-${DATASET}`).textContent).toContain(vi_['bi.model.none']);
    expect(screen.queryByRole('link', { name: /DGV/ })).toBeNull();
  });

  describe('the seven standard states', () => {
    it.each([
      ['empty', [], vi_['states.empty.title']],
      ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
      ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
    ] as Array<[string, unknown[] | Error, string]>)('UI-BI-07 shows the %s state', async (_name, datasets, title) => {
      mount(<DatasetModelScreen route={route('BI-07')} />, client({ datasets, versions: [] }), { permissions: QUERIER });
      expect(await screen.findByText(title)).toBeTruthy();
    });

    it('UI-BI-07 shows the loading state first, names the page, and retries after an error', async () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<DatasetModelScreen route={route('BI-07')} />, h, { permissions: QUERIER });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['bi.model.page.title'] })).toBeTruthy();
      cleanup();
      const world: World = { datasets: failure(500, 'INTERNAL_ERROR'), versions: [] };
      mount(<DatasetModelScreen route={route('BI-07')} />, client(world), { permissions: QUERIER });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      world.datasets = [dataset()];
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('model-rule')).toBeTruthy();
    });
  });
});

describe('BI-18 datasets and period snapshots (ST-BI-002, BI 3 F2)', () => {
  const first = version(1, { quality_badge: 'NOT_ASSESSED', excluded_quarantine_rows: 0, certified_row_count_min: 1500, quality_run_id: null, status: 'SUPERSEDED' });
  const second = version(2);

  it('AC-ST-BI-002-1: UAT-AC478 lists the versions of a period: the first not assessed and superseded but still there, the second with the run linked, 12 rows left out of the certified figures', async () => {
    mount(<DatasetVersionsScreen route={route('BI-18')} />, client({ datasets: [dataset()], versions: [second, first] }), { permissions: QUERIER });
    const table = await screen.findByTestId('versions-table');
    const rows = [...table.querySelectorAll('tbody tr')] as HTMLElement[];
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['FROZEN', 'SUPERSEDED']);
    expect(screen.getByTestId(`badge-${second.id}`).textContent).toBe(vi_['bi.dataset.badge.warning']);
    expect(screen.getByTestId(`rows-${second.id}`).textContent).toContain(fill(vi_['bi.versions.rows'], { rows: '1.500', certified: '1.488' }));
    expect(screen.getByTestId(`rows-${second.id}`).textContent).toContain(fill(vi_['bi.versions.excluded'], { rows: 12 }));
    // The first version says the quality is not known, and has no row left out.
    expect(screen.getByTestId(`badge-${first.id}`).textContent).toBe(vi_['bi.dataset.badge.notAssessed']);
    expect(screen.getByTestId(`rows-${first.id}`).textContent).not.toContain('quarantined');
    expect(within(rows[0] as HTMLElement).getByText(vi_['bi.dataset.status.frozen'])).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(vi_['bi.dataset.status.superseded'])).toBeTruthy();
    for (const name of ['dataset', 'period', 'snapshot', 'builtAt', 'rows', 'quality', 'status']) {
      expect(within(table).getByRole('columnheader', { name: vi_[`bi.versions.column.${name}` as keyof typeof vi_] })).toBeTruthy();
    }
  });

  it('says a version whose quality blocks or measured other data is not used for certified figures', async () => {
    const h = client({ datasets: [dataset()], versions: [version(3, { quality_badge: 'FAILED', feeds_certified: false }), version(4, { quality_badge: 'STALE', feeds_certified: false, excluded_quarantine_rows: 0 })] });
    mount(<DatasetVersionsScreen route={route('BI-18')} />, h, { permissions: QUERIER });
    await screen.findByTestId('versions-table');
    expect(screen.getAllByText(vi_['bi.versions.notCertified'], { exact: false })).toHaveLength(2);
  });

  it('reads the versions of the dataset named in the address, and of the one chosen in the list', async () => {
    const user = userEvent.setup();
    const h = client({ datasets: [dataset(), dataset({ id: OTHER, dataset_code: 'DS-OTHER', title: 'Other' })], versions: [second] });
    mount(<DatasetVersionsScreen route={route('BI-18')} />, h, { permissions: QUERIER }, `/?dataset=${OTHER}`);
    await screen.findByTestId('versions-table');
    expect(h.readAll.mock.calls.at(-1)).toEqual(['listBiDatasetVersions', { path: { id: OTHER } }]);
    await user.selectOptions(screen.getByLabelText(vi_['bi.versions.dataset']), DATASET);
    await waitFor(() => expect(h.readAll.mock.calls.at(-1)).toEqual(['listBiDatasetVersions', { path: { id: DATASET } }]));
  });

  it('AC-ST-BI-002-2: UAT-AC482 builds the version of a period, says when nothing changed, and says why the server refused', async () => {
    const user = userEvent.setup();
    let answer: unknown = { status: 'FROZEN', outcome: 'BUILT' };
    const h = client({ datasets: [dataset()], versions: [second] }, () => (answer instanceof Error ? answer : answer));
    mount(<DatasetVersionsScreen route={route('BI-18')} />, h, { permissions: BUILDER });
    const period = await screen.findByLabelText(vi_['bi.versions.build.period']);
    await user.click(screen.getByRole('button', { name: vi_['bi.versions.build.action'] }));
    expect(await screen.findByText(vi_['bi.metric.problem.required'])).toBeTruthy();
    await user.type(period, 'bad period');
    await user.click(screen.getByRole('button', { name: vi_['bi.versions.build.action'] }));
    expect(await screen.findByText(vi_['bi.versions.build.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.clear(period);
    await user.type(period, '2026-10');
    await user.click(screen.getByRole('button', { name: vi_['bi.versions.build.action'] }));
    expect((await screen.findByTestId('build-done')).textContent).toBe(vi_['bi.versions.build.built']);
    expect(h.command.mock.calls[0]).toMatchObject(['buildBiDatasetVersion', { path: { id: DATASET }, body: { as_of_period: '2026-10' } }]);
    answer = { status: 'FROZEN', outcome: 'UNCHANGED' };
    await user.click(screen.getByRole('button', { name: vi_['bi.versions.build.action'] }));
    await waitFor(() => expect(screen.getByTestId('build-done').textContent).toBe(vi_['bi.versions.build.unchanged']));
    for (const [code, key] of [['BUILD_ALREADY_RUNNING', 'running'], ['SOURCE_SNAPSHOT_NOT_FROZEN', 'notFrozen'], ['SCOPE_DENIED', 'denied'], ['INTERNAL_ERROR', 'general']] as const) {
      answer = failure(code === 'BUILD_ALREADY_RUNNING' ? 409 : code === 'INTERNAL_ERROR' ? 500 : 422, code);
      await user.click(screen.getByRole('button', { name: vi_['bi.versions.build.action'] }));
      await waitFor(() => expect(screen.getByTestId('build-refused').textContent).toBe(vi_[`bi.dataset.refused.${key}` as keyof typeof vi_]));
    }
  });

  it('shows no build form to whoever may not build, nor while the tenant is read-only', async () => {
    mount(<DatasetVersionsScreen route={route('BI-18')} />, client({ datasets: [dataset()], versions: [second] }), { permissions: QUERIER });
    await screen.findByTestId('versions-table');
    expect(screen.queryByRole('button', { name: vi_['bi.versions.build.action'] })).toBeNull();
    cleanup();
    mount(<DatasetVersionsScreen route={route('BI-18')} />, client({ datasets: [dataset()], versions: [second] }), { permissions: BUILDER, mode: 'READ_ONLY' });
    await screen.findByTestId('versions-table');
    expect(screen.queryByRole('button', { name: vi_['bi.versions.build.action'] })).toBeNull();
  });

  it('says a dataset has no version yet', async () => {
    mount(<DatasetVersionsScreen route={route('BI-18')} />, client({ datasets: [dataset()], versions: [] }), { permissions: QUERIER });
    expect((await screen.findByTestId('versions-none')).textContent).toBe(vi_['bi.versions.noVersions']);
  });

  describe('the seven standard states', () => {
    it.each([
      ['empty', { datasets: [], versions: [] }, vi_['states.empty.title']],
      ['denied', { datasets: failure(403, 'SCOPE_DENIED'), versions: [] }, vi_['states.denied.title']],
      ['denied for the versions', { datasets: [dataset()], versions: failure(403, 'SCOPE_DENIED') }, vi_['states.denied.title']],
      ['offline', { datasets: new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), versions: [] }, vi_['states.offline.title']],
      ['error', { datasets: failure(500, 'INTERNAL_ERROR'), versions: [] }, vi_['states.error.title']],
      ['signed out', { datasets: failure(401, 'SESSION_EXPIRED'), versions: [] }, vi_['states.signedOut.title']],
    ] as Array<[string, World, string]>)('UI-BI-18 shows the %s state', async (_name, world, title) => {
      mount(<DatasetVersionsScreen route={route('BI-18')} />, client(world), { permissions: QUERIER });
      expect(await screen.findByText(title)).toBeTruthy();
    });

    it('UI-BI-18 shows the loading state first and names the page', () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<DatasetVersionsScreen route={route('BI-18')} />, h, { permissions: QUERIER });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['bi.versions.page.title'] })).toBeTruthy();
    });
  });
});

describe('the datasets as the screens read them', () => {
  it('leaves out an entry that lacks what the screens need and reads the rest as it is', () => {
    expect(toDataset({ id: 'x' })).toBeUndefined();
    expect(toDataset('x')).toBeUndefined();
    expect(toDataset(dataset({ latest_version: { as_of_period: '2026-10', quality_badge: 'GOOD' } }))?.latest).toBeNull();
    expect(toDataset(dataset({ join_paths: { dimensions: ['a', 5], joins: [{ from: 'a' }, { from: 'b', to: 'c' }, 5] } }))).toMatchObject({ dimensions: ['a'], joins: [{ from: 'b', to: 'c' }] });
    for (const broken of [{ id: 5 }, { row_count: -1 }, { quality_badge: 'GOOD' }, { status: 'GONE' }, { as_of_period: 3 }]) expect(toVersion(version(1, broken))).toBeUndefined();
    expect(toVersion(version(1, { certified_row_count_min: undefined, excluded_quarantine_rows: 12, feeds_certified: undefined }))).toMatchObject({ certifiedRowCountMin: 1488, feedsCertified: true });
  });

  it('judges the period typed and maps a refusal of the server', () => {
    expect([periodProblem(''), periodProblem(' '), periodProblem('2026 10'), periodProblem('2026-10'), periodProblem('x')]).toEqual(['required', 'required', 'invalid', undefined, 'invalid']);
    const refused = (code: string) => describeBuildProblem(new ApiError({ status: 422, code, correlationId: 'c' }));
    expect([refused('BUILD_ALREADY_RUNNING'), refused('SOURCE_SNAPSHOT_NOT_FROZEN'), refused('VALIDATION_FAILED'), refused('SCOPE_DENIED'), refused('RESOURCE_NOT_FOUND'), refused('SESSION_EXPIRED'), refused('OTHER')]).toEqual(['running', 'notFrozen', 'invalid', 'denied', 'notFound', 'session', 'general']);
    expect(describeBuildProblem(new Error('x'))).toBe('general');
  });
});

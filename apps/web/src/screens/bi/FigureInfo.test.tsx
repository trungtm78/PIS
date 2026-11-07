import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import g from '../../i18n/vi.json';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import BoardScreen from './BoardScreen';
import { ChartView } from './ChartView';
import { toQueryResult } from './query-model';
import { rawMetric, sum } from './test-support';

const BOARD = routeOf('BI-02', 'FR-BI-02');
const QUERIER = ['bi.query', 'metric_definition.read'];
const DATASET = '00000000-0000-4000-8000-0000000000d1';
const V1 = '00000000-0000-4000-8000-0000000000a1';
const RATE = rawMetric({ id: '00000000-0000-4000-8000-0000000000b1', code: 'disbursement_rate', aggregation_type: 'ratio', unit: 'percent', numerator_ast: sum('GIAI_NGAN'), denominator_ast: sum('KE_HOACH_TTG') });
const DISBURSED = rawMetric({ id: '00000000-0000-4000-8000-0000000000b2', code: 'disbursed', aggregation_type: 'additive', unit: 'VND', numerator_ast: null, denominator_ast: null, expression_ast: sum('GIAI_NGAN') });
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

const dataset = { id: DATASET, dataset_code: 'DS-DISB', title: 'DISB', source_kind: 'PERIOD_SNAPSHOT', grain: 'project', join_paths: {}, refresh_policy: 'ON_SNAPSHOT_FROZEN', status: 'ACTIVE', latest_version: null };
const version = { id: V1, dataset_id: DATASET, as_of_period: '2026-10', source_snapshot_id: null, built_at: '2026-11-01T01:00:00.000Z', row_count: 3, excluded_quarantine_rows: 0, quality_badge: 'PASSED', feeds_certified: true, status: 'FROZEN' };
const answer = (metric: { id: string; code: string; unit: string; aggregation_type: string }, total: Record<string, unknown>) => ({
  metric,
  as_of_period: '2026-10',
  snapshot_id: V1,
  quality_badge: 'PASSED',
  excluded_quarantine_rows: 0,
  feeds_certified: true,
  new_data_available: false,
  scope: { label: 'YOUR_SCOPE', full_tenant: false },
  served_from_cache: false,
  built_at: '2026-11-01T02:00:00.000Z',
  dimension: null,
  total,
  reconciles_to_parent: true,
  non_additive_reason: null,
  truncated: false,
  children: [],
  drill_token: 'token-root',
});
const figure = { value: '35.00', numerator: null, denominator: null, null_reason: null };
const noData = { value: null, numerator: null, denominator: null, null_reason: 'NO_DATA' };
const kpiDefinition = {
  code: 'DISBURSED',
  name: 'Giá trị giải ngân',
  formula: 'Tổng giải ngân đã chốt',
  numerator: null,
  denominator: null,
  exclusions: ['Vốn chưa phân bổ'],
  unit: 'VND',
  period: 'Lũy kế',
  source: 'DIS, số đã chốt',
  owner: 'CAPITAL_PLANNER',
  decimals: 0,
  refresh_hours: 24,
  allowed_lag_days: 2,
  rag_code: null,
  version: 0,
  origin: 'DEFAULT',
  unverified: true,
  certification: null,
};
const datasetCert = (status: string) => ({ dataset_id: DATASET, code: 'DS-DISB', title: 'DISB', dataset_status: 'ACTIVE', last_certified_version: null, status, version: 2, origin: 'TENANT', certified_by: null, confirmed_by: null, note: null, at: null });

interface World {
  register?: unknown;
  certifications?: unknown;
  total?: Record<string, unknown>;
}

function client(world: World = {}) {
  const h = harness((operation) => {
    if (operation === 'getKpiRegister') return world.register ?? { as_of: '2026-11-08', definitions: [kpiDefinition] };
    if (operation === 'listAnalyticsCertifications') return world.certifications ?? { as_of: '2026-11-08', kpis: [], datasets: [datasetCert('CERTIFIED')], metrics: [] };
    return new Error(`unexpected read ${operation}`);
  }, (_operation, input) => {
    const id = (input as { body: { metric_version_id: string } }).body.metric_version_id;
    const metric = id === RATE.id ? { id: RATE.id, code: 'disbursement_rate', unit: 'percent', aggregation_type: 'ratio' } : { id: DISBURSED.id, code: 'disbursed', unit: 'VND', aggregation_type: 'additive' };
    return answer(metric, world.total ?? figure);
  });
  const readAll = vi.fn((operation: string) =>
    Promise.resolve(operation === 'get_resources_metric_definition' ? [RATE, DISBURSED] : operation === 'listBiDatasets' ? [dataset] : operation === 'listBiDatasetVersions' ? [version] : []),
  );
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}
const tile = (id: string): HTMLElement => document.querySelector(`[data-metric-id="${id}"]`) as HTMLElement;
const findInfo = (id: string) => waitFor(() => within(tile(id)).getByTestId('figure-info'));

afterEach(cleanup);

describe('the "i" and the data-quality flag on the numbers of the board (G0-4, G3-1)', () => {
  it('uses the definition of the KPI register when it has the code of the metric', async () => {
    const user = userEvent.setup();
    mount(<BoardScreen route={BOARD} />, client(), { permissions: QUERIER });
    const info = await findInfo(DISBURSED.id);
    await user.click(within(info).getByRole('button', { name: g['govc.bi.info.open'].replace('{name}', 'Giá trị giải ngân') }));
    const panel = screen.getByRole('dialog', { name: 'Giá trị giải ngân' });
    expect(within(panel).getByText('Tổng giải ngân đã chốt')).toBeTruthy();
    expect(within(panel).getByText('Vốn chưa phân bổ')).toBeTruthy();
    expect(within(panel).getByText('DIS, số đã chốt')).toBeTruthy();
    expect(within(panel).getByText('CAPITAL_PLANNER')).toBeTruthy();
    expect(within(panel).getByText('2026-10')).toBeTruthy();
    expect(within(panel).getByText('0 (mặc định)')).toBeTruthy();
    expect(within(panel).getByText(g['govc.bi.register.unverified'])).toBeTruthy();
  });

  it('falls back to the definition of the metric the board has: its formula, its dataset as the source, its revision', async () => {
    const user = userEvent.setup();
    mount(<BoardScreen route={BOARD} />, client(), { permissions: QUERIER });
    const info = await findInfo(RATE.id);
    await user.click(within(info).getByRole('button'));
    const panel = screen.getByRole('dialog', { name: 'disbursement_rate' });
    expect(within(panel).getByText('SUM(GIAI_NGAN) / SUM(KE_HOACH_TTG)')).toBeTruthy();
    expect(within(panel).getByText('Bộ dữ liệu DS-DISB, ảnh chụp kỳ 2026-10')).toBeTruthy();
    expect(within(panel).getByText('Bản sửa 1 của metric')).toBeTruthy();
    expect(within(panel).queryByText(g['govc.bi.register.unverified'])).toBeNull();
  });

  it('keeps the "i" from the metric when the register cannot be read, and reads the register once for all tiles', async () => {
    const h = client({ register: failure(500, 'INTERNAL_ERROR') });
    mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER });
    await findInfo(DISBURSED.id);
    await findInfo(RATE.id);
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'getKpiRegister').length).toBe(1));
  });

  it('flags a number made from a dataset that is not certified, with its state in words', async () => {
    const h = client({ certifications: { as_of: '2026-11-08', kpis: [], datasets: [datasetCert('DRAFT')], metrics: [] } });
    mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER });
    const flag = await within(await findInfo(RATE.id)).findByTestId('figure-flag');
    expect(flag.textContent).toBe('Bộ dữ liệu chưa chứng nhận: Nháp');
    expect(within(await findInfo(DISBURSED.id)).getByTestId('figure-flag')).toBeTruthy();
  });

  it('shows no flag for a certified dataset', async () => {
    const h = client();
    mount(<BoardScreen route={BOARD} />, h, { permissions: QUERIER });
    const info = await findInfo(RATE.id);
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listAnalyticsCertifications'));
    await Promise.all(h.read.mock.results.map((result) => result.value));
    expect(within(info).queryByTestId('figure-flag')).toBeNull();
  });

  it('says nothing when the person may not read the certifications, and says it could not be checked on another failure', async () => {
    mount(<BoardScreen route={BOARD} />, client({ certifications: failure(403, 'FORBIDDEN') }), { permissions: QUERIER });
    const info = await findInfo(RATE.id);
    await waitFor(() => expect(screen.getAllByTestId('figure-info').length).toBe(2));
    expect(within(info).queryByTestId('figure-flag')).toBeNull();
    cleanup();
    mount(<BoardScreen route={BOARD} />, client({ certifications: failure(500, 'INTERNAL_ERROR') }), { permissions: QUERIER });
    expect((await within(await findInfo(RATE.id)).findByTestId('figure-flag')).textContent).toBe(g['govc.bi.figure.unchecked']);
  });

  it('keeps the "i" on a tile with no data and never shows 0 there', async () => {
    mount(<BoardScreen route={BOARD} />, client({ total: noData }), { permissions: QUERIER });
    const info = await findInfo(RATE.id);
    expect(info).toBeTruthy();
    expect(tile(RATE.id).querySelector('.ui-kpi__value')?.textContent).toBe(vi_['bi.query.noData']);
  });
});

describe('the "i" on the figure of a widget (ChartView)', () => {
  it('finds the metric of the answer in the registry and offers its definition, without a flag when the metric names no dataset', async () => {
    const result = toQueryResult(answer({ id: RATE.id, code: 'disbursement_rate', unit: 'percent', aggregation_type: 'ratio' }, figure));
    expect(result).toBeDefined();
    const user = userEvent.setup();
    mount(<ChartView kind="KPI" result={result!} />, client(), { permissions: QUERIER });
    const info = await screen.findByTestId('figure-info');
    expect(within(info).queryByTestId('figure-flag')).toBeNull();
    await user.click(within(info).getByRole('button'));
    expect(within(screen.getByRole('dialog')).getByText('SUM(GIAI_NGAN) / SUM(KE_HOACH_TTG)')).toBeTruthy();
  });

  it('flags the figure of a metric whose dataset is not certified', async () => {
    const own = rawMetric({ id: '00000000-0000-4000-8000-0000000000b9', code: 't_own', dataset_id: DATASET });
    const result = toQueryResult(answer({ id: own.id as string, code: 't_own', unit: 'percent', aggregation_type: 'ratio' }, figure));
    const h = client({ certifications: { as_of: '2026-11-08', kpis: [], datasets: [datasetCert('OBSOLETE')], metrics: [] } });
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => Promise.resolve([own]));
    mount(<ChartView kind="KPI" result={result!} />, h, { permissions: QUERIER });
    expect((await screen.findByTestId('figure-flag')).textContent).toBe('Bộ dữ liệu chưa chứng nhận: Lỗi thời');
  });

  it('shows no control at all when there is neither a register entry, nor a metric, nor a flag', async () => {
    const result = toQueryResult(answer({ id: 'unknown-metric', code: 'unknown_metric', unit: 'VND', aggregation_type: 'additive' }, figure));
    mount(<ChartView kind="KPI" result={result!} />, client({ register: failure(500, 'INTERNAL_ERROR') }), { permissions: QUERIER });
    await screen.findByTestId('kpi-value');
    await waitFor(() => expect(screen.queryByTestId('figure-info')).toBeNull());
  });
});

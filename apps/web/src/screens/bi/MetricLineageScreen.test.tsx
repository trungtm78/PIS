import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import MetricLineageScreen from './MetricLineageScreen';
import { lineageNeedsMetric, lineageParams, toMetricLineage } from './metric-lineage-model';
import { rawMetric } from './test-support';

const ROUTE = routeOf('BI-14', 'FR-BI-14');
const READ = ['bi.lineage.read', 'metric_definition.read'];
const RATE = rawMetric({ id: '00000000-0000-4000-8000-0000000000f1', code: 'disbursement_rate', aggregation_type: 'ratio', unit: 'percent' });
const OTHER = rawMetric({ id: '00000000-0000-4000-8000-0000000000f2', code: 'plan_total' });
const RUN = '00000000-0000-4000-8000-0000000000a1';
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

const node = (key: string, level: number, overrides: Record<string, unknown> = {}) => ({
  key,
  restricted: false,
  node_kind: 'TABLE',
  ref_module: 'DIS',
  ref_id: null,
  ref_key: `ref:${key}`,
  display_name: `Nút ${key}`,
  classification: 'INTERNAL',
  level,
  ...overrides,
});
const GRAPH = {
  start: 'n-metric',
  direction: 'upstream',
  depth: 3,
  truncated: false,
  nodes: [
    node('n-metric', 0, { node_kind: 'METRIC_VERSION', ref_module: 'BI', display_name: 'disbursement_rate r1' }),
    node('n-version', 1, { node_kind: 'DATASET_VERSION', ref_module: 'BI', display_name: 'DS-DISB 2026-10' }),
    node('n-snapshot', 2, { display_name: 'Snapshot 2026-10' }),
    { key: 'restricted-1', restricted: true, level: 3, display_name: 'Bí mật' },
  ],
  edges: [
    { from: 'n-version', to: 'n-metric', run_id: RUN, transform_version: 'metric:disbursement_rate@1', observed_at: '2026-11-01T00:00:00.000Z' },
    { from: 'n-snapshot', to: 'n-version', run_id: RUN, transform_version: 'bi-dataset-build-v1', observed_at: '2026-11-01T00:00:00.000Z' },
    { from: 'restricted-1', to: 'n-snapshot', run_id: null, transform_version: null, observed_at: null },
  ],
  quality: { 'n-version': { quality_badge: 'NOT_ASSESSED', excluded_quarantine_rows: 0 } },
};

type Answer = Record<string, unknown> | Error;
function client(answer: () => Answer) {
  return harness((operation, input) => {
    if (operation === 'getBiLineage') return answer();
    return operation === 'get_resources_metric_definition' ? { items: [RATE, OTHER], next_cursor: null } : new Error(`unexpected read ${operation} ${JSON.stringify(input)}`);
  });
}
const withMetrics = (h: ReturnType<typeof client>) => {
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) =>
    operation === 'get_resources_metric_definition' ? Promise.resolve([RATE, OTHER]) : Promise.reject(new Error(`unexpected readAll ${operation}`)),
  );
  return h;
};

afterEach(() => cleanup());

describe('the model of the lineage of a metric (ST-BI-009)', () => {
  it('reads the graph and the quality of the versions of the dataset by the key of their node', () => {
    const lineage = toMetricLineage(GRAPH);
    expect(lineage?.graph.nodes).toHaveLength(4);
    expect(lineage?.quality.get('n-version')).toEqual({ badge: 'NOT_ASSESSED', excludedRows: 0 });
    expect(lineage?.graph.nodes[3]).toEqual({ key: 'restricted-1', restricted: true, kind: null, module: null, refId: null, refKey: null, name: null, classification: null, level: 3 });
  });

  it('reads a metric nothing was recorded about as a graph with no node, and anything else as nothing', () => {
    expect(toMetricLineage({ start: null, direction: 'upstream', depth: 3, truncated: false, nodes: [], edges: [], quality: {} })?.graph.nodes).toEqual([]);
    expect(toMetricLineage('x')).toBeUndefined();
    expect(toMetricLineage({ start: 'a' })).toBeUndefined();
    expect(toMetricLineage({ ...GRAPH, quality: { 'n-version': 3, 'n-x': { quality_badge: 'PASSED', excluded_quarantine_rows: 'many' } } })?.quality).toEqual(
      new Map([['n-x', { badge: 'PASSED', excludedRows: 0 }]]),
    );
    expect(toMetricLineage({ ...GRAPH, quality: 'none' })?.quality.size).toBe(0);
  });

  it('writes the query with the direction and the depth, and asks for a metric first', () => {
    expect(lineageParams({ metricId: RATE.id as string, direction: 'downstream', depth: 5 })).toEqual({ direction: 'downstream', depth: '5' });
    expect(lineageNeedsMetric({ metricId: '', direction: 'upstream', depth: 3 })).toBe(true);
    expect(lineageNeedsMetric({ metricId: RATE.id as string, direction: 'upstream', depth: 3 })).toBe(false);
  });
});

describe('BI-14, the lineage of a metric (ST-BI-009)', () => {
  async function open(h: ReturnType<typeof client>) {
    withMetrics(h);
    mount(<MetricLineageScreen route={ROUTE} />, h, { permissions: READ });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.lin.form.title'] });
    await waitFor(() => expect(within(within(form).getByLabelText(vi_['bi.lin.metric'])).getAllByRole('option')).toHaveLength(2));
    return { user, form };
  }

  it('asks nothing until a metric is asked for, then draws the graph level by level with each transform, the quality of the version, and the restricted node with nothing of its own', async () => {
    const h = client(() => GRAPH);
    const { user, form } = await open(h);
    expect(screen.getByTestId('ask-first')).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    await user.click(within(form).getByRole('button', { name: vi_['bi.lin.submit'] }));
    const levels = await screen.findByTestId('levels');
    const items = within(levels)
      .getAllByRole('listitem')
      .filter((item) => item.hasAttribute('data-node'));
    expect(items).toHaveLength(4);
    expect(items[1]?.textContent).toContain('DS-DISB 2026-10');
    expect(within(items[1] as HTMLElement).getByTestId('quality').textContent).toContain('NOT_ASSESSED');
    expect(items[3]?.getAttribute('data-restricted')).toBe('true');
    expect(items[3]?.textContent).toBe(vi_['dgv.lin.restricted']);
    expect(levels.textContent).not.toContain('Bí mật');
    const rows = within(screen.getByTestId('edges')).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('metric:disbursement_rate@1');
    expect(rows[2]?.getAttribute('data-restricted')).toBe('true');
    expect(rows[2]?.textContent).toContain(vi_['dgv.lin.restricted']);
    expect(h.read).toHaveBeenCalledWith('getBiLineage', { path: { id: RATE.id }, query: { direction: 'upstream', depth: '3' } });
  });

  it('asks for the metric, the direction and the depth that are chosen', async () => {
    const h = client(() => GRAPH);
    const { user, form } = await open(h);
    await user.selectOptions(within(form).getByLabelText(vi_['bi.lin.metric']), OTHER.id as string);
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.lin.direction']), 'downstream');
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.lin.depth']), '5');
    await user.click(within(form).getByRole('button', { name: vi_['bi.lin.submit'] }));
    await screen.findByTestId('levels');
    expect(h.read).toHaveBeenCalledWith('getBiLineage', { path: { id: OTHER.id }, query: { direction: 'downstream', depth: '5' } });
  });

  it('says when the graph was cut', async () => {
    const { user, form } = await open(client(() => ({ ...GRAPH, truncated: true })));
    await user.click(within(form).getByRole('button', { name: vi_['bi.lin.submit'] }));
    expect(await screen.findByTestId('truncated')).toBeTruthy();
  });

  it('says so, and draws nothing, for a metric nothing was recorded about', async () => {
    const { user, form } = await open(client(() => ({ start: null, direction: 'upstream', depth: 3, truncated: false, nodes: [], edges: [], quality: {} })));
    await user.click(within(form).getByRole('button', { name: vi_['bi.lin.submit'] }));
    expect((await screen.findByTestId('empty')).textContent).toBe(vi_['bi.lin.empty']);
    expect(screen.queryByTestId('levels')).toBeNull();
  });

  it('draws the parallel steps of two nodes one row each, even when a restricted node hides their transform', async () => {
    const hidden = { from: 'n-snapshot', to: 'restricted-1', run_id: null, transform_version: null, observed_at: null };
    const complaints = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { user, form } = await open(client(() => ({ ...GRAPH, edges: [hidden, { ...hidden }, { ...hidden }] })));
      await user.click(within(form).getByRole('button', { name: vi_['bi.lin.submit'] }));
      expect(
        within(await screen.findByTestId('edges'))
          .getAllByRole('row')
          .slice(1),
      ).toHaveLength(3);
      expect(complaints.mock.calls.flat().join(' ')).not.toContain('same key');
    } finally {
      complaints.mockRestore();
    }
  });

  it.each([
    ['notFound', failure(404, 'RESOURCE_NOT_FOUND'), vi_['dgv.lin.reason.notFound']],
    ['scope', failure(403, 'SCOPE_DENIED'), vi_['dgv.lin.reason.scope']],
    ['invalid', failure(422, 'VALIDATION_FAILED'), vi_['dgv.lin.reason.invalid']],
    ['general', failure(500, 'INTERNAL_ERROR'), vi_['dgv.lin.reason.general']],
  ])('tells a refusal for the reason it was given: %s', async (reason, error, message) => {
    const { user, form } = await open(client(() => error));
    await user.click(within(form).getByRole('button', { name: vi_['bi.lin.submit'] }));
    const failed = await screen.findByTestId('failed');
    expect(failed.getAttribute('data-reason')).toBe(reason);
    expect(failed.textContent).toBe(message);
  });

  it('asks the server again when the same question is submitted again: a failure is tried once more', async () => {
    let answers = 0;
    const h = client(() => (answers++ === 0 ? failure(500, 'BOOM') : GRAPH));
    const { user, form } = await open(h);
    await user.click(within(form).getByRole('button', { name: vi_['bi.lin.submit'] }));
    expect((await screen.findByTestId('failed')).getAttribute('data-reason')).toBe('general');
    await user.click(within(form).getByRole('button', { name: vi_['bi.lin.submit'] }));
    expect(await screen.findByTestId('levels')).toBeTruthy();
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('asks for a metric before it asks the server when there is none to choose', async () => {
    const h = client(() => GRAPH);
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => Promise.resolve([]));
    mount(<MetricLineageScreen route={ROUTE} />, h, { permissions: READ });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.lin.form.title'] });
    await user.click(within(form).getByRole('button', { name: vi_['bi.lin.submit'] }));
    expect(await within(form).findByText(vi_['bi.lin.metric.required'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('starts over when the member or the tenant changes: what was asked is not carried to another', async () => {
    const h = client(() => GRAPH);
    withMetrics(h);
    const view = mount(<MetricLineageScreen route={ROUTE} />, h, { permissions: READ });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.lin.form.title'] });
    await waitFor(() => expect(within(within(form).getByLabelText(vi_['bi.lin.metric'])).getAllByRole('option')).toHaveLength(2));
    await user.click(within(form).getByRole('button', { name: vi_['bi.lin.submit'] }));
    await screen.findByTestId('levels');
    view.rerenderWith({ permissions: READ, tenant: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Khác', membershipId: '00000000-0000-4000-8000-000000000001' } as never });
    await waitFor(() => expect(screen.getByTestId('ask-first')).toBeTruthy());
  });

  it('UI-BI-14 shows the loading state while the graph is read, and names the page', async () => {
    const h = harness((operation) => (operation === 'getBiLineage' ? (new Promise(() => undefined) as never) : new Error('unexpected')));
    const { user, form } = await open(h as ReturnType<typeof client>);
    await user.click(within(form).getByRole('button', { name: vi_['bi.lin.submit'] }));
    expect(await screen.findByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(screen.getByRole('region', { name: vi_['bi.lin.title'] })).toBeTruthy();
  });

  it('shows the offline state of the network as a general failure of the read', async () => {
    const { user, form } = await open(client(() => new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })));
    await user.click(within(form).getByRole('button', { name: vi_['bi.lin.submit'] }));
    expect((await screen.findByTestId('failed')).getAttribute('data-reason')).toBe('general');
  });
});

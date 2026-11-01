import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness, mount, routeOf } from '../../mne/test-support';
import LineageScreen from './LineageScreen';
import { DEFAULT_DEPTH, EMPTY_QUERY, describeLineageProblem, levelsOf, queryParams, sameQuery, toGraph, validateQuery } from './model';

const ROUTE = routeOf('DGV-05', 'FR-DGV-05');
const READ = ['data.lineage.read'];
const ME = '00000000-0000-4000-8000-000000000001'; // the member of the session of the test support
const METRIC = '00000000-0000-4000-8000-0000000000b1';
const RUN = '00000000-0000-4000-8000-0000000000c1';
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const node = (key: string, level: number, overrides: Record<string, unknown> = {}) => ({
  key,
  restricted: false,
  node_kind: 'TABLE',
  ref_module: 'DIS',
  ref_id: null,
  ref_key: 'period_snapshot_line',
  display_name: 'Bảng dòng snapshot',
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
    node('n-metric', 0, { node_kind: 'METRIC_VERSION', ref_id: METRIC, ref_key: null, ref_module: 'BI', display_name: 'Tỷ lệ giải ngân U-STC' }),
    { key: 'restricted-1', restricted: true, level: 1 },
    node('n-table', 2),
  ],
  edges: [
    { from: 'restricted-1', to: 'n-metric', run_id: null, transform_version: null, observed_at: null },
    { from: 'n-table', to: 'restricted-1', run_id: null, transform_version: null, observed_at: null },
    { from: 'n-table', to: 'n-metric', run_id: RUN, transform_version: 'dis-snapshot-v1', observed_at: '2026-11-01T00:00:00.000Z' },
  ],
};

function client(answer: (query: Record<string, string>) => unknown) {
  return harness((operation, input) => (operation === 'getLineageGraph' ? answer((input as { query: Record<string, string> }).query) : new Error(`unexpected read ${operation}`)));
}

afterEach(cleanup);

describe('the model of the lineage graph (ST-DGV-006)', () => {
  it('reads a graph, and tells nothing of a restricted node whatever the answer carried', () => {
    const graph = toGraph({ ...GRAPH, nodes: [...GRAPH.nodes.slice(0, 1), { key: 'restricted-1', restricted: true, level: 1, display_name: 'Bí mật', ref_id: METRIC, node_kind: 'TABLE' }] });
    expect(graph?.nodes[1]).toEqual({ key: 'restricted-1', restricted: true, kind: null, module: null, refId: null, refKey: null, name: null, classification: null, level: 1 });
    expect(graph?.nodes[0]).toMatchObject({ kind: 'METRIC_VERSION', name: 'Tỷ lệ giải ngân U-STC', refId: METRIC });
    expect(graph?.edges[2]).toEqual({ from: 'n-table', to: 'n-metric', runId: RUN, transformVersion: 'dis-snapshot-v1', observedAt: '2026-11-01T00:00:00.000Z' });
    expect(toGraph(null)).toBeUndefined();
    expect(toGraph({ start: 'x' })).toBeUndefined();
    const sparse = toGraph({ start: 'x', nodes: [null, { key: 'a', node_kind: 'NONSENSE' }, { level: 2 }], edges: [null, { from: 'a' }] });
    expect(sparse).toMatchObject({ direction: 'upstream', depth: DEFAULT_DEPTH, truncated: false, edges: [] });
    expect(sparse?.nodes).toEqual([{ key: 'a', restricted: false, kind: null, module: null, refId: null, refKey: null, name: null, classification: null, level: 0 }]);
    expect(toGraph({ ...GRAPH, direction: 'downstream', truncated: true })).toMatchObject({ direction: 'downstream', truncated: true });
  });

  it('takes the same question in other letters and blanks for the same one', () => {
    const query = { kind: 'RECORD' as const, refId: METRIC, direction: 'upstream' as const, depth: 3 };
    expect(sameQuery(query, { ...query, refId: ` ${METRIC.toUpperCase()} ` })).toBe(true);
    expect(sameQuery(query, { ...query, depth: 4 })).toBe(false);
    expect(sameQuery(query, { ...query, kind: 'TABLE' })).toBe(false);
    expect(sameQuery(query, { ...query, direction: 'downstream' })).toBe(false);
    expect(sameQuery(query, { ...query, refId: RUN })).toBe(false);
  });

  it('groups the nodes by level, nearest first', () => {
    const graph = toGraph(GRAPH);
    expect(levelsOf(graph!).map(({ level, nodes }) => [level, nodes.length])).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
  });

  it('checks the id asked for and writes the query as the contract has it', () => {
    expect(validateQuery(EMPTY_QUERY)).toEqual({ refId: 'required' });
    expect(validateQuery({ ...EMPTY_QUERY, refId: 'nope' })).toEqual({ refId: 'invalid' });
    expect(validateQuery({ ...EMPTY_QUERY, refId: METRIC })).toEqual({});
    expect(queryParams({ kind: 'RECORD', refId: ` ${METRIC.toUpperCase()} `, direction: 'downstream', depth: 5 })).toEqual({
      node_kind: 'RECORD',
      ref_id: METRIC,
      direction: 'downstream',
      depth: '5',
    });
  });

  it.each([
    [failure(404, 'RESOURCE_NOT_FOUND'), 'notFound'],
    [failure(403, 'SCOPE_DENIED'), 'scope'],
    [failure(422, 'VALIDATION_FAILED'), 'invalid'],
    [failure(500, 'BOOM'), 'general'],
    [new Error('x'), 'general'],
  ])('names the reason of a refusal by the code of the server: %#', (error, reason) => {
    expect(describeLineageProblem(error)).toBe(reason);
  });
});

describe('DGV-05 lineage of the whole system (ST-DGV-006)', () => {
  async function ask(h: ReturnType<typeof client>, options: { direction?: string; depth?: string; kind?: string } = {}) {
    mount(<LineageScreen route={ROUTE} />, h, { permissions: READ });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['dgv.lin.form.title'] });
    if (options.kind !== undefined) await user.selectOptions(within(form).getByLabelText(vi_['dgv.lin.kind']), options.kind);
    await user.type(within(form).getByLabelText(vi_['dgv.lin.ref']), METRIC);
    if (options.direction !== undefined) await user.selectOptions(within(form).getByLabelText(vi_['dgv.lin.direction']), options.direction);
    if (options.depth !== undefined) await user.selectOptions(within(form).getByLabelText(vi_['dgv.lin.depth']), options.depth);
    await user.click(within(form).getByRole('button', { name: vi_['dgv.lin.submit'] }));
    return user;
  }

  it('asks the graph of the node chosen and draws it level by level, each edge with its run and the version of its transform, and the restricted node with nothing of its own', async () => {
    const h = client(() => GRAPH);
    expect(screen.queryByTestId('levels')).toBeNull();
    await ask(h, { kind: 'METRIC_VERSION', direction: 'upstream', depth: '4' });
    const levels = await screen.findByTestId('levels');
    expect(h.read).toHaveBeenCalledWith('getLineageGraph', expect.objectContaining({ query: { node_kind: 'METRIC_VERSION', ref_id: METRIC, direction: 'upstream', depth: '4' } }));
    const items = within(levels)
      .getAllByRole('listitem')
      .filter((item) => item.hasAttribute('data-node'));
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain('Tỷ lệ giải ngân U-STC');
    expect(items[0]?.textContent).toContain(vi_['dgv.lin.kind.metric']);
    expect(items[1]?.getAttribute('data-restricted')).toBe('true');
    expect(items[1]?.textContent).toBe(vi_['dgv.lin.restricted']);
    expect(items[2]?.textContent).toContain('Bảng dòng snapshot');
    expect(within(levels).getByText(vi_['dgv.lin.level.start'])).toBeTruthy();
    expect(within(levels).getByText(fill(vi_['dgv.lin.level.step'], { level: 2 }))).toBeTruthy();
    const rows = within(screen.getByTestId('edges')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.getAttribute('data-restricted')).toBe('true');
    expect(rows[0]?.textContent).toContain(vi_['dgv.lin.restricted']);
    expect(rows[2]?.textContent).toContain(RUN);
    expect(rows[2]?.textContent).toContain('dis-snapshot-v1');
    expect(rows[2]?.getAttribute('data-restricted')).toBe('false');
    expect(screen.queryByTestId('truncated')).toBeNull();
  });

  it('draws the parallel steps of two nodes one row each, even when a restricted node hides their transform', async () => {
    const hidden = { from: 'n-table', to: 'restricted-1', run_id: null, transform_version: null, observed_at: null };
    const complaints = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await ask(client(() => ({ ...GRAPH, edges: [hidden, { ...hidden }, { ...hidden }] })));
      const rows = within(await screen.findByTestId('edges'))
        .getAllByRole('row')
        .slice(1);
      expect(rows).toHaveLength(3);
      expect(complaints.mock.calls.flat().join(' ')).not.toContain('same key');
    } finally {
      complaints.mockRestore();
    }
  });

  it('asks the server again when the same question is submitted again: a failure is tried once more', async () => {
    let answers = 0;
    const h = client(() => (answers++ === 0 ? failure(500, 'BOOM') : GRAPH));
    const user = await ask(h);
    expect((await screen.findByTestId('failed')).getAttribute('data-reason')).toBe('general');
    await user.click(screen.getByRole('button', { name: vi_['dgv.lin.submit'] }));
    expect(await screen.findByTestId('levels')).toBeTruthy();
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('asks for the direction and the depth that are chosen, and says when the graph was cut', async () => {
    const h = client(() => ({ ...GRAPH, direction: 'downstream', truncated: true }));
    await ask(h, { direction: 'downstream', depth: '6' });
    expect((await screen.findByTestId('truncated')).textContent).toBe(vi_['dgv.lin.truncated']);
    expect(h.read).toHaveBeenCalledWith('getLineageGraph', expect.objectContaining({ query: expect.objectContaining({ direction: 'downstream', depth: '6' }) }));
  });

  it('asks for the id before it asks anything of the server, and judges the id it is given', async () => {
    const h = client(() => GRAPH);
    mount(<LineageScreen route={ROUTE} />, h, { permissions: READ });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['dgv.lin.form.title'] });
    expect(screen.getByTestId('ask-first').textContent).toBe(vi_['dgv.lin.choose']);
    await user.click(within(form).getByRole('button', { name: vi_['dgv.lin.submit'] }));
    expect(await within(form).findByText(vi_['dgv.lin.ref.required'])).toBeTruthy();
    await user.type(within(form).getByLabelText(vi_['dgv.lin.ref']), 'nope');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.lin.submit'] }));
    expect(await within(form).findByText(vi_['dgv.lin.ref.invalid'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it.each([
    [failure(404, 'RESOURCE_NOT_FOUND'), 'notFound', vi_['dgv.lin.reason.notFound']],
    [failure(403, 'SCOPE_DENIED'), 'scope', vi_['dgv.lin.reason.scope']],
    [failure(422, 'VALIDATION_FAILED'), 'invalid', vi_['dgv.lin.reason.invalid']],
    [failure(500, 'BOOM'), 'general', vi_['dgv.lin.reason.general']],
    [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c', extensions: {} }), 'general', vi_['dgv.lin.reason.general']],
  ])('UI-DGV-05 tells why the graph was not given: %#', async (error, reason, message) => {
    const h = client(() => error);
    await ask(h);
    const failed = await screen.findByTestId('failed');
    expect(failed.getAttribute('data-reason')).toBe(reason);
    expect(failed.textContent).toBe(message);
    expect(screen.queryByTestId('levels')).toBeNull();
  });

  it('UI-DGV-05 shows the loading state while the graph is read, and names the page', async () => {
    const h = harness(() => new Promise(() => undefined) as never);
    (h.client as unknown as { read: unknown }).read = vi.fn(() => new Promise(() => undefined));
    await ask(h);
    expect(await screen.findByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(screen.getByRole('region', { name: vi_['dgv.lin.title'] })).toBeTruthy();
  });

  it('starts over when the member or the tenant changes: what was asked is not carried to another', async () => {
    const h = client(() => GRAPH);
    const view = mount(<LineageScreen route={ROUTE} />, h, { permissions: READ });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['dgv.lin.form.title'] });
    await user.type(within(form).getByLabelText(vi_['dgv.lin.ref']), METRIC);
    await user.click(within(form).getByRole('button', { name: vi_['dgv.lin.submit'] }));
    expect(await screen.findByTestId('levels')).toBeTruthy();
    view.rerenderWith({ permissions: READ, tenant: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Khác', membershipId: ME } as never });
    await waitFor(() => expect(screen.queryByTestId('levels')).toBeNull());
    expect((screen.getByLabelText(vi_['dgv.lin.ref']) as HTMLInputElement).value).toBe('');
  });
});

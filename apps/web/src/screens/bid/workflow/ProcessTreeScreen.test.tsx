import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as translate } from '../../../i18n';
import ProcessTreeScreen from './ProcessTreeScreen';
import { READER, client, mount, route, treeDto, world } from './test-support';
import type { World } from './test-support';

const ROUTE = route('BID-27', 'FR-BID-27');
const text = (key: string, params: Record<string, string | number> = {}): string => translate(key, params);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { permissions?: readonly string[]; path?: string } = {}) {
  const h = client(state);
  const { queries } = mount(<ProcessTreeScreen route={ROUTE} />, h, { permissions: options.permissions ?? READER, path: options.path ?? '/bid/bid-27' });
  return Object.assign(h, { queries });
}

const treeitem = (name: RegExp) => screen.getByRole('treeitem', { name });
const failing = (operation: string, error: Error, times = Infinity): Map<string, { error: Error; times: number }> => new Map([[operation, { error, times }]]);

describe('ProcessTreeScreen (BID-27): the progress tree', () => {
  it('shows the figures of the scope with their formulas, and the tree with the count of every state as text', async () => {
    open(world());
    expect(await screen.findByRole('tree', { name: text('prc1.tree.caption.text') })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(text('prc1.tree.page.title'));
    const group = screen.getByRole('group', { name: text('prc1.kpi.group.label') });
    expect(within(group).getByText('4')).toBeInTheDocument();
    expect(within(group).getByText('400,00')).toBeInTheDocument();
    expect(within(group).getAllByRole('button', { name: /Công thức và nguồn của/ })).toHaveLength(6);
    expect(treeitem(/Lập hồ sơ mời thầu, 2 gói thầu, giá trị 200,00 tỷ đồng, 1 trễ hạn/)).toBeInTheDocument();
    expect(treeitem(/Chưa bắt đầu, 1 gói thầu/)).toBeInTheDocument();
    expect(screen.getByText(/Màn hình BID-27 · FR-BID-27/)).toBeInTheDocument();
  });

  it('asks the server for the filters it was given, and keeps them when the view changes', async () => {
    const h = open(world(), { path: '/bid/bid-27?method=OPEN_BIDDING&late_only=true' });
    await screen.findByRole('tree');
    expect(h.read).toHaveBeenCalledWith('getPackageProcessTree', { query: { method: 'OPEN_BIDDING', late_only: true } });
    expect(screen.getByRole('tab', { name: text('prc1.views.board.name') })).toHaveAttribute('href', '/bid/bid-28?method=OPEN_BIDDING&late_only=true');
    expect(screen.getByRole('tab', { name: text('prc1.views.list.name') })).toHaveAttribute('href', '/bid/bid-28?method=OPEN_BIDDING&late_only=true&view=list');
    expect(screen.getByRole('tab', { name: text('prc1.views.tree.name') })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens a node: its numbers, then its packages with a link to the package page, then what changed in it', async () => {
    const h = open(world());
    await userEvent.click(await screen.findByText('Lập hồ sơ mời thầu'));
    const panel = await screen.findByRole('complementary', { name: text('prc1.panel.title.label', { label: 'Lập hồ sơ mời thầu' }) });
    expect(h.read).toHaveBeenCalledWith('getPackageProcessTreeNode', { query: { node_id: 'S:OPEN_BIDDING:DOC_PREPARE' } });
    expect(await within(panel).findByText('6 ngày')).toBeInTheDocument();
    expect(within(panel).getByText('Tiêu chí đánh giá đã chốt: 2 gói chưa xong')).toBeInTheDocument();
    expect(within(panel).getByText('Nguyễn Văn An: 2 gói')).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole('tab', { name: text('prc1.panel.packages.name') }));
    const table = await within(panel).findByRole('table', { name: text('prc1.panel.packages.caption', { label: 'Lập hồ sơ mời thầu' }) });
    const link = within(table).getByRole('link', { name: 'GT-1' });
    expect(link.getAttribute('href')).toContain('/bid/bid-29?package=');
    expect(link.getAttribute('href')).toContain('node=S%3AOPEN_BIDDING%3ADOC_PREPARE');
    expect(within(table).getByText('Quá hạn 3 ngày · 09/11')).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole('tab', { name: text('prc1.panel.changes.name') }));
    expect(await within(panel).findByText('GT-1: chuyển từ PLAN_SELECTION sang Lập hồ sơ mời thầu')).toBeInTheDocument();
    expect(h.read).toHaveBeenCalledWith('getPackageProcessTreeNodeFeed', { query: { node_id: 'S:OPEN_BIDDING:DOC_PREPARE', limit: '30' } });
  });

  it('closes the panel with Escape and puts the focus back on the node', async () => {
    open(world(), { path: '/bid/bid-27?node=S%3AOPEN_BIDDING%3ADOC_PREPARE' });
    const panel = await screen.findByRole('complementary');
    fireEvent.keyDown(within(panel).getByRole('tab', { name: text('prc1.panel.overview.name') }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('complementary')).not.toBeInTheDocument());
    await waitFor(() => expect(treeitem(/Lập hồ sơ mời thầu/)).toHaveFocus());
  });

  it('narrows the packages of a node by the filters of the tree', async () => {
    const h = open(world(), { path: '/bid/bid-27?node=S%3AOPEN_BIDDING%3ADOC_PREPARE&method=OPEN_BIDDING&from=2026-10-01' });
    const panel = await screen.findByRole('complementary');
    await userEvent.click(within(panel).getByRole('tab', { name: text('prc1.panel.packages.name') }));
    await within(panel).findByRole('table');
    expect(h.read).toHaveBeenCalledWith('listPackageProcessTreeNodePackages', { query: { node_id: 'S:OPEN_BIDDING:DOC_PREPARE', method: 'OPEN_BIDDING', limit: '20' } });
  });

  it('loading shows skeletons and no number', async () => {
    const state = world();
    const h = client(state);
    h.read.mockImplementation(() => new Promise(() => undefined));
    mount(<ProcessTreeScreen route={ROUTE} />, h, { permissions: READER, path: '/bid/bid-27' });
    const status = await screen.findByRole('status', { name: text('ui.processTree.loading.label') });
    expect(status.textContent).not.toMatch(/\d/);
    const tiles = screen.getAllByRole('status', { name: /Đang tải/ });
    expect(tiles.length).toBeGreaterThan(1);
  });

  it('error names the failure and retries in place', async () => {
    const state = world({ failing: failing('getPackageProcessTree', new Error('down'), 1) });
    const h = open(state);
    expect(await screen.findByRole('alert')).toHaveTextContent(text('ui.processTree.error.message'));
    await userEvent.click(screen.getByRole('button', { name: text('ui.common.retry') }));
    expect(await screen.findByRole('tree')).toBeInTheDocument();
    expect(h.read.mock.calls.filter(([operation]) => operation === 'getPackageProcessTree')).toHaveLength(2);
  });

  it('denied says the scope is hidden and leaks no name', async () => {
    open(world({ failing: failing('getPackageProcessTree', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })) }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text('states.denied.title'));
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
    expect(screen.queryByText('Quy trình đấu thầu rộng rãi')).not.toBeInTheDocument();
  });

  it.each([
    ['none', '/bid/bid-27', text('ui.processTree.empty.none')],
    ['filtered', '/bid/bid-27?method=SPECIAL_CASE', text('ui.processTree.empty.filtered')],
  ])('empty (%s) says which kind', async (_kind, path, message) => {
    open(world({ tree: treeDto({ total: { count: 0, value_vnd: '0' }, nodes: [], edges: [], kpis: { running: 0, late: 0, stalled: 0, on_hold: 0, no_owner: 0, median_days: null } }) as never }), { path });
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('partial: a read cut at the limit says the figures are a lower bound', async () => {
    open(world({ tree: treeDto({ truncated: true }) as never }));
    expect(await screen.findByText(text('prc1.truncated.text'))).toBeInTheDocument();
    expect(screen.getByRole('tree')).toBeInTheDocument();
  });

  it('stale: when a refresh fails the last figures stay, marked as old, with a retry', async () => {
    const state = world();
    const h = open(state);
    await screen.findByRole('tree');
    state.failing = failing('getPackageProcessTree', new Error('down'));
    await h.queries.invalidateQueries();
    expect(await screen.findByText(/Số liệu cũ · cập nhật/)).toBeInTheDocument();
    expect(screen.getByRole('tree')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(text('prc1.error.source.text'));
    state.failing = new Map();
    await userEvent.click(screen.getByRole('button', { name: text('ui.common.retry') }));
    await waitFor(() => expect(screen.queryByText(/Số liệu cũ · cập nhật/)).not.toBeInTheDocument());
  });

  it('shows the health as a word with the count, never by colour alone', async () => {
    open(world());
    await screen.findByRole('tree');
    const prep = treeitem(/Lập hồ sơ mời thầu/);
    // One of the two packages is late: half of the node is over the share (30%) from which a node is said to be late.
    expect(within(prep).getByText(text('ui.processTree.health.late'))).toBeInTheDocument();
    expect(within(treeitem(/Đánh giá hồ sơ dự thầu/)).getByText(text('ui.processTree.health.hold'))).toBeInTheDocument();
  });
});

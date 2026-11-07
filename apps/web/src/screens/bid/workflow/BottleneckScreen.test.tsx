import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as translate } from '../../../i18n';
import BottleneckScreen from './BottleneckScreen';
import { READER, client, mount, route, world } from './test-support';
import type { World } from './test-support';

const ROUTE = route('BID-30', 'FR-BID-30');
const text = (key: string, params: Record<string, string | number> = {}): string => translate(key, params);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, path = '/bid/bid-30') {
  const h = client(state);
  mount(<BottleneckScreen route={ROUTE} />, h, { permissions: READER, path });
  return h;
}
const failing = (error: Error): Map<string, { error: Error; times: number }> => new Map([['getPackageWorkflowStatistics', { error, times: Infinity }]]);

describe('BottleneckScreen (BID-30): where the days go', () => {
  it('shows the on-time share and the median of the period with their formulas, the steps with their figures and the stuck packages', async () => {
    const h = open(world());
    const table = await screen.findByRole('table', { name: text('prc1.analysis.table.caption') });
    expect(h.read).toHaveBeenCalledWith('getPackageWorkflowStatistics', { query: {} });
    const group = screen.getByRole('group', { name: text('prc1.kpi.group.label') });
    expect(within(group).getByText('66,67%')).toBeInTheDocument();
    expect(within(group).getAllByRole('button', { name: /Công thức và nguồn của/ }).length).toBeGreaterThanOrEqual(2);
    const row = within(table).getByText('Lập hồ sơ mời thầu').closest('tr') as HTMLElement;
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent).slice(0, 6)).toEqual(['Đấu thầu rộng rãi', 'Lập hồ sơ mời thầu', '3', '9', '66,67%', '2']);
    expect(screen.getByRole('link', { name: 'GT-1' }).getAttribute('href')).toContain('/bid/bid-29?package=');
    expect(screen.getByText(text('ui.processTree.health.late'))).toBeInTheDocument();
  });

  it('says a step nobody left in the period has no median, never 0', async () => {
    open(world());
    const table = await screen.findByRole('table', { name: text('prc1.analysis.table.caption') });
    const row = within(table).getByText('Đánh giá hồ sơ dự thầu').closest('tr') as HTMLElement;
    const cells = within(row).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells.slice(2, 5)).toEqual(['0', text('prc1.column.none.text'), text('prc1.column.none.text')]);
  });

  it('says when the days are calendar days', async () => {
    const state = world();
    (state.statistics.steps as Array<Record<string, unknown>>)[0]!.basis = 'CALENDAR_DAYS';
    open(state);
    expect(await screen.findByText('9 (ngày dương lịch)')).toBeInTheDocument();
  });

  it('exports the report of the period as Excel or CSV and saves the bytes the server sent', async () => {
    const saved: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => { saved.push(blob); return 'blob:y'; });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const h = open(world(), '/bid/bid-30?method=OPEN_BIDDING&from=2026-10-01&to=2026-10-31');
    await screen.findByRole('table', { name: text('prc1.analysis.table.caption') });
    await userEvent.click(screen.getByRole('button', { name: text('prc1.analysis.export.xlsx') }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('exportPackageWorkflowReport', { query: { method: 'OPEN_BIDDING', from: '2026-10-01', to: '2026-10-31', format: 'xlsx' } }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.size).toBe(3);
    expect(await screen.findByText('Đã xuất bao-cao.xlsx')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: text('prc1.analysis.export.csv') }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('exportPackageWorkflowReport', expect.objectContaining({ query: expect.objectContaining({ format: 'csv' }) })));
  });

  it('loading is a skeleton and never a number', async () => {
    const h = client(world());
    h.read.mockImplementation(() => new Promise(() => undefined));
    mount(<BottleneckScreen route={ROUTE} />, h, { permissions: READER, path: '/bid/bid-30' });
    const tiles = await screen.findAllByRole('status', { name: /Đang tải/ });
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) expect(tile.textContent).not.toMatch(/\d/);
  });

  it('error retries in place and denied hides the scope', async () => {
    const state = world({ failing: failing(new Error('down')) });
    const h = open(state);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    state.failing = new Map();
    await userEvent.click(screen.getByRole('button', { name: text('states.retry.action') }));
    expect(await screen.findByRole('table', { name: text('prc1.analysis.table.caption') })).toBeInTheDocument();
    expect(h.read.mock.calls.filter(([operation]) => operation === 'getPackageWorkflowStatistics')).toHaveLength(2);
    cleanup();
    open(world({ failing: failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })) }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text('states.denied.title'));
  });

  it('empty says there is nothing in the period, and partial says the read was cut', async () => {
    const empty = world();
    empty.statistics = { ...empty.statistics, steps: [], stuck: [], kpis: { on_time_share: null, completed_visits: 0, median_days: null, basis: 'WORKING_DAYS' } };
    open(empty);
    expect(await screen.findByText(text('states.empty.title'))).toBeInTheDocument();
    cleanup();
    const cut = world();
    cut.statistics = { ...cut.statistics, truncated: true };
    open(cut);
    expect(await screen.findByText(text('prc1.truncated.text'))).toBeInTheDocument();
  });
});

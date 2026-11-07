import { ApiError } from '@machvon/api-client';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { t as translate } from '../../i18n';
import { client, mount, world } from '../../screens/bid/workflow/test-support';
import { FunnelCard } from './FunnelCard';

const text = (key: string, params: Record<string, string | number> = {}): string => translate(key, params);

afterEach(cleanup);

function open(permissions: readonly string[] | undefined = ['bid.read'], failure?: Error) {
  const state = world();
  if (failure !== undefined) state.failing = new Map([['getPackageWorkflowSummary', { error: failure, times: Infinity }]]);
  const h = client(state);
  mount(<FunnelCard />, h, { permissions });
  return { h, state };
}

describe('FunnelCard (PWA dashboard)', () => {
  it('lists the steps with most packages, each with its count and in words whether some are late, and links to the tree', async () => {
    const { h } = open();
    const list = await screen.findByRole('list', { name: text('prc1.funnel.list.label') });
    expect(h.read).toHaveBeenCalledWith('getPackageWorkflowSummary', { query: {} });
    const row = within(list).getByText('Lập hồ sơ mời thầu').closest('li') as HTMLElement;
    expect(within(row).getByText('2 gói thầu')).toBeInTheDocument();
    expect(within(row).getByText('1 trễ hạn')).toBeInTheDocument();
    expect(screen.getByText('3 gói đang xử lý · 1 gói trễ hạn · 1 gói chưa có người phụ trách')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: text('prc1.funnel.link.action') })).toHaveAttribute('href', '/bid/bid-27');
  });

  it('loading is a skeleton with no number', () => {
    const h = client(world());
    h.read.mockImplementation(() => new Promise(() => undefined));
    mount(<FunnelCard />, h, { permissions: ['bid.read'] });
    const status = screen.getByRole('status', { name: text('prc1.funnel.loading.label') });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status.textContent).not.toMatch(/\d/);
  });

  it('error says so and retries in place', async () => {
    const { h, state } = open(['bid.read'], new Error('down'));
    expect(await screen.findByRole('alert')).toHaveTextContent(text('prc1.funnel.error.text'));
    state.failing = new Map();
    await userEvent.click(screen.getByRole('button', { name: text('ui.common.retry') }));
    expect(await screen.findByRole('list', { name: text('prc1.funnel.list.label') })).toBeInTheDocument();
    expect(h.read.mock.calls.filter(([operation]) => operation === 'getPackageWorkflowSummary')).toHaveLength(2);
  });

  it('denied says the scope is hidden: by the server, and without even asking when the right is missing', async () => {
    open(['bid.read'], new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
    expect(await screen.findByText(text('prc1.funnel.denied.text'))).toBeInTheDocument();
    cleanup();
    const { h } = open(['home.read']);
    expect(screen.getByText(text('prc1.funnel.denied.text'))).toBeInTheDocument();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('empty says there is no package, partial says the figures are incomplete', async () => {
    const h = client(world());
    h.read.mockResolvedValue({ total: 0, running: 0, not_started: 0, completed: 0, late: 0, stalled: 0, on_hold: 0, no_owner: 0, top_steps: [], truncated: false, as_of: '2026-11-12T03:00:00.000Z' });
    mount(<FunnelCard />, h, { permissions: ['bid.read'] });
    expect(await screen.findByText(text('prc1.funnel.empty.text'))).toBeInTheDocument();
    cleanup();
    const cut = client(world());
    cut.read.mockResolvedValue({ total: 4, running: 3, not_started: 1, completed: 0, late: 1, stalled: 0, on_hold: 0, no_owner: 0, top_steps: [{ node_id: 'S:A:B', method: 'A', code: 'B', name: null, count: 3, late_count: 0 }], truncated: true, as_of: '2026-11-12T03:00:00.000Z' });
    mount(<FunnelCard />, cut, { permissions: ['bid.read'] });
    expect(await screen.findByText(text('prc1.funnel.partial.text'))).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.getByText(text('ui.processTree.health.ok'))).toBeInTheDocument();
  });
});

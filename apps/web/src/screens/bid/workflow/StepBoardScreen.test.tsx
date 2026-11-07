import { ApiError } from '@machvon/api-client';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as translate } from '../../../i18n';
import StepBoardScreen from './StepBoardScreen';
import { READER, client, mount, route, world } from './test-support';
import type { World } from './test-support';

const ROUTE = route('BID-28', 'FR-BID-28');
const text = (key: string, params: Record<string, string | number> = {}): string => translate(key, params);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, path = '/bid/bid-28') {
  const h = client(state);
  mount(<StepBoardScreen route={ROUTE} />, h, { permissions: READER, path });
  return h;
}
const failing = (operation: string, error: Error): Map<string, { error: Error; times: number }> => new Map([[operation, { error, times: Infinity }]]);

describe('StepBoardScreen (BID-28): the packages by step', () => {
  it('draws a column for each step with its count and value, and a card for each package of it', async () => {
    const h = open(world());
    const region = await screen.findByRole('region', { name: text('prc1.board.region.label', { method: 'Quy trình đấu thầu rộng rãi' }) });
    expect(h.read).toHaveBeenCalledWith('getPackageWorkflowBoard', { query: {} });
    const column = within(region).getByRole('region', { name: 'Lập hồ sơ mời thầu' }) as HTMLElement;
    expect(column.textContent).toContain('3');
    expect(column.textContent).toContain('300,00 tỷ đồng');
    const cards = within(column).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    const late = cards[0] as HTMLElement;
    expect(within(late).getByRole('link', { name: 'GT-1' }).getAttribute('href')).toBe(`/bid/bid-29?package=${'00000000-0000-4000-8000-002000000001'}`);
    expect(within(late).getByText('Trễ 3 ngày')).toBeInTheDocument();
    expect(within(late).getByText(/Nguyễn Văn An/)).toBeInTheDocument();
    expect(within(late).getByText(/PRJ-001 · 100,00 tỷ đồng/)).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText('Còn 2 ngày · 14/11')).toBeInTheDocument();
  });

  it('says how many more packages a column has than its cards and links to the list of that step', async () => {
    open(world());
    const more = await screen.findByRole('link', { name: text('prc1.board.column.more.text', { count: 1 }) });
    expect(more.getAttribute('href')).toBe('/bid/bid-28?view=list&step=DOC_PREPARE&method=OPEN_BIDDING');
  });

  it('keeps an empty step in the structure with its zero as text', async () => {
    open(world());
    const column = (await screen.findByRole('region', { name: 'Đánh giá hồ sơ dự thầu' })) as HTMLElement;
    expect(column.textContent).toContain('0');
    expect(within(column).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('shows the list view, asks for a step and for the packages on hold or without an owner, and pages by cursor', async () => {
    const h = open(world(), '/bid/bid-28?view=list&step=DOC_PREPARE');
    const table = await screen.findByRole('table', { name: text('prc1.list.caption.text') });
    expect((await within(table).findAllByRole('link')).map((link) => link.textContent)).toEqual(['GT-1', 'GT-2']);
    expect(h.read).toHaveBeenCalledWith('listPackageWorkflows', { query: { step: 'DOC_PREPARE', limit: '20' } });
    await userEvent.click(screen.getByRole('checkbox', { name: text('prc1.list.hold.label') }));
    await screen.findAllByRole('link', { name: 'GT-1' });
    expect(h.read).toHaveBeenCalledWith('listPackageWorkflows', { query: { step: 'DOC_PREPARE', on_hold: true, limit: '20' } });
    expect(screen.getByRole('button', { name: text('prc1.pager.next.action') })).toBeDisabled();
    expect(screen.getByRole('tab', { name: text('prc1.views.list.name') })).toHaveAttribute('aria-selected', 'true');
  });

  it('asks the server for the filters of the address', async () => {
    const h = open(world(), '/bid/bid-28?method=DIRECT_PURCHASE&owner_id=00000000-0000-4000-8000-0000000000b7&late_only=true&from=2026-10-01');
    await screen.findByRole('region', { name: /Các cột theo bước/ });
    expect(h.read).toHaveBeenCalledWith('getPackageWorkflowBoard', { query: { method: 'DIRECT_PURCHASE', owner_id: '00000000-0000-4000-8000-0000000000b7', late_only: true } });
  });

  it('loading is a skeleton and never a number', async () => {
    const h = client(world());
    h.read.mockImplementation(() => new Promise(() => undefined));
    mount(<StepBoardScreen route={ROUTE} />, h, { permissions: READER, path: '/bid/bid-28' });
    const status = await screen.findByRole('status', { name: text('prc1.board.loading.label') });
    expect(status.textContent).not.toMatch(/\d/);
  });

  it('error retries in place, and denied says the scope is hidden', async () => {
    const state = world({ failing: failing('getPackageWorkflowBoard', new Error('down')) });
    const h = open(state);
    expect(await screen.findByRole('alert')).toHaveTextContent(text('prc1.board.error.text'));
    state.failing = new Map();
    await userEvent.click(screen.getByRole('button', { name: text('ui.common.retry') }));
    expect(await screen.findByRole('region', { name: /Các cột theo bước/ })).toBeInTheDocument();
    expect(h.read.mock.calls.filter(([operation]) => operation === 'getPackageWorkflowBoard')).toHaveLength(2);
    cleanup();
    open(world({ failing: failing('getPackageWorkflowBoard', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })) }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text('states.denied.title'));
  });

  it.each([
    ['none', '/bid/bid-28', text('prc1.board.empty.none')],
    ['filtered', '/bid/bid-28?project_id=00000000-0000-4000-8000-000000000030', text('prc1.board.empty.filtered')],
  ])('empty (%s) says which kind', async (_kind, path, message) => {
    const empty = world();
    (empty.board as { columns: Array<Record<string, unknown>> }).columns = [{ code: 'DOC_PREPARE', name: 'Lập hồ sơ mời thầu', order: 1, kind: 'STEP', standard_working_days: 15, count: 0, value_vnd: '0', late_count: 0, held_count: 0, cards: [] }];
    open(empty, path);
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('partial: a read cut at the limit says so', async () => {
    const cut = world();
    cut.board.truncated = true;
    open(cut);
    expect(await screen.findByText(text('prc1.truncated.text'))).toBeInTheDocument();
  });
});

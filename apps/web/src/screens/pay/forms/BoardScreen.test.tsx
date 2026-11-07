import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { message } from '../../ctr/test-catalogue';
import BoardScreen from './BoardScreen';
import { READER, checked, client, mount, paymentId, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PAY-04', 'FR-PAY-04');
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World) {
  const h = client(state);
  mount(<BoardScreen route={ROUTE} />, h, { permissions: READER, path: '/pay/pay-04' });
  return h;
}

const rowOf = (id: string): HTMLElement | null => document.querySelector(`[data-testid="status"][data-request="${id}"]`)?.closest('tr') ?? null;

describe('BoardScreen (PAY-04): the requests on their way to the Treasury', () => {
  it('UI-PAY-04: lists the requests that were checked and that were sent, with the forms that stand, the day and the number, each a link to its forms', async () => {
    const sent = checked(2, { status: 'SENT_TREASURY', treasury_submitted_on: '2026-07-24', treasury_ref: 'KB-2026-0001', forms_standing: ['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT'] });
    const waiting = checked(1, { forms_standing: ['03.a/TT', '04.a/TT'] });
    const draft = { ...checked(3), status: 'DRAFT' };
    open(world({ payments: [sent, waiting, draft] }));
    await screen.findByTestId('board');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.board.title']);
    expect(screen.getByText(text('pay.board.footer', { id: 'PAY-04', req: 'FR-PAY-04' }))).toBeTruthy();
    expect(within(screen.getByTestId('board')).getAllByRole('row')).toHaveLength(3);
    expect(rowOf(paymentId(3))).toBeNull();
    const first = rowOf(paymentId(2)) as HTMLElement;
    expect(within(first).getByTestId('status').textContent).toBe(vi_['pay.payment.status.sentTreasury']);
    expect(within(first).getByTestId('forms').textContent).toBe(text('pay.board.forms', { count: 4, total: 4 }));
    expect(within(first).getByTestId('sent-on').textContent).toBe('2026-07-24');
    expect(within(first).getByTestId('ref').textContent).toBe('KB-2026-0001');
    expect(within(first).getByTestId('net').textContent).toBe('2.100.000.000');
    expect(within(first).getByTestId('contract').textContent).toBe('HD-A-001');
    expect((within(first).getByTestId('open') as HTMLAnchorElement).getAttribute('href')).toBe(`/pay/pay-14?request=${paymentId(2)}`);
    expect((within(first).getByTestId('detail') as HTMLAnchorElement).getAttribute('href')).toBe(`/pay/pay-03?request=${paymentId(2)}`);
    const second = rowOf(paymentId(1)) as HTMLElement;
    expect(within(second).getByTestId('forms').textContent).toBe(text('pay.board.forms', { count: 2, total: 4 }));
    expect(within(second).getByTestId('sent-on').textContent).toBe('');
  });

  it('says so when nothing waits for the Treasury, and shows the state of a failed read', async () => {
    open(world({ payments: [] }));
    expect((await screen.findByTestId('nothing')).textContent).toBe(vi_['pay.board.empty']);
    cleanup();
    open(world({ failing: new Set(['get_resources_payment_request']) }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });
  it('names the scope and how many requests are on their way, and shows the money in dong', async () => {
    open(world({ payments: [checked(1), checked(2)] }));
    await screen.findByTestId('board');
    const bar = screen.getByRole('group', { name: vi_['ui.contextBar.label'] });
    expect(bar.textContent).toContain(message('w2pay.pay.board.ctx.count', { count: 2 }));
    expect(bar.textContent).toContain(message('ui.unitChip.label', { unit: message('w2pay.ctx.unit') }));
  });
});

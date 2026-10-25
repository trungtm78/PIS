import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import PaymentListScreen from './PaymentListScreen';
import { ACCOUNTANT, READER, client, contractId, mount, payment, paymentId, routeOf, world } from './test-support';
import type { World } from './test-support';


const ROUTE = routeOf('PAY-01', 'PAY', 'FR-PAY-01');
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { path?: string; permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY' } = {}) {
  const h = client(state);
  mount(<PaymentListScreen route={ROUTE} />, h, { permissions: options.permissions ?? READER, path: options.path ?? '/pay/pay-01', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const rowOf = (id: string): HTMLElement => document.querySelector(`tr[data-request="${id}"]`) as HTMLElement;

describe('PaymentListScreen (PAY-01): the payment requests', () => {
  it('UI-PAY-01: lists the requests with the contract, the kind, the value of the work and the amount to pay, each a link to its detail', async () => {
    open(world({ payments: [payment(2, { status: 'CANCELLED', request_kind: 'INTERIM' }), payment(1)] }));
    await screen.findByTestId('payments');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.payment.list.title']);
    expect(screen.getByText(text('pay.payment.list.footer', { id: 'PAY-01', req: 'FR-PAY-01' }))).toBeTruthy();
    const first = rowOf(paymentId(2));
    expect(within(first).getByTestId('contract').textContent).toBe('HD-A-001');
    expect(within(first).getByTestId('kind').textContent).toBe(vi_['pay.payment.kind.interim']);
    expect(within(first).getByTestId('gross').textContent).toBe('3.000.000.000');
    expect(within(first).getByTestId('net').textContent).toBe('2.100.000.000');
    expect(within(first).getByTestId('status').textContent).toBe(vi_['pay.payment.status.cancelled']);
    expect(within(first).getByTestId('status').className).toContain('warning');
    expect(within(rowOf(paymentId(1))).getByTestId('status').className).not.toContain('warning');
    const link = within(rowOf(paymentId(1))).getByTestId('open') as HTMLAnchorElement;
    expect(link.textContent).toBe('DNTT-001');
    expect(link.getAttribute('href')).toBe(`/pay/pay-03?request=${paymentId(1)}`);
  });

  it('offers the form to whoever may draw a request up, for the contract being looked at, and not to a reader or a read-only session', async () => {
    open(world(), { permissions: ACCOUNTANT, path: `/pay/pay-01?contract=${contractId(1)}` });
    const create = (await screen.findByTestId('create')) as HTMLAnchorElement;
    expect(create.getAttribute('href')).toBe(`/pay/pay-02?contract=${contractId(1)}`);
    cleanup();
    open(world(), { permissions: ACCOUNTANT });
    expect(((await screen.findByTestId('create')) as HTMLAnchorElement).getAttribute('href')).toBe('/pay/pay-02');
    cleanup();
    open(world(), { permissions: ACCOUNTANT, mode: 'READ_ONLY' });
    await screen.findByTestId('payments');
    expect(screen.queryByTestId('create')).toBeNull();
    cleanup();
    open(world());
    await screen.findByTestId('payments');
    expect(screen.queryByTestId('create')).toBeNull();
  });

  it('narrows the list by contract and by status through the server, and keeps the choice in the address', async () => {
    const h = open(world({ payments: [payment(1), payment(2, { status: 'CANCELLED' })] }));
    await screen.findByTestId('payments');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    fireEvent.change(screen.getByTestId('filter-status'), { target: { value: 'CANCELLED' } });
    await waitFor(() => expect(document.querySelectorAll('tbody tr')).toHaveLength(1));
    expect(rowOf(paymentId(2))).not.toBeNull();
    const calls = (h.client.readAll as unknown as { mock: { calls: Array<[string, { query?: Record<string, string> }?]> } }).mock.calls.filter((call) => call[0] === 'get_resources_payment_request');
    expect(calls.at(-1)?.[1]?.query).toEqual({ status: 'CANCELLED' });
    fireEvent.change(screen.getByTestId('filter-status'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('filter-contract'), { target: { value: contractId(1) } });
    await waitFor(() => expect(document.querySelectorAll('tbody tr')).toHaveLength(2));
  });

  it('starts from the filter in the address', async () => {
    open(world({ payments: [payment(1), payment(2, { status: 'CANCELLED' })] }), { path: `/pay/pay-01?contract=${contractId(1)}&status=DRAFT` });
    await screen.findByTestId('payments');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    expect((screen.getByTestId('filter-status') as HTMLSelectElement).value).toBe('DRAFT');
    expect((screen.getByTestId('filter-contract') as HTMLSelectElement).value).toBe(contractId(1));
  });

  it('says so when there is no request, and shows the state of a failed read; a reader who may not list contracts still reads the requests', async () => {
    open(world({ payments: [] }));
    expect((await screen.findByTestId('no-payments')).textContent).toBe(vi_['pay.payment.list.empty']);
    cleanup();
    open(world({ failing: new Set(['get_resources_payment_request']) }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    cleanup();
    open(world({ failing: new Set(['get_resources_contract']) }));
    await screen.findByTestId('payments');
    expect((screen.getByTestId('filter-contract') as HTMLSelectElement).options).toHaveLength(1);
  });
});

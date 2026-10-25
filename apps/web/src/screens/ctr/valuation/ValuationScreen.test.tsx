import { ApiError } from '@machvon/api-client';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { READER, client, mount, payment, paymentId, paymentLine, routeOf, world } from '../../pay/payment/test-support';
import type { World } from '../../pay/payment/test-support';
import ValuationScreen from './ValuationScreen';

const ROUTE = routeOf('CTR-13', 'CTR', 'FR-CTR-13');
const PATH = `/ctr/ctr-13?request=${paymentId(1)}`;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, path = PATH) {
  const h = client(state);
  mount(<ValuationScreen route={ROUTE} />, h, { permissions: READER, path });
  return h;
}

const rowOf = (id: string): HTMLElement => document.querySelector(`tr[data-line="${id}"]`) as HTMLElement;

describe('ValuationScreen (CTR-13): how the amount of a payment request is made up', () => {
  it('asks for a request when the address names none', async () => {
    open(world(), '/ctr/ctr-13');
    expect((await screen.findByTestId('no-request')).textContent).toBe(vi_['ctr.valuation.none']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.valuation.title']);
    expect(screen.getByText(text('ctr.valuation.footer', { id: 'CTR-13', req: 'FR-CTR-13' }))).toBeTruthy();
  });

  it('UI-CTR-13: shows each line with the quantity, the price in force, the gross, the advance recovered, the retention and the net, and the totals of the request', async () => {
    open(world());
    await screen.findByTestId('valuation');
    expect(screen.getByTestId('request-no').textContent).toBe('DNTT-001');
    expect(screen.getByTestId('contract').textContent).toBe('HD-A-001');
    expect(screen.getByTestId('status').textContent).toBe(vi_['pay.payment.status.draft']);
    const first = rowOf(paymentLine(1).id);
    expect(within(first).getByTestId('item').textContent).toBe('B01');
    expect(within(first).getByTestId('quantity').textContent).toBe('2.000 M3');
    expect(within(first).getByTestId('price').textContent).toBe('1.000.000');
    expect(within(first).getByTestId('gross').textContent).toBe('2.000.000.000');
    expect(within(first).getByTestId('recovery').textContent).toBe('500.000.000');
    expect(within(first).getByTestId('retention').textContent).toBe('100.000.000');
    expect(within(first).getByTestId('retention').getAttribute('title')).toBe(text('ctr.valuation.retentionRate', { pct: '5' }));
    expect(within(first).getByTestId('net').textContent).toBe('1.400.000.000');
    const second = rowOf(paymentLine(2).id);
    expect(within(second).getByTestId('gross').textContent).toBe('1.000.000.000');
    expect(within(second).getByTestId('net').textContent).toBe('700.000.000');
    expect(screen.getByTestId('total-gross').textContent).toBe('3.000.000.000');
    expect(screen.getByTestId('total-recovery').textContent).toBe('750.000.000');
    expect(screen.getByTestId('total-retention').textContent).toBe('150.000.000');
    expect(screen.getByTestId('total-tax').textContent).toBe('0');
    expect(screen.getByTestId('total-net').textContent).toBe('2.100.000.000');
    expect(screen.queryByTestId('tax-basis')).toBeNull();
    expect((screen.getByText(vi_['ctr.valuation.back']) as HTMLAnchorElement).getAttribute('href')).toBe(`/pay/pay-03?request=${paymentId(1)}`);
    // The table is read-only: nothing to type in.
    expect(document.querySelectorAll('input, textarea, select')).toHaveLength(0);
  });

  it('shows the tax adjustment of the whole request with its basis', async () => {
    open(world({ payments: [payment(1, { tax_adjustment_vnd: '-1000000', tax_adjustment_basis: 'Thông báo thuế', net_vnd: '2099000000' })] }));
    await screen.findByTestId('valuation');
    expect(screen.getByTestId('total-tax').textContent).toBe('-1.000.000');
    expect(screen.getByTestId('total-net').textContent).toBe('2.099.000.000');
    expect(screen.getByTestId('tax-basis').textContent).toBe(text('ctr.valuation.taxBasis', { basis: 'Thông báo thuế' }));
  });

  it('says so when the request has no lines (an advance)', async () => {
    open(world({ payments: [payment(1, { request_kind: 'ADVANCE', lines: [], acceptance: null })] }));
    expect((await screen.findByTestId('no-lines')).textContent).toBe(vi_['ctr.valuation.empty']);
    expect(screen.queryByTestId('valuation')).toBeNull();
  });

  it('shows the state of a request that is not there, of a refusal and of a failed read', async () => {
    open(world({ detail: new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} }) }));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    expect(screen.queryByText(vi_['ctr.valuation.back'])).toBeNull();
    cleanup();
    open(world({ detail: new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} }) }));
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    open(world({ failing: new Set(['get_resources_payment_request_id']) }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });
});

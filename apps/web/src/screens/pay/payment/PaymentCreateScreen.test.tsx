import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import PaymentCreateScreen from './PaymentCreateScreen';
import { ACCOUNTANT, LINE_ID, READER, acceptanceId, answer, client, commandsOf, contractId, mount, paymentId, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PAY-02', 'PAY', 'FR-PAY-02');
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { command?: (operation: string, input: unknown) => unknown; path?: string; permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY' } = {}) {
  const h = client(state, options.command ?? (() => answer(1)));
  mount(<PaymentCreateScreen route={ROUTE} />, h, { permissions: options.permissions ?? ACCOUNTANT, path: options.path ?? '/pay/pay-02', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const field = (id: string): HTMLInputElement & HTMLSelectElement => document.getElementById(id) as HTMLInputElement & HTMLSelectElement;
const type = (id: string, value: string): void => {
  fireEvent.change(field(id), { target: { value } });
};
const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['pay.payment.create.submit'] }));
};
const filled = async (): Promise<void> => {
  await screen.findByTestId('form');
  await waitFor(() => expect(field('payment-contract').options.length).toBeGreaterThan(1));
  type('payment-contract', contractId(1));
  await waitFor(() => expect(field('payment-acceptance').options.length).toBeGreaterThan(1));
  type('payment-acceptance', acceptanceId(1));
  await waitFor(() => expect(field('payment-line').options.length).toBeGreaterThan(1));
  type('payment-line', LINE_ID);
  type('payment-no', 'DNTT-NEW');
};

describe('PaymentCreateScreen (PAY-02): draw up a payment request', () => {
  it('UI-PAY-02: offers the approved acceptances of the contract only, the lines of capital of its project, and does not ask for any amount the server computes', async () => {
    open(world());
    await screen.findByTestId('form');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.payment.create.title']);
    expect(screen.getByText(text('pay.payment.create.footer', { id: 'PAY-02', req: 'FR-PAY-02' }))).toBeTruthy();
    await waitFor(() => expect(field('payment-contract').options.length).toBe(2));
    expect(screen.getByText(vi_['pay.payment.create.serverNumbers'])).toBeTruthy();
    for (const forbidden of ['gross', 'net', 'recovery', 'retention', 'status']) expect(document.querySelector(`[id*="${forbidden}"]`)).toBeNull();
    type('payment-contract', contractId(1));
    await waitFor(() => expect(field('payment-acceptance').options.length).toBe(2));
    expect([...field('payment-acceptance').options].map((option) => option.textContent)).toEqual([vi_['pay.payment.field.choose'], text('pay.payment.field.acceptance.option', { no: 'NT-001', amount: '400.000.000' })]);
    await waitFor(() => expect(field('payment-line').options.length).toBe(2));
  });

  it('says so when the contract has no approved acceptance, and keeps lines of other projects out', async () => {
    open(world({ acceptances: [], lines: [] }), { path: `/pay/pay-02?contract=${contractId(1)}` });
    await screen.findByTestId('form');
    await waitFor(() => expect(field('payment-contract').value).toBe(contractId(1)));
    expect(await screen.findByText(vi_['pay.payment.field.acceptance.none'])).toBeTruthy();
    expect(field('payment-line').options).toHaveLength(1);
  });

  it('refuses an empty form in words and sends nothing', async () => {
    const h = open(world());
    await screen.findByTestId('form');
    submit();
    expect(await screen.findAllByText(vi_['pay.payment.problem.required'])).toHaveLength(4);
    expect(commandsOf(h, 'createPaymentRequest')).toEqual([]);
    type('payment-tax', '5.5');
    type('payment-extra', 'x');
    submit();
    expect(await screen.findAllByText(vi_['pay.payment.problem.amount'])).toHaveLength(2);
    type('payment-tax', '5');
    submit();
    expect((await screen.findAllByText(vi_['pay.payment.problem.required'])).length).toBeGreaterThan(0);
  });

  it('AC-ST-PAY-002-1: sends what the client decides and shows the figures the server computed, with the warnings and the links on', async () => {
    const h = open(world(), { command: () => answer(1, { warnings: [{ code: 'OTHER_DRAFTS_FOR_ACCEPTANCE', detail: {} }] }) });
    await filled();
    type('payment-tax', '-1000000');
    type('payment-tax-basis', 'Thông báo thuế');
    type('payment-extra', '100');
    submit();
    expect((await screen.findByTestId('result')).textContent).toContain(vi_['pay.payment.create.result']);
    expect(commandsOf(h, 'createPaymentRequest')[0]?.body).toEqual({
      contract_id: contractId(1),
      request_kind: 'INTERIM',
      acceptance_id: acceptanceId(1),
      allocation_line_id: LINE_ID,
      request_no: 'DNTT-NEW',
      tax_adjustment_vnd: '-1000000',
      tax_adjustment_basis: 'Thông báo thuế',
      advance_recovery_extra_vnd: '100',
    });
    expect(screen.getByTestId('result-gross').textContent).toBe('3.000.000.000');
    expect(screen.getByTestId('result-recovery').textContent).toBe('750.000.000');
    expect(screen.getByTestId('result-retention').textContent).toBe('150.000.000');
    expect(screen.getByTestId('result-tax').textContent).toBe('0');
    expect(screen.getByTestId('result-net').textContent).toBe('2.100.000.000');
    expect(screen.getByTestId('warnings').textContent).toBe(vi_['pay.payment.warning.otherDrafts']);
    expect((screen.getByTestId('open-request') as HTMLAnchorElement).getAttribute('href')).toBe(`/pay/pay-03?request=${paymentId(1)}`);
    expect((screen.getByText(vi_['pay.payment.create.valuation']) as HTMLAnchorElement).getAttribute('href')).toBe(`/ctr/ctr-13?request=${paymentId(1)}`);
    expect((screen.getAllByText(vi_['pay.payment.create.list'])[0] as HTMLAnchorElement).getAttribute('href')).toBe(`/pay/pay-01?contract=${contractId(1)}`);
  });

  it('shows no warning list when there is none', async () => {
    open(world());
    await filled();
    submit();
    await screen.findByTestId('result');
    expect(screen.queryByTestId('warnings')).toBeNull();
  });

  it('puts the refusal of the server into words and keeps the form', async () => {
    const refuse = (code: string) => () => new ApiError({ status: 409, code, correlationId: 'c', extensions: {} });
    open(world(), { command: refuse('PAYMENT_REFERENCE_DUPLICATE') });
    await filled();
    submit();
    expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['pay.payment.error.referenceDuplicate']);
    expect(field('payment-no').value).toBe('DNTT-NEW');
    expect(screen.queryByTestId('result')).toBeNull();
  });

  it('does not draw a second request while one is being sent', async () => {
    let release: (value: unknown) => void = () => undefined;
    const h = open(world(), { command: () => new Promise((resolve) => (release = resolve)) as never });
    await filled();
    submit();
    await waitFor(() => expect(screen.getByRole('button', { name: vi_['pay.payment.create.pending'] })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: vi_['pay.payment.create.pending'] }));
    expect(commandsOf(h, 'createPaymentRequest')).toHaveLength(1);
    release(answer(1));
    await screen.findByTestId('result');
  });

  it('tells whoever may not draw a request up, and shows no form to a reader or a read-only session', async () => {
    open(world(), { permissions: READER });
    expect((await screen.findByTestId('no-right')).textContent).toBe(vi_['pay.payment.create.noRight']);
    expect(screen.queryByTestId('form')).toBeNull();
    cleanup();
    open(world(), { mode: 'READ_ONLY' });
    expect(await screen.findByTestId('no-right')).toBeTruthy();
  });
});

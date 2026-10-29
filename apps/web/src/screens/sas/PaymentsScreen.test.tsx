import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import PaymentsScreen from './PaymentsScreen';
import { toPayment, toTenantInvoices } from './billing/model';
import { outstandingOf, payableInvoices, toPaymentPage } from './payments/model';
import { harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-10', 'FR-SAS-10');
const BILLING = ['system.tenant.read', 'system.billing.manage'];
const READER = ['system.tenant.read'];
const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b1';
const problem = (code: string, status = 409, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });

const payment = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `pay-${n}`,
  provider: 'mock-bank',
  txn_ref: `TXN-${n}`,
  amount_vnd: '1100000',
  method: 'BANK_TRANSFER',
  received_at: '2026-03-04T02:00:00Z',
  match_status: 'Unmatched',
  memo: 'chuyen khoan thang 1',
  version: 1,
  actions: { match: true },
  ...overrides,
});

const invoice = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  subscription_id: 'sub-1',
  invoice_code: `INV-${id.toUpperCase()}`,
  period_start: '2026-01-01',
  period_end: '2026-01-31',
  kind: 'ORIGINAL',
  status: 'Issued',
  subtotal_vnd: '1000000',
  vat_vnd: '100000',
  total_vnd: '1100000',
  buyer: { code: 'cao-bang', name: 'Cao Bằng' },
  due_at: '2026-02-15',
  issue_attempts: 1,
  version: 4,
  einvoice: { provider: 'MOCK', template_code: '1', series: 'C26TMV', number: '0000012', tax_authority_code: 'CQT-ABC-123', lookup_code: 'LK-0001' },
  lines: [],
  payments: [],
  actions: { issue: false },
  ...overrides,
});

interface World {
  pages: Map<string | undefined, Record<string, unknown> | Error>;
  invoices: Map<string, Record<string, unknown> | Error>;
}

const world = (overrides: Partial<World> = {}): World => ({
  pages: new Map([[undefined, { items: [payment(1), payment(2, { match_status: 'PendingReview', memo: '' })], next_cursor: null }]]),
  invoices: new Map([
    [
      TENANT_A,
      {
        items: [
          invoice('a1'),
          invoice('a2', { status: 'Paid', payments: [{ id: 'p9', provider: 'mock-bank', txn_ref: 'T9', amount_vnd: '1100000', method: 'BANK_TRANSFER', received_at: '2026-03-01T00:00:00Z', match_status: 'Matched', memo: '', invoice_id: 'a2', version: 1, actions: { match: false } }] }),
          invoice('a3', { status: 'Draft', einvoice: undefined }),
        ],
        next_cursor: null,
      },
    ],
    [TENANT_B, { items: [invoice('b1')], next_cursor: null }],
  ]),
  ...overrides,
});

function client(current: World, command: (operation: string, input: unknown) => unknown = () => ({ status: 'MATCHED' })) {
  return harness((operation, input) => {
    if (operation === 'listSystemTenants')
      return {
        items: [
          { id: TENANT_A, code: 'cao-bang', name: 'Cao Bằng' },
          { id: TENANT_B, code: 'ha-giang', name: 'Hà Giang' },
        ],
        next_cursor: null,
      };
    if (operation === 'listBillingPayments') return current.pages.get((input as { query?: { cursor?: string } }).query?.cursor) ?? new Error('unknown page');
    if (operation === 'listTenantInvoices') return current.invoices.get((input as { path: { tenantId: string } }).path.tenantId) ?? new Error('unknown tenant');
    return new Error(`unexpected read ${operation}`);
  }, command);
}

afterEach(cleanup);

const row = (id: string): HTMLElement => document.querySelector(`[data-payment-id="${id}"]`) as HTMLElement;
const invoiceRow = (id: string): HTMLElement => document.querySelector(`[data-invoice-id="${id}"]`) as HTMLElement;
const form = () => within(screen.getByRole('form', { name: vi_['sas.payments.match.aria'] }));

describe('PaymentsScreen (SAS-10): the invoices and the reconciliation of the payments that come in', () => {
  it('shows the payments that wait with their amount, note and status, and for the invoices of the tenant the number, the code of the tax authority and the match status (UI-SAS-10, AC-ST-SAS-012-3)', async () => {
    mount(<PaymentsScreen route={ROUTE} />, client(world()), BILLING);
    await waitFor(() => expect(row('pay-1')).not.toBeNull());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['sas.payments.page.title']);
    expect(row('pay-1').textContent).toContain((1100000).toLocaleString('vi'));
    expect(row('pay-1').textContent).toContain('chuyen khoan thang 1');
    expect(row('pay-1').textContent).toContain(vi_['sas.payments.status.unmatched']);
    expect(row('pay-2').textContent).toContain(vi_['sas.payments.status.review']);
    await waitFor(() => expect(invoiceRow('a1')).not.toBeNull());
    // The issued invoice: the number of the provider, the code of the tax authority and the code to look it up with; not yet paid.
    expect(invoiceRow('a1').querySelector('[data-einvoice-number]')?.textContent).toBe('C26TMV 0000012');
    expect(invoiceRow('a1').querySelector('[data-tax-authority-code]')?.textContent).toContain('CQT-ABC-123');
    expect(invoiceRow('a1').querySelector('[data-tax-authority-code]')?.textContent).toContain('LK-0001');
    expect(invoiceRow('a1').querySelector('[data-match-status]')?.textContent).toContain(vi_['sas.payments.invoice.noPayment']);
    // The paid one shows the payment that matched it; a draft has no number yet.
    expect(invoiceRow('a2').querySelector('[data-match-status]')?.textContent).toContain(vi_['sas.payments.status.matched']);
    expect(invoiceRow('a3').querySelector('[data-einvoice-number]')?.textContent).toBe('—');
  });

  it('matches a payment with a payable invoice of the tenant, with the version of the payment and a reason, and says so', async () => {
    const h = client(world());
    mount(<PaymentsScreen route={ROUTE} />, h, BILLING);
    await waitFor(() => expect(row('pay-1')).not.toBeNull());
    fireEvent.click(within(row('pay-1')).getByRole('button', { name: vi_['sas.payments.match.action'] }));
    await waitFor(() => expect(form().getByLabelText(vi_['sas.payments.match.invoice.label'])).not.toBeNull());
    // Only the invoices that were issued and are not paid are offered, with what is left to pay.
    await waitFor(() => expect(within(form().getByLabelText(vi_['sas.payments.match.invoice.label'])).getAllByRole('option')).toHaveLength(2));
    const option = within(form().getByLabelText(vi_['sas.payments.match.invoice.label'])).getByRole('option', { name: /INV-A1/ });
    expect(option.textContent).toContain((1100000).toLocaleString('vi'));
    // Nothing is sent without an invoice and a reason.
    fireEvent.click(form().getByRole('button', { name: vi_['sas.payments.match.confirm.action'] }));
    expect(screen.queryByText(vi_['sas.payments.match.invoice.required'])).not.toBeNull();
    expect(screen.queryByText(vi_['sas.payments.match.reason.tooShort'])).not.toBeNull();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(form().getByLabelText(vi_['sas.payments.match.invoice.label']), { target: { value: 'a1' } });
    fireEvent.change(form().getByLabelText(vi_['sas.payments.match.reason.label']), { target: { value: 'The payer wrote no code.' } });
    fireEvent.click(form().getByRole('button', { name: vi_['sas.payments.match.confirm.action'] }));
    await waitFor(() => expect(screen.queryByText(vi_['sas.payments.done'])).not.toBeNull());
    const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown; ifMatchVersion: number }];
    expect(operation).toBe('matchBillingPayment');
    expect(input).toMatchObject({ path: { paymentId: 'pay-1' }, body: { invoice_id: 'a1', reason: 'The payer wrote no code.' }, ifMatchVersion: 1 });
  });

  it('says what is left to pay when the amount is refused (AMOUNT_MISMATCH), and why the other refusals came', async () => {
    const refusals: Array<[Error, string]> = [
      [problem('AMOUNT_MISMATCH', 422, { outstanding_vnd: '2500000' }), vi_['sas.payments.problem.mismatchAmount'].replace('{amount}', (2500000).toLocaleString('vi'))],
      [problem('PAYMENT_STATE_INVALID'), vi_['sas.payments.problem.paymentState']],
      [problem('EINVOICE_STATE_INVALID'), vi_['sas.payments.problem.invoiceState']],
      [problem('VERSION_CONFLICT'), vi_['sas.payments.problem.conflict']],
    ];
    for (const [error, message] of refusals) {
      mount(
        <PaymentsScreen route={ROUTE} />,
        client(world(), () => error),
        BILLING,
      );
      await waitFor(() => expect(row('pay-1')).not.toBeNull());
      fireEvent.click(within(row('pay-1')).getByRole('button', { name: vi_['sas.payments.match.action'] }));
      await waitFor(() => expect(within(form().getByLabelText(vi_['sas.payments.match.invoice.label'])).getAllByRole('option')).toHaveLength(2));
      fireEvent.change(form().getByLabelText(vi_['sas.payments.match.invoice.label']), { target: { value: 'a1' } });
      fireEvent.change(form().getByLabelText(vi_['sas.payments.match.reason.label']), { target: { value: 'The payer wrote no code.' } });
      fireEvent.click(form().getByRole('button', { name: vi_['sas.payments.match.confirm.action'] }));
      await waitFor(() => expect(screen.queryByText(message)).not.toBeNull());
      cleanup();
    }
  });

  it('does not carry the payment picked for matching over to another tenant', async () => {
    const h = client(world());
    mount(<PaymentsScreen route={ROUTE} />, h, BILLING);
    await waitFor(() => expect(row('pay-1')).not.toBeNull());
    fireEvent.click(within(row('pay-1')).getByRole('button', { name: vi_['sas.payments.match.action'] }));
    expect(screen.queryByRole('form', { name: vi_['sas.payments.match.aria'] })).not.toBeNull();
    fireEvent.change(screen.getByLabelText(vi_['sas.payments.tenant.label']), { target: { value: TENANT_B } });
    await waitFor(() => expect(invoiceRow('b1')).not.toBeNull());
    expect(screen.queryByRole('form', { name: vi_['sas.payments.match.aria'] })).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('offers a reader the queue and the invoices and nothing to match', async () => {
    mount(<PaymentsScreen route={ROUTE} />, client(world()), READER);
    await waitFor(() => expect(row('pay-1')).not.toBeNull());
    expect(screen.queryByRole('button', { name: vi_['sas.payments.match.action'] })).toBeNull();
  });

  it('loads older payments on request, only while there are more', async () => {
    const current = world({
      pages: new Map<string | undefined, Record<string, unknown> | Error>([
        [undefined, { items: [payment(1)], next_cursor: 'older' }],
        ['older', { items: [payment(7)], next_cursor: null }],
      ]),
    });
    mount(<PaymentsScreen route={ROUTE} />, client(current), BILLING);
    await waitFor(() => expect(row('pay-1')).not.toBeNull());
    expect(row('pay-7')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.payments.queue.more.action'] }));
    await waitFor(() => expect(row('pay-7')).not.toBeNull());
    expect(screen.queryByRole('button', { name: vi_['sas.payments.queue.more.action'] })).toBeNull();
  });

  it('shows the states: nothing waits, a queue that could not be read with a way to try again, and invoices that could not be read', async () => {
    mount(<PaymentsScreen route={ROUTE} />, client(world({ pages: new Map([[undefined, { items: [], next_cursor: null }]]) })), BILLING);
    await waitFor(() => expect(screen.queryByText(vi_['sas.payments.queue.none'])).not.toBeNull());
    cleanup();
    mount(<PaymentsScreen route={ROUTE} />, client(world({ pages: new Map([[undefined, new Error('boom')]]) })), BILLING);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
    expect(screen.queryByRole('button', { name: /thử lại|retry/i })).not.toBeNull();
    cleanup();
    mount(<PaymentsScreen route={ROUTE} />, client(world({ invoices: new Map([[TENANT_A, new Error('boom')]]) })), BILLING);
    await waitFor(() => expect(screen.queryByText(vi_['sas.payments.invoices.error'])).not.toBeNull());
    expect(screen.queryByRole('button', { name: vi_['sas.payments.invoices.retry.action'] })).not.toBeNull();
  });

  it('offers no way to edit or delete a payment, and nothing that cancels an invoice', async () => {
    mount(<PaymentsScreen route={ROUTE} />, client(world()), BILLING);
    await waitFor(() => expect(row('pay-1')).not.toBeNull());
    for (const button of screen.getAllByRole('button')) expect(button.textContent?.toLowerCase()).not.toMatch(/delete|xóa|edit|sửa|cancel|void|hủy|huỷ/);
  });
});

describe('the model of SAS-10', () => {
  it('reads a payment and a page, and ignores what it cannot place', () => {
    expect(toPayment(payment(1))).toMatchObject({ id: 'pay-1', status: 'Unmatched', method: 'BANK_TRANSFER', canMatch: true, version: 1 });
    expect(toPayment({ id: 'x', match_status: 'Mystery', method: 'CASH' })).toMatchObject({ status: 'Unmatched', method: 'BANK_TRANSFER', canMatch: false });
    expect(toPayment({ nothing: true })).toBeUndefined();
    expect(toPaymentPage({ items: [payment(1), { nothing: true }], next_cursor: 'c' })).toMatchObject({ nextCursor: 'c', items: [{ id: 'pay-1' }] });
    expect(toPaymentPage(undefined)).toEqual({ items: [], nextCursor: undefined });
  });

  it('offers the invoices that were issued and are not paid, adjusted ones too and never an adjustment, with what is left to pay as the server says', () => {
    const views = [
      invoice('a1'),
      invoice('a2', { status: 'Paid' }),
      invoice('a3', { status: 'Draft' }),
      invoice('a4', { status: 'Overdue' }),
      invoice('a5', { status: 'PendingIssue' }),
      invoice('a6', { status: 'Adjusted', outstanding_vnd: '750000' }),
      invoice('a7', { kind: 'ADJUSTMENT', status: 'Issued' }),
      invoice('a8', { status: 'Replaced' }),
    ];
    const items = toTenantInvoices({ items: views }).items;
    expect(payableInvoices(items).map((entry) => entry.id)).toEqual(['a1', 'a4', 'a6']);
    expect(outstandingOf(items[5] as never)).toBe('750000');
    // Without the server's figure the total stands in.
    expect(outstandingOf(items[0] as never)).toBe('1100000');
  });
});

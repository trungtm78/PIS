import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import PaymentDetailScreen from './PaymentDetailScreen';
import { ACCOUNTANT, APPROVER, DOCUMENT_VERSION, LINE_ID, actions, answer, client, commandsOf, paymentDocument, mount, payment, paymentId, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PAY-03', 'PAY', 'FR-PAY-03');
const PATH = `/pay/pay-03?request=${paymentId(1)}`;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const refusal = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { command?: (operation: string, input: unknown) => unknown; path?: string; permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY' } = {}) {
  const h = client(state, options.command ?? (() => answer(1)));
  mount(<PaymentDetailScreen route={ROUTE} />, h, { permissions: options.permissions ?? ACCOUNTANT, path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const field = (id: string): HTMLInputElement & HTMLSelectElement => document.getElementById(id) as HTMLInputElement & HTMLSelectElement;
const type = (id: string, value: string): void => {
  fireEvent.change(field(id), { target: { value } });
};
const press = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const action = (name: string): HTMLElement => document.querySelector(`button[data-action="${name}"]`) as HTMLElement;

describe('PaymentDetailScreen (PAY-03): a payment request and its documents', () => {
  it('asks for a request when the address names none', async () => {
    open(world(), { path: '/pay/pay-03' });
    expect((await screen.findByTestId('no-request')).textContent).toBe(vi_['pay.payment.detail.none']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.payment.detail.title']);
    expect(screen.getByText(text('pay.payment.detail.footer', { id: 'PAY-03', req: 'FR-PAY-03' }))).toBeTruthy();
  });

  it('UI-PAY-03: shows the request in figures, read-only, with the link to how the amount is made up', async () => {
    open(world({ payments: [payment(1, { other_drafts: 2 })] }));
    await screen.findByTestId('request-no');
    expect(screen.getByTestId('request-no').textContent).toBe('DNTT-001');
    expect(screen.getByTestId('status').textContent).toBe(vi_['pay.payment.status.draft']);
    expect(screen.getByTestId('contract').textContent).toBe('HD-A-001');
    expect(screen.getByTestId('acceptance').textContent).toBe(text('pay.payment.fact.acceptance.value', { no: 'NT-001', date: '2026-07-25' }));
    expect(screen.getByTestId('plan-year').textContent).toBe('2026');
    expect(screen.getByTestId('gross').textContent).toBe('3.000.000.000');
    expect(screen.getByTestId('recovery').textContent).toBe('750.000.000');
    expect(screen.getByTestId('retention').textContent).toBe('150.000.000');
    expect(screen.getByTestId('tax').textContent).toBe('0');
    expect(screen.getByTestId('net').textContent).toBe('2.100.000.000');
    expect(screen.queryByTestId('tax-basis')).toBeNull();
    expect(screen.getByTestId('other-drafts').textContent).toBe(text('pay.payment.detail.otherDrafts', { count: 2 }));
    expect((screen.getByTestId('valuation') as HTMLAnchorElement).getAttribute('href')).toBe(`/ctr/ctr-13?request=${paymentId(1)}`);
    expect(screen.getByTestId('no-documents').textContent).toBe(vi_['pay.payment.documents.empty']);
    // The numbers are text, not fields.
    expect(document.querySelectorAll('input')).toHaveLength(0);
  });

  it('shows the basis of a tax adjustment, the reasons of a return and a cancellation, and the documents with an exception', async () => {
    open(
      world({
        payments: [
          payment(1, {
            status: 'RETURNED',
            tax_adjustment_vnd: '-1000000',
            tax_adjustment_basis: 'Thông báo thuế',
            net_vnd: '2099000000',
            return_reason: 'Fix the invoice.',
            cancel_reason: 'Duplicate.',
            other_drafts: null,
            plan_year: null,
            acceptance: null,
            documents: [paymentDocument(1, { duplicate_override_reason: 'Hóa đơn điều chỉnh' }), paymentDocument(2, { doc_kind: 'OTHER', invoice_no: null, invoice_date: null, signed: false })],
          }),
        ],
      }),
    );
    await screen.findByTestId('request-no');
    expect(screen.getByTestId('status').className).toContain('warning');
    expect(screen.getByTestId('tax').textContent).toBe('-1.000.000');
    expect(screen.getByTestId('tax-basis').textContent).toBe('Thông báo thuế');
    expect(screen.getByTestId('return-reason').textContent).toBe('Fix the invoice.');
    expect(screen.getByTestId('cancel-reason').textContent).toBe('Duplicate.');
    expect(screen.queryByTestId('other-drafts')).toBeNull();
    expect(screen.getByTestId('acceptance').textContent).toBe('');
    const rows = within(screen.getByTestId('documents')).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByTestId('doc-kind').textContent).toBe(vi_['pay.payment.docKind.invoice']);
    expect(within(rows[0]!).getByTestId('doc-invoice').textContent).toBe('HD-0001234 · 2026-07-01');
    expect(within(rows[0]!).getByTestId('doc-override').textContent).toBe('Hóa đơn điều chỉnh');
    expect(within(rows[0]!).getByTestId('doc-checksum').textContent).toBe('abababababab');
    expect(rows[0]?.textContent).toContain(vi_['pay.payment.documents.yes']);
    expect(within(rows[1]!).getByTestId('doc-invoice').textContent).toBe('');
    expect(rows[1]?.textContent).toContain(vi_['pay.payment.documents.no']);
  });

  it('offers the commands the server says the caller may give, and none in a read-only session or for a request that is no longer open', async () => {
    open(world({ payments: [payment(1, { actions: actions({ cancel: false }) })] }));
    await screen.findByTestId('request-no');
    expect(action('revise')).not.toBeNull();
    expect(action('attach')).not.toBeNull();
    expect(action('cancel')).toBeNull();
    cleanup();
    open(world(), { mode: 'READ_ONLY' });
    await screen.findByTestId('request-no');
    expect(document.querySelectorAll('button[data-action]')).toHaveLength(0);
    cleanup();
    open(world({ payments: [payment(1, { status: 'SUBMITTED', actions: actions({ revise: false, attach_document: false, cancel: false }) })] }));
    await screen.findByTestId('request-no');
    expect(document.querySelectorAll('button[data-action]')).toHaveLength(0);
  });

  it('revises the draft: sends what the client decides, with the version, and says the amounts were worked out again', async () => {
    const h = open(world({ payments: [payment(1, { tax_adjustment_vnd: '-3000', tax_adjustment_basis: 'Điều chỉnh', advance_recovery_extra_vnd: '10' })] }), { command: () => answer(1, { warnings: [{ code: 'NATIONAL_CODE_MISSING', detail: {} }] }) });
    await screen.findByTestId('request-no');
    fireEvent.click(action('revise'));
    expect(field('revise-no').value).toBe('DNTT-001');
    expect(field('revise-tax').value).toBe('-3000');
    expect(field('revise-tax-basis').value).toBe('Điều chỉnh');
    expect(field('revise-extra').value).toBe('10');
    await waitFor(() => expect(field('revise-line').options.length).toBeGreaterThan(1));
    expect(field('revise-line').value).toBe(LINE_ID);
    type('revise-no', 'DNTT-NEW');
    type('revise-tax', '');
    press(vi_['pay.payment.revise.submit']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'revisePaymentDraft')[0]).toMatchObject({ path: { id: paymentId(1) }, ifMatchVersion: 1, body: { request_no: 'DNTT-NEW', allocation_line_id: LINE_ID, tax_adjustment_vnd: '0', advance_recovery_extra_vnd: '10' } });
    expect(screen.getByTestId('done').textContent).toContain(vi_['pay.payment.done.revised']);
    expect(screen.getByTestId('warnings').textContent).toBe(vi_['pay.payment.warning.nationalCode']);
  });

  it('keeps a line of capital that is not among the choices, and refuses an empty number in words', async () => {
    const h = open(world({ lines: [], payments: [payment(1, { allocation_line_id: '00000000-0000-4000-8000-0000000000ff' })] }));
    await screen.findByTestId('request-no');
    fireEvent.click(action('revise'));
    expect(field('revise-line').value).toBe('00000000-0000-4000-8000-0000000000ff');
    type('revise-no', '');
    type('revise-tax', '7');
    press(vi_['pay.payment.revise.submit']);
    expect((await within(dialog()).findAllByText(vi_['pay.payment.problem.required'])).length).toBe(2);
    expect(commandsOf(h, 'revisePaymentDraft')).toEqual([]);
    press(vi_['pay.payment.dialog.cancel']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts the refusal of a revision into words', async () => {
    open(world(), { command: () => refusal('PAYMENT_REFERENCE_DUPLICATE') });
    await screen.findByTestId('request-no');
    fireEvent.click(action('revise'));
    press(vi_['pay.payment.revise.submit']);
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['pay.payment.error.referenceDuplicate']);
  });

  it('AC-ST-PAY-002-4: attaches a document; an invoice names its number and date, and a duplicate is refused in words', async () => {
    const h = open(world(), { command: () => refusal('INVOICE_DUPLICATE') });
    await screen.findByTestId('request-no');
    fireEvent.click(action('attach'));
    press(vi_['pay.payment.attach.submit']);
    expect((await within(dialog()).findAllByText(vi_['pay.payment.problem.required'])).length).toBe(2);
    expect(within(dialog()).queryByLabelText(vi_['pay.payment.field.invoiceNo'])).toBeNull();
    type('attach-kind', 'INVOICE');
    type('attach-document', DOCUMENT_VERSION);
    type('attach-invoice-no', 'HD-0001234');
    type('attach-invoice-date', '2026-07-01');
    fireEvent.click(within(dialog()).getByLabelText(vi_['pay.payment.field.signed']));
    // Whoever may not give the exception is not offered the field for it.
    expect(document.getElementById('attach-override')).toBeNull();
    press(vi_['pay.payment.attach.submit']);
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['pay.payment.error.invoiceDuplicate']);
    expect(commandsOf(h, 'attachPaymentDocument')[0]).toMatchObject({ path: { id: paymentId(1) }, body: { document_version_id: DOCUMENT_VERSION, doc_kind: 'INVOICE', invoice_no: 'HD-0001234', invoice_date: '2026-07-01', signed: true } });
    expect(commandsOf(h, 'attachPaymentDocument')[0]?.body).not.toHaveProperty('duplicate_override_reason');
  });

  it('lets an approver who did not draw the request up give the reason that lets a duplicate invoice through', async () => {
    const h = open(world({ payments: [payment(1, { actions: actions({ revise: false, cancel: false, override_duplicate: true }) })] }), { permissions: APPROVER, command: () => answer(1, { warnings: [{ code: 'DUPLICATE_INVOICE_OTHER_CONTRACT', detail: {} }] }) });
    await screen.findByTestId('request-no');
    expect(action('revise')).toBeNull();
    fireEvent.click(action('attach'));
    type('attach-kind', 'INVOICE');
    type('attach-document', DOCUMENT_VERSION);
    type('attach-invoice-no', 'HD-0001234');
    type('attach-invoice-date', '2026-07-01');
    type('attach-override', 'Hóa đơn điều chỉnh theo thông báo 12/TB');
    press(vi_['pay.payment.attach.submit']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'attachPaymentDocument')[0]?.body).toMatchObject({ duplicate_override_reason: 'Hóa đơn điều chỉnh theo thông báo 12/TB' });
    expect(screen.getByTestId('done').textContent).toContain(vi_['pay.payment.done.attached']);
    expect(screen.getByTestId('warnings').textContent).toBe(vi_['pay.payment.warning.invoiceElsewhere']);
  });

  it('attaches a document that is not an invoice without asking for a number', async () => {
    const h = open(world());
    await screen.findByTestId('request-no');
    fireEvent.click(action('attach'));
    type('attach-kind', 'ACCEPTANCE_MINUTES');
    type('attach-document', DOCUMENT_VERSION);
    press(vi_['pay.payment.attach.submit']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'attachPaymentDocument')[0]?.body).toEqual({ document_version_id: DOCUMENT_VERSION, doc_kind: 'ACCEPTANCE_MINUTES' });
  });

  it('cancels a draft with a reason, and refuses an empty one in words', async () => {
    const h = open(world(), { command: () => answer(1, { status: 'CANCELLED', resource_version: 2 }) });
    await screen.findByTestId('request-no');
    fireEvent.click(action('cancel'));
    press(vi_['pay.payment.cancel.submit']);
    expect(await within(dialog()).findByText(vi_['pay.payment.problem.required'])).toBeTruthy();
    type('cancel-reason', 'The request was drawn up twice.');
    press(vi_['pay.payment.cancel.submit']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'cancelPaymentRequest')[0]).toMatchObject({ path: { id: paymentId(1) }, ifMatchVersion: 1, body: { reason: 'The request was drawn up twice.' } });
    expect(screen.getByTestId('done').textContent).toContain(vi_['pay.payment.done.cancelled']);
  });

  it('shows the states of a request that is not there, of a refusal and of a failed read, and never half a request', async () => {
    open(world({ payments: [] }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    cleanup();
    open(world({ detail: new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} }) }));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    open(world({ detail: new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} }) }));
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    open(world({ detail: { id: 'x' } }));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    expect(screen.queryByTestId('request-no')).toBeNull();
  });
});

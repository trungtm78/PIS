import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import CorrectionScreen from './CorrectionScreen';
import { toTenantInvoices } from './billing/model';
import { correctionBody, emptyForm, isCorrectable, receivableAfter, totalsOf, validateForm, vatOf } from './correction/model';
import type { CorrectionForm } from './correction/model';
import { harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-24', 'FR-SAS-24');
const BILLING = ['system.tenant.read', 'system.billing.manage'];
const READER = ['system.tenant.read'];
const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b1';
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });

const invoice = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  subscription_id: 'sub-1',
  invoice_code: `INV-${id.toUpperCase()}`,
  period_start: '2026-01-01',
  period_end: '2026-01-31',
  kind: 'ORIGINAL',
  status: 'Issued',
  subtotal_vnd: '365000000',
  vat_vnd: '0',
  total_vnd: '365000000',
  buyer: { code: 'cao-bang', name: 'Cao Bằng' },
  issue_attempts: 1,
  version: 4,
  einvoice: { provider: 'MOCK', template_code: '1', series: 'C26TMV', number: '0000012' },
  lines: [],
  payments: [],
  actions: { issue: false },
  ...overrides,
});

interface World {
  byTenant: Map<string, Record<string, unknown> | Error>;
}

const world = (): World => ({
  byTenant: new Map([
    [
      TENANT_A,
      {
        items: [
          invoice('o1', { standing_vnd: '328500000' }),
          invoice('d1', { status: 'Draft', einvoice: undefined }),
          invoice('a1', { kind: 'ADJUSTMENT', status: 'Issued', total_vnd: '-36500000', subtotal_vnd: '-36500000', related_invoice_id: 'o1', correction_reason: 'x'.repeat(12), agreement_document_ref: 'BB-2026/0042' }),
        ],
        next_cursor: null,
        receivable_vnd: '328500000',
      },
    ],
    [TENANT_B, { items: [invoice('b1')], next_cursor: null, receivable_vnd: '365000000' }],
  ]),
});

function client(current: World, command: (operation: string, input: unknown) => unknown = () => ({ status: 'DRAFTED' })) {
  return harness((operation, input) => {
    if (operation === 'listSystemTenants')
      return {
        items: [
          { id: TENANT_A, code: 'cao-bang', name: 'Cao Bằng' },
          { id: TENANT_B, code: 'ha-giang', name: 'Hà Giang' },
        ],
        next_cursor: null,
      };
    if (operation === 'listTenantInvoices') return current.byTenant.get((input as { path: { tenantId: string } }).path.tenantId) ?? new Error('unknown tenant');
    return new Error(`unexpected read ${operation}`);
  }, command);
}

afterEach(cleanup);

const row = (id: string): HTMLElement => document.querySelector(`[data-invoice-id="${id}"]`) as HTMLElement;
const form = () => within(screen.getByRole('form', { name: vi_['sas.correction.form.aria'] }));
const fill = (kind: 'ADJUSTMENT' | 'REPLACEMENT', lines: Array<[string, string]>, reason = 'The plan was billed at the wrong price.', agreement = 'BB-2026/0042'): void => {
  if (kind === 'REPLACEMENT') fireEvent.click(form().getByLabelText(vi_['sas.correction.kind.replacement']));
  fireEvent.change(form().getByLabelText(vi_['sas.correction.form.reason.label']), { target: { value: reason } });
  fireEvent.change(form().getByLabelText(vi_['sas.correction.form.agreement.label']), { target: { value: agreement } });
  lines.forEach(([description, amount], index) => {
    if (index > 0) fireEvent.click(form().getByRole('button', { name: vi_['sas.correction.line.add.action'] }));
    fireEvent.change(form().getByLabelText(vi_['sas.correction.line.description.aria'].replace('{n}', String(index + 1))), { target: { value: description } });
    fireEvent.change(form().getByLabelText(vi_['sas.correction.line.amount.aria'].replace('{n}', String(index + 1))), { target: { value: amount } });
  });
};

describe('CorrectionScreen (SAS-24): the correction of an issued invoice', () => {
  it('shows the invoices with their kind, status and total, the corrections as linked to the invoice they correct, and what the tenant owes (UI-SAS-24)', async () => {
    mount(<CorrectionScreen route={ROUTE} />, client(world()), BILLING);
    await waitFor(() => expect(row('o1')).not.toBeNull());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['sas.correction.page.title']);
    expect(document.querySelector('[data-receivable]')?.textContent).toContain((328500000).toLocaleString('vi'));
    expect(row('a1').textContent).toContain(vi_['sas.correction.kind.adjustment']);
    expect(row('a1').textContent).toContain(vi_['sas.correction.of.text'].replace('{code}', 'INV-O1'));
    expect(row('a1').textContent).toContain('BB-2026/0042');
    // An issued original can be corrected; a draft and a correction cannot.
    expect(within(row('o1')).queryByRole('button', { name: vi_['sas.correction.correct.action'] })).not.toBeNull();
    expect(within(row('d1')).queryByRole('button', { name: vi_['sas.correction.correct.action'] })).toBeNull();
    expect(within(row('a1')).queryByRole('button', { name: vi_['sas.correction.correct.action'] })).toBeNull();
  });

  it('has no button, action or word that cancels an invoice (AC-ST-SAS-013-2)', async () => {
    mount(<CorrectionScreen route={ROUTE} />, client(world()), BILLING);
    await waitFor(() => expect(row('o1')).not.toBeNull());
    fireEvent.click(within(row('o1')).getByRole('button', { name: vi_['sas.correction.correct.action'] }));
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['sas.correction.form.aria'] })).not.toBeNull());
    const words = /cancel|void|delete|hủy|huỷ|xóa/i;
    for (const button of screen.getAllByRole('button')) expect(button.textContent).not.toMatch(words);
    for (const link of screen.queryAllByRole('link')) expect(link.textContent).not.toMatch(words);
    // The page says in words that an invoice is never cancelled; it offers no way to.
    expect(screen.queryByRole('button', { name: words })).toBeNull();
  });

  it('shows the totals the lines come to and what the tenant owes once the correction is issued, as lines are written (AC-ST-SAS-013-1)', async () => {
    mount(<CorrectionScreen route={ROUTE} />, client(world()), BILLING);
    await waitFor(() => expect(row('o1')).not.toBeNull());
    fireEvent.click(within(row('o1')).getByRole('button', { name: vi_['sas.correction.correct.action'] }));
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['sas.correction.form.aria'] })).not.toBeNull());
    fill('ADJUSTMENT', [['Reduction of the plan price', '-10000000']]);
    const totals = document.querySelector('[data-totals]') as HTMLElement;
    expect(totals.querySelector('[data-total]')?.textContent).toBe((-10000000).toLocaleString('vi'));
    // The original stands for 365,000,000 less the adjustment already issued (-36,500,000): 328,500,000; the tenant owes 328,500,000 now and 318,500,000 after.
    expect(totals.querySelector('[data-standing]')?.textContent).toBe((328500000).toLocaleString('vi'));
    expect(totals.querySelector('[data-receivable-after]')?.textContent).toBe((318500000).toLocaleString('vi'));
    // A replacement takes the place of what the invoice stands for.
    fireEvent.click(form().getByLabelText(vi_['sas.correction.kind.replacement']));
    fireEvent.change(form().getByLabelText(vi_['sas.correction.line.amount.aria'].replace('{n}', '1')), { target: { value: '300000000' } });
    expect(totals.querySelector('[data-receivable-after]')?.textContent).toBe((300000000).toLocaleString('vi'));
  });

  it('refuses a form that is not whole: reason, agreement, a line with no description or amount or a zero amount, and totals that are not acceptable, and sends nothing', async () => {
    const h = client(world());
    mount(<CorrectionScreen route={ROUTE} />, h, BILLING);
    await waitFor(() => expect(row('o1')).not.toBeNull());
    fireEvent.click(within(row('o1')).getByRole('button', { name: vi_['sas.correction.correct.action'] }));
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['sas.correction.form.aria'] })).not.toBeNull());
    fireEvent.click(form().getByRole('button', { name: vi_['sas.correction.form.submit.action'] }));
    expect(screen.queryByText(vi_['sas.correction.form.reason.tooShort'])).not.toBeNull();
    expect(screen.queryByText(vi_['sas.correction.form.agreement.tooShort'])).not.toBeNull();
    expect(screen.queryByText(vi_['sas.correction.line.problem.description'])).not.toBeNull();
    fill('ADJUSTMENT', [['Reduction', '0']]);
    fireEvent.click(form().getByRole('button', { name: vi_['sas.correction.form.submit.action'] }));
    expect(screen.queryByText(vi_['sas.correction.line.problem.zero'])).not.toBeNull();
    fireEvent.change(form().getByLabelText(vi_['sas.correction.line.amount.aria'].replace('{n}', '1')), { target: { value: '-400000000' } });
    fireEvent.click(form().getByRole('button', { name: vi_['sas.correction.form.submit.action'] }));
    expect(screen.queryByText(vi_['sas.correction.total.problem.belowZero'])).not.toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('makes an adjustment with the reason, the agreement and the lines, and says it is a draft to issue', async () => {
    const h = client(world());
    mount(<CorrectionScreen route={ROUTE} />, h, BILLING);
    await waitFor(() => expect(row('o1')).not.toBeNull());
    fireEvent.click(within(row('o1')).getByRole('button', { name: vi_['sas.correction.correct.action'] }));
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['sas.correction.form.aria'] })).not.toBeNull());
    fill('ADJUSTMENT', [['Reduction of the plan price', '-36500000']]);
    fireEvent.click(form().getByRole('button', { name: vi_['sas.correction.form.submit.action'] }));
    await waitFor(() => expect(screen.queryByText(vi_['sas.correction.done.adjustment'])).not.toBeNull());
    const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown }];
    expect(operation).toBe('createAdjustmentInvoice');
    expect(input).toMatchObject({ path: { invoiceId: 'o1' }, body: { correction_reason: 'The plan was billed at the wrong price.', agreement_document_ref: 'BB-2026/0042', lines: [{ description: 'Reduction of the plan price', amount_vnd: '-36500000', vat_category: 'NOT_SUBJECT' }] } });
  });

  it('makes a replacement, and says why it was refused: already replaced, or the adjustment not acceptable with what the invoice stands for', async () => {
    const h = client(world(), () => problem('EINVOICE_ALREADY_REPLACED', 409));
    mount(<CorrectionScreen route={ROUTE} />, h, BILLING);
    await waitFor(() => expect(row('o1')).not.toBeNull());
    fireEvent.click(within(row('o1')).getByRole('button', { name: vi_['sas.correction.correct.action'] }));
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['sas.correction.form.aria'] })).not.toBeNull());
    fill('REPLACEMENT', [['Plan at the right price', '328500000']]);
    fireEvent.click(form().getByRole('button', { name: vi_['sas.correction.form.submit.action'] }));
    await waitFor(() => expect(screen.queryByText(vi_['sas.correction.problem.alreadyReplaced'])).not.toBeNull());
    expect(h.command.mock.calls[0]?.[0]).toBe('createReplacementInvoice');
    cleanup();
    const refused = client(world(), () => problem('EINVOICE_ADJUSTMENT_INVALID', 422, { standing_vnd: '328500000', reason: 'ADJUSTMENT_BELOW_ZERO' }));
    mount(<CorrectionScreen route={ROUTE} />, refused, BILLING);
    await waitFor(() => expect(row('o1')).not.toBeNull());
    fireEvent.click(within(row('o1')).getByRole('button', { name: vi_['sas.correction.correct.action'] }));
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['sas.correction.form.aria'] })).not.toBeNull());
    fill('ADJUSTMENT', [['Reduction', '-1']]);
    fireEvent.click(form().getByRole('button', { name: vi_['sas.correction.form.submit.action'] }));
    await waitFor(() => expect(screen.queryByText(vi_['sas.correction.problem.adjustmentStanding'].replace('{amount}', (328500000).toLocaleString('vi')))).not.toBeNull());
  });

  it('does not carry the invoice picked over to another tenant, and offers a reader nothing to correct', async () => {
    const h = client(world());
    mount(<CorrectionScreen route={ROUTE} />, h, BILLING);
    await waitFor(() => expect(row('o1')).not.toBeNull());
    fireEvent.click(within(row('o1')).getByRole('button', { name: vi_['sas.correction.correct.action'] }));
    expect(screen.queryByRole('form', { name: vi_['sas.correction.form.aria'] })).not.toBeNull();
    fireEvent.change(screen.getByLabelText(vi_['sas.correction.tenant.label']), { target: { value: TENANT_B } });
    await waitFor(() => expect(row('b1')).not.toBeNull());
    expect(screen.queryByRole('form', { name: vi_['sas.correction.form.aria'] })).toBeNull();
    cleanup();
    mount(<CorrectionScreen route={ROUTE} />, client(world()), READER);
    await waitFor(() => expect(row('o1')).not.toBeNull());
    expect(screen.queryByRole('button', { name: vi_['sas.correction.correct.action'] })).toBeNull();
  });

  it('shows the states: nothing yet, and a read that failed with a way to try again', async () => {
    mount(<CorrectionScreen route={ROUTE} />, client({ byTenant: new Map([[TENANT_A, { items: [], next_cursor: null, receivable_vnd: '0' }]]) }), BILLING);
    await waitFor(() => expect(screen.queryByText(vi_['sas.correction.invoices.none'])).not.toBeNull());
    cleanup();
    mount(<CorrectionScreen route={ROUTE} />, client({ byTenant: new Map([[TENANT_A, new Error('boom')]]) }), BILLING);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
    expect(screen.queryByRole('button', { name: /thử lại|retry/i })).not.toBeNull();
  });
});

describe('the model of SAS-24', () => {
  const form = (overrides: Partial<CorrectionForm> = {}): CorrectionForm => ({ ...emptyForm(), reason: 'The plan was billed at the wrong price.', agreementRef: 'BB-2026/0042', ...overrides });
  const withLines = (kind: CorrectionForm['kind'], lines: Array<[string, string]>): CorrectionForm => {
    const base = form({ kind });
    return { ...base, lines: lines.map(([description, amount], index) => ({ key: 100 + index, description, amount, vat: 'NOT_SUBJECT' as const })) };
  };

  it('works the VAT out as the server does: half up per line, a reduction mirroring the VAT of its own size', () => {
    expect(vatOf(7n, 'VAT_8')).toBe(1n);
    expect(vatOf(6n, 'VAT_8')).toBe(0n);
    expect(vatOf(-7n, 'VAT_8')).toBe(-1n);
    expect(vatOf(-107n, 'VAT_10')).toBe(-11n);
    expect(vatOf(1000000n, 'NOT_SUBJECT')).toBe(0n);
    const lines = [
      { key: 1, description: 'a', amount: '7', vat: 'VAT_8' as const },
      { key: 2, description: 'b', amount: '-107', vat: 'VAT_10' as const },
      { key: 3, description: 'c', amount: 'x', vat: 'VAT_10' as const },
    ];
    expect(totalsOf(lines)).toEqual({ subtotal: '-100', vat: '-10', total: '-110' });
  });

  it('judges the form as the server does', () => {
    expect(validateForm(withLines('ADJUSTMENT', [['Reduction', '-36500000']]), '365000000')).toEqual({ line: {} });
    expect(
      validateForm(
        withLines('ADJUSTMENT', [
          ['Up', '5'],
          ['Down', '-5'],
        ]),
        '365000000',
      ),
    ).toMatchObject({ total: 'zero' });
    expect(validateForm(withLines('ADJUSTMENT', [['Too much', '-365000001']]), '365000000')).toMatchObject({ total: 'belowZero' });
    expect(validateForm(withLines('REPLACEMENT', [['Nothing', '-5']]), '365000000')).toMatchObject({ total: 'notAbove' });
    expect(validateForm(withLines('REPLACEMENT', [['Plan', '328500000']]), '365000000')).toEqual({ line: {} });
    expect(validateForm({ ...form(), reason: 'short', agreementRef: '1234' }, '0')).toMatchObject({ reason: 'tooShort', agreementRef: 'tooShort' });
    expect(validateForm({ ...form(), lines: [] }, '0')).toMatchObject({ lines: 'empty' });
    const bad = withLines('ADJUSTMENT', [
      ['', '5'],
      ['x', '1.5'],
      ['y', '0'],
    ]);
    expect(validateForm(bad, '10').line).toEqual({ 100: 'description', 101: 'amount', 102: 'zero' });
  });

  it('writes the body the server takes, with the amounts as whole numbers', () => {
    expect(correctionBody(withLines('ADJUSTMENT', [[' Reduction ', '-0036500000']]))).toEqual({
      correction_reason: 'The plan was billed at the wrong price.',
      agreement_document_ref: 'BB-2026/0042',
      lines: [{ description: 'Reduction', amount_vnd: '-36500000', vat_category: 'NOT_SUBJECT' }],
    });
  });

  it('reads what an invoice stands for from the server, falling back to its total, and works out what the tenant owes after a correction', () => {
    const items = toTenantInvoices({ items: [invoice('o1', { standing_vnd: '328500000' }), invoice('o2')] }).items;
    expect(items.map((entry) => entry.standingVnd)).toEqual(['328500000', '365000000']);
    expect(receivableAfter('ADJUSTMENT', '328500000', '328500000', '-10000000')).toBe('318500000');
    expect(receivableAfter('REPLACEMENT', '328500000', '328500000', '300000000')).toBe('300000000');
    expect(isCorrectable({ kind: 'ORIGINAL', status: 'Adjusted' })).toBe(true);
    expect(isCorrectable({ kind: 'ORIGINAL', status: 'Replaced' })).toBe(false);
    expect(isCorrectable({ kind: 'ADJUSTMENT', status: 'Issued' })).toBe(false);
    expect(isCorrectable({ kind: 'ORIGINAL', status: 'Draft' })).toBe(false);
  });
});

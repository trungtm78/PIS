import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import BillingScreen from './BillingScreen';
import { WAITING_REFRESH_MS, formatVnd, isWaiting, toTenantInvoices, validateRun } from './billing/model';
import type { InvoiceView } from './billing/model';
import { harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-09', 'FR-SAS-09');
const BILLING = ['system.tenant.read', 'system.billing.manage'];
const READER = ['system.tenant.read'];
const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const problem = (code: string, status = 409, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), extensions: {} });

const line = (n: number, overrides: Record<string, unknown> = {}) => ({ id: `line-${n}`, invoice_id: 'inv-1', line_no: n, kind: 'SUBSCRIPTION', description: 'Gói Chuẩn (standard)', amount_vnd: '1000000', vat_category: 'VAT_10', vat_vnd: '100000', ...overrides });
const invoice = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  subscription_id: 'sub-1',
  invoice_code: 'INV-20260101-AAAA1111',
  period_start: '2026-01-01',
  period_end: '2026-01-31',
  kind: 'ORIGINAL',
  status: 'Draft',
  subtotal_vnd: '1000000',
  vat_vnd: '100000',
  total_vnd: '1100000',
  buyer: { code: 'cao-bang', name: 'Cao Bằng' },
  due_at: '2026-02-15',
  issue_attempts: 0,
  version: 3,
  lines: [line(1), line(2, { kind: 'USAGE', description: 'ai_calls: 30 ai_call beyond the 100 included', amount_vnd: '450', vat_vnd: '45' })],
  actions: { issue: true },
  ...overrides,
});

interface World {
  invoices: Record<string, unknown> | Error;
}

function client(world: World, command: (operation: string, input: unknown) => unknown = () => ({ status: 'ISSUED' })) {
  const h = harness((operation) => {
    if (operation === 'listSystemTenants') return { items: [{ id: TENANT_A, code: 'cao-bang', name: 'Cao Bằng' }], next_cursor: null };
    if (operation === 'listTenantInvoices') return world.invoices;
    return new Error(`unexpected read ${operation}`);
  }, command);
  return h;
}

const listOf = (items: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ items, ...extra });

afterEach(cleanup);

const runForm = () => within(screen.getByRole('form', { name: vi_['sas.billing.run.aria'] }));
const row = (id: string): HTMLElement => document.querySelector(`[data-invoice-id="${id}"]`) as HTMLElement;

describe('BillingScreen (SAS-09): the billing and the e-invoices of a tenant', () => {
  it('shows the invoices with their period, status, total, due day and e-invoice number, and the lines of each (UI-SAS-09, AC-ST-SAS-011-5)', async () => {
    const issued = invoice({ id: 'inv-2', invoice_code: 'INV-20251201-BBBB2222', period_start: '2025-12-01', period_end: '2025-12-31', status: 'Issued', actions: { issue: false }, einvoice: { provider: 'MOCK', template_code: '1', series: 'C26TMV', number: '0000007' }, issue_attempts: 1 });
    mount(<BillingScreen route={ROUTE} />, client({ invoices: listOf([invoice(), issued]) }), BILLING);
    await waitFor(() => expect(row('inv-1')).not.toBeNull());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['sas.billing.page.title']);
    const draft = row('inv-1');
    expect(draft.textContent).toContain(vi_['sas.billing.status.draft']);
    expect(draft.textContent).toContain((1100000).toLocaleString('vi'));
    expect(draft.textContent).toContain(new Date('2026-02-15T00:00:00Z').toLocaleDateString('vi', { timeZone: 'UTC' }));
    expect(row('inv-2').textContent).toContain(vi_['sas.billing.status.issued']);
    expect(row('inv-2').textContent).toContain('C26TMV 0000007');
    // The lines are one click away, with the kind in words.
    const lines = document.querySelector('[data-lines-of="inv-1"]') as HTMLElement;
    expect(lines.textContent).toContain(vi_['sas.billing.kind.subscription']);
    expect(lines.textContent).toContain(vi_['sas.billing.kind.usage']);
    expect(lines.textContent).toContain('450');
    // Issue is offered for the Draft only.
    expect(within(draft).queryByRole('button', { name: vi_['sas.billing.issue.action'] })).not.toBeNull();
    expect(within(row('inv-2')).queryByRole('button', { name: vi_['sas.billing.issue.action'] })).toBeNull();
  });

  it('offers nothing that cancels an invoice: an issued invoice is corrected by an adjustment or a replacement', async () => {
    mount(<BillingScreen route={ROUTE} />, client({ invoices: listOf([invoice(), invoice({ id: 'inv-2', status: 'Issued', actions: { issue: false } })]) }), BILLING);
    await waitFor(() => expect(row('inv-1')).not.toBeNull());
    const everything = (document.body.textContent ?? '').toLowerCase();
    expect(everything).not.toMatch(/cancel|void|hủy|huỷ/);
    for (const button of screen.getAllByRole('button')) expect(button.textContent?.toLowerCase()).not.toMatch(/cancel|void|hủy|huỷ/);
  });

  it('tells a tenant that is past due, and that a suspension is only proposed (AC-ST-SAS-011-4)', async () => {
    mount(<BillingScreen route={ROUTE} />, client({ invoices: listOf([invoice({ status: 'Overdue', actions: { issue: false } })], { subscription_status: 'PastDue', past_due_since: '2026-03-01T03:00:00Z', suspension_proposed_at: '2026-03-31T03:00:00Z' }) }), BILLING);
    await waitFor(() => expect(document.querySelector('[data-past-due]')).not.toBeNull());
    expect(document.querySelector('[data-past-due]')?.textContent).toContain(new Date('2026-03-01T03:00:00Z').toLocaleString('vi', { timeZone: 'UTC' }));
    expect(document.querySelector('[data-suspension-proposed]')?.textContent).toContain(vi_['sas.billing.notice.suspension'].split('{day}')[0] ?? '');
    expect(row('inv-1').textContent).toContain(vi_['sas.billing.status.overdue']);
    // The screen has no way to suspend: that is a decision of the System Admin elsewhere.
    expect(screen.queryByRole('button', { name: /suspend|tạm ngừng/i })).toBeNull();
  });

  it('says nothing about being past due for a tenant that is not', async () => {
    mount(<BillingScreen route={ROUTE} />, client({ invoices: listOf([invoice()], { subscription_status: 'Active' }) }), BILLING);
    await waitFor(() => expect(row('inv-1')).not.toBeNull());
    expect(document.querySelector('[data-past-due]')).toBeNull();
  });

  describe('the billing run', () => {
    it('refuses a form that is empty, backwards or longer than a year, and sends nothing', async () => {
      const h = client({ invoices: listOf([]) });
      mount(<BillingScreen route={ROUTE} />, h, BILLING);
      await waitFor(() => expect(screen.queryByRole('form', { name: vi_['sas.billing.run.aria'] })).not.toBeNull());
      fireEvent.click(runForm().getByRole('button', { name: vi_['sas.billing.run.submit.action'] }));
      expect(screen.getAllByText(vi_['sas.billing.field.required'])).toHaveLength(2);
      fireEvent.change(runForm().getByLabelText(vi_['sas.billing.run.start.label']), { target: { value: '2026-02-01' } });
      fireEvent.change(runForm().getByLabelText(vi_['sas.billing.run.end.label']), { target: { value: '2026-01-01' } });
      expect(screen.queryByText(vi_['sas.billing.field.backwards'])).not.toBeNull();
      fireEvent.change(runForm().getByLabelText(vi_['sas.billing.run.end.label']), { target: { value: '2027-06-01' } });
      expect(screen.queryByText(vi_['sas.billing.field.tooLong'])).not.toBeNull();
      fireEvent.click(runForm().getByRole('button', { name: vi_['sas.billing.run.submit.action'] }));
      expect(h.command).not.toHaveBeenCalled();
    });

    it('runs the billing for the tenant and the period, and says so', async () => {
      const h = client({ invoices: listOf([]) }, () => ({ status: 'BILLED' }));
      mount(<BillingScreen route={ROUTE} />, h, BILLING);
      await waitFor(() => expect(screen.queryByRole('form', { name: vi_['sas.billing.run.aria'] })).not.toBeNull());
      fireEvent.change(runForm().getByLabelText(vi_['sas.billing.run.start.label']), { target: { value: '2026-01-01' } });
      fireEvent.change(runForm().getByLabelText(vi_['sas.billing.run.end.label']), { target: { value: '2026-01-31' } });
      fireEvent.click(runForm().getByRole('button', { name: vi_['sas.billing.run.submit.action'] }));
      await waitFor(() => expect(screen.queryByText(vi_['sas.billing.run.done'])).not.toBeNull());
      const [operation, input] = h.command.mock.calls[0] as [string, { body: unknown }];
      expect(operation).toBe('runBillingCycle');
      expect(input.body).toEqual({ period_start: '2026-01-01', period_end: '2026-01-31', tenant_ids: [TENANT_A] });
    });

    it('says why the server refused a period', async () => {
      const h = client({ invoices: listOf([]) }, () => problem('BILLING_PERIOD_INVALID', 422, 'period_start'));
      mount(<BillingScreen route={ROUTE} />, h, BILLING);
      await waitFor(() => expect(screen.queryByRole('form', { name: vi_['sas.billing.run.aria'] })).not.toBeNull());
      fireEvent.change(runForm().getByLabelText(vi_['sas.billing.run.start.label']), { target: { value: '2026-01-01' } });
      fireEvent.change(runForm().getByLabelText(vi_['sas.billing.run.end.label']), { target: { value: '2026-01-31' } });
      fireEvent.click(runForm().getByRole('button', { name: vi_['sas.billing.run.submit.action'] }));
      await waitFor(() => expect(screen.queryByText(vi_['sas.billing.problem.period'])).not.toBeNull());
    });
  });

  describe('the issue', () => {
    const open = async (h = client({ invoices: listOf([invoice()]) })) => {
      mount(<BillingScreen route={ROUTE} />, h, BILLING);
      await waitFor(() => expect(row('inv-1')).not.toBeNull());
      fireEvent.click(within(row('inv-1')).getByRole('button', { name: vi_['sas.billing.issue.action'] }));
      return h;
    };
    const issueForm = () => within(screen.getByRole('form', { name: vi_['sas.billing.issue.aria'] }));

    it('asks for a reason of at least ten characters and sends nothing before it has one', async () => {
      const h = await open();
      fireEvent.change(issueForm().getByLabelText(vi_['sas.billing.issue.reason.label']), { target: { value: 'short' } });
      fireEvent.click(issueForm().getByRole('button', { name: vi_['sas.billing.issue.confirm.action'] }));
      expect(screen.queryByText(vi_['sas.billing.issue.reason.tooShort'])).not.toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('issues the invoice with its version and the reason, and says it was issued', async () => {
      const h = await open();
      fireEvent.change(issueForm().getByLabelText(vi_['sas.billing.issue.reason.label']), { target: { value: 'Issue the invoice of January.' } });
      fireEvent.click(issueForm().getByRole('button', { name: vi_['sas.billing.issue.confirm.action'] }));
      await waitFor(() => expect(screen.queryByText(vi_['sas.billing.issue.done.issued'])).not.toBeNull());
      const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown; ifMatchVersion: number }];
      expect(operation).toBe('issueEInvoice');
      expect(input).toMatchObject({ path: { invoiceId: 'inv-1' }, body: { reason: 'Issue the invoice of January.' }, ifMatchVersion: 3 });
    });

    it('says that the invoice waits when the provider did not answer, and that it could not be issued when the tries are over', async () => {
      const waiting = await open(client({ invoices: listOf([invoice()]) }, () => ({ status: 'PENDING_ISSUE' })));
      fireEvent.change(issueForm().getByLabelText(vi_['sas.billing.issue.reason.label']), { target: { value: 'Issue the invoice of January.' } });
      fireEvent.click(issueForm().getByRole('button', { name: vi_['sas.billing.issue.confirm.action'] }));
      await waitFor(() => expect(screen.queryByText(vi_['sas.billing.issue.done.pending'])).not.toBeNull());
      expect(waiting.command).toHaveBeenCalledTimes(1);
      cleanup();
      await open(client({ invoices: listOf([invoice({ status: 'IssueFailed', issue_attempts: 5 })]) }, () => ({ status: 'ISSUE_FAILED' })));
      fireEvent.change(issueForm().getByLabelText(vi_['sas.billing.issue.reason.label']), { target: { value: 'Issue the invoice of January.' } });
      fireEvent.click(issueForm().getByRole('button', { name: vi_['sas.billing.issue.confirm.action'] }));
      await waitFor(() => expect(screen.queryByText(vi_['sas.billing.issue.done.failed'])).not.toBeNull());
    });

    it('says why the server refused: an invoice that is not a Draft, or one that changed since the page was read', async () => {
      await open(client({ invoices: listOf([invoice()]) }, () => problem('EINVOICE_STATE_INVALID')));
      fireEvent.change(issueForm().getByLabelText(vi_['sas.billing.issue.reason.label']), { target: { value: 'Issue the invoice of January.' } });
      fireEvent.click(issueForm().getByRole('button', { name: vi_['sas.billing.issue.confirm.action'] }));
      await waitFor(() => expect(screen.queryByText(vi_['sas.billing.problem.stateInvalid'])).not.toBeNull());
      cleanup();
      await open(client({ invoices: listOf([invoice()]) }, () => problem('VERSION_CONFLICT')));
      fireEvent.change(issueForm().getByLabelText(vi_['sas.billing.issue.reason.label']), { target: { value: 'Issue the invoice of January.' } });
      fireEvent.click(issueForm().getByRole('button', { name: vi_['sas.billing.issue.confirm.action'] }));
      await waitFor(() => expect(screen.queryByText(vi_['sas.billing.problem.conflict'])).not.toBeNull());
    });

    it('closes the form without sending anything', async () => {
      const h = await open();
      fireEvent.click(issueForm().getByRole('button', { name: vi_['sas.billing.issue.abort.action'] }));
      expect(screen.queryByRole('form', { name: vi_['sas.billing.issue.aria'] })).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });
  });

  it('does not carry the invoice picked for issue over to another tenant', async () => {
    const TENANT_B = '00000000-0000-4000-8000-0000000000b1';
    const h = harness((operation, input) => {
      if (operation === 'listSystemTenants')
        return {
          items: [
            { id: TENANT_A, code: 'cao-bang', name: 'Cao Bằng' },
            { id: TENANT_B, code: 'ha-giang', name: 'Hà Giang' },
          ],
          next_cursor: null,
        };
      if (operation === 'listTenantInvoices') return listOf([invoice({ id: (input as { path: { tenantId: string } }).path.tenantId === TENANT_A ? 'inv-a' : 'inv-b' })]);
      return new Error(`unexpected read ${operation}`);
    });
    mount(<BillingScreen route={ROUTE} />, h, BILLING);
    await waitFor(() => expect(row('inv-a')).not.toBeNull());
    fireEvent.click(within(row('inv-a')).getByRole('button', { name: vi_['sas.billing.issue.action'] }));
    expect(screen.queryByRole('form', { name: vi_['sas.billing.issue.aria'] })).not.toBeNull();
    fireEvent.change(screen.getByLabelText(vi_['sas.billing.tenant.label']), { target: { value: TENANT_B } });
    await waitFor(() => expect(row('inv-b')).not.toBeNull());
    expect(screen.queryByRole('form', { name: vi_['sas.billing.issue.aria'] })).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('loads the older invoices on request, and only while there are more', async () => {
    const pages = new Map<string | undefined, Record<string, unknown>>([
      [undefined, listOf([invoice({ id: 'inv-new', period_start: '2026-03-01', period_end: '2026-03-31' })], { next_cursor: 'older' })],
      ['older', listOf([invoice({ id: 'inv-old', period_start: '2026-01-01', period_end: '2026-01-31' })], { next_cursor: null })],
    ]);
    const h = harness((operation, input) => {
      if (operation === 'listSystemTenants') return { items: [{ id: TENANT_A, code: 'cao-bang', name: 'Cao Bằng' }], next_cursor: null };
      if (operation === 'listTenantInvoices') return pages.get((input as { query?: { cursor?: string } }).query?.cursor) ?? new Error('unknown page');
      return new Error(`unexpected read ${operation}`);
    });
    mount(<BillingScreen route={ROUTE} />, h, BILLING);
    await waitFor(() => expect(row('inv-new')).not.toBeNull());
    expect(row('inv-old')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.billing.invoices.more.action'] }));
    await waitFor(() => expect(row('inv-old')).not.toBeNull());
    expect(row('inv-new')).not.toBeNull();
    expect(screen.queryByRole('button', { name: vi_['sas.billing.invoices.more.action'] })).toBeNull();
  });

  it('shows a reader the invoices and nothing to run or to issue', async () => {
    mount(<BillingScreen route={ROUTE} />, client({ invoices: listOf([invoice()]) }), READER);
    await waitFor(() => expect(row('inv-1')).not.toBeNull());
    expect(screen.queryByRole('form', { name: vi_['sas.billing.run.aria'] })).toBeNull();
    expect(within(row('inv-1')).queryByRole('button', { name: vi_['sas.billing.issue.action'] })).toBeNull();
  });

  it('shows the states: no invoice yet, and a read that failed with a way to try again', async () => {
    mount(<BillingScreen route={ROUTE} />, client({ invoices: listOf([]) }), BILLING);
    await waitFor(() => expect(screen.queryByText(vi_['sas.billing.invoices.none'])).not.toBeNull());
    cleanup();
    const failing = client({ invoices: new Error('boom') });
    mount(<BillingScreen route={ROUTE} />, failing, BILLING);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
    expect(screen.queryByRole('button', { name: /thử lại|retry/i })).not.toBeNull();
  });

  it('reads again while an invoice waits for the provider, so that it shows the invoice issued, and stops when none waits', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const world: World = { invoices: listOf([invoice({ status: 'PendingIssue', issue_attempts: 1, actions: { issue: false }, next_attempt_at: '2026-03-05T03:10:00Z' })]) };
      const h = client(world);
      mount(<BillingScreen route={ROUTE} />, h, BILLING);
      await waitFor(() => expect(row('inv-1')).not.toBeNull());
      expect(row('inv-1').querySelector('[data-attempts]')?.textContent).toContain(vi_['sas.billing.attempts.text'].replace('{count}', '1'));
      const reads = () => h.read.mock.calls.filter(([operation]) => operation === 'listTenantInvoices').length;
      const before = reads();
      world.invoices = listOf([invoice({ status: 'Issued', issue_attempts: 2, actions: { issue: false }, einvoice: { provider: 'MOCK', template_code: '1', series: 'C26TMV', number: '0000009' } })]);
      await vi.advanceTimersByTimeAsync(WAITING_REFRESH_MS + 500);
      await waitFor(() => expect(reads()).toBeGreaterThan(before));
      await waitFor(() => expect(row('inv-1').textContent).toContain(vi_['sas.billing.status.issued']));
      const settled = reads();
      await vi.advanceTimersByTimeAsync(WAITING_REFRESH_MS * 3);
      expect(reads()).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the model of SAS-09', () => {
  it('reads what the server sends and ignores what it cannot place', () => {
    const view = toTenantInvoices({ items: [invoice({ status: 'Mystery' }), { nothing: true }], past_due_since: '2026-03-01T00:00:00Z' });
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ status: 'Draft', totalVnd: '1100000', canIssue: true });
    expect(view.pastDueSince).toBe('2026-03-01T00:00:00Z');
    expect(toTenantInvoices(undefined)).toEqual({ items: [], subscriptionStatus: undefined, pastDueSince: undefined, suspensionProposedAt: undefined });
  });

  it('judges the form of the run as the server does', () => {
    expect(validateRun({ periodStart: '', periodEnd: '' })).toEqual({ periodStart: 'required', periodEnd: 'required' });
    expect(validateRun({ periodStart: '2026-02-30', periodEnd: '2026-03-01' })).toEqual({ periodStart: 'notDate' });
    expect(validateRun({ periodStart: '2026-02-01', periodEnd: '2026-01-01' })).toEqual({ periodEnd: 'backwards' });
    expect(validateRun({ periodStart: '2025-03-06', periodEnd: '2026-03-07' })).toEqual({ periodEnd: 'tooLong' });
    expect(validateRun({ periodStart: '2025-03-06', periodEnd: '2026-03-05' })).toEqual({});
  });

  it('writes whole VND exactly, and follows only the invoices that wait', () => {
    expect(formatVnd('123456789012345678', 'en')).toBe('123,456,789,012,345,678');
    expect(formatVnd('-5', 'en')).toBe('-5');
    expect(formatVnd('x', 'en')).toBe('x');
    expect(isWaiting([{ status: 'PendingIssue' }] as InvoiceView[])).toBe(true);
    expect(isWaiting([{ status: 'Issued' }, { status: 'IssueFailed' }] as InvoiceView[])).toBe(false);
    expect(isWaiting(undefined)).toBe(false);
  });
});

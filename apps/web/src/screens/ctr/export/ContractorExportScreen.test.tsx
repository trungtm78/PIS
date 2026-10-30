import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness as baseHarness } from '../../sas/test-support';
import { mount } from '../test-support';
import { routeOf } from '../retention/test-support';
import Screen from './ContractorExportScreen';
import { describeProblem, emptyExport, emptySubmission, exportBody, linkOf, shownError, submissionBody, toBatches, toDownload, validateExport, validateSubmission } from './model';

const ROUTE = routeOf('CTR-24', 'FR-CTR-24');
const EXPORTER = ['contractor.export'];
const SHA = 'a'.repeat(64);
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c' });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const batch = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00b00000000${n}`,
  scope: 'BOTH',
  period_from: '2026-07-01',
  period_to: '2026-09-30',
  format: 'CSV',
  row_count: 4,
  file_sha256: SHA,
  status: 'GENERATED',
  submitted_ref: null,
  submitted_on: null,
  created_at: '2026-10-25T01:00:00.000000Z',
  version: 1,
  ...overrides,
});
const page = (items: unknown[] = []) => ({ items, next_cursor: null, adapter: { state: 'PROPOSED', api: 'MISSING', cxn: 'CXN-EXE-01' }, as_of: '2026-10-25T03:00:00.000Z' });

afterEach(cleanup);

function open(answer: () => unknown, options: { permissions?: readonly string[]; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; download?: () => unknown } = {}) {
  const h = baseHarness(
    (operation) => (operation === 'listContractorExports' ? answer() : operation === 'getContractorExportDownload' ? (options.download ?? (() => ({ url: '/contractor-exports/x/file?signature=s', expires_at: '2026-10-25T03:05:00.000Z', rows: 4 })))() : new Error(`unexpected read ${operation}`)),
    options.command ?? (() => ({ operation_id: 'o', status: 'GENERATED', resource_version: 1, resource_id: 'x' })),
  );
  mount(<Screen route={ROUTE} />, h, { permissions: options.permissions ?? EXPORTER, path: '/ctr/ctr-24', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}
const ready = async (): Promise<void> => {
  await screen.findByTestId('adapter');
};
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const commandsOf = (h: ReturnType<typeof open>, operation: string) => h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown> });

describe('ContractorExportScreen (CTR-24): the export of the records of the contractors', () => {
  it('UI-CTR-24: says the adapter is PROPOSED and its API MISSING, and lists the batches with the period, the rows, the hash, the state and the receipt', async () => {
    open(() => page([batch(1), batch(2, { status: 'SUBMITTED_EXTERNALLY', submitted_ref: 'QG-2026-0001', submitted_on: '2026-10-02', scope: 'VIOLATION', format: 'JSON' })]));
    await ready();
    expect(screen.getByTestId('adapter').textContent).toBe(text('ctr.export.adapter.notice', { state: 'PROPOSED', api: 'MISSING' }));
    const rows = document.querySelectorAll('[data-batch]');
    expect(rows).toHaveLength(2);
    const first = rows[0] as HTMLElement;
    expect(within(first).getByTestId('scope').textContent).toBe(text('ctr.export.scope.both'));
    expect(within(first).getByTestId('period').textContent).toBe('2026-07-01 – 2026-09-30');
    expect(within(first).getByTestId('rows').textContent).toBe('4');
    expect(within(first).getByTestId('sha').textContent).toBe(SHA);
    expect(within(first).getByTestId('status').textContent).toBe(text('ctr.export.status.generated'));
    expect(within(first).getByTestId('receipt').textContent).toBe(text('ctr.export.receipt.none'));
    const second = rows[1] as HTMLElement;
    expect(within(second).getByTestId('status').textContent).toBe(text('ctr.export.status.submitted'));
    expect(within(second).getByTestId('receipt').textContent).toBe('QG-2026-0001 · 2026-10-02');
    expect(within(second).getByTestId('format').textContent).toBe('JSON');
    expect(document.querySelector('[data-submit]')?.getAttribute('data-submit')).toBe(batch(1).id);
    expect(document.querySelectorAll('[data-submit]')).toHaveLength(1);
  });

  it('AC-ST-CTR-015-1 UAT-AC315: sends the scope, the period and the format, and says the file is made; a period with nothing in it is told in words', async () => {
    const h = open(() => page(), { command: () => problem('EXPORT_EMPTY') });
    await ready();
    expect(screen.getByTestId('no-batches')).toBeTruthy();
    pick('export-scope', 'PERFORMANCE');
    pick('export-from', '2027-01-01');
    pick('export-to', '2027-01-31');
    pick('export-format', 'JSON');
    fireEvent.submit(screen.getByTestId('export-form'));
    expect((await screen.findByTestId('refusal')).textContent).toBe(text('ctr.export.error.empty'));
    expect(commandsOf(h, 'exportContractorRecords')[0]?.body).toEqual({ scope: 'PERFORMANCE', period_from: '2027-01-01', period_to: '2027-01-31', format: 'JSON' });
  });

  it('says the file was made when the server accepts the request', async () => {
    const h = open(() => page());
    await ready();
    pick('export-from', '2026-07-01');
    pick('export-to', '2026-09-30');
    fireEvent.submit(screen.getByTestId('export-form'));
    expect((await screen.findByTestId('made')).textContent).toBe(text('ctr.export.form.done'));
    expect(commandsOf(h, 'exportContractorRecords')[0]?.body).toEqual({ scope: 'BOTH', period_from: '2026-07-01', period_to: '2026-09-30', format: 'CSV' });
    await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'listContractorExports').length).toBeGreaterThan(1));
  });

  it('names what is wrong before sending: no day, a day that is not real, a period the wrong way round or too long', async () => {
    const h = open(() => page());
    await ready();
    fireEvent.submit(screen.getByTestId('export-form'));
    expect(await screen.findAllByText(text('ctr.export.problem.required'))).toHaveLength(2);
    pick('export-from', '2026-02-30');
    pick('export-to', '2026-09-30');
    fireEvent.submit(screen.getByTestId('export-form'));
    expect(await screen.findByText(text('ctr.export.problem.day'))).toBeTruthy();
    pick('export-from', '2026-10-01');
    fireEvent.submit(screen.getByTestId('export-form'));
    expect(await screen.findByText(text('ctr.export.problem.order'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('asks for the link of a file and offers it, and says in words when the server refuses to give one', async () => {
    open(() => page([batch(1)]), { download: () => ({ url: '/contractor-exports/x/file?signature=s', expires_at: '2026-10-25T03:05:00.000Z', rows: 4 }) });
    await ready();
    fireEvent.click(document.querySelector('[data-download]') as HTMLElement);
    const link = await screen.findByTestId('link');
    expect(link.getAttribute('href')).toContain('/contractor-exports/x/file?signature=s');
    cleanup();
    open(() => page([batch(1)]), { download: () => problem('RESOURCE_NOT_FOUND', 404) });
    await ready();
    fireEvent.click(document.querySelector('[data-download]') as HTMLElement);
    expect((await screen.findByTestId('download-problem')).textContent).toBe(text('ctr.export.error.notFound'));
  });

  it('AC-ST-CTR-015-2 UAT-PLAN-18: writes down the receipt of a submission by hand, with the number and the day, and checks them before sending', async () => {
    const h = open(() => page([batch(1)]));
    await ready();
    fireEvent.click(document.querySelector('[data-submit]') as HTMLElement);
    const dialog = screen.getByRole('dialog');
    fireEvent.submit(dialog.querySelector('form') as HTMLElement);
    expect(await within(dialog).findByText(text('ctr.export.problem.required'))).toBeTruthy();
    pick('submit-reference', 'x'.repeat(101));
    fireEvent.submit(dialog.querySelector('form') as HTMLElement);
    expect(await within(dialog).findByText(text('ctr.export.problem.tooLong'))).toBeTruthy();
    pick('submit-reference', '  QG-2026-0001  ');
    pick('submit-day', '2099-01-01');
    fireEvent.submit(dialog.querySelector('form') as HTMLElement);
    expect(await within(dialog).findByText(text('ctr.export.problem.future'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    pick('submit-day', '2026-10-02');
    fireEvent.submit(dialog.querySelector('form') as HTMLElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(commandsOf(h, 'markContractorExportSubmitted')[0]).toMatchObject({ path: { id: batch(1).id }, body: { submitted_ref: 'QG-2026-0001', submitted_on: '2026-10-02' } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says in words that a receipt is written down already, and keeps the dialog open', async () => {
    open(() => page([batch(1)]), { command: () => problem('EXPORT_STATE_INVALID', 409) });
    await ready();
    fireEvent.click(document.querySelector('[data-submit]') as HTMLElement);
    pick('submit-reference', 'A');
    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLElement);
    expect((await within(screen.getByRole('dialog')).findByRole('alert')).textContent).toBe(text('ctr.export.error.state'));
  });

  it('follows the cursor of the list: older batches are shown when asked for, and the button goes when there are no more', async () => {
    const h = baseHarness((operation, input) => {
      if (operation !== 'listContractorExports') return new Error(`unexpected read ${operation}`);
      const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
      return cursor === undefined ? { ...page([batch(1)]), next_cursor: 'next-1' } : page([batch(2)]);
    }, () => ({}));
    mount(<Screen route={ROUTE} />, h, { permissions: EXPORTER, path: '/ctr/ctr-24' });
    await ready();
    expect(document.querySelectorAll('[data-batch]')).toHaveLength(1);
    fireEvent.click(document.querySelector('[data-more]') as HTMLElement);
    await waitFor(() => expect(document.querySelectorAll('[data-batch]')).toHaveLength(2));
    expect(h.read.mock.calls.map((call) => (call[1] as { query: Record<string, unknown> }).query)).toEqual([{ limit: 50 }, { limit: 50, cursor: 'next-1' }]);
    expect(document.querySelector('[data-more]')).toBeNull();
  });

  it('shows no form and no action while the tenant is read-only, and nothing to one who may not export', async () => {
    open(() => page([batch(1)]), { mode: 'READ_ONLY' });
    await ready();
    expect(document.querySelector('[data-testid="export-form"]')).toBeNull();
    expect(document.querySelector('[data-submit]')).toBeNull();
    expect(document.querySelector('[data-download]')).not.toBeNull();
    cleanup();
    const h = open(() => page(), { permissions: ['notification.self'] });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the seven states: loading, denied, signed out, offline, error and empty', async () => {
    open(() => page());
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    cleanup();
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      open(() => error);
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    open(() => ({ items: 3 }));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  describe('the rules of the forms', () => {
    it('reads the batches leniently, and the link of a download', () => {
      expect(toBatches(page([batch(1), { id: 3 }, batch(2, { scope: 'ALL' }), batch(3, { status: 'LOST' })]))?.items).toHaveLength(1);
      expect(toBatches(null)).toBeUndefined();
      expect(toBatches({ items: [] })?.adapter).toEqual({ state: 'PROPOSED', api: 'MISSING' });
      expect(toBatches({ items: [], next_cursor: 'c' })?.nextCursor).toBe('c');
      expect(toBatches({ items: [], next_cursor: null })?.nextCursor).toBeUndefined();
      expect(toDownload({ url: '/x', expires_at: 'e', rows: 2 })).toEqual({ url: '/x', expiresAt: 'e', rows: 2 });
      expect(toDownload({})).toBeUndefined();
      expect(toDownload(null)).toBeUndefined();
      expect(linkOf('/contractor-exports/x/file', '/api/')).toBe('/api/contractor-exports/x/file');
      expect(linkOf('contractor-exports/x/file', '')).toBe('/contractor-exports/x/file');
      expect(linkOf('https://files.example/x', '/api')).toBe('https://files.example/x');
    });

    it('judges a period and a submission before they are sent', () => {
      expect(validateExport({ ...emptyExport(), from: '2026-07-01', to: '2026-09-30' })).toEqual({});
      expect(validateExport({ ...emptyExport(), from: '2026-07-01', to: '2026-07-01' })).toEqual({});
      expect(validateExport({ ...emptyExport(), from: '2026-10-01', to: '2026-09-30' })).toEqual({ to: 'order' });
      expect(validateExport({ ...emptyExport(), from: '2018-01-01', to: '2026-09-30' })).toEqual({ to: 'order' });
      expect(validateExport({ ...emptyExport(), from: 'x', to: '' })).toEqual({ from: 'day', to: 'required' });
      expect(exportBody({ scope: 'VIOLATION', from: ' 2026-07-01 ', to: '2026-09-30', format: 'JSON' })).toEqual({ scope: 'VIOLATION', period_from: '2026-07-01', period_to: '2026-09-30', format: 'JSON' });
      expect(validateSubmission({ reference: 'A', day: '2026-10-01' }, '2026-10-01')).toEqual({});
      expect(validateSubmission({ reference: '', day: '' }, '2026-10-01')).toEqual({ reference: 'required', day: 'required' });
      expect(validateSubmission({ reference: 'x'.repeat(101), day: '2026-02-30' }, '2026-10-01')).toEqual({ reference: 'tooLong', day: 'day' });
      expect(validateSubmission({ reference: 'A', day: '2026-10-02' }, '2026-10-01')).toEqual({ day: 'future' });
      expect(emptySubmission('2026-10-01')).toEqual({ reference: '', day: '2026-10-01' });
      expect(submissionBody({ reference: ' A ', day: '2026-10-01' })).toEqual({ submitted_ref: 'A', submitted_on: '2026-10-01' });
    });

    it('tells a refusal of the server from a failure of the network', () => {
      expect(describeProblem(problem('EXPORT_ROW_CAP_EXCEEDED'))).toBe('tooMany');
      expect(describeProblem(problem('SCOPE_DENIED', 403))).toBe('denied');
      expect(describeProblem(problem('SESSION_EXPIRED', 401))).toBe('session');
      expect(describeProblem(problem('VALIDATION_FAILED'))).toBe('validation');
      expect(describeProblem(new Error('x'))).toBe('general');
      expect(shownError(null, true)).toBeUndefined();
      expect(shownError(new Error('x'), false)).toBeInstanceOf(Error);
      expect(shownError(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), true)).toBeUndefined();
      expect(shownError(problem('SCOPE_DENIED', 403), true)).toBeDefined();
    });
  });
});

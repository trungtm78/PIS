import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import PackagesScreen from './PackagesScreen';
import { harness, mount, obligationRow, routeOf } from './test-support';
import type { Harness } from './test-support';

const ROUTE = routeOf('MNE-06', 'FR-MNE-06');
const REPORT = '00000000-0000-4000-8000-000000000666';
const PACKAGE_A = '00000000-0000-4000-8000-0000000000a1';
const PACKAGE_B = '00000000-0000-4000-8000-0000000000a2';
const EXPORTER = ['mne.read', 'mne.report.export'];
const READ_ONLY = ['mne.read'];
const OPEN = `/?report=${REPORT}`;
const HASH_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HASH_B = 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const problem = (status: number, code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });

const packageBody = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  target_system: 'NATIONAL_PIM_SYSTEM',
  format: 'XLSX',
  file_sha256: HASH_A,
  file_size_bytes: 4096,
  adapter_status: 'PROPOSED',
  status: 'GENERATED',
  receipt: null,
  created_at: '2026-10-20T08:00:00.000000Z',
  downloaded_at: null,
  version: 1,
  download: { url: `/mne-export-packages/${id}/file?tenant=t&expires=9&signature=${'0'.repeat(64)}`, expires_at: '2999-01-01T00:00:00.000Z' },
  ...overrides,
});

const reportBody = (overrides: Record<string, unknown> = {}) => ({
  id: REPORT,
  form: { id: '00000000-0000-4000-8000-000000000101', code: 'TT44-M02', revision: 1, title: 'Báo cáo giám sát, đánh giá tổng thể 6 tháng', legal_confirmation_ref: null, watermark_text: null },
  awaiting_confirmation: true,
  cxn_refs: ['CXN-10'],
  report_year: 2026,
  period_label: 'H1-2026',
  scope_unit: { id: '00000000-0000-4000-8000-000000000501', code: 'CDT-1', name: 'Chủ đầu tư 1' },
  due_date: '2026-07-10',
  status: 'ISSUED',
  is_late: false,
  snapshot: { id: '00000000-0000-4000-8000-0000000000f2', as_of_date: '2026-06-30' },
  snapshot_options: [],
  fields: [],
  attachments: [],
  payload_sha256: HASH_B,
  doc_document_id: '00000000-0000-4000-8000-0000000000d1',
  document_state: 'ISSUED',
  packages: [],
  recalled_at: null,
  created_by: '00000000-0000-4000-8000-0000000000aa',
  submitted_by: '00000000-0000-4000-8000-0000000000aa',
  version: 7,
  ...overrides,
});

const OK = { operation_id: '00000000-0000-4000-8000-0000000000bb', status: 'EXPORTED', resource_version: 8, resource_id: REPORT };

function client(report: unknown, command: (operation: string, input: unknown) => unknown = () => OK): Harness {
  return harness((operation) => (operation === 'getMneReport' ? report : new Error(`unexpected read ${operation}`)), command);
}
const commands = (h: Harness): Array<[string, Record<string, unknown>]> => h.command.mock.calls.map((call) => [call[0] as string, call[1] as Record<string, unknown>]);

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('MNE-06 export packages and the receipt of the filing (ST-MNE-004)', () => {
  describe('AC-ST-MNE-004-3: UI-MNE-06 the packages', () => {
    it('AC-ST-MNE-004-3: UI-MNE-06 shows the adapter badge "PROPOSED - manual filing" and the short hash of each file, the whole hash in its title', async () => {
      const report = reportBody({ packages: [packageBody(PACKAGE_A), packageBody(PACKAGE_B, { format: 'PDF', file_sha256: HASH_B, adapter_status: 'MISSING' })] });
      mount(<PackagesScreen route={ROUTE} />, client(report), { permissions: EXPORTER }, OPEN);
      expect(await screen.findByTestId(`adapter-${PACKAGE_A}`)).toBeTruthy();
      expect(screen.getByTestId(`adapter-${PACKAGE_A}`).textContent).toBe(vi_['mne.export.adapter.proposed']);
      expect(screen.getByTestId(`adapter-${PACKAGE_B}`).textContent).toBe(vi_['mne.export.adapter.missing']);
      const hash = screen.getByTestId(`hash-${PACKAGE_A}`);
      expect(hash.textContent).toBe('a1b2c3d4e5f6…8f90');
      expect(hash.textContent?.length).toBeLessThan(HASH_A.length);
      expect(hash.closest('td')?.getAttribute('title')).toBe(HASH_A);
      expect(within(document.querySelector(`tr[data-package-id="${PACKAGE_A}"]`) as HTMLElement).getByText(vi_['mne.export.status.generated'])).toBeTruthy();
      expect(within(document.querySelector(`tr[data-package-id="${PACKAGE_B}"]`) as HTMLElement).getByText(vi_['mne.export.format.pdf'])).toBeTruthy();
    });

    it('offers the file by its link to who may export, and says there is none when there is no link', async () => {
      const report = reportBody({ packages: [packageBody(PACKAGE_A), packageBody(PACKAGE_B, { download: null })] });
      mount(<PackagesScreen route={ROUTE} />, client(report), { permissions: EXPORTER }, OPEN);
      await screen.findByTestId(`hash-${PACKAGE_A}`);
      const link = within(document.querySelector(`tr[data-package-id="${PACKAGE_A}"]`) as HTMLElement).getByRole('link', { name: vi_['mne.export.download.action'] });
      expect(link.getAttribute('href')).toContain(`/mne-export-packages/${PACKAGE_A}/file?`);
      expect(within(document.querySelector(`tr[data-package-id="${PACKAGE_B}"]`) as HTMLElement).getByText(vi_['mne.export.download.none'])).toBeTruthy();
    });

    it('resolves the link against the base the web app calls the API on, so that a proxy prefix or another host is reached', async () => {
      vi.stubEnv('VITE_API_BASE_URL', '/api');
      mount(<PackagesScreen route={ROUTE} />, client(reportBody({ packages: [packageBody(PACKAGE_A)] })), { permissions: EXPORTER }, OPEN);
      const link = await screen.findByRole('link', { name: vi_['mne.export.download.action'] });
      expect(link.getAttribute('href')).toBe(`/api/mne-export-packages/${PACKAGE_A}/file?tenant=t&expires=9&signature=${'0'.repeat(64)}`);
    });

    it('does not follow a link that has run out: the packages are read again at once and the new link is the one to follow', async () => {
      const user = userEvent.setup();
      let reads = 0;
      const h = harness((operation) => {
        if (operation !== 'getMneReport') return new Error('unexpected read');
        reads += 1;
        return reportBody({ packages: [packageBody(PACKAGE_A, reads === 1 ? { download: { url: '/old', expires_at: '2020-01-01T00:00:00.000Z' } } : { download: { url: '/fresh', expires_at: '2999-01-01T00:00:00.000Z' } })] });
      });
      mount(<PackagesScreen route={ROUTE} />, h, { permissions: EXPORTER }, OPEN);
      const link = await screen.findByRole('link', { name: vi_['mne.export.download.action'] });
      let prevented = false;
      // The handler of React runs at the root of the page: what the page does with the click is seen from the document, after it.
      const seen = (event: Event): void => {
        prevented = event.defaultPrevented;
        event.preventDefault();
      };
      document.addEventListener('click', seen);
      await user.click(link);
      document.removeEventListener('click', seen);
      expect(prevented).toBe(true);
      await waitFor(() => expect(reads).toBe(2));
      expect((await screen.findByRole('link', { name: vi_['mne.export.download.action'] })).getAttribute('href')).toBe('/fresh');
    });

    it('reads the packages again a moment after a file was asked for, because serving it moves the package, so that the receipt carries the version that stands', async () => {
      const user = userEvent.setup();
      let version = 1;
      const h = harness((operation) => (operation === 'getMneReport' ? reportBody({ status: 'EXPORTED', packages: [packageBody(PACKAGE_A, { version })] }) : new Error('unexpected read')), () => ({ ...OK, status: 'SUBMISSION_CONFIRMED', resource_id: PACKAGE_A }));
      mount(<PackagesScreen route={ROUTE} />, h, { permissions: EXPORTER }, OPEN);
      const link = await screen.findByRole('link', { name: vi_['mne.export.download.action'] });
      link.addEventListener('click', (event) => event.preventDefault());
      version = 2;
      await user.click(link);
      await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'getMneReport').length).toBeGreaterThanOrEqual(2), { timeout: 4000 });
      await user.type(await screen.findByLabelText(vi_['mne.export.receipt.reference.label']), 'QG-1');
      fireEvent.change(screen.getByLabelText(vi_['mne.export.receipt.submittedAt.label']), { target: { value: '2026-07-09T10:30' } });
      await user.click(screen.getByRole('button', { name: vi_['mne.export.receipt.action'] }));
      await waitFor(() => expect(commands(h)).toHaveLength(1));
      expect(commands(h)[0]?.[1]).toMatchObject({ ifMatchVersion: 2 });
    });

    it('reads the report again after a version conflict, so that the next attempt carries the version that stands', async () => {
      const user = userEvent.setup();
      let version = 1;
      const h = harness(
        (operation) => (operation === 'getMneReport' ? reportBody({ status: 'EXPORTED', packages: [packageBody(PACKAGE_A, { version })] }) : new Error('unexpected read')),
        () => {
          version = 5;
          return problem(409, 'VERSION_CONFLICT');
        },
      );
      mount(<PackagesScreen route={ROUTE} />, h, { permissions: EXPORTER }, OPEN);
      await user.type(await screen.findByLabelText(vi_['mne.export.receipt.reference.label']), 'QG-1');
      fireEvent.change(screen.getByLabelText(vi_['mne.export.receipt.submittedAt.label']), { target: { value: '2026-07-09T10:30' } });
      await user.click(screen.getByRole('button', { name: vi_['mne.export.receipt.action'] }));
      expect((await screen.findByTestId('report-problem')).textContent).toBe(vi_['mne.report.problem.conflict']);
      await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'getMneReport').length).toBeGreaterThanOrEqual(2));
    });

    it('shows the receipt of a filed package and that a late filing was late', async () => {
      const receipt = { reference: 'QG-2026-000123', document_id: null, submitted_at: '2026-07-12T03:00:00.000000Z', recorded_at: '2026-07-12T03:05:00.000000Z' };
      const report = reportBody({ status: 'SUBMITTED_EXTERNAL', is_late: true, packages: [packageBody(PACKAGE_A, { status: 'SUBMISSION_CONFIRMED', receipt, download: null })] });
      mount(<PackagesScreen route={ROUTE} />, client(report), { permissions: EXPORTER }, OPEN);
      expect((await screen.findByTestId(`receipt-${PACKAGE_A}`)).textContent).toBe(fill(vi_['mne.export.receipt.shown'], { reference: 'QG-2026-000123', at: '2026-07-12T03:00:00.000000Z' }));
      expect(screen.getByTestId('filed-late').textContent).toBe(fill(vi_['mne.export.late.text'], { due: '2026-07-10' }));
      // A filed package takes no second receipt.
      expect(document.querySelector(`tr[data-receipt-for="${PACKAGE_A}"]`)).toBeNull();
    });

    it('says there are no packages yet', async () => {
      mount(<PackagesScreen route={ROUTE} />, client(reportBody()), { permissions: EXPORTER }, OPEN);
      expect((await screen.findByTestId('packages-empty')).textContent).toBe(vi_['mne.export.packages.empty']);
    });
  });

  describe('making the files', () => {
    it('AC-ST-MNE-004-1: sends the recipient and the formats that were ticked, with the version of the report, and says so', async () => {
      const user = userEvent.setup();
      const h = client(reportBody());
      mount(<PackagesScreen route={ROUTE} />, h, { permissions: EXPORTER }, OPEN);
      await user.selectOptions(await screen.findByLabelText(vi_['mne.export.generate.target.label']), 'RECIPIENT_AGENCY');
      await user.click(screen.getByLabelText(vi_['mne.export.format.pdf']));
      await user.click(screen.getByRole('button', { name: vi_['mne.export.generate.action'] }));
      await waitFor(() => expect(commands(h)).toHaveLength(1));
      expect(commands(h)[0]).toEqual(['generateMneExportPackage', expect.objectContaining({ path: { id: REPORT }, ifMatchVersion: 7, body: { target_system: 'RECIPIENT_AGENCY', formats: ['XLSX', 'PDF'] } })]);
      expect((await screen.findByTestId('export-done')).textContent).toBe(vi_['mne.export.generate.done']);
    });

    it('sends nothing and says so when no format is ticked, and does not offer the XML', async () => {
      const user = userEvent.setup();
      const h = client(reportBody());
      mount(<PackagesScreen route={ROUTE} />, h, { permissions: EXPORTER }, OPEN);
      await user.click(await screen.findByLabelText(vi_['mne.export.format.xlsx']));
      await user.click(screen.getByRole('button', { name: vi_['mne.export.generate.action'] }));
      expect(await screen.findByText(vi_['mne.export.generate.none'])).toBeTruthy();
      expect(commands(h)).toHaveLength(0);
      expect(screen.queryByLabelText(/XML/)).toBeNull();
    });

    it.each([
      ['REPORT_NOT_ISSUED', problem(409, 'REPORT_NOT_ISSUED'), vi_['mne.export.problem.notIssued']],
      ['EXPORT_FORMAT_UNSUPPORTED', problem(422, 'EXPORT_FORMAT_UNSUPPORTED'), vi_['mne.export.problem.formatUnsupported']],
      ['VERSION_CONFLICT', problem(409, 'VERSION_CONFLICT'), vi_['mne.report.problem.conflict']],
      ['SCOPE_DENIED', problem(403, 'SCOPE_DENIED'), vi_['mne.report.problem.denied']],
    ])('says %s in words', async (_name, failure, message) => {
      const user = userEvent.setup();
      mount(<PackagesScreen route={ROUTE} />, client(reportBody(), () => failure), { permissions: EXPORTER }, OPEN);
      await user.click(await screen.findByRole('button', { name: vi_['mne.export.generate.action'] }));
      expect((await screen.findByTestId('report-problem')).textContent).toBe(message);
    });
  });

  describe('AC-ST-MNE-004-1: the receipt of the filing', () => {
    const open = (command?: (operation: string, input: unknown) => unknown) => {
      const h = client(reportBody({ status: 'EXPORTED', packages: [packageBody(PACKAGE_A, { version: 3 })] }), command);
      mount(<PackagesScreen route={ROUTE} />, h, { permissions: EXPORTER }, OPEN);
      return h;
    };

    it('sends the reference and the moment of the filing with the version of the package, and says the report is filed', async () => {
      const user = userEvent.setup();
      const h = open(() => ({ ...OK, status: 'SUBMISSION_CONFIRMED', resource_id: PACKAGE_A, resource_version: 4 }));
      await user.type(await screen.findByLabelText(vi_['mne.export.receipt.reference.label']), 'QG-2026-000123');
      fireEvent.change(screen.getByLabelText(vi_['mne.export.receipt.submittedAt.label']), { target: { value: '2026-07-09T10:30' } });
      await user.click(screen.getByRole('button', { name: vi_['mne.export.receipt.action'] }));
      await waitFor(() => expect(commands(h)).toHaveLength(1));
      const [operation, input] = commands(h)[0] as [string, Record<string, unknown>];
      expect(operation).toBe('recordMneSubmissionReceipt');
      expect(input).toMatchObject({ path: { id: PACKAGE_A }, ifMatchVersion: 3, body: { receipt_reference: 'QG-2026-000123' } });
      expect((input.body as { submitted_at: string }).submitted_at).toBe(new Date('2026-07-09T10:30').toISOString());
      expect((await screen.findByTestId('export-done')).textContent).toBe(vi_['mne.export.receipt.done']);
    });

    it('sends nothing and names the field when the reference is missing or the moment is not a date', async () => {
      const user = userEvent.setup();
      const h = open();
      await user.click(await screen.findByRole('button', { name: vi_['mne.export.receipt.action'] }));
      expect(await screen.findByText(vi_['mne.export.receipt.required'])).toBeTruthy();
      await user.type(screen.getByLabelText(vi_['mne.export.receipt.reference.label']), 'QG-1');
      await user.click(screen.getByRole('button', { name: vi_['mne.export.receipt.action'] }));
      expect(await screen.findByText(vi_['mne.export.receipt.date'])).toBeTruthy();
      expect(commands(h)).toHaveLength(0);
    });

    it.each([
      ['RECEIPT_REQUIRED', problem(422, 'RECEIPT_REQUIRED'), vi_['mne.export.problem.receiptRequired']],
      ['PACKAGE_STATE_INVALID', problem(409, 'PACKAGE_STATE_INVALID'), vi_['mne.export.problem.packageState']],
      ['VERSION_CONFLICT', problem(409, 'VERSION_CONFLICT'), vi_['mne.report.problem.conflict']],
    ])('says %s in words', async (_name, failure, message) => {
      const user = userEvent.setup();
      open(() => failure);
      await user.type(await screen.findByLabelText(vi_['mne.export.receipt.reference.label']), 'QG-1');
      fireEvent.change(screen.getByLabelText(vi_['mne.export.receipt.submittedAt.label']), { target: { value: '2026-07-09T10:30' } });
      await user.click(screen.getByRole('button', { name: vi_['mne.export.receipt.action'] }));
      expect((await screen.findByTestId('report-problem')).textContent).toBe(message);
    });
  });

  describe('who may', () => {
    it('shows a reader the packages without the form to make them, the link or the receipt form', async () => {
      const report = reportBody({ status: 'EXPORTED', packages: [packageBody(PACKAGE_A, { download: null })] });
      mount(<PackagesScreen route={ROUTE} />, client(report), { permissions: READ_ONLY }, OPEN);
      expect((await screen.findByTestId('export-readonly')).textContent).toBe(vi_['mne.export.notice.readonly']);
      expect(screen.queryByRole('form', { name: vi_['mne.export.generate.title'] })).toBeNull();
      expect(document.querySelector(`tr[data-receipt-for="${PACKAGE_A}"]`)).toBeNull();
    });

    it('offers nothing on a suspended tenant, nor for a report that is not issued', async () => {
      mount(<PackagesScreen route={ROUTE} />, client(reportBody()), { permissions: EXPORTER, mode: 'READ_ONLY' }, OPEN);
      expect((await screen.findByTestId('export-readonly')).textContent).toBe(vi_['mne.export.notice.frozen']);
      cleanup();
      mount(<PackagesScreen route={ROUTE} />, client(reportBody({ status: 'APPROVED' })), { permissions: EXPORTER }, OPEN);
      expect((await screen.findByTestId('export-readonly')).textContent).toBe(vi_['mne.export.notice.notIssued']);
      expect(screen.queryByRole('form', { name: vi_['mne.export.generate.title'] })).toBeNull();
      cleanup();
      mount(<PackagesScreen route={ROUTE} />, client(reportBody({ recalled_at: '2026-10-01T09:00:00.000000Z' })), { permissions: EXPORTER }, OPEN);
      expect(await screen.findByTestId('export-readonly')).toBeTruthy();
      expect(screen.queryByRole('form', { name: vi_['mne.export.generate.title'] })).toBeNull();
    });
  });

  describe('AC-ST-MNE-004-3: UI-MNE-06 the standard states', () => {
    it.each([
      ['denied', problem(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', problem(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
      ['signed out', problem(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
    ])('AC-ST-MNE-004-3: UI-MNE-06 shows the %s state of a report', async (_name, failure, title) => {
      mount(<PackagesScreen route={ROUTE} />, client(failure), { permissions: EXPORTER }, OPEN);
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByRole('heading', { name: vi_['mne.export.page.title'] })).toBeTruthy();
    });

    it('AC-ST-MNE-004-3: UI-MNE-06 shows the loading state first and names the page for assistive technology', () => {
      mount(<PackagesScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), { permissions: EXPORTER }, OPEN);
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['mne.export.page.title'] })).toBeTruthy();
    });

    it('AC-ST-MNE-004-3: UI-MNE-06 names every field and every action for assistive technology', async () => {
      const report = reportBody({ status: 'EXPORTED', packages: [packageBody(PACKAGE_A)] });
      mount(<PackagesScreen route={ROUTE} />, client(report), { permissions: EXPORTER }, OPEN);
      await screen.findByLabelText(vi_['mne.export.receipt.reference.label']);
      for (const control of [...screen.getAllByRole('combobox'), ...screen.getAllByRole('textbox'), ...screen.getAllByRole('checkbox')]) expect((control as HTMLInputElement).labels?.length).toBeGreaterThan(0);
      for (const action of screen.getAllByRole('button')) expect((action.getAttribute('aria-label') ?? action.textContent ?? '').trim().length).toBeGreaterThan(0);
    });

    it('AC-ST-MNE-004-3: UI-MNE-06 retries the read after an error', async () => {
      let failing = true;
      const h = harness((operation) => (operation === 'getMneReport' ? (failing ? problem(500, 'INTERNAL_ERROR') : reportBody()) : { items: [], next_cursor: null }));
      mount(<PackagesScreen route={ROUTE} />, h, { permissions: EXPORTER }, OPEN);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByText('Báo cáo giám sát, đánh giá tổng thể 6 tháng')).toBeTruthy();
    });
  });

  describe('choosing the report', () => {
    it('lists the issued, exported and filed reports and not the others, reads on past an empty page, and opens the one chosen', async () => {
      const user = userEvent.setup();
      const rows = [obligationRow(1, { status: 'ISSUED' }), obligationRow(2, { status: 'EXPORTED' }), obligationRow(3, { status: 'SUBMITTED_EXTERNAL' }), obligationRow(4, { status: 'APPROVED' }), obligationRow(5, { status: 'DRAFT' })];
      const h = harness((operation, input) => {
        if (operation === 'getMneReport') return reportBody();
        if (operation !== 'listMneObligations') return new Error('unexpected read');
        const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
        return cursor === undefined ? { items: [obligationRow(9, { status: 'DRAFT' })], next_cursor: 'second', as_of: '2026-10-24' } : { items: rows, next_cursor: null, as_of: '2026-10-24' };
      });
      mount(<PackagesScreen route={ROUTE} />, h, { permissions: EXPORTER }, '/');
      expect(await screen.findByText('CDT-1')).toBeTruthy();
      expect(screen.getByText('CDT-2')).toBeTruthy();
      expect(screen.getByText('CDT-3')).toBeTruthy();
      expect(screen.queryByText('CDT-4')).toBeNull();
      expect(screen.queryByText('CDT-5')).toBeNull();
      expect(screen.queryByText('CDT-9')).toBeNull();
      await user.click(within(document.querySelector(`tr[data-report-id="${(rows[0] as { mne_report_id: string }).mne_report_id}"]`) as HTMLElement).getByRole('button', { name: vi_['mne.export.picker.open'] }));
      expect(await screen.findByText('Báo cáo giám sát, đánh giá tổng thể 6 tháng')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: vi_['mne.export.back'] }));
      expect(await screen.findByText(vi_['mne.export.picker.title'])).toBeTruthy();
    });

    it('shows the empty state when nothing was issued', async () => {
      mount(<PackagesScreen route={ROUTE} />, harness(() => ({ items: [obligationRow(3, { status: 'DRAFT' })], next_cursor: null, as_of: '2026-10-24' })), { permissions: EXPORTER }, '/');
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });
  });
});

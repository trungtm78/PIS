import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ReportScreen from './ReportScreen';
import { harness, mount, obligationRow, routeOf } from './test-support';
import type { Harness } from './test-support';

const ROUTE = routeOf('MNE-03', 'FR-MNE-03');
const REPORT = '00000000-0000-4000-8000-000000000333';
const SNAPSHOT = '00000000-0000-4000-8000-0000000000f2';
const OTHER_SNAPSHOT = '00000000-0000-4000-8000-0000000000f3';
const PREPARE = ['mne.read', 'mne.report.prepare'];
const READ_ONLY = ['mne.read'];
const OPEN = `/?report=${REPORT}`;

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const problem = (status: number, code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });

const field = (key: string, label: string, kind: string, overrides: Record<string, unknown> = {}) => ({ key, label, kind, required: false, locked: false, source: null, value: null, ...overrides });

const reportBody = (overrides: Record<string, unknown> = {}) => ({
  id: REPORT,
  form: { id: '00000000-0000-4000-8000-000000000101', code: 'TT44-M02', revision: 1, title: 'Báo cáo giám sát, đánh giá tổng thể 6 tháng', legal_confirmation_ref: null, watermark_text: 'Mẫu chờ xác nhận pháp lý [CXN-10]' },
  awaiting_confirmation: true,
  cxn_refs: ['CXN-10'],
  report_year: 2026,
  period_label: 'H1-2026',
  period_id: null,
  scope_unit_id: '00000000-0000-4000-8000-000000000501',
  scope_unit: { id: '00000000-0000-4000-8000-000000000501', code: 'CDT-1', name: 'Chủ đầu tư 1' },
  project_id: null,
  due_date: '2026-06-30',
  revision: 1,
  status: 'DRAFT',
  is_late: false,
  snapshot: { id: SNAPSHOT, as_of_date: '2026-06-30' },
  snapshot_options: [
    { id: SNAPSHOT, as_of_date: '2026-06-30' },
    { id: OTHER_SNAPSHOT, as_of_date: '2026-05-31' },
  ],
  fields: [
    field('plan_total', 'Tổng kế hoạch vốn', 'MONEY', { required: true, locked: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'plan_total_vnd' }, value: '1250000000000' }),
    field('rate_pm', 'Tỷ lệ giải ngân theo kế hoạch Thủ tướng giao', 'PERCENT', { required: true, locked: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'rate_pm_pct' }, value: '60.0000' }),
    field('projects', 'Số dự án', 'INTEGER', { locked: true, source: { kind: 'PROJECT_COUNT', stage: null }, value: 4 }),
    field('assessment', 'Đánh giá chung', 'TEXT', { required: true }),
    field('difficulties', 'Khó khăn, vướng mắc', 'TEXT', { value: 'Giải phóng mặt bằng.' }),
  ],
  attachments: [],
  payload_sha256: null,
  doc_document_id: null,
  supersedes_id: null,
  correction_reason: null,
  submitted_by: null,
  approved_by: null,
  created_by: '00000000-0000-4000-8000-000000000001',
  version: 3,
  ...overrides,
});

const snapshotRow = (id: string, asOf: string) => ({
  id,
  period_id: '00000000-0000-4000-8000-0000000000f1',
  snapshot_kind: 'PERIOD_CLOSE',
  status: 'FROZEN',
  as_of_date: asOf,
  treasury_cutoff_date: asOf,
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  row_count: 3,
  payload_sha256: 'a'.repeat(64),
  frozen_at: '2026-07-01T00:00:00Z',
  supersedes_id: null,
  created_at: '2026-06-30T00:00:00Z',
  version: 2,
});

const OK = { operation_id: '00000000-0000-4000-8000-0000000000aa', status: 'DRAFT', resource_version: 4, resource_id: REPORT };

function client(report: unknown, command: (operation: string, input: unknown) => unknown = () => OK): Harness {
  return harness((operation) => {
    if (operation === 'getMneReport') return report;
    if (operation === 'listPeriodSnapshots') return { items: [snapshotRow(SNAPSHOT, '2026-06-30'), snapshotRow(OTHER_SNAPSHOT, '2026-05-31')], pending_reports: [], next_cursor: null };
    return new Error(`unexpected read ${operation}`);
  }, command);
}

const commands = (h: Harness): Array<[string, Record<string, unknown>]> => h.command.mock.calls.map((call) => [call[0] as string, call[1] as Record<string, unknown>]);

afterEach(cleanup);

describe('MNE-03 periodic overall report (ST-MNE-002, MNE F3)', () => {
  describe('AC-ST-MNE-002-5: UI-MNE-03 the header, the cells and their sources', () => {
    it('AC-ST-MNE-002-5: UI-MNE-03 names the snapshot with its as-of date, the form revision, the unit and the period', async () => {
      mount(<ReportScreen route={ROUTE} />, client(reportBody()), { permissions: PREPARE }, OPEN);
      expect(await screen.findByText('Báo cáo giám sát, đánh giá tổng thể 6 tháng')).toBeTruthy();
      expect(screen.getByTestId('report-snapshot').textContent).toBe(fill(vi_['mne.report.header.snapshot'], { date: '2026-06-30' }));
      expect(screen.getByText(fill(vi_['mne.report.header.form'], { code: 'TT44-M02', revision: 1 }))).toBeTruthy();
      expect(screen.getByText(fill(vi_['mne.report.header.unit'], { unit: 'CDT-1 Chủ đầu tư 1' }))).toBeTruthy();
      expect(screen.getByText(fill(vi_['mne.report.header.period'], { period: 'H1-2026', due: '2026-06-30' }))).toBeTruthy();
      expect(screen.getByTestId('report-status').textContent).toBe(vi_['mne.calendar.status.draft']);
      expect(screen.getByText(fill(vi_['mne.forms.confirmation.pending'], { tags: '[CXN-10]' }))).toBeTruthy();
      expect(screen.getByText('Mẫu chờ xác nhận pháp lý [CXN-10]')).toBeTruthy();
    });

    it('AC-ST-MNE-002-5: UI-MNE-03 shows the figures locked, in dong and percent, each with a source icon that opens the HOME drill of the snapshot', async () => {
      mount(<ReportScreen route={ROUTE} />, client(reportBody()), { permissions: PREPARE }, OPEN);
      await screen.findByTestId('value-plan_total');
      expect(screen.getByTestId('value-plan_total').textContent).toBe('1.250.000.000.000');
      expect(screen.getByTestId('value-rate_pm').textContent).toBe('60.0000%');
      expect(screen.getByTestId('value-projects').textContent).toBe('4');
      for (const key of ['plan_total', 'rate_pm', 'projects']) {
        expect(screen.getByTestId(`locked-${key}`).textContent).toBe(vi_['mne.report.field.locked']);
        // A locked cell cannot be typed into.
        expect(document.querySelector(`#cell-${key}`)).toBeNull();
      }
      const drill = screen.getByRole('link', { name: fill(vi_['mne.report.source.drill'], { label: 'Tổng kế hoạch vốn' }) });
      const target = new URL(drill.getAttribute('href') ?? '', 'http://local');
      expect(target.pathname).toBe('/home/home-10');
      expect(target.searchParams.get('snapshot')).toBe(SNAPSHOT);
      expect(target.searchParams.get('source')).toBe('SNAPSHOT_METRIC');
      expect(target.searchParams.get('detail')).toBe('plan_total_vnd');
    });

    it('AC-ST-MNE-002-5: UI-MNE-03 lets the preparer write the narrative cells and says who writes each cell', async () => {
      mount(<ReportScreen route={ROUTE} />, client(reportBody()), { permissions: PREPARE }, OPEN);
      const assessment = (await screen.findByLabelText('Đánh giá chung')) as HTMLTextAreaElement;
      expect(assessment.value).toBe('');
      expect((screen.getByLabelText('Khó khăn, vướng mắc') as HTMLTextAreaElement).value).toBe('Giải phóng mặt bằng.');
      expect(screen.getAllByText(vi_['mne.report.field.written'])).toHaveLength(2);
      expect(screen.getAllByText(vi_['mne.report.field.required']).length).toBeGreaterThan(0);
    });

    it('says a figure that has none yet is not there, never zero', async () => {
      const body = reportBody({ fields: [field('rate_pm', 'Tỷ lệ', 'PERCENT', { required: true, locked: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'rate_pm_pct' }, value: null })] });
      mount(<ReportScreen route={ROUTE} />, client(body), { permissions: PREPARE }, OPEN);
      expect((await screen.findByTestId('value-rate_pm')).textContent).toBe(vi_['mne.report.field.empty']);
    });

    it('says a form without cells is an empty shell', async () => {
      mount(<ReportScreen route={ROUTE} />, client(reportBody({ fields: [] })), { permissions: PREPARE }, OPEN);
      expect(await screen.findByTestId('report-no-fields')).toBeTruthy();
    });
  });

  describe('saving and handing in', () => {
    it('AC-ST-MNE-002-1: sends only the cells that changed, with the version it read, and says the draft was saved', async () => {
      const user = userEvent.setup();
      const h = client(reportBody());
      mount(<ReportScreen route={ROUTE} />, h, { permissions: PREPARE }, OPEN);
      const assessment = await screen.findByLabelText('Đánh giá chung');
      expect((screen.getByRole('button', { name: vi_['mne.report.action.save'] }) as HTMLButtonElement).disabled).toBe(true);
      await user.type(assessment, 'Giải ngân đúng tiến độ.');
      await user.click(screen.getByRole('button', { name: vi_['mne.report.action.save'] }));
      await waitFor(() => expect(commands(h)).toHaveLength(1));
      const [operation, input] = commands(h)[0] as [string, Record<string, unknown>];
      expect(operation).toBe('editMneReport');
      expect(input).toMatchObject({ path: { id: REPORT }, ifMatchVersion: 3, body: { narrative: { assessment: 'Giải ngân đúng tiến độ.' } } });
      expect((input.body as Record<string, unknown>).snapshot_id).toBeUndefined();
      expect(await screen.findByTestId('report-done')).toBeTruthy();
      expect(screen.getByTestId('report-done').textContent).toBe(vi_['mne.report.saved']);
    });

    it('sends an emptied cell as null, so that the server clears it', async () => {
      const user = userEvent.setup();
      const h = client(reportBody());
      mount(<ReportScreen route={ROUTE} />, h, { permissions: PREPARE }, OPEN);
      await user.clear(await screen.findByLabelText('Khó khăn, vướng mắc'));
      await user.click(screen.getByRole('button', { name: vi_['mne.report.action.save'] }));
      await waitFor(() => expect(commands(h)).toHaveLength(1));
      expect(commands(h)[0]?.[1]).toMatchObject({ body: { narrative: { difficulties: null } } });
    });

    it('AC-ST-MNE-002-1: attaches the snapshot that was chosen, which fills the locked cells again on the server', async () => {
      const user = userEvent.setup();
      const h = client(reportBody());
      mount(<ReportScreen route={ROUTE} />, h, { permissions: PREPARE }, OPEN);
      const choice = await screen.findByLabelText(vi_['mne.report.snapshot.label']);
      await waitFor(() => expect(within(choice).getAllByRole('option')).toHaveLength(3));
      await user.selectOptions(choice, OTHER_SNAPSHOT);
      await user.click(screen.getByRole('button', { name: vi_['mne.report.action.save'] }));
      await waitFor(() => expect(commands(h)).toHaveLength(1));
      expect(commands(h)[0]?.[1]).toMatchObject({ body: { narrative: {}, snapshot_id: OTHER_SNAPSHOT } });
    });

    it('AC-ST-MNE-002-1: hands in a complete report: it saves what changed first and then submits with the version the save answered', async () => {
      const user = userEvent.setup();
      const h = client(reportBody(), (operation) => (operation === 'editMneReport' ? { ...OK, resource_version: 4 } : { ...OK, status: 'IN_REVIEW', resource_version: 5 }));
      mount(<ReportScreen route={ROUTE} />, h, { permissions: PREPARE }, OPEN);
      expect((screen.queryByRole('button', { name: vi_['mne.report.action.submit'] }) as HTMLButtonElement | null)?.disabled ?? true).toBe(true);
      await user.type(await screen.findByLabelText('Đánh giá chung'), 'Đạt kế hoạch.');
      await user.click(screen.getByRole('button', { name: vi_['mne.report.action.submit'] }));
      await waitFor(() => expect(commands(h)).toHaveLength(2));
      expect(commands(h).map(([operation]) => operation)).toEqual(['editMneReport', 'submitMneReport']);
      expect(commands(h)[1]?.[1]).toMatchObject({ path: { id: REPORT }, ifMatchVersion: 4 });
      expect(await screen.findByText(vi_['mne.report.submitted'])).toBeTruthy();
    });

    it('keeps showing why the hand-in failed after the save before it moved the version of the report and started the body over', async () => {
      const user = userEvent.setup();
      let version = 3;
      const h = harness(
        (operation) => {
          if (operation === 'getMneReport') return reportBody({ version });
          if (operation === 'listPeriodSnapshots') return { items: [], pending_reports: [], next_cursor: null };
          return new Error('unexpected read');
        },
        (operation) => {
          if (operation === 'editMneReport') {
            version = 4;
            return { ...OK, resource_version: 4 };
          }
          return problem(422, 'VALIDATION_FAILED', { missing_fields: ['assessment'] });
        },
      );
      mount(<ReportScreen route={ROUTE} />, h, { permissions: PREPARE }, OPEN);
      await user.type(await screen.findByLabelText('Đánh giá chung'), 'Đạt kế hoạch.');
      await user.click(screen.getByRole('button', { name: vi_['mne.report.action.submit'] }));
      expect((await screen.findByTestId('report-problem')).textContent).toBe(fill(vi_['mne.report.problem.missing'], { fields: 'Đánh giá chung' }));
      expect(commands(h).map(([operation]) => operation)).toEqual(['editMneReport', 'submitMneReport']);
      expect(commands(h)[1]?.[1]).toMatchObject({ ifMatchVersion: 4 });
      expect((screen.getByRole('button', { name: vi_['mne.report.action.save'] }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('says so when no snapshot has been frozen for the period, instead of showing an empty choice', async () => {
      mount(<ReportScreen route={ROUTE} />, client(reportBody({ snapshot_options: [] })), { permissions: PREPARE }, OPEN);
      expect((await screen.findByTestId('snapshot-none')).textContent).toBe(vi_['mne.report.snapshot.noneFrozen']);
    });

    it('offers the snapshots the report names, with no read of the disbursement module (the preparer may not have it)', async () => {
      const h = client(reportBody());
      mount(<ReportScreen route={ROUTE} />, h, { permissions: PREPARE }, OPEN);
      const choice = await screen.findByLabelText(vi_['mne.report.snapshot.label']);
      expect(within(choice).getAllByRole('option').map((option) => option.textContent)).toEqual([
        vi_['mne.report.snapshot.none'],
        fill(vi_['mne.report.snapshot.option'], { date: '2026-06-30' }),
        fill(vi_['mne.report.snapshot.option'], { date: '2026-05-31' }),
      ]);
      expect(h.read.mock.calls.some((call) => call[0] === 'listPeriodSnapshots')).toBe(false);
    });

    it('does not offer the hand-in while a required cell is empty, and says which', async () => {
      mount(<ReportScreen route={ROUTE} />, client(reportBody()), { permissions: PREPARE }, OPEN);
      await screen.findByLabelText('Đánh giá chung');
      expect((screen.getByRole('button', { name: vi_['mne.report.action.submit'] }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId('report-missing').textContent).toBe(fill(vi_['mne.report.notice.missing'], { fields: 'Đánh giá chung' }));
    });

    it('does not offer the hand-in without a snapshot, and offers it again once one is chosen', async () => {
      const user = userEvent.setup();
      const body = reportBody({
        snapshot: null,
        fields: [field('plan_total', 'Tổng kế hoạch vốn', 'MONEY', { required: true, locked: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'plan_total_vnd' }, value: '1' }), field('assessment', 'Đánh giá chung', 'TEXT', { value: 'Đủ.' })],
      });
      mount(<ReportScreen route={ROUTE} />, client(body), { permissions: PREPARE }, OPEN);
      expect(await screen.findByTestId('report-need-snapshot')).toBeTruthy();
      expect(screen.getByTestId('report-snapshot').textContent).toBe(vi_['mne.report.header.noSnapshot']);
      expect((screen.getByRole('button', { name: vi_['mne.report.action.submit'] }) as HTMLButtonElement).disabled).toBe(true);
      const choice = screen.getByLabelText(vi_['mne.report.snapshot.label']);
      await waitFor(() => expect(within(choice).getAllByRole('option')).toHaveLength(3));
      await user.selectOptions(choice, SNAPSHOT);
      expect((screen.getByRole('button', { name: vi_['mne.report.action.submit'] }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByTestId('report-need-snapshot')).toBeNull();
    });
  });

  describe('why a command failed', () => {
    const typeAndSave = async (h: Harness): Promise<void> => {
      const user = userEvent.setup();
      mount(<ReportScreen route={ROUTE} />, h, { permissions: PREPARE }, OPEN);
      await user.type(await screen.findByLabelText('Đánh giá chung'), 'x');
      await user.click(screen.getByRole('button', { name: vi_['mne.report.action.save'] }));
    };

    it.each([
      ['FIELD_SOURCE_LOCKED', problem(422, 'FIELD_SOURCE_LOCKED', { fields: ['plan_total'] }), fill(vi_['mne.report.problem.locked'], { fields: 'Tổng kế hoạch vốn' })],
      ['VERSION_CONFLICT', problem(409, 'VERSION_CONFLICT'), vi_['mne.report.problem.conflict']],
      ['REPORT_STATE_INVALID', problem(409, 'REPORT_STATE_INVALID'), vi_['mne.report.problem.stateInvalid']],
      ['SNAPSHOT_NOT_FROZEN', problem(422, 'SNAPSHOT_NOT_FROZEN'), vi_['mne.report.problem.snapshotNotFrozen']],
      ['VALIDATION_FAILED', problem(422, 'VALIDATION_FAILED'), vi_['mne.report.problem.invalid']],
      ['SCOPE_DENIED', problem(403, 'SCOPE_DENIED'), vi_['mne.report.problem.denied']],
      ['an unknown failure', problem(500, 'INTERNAL_ERROR'), vi_['mne.report.problem.general']],
    ])('says %s in words', async (_name, failure, message) => {
      await typeAndSave(client(reportBody(), () => failure));
      expect((await screen.findByTestId('report-problem')).textContent).toBe(message);
    });

    it('lists the cells the server found missing when a hand-in is refused', async () => {
      const user = userEvent.setup();
      const h = client(reportBody({ fields: [field('assessment', 'Đánh giá chung', 'TEXT', { value: 'Đủ.', required: true })] }), () => problem(422, 'VALIDATION_FAILED', { missing_fields: ['assessment'] }));
      mount(<ReportScreen route={ROUTE} />, h, { permissions: PREPARE }, OPEN);
      await user.click(await screen.findByRole('button', { name: vi_['mne.report.action.submit'] }));
      expect((await screen.findByTestId('report-problem')).textContent).toBe(fill(vi_['mne.report.problem.missing'], { fields: 'Đánh giá chung' }));
    });
  });

  describe('who may write', () => {
    it('shows a report that was handed in as read-only, with no editor and no action', async () => {
      mount(<ReportScreen route={ROUTE} />, client(reportBody({ status: 'IN_REVIEW' })), { permissions: PREPARE }, OPEN);
      expect((await screen.findByTestId('report-readonly')).textContent).toBe(vi_['mne.report.notice.locked']);
      expect(document.querySelector('textarea')).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['mne.report.action.save'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['mne.report.action.submit'] })).toBeNull();
      expect(screen.getByTestId('report-status').textContent).toBe(vi_['mne.calendar.status.inReview']);
    });

    it('shows the report to a reader without the right to prepare, who cannot write or hand it in', async () => {
      mount(<ReportScreen route={ROUTE} />, client(reportBody()), { permissions: READ_ONLY }, OPEN);
      expect((await screen.findByTestId('report-readonly')).textContent).toBe(vi_['mne.report.notice.noRight']);
      expect(document.querySelector('textarea')).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['mne.report.action.submit'] })).toBeNull();
      expect(screen.getByTestId('value-difficulties').textContent).toBe('Giải phóng mặt bằng.');
    });

    it('offers nothing on a suspended tenant', async () => {
      mount(<ReportScreen route={ROUTE} />, client(reportBody()), { permissions: PREPARE, mode: 'READ_ONLY' }, OPEN);
      expect((await screen.findByTestId('report-readonly')).textContent).toBe(vi_['mne.report.notice.frozen']);
      expect(screen.queryByRole('button', { name: vi_['mne.report.action.save'] })).toBeNull();
    });
  });

  describe('AC-ST-MNE-002-5: UI-MNE-03 the standard states', () => {
    it.each([
      ['denied', problem(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', problem(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
      ['signed out', problem(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
    ])('AC-ST-MNE-002-5: UI-MNE-03 shows the %s state of a report', async (_name, failure, title) => {
      mount(<ReportScreen route={ROUTE} />, client(failure), { permissions: PREPARE }, OPEN);
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByRole('heading', { name: vi_['mne.report.page.title'] })).toBeTruthy();
    });

    it('AC-ST-MNE-002-5: UI-MNE-03 shows the loading state first and names the page for assistive technology', () => {
      mount(<ReportScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), { permissions: PREPARE }, OPEN);
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['mne.report.page.title'] })).toBeTruthy();
    });

    it('AC-ST-MNE-002-5: UI-MNE-03 refuses an answer that is not a report, instead of showing what it cannot trust', async () => {
      mount(<ReportScreen route={ROUTE} />, client({ id: REPORT }), { permissions: PREPARE }, OPEN);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });

    it('AC-ST-MNE-002-5: UI-MNE-03 retries the read after an error', async () => {
      let failing = true;
      const h = harness((operation) => (operation === 'getMneReport' ? (failing ? problem(500, 'INTERNAL_ERROR') : reportBody()) : { items: [], next_cursor: null }));
      mount(<ReportScreen route={ROUTE} />, h, { permissions: PREPARE }, OPEN);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByText('Báo cáo giám sát, đánh giá tổng thể 6 tháng')).toBeTruthy();
    });

    it('AC-ST-MNE-002-5: UI-MNE-03 names every field and every action for assistive technology', async () => {
      mount(<ReportScreen route={ROUTE} />, client(reportBody()), { permissions: PREPARE }, OPEN);
      await screen.findByLabelText('Đánh giá chung');
      for (const control of [...screen.getAllByRole('combobox'), ...screen.getAllByRole('textbox')]) expect((control as HTMLInputElement).labels?.length).toBeGreaterThan(0);
      for (const action of screen.getAllByRole('button')) expect((action.getAttribute('aria-label') ?? action.textContent ?? '').trim().length).toBeGreaterThan(0);
    });
  });

  describe('opening a report', () => {
    it('lists the draft reports of the calendar when none is chosen, shows the empty state when there are none, and opens the one that was chosen', async () => {
      const user = userEvent.setup();
      const rows = [obligationRow(1), obligationRow(2, { period_label: 'YEAR-2026' })];
      const h = harness((operation) => {
        if (operation === 'listMneObligations') return { items: rows, next_cursor: null, as_of: '2026-10-24' };
        if (operation === 'getMneReport') return reportBody();
        return { items: [], next_cursor: null };
      });
      mount(<ReportScreen route={ROUTE} />, h, { permissions: PREPARE }, '/');
      expect(await screen.findByText('CDT-1')).toBeTruthy();
      expect(h.read.mock.calls.find((call) => call[0] === 'listMneObligations')?.[1]).toMatchObject({ query: { status: 'DRAFT' } });
      await user.click(within(document.querySelector(`tr[data-report-id="${(rows[0] as { mne_report_id: string }).mne_report_id}"]`) as HTMLElement).getByRole('button', { name: vi_['mne.report.picker.open'] }));
      expect(await screen.findByText('Báo cáo giám sát, đánh giá tổng thể 6 tháng')).toBeTruthy();
      expect(h.read.mock.calls.some((call) => call[0] === 'getMneReport' && (call[1] as { path: { id: string } }).path.id === (rows[0] as { mne_report_id: string }).mne_report_id)).toBe(true);
      await user.click(screen.getByRole('button', { name: vi_['mne.report.back'] }));
      expect(await screen.findByText(vi_['mne.report.picker.title'])).toBeTruthy();
    });

    it('loads the next page of the draft reports with the cursor of the last one, so that none is out of reach', async () => {
      const user = userEvent.setup();
      const h = harness((operation, input) => {
        if (operation !== 'listMneObligations') return new Error('unexpected read');
        const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
        return cursor === undefined ? { items: [obligationRow(1)], next_cursor: 'next-page', as_of: '2026-10-24' } : { items: [obligationRow(2)], next_cursor: null, as_of: '2026-10-24' };
      });
      mount(<ReportScreen route={ROUTE} />, h, { permissions: PREPARE }, '/');
      await screen.findByText('CDT-1');
      expect(screen.queryByText('CDT-2')).toBeNull();
      await user.click(screen.getByRole('button', { name: vi_['mne.calendar.more.action'] }));
      expect(await screen.findByText('CDT-2')).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['mne.calendar.more.action'] })).toBeNull();
    });

    it('lets the person choose the reporting year, so that the drafts of the year before stay within reach', async () => {
      const user = userEvent.setup();
      const year = Number(new Date().toISOString().slice(0, 4));
      const h = harness((operation) => (operation === 'listMneObligations' ? { items: [obligationRow(1)], next_cursor: null, as_of: '2026-10-24' } : new Error('unexpected read')));
      mount(<ReportScreen route={ROUTE} />, h, { permissions: PREPARE }, '/');
      await screen.findByText('CDT-1');
      // Each draft is read as well (its scope, snapshot and cells from source): the year is in the last read of the list.
      const query = (): Record<string, unknown> | undefined => (h.read.mock.calls.filter((call) => call[0] === 'listMneObligations').at(-1)?.[1] as { query?: Record<string, unknown> } | undefined)?.query;
      expect(query()).toMatchObject({ report_year: String(year), status: 'DRAFT' });
      await user.selectOptions(screen.getByLabelText(vi_['mne.calendar.filter.year.label']), String(year - 1));
      await waitFor(() => expect(query()).toMatchObject({ report_year: String(year - 1), status: 'DRAFT' }));
    });

    it('shows the empty state when no draft report is due', async () => {
      mount(<ReportScreen route={ROUTE} />, harness(() => ({ items: [], next_cursor: null, as_of: '2026-10-24' })), { permissions: PREPARE }, '/');
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });
  });
});

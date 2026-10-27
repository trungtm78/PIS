import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ApprovalScreen from './ApprovalScreen';
import { ME, OTHER, harness, mount, obligationRow, routeOf } from './test-support';
import type { Harness } from './test-support';

const ROUTE = routeOf('MNE-05', 'FR-MNE-05');
const REPORT = '00000000-0000-4000-8000-000000000555';
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';
const REVIEW = ['mne.read', 'mne.report.approve', 'mne.report.issue'];
const READ_ONLY = ['mne.read'];
const OPEN = `/?report=${REPORT}`;

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const problem = (status: number, code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const HASH = 'a'.repeat(64);

const reportBody = (overrides: Record<string, unknown> = {}) => ({
  id: REPORT,
  form: { id: '00000000-0000-4000-8000-000000000101', code: 'TT44-M02', revision: 1, title: 'Báo cáo giám sát, đánh giá tổng thể 6 tháng', legal_confirmation_ref: null, watermark_text: 'Mẫu chờ xác nhận pháp lý [CXN-10]' },
  awaiting_confirmation: true,
  cxn_refs: ['CXN-10'],
  report_year: 2026,
  period_label: 'H1-2026',
  scope_unit: { id: '00000000-0000-4000-8000-000000000501', code: 'CDT-1', name: 'Chủ đầu tư 1' },
  due_date: '2026-07-10',
  status: 'IN_REVIEW',
  is_late: false,
  snapshot: { id: '00000000-0000-4000-8000-0000000000f2', as_of_date: '2026-06-30' },
  snapshot_options: [],
  fields: [
    { key: 'plan_total', label: 'Tổng kế hoạch vốn', kind: 'MONEY', required: true, locked: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'plan_total_vnd' }, value: '1250000000000' },
    { key: 'assessment', label: 'Đánh giá chung', kind: 'TEXT', required: true, locked: false, source: null, value: 'Giải ngân đúng tiến độ.' },
  ],
  attachments: [],
  payload_sha256: null,
  doc_document_id: null,
  document_state: null,
  decision: null,
  issue_requested_at: null,
  issued_at: null,
  recalled_at: null,
  created_by: OTHER,
  submitted_by: OTHER,
  version: 4,
  ...overrides,
});

const OK = { operation_id: '00000000-0000-4000-8000-0000000000aa', status: 'APPROVED', resource_version: 5, resource_id: REPORT };

function client(report: unknown, command: (operation: string, input: unknown) => unknown = () => OK): Harness {
  return harness((operation) => (operation === 'getMneReport' ? report : new Error(`unexpected read ${operation}`)), command);
}
const commands = (h: Harness): Array<[string, Record<string, unknown>]> => h.command.mock.calls.map((call) => [call[0] as string, call[1] as Record<string, unknown>]);

afterEach(cleanup);

describe('MNE-05 review, approval and issue (ST-MNE-003)', () => {
  describe('AC-ST-MNE-003-3: UI-MNE-05 the content, the decision and the document', () => {
    it('AC-ST-MNE-003-3: UI-MNE-05 shows the report, its snapshot, its cells and the label of the confirmation it waits for', async () => {
      mount(<ApprovalScreen route={ROUTE} />, client(reportBody()), { permissions: REVIEW }, OPEN);
      expect(await screen.findByText('Báo cáo giám sát, đánh giá tổng thể 6 tháng')).toBeTruthy();
      expect(screen.getByTestId('report-status').textContent).toBe(vi_['mne.calendar.status.inReview']);
      expect(screen.getByTestId('report-snapshot').textContent).toBe(fill(vi_['mne.report.header.snapshot'], { date: '2026-06-30' }));
      expect(screen.getByTestId('value-plan_total').textContent).toBe('1.250.000.000.000');
      expect(screen.getByTestId('value-assessment').textContent).toBe('Giải ngân đúng tiến độ.');
      expect(screen.getByText(fill(vi_['mne.forms.confirmation.pending'], { tags: '[CXN-10]' }))).toBeTruthy();
      // The content is read here, not written: no cell can be typed into.
      expect(document.querySelectorAll('textarea')).toHaveLength(1);
    });

    it('AC-ST-MNE-003-3: UI-MNE-05 shows the four stages of the document, the one DOC is at marked as current', async () => {
      const stages: Array<[string, string]> = [
        ['DRAFT', 'drafting'],
        ['SUBMITTED', 'awaitingSignature'],
        ['NUMBERED', 'numbered'],
        ['ISSUED', 'published'],
      ];
      for (const [state, step] of stages) {
        mount(<ApprovalScreen route={ROUTE} />, client(reportBody({ status: 'ISSUING', document_state: state, payload_sha256: HASH })), { permissions: REVIEW }, OPEN);
        const timeline = await screen.findByTestId('doc-stage');
        expect(within(timeline).getAllByRole('listitem').map((item) => item.textContent)).toEqual([vi_['mne.approval.doc.drafting'], vi_['mne.approval.doc.awaitingSignature'], vi_['mne.approval.doc.numbered'], vi_['mne.approval.doc.published']]);
        expect(timeline.querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe(step);
        cleanup();
      }
    });

    it('says there is no draft yet, and that a cancelled or recalled document is withdrawn', async () => {
      mount(<ApprovalScreen route={ROUTE} />, client(reportBody({ status: 'ISSUING', payload_sha256: HASH })), { permissions: REVIEW }, OPEN);
      expect((await screen.findByTestId('doc-stage')).textContent).toBe(vi_['mne.approval.doc.none']);
      cleanup();
      mount(<ApprovalScreen route={ROUTE} />, client(reportBody({ status: 'ISSUING', document_state: 'CANCELLED', payload_sha256: HASH })), { permissions: REVIEW }, OPEN);
      expect((await screen.findByTestId('doc-stage')).textContent).toBe(vi_['mne.approval.doc.withdrawn']);
    });

    it('shows the hash that was frozen, waits for DOC while the report is issuing, and offers no action then', async () => {
      mount(<ApprovalScreen route={ROUTE} />, client(reportBody({ status: 'ISSUING', document_state: 'DRAFT', payload_sha256: HASH })), { permissions: REVIEW }, OPEN);
      expect((await screen.findByTestId('issue-hash')).textContent).toBe(fill(vi_['mne.approval.issue.hash'], { hash: HASH }));
      expect(screen.getByTestId('issue-waiting').textContent).toBe(vi_['mne.approval.issue.waiting']);
      expect(screen.queryByRole('button', { name: vi_['mne.approval.issue.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['mne.approval.decision.approve'] })).toBeNull();
    });

    it('shows the document an issued report has, and says a recalled one needs a correction', async () => {
      mount(<ApprovalScreen route={ROUTE} />, client(reportBody({ status: 'ISSUED', document_state: 'ISSUED', payload_sha256: HASH, doc_document_id: DOCUMENT, recalled_at: '2026-10-01T09:00:00.000000Z' })), { permissions: REVIEW }, OPEN);
      expect((await screen.findByTestId('issue-done')).textContent).toBe(fill(vi_['mne.approval.issue.done'], { document: DOCUMENT }));
      expect(screen.getByTestId('issue-recalled').textContent).toBe(fill(vi_['mne.approval.issue.recalled'], { date: '2026-10-01' }));
    });
  });

  describe('deciding', () => {
    it('AC-ST-MNE-003-1: approves with the reason and the version it read, and says so', async () => {
      const user = userEvent.setup();
      const h = client(reportBody());
      mount(<ApprovalScreen route={ROUTE} />, h, { permissions: REVIEW }, OPEN);
      await user.type(await screen.findByLabelText(vi_['mne.approval.decision.reason.label']), 'Đã đối chiếu với snapshot.');
      await user.click(screen.getByRole('button', { name: vi_['mne.approval.decision.approve'] }));
      await waitFor(() => expect(commands(h)).toHaveLength(1));
      expect(commands(h)[0]).toEqual(['decideMneReport', expect.objectContaining({ path: { id: REPORT }, ifMatchVersion: 4, body: { decision: 'approve', reason: 'Đã đối chiếu với snapshot.' } })]);
      expect((await screen.findByTestId('approval-done')).textContent).toBe(vi_['mne.approval.decision.approved']);
    });

    it('returns the report to its preparer with the reason', async () => {
      const user = userEvent.setup();
      const h = client(reportBody(), () => ({ ...OK, status: 'DRAFT' }));
      mount(<ApprovalScreen route={ROUTE} />, h, { permissions: REVIEW }, OPEN);
      await user.type(await screen.findByLabelText(vi_['mne.approval.decision.reason.label']), 'Cần bổ sung khó khăn.');
      await user.click(screen.getByRole('button', { name: vi_['mne.approval.decision.return'] }));
      await waitFor(() => expect(commands(h)).toHaveLength(1));
      expect(commands(h)[0]?.[1]).toMatchObject({ body: { decision: 'return', reason: 'Cần bổ sung khó khăn.' } });
      expect((await screen.findByTestId('approval-done')).textContent).toBe(vi_['mne.approval.decision.returned']);
    });

    it('sends nothing and names the field when the reason is too short', async () => {
      const user = userEvent.setup();
      const h = client(reportBody());
      mount(<ApprovalScreen route={ROUTE} />, h, { permissions: REVIEW }, OPEN);
      await user.type(await screen.findByLabelText(vi_['mne.approval.decision.reason.label']), 'ok');
      await user.click(screen.getByRole('button', { name: vi_['mne.approval.decision.approve'] }));
      expect(await screen.findByText(vi_['mne.approval.decision.reason.short'])).toBeTruthy();
      expect(commands(h)).toHaveLength(0);
    });

    it('AC-ST-MNE-003-1: offers no approval to who wrote the report or handed it in, and says why', async () => {
      mount(<ApprovalScreen route={ROUTE} />, client(reportBody({ created_by: ME })), { permissions: REVIEW }, OPEN);
      expect((await screen.findByTestId('decision-own')).textContent).toBe(vi_['mne.approval.decision.own']);
      expect(screen.queryByRole('button', { name: vi_['mne.approval.decision.approve'] })).toBeNull();
      cleanup();
      mount(<ApprovalScreen route={ROUTE} />, client(reportBody({ submitted_by: ME })), { permissions: REVIEW }, OPEN);
      expect((await screen.findByTestId('decision-own')).textContent).toBe(vi_['mne.approval.decision.own']);
    });

    it.each([
      ['SELF_APPROVAL_DENIED', problem(403, 'SELF_APPROVAL_DENIED'), vi_['mne.report.problem.selfApproval']],
      ['VERSION_CONFLICT', problem(409, 'VERSION_CONFLICT'), vi_['mne.report.problem.conflict']],
      ['REPORT_STATE_INVALID', problem(409, 'REPORT_STATE_INVALID'), vi_['mne.report.problem.stateInvalid']],
      ['SCOPE_DENIED', problem(403, 'SCOPE_DENIED'), vi_['mne.report.problem.denied']],
    ])('says %s in words', async (_name, failure, message) => {
      const user = userEvent.setup();
      mount(<ApprovalScreen route={ROUTE} />, client(reportBody(), () => failure), { permissions: REVIEW }, OPEN);
      await user.type(await screen.findByLabelText(vi_['mne.approval.decision.reason.label']), 'Đã đối chiếu.');
      await user.click(screen.getByRole('button', { name: vi_['mne.approval.decision.approve'] }));
      expect((await screen.findByTestId('report-problem')).textContent).toBe(message);
    });

    it('offers the decision only to who holds the right to approve, and nothing on a suspended tenant', async () => {
      mount(<ApprovalScreen route={ROUTE} />, client(reportBody()), { permissions: READ_ONLY }, OPEN);
      expect((await screen.findByTestId('approval-readonly')).textContent).toBe(vi_['mne.approval.notice.readonly']);
      expect(screen.queryByLabelText(vi_['mne.approval.decision.reason.label'])).toBeNull();
      cleanup();
      mount(<ApprovalScreen route={ROUTE} />, client(reportBody()), { permissions: REVIEW, mode: 'READ_ONLY' }, OPEN);
      expect((await screen.findByTestId('approval-readonly')).textContent).toBe(vi_['mne.approval.notice.frozen']);
    });
  });

  describe('asking DOC to issue', () => {
    const approved = (overrides: Record<string, unknown> = {}) => reportBody({ status: 'APPROVED', decision: { by: OTHER, at: '2026-10-20T08:00:00.000000Z', reason: 'Đã đối chiếu.' }, ...overrides });

    it('AC-ST-MNE-003-1: asks for the issue of an approved report with the version it read, and says it was sent', async () => {
      const user = userEvent.setup();
      const h = client(approved(), () => ({ ...OK, status: 'ISSUING' }));
      mount(<ApprovalScreen route={ROUTE} />, h, { permissions: REVIEW }, OPEN);
      expect((await screen.findByTestId('decision-record')).textContent).toBe(fill(vi_['mne.approval.decision.record'], { reason: 'Đã đối chiếu.' }));
      await user.click(screen.getByRole('button', { name: vi_['mne.approval.issue.action'] }));
      await waitFor(() => expect(commands(h)).toHaveLength(1));
      expect(commands(h)[0]).toEqual(['requestMneReportIssue', expect.objectContaining({ path: { id: REPORT }, ifMatchVersion: 4 })]);
      expect((await screen.findByTestId('approval-done')).textContent).toBe(vi_['mne.approval.issue.requested']);
    });

    it('AC-ST-MNE-003-2: says the template is missing, and that the report stays approved and the administrator was told', async () => {
      const user = userEvent.setup();
      mount(<ApprovalScreen route={ROUTE} />, client(approved(), () => problem(422, 'DOC_TEMPLATE_MISSING', { template_code: 'MNE-X' })), { permissions: REVIEW }, OPEN);
      await user.click(await screen.findByRole('button', { name: vi_['mne.approval.issue.action'] }));
      expect((await screen.findByTestId('report-problem')).textContent).toBe(vi_['mne.report.problem.templateMissing']);
      expect(screen.getByTestId('report-status').textContent).toBe(vi_['mne.calendar.status.approved']);
    });

    it('offers the request only to who holds the right to issue', async () => {
      mount(<ApprovalScreen route={ROUTE} />, client(approved()), { permissions: ['mne.read', 'mne.report.approve'] }, OPEN);
      expect((await screen.findByTestId('approval-readonly')).textContent).toBe(vi_['mne.approval.notice.readonly']);
      expect(screen.queryByRole('button', { name: vi_['mne.approval.issue.action'] })).toBeNull();
    });
  });

  describe('keeping the document state live', () => {
    it('reads the report again while DOC has it, so that the state of the document moves without anyone asking', async () => {
      let reads = 0;
      const h = harness((operation) => {
        if (operation !== 'getMneReport') return new Error('unexpected read');
        reads += 1;
        return reportBody({ status: reads < 2 ? 'ISSUING' : 'ISSUED', document_state: reads < 2 ? 'DRAFT' : 'ISSUED', payload_sha256: HASH, doc_document_id: reads < 2 ? null : DOCUMENT });
      });
      mount(<ApprovalScreen route={ROUTE} />, h, { permissions: REVIEW }, OPEN);
      expect((await screen.findByTestId('issue-waiting')).textContent).toBe(vi_['mne.approval.issue.waiting']);
      expect(await screen.findByTestId('issue-done', undefined, { timeout: 8000 })).toBeTruthy();
      expect(screen.getByTestId('report-status').textContent).toBe(vi_['mne.calendar.status.issued']);
    }, 15_000);
  });

  describe('AC-ST-MNE-003-3: UI-MNE-05 the standard states', () => {
    it.each([
      ['denied', problem(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', problem(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
      ['signed out', problem(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
    ])('AC-ST-MNE-003-3: UI-MNE-05 shows the %s state of a report', async (_name, failure, title) => {
      mount(<ApprovalScreen route={ROUTE} />, client(failure), { permissions: REVIEW }, OPEN);
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByRole('heading', { name: vi_['mne.approval.page.title'] })).toBeTruthy();
    });

    it('AC-ST-MNE-003-3: UI-MNE-05 shows the loading state first and names the page for assistive technology', () => {
      mount(<ApprovalScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), { permissions: REVIEW }, OPEN);
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['mne.approval.page.title'] })).toBeTruthy();
    });

    it('AC-ST-MNE-003-3: UI-MNE-05 names every field and every action for assistive technology', async () => {
      mount(<ApprovalScreen route={ROUTE} />, client(reportBody()), { permissions: REVIEW }, OPEN);
      await screen.findByLabelText(vi_['mne.approval.decision.reason.label']);
      for (const control of screen.getAllByRole('textbox')) expect((control as HTMLInputElement).labels?.length).toBeGreaterThan(0);
      for (const action of screen.getAllByRole('button')) expect((action.getAttribute('aria-label') ?? action.textContent ?? '').trim().length).toBeGreaterThan(0);
    });
  });

  describe('choosing the report', () => {
    it('lists the reports that wait for a decision, for issue, with DOC or issued, and not drafts or filed reports, and opens the one chosen', async () => {
      const user = userEvent.setup();
      const rows = [
        obligationRow(1, { status: 'IN_REVIEW' }),
        obligationRow(2, { status: 'APPROVED' }),
        obligationRow(3, { status: 'DRAFT' }),
        obligationRow(4, { status: 'SUBMITTED_EXTERNAL' }),
        obligationRow(5, { status: 'ISSUING' }),
        obligationRow(6, { status: 'ISSUED' }),
      ];
      const h = harness((operation) => {
        if (operation === 'listMneObligations') return { items: rows, next_cursor: null, as_of: '2026-10-24' };
        if (operation === 'getMneReport') return reportBody();
        return new Error('unexpected read');
      });
      mount(<ApprovalScreen route={ROUTE} />, h, { permissions: REVIEW }, '/');
      expect(await screen.findByText('CDT-1')).toBeTruthy();
      expect(screen.getByText('CDT-2')).toBeTruthy();
      expect(screen.getByText('CDT-5')).toBeTruthy();
      expect(screen.getByText('CDT-6')).toBeTruthy();
      expect(screen.queryByText('CDT-3')).toBeNull();
      expect(screen.queryByText('CDT-4')).toBeNull();
      await user.click(within(document.querySelector(`tr[data-report-id="${(rows[0] as { mne_report_id: string }).mne_report_id}"]`) as HTMLElement).getByRole('button', { name: vi_['mne.approval.picker.open'] }));
      expect(await screen.findByText('Báo cáo giám sát, đánh giá tổng thể 6 tháng')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: vi_['mne.approval.back'] }));
      expect(await screen.findByText(vi_['mne.approval.picker.title'])).toBeTruthy();
    });

    it('reads on when a page holds nothing for a reviewer, so that the reports on the next page are not out of reach', async () => {
      const h = harness((operation, input) => {
        if (operation !== 'listMneObligations') return new Error('unexpected read');
        const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
        return cursor === undefined ? { items: [obligationRow(3, { status: 'DRAFT' })], next_cursor: 'second', as_of: '2026-10-24' } : { items: [obligationRow(1, { status: 'IN_REVIEW' })], next_cursor: null, as_of: '2026-10-24' };
      });
      mount(<ApprovalScreen route={ROUTE} />, h, { permissions: REVIEW }, '/');
      expect(await screen.findByText('CDT-1')).toBeTruthy();
      expect(screen.queryByText('CDT-3')).toBeNull();
      expect(h.read.mock.calls.filter((call) => call[0] === 'listMneObligations')).toHaveLength(2);
    });

    it('shows the empty state when nothing is waiting, and the next page when there is one', async () => {
      const user = userEvent.setup();
      mount(<ApprovalScreen route={ROUTE} />, harness(() => ({ items: [obligationRow(3, { status: 'DRAFT' })], next_cursor: null, as_of: '2026-10-24' })), { permissions: REVIEW }, '/');
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
      cleanup();
      const h = harness((operation, input) => {
        if (operation !== 'listMneObligations') return new Error('unexpected read');
        const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
        return cursor === undefined ? { items: [obligationRow(1, { status: 'IN_REVIEW' })], next_cursor: 'next-page', as_of: '2026-10-24' } : { items: [obligationRow(2, { status: 'APPROVED' })], next_cursor: null, as_of: '2026-10-24' };
      });
      mount(<ApprovalScreen route={ROUTE} />, h, { permissions: REVIEW }, '/');
      await screen.findByText('CDT-1');
      await user.click(screen.getByRole('button', { name: vi_['mne.calendar.more.action'] }));
      expect(await screen.findByText('CDT-2')).toBeTruthy();
    });
  });
});

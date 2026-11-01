import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ReportHistoryScreen from './ReportHistoryScreen';
import { changedCount, defaultAgainst, diffCells, hasOthers, historicObligations, toRevision } from './history-model';
import { harness, mount, obligationRow, routeOf } from './test-support';
import type { Harness } from './test-support';
import { toObligation } from './types';

const ROUTE = routeOf('MNE-10', 'FR-MNE-10');
const FIRST = '00000000-0000-4000-8000-000000000801';
const SECOND = '00000000-0000-4000-8000-000000000802';
const THIRD = '00000000-0000-4000-8000-000000000803';
const APPROVER_1 = '00000000-0000-4000-8000-0000000000a1';
const APPROVER_2 = '00000000-0000-4000-8000-0000000000a2';
const READER = ['mne.read', 'membership.read'];
const NO_MEMBERS = ['mne.read'];

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const FAILURES: Array<[string, Error, string]> = [
  ['denied', problem(403, 'SCOPE_DENIED'), word('states.denied.title')],
  ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c', extensions: {} }), word('states.offline.title')],
  ['error', problem(500, 'INTERNAL_ERROR'), word('states.error.title')],
  ['signed out', problem(401, 'SESSION_EXPIRED'), word('states.signedOut.title')],
];

afterEach(cleanup);

const field = (key: string, label: string, kind: string, overrides: Record<string, unknown> = {}) => ({ key, label, kind, required: false, locked: false, source: null, value: null, ...overrides });

const HISTORY = [
  { id: FIRST, revision: 1, status: 'SUPERSEDED', correction_reason: null, supersedes_id: null, issued_at: '2026-07-12T02:00:00Z', created_at: '2026-07-01T02:00:00Z', current: false },
  {
    id: SECOND,
    revision: 2,
    status: 'ISSUED',
    correction_reason: 'Sửa số giải ngân sau khi đối chiếu Kho bạc',
    supersedes_id: FIRST,
    issued_at: '2026-07-20T02:00:00Z',
    created_at: '2026-07-15T02:00:00Z',
    current: false,
  },
];

const PACKAGE = (id: string, url: string | null) => ({
  id,
  target_system: 'NATIONAL_PIM_SYSTEM',
  format: 'XLSX',
  file_sha256: 'ab'.repeat(32),
  file_size_bytes: 2048,
  adapter_status: 'PROPOSED',
  status: 'GENERATED',
  created_at: '2026-07-13T02:00:00Z',
  receipt: null,
  download: url === null ? null : { url, expires_at: '2026-07-13T02:05:00Z' },
  version: 1,
});

/** A revision of the report as `getMneReport` answers it: its own cells, and the history of every revision with the one that was read marked. */
const revisionBody = (id: string, revision: number, overrides: Record<string, unknown> = {}) => ({
  id,
  form: { id: '00000000-0000-4000-8000-000000000101', code: 'TT44-M02', revision: 1, title: 'Báo cáo giám sát, đánh giá tổng thể 6 tháng', legal_confirmation_ref: null, watermark_text: null },
  awaiting_confirmation: true,
  cxn_refs: [],
  report_year: 2026,
  period_label: 'H1-2026',
  period_id: null,
  scope_unit: { id: '00000000-0000-4000-8000-000000000501', code: 'CDT-1', name: 'Chủ đầu tư 1' },
  project_id: null,
  due_date: '2026-07-10',
  revision,
  status: revision === 1 ? 'SUPERSEDED' : 'ISSUED',
  is_late: false,
  snapshot: null,
  snapshot_options: [],
  fields: [
    field('disbursed', 'Giải ngân lũy kế', 'MONEY', { locked: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'disbursed_treasury_vnd' }, value: revision === 1 ? '500000000000' : '520000000000' }),
    field('rate', 'Tỷ lệ giải ngân', 'PERCENT', { locked: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'rate_total_pct' }, value: '40.0000' }),
    field('difficulties', 'Khó khăn, vướng mắc', 'TEXT', { value: revision === 1 ? 'Giải phóng mặt bằng.' : 'Giải phóng mặt bằng và thiếu vật liệu.' }),
    ...(revision === 2 ? [field('proposals', 'Kiến nghị', 'TEXT', { value: 'Đề nghị điều chỉnh kế hoạch.' })] : [field('legacy', 'Ghi chú cũ', 'TEXT', { value: 'Bỏ ở bản sau.' })]),
  ],
  attachments: [],
  payload_sha256: null,
  doc_document_id: null,
  supersedes_id: revision === 2 ? FIRST : null,
  correction_reason: revision === 2 ? 'Sửa số giải ngân sau khi đối chiếu Kho bạc' : null,
  submitted_by: null,
  approved_by: revision === 1 ? APPROVER_1 : APPROVER_2,
  created_by: '00000000-0000-4000-8000-000000000001',
  history: HISTORY.map((entry) => ({ ...entry, current: entry.id === id })),
  packages: [PACKAGE(`pk-${revision}`, revision === 1 ? '/exports/file-1.xlsx' : null)],
  issued_at: revision === 1 ? '2026-07-12T02:00:00Z' : '2026-07-20T02:00:00Z',
  version: 3,
  ...overrides,
});

interface Served {
  reports?: Record<string, unknown>;
  obligations?: (query: unknown) => unknown;
  members?: Array<Record<string, unknown>> | Error;
}

function client(served: Served = {}): Harness & { readAll: ReturnType<typeof vi.fn> } {
  const reports: Record<string, unknown> = { [FIRST]: revisionBody(FIRST, 1), [SECOND]: revisionBody(SECOND, 2), ...served.reports };
  const h = harness((operation, input) => {
    if (operation === 'getMneReport') {
      const id = (input as { path: { id: string } }).path.id;
      return reports[id] ?? problem(404, 'RESOURCE_NOT_FOUND');
    }
    if (operation === 'listMneObligations') return served.obligations === undefined ? { items: [], next_cursor: null } : served.obligations((input as { query?: unknown } | undefined)?.query);
    return new Error(`unexpected read ${operation}`);
  });
  const readAll = vi.fn((operation: string) => {
    if (operation !== 'get_resources_membership') return Promise.reject(new Error(`unexpected readAll ${operation}`));
    const members = served.members ?? [
      { id: APPROVER_1, display_name: 'Nguyễn Văn An' },
      { id: APPROVER_2, display_name: 'Trần Thị Bình' },
    ];
    return members instanceof Error ? Promise.reject(members) : Promise.resolve(members);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

const show = (served: Served = {}, permissions: readonly string[] | undefined = READER, path = '/') => {
  const h = client(served);
  mount(<ReportHistoryScreen route={ROUTE} />, h, { permissions }, path);
  return h;
};
const readsOf = (h: Harness, operation: string): unknown[][] => h.read.mock.calls.filter(([name]) => name === operation);
const cell = (key: string) => document.querySelector(`tr[data-cell="${key}"]`) as HTMLElement;

describe('ReportHistoryScreen (MNE-10): revisions and corrections of a report', () => {
  it('UI-MNE-10: lists the reports that were issued, leaving out the drafts, and opens the history of one', async () => {
    const h = show({
      reports: { [obligationRow(1).mne_report_id]: revisionBody(SECOND, 2, { id: obligationRow(1).mne_report_id }) },
      obligations: () => ({
        items: [
          obligationRow(1, { status: 'ISSUED', period_label: 'H1-2026' }),
          obligationRow(2, { status: 'DRAFT' }),
          obligationRow(3, { status: 'SUPERSEDED', period_label: 'H2-2025' }),
          obligationRow(4, { status: 'APPROVED' }),
        ],
        next_cursor: null,
      }),
    });
    const table = await screen.findByTestId('issued-reports');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('mne.history.page.title'));
    expect(screen.getByTestId('immutable').textContent).toBe(word('mne.history.immutable.notice'));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain(word('mne.calendar.status.issued'));
    expect(rows[1]?.textContent).toContain('H2-2025');
    expect((readsOf(h, 'listMneObligations')[0]?.[1] as { query: Record<string, unknown> }).query).not.toHaveProperty('status');
    fireEvent.click(within(table).getByRole('button', { name: fill(word('mne.history.picker.open'), { period: 'H1-2026' }) }));
    expect(await screen.findByTestId('history')).toBeTruthy();
    expect(readsOf(h, 'getMneReport')[0]?.[1]).toEqual({ path: { id: obligationRow(1).mne_report_id } });
  });

  it('AC-ST-MNE-010-1, UAT-AC294, UI-MNE-10: opens revision 2 with its history and a side-by-side diff of the changed cells and the reason, and revision 1 stays downloadable', async () => {
    show({}, READER, `/?report=${SECOND}`);
    const history = await screen.findByTestId('history');
    for (const key of ['mne.history.column.revision', 'mne.history.column.reason', 'mne.history.column.issued'] as const)
      expect(within(history).getByRole('columnheader', { name: word(key) })).toBeTruthy();
    const rows = within(history).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain(fill(word('mne.history.revision.title'), { revision: 1 }));
    expect(rows[0]?.textContent).toContain(word('mne.calendar.status.superseded'));
    expect(rows[0]?.textContent).toContain(word('mne.history.reason.none'));
    expect(rows[1]?.textContent).toContain('Sửa số giải ngân sau khi đối chiếu Kho bạc');
    expect(rows[1]?.getAttribute('data-opened')).toBe('true');
    // The revision it corrects is compared with it without being asked.
    const compare = await screen.findByTestId('compare');
    expect(await within(compare).findByText(fill(word('mne.history.compare.title'), { from: 1, to: 2 }))).toBeTruthy();
    expect(rows[0]?.getAttribute('data-against')).toBe('true');
    expect(screen.getByTestId('compare-summary').textContent).toBe(fill(word('mne.history.compare.summary'), { count: 4, total: 5 }));
    expect(cell('disbursed').getAttribute('data-change')).toBe('changed');
    expect(screen.getByTestId('before-disbursed').textContent).toBe('500.000.000.000');
    expect(screen.getByTestId('after-disbursed').textContent).toBe('520.000.000.000');
    expect(cell('rate').getAttribute('data-change')).toBe('same');
    expect(cell('rate').textContent).toContain(word('mne.history.change.same'));
    expect(cell('difficulties').textContent).toContain(word('mne.history.change.changed'));
    expect(cell('proposals').getAttribute('data-change')).toBe('added');
    expect(screen.getByTestId('before-proposals').textContent).toBe(word('mne.history.diff.empty'));
    expect(cell('legacy').getAttribute('data-change')).toBe('removed');
    expect(screen.getByTestId('after-legacy').textContent).toBe(word('mne.history.diff.empty'));
    // The reason of the correction, who approved each revision, and the files of each.
    expect(screen.getByTestId('reason-2').textContent).toBe('Sửa số giải ngân sau khi đối chiếu Kho bạc');
    expect(screen.getByTestId('reason-1').textContent).toBe(word('mne.history.reason.none'));
    await waitFor(() => expect(screen.getByTestId('approver-1').textContent).toBe('Nguyễn Văn An'));
    expect(screen.getByTestId('approver-2').textContent).toBe('Trần Thị Bình');
    const download = within(screen.getByTestId('files-1')).getByRole('link', { name: fill(word('mne.history.download.action'), { format: word('mne.export.format.xlsx'), revision: 1 }) });
    expect(download.getAttribute('href')).toContain('/exports/file-1.xlsx');
    expect(within(screen.getByTestId('files-2')).getByText(word('mne.export.download.none'))).toBeTruthy();
  });

  it('shows the short id of an approver whose name cannot be read, and says when nobody approved', async () => {
    show({ reports: { [FIRST]: revisionBody(FIRST, 1, { approved_by: null }) } }, NO_MEMBERS, `/?report=${SECOND}`);
    expect((await screen.findByTestId('approver-2')).textContent).toBe(APPROVER_2.slice(0, 8));
    expect(screen.getByTestId('approver-2').getAttribute('title')).toBe(APPROVER_2);
    expect(screen.getByTestId('approver-1').textContent).toBe(word('mne.history.approver.none'));
    cleanup();
    const h = show({ members: problem(403, 'SCOPE_DENIED') }, READER, `/?report=${SECOND}`);
    await screen.findByTestId('approver-2');
    await waitFor(() => expect(h.readAll).toHaveBeenCalled());
    expect(screen.getByTestId('approver-2').textContent).toBe(APPROVER_2.slice(0, 8));
  });

  it('asks nothing of the members from whoever may not list them', async () => {
    const h = show({}, NO_MEMBERS, `/?report=${SECOND}`);
    await screen.findByTestId('approver-2');
    expect(h.readAll).not.toHaveBeenCalled();
  });

  it('lets the reviewer choose the revision to compare with, or open another one, and keeps the choice in the address', async () => {
    show(
      {
        reports: {
          [THIRD]: revisionBody(THIRD, 3, {
            status: 'DRAFT',
            supersedes_id: SECOND,
            history: [...HISTORY, { id: THIRD, revision: 3, status: 'DRAFT', correction_reason: 'Bổ sung', supersedes_id: SECOND, issued_at: null, created_at: '2026-08-01T02:00:00Z', current: true }],
          }),
        },
      },
      READER,
      `/?report=${THIRD}&against=${FIRST}`,
    );
    expect(await screen.findByText(fill(word('mne.history.compare.title'), { from: 1, to: 3 }))).toBeTruthy();
    const third = document.querySelector(`tr[data-revision-id="${THIRD}"]`) as HTMLElement;
    expect(third.textContent).toContain(word('mne.calendar.status.draft'));
    expect(within(third).queryByRole('button')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: fill(word('mne.history.compare.action'), { revision: 2 }) }));
    expect(await screen.findByText(fill(word('mne.history.compare.title'), { from: 2, to: 3 }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: fill(word('mne.history.open.action'), { revision: 1 }) }));
    await waitFor(() => expect(document.querySelector(`tr[data-revision-id="${FIRST}"]`)?.getAttribute('data-opened')).toBe('true'));
    expect(screen.getByTestId('compare-none').textContent).toBe(word('mne.history.compare.choose.notice'));
  });

  it('says the two revisions hold the same cells, and that a report with one revision has nothing to compare', async () => {
    show({ reports: { [SECOND]: revisionBody(SECOND, 2, { fields: revisionBody(FIRST, 1).fields }) } }, READER, `/?report=${SECOND}`);
    expect((await screen.findByTestId('compare-summary')).textContent).toBe(word('mne.history.compare.same.notice'));
    cleanup();
    show({ reports: { [FIRST]: revisionBody(FIRST, 1, { history: [HISTORY[0]] }) } }, READER, `/?report=${FIRST}`);
    expect((await screen.findByTestId('compare-none')).textContent).toBe(word('mne.history.compare.only.notice'));
    expect(screen.queryByTestId('compare')).toBeNull();
    // The files and the approver of the only revision are still there to be read.
    const card = document.querySelector('[data-revision-card="1"]') as HTMLElement;
    expect(within(card).getByTestId('approver-1')).toBeTruthy();
    expect(within(card).getByTestId('files-1').querySelector('a')?.getAttribute('href')).toContain('/exports/file-1.xlsx');
  });

  it('keeps the history when the revision it is compared with cannot be read, with the card in the comparison', async () => {
    show({ reports: { [FIRST]: problem(403, 'SCOPE_DENIED') } }, READER, `/?report=${SECOND}`);
    const compare = await screen.findByTestId('compare');
    expect(await within(compare).findByText(word('states.denied.title'))).toBeTruthy();
    expect(screen.getByTestId('history')).toBeTruthy();
  });

  it('goes back to the choice of a report', async () => {
    show({}, READER, `/?report=${SECOND}`);
    fireEvent.click(await screen.findByRole('button', { name: word('mne.history.back.action') }));
    expect(await screen.findByText(word('mne.history.picker.title'))).toBeTruthy();
    expect(screen.queryByTestId('history')).toBeNull();
  });

  it('shows the denied card and reads nothing when the caller may not read the monitoring', async () => {
    const h = show({}, ['membership.read'], `/?report=${SECOND}`);
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    expect(screen.queryByTestId('history')).toBeNull();
    expect(readsOf(h, 'getMneReport')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: word('mne.history.back.action') })).toBeNull();
  });

  it('shows the empty card when the year has no issued report, and the skeleton while a report is read', async () => {
    show({ obligations: () => ({ items: [obligationRow(1, { status: 'DRAFT' })], next_cursor: null }) });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    const h = client();
    h.read.mockImplementation(() => new Promise(() => undefined));
    mount(<ReportHistoryScreen route={ROUTE} />, h, { permissions: READER }, `/?report=${SECOND}`);
    expect(await screen.findByLabelText(word('states.loading.label'))).toBeTruthy();
  });

  it('reads on through pages that hold no issued report until one is found, and ends on the empty card when none is', async () => {
    const h = show({
      obligations: (query) =>
        (query as { cursor?: string }).cursor === undefined
          ? { items: [obligationRow(1, { status: 'DRAFT' })], next_cursor: 'next' }
          : { items: [obligationRow(2, { status: 'ISSUED' })], next_cursor: null },
    });
    await screen.findByTestId('issued-reports');
    expect(within(screen.getByTestId('issued-reports')).getAllByRole('row')).toHaveLength(2);
    expect(readsOf(h, 'listMneObligations')).toHaveLength(2);
    cleanup();
    show({
      obligations: (query) =>
        (query as { cursor?: string }).cursor === undefined
          ? { items: [obligationRow(1, { status: 'DRAFT' })], next_cursor: 'next' }
          : { items: [obligationRow(3, { status: 'DRAFT' })], next_cursor: null },
    });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
  });

  it('reads another year and further pages of the calendar', async () => {
    const h = show({
      obligations: (query) =>
        (query as { cursor?: string }).cursor === undefined
          ? { items: [obligationRow(1, { status: 'ISSUED' })], next_cursor: 'next' }
          : { items: [obligationRow(2, { status: 'EXPORTED' })], next_cursor: null },
    });
    await screen.findByTestId('issued-reports');
    fireEvent.click(screen.getByRole('button', { name: word('mne.calendar.more.action') }));
    await waitFor(() => expect(within(screen.getByTestId('issued-reports')).getAllByRole('row')).toHaveLength(3));
    fireEvent.change(screen.getByLabelText(word('mne.calendar.filter.year.label')), { target: { value: String(new Date().getFullYear() - 1) } });
    await waitFor(() =>
      expect(readsOf(h, 'listMneObligations').some(([, input]) => (input as { query: Record<string, unknown> }).query.report_year === String(new Date().getFullYear() - 1))).toBe(true),
    );
  });

  for (const [name, failure, title] of FAILURES) {
    it(`shows the ${name} card when the calendar fails, and when the report fails`, async () => {
      show({ obligations: () => failure });
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.queryByTestId('issued-reports')).toBeNull();
      cleanup();
      const h = show({ reports: { [SECOND]: failure } }, READER, `/?report=${SECOND}`);
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.queryByTestId('history')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      await waitFor(() => expect(readsOf(h, 'getMneReport').length).toBeGreaterThan(1));
    });
  }
});

describe('history model (MNE-10)', () => {
  it('reads a revision with its history oldest first, and drops what is not well formed', () => {
    const revision = toRevision({
      ...revisionBody(SECOND, 2),
      history: [HISTORY[1], HISTORY[0], { id: THIRD, revision: 'x', status: 'DRAFT' }, { id: THIRD, revision: 3, status: 'WEIRD' }, { revision: 4, status: 'DRAFT' }, 'x'],
    });
    expect(revision?.history.map((entry) => entry.revision)).toEqual([1, 2]);
    expect(revision).toMatchObject({ approvedBy: APPROVER_2, correctionReason: 'Sửa số giải ngân sau khi đối chiếu Kho bạc', supersedesId: FIRST });
    expect(revision?.history[1]).toMatchObject({ id: SECOND, issuedAt: '2026-07-20T02:00:00Z', createdAt: '2026-07-15T02:00:00Z', supersedesId: FIRST });
    expect(toRevision({ ...revisionBody(FIRST, 1), history: undefined })?.history).toEqual([]);
    expect(toRevision({ ...revisionBody(FIRST, 1), approved_by: '', correction_reason: '' })).toMatchObject({ approvedBy: null, correctionReason: null });
    expect(toRevision('x')).toBeUndefined();
    expect(toRevision({})).toBeUndefined();
  });

  it('compares with the revision it corrects, and knows when there is another to compare with', () => {
    const revision = toRevision(revisionBody(SECOND, 2));
    expect(defaultAgainst(revision ?? { supersedesId: null })).toBe(FIRST);
    expect(defaultAgainst({ supersedesId: null })).toBeUndefined();
    expect(hasOthers(revision?.history ?? [], SECOND)).toBe(true);
    expect(hasOthers((revision?.history ?? []).slice(1), SECOND)).toBe(false);
  });

  it('puts the cells of the two revisions side by side and counts the ones that differ', () => {
    const before = toRevision(revisionBody(FIRST, 1))?.report;
    const after = toRevision(revisionBody(SECOND, 2))?.report;
    const rows = diffCells(before ?? { fields: [] }, after ?? { fields: [] });
    expect(rows.map((row) => `${row.key}:${row.change}`)).toEqual(['disbursed:changed', 'rate:same', 'difficulties:changed', 'proposals:added', 'legacy:removed']);
    expect(changedCount(rows)).toBe(4);
    expect(changedCount(diffCells({ fields: [] }, { fields: [] }))).toBe(0);
  });

  it('keeps the obligations that were issued at least once', () => {
    const items = [obligationRow(1, { status: 'ISSUED' }), obligationRow(2, { status: 'DRAFT' }), obligationRow(3, { status: 'RETURNED' }), obligationRow(4, { status: 'ISSUING' })].flatMap(
      (raw) => toObligation(raw) ?? [],
    );
    expect(historicObligations(items).map((item) => item.status)).toEqual(['ISSUED', 'RETURNED']);
  });
});

import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { detail } from '../prj/test-support';
import ProjectReportScreen from './ProjectReportScreen';
import { figuresOf, isProjectKind, projectObligations } from './project-report-model';
import { formRow, harness, mount, obligationRow, routeOf } from './test-support';
import type { Harness } from './test-support';
import { toForm, toObligation, toReport } from './types';

const ROUTE = routeOf('MNE-04', 'FR-MNE-04');
const REPORT = '00000000-0000-4000-8000-000000000777';
const PROJECT = detail(1).id;
const PREPARE = ['mne.read', 'mne.report.prepare'];
const READ_ONLY = ['mne.read'];

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

const reportBody = (overrides: Record<string, unknown> = {}) => ({
  id: REPORT,
  form: {
    id: '00000000-0000-4000-8000-000000000104',
    code: 'TT44-M04',
    revision: 2,
    title: 'Báo cáo giám sát dự án khi khởi công',
    legal_confirmation_ref: null,
    watermark_text: 'Mẫu chờ xác nhận pháp lý [CXN-10]',
  },
  awaiting_confirmation: true,
  cxn_refs: ['CXN-10'],
  report_year: 2026,
  period_label: 'Khởi công 2026-03-02',
  period_id: null,
  scope_unit: { id: '00000000-0000-4000-8000-000000000501', code: 'CDT-1', name: 'Chủ đầu tư 1' },
  project_id: PROJECT,
  due_date: '2026-04-01',
  revision: 1,
  status: 'DRAFT',
  is_late: false,
  snapshot: null,
  snapshot_options: [],
  fields: [
    field('total_investment', 'Tổng mức đầu tư', 'MONEY', { required: true, locked: true, source: { kind: 'PROJECT_COUNT', stage: null }, value: 4 }),
    field('plan_total', 'Vốn đã giao trong năm', 'MONEY', { locked: true, source: { kind: 'APPROPRIATION_TOTAL', plan_year: 2026 }, value: '250000000000' }),
    field('contract_value', 'Giá trị hợp đồng', 'MONEY', { locked: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'plan_total_vnd' }, value: null }),
    field('proposals', 'Kiến nghị', 'TEXT', { value: 'Đề nghị bố trí vốn kịp thời.' }),
    field('difficulties', 'Khó khăn, vướng mắc', 'TEXT'),
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

const FORMS = [
  formRow(2, { report_kind: 'OVERALL_SEMIANNUAL' }),
  formRow(4, { form_code: 'TT44-M04', report_kind: 'PROJECT_START', title: 'Báo cáo giám sát dự án khi khởi công' }),
  formRow(5, { form_code: 'TT44-M05', report_kind: 'PROJECT_ADJUST' }),
];
const EVENTS = [
  obligationRow(1, { form_code: 'TT44-M04', period_label: 'Khởi công 2026-03-02', due_date: '2026-04-01' }),
  obligationRow(2, { form_code: 'TT44-M05', period_label: 'Điều chỉnh 2026-05-10', due_date: '2026-06-09', status: 'IN_REVIEW' }),
  obligationRow(3, { form_code: 'TT44-M02' }),
];

interface Served {
  obligations?: (query: unknown) => unknown;
  forms?: Array<Record<string, unknown>> | Error;
  report?: unknown;
  project?: unknown;
}

function client(served: Served = {}): Harness & { readAll: ReturnType<typeof vi.fn> } {
  const h = harness((operation, input) => {
    if (operation === 'listMneObligations') return served.obligations === undefined ? { items: EVENTS, next_cursor: null } : served.obligations((input as { query?: unknown } | undefined)?.query);
    if (operation === 'getMneReport') return served.report ?? reportBody();
    if (operation === 'get_resources_project_id') return served.project ?? detail(1);
    return new Error(`unexpected read ${operation}`);
  });
  const readAll = vi.fn((operation: string) => {
    if (operation !== 'listMneForms') return Promise.reject(new Error(`unexpected readAll ${operation}`));
    const forms = served.forms ?? FORMS;
    return forms instanceof Error ? Promise.reject(forms) : Promise.resolve(forms);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

const show = (served: Served = {}, permissions: readonly string[] | undefined = PREPARE, path = '/') => {
  const h = client(served);
  mount(<ProjectReportScreen route={ROUTE} />, h, { permissions }, path);
  return h;
};
const readsOf = (h: Harness, operation: string): unknown[][] => h.read.mock.calls.filter(([name]) => name === operation);

describe('ProjectReportScreen (MNE-04): the monitoring report of a project', () => {
  it('UI-MNE-04: lists the project reports of the calendar with their kind, milestone, unit, due day and state, and leaves out the reports of units', async () => {
    const h = show();
    const table = await screen.findByTestId('project-reports');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('mne.project.page.title'));
    for (const key of ['mne.project.picker.column.kind', 'mne.project.picker.column.milestone', 'mne.project.picker.column.due', 'mne.project.picker.column.status'] as const) {
      expect(within(table).getByRole('columnheader', { name: word(key) })).toBeTruthy();
    }
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('data-kind')).toBe('PROJECT_START');
    expect(rows[0]?.textContent).toContain(word('mne.forms.kind.projectStart'));
    expect(rows[0]?.textContent).toContain('Khởi công 2026-03-02');
    expect(rows[0]?.textContent).toContain('2026-04-01');
    expect(rows[0]?.textContent).toContain(word('mne.calendar.status.draft'));
    expect(rows[1]?.textContent).toContain(word('mne.forms.kind.projectAdjust'));
    expect(rows[1]?.textContent).toContain(word('mne.calendar.status.inReview'));
    expect((readsOf(h, 'listMneObligations')[0]?.[1] as { query: Record<string, unknown> }).query).toMatchObject({ report_year: String(new Date().getFullYear()) });
    expect((readsOf(h, 'listMneObligations')[0]?.[1] as { query: Record<string, unknown> }).query).not.toHaveProperty('status');
  });

  it('AC-ST-MNE-008-2, UI-MNE-04: opens a report with its project, kind, milestone, figures and proposals, and the cells to write', async () => {
    const h = show();
    fireEvent.click(await screen.findByRole('button', { name: fill(word('mne.project.picker.open'), { milestone: 'Khởi công 2026-03-02' }) }));
    const card = await screen.findByTestId('project-card');
    expect(within(card).getByText(word('mne.project.field.project'))).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('project-name').textContent).toContain('DA-2026-001 Dự án số 1'));
    expect(screen.getByTestId('project-name').textContent).toContain(word('prj.stage.concept.label'));
    expect(screen.getByTestId('project-kind').textContent).toBe(fill(word('mne.project.kind.text'), { title: 'Báo cáo giám sát dự án khi khởi công', code: 'TT44-M04', revision: 2 }));
    expect(screen.getByTestId('project-milestone').textContent).toBe(fill(word('mne.project.milestone.text'), { milestone: 'Khởi công 2026-03-02', due: '2026-04-01' }));
    expect(screen.getByTestId('project-figures').textContent).toBe(fill(word('mne.project.figures.text'), { count: 3, empty: 1 }));
    expect(screen.getByTestId('project-proposals').textContent).toBe(fill(word('mne.project.proposals.text'), { filled: 1, count: 2 }));
    // The report itself is the one of MNE-03: its figures are locked, its words are written by the preparer.
    expect(await screen.findByTestId('value-plan_total')).toBeTruthy();
    expect(screen.getByTestId('locked-plan_total').textContent).toBe(word('mne.report.field.locked'));
    expect((screen.getByLabelText('Kiến nghị') as HTMLTextAreaElement).value).toBe('Đề nghị bố trí vốn kịp thời.');
    expect(readsOf(h, 'getMneReport').length).toBeGreaterThanOrEqual(1);
    expect(readsOf(h, 'get_resources_project_id')[0]?.[1]).toEqual({ path: { id: PROJECT } });
    // The way back lists the reports again.
    fireEvent.click(screen.getByRole('button', { name: word('mne.project.back.action') }));
    expect(await screen.findByTestId('project-reports')).toBeTruthy();
  });

  it('opens a report from the address, and says there is no figure or no written cell where the form has none', async () => {
    show({ report: reportBody({ fields: [field('proposals', 'Kiến nghị', 'TEXT')] }) }, READ_ONLY, `/?report=${REPORT}`);
    expect((await screen.findByTestId('project-figures')).textContent).toBe(word('mne.project.figures.none'));
    expect(screen.getByTestId('project-proposals').textContent).toBe(fill(word('mne.project.proposals.text'), { filled: 0, count: 1 }));
    cleanup();
    show({ report: reportBody({ fields: [field('total', 'Tổng', 'MONEY', { locked: true, source: { kind: 'PROJECT_COUNT', stage: null }, value: 1 })] }) }, READ_ONLY, `/?report=${REPORT}`);
    expect((await screen.findByTestId('project-proposals')).textContent).toBe(word('mne.project.proposals.none'));
    // Whoever may not prepare reports reads the cells without a box to type in.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps the report when the project cannot be read, and says so in place of its name', async () => {
    show({ project: problem(403, 'SCOPE_DENIED') }, PREPARE, `/?report=${REPORT}`);
    await screen.findByTestId('project-name');
    await waitFor(() => expect(screen.getByTestId('project-name').textContent).toBe(word('mne.project.project.unreadable.notice')));
    expect(await screen.findByTestId('value-plan_total')).toBeTruthy();
  });

  it('does not open a report of a unit as a project report, and sends it to the screen that writes it', async () => {
    const h = show({ report: reportBody({ project_id: null }) }, PREPARE, `/?report=${REPORT}`);
    expect((await screen.findByTestId('not-project-report')).textContent).toContain(word('mne.project.notProject.notice'));
    expect(screen.getByRole('link', { name: word('mne.project.notProject.action') }).getAttribute('href')).toBe(`/mne/mne-03?report=${REPORT}`);
    expect(screen.queryByTestId('project-card')).toBeNull();
    expect(readsOf(h, 'get_resources_project_id')).toHaveLength(0);
  });

  it('reads on through pages that hold no project report until one is found, and ends on the empty card when none is', async () => {
    const other = obligationRow(3, { form_code: 'TT44-M02' });
    const h = show({ obligations: (query) => ((query as { cursor?: string }).cursor === undefined ? { items: [other], next_cursor: 'next' } : { items: [EVENTS[0]], next_cursor: null }) });
    await screen.findByTestId('project-reports');
    expect(within(screen.getByTestId('project-reports')).getAllByRole('row')).toHaveLength(2);
    expect(readsOf(h, 'listMneObligations')).toHaveLength(2);
    cleanup();
    show({ obligations: (query) => ((query as { cursor?: string }).cursor === undefined ? { items: [other], next_cursor: 'next' } : { items: [other], next_cursor: null }) });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
  });

  it('reads another year and further pages of the calendar', async () => {
    const h = show({
      obligations: (query) => ((query as { cursor?: string }).cursor === undefined ? { items: [EVENTS[0]], next_cursor: 'next' } : { items: [EVENTS[1]], next_cursor: null }),
    });
    await screen.findByTestId('project-reports');
    fireEvent.click(screen.getByRole('button', { name: word('mne.calendar.more.action') }));
    await waitFor(() => expect(within(screen.getByTestId('project-reports')).getAllByRole('row')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: word('mne.calendar.more.action') })).toBeNull();
    fireEvent.change(screen.getByLabelText(word('mne.calendar.filter.year.label')), { target: { value: String(new Date().getFullYear() - 1) } });
    await waitFor(() =>
      expect(readsOf(h, 'listMneObligations').some(([, input]) => (input as { query: Record<string, unknown> }).query.report_year === String(new Date().getFullYear() - 1))).toBe(true),
    );
  });

  it('shows the denied card and reads nothing when the caller may not read the monitoring', async () => {
    const h = show({}, ['mne.report.prepare']);
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    expect(screen.queryByTestId('project-reports')).toBeNull();
    expect(readsOf(h, 'listMneObligations')).toHaveLength(0);
    cleanup();
    const unknown = show({}, undefined);
    expect(await screen.findByTestId('project-reports')).toBeTruthy();
    expect(readsOf(unknown, 'listMneObligations')).toHaveLength(1);
  });

  it('shows the empty card when the year has no project report, and the skeleton while the calendar is read', async () => {
    show({ obligations: () => ({ items: [obligationRow(3, { form_code: 'TT44-M02' })], next_cursor: null }) });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    const h = client();
    h.read.mockImplementation(() => new Promise(() => undefined));
    mount(<ProjectReportScreen route={ROUTE} />, h, { permissions: PREPARE }, '/');
    expect(await screen.findByLabelText(word('states.loading.label'))).toBeTruthy();
  });

  for (const [name, failure, title] of FAILURES) {
    it(`shows the ${name} card when the calendar fails, and when the report fails`, async () => {
      show({ obligations: () => failure });
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.queryByTestId('project-reports')).toBeNull();
      cleanup();
      const h = show({ report: failure }, PREPARE, `/?report=${REPORT}`);
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.queryByTestId('project-card')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      await waitFor(() => expect(readsOf(h, 'getMneReport').length).toBeGreaterThan(1));
    });
  }

  it('shows the error card when the catalogue of forms fails, and reads again on retry', async () => {
    const h = show({ forms: problem(500, 'INTERNAL_ERROR') });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(h.readAll.mock.calls.length).toBeGreaterThan(1));
  });
});

describe('project report model (MNE-04)', () => {
  const forms = FORMS.flatMap((raw) => toForm(raw) ?? []);

  it('knows the kinds of report that are about a project', () => {
    expect(['PROJECT_START', 'PROJECT_ADJUST', 'PROJECT_COMPLETION', 'PROJECT_PERIODIC'].every((kind) => isProjectKind(kind as never))).toBe(true);
    expect(['OVERALL_SEMIANNUAL', 'OVERALL_ANNUAL', 'EVALUATION', 'WEEKLY_QUICK'].some((kind) => isProjectKind(kind as never))).toBe(false);
  });

  it('keeps the obligations whose form is a project form, with the kind of that form', () => {
    const items = EVENTS.flatMap((raw) => toObligation(raw) ?? []);
    expect(projectObligations(items, forms).map((one) => `${one.item.formCode}:${one.kind}`)).toEqual(['TT44-M04:PROJECT_START', 'TT44-M05:PROJECT_ADJUST']);
    expect(projectObligations(items, [])).toEqual([]);
    expect(projectObligations([], forms)).toEqual([]);
  });

  it('counts the figures from a source that hold nothing yet and the written cells that hold something', () => {
    const report = toReport(reportBody());
    expect(figuresOf(report ?? { fields: [] })).toEqual({ figures: 3, empty: 1, written: 2, writtenFilled: 1 });
    expect(figuresOf({ fields: [] })).toEqual({ figures: 0, empty: 0, written: 0, writtenFilled: 0 });
    const blank = toReport(reportBody({ fields: [field('a', 'A', 'TEXT', { value: '   ' }), field('b', 'B', 'INTEGER', { locked: true, source: { kind: 'PROJECT_COUNT', stage: null }, value: 0 })] }));
    expect(figuresOf(blank ?? { fields: [] })).toEqual({ figures: 1, empty: 0, written: 1, writtenFilled: 0 });
    expect(toReport(reportBody({ project_id: null }))?.projectId).toBeNull();
    expect(toReport(reportBody())?.projectId).toBe(PROJECT);
  });
});

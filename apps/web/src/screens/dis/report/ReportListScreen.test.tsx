import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../../i18n';
import vi_ from '../../../i18n/vi.json';
import { PERIOD, PLAN, PROJECT, PROJECT_TWO, READER, MAKER, client, kpiRecord, lineRecord, mount, pageRecord, routeOf, world } from './test-support';
import type { World } from './test-support';
import ReportListScreen from './ReportListScreen';

const ROUTE = routeOf('DIS-01', 'FR-DIS-01');

afterEach(cleanup);

const open = (overrides: Partial<World> = {}, permissions: readonly string[] | undefined = MAKER, mode?: 'FULL' | 'READ_ONLY') => {
  const state = world({ page: pageRecord([lineRecord(1), lineRecord(2, { status: 'SUBMITTED', is_late: true, cumulative_vnd: '1250000000', ctmtqg_vnd: '0' })]), ...overrides });
  const h = client(state);
  mount(<ReportListScreen route={ROUTE} />, h, { permissions, path: '/dis/dis-01', ...(mode === undefined ? {} : { mode }) });
  return h;
};

const text = (id: string): string => screen.getByTestId(id).textContent ?? '';
type Harness = ReturnType<typeof client>;
/** The query of the last read of the list (the board and the others read too, so the reads are picked by operation). */
const queryOfLastRead = (h: Harness): Record<string, unknown> => {
  const reads = h.read.mock.calls.filter((call) => call[0] === 'get_resources_report_revision');
  return ((reads.at(-1)?.[1] as { query: Record<string, unknown> }) ?? { query: {} }).query;
};
const bodyRows = (): HTMLTableRowElement[] => Array.from(document.querySelectorAll<HTMLTableRowElement>('tbody tr'));
const pagerButton = (label: string): HTMLButtonElement => screen.getByRole('button', { name: label }) as HTMLButtonElement;

describe('DIS-01 weekly reports', () => {
  it('AC-ST-DIS-007-1: offers the drafts that were deleted apart from the reports that stand, each leading to the confirmation that names it', async () => {
    const gone = lineRecord(7, { id: '00000000-0000-4000-8000-004500000077', period: { id: PERIOD, code: '2027-W05', end_date: '2027-02-07', fiscal_year: 2027, status: 'OPEN' } });
    open({ deleted: [gone] });
    const section = await screen.findByTestId('deleted-drafts');
    expect(within(section).getByText(/DA-2027-007 · 2027-W05 · lần 1/)).toBeTruthy();
    expect(within(section).getByRole('link', { name: vi_['dis.reports.deleted.open.action'] }).getAttribute('href')).toBe('/dis/dis-09?report=00000000-0000-4000-8000-004500000077');
    // The table is of the reports that stand: the deleted draft is not in it.
    await screen.findByText('DA-2027-001');
    expect(bodyRows()).toHaveLength(2);
    expect(screen.queryByText('DA-2027-007', { selector: 'strong' })).toBeNull();
  });

  it('AC-ST-DIS-008-1: leads a person who may import to the bulk import, and shows the way to nobody else', async () => {
    open({}, [...MAKER, 'report.import']);
    expect((await screen.findByRole('link', { name: vi_['dis.reports.import.action'] })).getAttribute('href')).toBe('/dis/dis-10');
    cleanup();
    open({}, MAKER);
    await screen.findByRole('heading', { level: 1, name: vi_['dis.reports.page.title'] });
    expect(screen.queryByRole('link', { name: vi_['dis.reports.import.action'] })).toBeNull();
    cleanup();
    open({}, ['report.import', 'report.read']);
    expect((await screen.findByRole('link', { name: vi_['dis.reports.import.action'] })).getAttribute('href')).toBe('/dis/dis-10');
    expect(screen.queryByRole('link', { name: t('dis.wr.create.action') })).toBeNull();
  });

  it('shows no deleted drafts when there are none, and to a reader who may not restore them', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: vi_['dis.reports.page.title'] });
    expect(screen.queryByTestId('deleted-drafts')).toBeNull();
    cleanup();
    open({ deleted: [lineRecord(7)] }, READER);
    await screen.findByRole('heading', { level: 1, name: vi_['dis.reports.page.title'] });
    expect(screen.queryByTestId('deleted-drafts')).toBeNull();
  });

  it('lists the reports with the project, its status chips, the period, the cumulative and the CTMTQG apart with its share, and a link to open each', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.reports.page.title'] })).toBeTruthy();
    await screen.findByText('DA-2027-001');
    const rows = bodyRows().filter((row) => row.querySelector('td') !== null && row.querySelector('th[scope="row"]') === null);
    const cells = rows.map((row) => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent));
    expect(cells[0]).toEqual([
      `DA-2027-001Cầu số 1${vi_['dis.reportStatus.draft']}`,
      `2027-W01${vi_['dis.reports.revision.text'].replace('{revision}', '1')}`,
      '420.000.000',
      `40.000.000${t('dis.wr.row.share', { percent: '9,5' })}`,
      '2027-01-05',
      vi_['dis.reports.open.action'].replace('{code}', 'DA-2027-001'),
    ]);
    // The status of a report that was handed in late is a chip, and the late mark is another.
    expect(cells[1]?.[0]).toBe(`DA-2027-002Cầu số 2${vi_['dis.reportStatus.submitted']}${vi_['dis.reports.late.text']}`);
    expect(cells[1]?.[2]).toBe('1.250.000.000');
    expect(cells[1]?.[3]).toBe(`0${t('dis.wr.row.share', { percent: '0,0' })}`);
    expect(screen.getByRole('link', { name: vi_['dis.reports.open.action'].replace('{code}', 'DA-2027-001') }).getAttribute('href')).toBe(`/dis/dis-04?report=${lineRecord(1).id as string}`);
    // A report that was handed in is read on its detail (DIS-07), where the reviewer decides and the maker corrects; only a draft is edited.
    expect(screen.getByRole('link', { name: vi_['dis.reports.open.action'].replace('{code}', 'DA-2027-002') }).getAttribute('href')).toBe(`/dis/dis-07?report=${lineRecord(2).id as string}`);
  });

  it('has a two-tier head: the cumulative columns sit under one group, and the others span both rows', async () => {
    open();
    await screen.findByText('DA-2027-001');
    const head = document.querySelectorAll('thead tr');
    expect(head).toHaveLength(2);
    const group = within(head[0] as HTMLElement).getByRole('columnheader', { name: t('dis.reports.col.cumulative') });
    expect(group.getAttribute('colspan')).toBe('2');
    expect(within(head[1] as HTMLElement).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([t('dis.wr.col.total'), t('dis.reports.col.ctmtqg')]);
  });

  it('adds up the rows that are shown in a row of its own that says it is the total of the rows shown', async () => {
    open();
    await screen.findByText('DA-2027-001');
    const total = document.querySelector('tfoot tr') as HTMLElement;
    expect(within(total).getByRole('rowheader').textContent).toBe(t('dis.wr.totals.label'));
    expect(Array.from(total.querySelectorAll('td')).map((cell) => cell.textContent)).toEqual(['', '1.670.000.000', '40.000.000', '', '']);
  });

  it('AC-ST-DIS-003-4 / UI-DIS-01: gives four figures with the scope each counts and the exact amount next to the short form, and the figures of everything the caller sees apart once the table is filtered', async () => {
    const user = userEvent.setup();
    const filtered = (query: Record<string, unknown>) =>
      query.project_id === undefined
        ? pageRecord([lineRecord(1), lineRecord(2)], { summary: { filtered: kpiRecord(2, 2, '840000000', '80000000'), scope: kpiRecord(2, 2, '840000000', '80000000'), is_filtered: false } })
        : pageRecord([lineRecord(1)], { summary: { filtered: kpiRecord(1, 1, '420000000', '40000000'), scope: kpiRecord(2, 2, '840000000', '80000000'), is_filtered: true } });
    const h = open({ page: filtered });
    const tiles = within(await screen.findByRole('group', { name: t('dis.wr.kpi.label') }));
    expect(tiles.getAllByRole('article')).toHaveLength(4);
    const cumulative = tiles.getByText(t('dis.wr.kpi.cumulative')).closest('article') as HTMLElement;
    expect(cumulative.textContent).toContain('0,84');
    expect(cumulative.textContent).toContain(t('dis.wr.kpi.unit'));
    expect(cumulative.textContent).toContain(t('dis.wr.kpi.exact', { amount: '840.000.000' }));
    expect(cumulative.textContent).toContain(t('dis.wr.kpi.scope.all'));
    expect((tiles.getByText(t('dis.wr.kpi.ctmtqg')).closest('article') as HTMLElement).textContent).toContain(t('dis.wr.kpi.share', { percent: '9,5' }));
    expect(screen.queryByTestId('kpi-scope')).toBeNull();
    await user.selectOptions(screen.getByLabelText(vi_['dis.reports.filter.project.label']), PROJECT);
    const filteredTile = (): string => (within(screen.getByRole('group', { name: t('dis.wr.kpi.label') })).getByText(t('dis.wr.kpi.cumulative')).closest('article') as HTMLElement).textContent ?? '';
    await waitFor(() => expect(filteredTile()).toContain(t('dis.reports.kpi.filtered.title')));
    expect(filteredTile()).toContain('420.000.000');
    expect(text('kpi-scope')).toContain(vi_['dis.reports.kpi.scope.title']);
    expect(text('kpi-scope-counts')).toBe(vi_['dis.reports.kpi.counts'].replace('{reports}', '2').replace('{projects}', '2'));
    expect(text('kpi-scope-money')).toBe(vi_['dis.reports.kpi.money'].replace('{amount}', '840.000.000').replace('{ctmtqg}', '80.000.000'));
    expect(text('kpi-note')).toBe(vi_['dis.reports.kpi.note']);
    expect(queryOfLastRead(h)).toMatchObject({ project_id: PROJECT, limit: 25 });
  });

  it('filters by year, week, annual plan and project, asks the server for what is set, and lets the filters go', async () => {
    const user = userEvent.setup();
    const h = open();
    await screen.findByTestId('kpis');
    const week = screen.getByLabelText(vi_['dis.reports.filter.period.label']) as HTMLSelectElement;
    expect(week.disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText(vi_['dis.reports.filter.year.label']), '2027');
    expect(queryOfLastRead(h)).toMatchObject({ fiscal_year: 2027 });
    expect(week.disabled).toBe(false);
    expect(within(week).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['dis.reports.filter.all.option'], '2027-W01', '2027-W02']);
    await user.selectOptions(week, PERIOD);
    await user.selectOptions(await screen.findByLabelText(vi_['dis.reports.filter.plan.label']), PLAN);
    await user.selectOptions(screen.getByLabelText(vi_['dis.reports.filter.project.label']), PROJECT_TWO);
    await waitFor(() => expect(queryOfLastRead(h)).toMatchObject({ fiscal_year: 2027, period_id: PERIOD, plan_id: PLAN, project_id: PROJECT_TWO }));
    await user.click(screen.getByRole('button', { name: vi_['dis.reports.filter.clear.action'] }));
    await waitFor(() => expect(queryOfLastRead(h)).toEqual({ limit: 25 }));
    expect(screen.queryByRole('button', { name: vi_['dis.reports.filter.clear.action'] })).toBeNull();
  });

  it('opens on the progress of the period: how many projects have sent, the deadline with its countdown, and how many are still missing, with the way to the board', async () => {
    const board = (_query: Record<string, unknown>, periodId: string) => ({
      period: { id: periodId, code: '2027-W02', period_type: 'WEEK', deadline_at: '2099-01-09T10:00:00.000Z' },
      deadline_passed: false,
      total: { must_report: 8, submitted: 6, submitted_late: 1, draft: 1, not_started: 1, overdue: 0 },
      units: [],
      projects: [],
    });
    open({ board });
    const card = await screen.findByTestId('period-progress');
    expect(within(card).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('75');
    expect(card.textContent).toContain(t('ui.periodProgress.sent', { sent: 6, total: 8 }));
    expect(card.textContent).toMatch(/Hạn 10:00 09\/01\/2099 · còn \d+ ngày/);
    expect(text('period-missing')).toContain(t('dis.wr.missing.count', { count: 2 }));
    expect(within(card).getByRole('link', { name: t('dis.wr.missing.board') }).getAttribute('href')).toMatch(/^\/dis\/dis-15\?period=/);
  });

  it('says that every project has sent, and shows no card at all when the board cannot be read', async () => {
    const board = (_query: Record<string, unknown>, periodId: string) => ({
      period: { id: periodId, code: '2027-W02', period_type: 'WEEK', deadline_at: '2020-01-09T10:00:00.000Z' },
      deadline_passed: true,
      total: { must_report: 3, submitted: 3, submitted_late: 0, draft: 0, not_started: 0, overdue: 0 },
      units: [],
      projects: [],
    });
    open({ board });
    expect((await screen.findByTestId('period-missing')).textContent).toContain(t('dis.wr.missing.none'));
    cleanup();
    open();
    await screen.findByTestId('kpis');
    expect(screen.queryByTestId('period-progress')).toBeNull();
  });

  it('has the shortcuts "not sent" and "sent back", which ask the server for the status, mark the one that is on, and go off when pressed again', async () => {
    const user = userEvent.setup();
    const h = open();
    await screen.findByTestId('kpis');
    const group = within(screen.getByRole('group', { name: t('dis.wr.quick.label') }));
    expect(group.getByRole('button', { name: t('dis.wr.quick.all') }).getAttribute('aria-pressed')).toBe('true');
    await user.click(group.getByRole('button', { name: t('dis.wr.quick.draft') }));
    await waitFor(() => expect(queryOfLastRead(h)).toMatchObject({ status: 'DRAFT' }));
    expect(group.getByRole('button', { name: t('dis.wr.quick.draft') }).getAttribute('aria-pressed')).toBe('true');
    await user.click(group.getByRole('button', { name: t('dis.wr.quick.returned') }));
    await waitFor(() => expect(queryOfLastRead(h)).toMatchObject({ status: 'RETURNED' }));
    expect(group.getByRole('button', { name: t('dis.wr.quick.draft') }).getAttribute('aria-pressed')).toBe('false');
    await user.click(group.getByRole('button', { name: t('dis.wr.quick.returned') }));
    await waitFor(() => expect(queryOfLastRead(h)).toEqual({ limit: 25 }));
    // A shortcut counts as a filter, so it can be cleared with the others.
    await user.click(group.getByRole('button', { name: t('dis.wr.quick.draft') }));
    await user.click(await screen.findByRole('button', { name: vi_['dis.reports.filter.clear.action'] }));
    await waitFor(() => expect(queryOfLastRead(h)).toEqual({ limit: 25 }));
  });

  it('exports the rows that are shown as a file a spreadsheet opens, and has nothing to export when there is no row', async () => {
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    // The browser of the test has no object URLs: stand-ins are put there for the length of the test.
    const created = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:report';
    });
    const revoked = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: created });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revoked });
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      open();
      await screen.findByText('DA-2027-001');
      await user.click(screen.getByRole('button', { name: t('dis.wr.export.action') }));
      expect(created).toHaveBeenCalledTimes(1);
      expect(clicked).toHaveBeenCalledTimes(1);
      expect(revoked).toHaveBeenCalledWith('blob:report');
      const bytes = new Uint8Array(
        await new Promise<ArrayBuffer>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.readAsArrayBuffer(blobs[0] as Blob);
        }),
      );
      // The byte order mark comes first, so that the spreadsheet reads the letters as UTF-8.
      expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
      const body = new TextDecoder().decode(bytes);
      expect(body).toContain(`"DA-2027-001","Cầu số 1","2027-W01","${vi_['dis.reportStatus.draft']}","420000000","40000000","2027-01-05"`);
      expect(body.trim().split('\r\n')).toHaveLength(3);
    } finally {
      Reflect.deleteProperty(URL, 'createObjectURL');
      Reflect.deleteProperty(URL, 'revokeObjectURL');
      clicked.mockRestore();
    }
    cleanup();
    open({ page: pageRecord([]) });
    await screen.findByText(t('ui.dataTable.emptyNone'));
    expect((screen.getByRole('button', { name: t('dis.wr.export.action') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not offer the filter by plan when the caller may read none', async () => {
    open({ plans: [] });
    await screen.findByTestId('kpis');
    expect(screen.queryByLabelText(vi_['dis.reports.filter.plan.label'])).toBeNull();
  });

  it('goes from page to page by the cursor the server gave, and back, and says which rows of how many are shown', async () => {
    const user = userEvent.setup();
    const pages = (query: Record<string, unknown>) =>
      query.cursor === 'second'
        ? pageRecord([lineRecord(3)], { next_cursor: null, summary: { filtered: kpiRecord(60, 3, '1', '1'), scope: kpiRecord(60, 3, '1', '1'), is_filtered: false } })
        : pageRecord([lineRecord(1), lineRecord(2)], { next_cursor: 'second', summary: { filtered: kpiRecord(60, 3, '1', '1'), scope: kpiRecord(60, 3, '1', '1'), is_filtered: false } });
    const h = open({ page: pages });
    await screen.findByText('DA-2027-001');
    expect(screen.getByText(t('ui.tablePager.range', { from: 1, to: 2, total: 60 }))).toBeTruthy();
    expect(pagerButton(t('ui.tablePager.prev')).disabled).toBe(true);
    await user.click(pagerButton(t('ui.tablePager.next')));
    await waitFor(() => expect(queryOfLastRead(h)).toMatchObject({ cursor: 'second' }));
    await screen.findByText('DA-2027-003');
    expect(screen.getByText(t('ui.tablePager.range', { from: 26, to: 26, total: 60 }))).toBeTruthy();
    await user.click(pagerButton(t('ui.tablePager.prev')));
    await screen.findByText('DA-2027-002');
    expect(pagerButton(t('ui.tablePager.prev')).disabled).toBe(true);
  });

  it('asks for the page size the person chose and starts again from the first page', async () => {
    const user = userEvent.setup();
    const h = open();
    await screen.findByText('DA-2027-001');
    await user.selectOptions(screen.getByRole('combobox', { name: t('ui.tablePager.size') }), '50');
    await waitFor(() => expect(queryOfLastRead(h)).toEqual({ limit: 50 }));
  });

  it('says there is no report in words, and does not add up what is not there', async () => {
    open({ page: pageRecord([], { summary: { filtered: kpiRecord(0, 0, '0', '0'), scope: kpiRecord(0, 0, '0', '0'), is_filtered: false } }) });
    expect(await screen.findByText(t('ui.dataTable.emptyNone'))).toBeTruthy();
    expect(within(screen.getByRole('group', { name: t('dis.wr.kpi.label') })).getAllByRole('article')[0]?.textContent).toContain('0');
    expect(document.querySelector('tfoot')).toBeNull();
  });

  it('says a filter that finds nothing in its own words and offers to clear it', async () => {
    const user = userEvent.setup();
    open({ page: (query) => (query.status === undefined ? pageRecord([lineRecord(1)]) : pageRecord([], { summary: { filtered: kpiRecord(0, 0, '0', '0'), scope: kpiRecord(1, 1, '1', '1'), is_filtered: true } })) });
    await screen.findByText('DA-2027-001');
    await user.click(screen.getByRole('button', { name: t('dis.wr.quick.returned') }));
    expect(await screen.findByText(t('ui.dataTable.emptyFiltered'))).toBeTruthy();
    await user.click(within(screen.getByText(t('ui.dataTable.emptyFiltered')).closest('td') as HTMLElement).getByRole('button', { name: t('ui.dataTable.clearFilters') }));
    await screen.findByText('DA-2027-001');
  });

  it('shows the figures only when the server gave them', async () => {
    open({ page: { items: [lineRecord(1)], next_cursor: null } });
    await screen.findByText('DA-2027-001');
    expect(screen.queryByTestId('kpis')).toBeNull();
  });

  it('puts the scope, the period, the closing date and the unit on the line under the title, and the time of the data on the filter', async () => {
    open();
    const context = await screen.findByRole('group', { name: t('ui.contextBar.label') });
    await waitFor(() => expect(context.textContent).toMatch(/2027-W0[12]/));
    expect(context.textContent).toContain(t('dis.wr.ctx.scope'));
    expect(context.textContent).toContain('Cao Bang');
    expect(context.textContent).toContain('10:00 09/01/2099');
    expect(context.textContent).toContain(t('ui.unitChip.label', { unit: t('dis.wr.unit') }));
    expect((await screen.findByRole('region', { name: t('ui.filterPanel.title') })).textContent).toContain(t('ui.unitChip.label', { unit: t('dis.wr.unit') }));
  });

  it('offers the start of a report to a maker, and to nobody else', async () => {
    open();
    expect((await screen.findByRole('link', { name: t('dis.wr.create.action') })).getAttribute('href')).toBe('/dis/dis-02');
    cleanup();
    open({}, READER);
    await screen.findByTestId('kpis');
    expect(screen.queryByRole('link', { name: t('dis.wr.create.action') })).toBeNull();
    cleanup();
    open({}, MAKER, 'READ_ONLY');
    await screen.findByTestId('kpis');
    expect(screen.queryByRole('link', { name: t('dis.wr.create.action') })).toBeNull();
  });

  it('shows a loading state first, then the denied, signed-out, offline and error states', async () => {
    const failing = (error: Error) => {
      const state = world();
      state.failing.set('get_resources_report_revision', error);
      return client(state);
    };
    mount(<ReportListScreen route={ROUTE} />, failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: READER });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    mount(<ReportListScreen route={ROUTE} />, failing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: READER });
    expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    cleanup();
    mount(<ReportListScreen route={ROUTE} />, failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: READER });
    expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
    cleanup();
    mount(<ReportListScreen route={ROUTE} />, failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: READER });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });
});

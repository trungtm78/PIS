import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
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
const queryOfLastRead = (h: ReturnType<typeof client>): Record<string, unknown> => ((h.read.mock.calls.at(-1)?.[1] as { query: Record<string, unknown> }) ?? { query: {} }).query;

describe('DIS-01 weekly reports', () => {
  it('AC-ST-DIS-007-1: offers the drafts that were deleted apart from the reports that stand, each leading to the confirmation that names it', async () => {
    const gone = lineRecord(7, { id: '00000000-0000-4000-8000-004500000077', period: { id: PERIOD, code: '2027-W05', end_date: '2027-02-07', fiscal_year: 2027, status: 'OPEN' } });
    open({ deleted: [gone] });
    const section = await screen.findByTestId('deleted-drafts');
    expect(within(section).getByText(/DA-2027-007 · 2027-W05 · lần 1/)).toBeTruthy();
    expect(within(section).getByRole('link', { name: vi_['dis.reports.deleted.open.action'] }).getAttribute('href')).toBe('/dis/dis-09?report=00000000-0000-4000-8000-004500000077');
    // The table is of the reports that stand: the deleted draft is not in it.
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(2);
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
    expect(screen.queryByRole('link', { name: vi_['dis.reports.create.action'] })).toBeNull();
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

  it('lists the reports with the project, the period, the status, the cumulative and the CTMTQG apart, and a link to open each', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.reports.page.title'] })).toBeTruthy();
    const rows = Array.from(await screen.findAllByRole('row')).slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows[0]).toEqual([`DA-2027-001Cầu số 1`, `2027-W01${vi_['dis.reports.revision.text'].replace('{revision}', '1')}`, vi_['dis.reportStatus.draft'], '420.000.000', '40.000.000', '2027-01-05', vi_['dis.reports.open.action'].replace('{code}', 'DA-2027-001')]);
    expect(rows[1]?.[2]).toBe(`${vi_['dis.reportStatus.submitted']}${vi_['dis.reports.late.text']}`);
    expect(rows[1]?.[3]).toBe('1.250.000.000');
    expect(screen.getByRole('link', { name: vi_['dis.reports.open.action'].replace('{code}', 'DA-2027-001') }).getAttribute('href')).toBe(`/dis/dis-04?report=${lineRecord(1).id as string}`);
    // A report that was handed in is read on its detail (DIS-07), where the reviewer decides and the maker corrects; only a draft is edited.
    expect(screen.getByRole('link', { name: vi_['dis.reports.open.action'].replace('{code}', 'DA-2027-002') }).getAttribute('href')).toBe(`/dis/dis-07?report=${lineRecord(2).id as string}`);
  });

  it('AC-ST-DIS-003-4 / UI-DIS-01: gives the figures of the table with the words of what they are the total of, and the figures of everything the caller sees apart once the table is filtered', async () => {
    const user = userEvent.setup();
    const filtered = (query: Record<string, unknown>) =>
      query.project_id === undefined
        ? pageRecord([lineRecord(1), lineRecord(2)], { summary: { filtered: kpiRecord(2, 2, '840000000', '80000000'), scope: kpiRecord(2, 2, '840000000', '80000000'), is_filtered: false } })
        : pageRecord([lineRecord(1)], { summary: { filtered: kpiRecord(1, 1, '420000000', '40000000'), scope: kpiRecord(2, 2, '840000000', '80000000'), is_filtered: true } });
    const h = open({ page: filtered });
    await screen.findByTestId('kpis');
    expect(screen.getByTestId('kpi-filtered').querySelector('h2')?.textContent).toBe(vi_['dis.reports.kpi.scope.title']);
    expect(screen.queryByTestId('kpi-scope')).toBeNull();
    expect(text('kpi-filtered-counts')).toBe(vi_['dis.reports.kpi.counts'].replace('{reports}', '2').replace('{projects}', '2'));
    expect(text('kpi-filtered-money')).toBe(vi_['dis.reports.kpi.money'].replace('{amount}', '840.000.000').replace('{ctmtqg}', '80.000.000'));
    await user.selectOptions(screen.getByLabelText(vi_['dis.reports.filter.project.label']), PROJECT);
    await waitFor(() => expect(screen.getByTestId('kpi-filtered').querySelector('h2')?.textContent).toBe(vi_['dis.reports.kpi.filtered.title']));
    expect(text('kpi-filtered-counts')).toBe(vi_['dis.reports.kpi.counts'].replace('{reports}', '1').replace('{projects}', '1'));
    expect(text('kpi-filtered-money')).toContain('420.000.000');
    expect(screen.getByTestId('kpi-scope').querySelector('h2')?.textContent).toBe(vi_['dis.reports.kpi.scope.title']);
    expect(text('kpi-scope-counts')).toBe(vi_['dis.reports.kpi.counts'].replace('{reports}', '2').replace('{projects}', '2'));
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

  it('does not offer the filter by plan when the caller may read none', async () => {
    open({ plans: [] });
    await screen.findByTestId('kpis');
    expect(screen.queryByLabelText(vi_['dis.reports.filter.plan.label'])).toBeNull();
  });

  it('goes from page to page by the cursor the server gave, and back', async () => {
    const user = userEvent.setup();
    const pages = (query: Record<string, unknown>) =>
      query.cursor === 'second' ? pageRecord([lineRecord(3)], { next_cursor: null }) : pageRecord([lineRecord(1), lineRecord(2)], { next_cursor: 'second' });
    const h = open({ page: pages });
    await screen.findByTestId('kpis');
    // The page is shown again when another is read, so the buttons are looked for each time.
    const pager = (): [HTMLButtonElement, HTMLButtonElement] => within(screen.getByTestId('pager')).getAllByRole('button') as [HTMLButtonElement, HTMLButtonElement];
    expect(pager().map((button) => button.disabled)).toEqual([true, false]);
    await user.click(pager()[1]);
    await waitFor(() => expect(queryOfLastRead(h)).toMatchObject({ cursor: 'second' }));
    await screen.findByText('DA-2027-003');
    expect(pager().map((button) => button.disabled)).toEqual([false, true]);
    await user.click(pager()[0]);
    await screen.findByText('DA-2027-002');
    expect(pager().map((button) => button.disabled)).toEqual([true, false]);
  });

  it('says there is no report in words, and does not add up what is not there', async () => {
    open({ page: pageRecord([], { summary: { filtered: kpiRecord(0, 0, '0', '0'), scope: kpiRecord(0, 0, '0', '0'), is_filtered: false } }) });
    expect((await screen.findByTestId('no-reports')).textContent).toBe(vi_['dis.reports.empty.text']);
    expect(text('kpi-filtered-counts')).toBe(vi_['dis.reports.kpi.counts'].replace('{reports}', '0').replace('{projects}', '0'));
  });

  it('shows the figures only when the server gave them', async () => {
    open({ page: { items: [lineRecord(1)], next_cursor: null } });
    await screen.findByText('DA-2027-001');
    expect(screen.queryByTestId('kpis')).toBeNull();
  });

  it('offers the start of a report to a maker, and to nobody else', async () => {
    open();
    expect((await screen.findByRole('link', { name: vi_['dis.reports.create.action'] })).getAttribute('href')).toBe('/dis/dis-02');
    cleanup();
    open({}, READER);
    await screen.findByTestId('kpis');
    expect(screen.queryByRole('link', { name: vi_['dis.reports.create.action'] })).toBeNull();
    cleanup();
    open({}, MAKER, 'READ_ONLY');
    await screen.findByTestId('kpis');
    expect(screen.queryByRole('link', { name: vi_['dis.reports.create.action'] })).toBeNull();
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

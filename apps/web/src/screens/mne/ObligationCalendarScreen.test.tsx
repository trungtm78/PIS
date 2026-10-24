import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ObligationCalendarScreen from './ObligationCalendarScreen';
import { vietnamToday } from './model';
import { PLANNER, READER, harness, mount, obligationRow, routeOf } from './test-support';

const ROUTE = routeOf('MNE-01', 'FR-MNE-01');
const YEAR = Number(vietnamToday().slice(0, 4));

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const YEARLY = { period_label: 'YEAR-2026', due_date: '2027-02-10', form_code: 'TT44-M03', form_title: 'Báo cáo tổng thể năm', rule_code: 'OVERALL_ANNUAL', legal_basis: 'Thông tư 44/2026/TT-BTC, báo cáo năm [CXN-10]' };
const ROWS = [
  obligationRow(1),
  obligationRow(2, { is_late: true, days_late: 5 }),
  obligationRow(3, { status: 'SUBMITTED_EXTERNAL', is_late: true, days_late: null }),
  obligationRow(4, { reporting_role: 'PROVINCIAL_PEOPLE_COMMITTEE', recipient: 'Bộ Tài chính', awaiting_confirmation: false, cxn_refs: [] }),
  obligationRow(5, YEARLY),
];

const page = (items: unknown[], cursor: string | null = null) => ({ items, next_cursor: cursor, as_of: '2026-10-24' });
const answer = (reply: unknown) => (operation: string) => (operation === 'listMneObligations' ? reply : new Error(`unexpected read ${operation}`));
const lastQuery = (h: ReturnType<typeof harness>): Record<string, unknown> | undefined => (h.read.mock.calls.at(-1)?.[1] as { query?: Record<string, unknown> } | undefined)?.query;

afterEach(cleanup);

describe('MNE-01 obligation calendar (ST-MNE-001, MNE F2, BR-MNE-02, BR-MNE-03)', () => {
  it('AC-ST-MNE-001-3: shows form, level, due date, recipient and the CXN label of every obligation, by the month of its due date', async () => {
    mount(<ObligationCalendarScreen route={ROUTE} />, harness(answer(page(ROWS))), { permissions: READER });
    expect(await screen.findByText('CDT-1')).toBeTruthy();
    expect(screen.getByRole('heading', { name: vi_['mne.calendar.page.title'] })).toBeTruthy();
    // The months of the due dates, in the order of the calendar.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual([fill(vi_['mne.calendar.month.heading'], { month: '07', year: '2026' }), fill(vi_['mne.calendar.month.heading'], { month: '02', year: '2027' })]);
    const first = document.querySelector(`tr[data-report-id="${(ROWS[0] as { mne_report_id: string }).mne_report_id}"]`) as HTMLElement;
    const row = within(first);
    expect(row.getByText('TT44-M02')).toBeTruthy();
    expect(row.getByText('Báo cáo giám sát, đánh giá tổng thể 6 tháng')).toBeTruthy();
    expect(row.getByText(vi_['mne.calendar.role.investor'])).toBeTruthy();
    expect(row.getByText('Chủ đầu tư 1')).toBeTruthy();
    expect(row.getByText('H1-2026')).toBeTruthy();
    expect(row.getByText('2026-07-10')).toBeTruthy();
    expect(row.getByText('Cơ quan chủ quản')).toBeTruthy();
    expect(row.getByText('Thông tư 44/2026/TT-BTC, báo cáo trước ngày 10 tháng 7 [CXN-10]')).toBeTruthy();
    expect(row.getByText(fill(vi_['mne.forms.confirmation.pending'], { tags: '[CXN-10]' }))).toBeTruthy();
    expect(row.getByText(vi_['mne.calendar.status.draft'])).toBeTruthy();
    const yearly = within(document.querySelector('tr[data-due-date="2027-02-10"]') as HTMLElement);
    expect(yearly.getByText('YEAR-2026')).toBeTruthy();
    expect(yearly.getByText('TT44-M03')).toBeTruthy();
  });

  it('shows a confirmed obligation as confirmed, and the level of the committee', async () => {
    mount(<ObligationCalendarScreen route={ROUTE} />, harness(answer(page(ROWS))), { permissions: READER });
    await screen.findByText('CDT-4');
    const row = within(document.querySelector(`tr[data-report-id="${(ROWS[3] as { mne_report_id: string }).mne_report_id}"]`) as HTMLElement);
    expect(row.getByText(vi_['mne.calendar.role.provincialPeopleCommittee'])).toBeTruthy();
    expect(row.getByText('Bộ Tài chính')).toBeTruthy();
    expect(row.getByText(vi_['mne.forms.confirmation.confirmed'])).toBeTruthy();
    expect(row.queryByText(fill(vi_['mne.forms.confirmation.pending'], { tags: '[CXN]' }))).toBeNull();
  });

  it('says how late a report is with a text and a count, never with a colour alone', async () => {
    mount(<ObligationCalendarScreen route={ROUTE} />, harness(answer(page(ROWS))), { permissions: READER });
    await screen.findByText('CDT-2');
    const late = within(document.querySelector(`tr[data-report-id="${(ROWS[1] as { mne_report_id: string }).mne_report_id}"]`) as HTMLElement);
    expect(late.getByText(fill(vi_['mne.calendar.late.text'], { days: 5 }))).toBeTruthy();
    const filed = within(document.querySelector(`tr[data-report-id="${(ROWS[2] as { mne_report_id: string }).mne_report_id}"]`) as HTMLElement);
    expect(filed.getByText(vi_['mne.calendar.status.submittedExternal'])).toBeTruthy();
    expect(filed.getByText(vi_['mne.calendar.late.unknown'])).toBeTruthy();
    expect(within(document.querySelector(`tr[data-report-id="${(ROWS[0] as { mne_report_id: string }).mne_report_id}"]`) as HTMLElement).queryByText(/Trễ|Nộp trễ/)).toBeNull();
    expect(screen.getByTestId('count').textContent).toBe(fill(vi_['mne.calendar.count.text'], { total: 5, late: 1 }));
  });

  describe('the filters', () => {
    it('reads the obligations of the current year first, then the year and the status the person chose', async () => {
      const user = userEvent.setup();
      const h = harness(answer(page(ROWS)));
      mount(<ObligationCalendarScreen route={ROUTE} />, h, { permissions: READER });
      await screen.findByText('CDT-1');
      expect(lastQuery(h)).toEqual({ report_year: String(YEAR), limit: 100 });
      await user.selectOptions(screen.getByLabelText(vi_['mne.calendar.filter.year.label']), String(YEAR + 1));
      await waitFor(() => expect(lastQuery(h)).toEqual({ report_year: String(YEAR + 1), limit: 100 }));
      await user.selectOptions(screen.getByLabelText(vi_['mne.calendar.filter.status.label']), 'APPROVED');
      await waitFor(() => expect(lastQuery(h)).toEqual({ report_year: String(YEAR + 1), limit: 100, status: 'APPROVED' }));
    });

    it('loads the next page with the cursor of the last one', async () => {
      const user = userEvent.setup();
      const h = harness((operation, input) => {
        if (operation !== 'listMneObligations') return new Error('unexpected read');
        const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
        return cursor === undefined ? page(ROWS.slice(0, 2), 'next-page') : page(ROWS.slice(2));
      });
      mount(<ObligationCalendarScreen route={ROUTE} />, h, { permissions: READER });
      await screen.findByText('CDT-2');
      expect(screen.queryByText('CDT-4')).toBeNull();
      await user.click(screen.getByRole('button', { name: vi_['mne.calendar.more.action'] }));
      expect(await screen.findByText('CDT-4')).toBeTruthy();
      expect(lastQuery(h)).toMatchObject({ cursor: 'next-page' });
      expect(screen.queryByRole('button', { name: vi_['mne.calendar.more.action'] })).toBeNull();
    });
  });

  describe('generating the obligations of a year', () => {
    const generate = async (year: string, h: ReturnType<typeof harness>, permissions: readonly string[] = PLANNER) => {
      const user = userEvent.setup();
      mount(<ObligationCalendarScreen route={ROUTE} />, h, { permissions });
      await screen.findByText('CDT-1');
      const form = screen.getByRole('form', { name: vi_['mne.calendar.generate.title'] });
      const input = within(form).getByLabelText(vi_['mne.calendar.generate.year.label']);
      await user.clear(input);
      if (year !== '') await user.type(input, year);
      await user.click(within(form).getByRole('button', { name: vi_['mne.calendar.generate.action'] }));
      return { user, form };
    };

    it('offers the generation to whoever manages the calendar, with the year shown, and to nobody else', async () => {
      mount(<ObligationCalendarScreen route={ROUTE} />, harness(answer(page(ROWS))), { permissions: PLANNER });
      await screen.findByText('CDT-1');
      expect((screen.getByLabelText(vi_['mne.calendar.generate.year.label']) as HTMLInputElement).value).toBe(String(YEAR));
      cleanup();
      mount(<ObligationCalendarScreen route={ROUTE} />, harness(answer(page(ROWS))), { permissions: READER });
      await screen.findByText('CDT-1');
      expect(screen.queryByRole('form', { name: vi_['mne.calendar.generate.title'] })).toBeNull();
    });

    it('offers nothing on a suspended tenant', async () => {
      mount(<ObligationCalendarScreen route={ROUTE} />, harness(answer(page(ROWS))), { permissions: PLANNER, mode: 'READ_ONLY' });
      await screen.findByText('CDT-1');
      expect(screen.queryByRole('form', { name: vi_['mne.calendar.generate.title'] })).toBeNull();
      expect(screen.getByText(vi_['mne.calendar.frozen.notice'])).toBeTruthy();
    });

    it('AC-ST-MNE-001-1: sends the year, says how many obligations it made and how many existed, and reads the calendar again', async () => {
      let reads = 0;
      const h = harness(
        (operation) => {
          reads += 1;
          return operation === 'listMneObligations' ? page(ROWS) : new Error('unexpected read');
        },
        () => ({ created: 6, existing: 0, periods: 2, unresolved_roles: [] }),
      );
      await generate('2026', h);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('generateMneObligations', expect.objectContaining({ body: { report_year: 2026 } }));
      expect((await screen.findByTestId('generated')).textContent).toBe(fill(vi_['mne.calendar.generate.done.notice'], { created: 6, existing: 0 }));
      expect(screen.queryByTestId('unresolved')).toBeNull();
      expect(reads).toBeGreaterThanOrEqual(2);
    });

    it('AC-ST-MNE-001-1: a second run says that nothing was added', async () => {
      const h = harness(answer(page(ROWS)), () => ({ created: 0, existing: 6, periods: 2, unresolved_roles: [] }));
      await generate('2026', h);
      expect((await screen.findByTestId('generated')).textContent).toBe(fill(vi_['mne.calendar.generate.done.notice'], { created: 0, existing: 6 }));
    });

    it('warns about the role that no unit holds, by its name', async () => {
      const h = harness(answer(page(ROWS)), () => ({ created: 0, existing: 0, periods: 1, unresolved_roles: ['PLANNING_AGENCY'] }));
      await generate('2026', h);
      expect((await screen.findByTestId('unresolved')).textContent).toBe(fill(vi_['mne.calendar.generate.unresolved.warning'], { roles: vi_['mne.calendar.role.planningAgency'] }));
    });

    it.each(['', '26', '1999', '3000', 'abcd'])('refuses the year "%s" before anything is sent', async (year) => {
      const h = harness(answer(page(ROWS)));
      const { form } = await generate(year, h);
      expect(within(form).getByText(vi_['mne.calendar.generate.year.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it.each([
      ['NO_EFFECTIVE_RULE', 422, vi_['mne.calendar.problem.noRule.text']],
      ['FORM_NOT_EFFECTIVE', 422, vi_['mne.calendar.problem.formNotEffective.text']],
      ['CALENDAR_NOT_EFFECTIVE', 422, vi_['mne.calendar.problem.calendar.text']],
      ['SCOPE_DENIED', 403, vi_['mne.calendar.problem.scopeDenied.text']],
      ['VALIDATION_FAILED', 422, vi_['mne.calendar.problem.invalid.text']],
      ['SESSION_EXPIRED', 401, vi_['mne.calendar.problem.session.text']],
      ['INTERNAL_ERROR', 500, vi_['mne.calendar.problem.general.text']],
    ])('tells the person why when the server answers %s', async (code, status, message) => {
      const h = harness(answer(page(ROWS)), () => new ApiError({ status, code, correlationId: 'c' }));
      const { form } = await generate('2026', h);
      expect((await within(form).findByRole('alert')).textContent).toBe(message);
      expect(screen.queryByTestId('generated')).toBeNull();
    });

    it('forgets the result of a run when the year is written over', async () => {
      const h = harness(answer(page(ROWS)), () => ({ created: 6, existing: 0, periods: 2, unresolved_roles: [] }));
      const { form } = await generate('2026', h);
      await screen.findByTestId('generated');
      fireEvent.change(within(form).getByLabelText(vi_['mne.calendar.generate.year.label']), { target: { value: '2027' } });
      expect(screen.queryByTestId('generated')).toBeNull();
    });
  });

  describe('AC-ST-MNE-001-3: the seven standard states', () => {
    it.each([
      ['empty', page([]), vi_['states.empty.title']],
      ['denied', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
      ['signed out', new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
    ])('AC-ST-MNE-001-3: UI-MNE-01 shows the %s state and keeps the filters', async (_name, reply, title) => {
      mount(<ObligationCalendarScreen route={ROUTE} />, harness(answer(reply)), { permissions: PLANNER });
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByLabelText(vi_['mne.calendar.filter.year.label'])).toBeTruthy();
      // A year without obligations is where the generation starts: it stays reachable in every state that shows the filters.
      expect(screen.getByRole('form', { name: vi_['mne.calendar.generate.title'] })).toBeTruthy();
    });

    it('AC-ST-MNE-001-3: UI-MNE-01 shows the loading state first and names the page for assistive technology', () => {
      mount(<ObligationCalendarScreen route={ROUTE} />, harness(() => new Promise(() => undefined)));
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['mne.calendar.page.title'] })).toBeTruthy();
    });

    it('AC-ST-MNE-001-3: UI-MNE-01 shows the default state with every field and every action named for assistive technology', async () => {
      mount(<ObligationCalendarScreen route={ROUTE} />, harness(answer(page(ROWS, 'more'))), { permissions: PLANNER });
      await screen.findByText('CDT-1');
      for (const control of screen.getAllByRole('combobox')) expect((control as HTMLSelectElement).labels?.length).toBeGreaterThan(0);
      for (const action of screen.getAllByRole('button')) expect((action.getAttribute('aria-label') ?? action.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(screen.getAllByRole('table').length).toBe(2);
      expect(screen.getAllByRole('columnheader').length).toBe(16);
    });

    it('AC-ST-MNE-001-3: UI-MNE-01 retries the read after an error', async () => {
      let failing = true;
      const h = harness(() => (failing ? new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) : page(ROWS)));
      mount(<ObligationCalendarScreen route={ROUTE} />, h);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByText('CDT-1')).toBeTruthy();
    });
  });
});

import { ApiError } from '@machvon/api-client';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import { routeOf } from '../doc/test-support';
import { SECOND_TENANT, harness, mountInSession } from './security/test-support';
import { WorkCalendarWorkspace } from './WorkCalendarWorkspace';
import { toCalendar } from './calendar/model';
import type { CalendarView } from './calendar/model';

// Twelve month grids are drawn for the year in view, and the machine is shared and busy under coverage: a test may take tens of seconds.
vi.setConfig({ testTimeout: 90_000 });
configure({ asyncUtilTimeout: 10_000 });

const ROUTE = routeOf('ADM-07', 'FR-ADM-07');
const MANAGER = ['adm.calendar.manage'];
const READER = ['adm.security.read'];
const CODE = 'WORKDAY_VN';

const tx = (key: string, params?: Record<string, string | number>): string => translator.t(key, params);

const raw = (id: string, year: number, revision: number, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  calendar_code: CODE,
  year,
  revision,
  working_days: [1, 2, 3, 4, 5],
  holidays: [{ date: `${year}-04-30`, name: 'Reunification Day' }, { date: `${year}-05-01`, name: 'Labour Day', legal_basis_ref: 'Labour Code 2019 art. 112' }],
  compensated_workdays: [`${year}-05-09`],
  legal_basis_ref: 'Labour Code 2019 art. 112; notice of the year',
  status,
  created_by: 'u1',
  published_by: status === 'Draft' ? null : 'u2',
  published_at: status === 'Draft' ? null : '2026-04-01T00:00:00Z',
  version: status === 'Draft' ? 1 : 2,
  ...extra,
});

// 2026: revision 1 confirmed, revision 2 a draft on top of it; 2027: a draft only; 2028: nothing.
const VERSIONS: CalendarView[] = [raw('c3', 2027, 1, 'Draft'), raw('c2', 2026, 2, 'Draft'), raw('c1', 2026, 1, 'Published')].flatMap((row) => toCalendar(row) ?? []);
const CONFIRMED_ONLY: CalendarView[] = [raw('c1', 2026, 1, 'Published')].flatMap((row) => toCalendar(row) ?? []);

const mount = (versions: readonly CalendarView[] = VERSIONS, options: Parameters<typeof mountInSession>[2] = { permissions: MANAGER }, h = harness(() => new Error('no read'))) => {
  const view = mountInSession(<WorkCalendarWorkspace route={ROUTE} versions={versions} />, h, options);
  return { h, view };
};
const editor = (): HTMLElement => screen.getByTestId('year-editor');
const yearRow = (year: number): HTMLElement => document.querySelector(`[data-testid="years"] tr[data-year="${year}"]`) as HTMLElement;
const dayInGrid = (date: string): HTMLElement => screen.getByTestId('month-grids').querySelector(`[data-date="${date}"]`) as HTMLElement;
const saveButton = (): HTMLButtonElement => screen.getByRole('button', { name: tx('wfxcal.save.action') }) as HTMLButtonElement;
const confirmButton = (): HTMLButtonElement => screen.getByRole('button', { name: tx('wfxcal.confirm.action') }) as HTMLButtonElement;
const openYear = async (user: ReturnType<typeof userEvent.setup>, year: number): Promise<void> => {
  await user.click(within(yearRow(year)).getByRole('button'));
};
const addDays = (kind: 'off' | 'work', from: string, to: string, note = '') => {
  fireEvent.change(screen.getByLabelText(tx('wfxcal.add.kind.label')), { target: { value: kind } });
  fireEvent.change(screen.getByLabelText(tx('wfxcal.add.from.label')), { target: { value: from } });
  fireEvent.change(screen.getByLabelText(tx('wfxcal.add.to.label')), { target: { value: to } });
  if (note !== '') fireEvent.change(screen.getByLabelText(tx('wfxcal.add.note.label')), { target: { value: note } });
  fireEvent.click(screen.getByRole('button', { name: tx('wfxcal.add.action') }));
};

beforeEach(() => {
  // "This year" is 2026 whatever day the test runs on.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-15T05:00:00Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  translator.setLocale('vi');
});

describe('WorkCalendarWorkspace (ADM-07): the yearly work calendar', () => {
  it('lists the years with their state: confirmed, draft, and a year with no calendar yet', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(tx('wfxcal.page.title'));
    const rows = [...document.querySelectorAll('[data-testid="years"] tr[data-year]')].map((row) => row.getAttribute('data-year'));
    expect(rows).toEqual(['2028', '2027', '2026', '2025']);
    expect(within(yearRow(2026)).getByText(tx('wfxcal.state.confirmedRev.label', { revision: 1 }))).toBeTruthy();
    expect(within(yearRow(2026)).getByText(tx('wfxcal.state.draftRev.label', { revision: 2 }))).toBeTruthy();
    expect(within(yearRow(2027)).getByText(tx('wfxcal.state.draftRev.label', { revision: 1 }))).toBeTruthy();
    expect(within(yearRow(2028)).getByText(tx('wfxcal.state.none.label'))).toBeTruthy();
  });

  it('opens the current year on its draft, with the twelve months and the working days of each month', () => {
    mount();
    expect(editor().getAttribute('data-year')).toBe('2026');
    expect(screen.getByRole('heading', { name: tx('wfxcal.year.title', { year: 2026 }) })).toBeTruthy();
    const grids = screen.getByTestId('month-grids');
    expect(grids.querySelectorAll('table.cal-month')).toHaveLength(12);
    // May 2026: 21 weekdays, less the 1st, plus the compensated Saturday the 9th.
    expect(within(grids.querySelector('table[data-month="5"]') as HTMLElement).getByText(tx('wfxcal.month.count.label', { count: 21 }))).toBeTruthy();
    expect(dayInGrid('2026-05-09').getAttribute('data-kind')).toBe('compensated');
    expect(dayInGrid('2026-05-01').getAttribute('data-kind')).toBe('holiday');
    expect(dayInGrid('2026-05-02').getAttribute('data-kind')).toBe('off');
    expect(screen.getByTestId('year-count').textContent).toBe(tx('adm.calendar.summary.workingDays', { count: 260 }));
    // The days of the grid are only shown: nothing in it is a button.
    expect(grids.querySelectorAll('button')).toHaveLength(0);
  });

  it('warns that a year without a confirmed calendar is provisional for the chart of a template and not for a real deadline (R66, R74)', async () => {
    mount();
    const user = userEvent.setup({ delay: null });
    // 2026 has a confirmed revision: no warning. 2027 has only a draft: the warning, in the words of the decision.
    expect(screen.queryByTestId('provisional-note')).toBeNull();
    await openYear(user, 2027);
    expect(screen.getByTestId('provisional-note').textContent).toBe('Năm chưa xác nhận: sơ đồ của mẫu tạm tính theo lịch nháp; hạn thật của dự án chỉ tính từ năm đã xác nhận.');
  });

  it('shows a calendar for a year with no version as a blank page to fill in, with the default code', async () => {
    mount();
    const user = userEvent.setup({ delay: null });
    await openYear(user, 2028);
    expect((screen.getByLabelText(tx('adm.calendar.code.label')) as HTMLInputElement).value).toBe(CODE);
    expect(screen.getByTestId('special-days').textContent).toContain(tx('wfxcal.special.empty'));
    expect(screen.getByTestId('year-count').textContent).toBe(tx('adm.calendar.summary.workingDays', { count: 260 }));
  });

  it('starts another year from the number the person types, and refuses one outside 2020 to 2100', async () => {
    mount();
    const user = userEvent.setup({ delay: null });
    const box = screen.getByLabelText(tx('wfxcal.years.other.label'));
    await user.type(box, '1999');
    await user.click(screen.getByRole('button', { name: tx('wfxcal.years.other.action') }));
    expect(await screen.findByText(tx('adm.calendar.field.range'))).toBeTruthy();
    await user.clear(box);
    await user.type(box, '2031');
    await user.click(screen.getByRole('button', { name: tx('wfxcal.years.other.action') }));
    expect(editor().getAttribute('data-year')).toBe('2031');
  });

  it('ticks the weekly rest days: a Friday made a rest day turns every Friday off in the preview', async () => {
    mount();
    const user = userEvent.setup({ delay: null });
    await openYear(user, 2028);
    expect(dayInGrid('2028-05-05').getAttribute('data-kind')).toBe('working');
    const week = within(screen.getByRole('group', { name: tx('wfxcal.rest.legend') }));
    await user.click(week.getAllByRole('checkbox')[4] as HTMLElement);
    expect(dayInGrid('2028-05-05').getAttribute('data-kind')).toBe('off');
    expect(screen.getByTestId('year-count').textContent).not.toBe(tx('adm.calendar.summary.workingDays', { count: 260 }));
  });

  it('adds a range of days off with a note, lists it as one row under its month, and takes it out again', async () => {
    mount();
    const user = userEvent.setup({ delay: null });
    await openYear(user, 2028);
    addDays('off', '2028-01-24', '2028-01-28', 'Tết Nguyên đán');
    expect(screen.getByTestId('add-done').textContent).toBe(tx('wfxcal.add.done.status', { count: 5 }));
    const table = screen.getByTestId('special-table');
    const rows = table.querySelectorAll('tr[data-special]');
    expect(rows).toHaveLength(1);
    expect(table.querySelector('tbody[data-month="1"]')).not.toBeNull();
    expect(within(rows[0] as HTMLElement).getByDisplayValue('Tết Nguyên đán')).toBeTruthy();
    expect(dayInGrid('2028-01-26').getAttribute('data-kind')).toBe('holiday');
    await user.click(within(rows[0] as HTMLElement).getByRole('button', { name: /^Bỏ / }));
    expect(screen.queryByTestId('special-table')).toBeNull();
    expect(dayInGrid('2028-01-26').getAttribute('data-kind')).toBe('working');
  });

  it('adds a make-up working day only on a rest day, says what it skipped, and keeps no note for it', async () => {
    mount();
    const user = userEvent.setup({ delay: null });
    await openYear(user, 2028);
    // 2028-02-04 is a Friday (working), 02-05 a Saturday, 02-06 a Sunday.
    addDays('work', '2028-02-04', '2028-02-06');
    expect(screen.getByTestId('add-done').textContent).toBe(tx('wfxcal.add.doneSkipped.status', { count: 2, skipped: 1 }));
    const row = screen.getByTestId('special-table').querySelector('tr[data-special][data-kind="work"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelectorAll('input')).toHaveLength(0);
    expect(dayInGrid('2028-02-05').getAttribute('data-kind')).toBe('compensated');
  });

  it('refuses days the form can see are wrong before it adds anything', async () => {
    mount();
    const user = userEvent.setup({ delay: null });
    await openYear(user, 2028);
    addDays('off', '', '');
    expect(screen.getByTestId('add-problem').textContent).toBe(tx('wfxcal.add.dateRequired.error'));
    addDays('off', '2028-02-09', '2028-02-05', 'x');
    expect(screen.getByTestId('add-problem').textContent).toBe(tx('wfxcal.add.rangeOrder.error'));
    addDays('off', '2029-01-01', '', 'x');
    expect(screen.getByTestId('add-problem').textContent).toBe(tx('wfxcal.add.outOfYear.error'));
    addDays('off', '2028-02-05', '', ' ');
    expect(screen.getByTestId('add-problem').textContent).toBe(tx('wfxcal.add.nameRequired.error'));
    expect(screen.queryByTestId('special-table')).toBeNull();
  });

  it('writes the calendar as a draft in date order, once, and saves it again only after an edit', async () => {
    const { h } = mount([], { permissions: MANAGER }, harness(() => new Error('no read'), () => ({ status: 'DRAFTED', resource_version: 1, resource_id: 'c9' })));
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByLabelText(tx('adm.calendar.basis.label')), 'Labour Code 2019 art. 112');
    addDays('off', '2026-09-02', '', 'National Day');
    addDays('off', '2026-05-01', '', 'Labour Day');
    addDays('work', '2026-05-09', '');
    await user.click(saveButton());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('createWorkCalendarVersion');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({
      body: {
        calendar_code: CODE,
        year: 2026,
        working_days: [1, 2, 3, 4, 5],
        holidays: [{ date: '2026-05-01', name: 'Labour Day' }, { date: '2026-09-02', name: 'National Day' }],
        compensated_workdays: ['2026-05-09'],
        legal_basis_ref: 'Labour Code 2019 art. 112',
      },
    });
    expect(await screen.findByText(tx('wfxcal.save.accepted.notice'))).toBeTruthy();
    // The same text is not saved again; an edit makes it another revision.
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(h.command).toHaveBeenCalledTimes(1);
    const row = screen.getByTestId('special-table').querySelector('tr[data-special="off:2026-05-01"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /^Bỏ / }));
    expect(saveButton().disabled).toBe(false);
  });

  it('asks for the legal basis and the name of every holiday, and refuses a make-up day that clashes, before it saves', async () => {
    const { h } = mount([]);
    const user = userEvent.setup({ delay: null });
    await user.click(saveButton());
    expect(await screen.findByText(tx('adm.calendar.field.required'))).toBeTruthy();
    await user.type(screen.getByLabelText(tx('adm.calendar.basis.label')), 'Labour Code');
    // Make Saturday a working day: a make-up day on a Saturday is now a clash.
    addDays('work', '2026-05-09', '');
    await user.click(within(screen.getByRole('group', { name: tx('wfxcal.rest.legend') })).getAllByRole('checkbox')[5] as HTMLElement);
    await user.click(saveButton());
    expect(await screen.findByText(tx('wfxcal.field.compensatedConflict.error'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('refuses a calendar with no working weekday', async () => {
    const { h } = mount([]);
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByLabelText(tx('adm.calendar.basis.label')), 'Labour Code');
    for (const box of within(screen.getByRole('group', { name: tx('wfxcal.rest.legend') })).getAllByRole('checkbox')) {
      if (!(box as HTMLInputElement).checked) await user.click(box);
    }
    await user.click(saveButton());
    expect(await screen.findAllByText(tx('adm.calendar.field.required'))).not.toHaveLength(0);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('lists every finding of a calendar the server refused with 422 CALENDAR_INVALID', async () => {
    const errors = [
      { field: 'holidays[1]', code: 'OUT_OF_YEAR' },
      { field: 'holidays[2]', code: 'DATE_INVALID' },
      { field: 'working_days', code: 'NO_WORKING_DAYS' },
      { field: 'compensated_workdays[0]', code: 'COMPENSATED_ON_HOLIDAY' },
      { field: 'x', code: 'SOMETHING_NEW' },
    ];
    const { h } = mount([], { permissions: MANAGER }, harness(() => new Error('no read'), () => new ApiError({ status: 422, code: 'CALENDAR_INVALID', correlationId: 'c', detail: 'holidays[1]', extensions: { errors } })));
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByLabelText(tx('adm.calendar.basis.label')), 'Labour Code');
    await user.click(saveButton());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const refusal = (await screen.findByText(tx('adm.calendar.error.outOfYear', { field: 'holidays[1]' }))).closest('[role="alert"]') as HTMLElement;
    expect(within(refusal).getByText(tx('adm.calendar.problem.calendarInvalid'), { selector: 'p' })).toBeTruthy();
    expect(within(refusal).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      tx('adm.calendar.error.outOfYear', { field: 'holidays[1]' }),
      tx('adm.calendar.error.dateInvalid', { field: 'holidays[2]' }),
      tx('adm.calendar.error.noWorkingDays'),
      tx('adm.calendar.error.compensatedOnHoliday', { field: 'compensated_workdays[0]' }),
      // A code this screen has no sentence for says only that the calendar is invalid.
      tx('adm.calendar.problem.calendarInvalid'),
    ]);
  });
});

describe('the preset of the public holidays', () => {
  it('fills the statutory holidays as an editable draft, says the list is not verified, and calls nothing on the server', async () => {
    const { h } = mount();
    const user = userEvent.setup({ delay: null });
    await openYear(user, 2028);
    await user.click(screen.getByRole('button', { name: tx('wfxcal.preset.action') }));
    const note = screen.getByTestId('preset-note');
    expect(within(note).getByText(tx('wfxcal.preset.unverified.label'))).toBeTruthy();
    expect(note.textContent).toContain('Điều 112');
    expect(h.command).not.toHaveBeenCalled();
    const table = screen.getByTestId('special-table');
    expect(table.querySelectorAll('tbody[data-month]').length).toBeGreaterThanOrEqual(4);
    expect(within(table).getAllByDisplayValue('Tết Nguyên đán').length).toBeGreaterThanOrEqual(1);
    expect((screen.getByLabelText(tx('adm.calendar.basis.label')) as HTMLInputElement).value).toContain('chưa kiểm chứng');
    // It is a draft the person edits: rename one holiday and the table keeps the edit.
    const first = table.querySelector('tr[data-special="off:2028-01-01"]') as HTMLElement;
    const name = within(first).getByDisplayValue('Tết Dương lịch');
    await user.clear(name);
    await user.type(name, 'Tết Dương lịch (đã sửa)');
    expect(within(table).getByDisplayValue('Tết Dương lịch (đã sửa)')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
  });

  it('names the holidays it has no day for in a year its catalogue does not list', async () => {
    mount();
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByLabelText(tx('wfxcal.years.other.label')), '2040');
    await user.click(screen.getByRole('button', { name: tx('wfxcal.years.other.action') }));
    await user.click(screen.getByRole('button', { name: tx('wfxcal.preset.action') }));
    expect(screen.getByTestId('preset-note').textContent).toContain('Tết Nguyên đán, Giỗ Tổ Hùng Vương');
  });

  it('is not offered to a reader', () => {
    mount(VERSIONS, { permissions: READER });
    expect(screen.queryByRole('button', { name: tx('wfxcal.preset.action') })).toBeNull();
  });
});

describe('confirming a year', () => {
  it('confirms the saved draft with a reason and the version of the draft, after showing what it marks', async () => {
    const { h } = mount(VERSIONS, { permissions: MANAGER }, harness(() => new Error('no read'), () => ({ status: 'PUBLISHED', resource_version: 2, resource_id: 'c2' })));
    const user = userEvent.setup({ delay: null });
    expect(confirmButton().disabled).toBe(false);
    await user.click(confirmButton());
    const preview = screen.getByTestId('confirm-preview');
    expect(preview.textContent).toContain(`${CODE} 2026 #2`);
    expect(preview.textContent).toContain('260');
    expect(screen.getByTestId('confirm-panel').textContent).toContain(tx('wfxcal.confirm.impact.note', { year: 2026 }));
    await user.click(screen.getByRole('button', { name: tx('wfxcal.confirm.submit.action') }));
    expect(await screen.findByText(tx('adm.calendar.field.required'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(tx('wfxcal.confirm.reason.label')), 'The notice is signed');
    await user.click(screen.getByRole('button', { name: tx('wfxcal.confirm.submit.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('publishWorkCalendar');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { calendarId: 'c2' }, ifMatchVersion: 1, body: { reason: 'The notice is signed' } });
    expect(screen.queryByTestId('confirm-panel')).toBeNull();
  });

  it('cannot confirm what is not saved: an edited form has no draft to confirm until it is saved', () => {
    mount();
    expect(confirmButton().disabled).toBe(false);
    addDays('off', '2026-12-25', '', 'Noel');
    expect(confirmButton().disabled).toBe(true);
    expect(confirmButton().getAttribute('title')).toBe(tx('wfxcal.confirm.needsSave.hint'));
    expect(screen.getByText(tx('wfxcal.state.unsaved.label'))).toBeTruthy();
  });

  it('has nothing to confirm in a year that is already confirmed and has no newer draft', () => {
    mount(CONFIRMED_ONLY);
    expect(confirmButton().disabled).toBe(true);
    expect(screen.queryByTestId('provisional-note')).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it.each([
    ['VERSION_CONFLICT', 409, 'adm.calendar.problem.conflict'],
    ['STAGE_TRANSITION_DENIED', 409, 'adm.calendar.problem.stage'],
    ['RESOURCE_NOT_FOUND', 404, 'adm.calendar.problem.notFound'],
    ['SCOPE_DENIED', 403, 'adm.calendar.problem.denied'],
    ['SESSION_EXPIRED', 401, 'adm.calendar.problem.session'],
    ['VALIDATION_FAILED', 422, 'adm.calendar.problem.invalid'],
  ] as const)('shows what the server refused for a confirmation: %s', async (code, status, key) => {
    const { h } = mount(VERSIONS, { permissions: MANAGER }, harness(() => new Error('no read'), () => new ApiError({ status, code, correlationId: 'c' })));
    const user = userEvent.setup({ delay: null });
    await user.click(confirmButton());
    await user.type(screen.getByLabelText(tx('wfxcal.confirm.reason.label')), 'The notice is signed');
    await user.click(screen.getByRole('button', { name: tx('wfxcal.confirm.submit.action') }));
    expect(await screen.findByText(tx(key))).toBeTruthy();
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('closes the confirmation without sending anything', async () => {
    const { h } = mount();
    const user = userEvent.setup({ delay: null });
    await user.click(confirmButton());
    await user.click(screen.getByRole('button', { name: tx('wfxcal.confirm.cancel.action') }));
    expect(screen.queryByTestId('confirm-panel')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });
});

describe('the revisions of a year', () => {
  it('opens an older revision into the form, to write the next revision from it', async () => {
    mount();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId('year-versions').querySelector('summary') as HTMLElement);
    const older = document.querySelector('[data-testid="year-versions"] tr[data-calendar-id="c1"]') as HTMLElement;
    expect(within(older).getByText(tx('wfxcal.state.confirmed.label'))).toBeTruthy();
    expect(document.querySelector('[data-testid="year-versions"] tr[data-calendar-id="c2"]')).not.toBeNull();
    await user.click(within(older).getByRole('button', { name: tx('wfxcal.versions.open.label', { revision: 1 }) }));
    expect(screen.getByTestId('special-table').querySelector('tr[data-special="off:2026-05-01"]')).not.toBeNull();
    // Nothing is changed yet, so nothing is saved again.
    expect(saveButton().disabled).toBe(true);
  });
});

describe('who may change the calendar', () => {
  it('offers a reader the years and the preview without the actions of the form', () => {
    mount(VERSIONS, { permissions: READER });
    expect(screen.getByText(tx('wfxcal.readOnly.notice'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: tx('wfxcal.save.action') })).toBeNull();
    expect(screen.queryByRole('button', { name: tx('wfxcal.confirm.action') })).toBeNull();
    expect(screen.queryByLabelText(tx('wfxcal.years.other.label'))).toBeNull();
    expect(screen.getByTestId('month-grids').querySelectorAll('table.cal-month')).toHaveLength(12);
    const fields = editor().querySelectorAll('fieldset[disabled]');
    expect(fields.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('button', { name: /^Bỏ / })).toBeNull();
  });

  it('is read-only in a suspended tenant: no save, no confirmation, whatever the grants say', () => {
    mount(VERSIONS, { permissions: MANAGER, mode: 'READ_ONLY' });
    expect(screen.getByText(tx('wfxcal.frozen.notice'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: tx('wfxcal.save.action') })).toBeNull();
    expect(screen.queryByRole('button', { name: tx('wfxcal.confirm.action') })).toBeNull();
  });

  it('shows the form without permission checks while the permissions are not known yet', () => {
    mount(VERSIONS, { permissions: undefined });
    expect(saveButton()).toBeTruthy();
  });

  it('starts over when the person switches tenant: a form typed for one tenant is never saved into another', async () => {
    const h = harness(() => new Error('no read'));
    const { view } = mount([], { permissions: MANAGER }, h);
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByLabelText(tx('adm.calendar.basis.label')), 'typed for the first tenant');
    view.rerenderWith({ permissions: MANAGER, tenant: SECOND_TENANT });
    expect((screen.getByLabelText(tx('adm.calendar.basis.label')) as HTMLInputElement).value).toBe('');
    expect(h.command).not.toHaveBeenCalled();
  });

  it('stops a confirmation that was opened before the tenant was suspended', async () => {
    const h = harness(() => new Error('no read'), () => ({ status: 'PUBLISHED', resource_version: 2, resource_id: 'c2' }));
    const { view } = mount(VERSIONS, { permissions: MANAGER }, h);
    const user = userEvent.setup({ delay: null });
    await user.click(confirmButton());
    await user.type(screen.getByLabelText(tx('wfxcal.confirm.reason.label')), 'The notice is signed');
    view.rerenderWith({ permissions: MANAGER, mode: 'READ_ONLY' });
    expect(screen.queryByRole('button', { name: tx('wfxcal.confirm.submit.action') })).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });
});

describe('another calendar code', () => {
  it('names a calendar that is not the default one in the list, and starts from the code the tenant already has', () => {
    const others = [raw('o1', 2026, 1, 'Published', { calendar_code: 'VN-STD' })].flatMap((row) => toCalendar(row) ?? []);
    mount(others);
    expect(editor().getAttribute('data-code')).toBe('VN-STD');
    expect(screen.getByTestId('calendar-code').textContent).toBe(tx('wfxcal.code.read', { code: 'VN-STD' }));
  });

  it('speaks English when the locale is English', () => {
    translator.setLocale('en');
    mount([]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(tx('wfxcal.page.title'));
    expect(screen.getByTestId('provisional-note').textContent).toBe(tx('wfxcal.provisional.note'));
  });
});

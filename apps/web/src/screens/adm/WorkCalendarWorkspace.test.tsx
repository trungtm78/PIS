import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en_ from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { translator } from '../../i18n';
import { routeOf } from '../doc/test-support';
import { SECOND_TENANT, harness, mountInSession } from './security/test-support';
import { WorkCalendarWorkspace } from './WorkCalendarWorkspace';
import { toCalendar } from './calendar/model';
import type { CalendarView } from './calendar/model';

// Twelve month grids are drawn on every render and the machine is shared: a test may take longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('ADM-07', 'FR-ADM-07');
const MANAGER = ['adm.calendar.manage'];
const READER = ['adm.security.read'];

const raw = (id: string, year: number, revision: number, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  calendar_code: 'VN-STD',
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

const VERSIONS: CalendarView[] = [raw('c3', 2027, 1, 'Draft'), raw('c2', 2026, 2, 'Draft'), raw('c1', 2026, 1, 'Published')].flatMap((row) => toCalendar(row) ?? []);

const mount = (versions: readonly CalendarView[] = VERSIONS, options: Parameters<typeof mountInSession>[2] = { permissions: MANAGER }, h = harness(() => new Error('no read'))) => {
  const view = mountInSession(<WorkCalendarWorkspace route={ROUTE} versions={versions} />, h, options);
  return { h, view };
};
const rowOf = (id: string): HTMLElement => document.querySelector(`[data-calendar-id="${id}"][data-status]`) as HTMLElement;
const editor = (): HTMLElement => screen.getByTestId('editor');
const dayInEditor = (date: string): HTMLElement => editor().querySelector(`[data-date="${date}"]`) as HTMLElement;
const save = (): HTMLButtonElement => screen.getByRole('button', { name: vi_['adm.calendar.draft.submit.action'] }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

describe('WorkCalendarWorkspace (ADM-07)', () => {
  it('shows the month grid of the version in force with its compensated working days, a legend and the placeholder notice (AC-ST-ADM-010-3)', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['adm.calendar.page.title']);
    expect(screen.getByTestId('placeholder-note').textContent).toBe(vi_['adm.calendar.placeholder.note']);
    const inView = screen.getByTestId('version-in-view');
    expect(inView.getAttribute('data-calendar-id')).toBe('c1');
    expect(inView.querySelectorAll('table.cal-month')).toHaveLength(12);
    const compensated = inView.querySelector('[data-date="2026-05-09"]') as HTMLElement;
    expect(compensated.getAttribute('data-kind')).toBe('compensated');
    expect(compensated.textContent).toContain(vi_['adm.calendar.day.compensated']);
    expect((inView.querySelector('[data-date="2026-05-01"]') as HTMLElement).getAttribute('data-kind')).toBe('holiday');
    expect((inView.querySelector('[data-date="2026-05-02"]') as HTMLElement).getAttribute('data-kind')).toBe('off');
    expect(within(inView).getByLabelText(vi_['adm.calendar.legend.title']).querySelectorAll('li')).toHaveLength(4);
    expect(within(inView).getByText(vi_['adm.calendar.summary.workingDays'].replace('{count}', '260'))).toBeTruthy();
  });

  it('lists the versions with the newest year first and a calendar revisions newest first', () => {
    mount();
    expect([...document.querySelectorAll('[data-calendar-id][data-status]')].map((row) => row.getAttribute('data-calendar-id'))).toEqual(['c3', 'c2', 'c1']);
    expect(within(rowOf('c1')).getByText(vi_['adm.calendar.status.published'])).toBeTruthy();
    expect(within(rowOf('c2')).getByText(vi_['adm.calendar.status.draft'])).toBeTruthy();
  });

  it('shows the month and weekday names in the language of the screen', () => {
    mount();
    const january = screen.getByTestId('version-in-view').querySelector('table[data-month="1"]') as HTMLElement;
    expect(january.querySelector('caption')?.textContent).toMatch(/tháng 1/i);
    translator.setLocale('en');
    cleanup();
    mount();
    expect((screen.getByTestId('version-in-view').querySelector('table[data-month="1"] caption') as HTMLElement).textContent).toBe('January');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(en_['adm.calendar.page.title']);
  });

  it('says so when the tenant has no version and still offers the form', () => {
    mount([]);
    expect(screen.getByText(vi_['adm.calendar.versions.empty'])).toBeTruthy();
    expect(screen.queryByTestId('version-in-view')).toBeNull();
    expect(editor()).toBeTruthy();
  });

  it('shows another version when asked, and starts the next revision from it', async () => {
    mount();
    const user = userEvent.setup();
    await user.click(within(rowOf('c3')).getByRole('button', { name: vi_['adm.calendar.view.action'] }));
    expect(screen.getByTestId('version-in-view').getAttribute('data-calendar-id')).toBe('c3');
    expect(rowOf('c3').getAttribute('aria-current')).toBe('true');
    await user.click(within(rowOf('c3')).getByRole('button', { name: vi_['adm.calendar.copy.action'] }));
    expect((screen.getByLabelText(vi_['adm.calendar.code.label']) as HTMLInputElement).value).toBe('VN-STD');
    expect((screen.getByLabelText(vi_['adm.calendar.year.label']) as HTMLInputElement).value).toBe('2027');
    expect(dayInEditor('2027-05-01').getAttribute('data-kind')).toBe('holiday');
    expect(dayInEditor('2027-05-09').getAttribute('data-kind')).toBe('compensated');
    expect(within(screen.getByTestId('holiday-list')).getByDisplayValue('Labour Day')).toBeTruthy();
  });

  it('writes a draft by marking days on the grid, and sends it once with the marks in date order', async () => {
    const { h } = mount([], { permissions: MANAGER }, harness(() => new Error('no read'), () => ({ status: 'DRAFTED', resource_version: 1, resource_id: 'c9' })));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(vi_['adm.calendar.code.label']), 'VN-STD');
    const year = screen.getByLabelText(vi_['adm.calendar.year.label']);
    await user.clear(year);
    await user.type(year, '2026');
    await user.type(screen.getByLabelText(vi_['adm.calendar.basis.label']), 'Labour Code 2019 art. 112');
    await user.click(dayInEditor('2026-09-02'));
    await user.click(dayInEditor('2026-05-01'));
    await user.click(dayInEditor('2026-05-09'));
    const holidays = screen.getByTestId('holiday-list');
    await user.type(within(holidays).getByLabelText(vi_['adm.calendar.holiday.name.label'], { selector: '#holiday-name-2026-05-01' }), 'Labour Day');
    await user.type(within(holidays).getByLabelText(vi_['adm.calendar.holiday.name.label'], { selector: '#holiday-name-2026-09-02' }), 'National Day');
    await user.type(within(holidays).getByLabelText(vi_['adm.calendar.holiday.basis.label'], { selector: '#holiday-basis-2026-05-01' }), 'Labour Code');
    expect(screen.getByTestId('compensated-list').textContent).toBe('2026-05-09');
    await user.click(save());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('createWorkCalendarVersion');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({
      body: {
        calendar_code: 'VN-STD',
        year: 2026,
        working_days: [1, 2, 3, 4, 5],
        holidays: [
          { date: '2026-05-01', name: 'Labour Day', legal_basis_ref: 'Labour Code' },
          { date: '2026-09-02', name: 'National Day' },
        ],
        compensated_workdays: ['2026-05-09'],
        legal_basis_ref: 'Labour Code 2019 art. 112',
      },
    });
    expect(await screen.findByText(vi_['adm.calendar.draft.accepted.notice'])).toBeTruthy();
    // The same text is not saved again; an edit makes it another revision.
    expect(save().disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: vi_['adm.calendar.form.title'] }));
    expect(h.command).toHaveBeenCalledTimes(1);
    await user.click(dayInEditor('2026-05-01'));
    expect(save().disabled).toBe(false);
  });

  it('clears a mark with a second click, and counts the working days as the marks change', async () => {
    mount([]);
    const user = userEvent.setup();
    const year = screen.getByLabelText(vi_['adm.calendar.year.label']);
    await user.clear(year);
    await user.type(year, '2026');
    const summary = (count: number): string => vi_['adm.calendar.summary.workingDays'].replace('{count}', String(count));
    expect(within(screen.getByTestId('editor-grids')).getByText(summary(261))).toBeTruthy();
    await user.click(dayInEditor('2026-05-01'));
    expect(within(screen.getByTestId('editor-grids')).getByText(summary(260))).toBeTruthy();
    expect(dayInEditor('2026-05-01').getAttribute('aria-pressed')).toBe('true');
    await user.click(dayInEditor('2026-05-01'));
    expect(within(screen.getByTestId('editor-grids')).getByText(summary(261))).toBeTruthy();
    expect(screen.getByText(vi_['adm.calendar.holidays.empty'])).toBeTruthy();
    expect(screen.getByTestId('compensated-list').textContent).toBe(vi_['adm.calendar.compensated.empty']);
  });

  it('follows the working weekdays: unticking Friday makes Fridays days off', async () => {
    mount([]);
    const user = userEvent.setup();
    const year = screen.getByLabelText(vi_['adm.calendar.year.label']);
    await user.clear(year);
    await user.type(year, '2026');
    expect(dayInEditor('2026-05-08').getAttribute('data-kind')).toBe('working');
    await user.click(within(screen.getByRole('group', { name: vi_['adm.calendar.weekdays.legend'] })).getAllByRole('checkbox')[4] as HTMLElement);
    expect(dayInEditor('2026-05-08').getAttribute('data-kind')).toBe('off');
  });

  it('drops the marks of the old year when the year changes, and shows no grid for a year outside 2020 to 2100', async () => {
    mount([]);
    const user = userEvent.setup();
    const year = screen.getByLabelText(vi_['adm.calendar.year.label']);
    await user.clear(year);
    await user.type(year, '2026');
    await user.click(dayInEditor('2026-05-01'));
    await user.clear(year);
    await user.type(year, '2027');
    expect(screen.getByText(vi_['adm.calendar.holidays.empty'])).toBeTruthy();
    await user.clear(year);
    await user.type(year, '1999');
    expect(screen.queryByTestId('editor-grids')).toBeNull();
    await user.click(screen.getByLabelText(vi_['adm.calendar.code.label']));
    await user.type(screen.getByLabelText(vi_['adm.calendar.code.label']), 'VN-STD');
    await user.type(screen.getByLabelText(vi_['adm.calendar.basis.label']), 'Labour Code');
    await user.click(save());
    expect(await screen.findByText(vi_['adm.calendar.field.range'])).toBeTruthy();
  });

  it('refuses what the form can see is wrong before anything is sent', async () => {
    const { h } = mount([]);
    const user = userEvent.setup();
    await user.click(save());
    expect(screen.getAllByText(vi_['adm.calendar.field.required']).length).toBeGreaterThanOrEqual(2);
    await user.type(screen.getByLabelText(vi_['adm.calendar.code.label']), 'VN STD');
    await user.click(save());
    expect(await screen.findByText(vi_['adm.calendar.field.pattern'])).toBeTruthy();
    await user.clear(screen.getByLabelText(vi_['adm.calendar.code.label']));
    await user.type(screen.getByLabelText(vi_['adm.calendar.code.label']), 'A'.repeat(41));
    await user.click(save());
    expect(await screen.findByText(vi_['adm.calendar.field.tooLong'])).toBeTruthy();
    for (const box of within(screen.getByRole('group', { name: vi_['adm.calendar.weekdays.legend'] })).getAllByRole('checkbox')) {
      if ((box as HTMLInputElement).checked) await user.click(box);
    }
    await user.click(save());
    expect(await screen.findAllByText(vi_['adm.calendar.field.required'])).not.toHaveLength(0);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('asks for the name of every holiday before it saves', async () => {
    const { h } = mount([]);
    const user = userEvent.setup();
    const year = screen.getByLabelText(vi_['adm.calendar.year.label']);
    await user.clear(year);
    await user.type(year, '2026');
    await user.type(screen.getByLabelText(vi_['adm.calendar.code.label']), 'VN-STD');
    await user.type(screen.getByLabelText(vi_['adm.calendar.basis.label']), 'Labour Code');
    await user.click(dayInEditor('2026-05-01'));
    await user.click(save());
    expect(await screen.findByText(vi_['adm.calendar.field.nameRequired'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('lists every finding of a calendar the server refused with 422 CALENDAR_INVALID', async () => {
    const errors = [
      { field: 'holidays[1]', code: 'OUT_OF_YEAR', message: 'adm.calendar.error.outOfYear' },
      { field: 'holidays[2]', code: 'DATE_INVALID' },
      { field: 'holidays[3]', code: 'DUPLICATE' },
      { field: 'working_days', code: 'NO_WORKING_DAYS' },
      { field: 'calendar_code', code: 'CODE_INVALID' },
      { field: 'legal_basis_ref', code: 'LEGAL_BASIS_REQUIRED' },
      { field: 'holidays[0].name', code: 'NAME_REQUIRED' },
      { field: 'compensated_workdays[0]', code: 'COMPENSATED_ON_HOLIDAY' },
      { field: 'compensated_workdays[1]', code: 'COMPENSATED_ALREADY_WORKING' },
      { field: 'x', code: 'SOMETHING_NEW' },
    ];
    const { h } = mount([], { permissions: MANAGER }, harness(() => new Error('no read'), () => new ApiError({ status: 422, code: 'CALENDAR_INVALID', correlationId: 'c', detail: 'holidays[1]', extensions: { errors } })));
    const user = userEvent.setup();
    const year = screen.getByLabelText(vi_['adm.calendar.year.label']);
    await user.clear(year);
    await user.type(year, '2027');
    await user.type(screen.getByLabelText(vi_['adm.calendar.code.label']), 'VN-STD');
    await user.type(screen.getByLabelText(vi_['adm.calendar.basis.label']), 'Labour Code');
    await user.click(save());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const sentence = (key: keyof typeof vi_, field = ''): string => vi_[key].replace('{field}', field);
    const refusal = (await screen.findByText(sentence('adm.calendar.error.outOfYear', 'holidays[1]'))).closest('[role="alert"]') as HTMLElement;
    expect(within(refusal).getByText(vi_['adm.calendar.problem.calendarInvalid'], { selector: 'p' })).toBeTruthy();
    expect(within(refusal).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      sentence('adm.calendar.error.outOfYear', 'holidays[1]'),
      sentence('adm.calendar.error.dateInvalid', 'holidays[2]'),
      sentence('adm.calendar.error.duplicate', 'holidays[3]'),
      sentence('adm.calendar.error.noWorkingDays'),
      sentence('adm.calendar.error.codeInvalid'),
      sentence('adm.calendar.error.legalBasisRequired'),
      sentence('adm.calendar.error.nameRequired', 'holidays[0].name'),
      sentence('adm.calendar.error.compensatedOnHoliday', 'compensated_workdays[0]'),
      sentence('adm.calendar.error.compensatedAlreadyWorking', 'compensated_workdays[1]'),
      // A code this screen has no sentence for says only that the calendar is invalid.
      vi_['adm.calendar.problem.calendarInvalid'],
    ]);
  });

  it.each([
    ['VERSION_CONFLICT', 409, 'adm.calendar.problem.conflict'],
    ['STAGE_TRANSITION_DENIED', 409, 'adm.calendar.problem.stage'],
    ['RESOURCE_NOT_FOUND', 404, 'adm.calendar.problem.notFound'],
    ['SCOPE_DENIED', 403, 'adm.calendar.problem.denied'],
    ['SESSION_EXPIRED', 401, 'adm.calendar.problem.session'],
    ['VALIDATION_FAILED', 422, 'adm.calendar.problem.invalid'],
  ] as const)('shows what the server refused for a publication: %s', async (code, status, key) => {
    const { h } = mount(VERSIONS, { permissions: MANAGER }, harness(() => new Error('no read'), () => new ApiError({ status, code, correlationId: 'c' })));
    const user = userEvent.setup();
    await user.click(within(rowOf('c2')).getByRole('button', { name: vi_['adm.calendar.publish.action'] }));
    await user.type(screen.getByLabelText(vi_['adm.calendar.publish.reason.label']), 'The notice is signed');
    await user.click(screen.getByRole('button', { name: vi_['adm.calendar.publish.confirm.action'] }));
    expect(await screen.findByText(vi_[key])).toBeTruthy();
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('publishes a draft with a reason and the version of the row, after showing what it marks', async () => {
    const { h } = mount(VERSIONS, { permissions: MANAGER }, harness(() => new Error('no read'), () => ({ status: 'PUBLISHED', resource_version: 2, resource_id: 'c2' })));
    const user = userEvent.setup();
    expect(within(rowOf('c1')).queryByRole('button', { name: vi_['adm.calendar.publish.action'] })).toBeNull();
    await user.click(within(rowOf('c2')).getByRole('button', { name: vi_['adm.calendar.publish.action'] }));
    const preview = screen.getByTestId('publish-preview');
    expect(preview.textContent).toContain('VN-STD 2026 #2');
    expect(preview.textContent).toContain('260');
    await user.click(screen.getByRole('button', { name: vi_['adm.calendar.publish.confirm.action'] }));
    expect(await screen.findByText(vi_['adm.calendar.field.required'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(vi_['adm.calendar.publish.reason.label']), 'The notice is signed');
    await user.click(screen.getByRole('button', { name: vi_['adm.calendar.publish.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('publishWorkCalendar');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { calendarId: 'c2' }, ifMatchVersion: 1, body: { reason: 'The notice is signed' } });
    expect(await screen.findByText(vi_['adm.calendar.publish.accepted.notice'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['adm.calendar.publish.confirm.action'] })).toBeNull();
  });

  it('closes the publication form without sending anything', async () => {
    const { h } = mount();
    const user = userEvent.setup();
    await user.click(within(rowOf('c2')).getByRole('button', { name: vi_['adm.calendar.publish.action'] }));
    await user.click(screen.getByRole('button', { name: vi_['adm.calendar.publish.cancel.action'] }));
    expect(screen.queryByTestId('publish-preview')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('offers a reader the versions without the form actions', () => {
    mount(VERSIONS, { permissions: READER });
    expect(screen.getByText(vi_['adm.calendar.readOnly.notice'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['adm.calendar.draft.submit.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['adm.calendar.publish.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['adm.calendar.copy.action'] })).toBeNull();
    expect(screen.getByTestId('version-in-view')).toBeTruthy();
    // The month grids of the form are shown but their days cannot be marked.
    expect(editor().querySelectorAll('table.cal-month')).toHaveLength(12);
    expect(editor().querySelectorAll('button.cal-day')).toHaveLength(0);
  });

  it('is read-only in a suspended tenant: no draft, no publication, whatever the grants say', () => {
    mount(VERSIONS, { permissions: MANAGER, mode: 'READ_ONLY' });
    expect(screen.getByText(vi_['adm.calendar.frozen.notice'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['adm.calendar.draft.submit.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['adm.calendar.publish.action'] })).toBeNull();
  });

  it('shows the form without permission checks while the permissions are not known yet', () => {
    mount(VERSIONS, { permissions: undefined });
    expect(save()).toBeTruthy();
  });

  it('starts over when the person switches tenant: a draft typed for one tenant is never saved into another', async () => {
    const h = harness(() => new Error('no read'));
    const { view } = mount(VERSIONS, { permissions: MANAGER }, h);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(vi_['adm.calendar.code.label']), 'VN-STD');
    await user.click(within(rowOf('c2')).getByRole('button', { name: vi_['adm.calendar.publish.action'] }));
    await user.type(screen.getByLabelText(vi_['adm.calendar.publish.reason.label']), 'The notice is signed');
    view.rerenderWith({ permissions: MANAGER, tenant: SECOND_TENANT });
    expect((screen.getByLabelText(vi_['adm.calendar.code.label']) as HTMLInputElement).value).toBe('');
    expect(screen.queryByLabelText(vi_['adm.calendar.publish.reason.label'])).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('stops a publication that was opened before the tenant was suspended', async () => {
    const h = harness(() => new Error('no read'), () => ({ status: 'PUBLISHED', resource_version: 2, resource_id: 'c2' }));
    const { view } = mount(VERSIONS, { permissions: MANAGER }, h);
    const user = userEvent.setup();
    await user.click(within(rowOf('c2')).getByRole('button', { name: vi_['adm.calendar.publish.action'] }));
    await user.type(screen.getByLabelText(vi_['adm.calendar.publish.reason.label']), 'The notice is signed');
    view.rerenderWith({ permissions: MANAGER, mode: 'READ_ONLY' });
    expect(screen.queryByRole('button', { name: vi_['adm.calendar.publish.confirm.action'] })).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });
});

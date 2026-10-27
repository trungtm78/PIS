import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { FIRST_TENANT, SECOND_TENANT, mountInSession } from '../adm/security/test-support';
import PeriodCalendarScreen from './PeriodCalendarScreen';
import { CURRENT_YEAR, FUTURE_DEADLINE, MAKER, MANAGER, PAST_DEADLINE, PLANNER, client, mount, period, routeOf, world } from './test-support';

const ROUTE = routeOf('DIS-14', 'FR-DIS-14');
const PATH = '/dis/dis-14';

afterEach(cleanup);

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-period-code]'));
const codes = (): string[] => rows().map((row) => row.getAttribute('data-period-code') ?? '');
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const row = (n: number): HTMLElement => document.querySelector(`tr[data-period-id="00000000-0000-4000-8000-0003${String(n).padStart(8, '0')}"]`) as HTMLElement;
const moveButton = (n: number, move: 'softClose' | 'lock'): HTMLElement | null => row(n).querySelector(`button[data-move="${move}"]`);
const refusal = (code: string, detail?: string): ApiError => new ApiError({ status: 409, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });
const text = (key: keyof typeof vi_, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), vi_[key]);

const CALENDAR = [
  period(1, { status: 'OPEN', deadline_at: PAST_DEADLINE }),
  period(2, { status: 'SOFT_CLOSED', soft_closed_at: '2026-10-02T03:05:00.000Z', version: 2 }),
  period(3, {
    status: 'LOCKED',
    soft_closed_at: '2026-10-02T03:05:00.000Z',
    locked_at: '2026-10-02T03:10:00.000Z',
    locked_by: '00000000-0000-4000-8000-0000000000f1',
    version: 3,
    reopens: [
      { id: 'r1', scope_kind: 'PERIOD', status: 'REQUESTED', window_until: null, requested_at: '2026-10-03T01:00:00.000Z' },
      { id: 'r2', scope_kind: 'PROJECTS', status: 'APPROVED', window_until: '2026-10-05T03:00:00.000Z', requested_at: '2026-10-03T02:00:00.000Z' },
    ],
  }),
  period(4, { status: 'OPEN', deadline_at: FUTURE_DEADLINE }),
];

describe('PeriodCalendarScreen (DIS-14): the calendar of the reporting periods (UI-DIS-14)', () => {
  it('lists the periods with the status of each in words, the lock time and the history of reopening (AC-ST-DIS-001-4)', async () => {
    mount(<PeriodCalendarScreen route={ROUTE} />, client(world({ periods: CALENDAR })), MAKER, PATH);
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['dis.calendar.page.title']);
    expect(codes()).toEqual(CALENDAR.map((item) => item.code));
    const pill = (n: number): string => (row(n).querySelector('.pill') as HTMLElement).textContent ?? '';
    expect([1, 2, 3, 4].map(pill)).toEqual([vi_['dis.calendar.status.open.text'], vi_['dis.calendar.status.softClosed.text'], vi_['dis.calendar.status.locked.text'], vi_['dis.calendar.status.open.text']]);
    expect(row(2).getAttribute('data-status')).toBe('SOFT_CLOSED');
    expect(row(2).textContent).toContain(text('dis.calendar.softClosedAt.text', { when: '2026-10-02 10:05' }));
    // The deadline and the lock time are shown in Vietnam time (UTC+7), the instant itself stays in the element.
    expect(row(1).querySelector('time')?.textContent).toBe('2020-01-10 10:00');
    expect(row(1).querySelector('time')?.getAttribute('datetime')).toBe(PAST_DEADLINE);
    expect(Array.from(row(3).querySelectorAll('time')).map((time) => time.textContent)).toEqual(['2020-01-10 10:00', '2026-10-02 10:10']);
    expect(row(1).textContent).toContain(text('dis.calendar.version.text', { revision: 1 }));
    // The history of reopening: none, then a request for the whole period and an approved window for some projects.
    expect(row(1).textContent).toContain(vi_['dis.calendar.history.none.text']);
    const history = Array.from(row(3).querySelectorAll('.dis-history li')).map((item) => item.textContent);
    expect(history).toEqual([
      text('dis.calendar.history.item.text', { scope: vi_['dis.calendar.reopenScope.period.text'], status: vi_['dis.calendar.reopenStatus.requested.text'] }),
      `${text('dis.calendar.history.item.text', { scope: vi_['dis.calendar.reopenScope.projects.text'], status: vi_['dis.calendar.reopenStatus.approved.text'] })} ${text('dis.calendar.history.window.text', { when: '2026-10-05 10:00' })}`,
    ]);
    // There is no "Closed" status anywhere on the screen.
    expect(document.body.textContent).not.toMatch(/\bClosed\b/);
    expect(screen.getByRole('table', { name: vi_['dis.calendar.table.aria'] })).toBeTruthy();
    expect(screen.getByTestId('count').textContent).toBe(text('dis.calendar.count.text', { total: 4, open: 2, softClosed: 1, locked: 1 }));
  });

  it('offers a period manager the close and the lock, and a maker none, with the status in words in every state (AC-ST-DIS-001-4)', async () => {
    mount(<PeriodCalendarScreen route={ROUTE} />, client(world({ periods: CALENDAR })), MANAGER, PATH);
    await ready();
    expect(moveButton(1, 'softClose')?.textContent).toBe(vi_['dis.calendar.softClose.action']);
    expect(moveButton(2, 'lock')?.textContent).toBe(vi_['dis.calendar.lock.action']);
    expect(moveButton(2, 'softClose')).toBeNull();
    expect(row(3).querySelectorAll('button')).toHaveLength(0);
    // A period that is not due has no button that the server would refuse, and says so.
    expect(row(4).querySelectorAll('button')).toHaveLength(0);
    expect(row(4).textContent).toContain(vi_['dis.calendar.beforeDeadline.hint']);
    expect(screen.getByRole('form', { name: vi_['dis.calendar.generate.title'] })).toBeTruthy();
    cleanup();

    mount(<PeriodCalendarScreen route={ROUTE} />, client(world({ periods: CALENDAR })), MAKER, PATH);
    await ready();
    expect(document.querySelectorAll('button[data-move]')).toHaveLength(0);
    expect(screen.queryByRole('form', { name: vi_['dis.calendar.generate.title'] })).toBeNull();
    expect(row(1).textContent).not.toContain(vi_['dis.calendar.beforeDeadline.hint']);
    expect(row(4).textContent).not.toContain(vi_['dis.calendar.beforeDeadline.hint']);
    expect([1, 2, 3].map((n) => (row(n).querySelector('.pill') as HTMLElement).textContent)).toEqual([
      vi_['dis.calendar.status.open.text'],
      vi_['dis.calendar.status.softClosed.text'],
      vi_['dis.calendar.status.locked.text'],
    ]);
  });

  it('offers a planner who may manage but not lock the close and not the lock', async () => {
    mount(<PeriodCalendarScreen route={ROUTE} />, client(world({ periods: CALENDAR })), PLANNER, PATH);
    await ready();
    expect(moveButton(1, 'softClose')).not.toBeNull();
    expect(moveButton(2, 'lock')).toBeNull();
  });

  it('offers nothing and no generator while the tenant is read-only', async () => {
    mountInSession(<PeriodCalendarScreen route={ROUTE} />, client(world({ periods: CALENDAR })), { permissions: MANAGER, mode: 'READ_ONLY' });
    await ready();
    expect(document.querySelectorAll('button[data-move]')).toHaveLength(0);
    expect(screen.queryByRole('form', { name: vi_['dis.calendar.generate.title'] })).toBeNull();
  });

  describe('closing and locking', () => {
    it('soft closes a period after asking for a reason, against the version that was read, and shows the new status', async () => {
      const state = world({ periods: CALENDAR.map((item) => ({ ...item })) });
      const h = client(state, (operation, input) => {
        if (operation === 'softCloseReportingPeriod') {
          const target = state.periods.find((item) => item.id === (input as { path: { id: string } }).path.id) as Record<string, unknown>;
          Object.assign(target, { status: 'SOFT_CLOSED', soft_closed_at: '2026-10-02T03:05:00.000Z', version: 2 });
        }
        return {};
      });
      mount(<PeriodCalendarScreen route={ROUTE} />, h, MANAGER, PATH);
      await ready();
      const user = userEvent.setup();
      await user.click(moveButton(1, 'softClose') as HTMLElement);
      const dialog = await screen.findByRole('dialog', { name: text('dis.calendar.softClose.dialog.title', { code: CALENDAR[0]?.code as string }) });
      expect(within(dialog).getByText(vi_['dis.calendar.softClose.dialog.body'])).toBeTruthy();
      // A reason is required, and it is at least five characters.
      await user.click(within(dialog).getByRole('button', { name: vi_['dis.calendar.softClose.confirm.action'] }));
      expect((await within(dialog).findByRole('alert')).textContent).toBe(vi_['dis.calendar.field.required.error']);
      await user.type(within(dialog).getByLabelText(vi_['dis.calendar.dialog.reason.label']), 'abc');
      await user.click(within(dialog).getByRole('button', { name: vi_['dis.calendar.softClose.confirm.action'] }));
      expect((await within(dialog).findByRole('alert')).textContent).toBe(vi_['dis.calendar.field.tooShort.error']);
      expect(h.command).not.toHaveBeenCalled();
      await user.clear(within(dialog).getByLabelText(vi_['dis.calendar.dialog.reason.label']));
      await user.type(within(dialog).getByLabelText(vi_['dis.calendar.dialog.reason.label']), '  The deadline has passed  ');
      await user.click(within(dialog).getByRole('button', { name: vi_['dis.calendar.softClose.confirm.action'] }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(h.command).toHaveBeenCalledTimes(1);
      expect(h.command).toHaveBeenCalledWith('softCloseReportingPeriod', expect.objectContaining({ path: { id: CALENDAR[0]?.id }, body: { reason: 'The deadline has passed' }, ifMatchVersion: 1 }));
      await waitFor(() => expect((row(1).querySelector('.pill') as HTMLElement).textContent).toBe(vi_['dis.calendar.status.softClosed.text']));
      expect(moveButton(1, 'softClose')).toBeNull();
      expect(moveButton(1, 'lock')).not.toBeNull();
    });

    it('locks a soft-closed period with a reason and shows when it was locked', async () => {
      const state = world({ periods: CALENDAR.map((item) => ({ ...item })) });
      const h = client(state, (operation, input) => {
        if (operation === 'lockReportingPeriod') {
          const target = state.periods.find((item) => item.id === (input as { path: { id: string } }).path.id) as Record<string, unknown>;
          Object.assign(target, { status: 'LOCKED', locked_at: '2026-10-02T03:10:00.000Z', locked_by: '00000000-0000-4000-8000-0000000000f1', version: 3 });
        }
        return {};
      });
      mount(<PeriodCalendarScreen route={ROUTE} />, h, MANAGER, PATH);
      await ready();
      const user = userEvent.setup();
      await user.click(moveButton(2, 'lock') as HTMLElement);
      const dialog = await screen.findByRole('dialog', { name: text('dis.calendar.lock.dialog.title', { code: CALENDAR[1]?.code as string }) });
      expect(within(dialog).getByText(vi_['dis.calendar.lock.dialog.body'])).toBeTruthy();
      await user.type(within(dialog).getByLabelText(vi_['dis.calendar.dialog.reason.label']), 'Locked after the review');
      await user.click(within(dialog).getByRole('button', { name: vi_['dis.calendar.lock.confirm.action'] }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(h.command).toHaveBeenCalledWith('lockReportingPeriod', expect.objectContaining({ path: { id: CALENDAR[1]?.id }, body: { reason: 'Locked after the review' }, ifMatchVersion: 2 }));
      await waitFor(() => expect((row(2).querySelector('.pill') as HTMLElement).textContent).toBe(vi_['dis.calendar.status.locked.text']));
      expect(row(2).querySelectorAll('time')[1]?.textContent).toBe('2026-10-02 10:10');
      expect(row(2).querySelectorAll('button')).toHaveLength(0);
    });

    it('says why the server refused a move and keeps the dialog open', async () => {
      const failures = [
        [refusal('PERIOD_STATE_INVALID', 'deadline_at'), 'dis.calendar.problem.beforeDeadline.error'],
        [refusal('PERIOD_STATE_INVALID', 'status'), 'dis.calendar.problem.stateInvalid.error'],
        [refusal('VERSION_CONFLICT'), 'dis.calendar.problem.versionConflict.error'],
        [refusal('RESOURCE_NOT_FOUND'), 'dis.calendar.problem.notFound.error'],
        [refusal('SCOPE_DENIED'), 'dis.calendar.problem.denied.error'],
        [refusal('VALIDATION_FAILED', 'reason'), 'dis.calendar.problem.validation.error'],
        [new Error('network'), 'dis.calendar.problem.general.error'],
      ] as const;
      for (const [failure, key] of failures) {
        const h = client(world({ periods: CALENDAR }), () => failure);
        mount(<PeriodCalendarScreen route={ROUTE} />, h, MANAGER, PATH);
        await ready();
        const user = userEvent.setup();
        await user.click(moveButton(1, 'softClose') as HTMLElement);
        const dialog = await screen.findByRole('dialog');
        await user.type(within(dialog).getByLabelText(vi_['dis.calendar.dialog.reason.label']), 'The deadline has passed');
        await user.click(within(dialog).getByRole('button', { name: vi_['dis.calendar.softClose.confirm.action'] }));
        expect((await within(dialog).findByRole('alert')).textContent).toBe(vi_[key]);
        expect(screen.getByRole('dialog')).toBeTruthy();
        cleanup();
      }
    });

    it('closes the dialog without sending anything on cancel, on the close button and on Escape', async () => {
      const h = client(world({ periods: CALENDAR }));
      mount(<PeriodCalendarScreen route={ROUTE} />, h, MANAGER, PATH);
      await ready();
      const user = userEvent.setup();
      for (const close of [
        () => user.click(screen.getByRole('button', { name: vi_['dis.calendar.dialog.cancel.action'] })),
        () => user.click(screen.getByRole('button', { name: vi_['dis.calendar.dialog.close.label'] })),
        () => user.keyboard('{Escape}'),
      ]) {
        await user.click(moveButton(1, 'softClose') as HTMLElement);
        await screen.findByRole('dialog');
        await close();
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      }
      expect(h.command).not.toHaveBeenCalled();
    });
  });

  describe('generating the periods of a year', () => {
    it('generates the weeks of a year from the calendar in force and shows that year', async () => {
      const state = world({ periods: [] });
      const h = client(state, (operation) => {
        if (operation === 'generateReportingPeriods') state.periods = [period(1, { fiscal_year: 2031, code: 'W2031-01', status: 'OPEN' })];
        return {};
      });
      mount(<PeriodCalendarScreen route={ROUTE} />, h, MANAGER, PATH);
      expect((await screen.findByTestId('empty-periods')).textContent).toBe(text('dis.calendar.empty.text', { year: CURRENT_YEAR }));
      const user = userEvent.setup();
      const input = screen.getByLabelText(vi_['dis.calendar.generate.year.label']);
      await user.clear(input);
      await user.type(input, '2031');
      await user.click(screen.getByRole('button', { name: vi_['dis.calendar.generate.submit.action'] }));
      expect((await screen.findByTestId('generated')).textContent).toBe(text('dis.calendar.generate.done.notice', { year: 2031 }));
      expect(h.command).toHaveBeenCalledWith('generateReportingPeriods', expect.objectContaining({ body: { calendar_code: 'DEFAULT', fiscal_year: 2031, period_type: 'WEEK' } }));
      await waitFor(() => expect(codes()).toEqual(['W2031-01']));
      expect((screen.getByLabelText(vi_['dis.calendar.filter.year.label']) as HTMLSelectElement).value).toBe('2031');
    });

    it('ST-DIS-015: generates the months of a year when the type is changed to months, and weeks stay the default', async () => {
      const h = client(world({ periods: [] }), () => ({}));
      mount(<PeriodCalendarScreen route={ROUTE} />, h, MANAGER, PATH);
      const user = userEvent.setup();
      const type = (await screen.findByLabelText(vi_['dis.calendar.generate.type.label'])) as HTMLSelectElement;
      expect(type.value).toBe('WEEK');
      expect(within(type).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['dis.calendar.generate.type.week'], vi_['dis.calendar.generate.type.month']]);
      const input = screen.getByLabelText(vi_['dis.calendar.generate.year.label']);
      await user.clear(input);
      await user.type(input, '2031');
      await user.selectOptions(type, 'MONTH');
      await user.click(screen.getByRole('button', { name: vi_['dis.calendar.generate.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('generateReportingPeriods', expect.objectContaining({ body: { calendar_code: 'DEFAULT', fiscal_year: 2031, period_type: 'MONTH' } })));
    });

    it('refuses a year that is not four digits within the calendar years, without calling the server', async () => {
      const h = client(world({ periods: [] }));
      mount(<PeriodCalendarScreen route={ROUTE} />, h, MANAGER, PATH);
      const user = userEvent.setup();
      const input = await screen.findByLabelText(vi_['dis.calendar.generate.year.label']);
      const submit = screen.getByRole('button', { name: vi_['dis.calendar.generate.submit.action'] });
      for (const [value, message] of [
        ['', 'dis.calendar.field.required.error'],
        ['27', 'dis.calendar.field.invalidYear.error'],
        ['1999', 'dis.calendar.field.invalidYear.error'],
      ] as const) {
        await user.clear(input);
        if (value !== '') await user.type(input, value);
        await user.click(submit);
        expect((await screen.findByRole('alert')).textContent).toBe(vi_[message]);
      }
      fireEvent.change(input, { target: { value: '2031' } });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('says that the year was already generated, and that no calendar is in force', async () => {
      for (const [failure, key] of [
        [refusal('PERIOD_OVERLAP', 'fiscal_year'), 'dis.calendar.problem.overlap.error'],
        [new ApiError({ status: 422, code: 'CALENDAR_NOT_EFFECTIVE', correlationId: 'c', retryAfterSeconds: undefined, detail: 'calendar_code', extensions: {} }), 'dis.calendar.problem.noCalendar.error'],
      ] as const) {
        const h = client(world({ periods: [] }), () => failure);
        mount(<PeriodCalendarScreen route={ROUTE} />, h, MANAGER, PATH);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: vi_['dis.calendar.generate.submit.action'] }));
        expect((await screen.findByRole('alert')).textContent).toBe(vi_[key]);
        expect(screen.queryByTestId('generated')).toBeNull();
        cleanup();
      }
    });
  });

  describe('the list', () => {
    const TWO_YEARS = [...CALENDAR, period(5, { fiscal_year: CURRENT_YEAR - 1, code: `W${CURRENT_YEAR - 1}-52`, start_date: `${CURRENT_YEAR - 1}-12-20`, status: 'LOCKED', locked_at: PAST_DEADLINE })];

    it('shows the current year and lets the person pick another year or a status', async () => {
      mount(<PeriodCalendarScreen route={ROUTE} />, client(world({ periods: TWO_YEARS })), MAKER, PATH);
      await ready();
      expect(codes()).toHaveLength(4);
      const user = userEvent.setup();
      expect(Array.from((screen.getByLabelText(vi_['dis.calendar.filter.year.label']) as HTMLSelectElement).options).map((option) => option.value)).toEqual([String(CURRENT_YEAR), String(CURRENT_YEAR - 1)]);
      await user.selectOptions(screen.getByLabelText(vi_['dis.calendar.filter.year.label']), String(CURRENT_YEAR - 1));
      expect(codes()).toEqual([`W${CURRENT_YEAR - 1}-52`]);
      await user.selectOptions(screen.getByLabelText(vi_['dis.calendar.filter.year.label']), String(CURRENT_YEAR));
      await user.selectOptions(screen.getByLabelText(vi_['dis.calendar.filter.status.label']), 'SOFT_CLOSED');
      expect(codes()).toEqual([CALENDAR[1]?.code]);
      expect(screen.getByTestId('count').textContent).toBe(text('dis.calendar.count.text', { total: 4, open: 2, softClosed: 1, locked: 1 }));
    });

    it('says that no period has the status when the year has none, and that the year is empty when it has no period', async () => {
      mount(<PeriodCalendarScreen route={ROUTE} />, client(world({ periods: [period(1)] })), MAKER, PATH);
      await ready();
      await userEvent.setup().selectOptions(screen.getByLabelText(vi_['dis.calendar.filter.status.label']), 'LOCKED');
      expect((await screen.findByTestId('empty-periods')).textContent).toBe(vi_['dis.calendar.noMatch.text']);
      cleanup();
      mount(<PeriodCalendarScreen route={ROUTE} />, client(world({ periods: [] })), MAKER, PATH);
      expect((await screen.findByTestId('empty-periods')).textContent).toBe(text('dis.calendar.empty.text', { year: CURRENT_YEAR }));
      expect(screen.getByTestId('count').textContent).toBe(text('dis.calendar.count.text', { total: 0, open: 0, softClosed: 0, locked: 0 }));
    });

    it('ignores a row that does not have the shape of a period', async () => {
      mount(<PeriodCalendarScreen route={ROUTE} />, client(world({ periods: [period(1), { id: 'broken' }] })), MAKER, PATH);
      await ready();
      expect(codes()).toHaveLength(1);
    });
  });

  describe('around the list', () => {
    it('says that the calendar could not be read, with a retry', async () => {
      const state = world({ periods: CALENDAR, failing: new Set(['get_resources_reporting_period']) });
      mount(<PeriodCalendarScreen route={ROUTE} />, client(state), MAKER, PATH);
      expect(await screen.findByRole('alert')).toBeTruthy();
      state.failing = new Set();
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      await ready();
      expect(codes()).toHaveLength(4);
    });

    it('shows the standard card of a refusal when the person has no right to read the calendar', async () => {
      const h = client(world());
      (h.client as unknown as { readAll: () => Promise<never> }).readAll = () => Promise.reject(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} }));
      mount(<PeriodCalendarScreen route={ROUTE} />, h, MAKER, PATH);
      expect((await screen.findByRole('alert')).textContent).toContain(vi_['states.denied.title']);
    });

    it('shows the loading state while the calendar is read', () => {
      mount(<PeriodCalendarScreen route={ROUTE} />, client(world({ periods: CALENDAR })), MAKER, PATH);
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    });

    it('starts over when the person switches tenant: the year and the status of the first tenant do not follow', async () => {
      const h = client(world({ periods: [period(1), period(5, { fiscal_year: CURRENT_YEAR - 1, status: 'LOCKED', locked_at: PAST_DEADLINE })] }));
      const view = mountInSession(<PeriodCalendarScreen route={ROUTE} />, h, { permissions: MAKER });
      await ready();
      await userEvent.setup().selectOptions(screen.getByLabelText(vi_['dis.calendar.filter.year.label']), String(CURRENT_YEAR - 1));
      expect(FIRST_TENANT.id).not.toBe(SECOND_TENANT.id);
      view.rerenderWith({ permissions: MAKER, tenant: SECOND_TENANT });
      await ready();
      expect((screen.getByLabelText(vi_['dis.calendar.filter.year.label']) as HTMLSelectElement).value).toBe(String(CURRENT_YEAR));
    });

    it('moves the clock on while the screen stays open, so that a period turns closable at its deadline', async () => {
      const soon = new Date(Date.now() + 60_000).toISOString();
      mount(<PeriodCalendarScreen route={ROUTE} />, client(world({ periods: [period(1, { deadline_at: soon })] })), MANAGER, PATH);
      await ready();
      expect(moveButton(1, 'softClose')).toBeNull();
      expect(row(1).textContent).toContain(vi_['dis.calendar.beforeDeadline.hint']);
    });

    it('tells the screen it belongs to in a footer', async () => {
      mount(<PeriodCalendarScreen route={ROUTE} />, client(world({ periods: CALENDAR })), MAKER, PATH);
      await ready();
      expect(document.querySelector('[data-screen-id="DIS-14"]')).not.toBeNull();
      expect(screen.getByText(text('dis.calendar.footer.reference', { id: 'DIS-14', req: 'FR-DIS-14' }))).toBeTruthy();
    });
  });
});

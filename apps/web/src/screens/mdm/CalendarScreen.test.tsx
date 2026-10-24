import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import CalendarScreen from './CalendarScreen';
import { READER, STEWARD, client, mount, record, routeOf, world } from './test-support';

const ROUTE = routeOf('MDM-11', 'FR-MDM-11');
const CALENDAR = { owner_module: 'DIS', awaiting_confirmation: true, cxn: 'ASSUMPTION-D03', week_starts_on: 'SATURDAY', deadline_weekday: 'FRIDAY', deadline_time: '10:00', timezone: 'Asia/Ho_Chi_Minh' };
const calendar = (overrides: Record<string, unknown> = {}) =>
  record(1, { master_type: 'CALENDAR', business_key: 'DEFAULT', label: 'Lịch kỳ báo cáo tuần', namespace: 'PLATFORM', attributes: CALENDAR, revision: 2, legal_basis: 'Giả định D03', valid_from: '2025-01-01', ...overrides });

beforeEach(() => {
  // Noon on 2026-10-05: the periods of 2026 up to W2026-40 (due 2026-10-02) are locked, the later ones are open.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T05:00:00.000Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ready = () => waitFor(() => expect(screen.getByTestId('calendar-rule')).toBeTruthy());
const periodRow = (code: string): HTMLElement => document.querySelector(`[data-period="${code}"]`) as HTMLElement;

describe('CalendarScreen (MDM-11)', () => {
  it('states the calendar in force with its legal basis, its version and what it waits for', async () => {
    mount(<CalendarScreen route={ROUTE} />, client(world({ records: [calendar()] })), READER, '/mdm/mdm-11');
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['mdm.calendar.page.title']);
    expect(screen.getByTestId('calendar-text').textContent).toBe(
      vi_['mdm.calendar.rule.text'].replace('{start}', vi_['mdm.value.weekday.saturday']).replace('{deadline}', vi_['mdm.value.weekday.friday']).replace('{time}', '10:00').replace('{zone}', 'Asia/Ho_Chi_Minh'),
    );
    const rule = within(screen.getByTestId('calendar-rule'));
    expect(rule.getByText(vi_['mdm.rule.awaiting.pill'].replace('{cxn}', 'ASSUMPTION-D03'))).toBeTruthy();
    expect(rule.getByText('Giả định D03')).toBeTruthy();
    expect(rule.getByText(vi_['mdm.calendar.version.text'].replace('{revision}', '2'))).toBeTruthy();
    expect(rule.getByText(vi_['mdm.calendar.history.action']).getAttribute('href')).toBe('/mdm/mdm-28?type=CALENDAR&key=DEFAULT&ns=PLATFORM');
    // The calendar is the platform's: the tenant reads it and is offered no change.
    expect(screen.getByTestId('calendar-locked')).toBeTruthy();
    expect(screen.queryByText(vi_['mdm.calendar.edit.action'])).toBeNull();
  });

  it('lists the first eight periods of the year, each due on Friday at 03:00 UTC, locked once the deadline has passed', async () => {
    mount(<CalendarScreen route={ROUTE} />, client(world({ records: [calendar()] })), READER, '/mdm/mdm-11?year=2026');
    await ready();
    expect(document.querySelectorAll('[data-period]')).toHaveLength(8);
    expect(screen.getByTestId('period-count').textContent).toBe(vi_['mdm.calendar.count.text'].replace('{shown}', '8').replace('{total}', '52'));
    expect(periodRow('W2026-01').textContent).toContain('2025-12-27');
    expect(periodRow('W2026-01').textContent).toContain('2026-01-02');
    expect(periodRow('W2026-01').textContent).toContain(vi_['mdm.calendar.deadline.text'].replace('{when}', '2026-01-02 03:00'));
    expect(within(periodRow('W2026-01')).getByText(vi_['mdm.calendar.locked.pill'])).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['mdm.calendar.all.action'].replace('{count}', '52') }));
    expect(document.querySelectorAll('[data-period]')).toHaveLength(52);
    // W2026-40 is due on 2026-10-02 (locked); W2026-41 on 2026-10-09 (open).
    expect(within(periodRow('W2026-40')).getByText(vi_['mdm.calendar.locked.pill'])).toBeTruthy();
    expect(within(periodRow('W2026-41')).getByText(vi_['mdm.calendar.open.pill'])).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['mdm.calendar.first.action'].replace('{count}', '8') }));
    expect(document.querySelectorAll('[data-period]')).toHaveLength(8);
  });

  it('changes the year from the field, and falls back to the current year for a year that is not one', async () => {
    mount(<CalendarScreen route={ROUTE} />, client(world({ records: [calendar()] })), READER, '/mdm/mdm-11?year=abc');
    await ready();
    expect((screen.getByLabelText(vi_['mdm.calendar.year.label']) as HTMLInputElement).value).toBe('2026');
    fireEvent.change(screen.getByLabelText(vi_['mdm.calendar.year.label']), { target: { value: '2027' } });
    await waitFor(() => expect(periodRow('W2027-01')).toBeTruthy());
    expect(screen.getByTestId('period-count').textContent).toBe(vi_['mdm.calendar.count.text'].replace('{shown}', '8').replace('{total}', '53'));
    fireEvent.change(screen.getByLabelText(vi_['mdm.calendar.year.label']), { target: { value: '' } });
    await waitFor(() => expect((screen.getByLabelText(vi_['mdm.calendar.year.label']) as HTMLInputElement).value).toBe('2026'));
  });

  it('offers the change of a calendar that the tenant owns, to someone who may propose, and never while a request is open', async () => {
    const own = calendar({ namespace: 'TENANT' });
    mount(<CalendarScreen route={ROUTE} />, client(world({ records: [own] })), STEWARD, '/mdm/mdm-11');
    await ready();
    expect(screen.getByText(vi_['mdm.calendar.edit.action']).getAttribute('href')).toBe('/mdm/mdm-26?type=CALENDAR&key=DEFAULT');
    expect(screen.queryByTestId('calendar-locked')).toBeNull();
    cleanup();
    mount(<CalendarScreen route={ROUTE} />, client(world({ records: [calendar({ namespace: 'TENANT', open_change_request_id: 'c1' })] })), STEWARD, '/mdm/mdm-11');
    await ready();
    expect(screen.queryByText(vi_['mdm.calendar.edit.action'])).toBeNull();
    cleanup();
    mount(<CalendarScreen route={ROUTE} />, client(world({ records: [own] })), READER, '/mdm/mdm-11');
    await ready();
    expect(screen.queryByText(vi_['mdm.calendar.edit.action'])).toBeNull();
  });

  it('reads the calendar of the platform before the tenant\'s own, as the server does, and ignores an entry that is not in force', async () => {
    const platform = calendar({ business_key: 'P', label: 'Của nền tảng', attributes: { ...CALENDAR, deadline_time: '09:00' } });
    const own = calendar({ business_key: 'T', namespace: 'TENANT', label: 'Của tenant', attributes: { ...CALENDAR, deadline_time: '15:00' } });
    const retired = calendar({ business_key: 'OLD', status: 'RETIRED', attributes: { ...CALENDAR, deadline_time: '01:00' } });
    mount(<CalendarScreen route={ROUTE} />, client(world({ records: [retired, own, platform] })), READER, '/mdm/mdm-11');
    await ready();
    expect(screen.getByTestId('calendar-text').textContent).toContain('09:00');
  });

  it('shows the confirmed state when nothing is awaited, and says so when no calendar is in force or the read fails', async () => {
    mount(<CalendarScreen route={ROUTE} />, client(world({ records: [calendar({ attributes: { ...CALENDAR, awaiting_confirmation: false } })] })), READER, '/mdm/mdm-11');
    await ready();
    expect(screen.getByText(vi_['mdm.rule.confirmed.pill'])).toBeTruthy();
    cleanup();
    mount(<CalendarScreen route={ROUTE} />, client(world({ records: [] })), READER, '/mdm/mdm-11');
    expect((await screen.findByTestId('no-calendar')).textContent).toBe(vi_['mdm.calendar.empty.text']);
    cleanup();
    mount(<CalendarScreen route={ROUTE} />, client(world({ failing: new Set(['searchMasterRecords']) })), READER, '/mdm/mdm-11');
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

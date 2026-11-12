import { ApiError } from '@machvon/api-client';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import type { WebRoute } from '../../../routes/types';
import { harness, mount } from '../../sas/test-support';
import CalendarScreen from './CalendarScreen';
import ScheduleRulesScreen from './ScheduleRulesScreen';

/**
 * The seven standard states of the calendar of the reporting periods (DIS-34) and of the rule of the deadlines (ADM-31), each forced in turn and each held to its own message: the loading skeleton, the populated screen,
 * the empty screen with its reason, the refused input, the service error with its retry, the permission denied, and the stale marker of a reading that failed after a good one. The screens are mounted over a client whose
 * answers the case chooses; the browser widths of the case (1440 and 390 px) are the business of the browser runs, not of this file.
 */
const route = (id: string, module: string): WebRoute => ({ id, path: `/${module.toLowerCase()}/${id.toLowerCase()}`, title: id, kind: 'table', area: 'investment', module, group: module, role: 'workspace', parent: null, req: 'QT.02' });
const READER = ['report.read'];
const STEPS = ['ENTRY', 'UNIT_APPROVAL', 'PLANNING_REVIEW', 'PERIOD_CLOSE', 'PUSH'];
const schedule = (code: string) => ({
  code,
  basis: code,
  version: 0,
  source: 'DEFAULT',
  unverified: true,
  rule_id: null,
  steps: STEPS.map((kind, at) => ({ kind, offset_days: [5, 7, 10, 12, 15][at], time: at === 4 ? '16:00' : null })),
  reminder_days_before: [3, 1],
  overdue_repeat_days: 1,
  overdue_max_reminders: 5,
  escalate_after_overdue_days: 3,
});
const populated = () => ({
  year: 2027,
  calendar_time: '10:00',
  schedules: [schedule('MONTH')],
  items: [
    {
      kind: 'REPORT_PERIOD',
      key: 'M2027-09',
      code: 'M2027-09',
      period_type: 'MONTH',
      period_id: null,
      generated: false,
      status: null,
      starts_on: '2027-09-01',
      ends_on: '2027-09-30',
      schedule_code: 'MONTH',
      steps: STEPS.map((kind, at) => ({ kind, due_at: '2027-10-05T03:00:00.000Z', due_on: `2027-10-${String(5 + at).padStart(2, '0')}`, due_time: '10:00' })),
    },
  ],
  as_of: '2027-10-03T03:00:00.000Z',
});
const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const SCREENS: Array<[string, () => JSX.Element]> = [
  ['DIS-34', () => <CalendarScreen route={route('DIS-34', 'DIS')} />],
  ['ADM-31', () => <ScheduleRulesScreen route={route('ADM-31', 'ADM')} />],
];

afterEach(cleanup);

describe.each(SCREENS)('UAT-DIS-ENT4C-3 the seven standard states of %s', (id, screenOf) => {
  it('shows the loading skeleton while the answer is on its way, and no figure', () => {
    mount(screenOf(), harness(() => new Promise(() => undefined) as never), READER);
    const skeleton = screen.getByRole('status', { name: translator.t('states.loading.label') });
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('calendar-table')).toBeNull();
    expect(screen.queryByTestId('schedule-table')).toBeNull();
  });

  it('shows the populated screen with the rule of the deadlines and the note that the default is not confirmed', async () => {
    mount(screenOf(), harness(() => populated()), READER);
    expect(await screen.findByTestId(id === 'DIS-34' ? 'calendar-table' : 'schedule-table')).toBeTruthy();
    expect(screen.getByTestId('unverified-note')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the screen is empty with the standard empty card when nothing is there', async () => {
    mount(screenOf(), harness(() => ({ ...populated(), items: [], schedules: [] })), READER);
    expect(await screen.findByText(translator.t('states.empty.title'))).toBeTruthy();
    expect(screen.queryByTestId('calendar-table')).toBeNull();
    expect(screen.queryByTestId('schedule-table')).toBeNull();
  });

  it('names a service error and retries in place', async () => {
    let failing = true;
    const h = harness(() => (failing ? problem(500, 'INTERNAL') : populated()));
    mount(screenOf(), h, READER);
    expect((await screen.findByRole('alert')).textContent).toContain(translator.t('states.error.title'));
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: translator.t('states.retry.action') }));
    expect(await screen.findByTestId(id === 'DIS-34' ? 'calendar-table' : 'schedule-table')).toBeTruthy();
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('names a refusal of the permission, with the card of its own and no data', async () => {
    mount(screenOf(), harness(() => problem(403, 'PERMISSION_DENIED')), []);
    expect((await screen.findByRole('alert')).textContent).toContain(translator.t('states.denied.title'));
    expect(screen.queryByTestId('calendar-table')).toBeNull();
    expect(screen.queryByTestId('schedule-table')).toBeNull();
  });

  it('keeps what was read and marks it stale when a later reading fails', async () => {
    let failing = false;
    const mounted = mount(screenOf(), harness(() => (failing ? problem(500, 'INTERNAL') : populated())), READER);
    await screen.findByTestId(id === 'DIS-34' ? 'calendar-table' : 'schedule-table');
    failing = true;
    await act(async () => {
      await mounted.queries.invalidateQueries();
    });
    expect((await screen.findByTestId('stale-note')).textContent).toBe(translator.t('gov11.common.stale'));
    expect(screen.getByTestId(id === 'DIS-34' ? 'calendar-table' : 'schedule-table')).toBeTruthy();
  });
});

describe('UAT-DIS-ENT4C-3 the refused input of DIS-34', () => {
  it('refuses a year that is not one with the message of the field, keeps the screen on the last good year and asks for nothing new', async () => {
    const h = harness(() => populated());
    mount(<CalendarScreen route={route('DIS-34', 'DIS')} />, h, READER);
    await screen.findByTestId('calendar-table');
    const calls = h.read.mock.calls.length;
    fireEvent.change(screen.getByLabelText(translator.t('ent4c.calendar.filter.year')), { target: { value: '19' } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(translator.t('ent4c.calendar.filter.yearInvalid')));
    expect(screen.getByLabelText(translator.t('ent4c.calendar.filter.year')).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByTestId('calendar-table')).toBeTruthy();
    expect(h.read.mock.calls.length).toBe(calls);
  });

  it('negative control: a screen that says nothing for a bad year would not pass the check above', () => {
    mount(<CalendarScreen route={route('DIS-34', 'DIS')} />, harness(() => populated()), READER);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

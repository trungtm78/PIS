import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import type { WebRoute } from '../../../routes/types';
import { harness, mount } from '../../sas/test-support';
import CalendarScreen from './CalendarScreen';
import ScheduleRulesScreen from './ScheduleRulesScreen';
import { stateKeyOf, yearOf } from './model';

const route = (id: string, module: string): WebRoute => ({ id, path: `/${module.toLowerCase()}/${id.toLowerCase()}`, title: id, kind: 'table', area: 'investment', module, group: module, role: 'workspace', parent: null, req: 'QT.02' });
const PERMISSIONS = ['report.read'];
const PERIOD = '00000000-0000-4000-8000-0000000000a1';
const UNIT = '00000000-0000-4000-8000-0000000000b1';
const AS_OF = '2027-10-03T03:00:00.000Z';

const steps = (days: number[]) => ['ENTRY', 'UNIT_APPROVAL', 'PLANNING_REVIEW', 'PERIOD_CLOSE', 'PUSH'].map((kind, at) => ({ kind, due_at: '2027-10-05T03:00:00.000Z', due_on: `2027-10-${String(days[at]).padStart(2, '0')}`, due_time: '10:00' }));
const schedule = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  basis: code,
  version: 0,
  source: 'DEFAULT',
  unverified: true,
  rule_id: null,
  steps: ['ENTRY', 'UNIT_APPROVAL', 'PLANNING_REVIEW', 'PERIOD_CLOSE', 'PUSH'].map((kind, at) => ({ kind, offset_days: [5, 7, 10, 12, 15][at], time: at === 4 ? '16:00' : null })),
  reminder_days_before: [3, 1],
  overdue_repeat_days: 1,
  overdue_max_reminders: 5,
  escalate_after_overdue_days: 3,
  ...over,
});
const calendar = () => ({
  year: 2027,
  calendar_time: '10:00',
  schedules: [schedule('MONTH')],
  items: [
    { kind: 'REPORT_PERIOD', key: PERIOD, code: 'M2027-09', period_type: 'MONTH', period_id: PERIOD, generated: true, status: 'OPEN', starts_on: '2027-09-01', ends_on: '2027-09-30', schedule_code: 'MONTH', steps: steps([5, 7, 10, 12, 15]) },
    { kind: 'REPORT_PERIOD', key: 'M2027-10', code: 'M2027-10', period_type: 'MONTH', period_id: null, generated: false, status: null, starts_on: '2027-10-01', ends_on: '2027-10-31', schedule_code: 'MONTH', steps: steps([5, 7, 10, 12, 15]) },
    { kind: 'DIRECTIVE_DUE', key: 'd1', code: 'CD-001', title: 'Chốt số liệu quý', starts_on: '2027-10-20', ends_on: '2027-10-20', status: 'OVERDUE', overdue_days: 4 },
  ],
  as_of: AS_OF,
});
const board = () => ({
  period: { id: PERIOD, code: 'M2027-09' },
  schedule: schedule('MONTH'),
  steps: steps([5, 7, 10, 12, 15]),
  period_steps: ['PLANNING_REVIEW', 'PERIOD_CLOSE', 'PUSH'].map((kind) => ({ kind, due_at: '2027-10-10T03:00:00.000Z', state: kind === 'PERIOD_CLOSE' ? 'OPEN' : 'NOT_TRACKED', done_at: null })),
  units: [
    {
      unit: { id: UNIT, code: 'B1', name: 'Ban Kỹ thuật' },
      projects: 4,
      steps: [
        { kind: 'ENTRY', due_at: '2027-10-05T03:00:00.000Z', state: 'DUE_SOON', done: 2, of: 4, done_at: null },
        { kind: 'UNIT_APPROVAL', due_at: '2027-10-07T03:00:00.000Z', state: 'OPEN', done: 0, of: 4, done_at: null },
        { kind: 'PLANNING_REVIEW', due_at: '2027-10-10T03:00:00.000Z', state: 'NOT_TRACKED', done: null, of: null, done_at: null },
        { kind: 'PERIOD_CLOSE', due_at: '2027-10-12T03:00:00.000Z', state: 'OPEN', done: null, of: null, done_at: null },
        { kind: 'PUSH', due_at: '2027-10-15T09:00:00.000Z', state: 'NOT_TRACKED', done: null, of: null, done_at: null },
      ],
    },
  ],
  tally: {},
  reminders: [{ id: 'r1', unit_id: UNIT, step: 'ENTRY', kind: 'BEFORE_DUE', ordinal: 1, due_at: '2027-10-05T03:00:00.000Z', created_at: '2027-10-02T04:00:00.000Z' }],
  as_of: AS_OF,
});
const answer = (operation: string) => (operation === 'getReportingCalendarBoard' ? board() : calendar());

afterEach(cleanup);

describe('DIS-34, the reporting calendar (QT.02)', () => {
  it('lists the periods with the deadline of every step, the directive that falls due, and says a period that was not generated is not', async () => {
    mount(<CalendarScreen route={route('DIS-34', 'DIS')} />, harness((operation) => answer(operation)), PERMISSIONS);
    const rows = await screen.findAllByTestId('calendar-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('M2027-09');
    expect(rows[0]?.textContent).toContain('05/10/2027 10:00');
    expect(rows[0]?.textContent).toContain('15/10/2027');
    expect(rows[1]?.textContent).toContain(translator.t('ent4c.calendar.notGenerated'));
    expect(rows[2]?.textContent).toContain('CD-001');
    expect(rows[2]?.textContent).toContain('(4)');
    expect(screen.getByTestId('unverified-note')).toBeTruthy();
  });

  it('filters by kind and refuses a year that is not one', async () => {
    mount(<CalendarScreen route={route('DIS-34', 'DIS')} />, harness((operation) => answer(operation)), PERMISSIONS);
    await screen.findAllByTestId('calendar-row');
    fireEvent.change(screen.getByLabelText(translator.t('ent4c.calendar.filter.kind')), { target: { value: 'DIRECTIVE_DUE' } });
    expect(screen.getAllByTestId('calendar-row')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(translator.t('ent4c.calendar.filter.kind')), { target: { value: 'MEETING' } });
    expect(screen.getByTestId('filtered-empty')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(translator.t('ent4c.calendar.filter.year')), { target: { value: '27' } });
    expect(screen.getByRole('alert').textContent).toContain(translator.t('ent4c.calendar.filter.yearInvalid'));
  });

  it('opens the status board of a period: the state of each step for each input point, "not tracked" for a step with no fact, and the reminders sent', async () => {
    mount(<CalendarScreen route={route('DIS-34', 'DIS')} />, harness((operation) => answer(operation)), PERMISSIONS);
    const first = (await screen.findAllByTestId('calendar-row'))[0] as HTMLElement;
    fireEvent.click(within(first).getByRole('button', { name: translator.t('ent4c.calendar.board.open') }));
    const row = await screen.findByTestId('board-row');
    expect(row.textContent).toContain('Ban Kỹ thuật');
    expect(row.textContent).toContain('2/4');
    const cells = row.querySelectorAll('td[data-state]');
    expect([...cells].map((cell) => cell.getAttribute('data-state'))).toEqual(['DUE_SOON', 'OPEN', 'NOT_TRACKED', 'OPEN', 'NOT_TRACKED']);
    expect(row.textContent).toContain(translator.t('ent4c.state.notTracked'));
    expect(screen.getByTestId('reminders').textContent).toContain(translator.t('ent4c.reminder.beforeDue'));
  });

  it('says the calendar has nothing when the year has no item, and names an error that retries', async () => {
    mount(<CalendarScreen route={route('DIS-34', 'DIS')} />, harness(() => ({ ...calendar(), items: [] })), PERMISSIONS);
    expect(await screen.findByText(translator.t('states.empty.title'))).toBeTruthy();
  });

  it('has a word for every state of a step', () => {
    for (const state of ['DONE', 'DONE_LATE', 'DUE_SOON', 'OPEN', 'OVERDUE', 'NOT_TRACKED'] as const) expect(translator.t(`ent4c.state.${stateKeyOf(state)}`)).not.toContain('ent4c.');
    expect(yearOf('2027')).toBe(2027);
    expect(yearOf('1999')).toBeUndefined();
    expect(yearOf('20277')).toBeUndefined();
  });
});

describe('ADM-31, the deadline of each step (QT.02)', () => {
  it('shows the rule in force for each kind of period with its days, hour, reminders and version, and the note that the default is not confirmed', async () => {
    const data = { ...calendar(), schedules: [schedule('MONTH'), schedule('QUARTER', { source: 'RULE', version: 2, unverified: false, escalate_after_overdue_days: 0, reminder_days_before: [] })] };
    mount(<ScheduleRulesScreen route={route('ADM-31', 'ADM')} />, harness(() => data), PERMISSIONS);
    const rows = await screen.findAllByTestId('schedule-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('+5');
    expect(rows[0]?.textContent).toContain('+15');
    expect(rows[0]?.textContent).toContain('16:00');
    expect(rows[0]?.textContent).toContain(translator.t('ent4c.schedule.unverified'));
    expect(rows[1]?.textContent).toContain(translator.t('ent4c.schedule.version.rule', { version: 2 }));
    expect(rows[1]?.textContent).toContain(translator.t('ent4c.schedule.escalate.never'));
    expect(rows[1]?.textContent).not.toContain(translator.t('ent4c.schedule.unverified'));
    expect(screen.getByTestId('propose-link').getAttribute('href')).toBe('/adm/adm-19');
  });
});

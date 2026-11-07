import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { RATE_READER, client, mount, routeOf, world } from '../report/test-support';
import WeeklyPlanScreen from './WeeklyPlanScreen';
import { planYearOf, standingOf, toWeeklyPlanPage } from './model';

const ROUTE = routeOf('DIS-24', 'FR-DIS-24');
const PATH = '/dis/dis-24';
const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const LEADER = '00000000-0000-4000-8000-0000000000b1';

afterEach(cleanup);

const row = (week: 40 | 41, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  project: { id: PROJECT, code: 'P-A-001', name: 'Cầu qua sông' },
  leader: { membership_id: LEADER, display_name: 'Trần Thị Bình' },
  period: { id: `00000000-0000-4000-8000-0000000000c${week - 40}`, code: `2027-W${week}`, start_date: week === 40 ? '2027-10-04' : '2027-10-11', end_date: week === 40 ? '2027-10-10' : '2027-10-17' },
  commitment_vnd: week === 40 ? '200000000' : '250000000',
  actual_vnd: week === 40 ? '120000000' : '100000000',
  difference_vnd: week === 40 ? '-80000000' : '-150000000',
  actual_from_year_start: week === 40,
  ...over,
});
const page = (items: Array<Record<string, unknown>>, next: string | null = null) => ({ plan_year: 2027, items, next_cursor: next });
const open = (weekly: Parameters<typeof world>[0] = {}, permissions = RATE_READER) => {
  const h = client(world(weekly));
  mount(<WeeklyPlanScreen route={ROUTE} />, h, { permissions, path: PATH });
  return h;
};
const asked = (h: ReturnType<typeof client>): Array<Record<string, unknown>> => h.read.mock.calls.filter((call) => call[0] === 'listWeeklyDisbursementPlans').map((call) => (call[1] as { query: Record<string, unknown> }).query);

const weeklyTable = (): Promise<HTMLElement> => screen.findByRole('table', { name: vi_['dis.weekly.table.aria'] });

describe('DIS-24 weekly disbursement plan by project', () => {
  it('AC-ST-DIS-014-1 / UAT-AC256: shows the commitments of 200 and 250 million against the 120 and 100 million the Treasury paid, the differences -80 and -150 million with their sign, and the leader in charge', async () => {
    open({ weekly: page([row(40), row(41)]) });
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.weekly.page.title'] })).toBeTruthy();
    const table = await weeklyTable();
    const first = table.querySelector('[data-period="00000000-0000-4000-8000-0000000000c0"]')?.closest('tr') as HTMLElement;
    const second = table.querySelector('[data-period="00000000-0000-4000-8000-0000000000c1"]')?.closest('tr') as HTMLElement;
    const cell = (tr: HTMLElement, name: string) => tr.querySelector(`[data-cell="${name}"]`)?.textContent;
    expect(cell(first, 'leader')).toBe('Trần Thị Bình');
    expect(cell(first, 'commitment')).toBe('200.000.000');
    expect(cell(first, 'actual')).toBe(`120.000.000${vi_['dis.weekly.actual.fromYearStart']}`);
    expect(cell(first, 'difference')).toBe('-80.000.000');
    expect(cell(second, 'commitment')).toBe('250.000.000');
    expect(cell(second, 'actual')).toBe('100.000.000');
    expect(cell(second, 'difference')).toBe('-150.000.000');
    expect(second.querySelector('[data-standing]')?.getAttribute('data-standing')).toBe('short');
    expect(screen.getByText(vi_['dis.weekly.table.note'])).toBeTruthy();
  });

  it('says a week that is not frozen has no actual yet (not zero) and no difference, and a project with no leader has none assigned; a week above its commitment is shown with a plus', async () => {
    open({ weekly: page([row(40, { actual_vnd: null, difference_vnd: null, actual_from_year_start: false, leader: null }), row(41, { actual_vnd: '300000000', difference_vnd: '50000000', actual_from_year_start: false })]) });
    const table = await weeklyTable();
    const first = table.querySelector('[data-period="00000000-0000-4000-8000-0000000000c0"]')?.closest('tr') as HTMLElement;
    expect(first.querySelector('[data-cell="actual"]')?.textContent).toBe(vi_['dis.weekly.actual.pending']);
    expect(first.querySelector('[data-cell="difference"]')?.textContent).toBe('—');
    expect(first.querySelector('[data-cell="leader"]')?.textContent).toBe(vi_['dis.weekly.leader.none']);
    const second = table.querySelector('[data-period="00000000-0000-4000-8000-0000000000c1"]')?.closest('tr') as HTMLElement;
    expect(second.querySelector('[data-cell="difference"]')?.textContent).toBe('+50.000.000');
    expect(second.querySelector('[data-standing]')?.getAttribute('data-standing')).toBe('over');
  });

  it('takes the year off with one button, and asks for the plan year it was given', async () => {
    const h = open({ weekly: page([row(40)]) });
    await weeklyTable();
    expect(screen.queryByRole('button', { name: vi_['dis.reports.filter.clear.action'] })).toBeNull();
    fireEvent.change(screen.getByLabelText(vi_['dis.weekly.filter.year']), { target: { value: '2027' } });
    await waitFor(() => expect(asked(h).some((query) => query.plan_year === 2027)).toBe(true));
    fireEvent.click(await screen.findByRole('button', { name: vi_['dis.reports.filter.clear.action'] }));
    expect((screen.getByLabelText(vi_['dis.weekly.filter.year']) as HTMLInputElement).value).toBe('');
  });

  it('is read only: it carries no button that registers or changes a commitment, only the one that loads more weeks, and it reads a page at a time by cursor', async () => {
    const h = open({ weekly: (query) => (query.cursor === undefined ? page([row(40)], 'next-page') : page([row(41)])) });
    await weeklyTable();
    // Apart from the toggle of the filter panel (shown under 980 px), the only button is the one that loads more weeks.
    expect(screen.queryAllByRole('button').map((button) => button.textContent)).toEqual([vi_['ui.filterPanel.toggle'], vi_['dis.weekly.more.action']]);
    fireEvent.click(screen.getByRole('button', { name: vi_['dis.weekly.more.action'] }));
    await waitFor(() => expect(screen.getByRole('table', { name: vi_['dis.weekly.table.aria'] }).querySelectorAll('tbody tr')).toHaveLength(2));
    expect(asked(h)).toEqual([{ limit: 50 }, { limit: 50, cursor: 'next-page' }]);
    expect(screen.queryByRole('button', { name: vi_['dis.weekly.more.action'] })).toBeNull();
  });

  it('asks for the plan year that was typed, says an invalid year is not valid before asking, and shows the refusal of the server for a query it judges invalid', async () => {
    const h = open({ weekly: page([row(40)]) });
    await weeklyTable();
    fireEvent.change(screen.getByLabelText(vi_['dis.weekly.filter.year']), { target: { value: '2028' } });
    await waitFor(() => expect(asked(h).some((query) => query.plan_year === 2028)).toBe(true));
    fireEvent.change(screen.getByLabelText(vi_['dis.weekly.filter.year']), { target: { value: '19' } });
    expect((await screen.findByText(vi_['dis.weekly.filter.year.invalid'])).getAttribute('role')).toBe('alert');
    expect(asked(h).some((query) => query.plan_year === 19)).toBe(false);
    cleanup();
    const state = world();
    state.failing.set('listWeeklyDisbursementPlans', new ApiError({ status: 422, code: 'VALIDATION_FAILED', correlationId: 'c' }));
    mount(<WeeklyPlanScreen route={ROUTE} />, client(state), { permissions: RATE_READER, path: PATH });
    expect((await screen.findByTestId('weekly-refusal')).textContent).toBe(vi_['dis.weekly.problem.validation']);
  });

  it('AC-ST-DIS-014-2 / UI-DIS-24: is in each of the seven states: loading, empty, denied, signed out, offline, error, and the table', async () => {
    const failing = (error: Error) => {
      const state = world();
      state.failing.set('listWeeklyDisbursementPlans', error);
      return client(state);
    };
    mount(<WeeklyPlanScreen route={ROUTE} />, failing(new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c' })), { permissions: RATE_READER, path: PATH });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    mount(<WeeklyPlanScreen route={ROUTE} />, failing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: RATE_READER, path: PATH });
    expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    cleanup();
    mount(<WeeklyPlanScreen route={ROUTE} />, failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: RATE_READER, path: PATH });
    expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
    cleanup();
    mount(<WeeklyPlanScreen route={ROUTE} />, failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: RATE_READER, path: PATH });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    cleanup();
    open({ weekly: page([]) });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });
});

describe('the weekly plan model', () => {
  it('reads only the rows that carry a project, a week and a whole commitment, and keeps the sign of a difference', () => {
    const read = toWeeklyPlanPage({ plan_year: 2027, items: [row(40), { project: { id: PROJECT } }, row(41, { commitment_vnd: '1.5' }), null], next_cursor: 'c' });
    expect(read.items.map((item) => item.commitmentVnd)).toEqual(['200000000']);
    expect(read.items[0]?.differenceVnd).toBe('-80000000');
    expect(read).toMatchObject({ planYear: 2027, nextCursor: 'c' });
    expect(toWeeklyPlanPage(undefined)).toEqual({ planYear: undefined, items: [], nextCursor: undefined });
  });

  it('judges the standing of a week from the sign of its difference, and the year that was typed', () => {
    expect([standingOf('-1'), standingOf('0'), standingOf('1'), standingOf(null)]).toEqual(['short', 'met', 'over', 'unknown']);
    expect([planYearOf(''), planYearOf(' 2027 '), planYearOf('1999'), planYearOf('abcd')]).toEqual([
      { year: undefined, valid: true },
      { year: '2027', valid: true },
      { year: undefined, valid: false },
      { year: undefined, valid: false },
    ]);
  });
});

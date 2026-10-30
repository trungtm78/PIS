import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import IssueListScreen from '../IssueListScreen';
import { harness as baseHarness } from '../../sas/test-support';
import { READER, mountIssue, routeOf } from '../test-support';
import IssueMatrixScreen from './IssueMatrixScreen';
import IssueProgressScreen from './IssueProgressScreen';
import { drillLink, isWeek, isoWeekOf, mondayOf, progressPercent, shiftWeek, toMatrix, vietnamDay } from './model';

const U1 = '00000000-0000-4000-8000-0000000000a1';
const U2 = '00000000-0000-4000-8000-0000000000a2';
const CATEGORY = '00000000-0000-4000-8000-0000000000b1';
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

const counts = (overrides: Record<string, number> = {}) => ({ OPEN: 0, ASSIGNED: 0, IN_PROGRESS: 0, ESCALATED: 0, PENDING_VERIFICATION: 0, CLOSED: 0, REOPENED: 0, ...overrides });
const matrix = (overrides: Record<string, unknown> = {}) => ({
  week: '2026-W20',
  from: '2026-05-11',
  to: '2026-05-17',
  statuses: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'PENDING_VERIFICATION', 'CLOSED', 'REOPENED'],
  rows: [
    { unit: { id: U1, code: 'U1', name: 'Ban quản lý 1' }, category: { version_id: CATEGORY, code: 'LAND', label: 'Giải phóng mặt bằng' }, opening: 1, opened: 3, resolved: 2, closing: 2, overdue: 1, by_status: counts({ OPEN: 1, IN_PROGRESS: 1, CLOSED: 2 }) },
    { unit: { id: U2, code: 'U2', name: 'Ban quản lý 2' }, category: { version_id: CATEGORY, code: 'LAND', label: 'Giải phóng mặt bằng' }, opening: 1, opened: 1, resolved: 0, closing: 2, overdue: 0, by_status: counts({ OPEN: 1, REOPENED: 1 }) },
  ],
  units: [
    { unit: { id: U1, code: 'U1', name: 'Ban quản lý 1' }, opening: 1, opened: 3, resolved: 2, closing: 2, overdue: 1, by_status: counts({ OPEN: 1, IN_PROGRESS: 1, CLOSED: 2 }) },
    { unit: { id: U2, code: 'U2', name: 'Ban quản lý 2' }, opening: 1, opened: 1, resolved: 0, closing: 2, overdue: 0, by_status: counts({ OPEN: 1, REOPENED: 1 }) },
  ],
  totals: { opening: 2, opened: 4, resolved: 2, closing: 4, overdue: 1, by_status: counts({ OPEN: 2, IN_PROGRESS: 1, CLOSED: 2, REOPENED: 1 }) },
  as_of: '2026-05-20T00:00:00.000Z',
  ...overrides,
});

afterEach(cleanup);

type Screen = typeof IssueMatrixScreen;

function open(Component: Screen, answer: (input: unknown) => unknown, options: { permissions?: readonly string[]; path?: string } = {}) {
  const h = baseHarness((operation, input) => (operation === 'getIssueWeeklyMatrix' ? answer(input) : new Error(`unexpected read ${operation}`)), () => ({}));
  mountIssue(<Component route={routeOf('ISS-08', 'FR-ISS-08')} />, h, { permissions: options.permissions ?? READER, path: options.path ?? '/iss/iss-08?week=2026-W20' });
  return h;
}
const queryOf = (h: ReturnType<typeof open>): Array<Record<string, string>> => h.read.mock.calls.filter((call) => call[0] === 'getIssueWeeklyMatrix').map((call) => (call[1] as { query: Record<string, string> }).query);
const hrefOf = (element: Element | null): string | null => element?.getAttribute('href') ?? null;

describe('ISS-08 the weekly matrix of the issues (ST-ISS-006, BR-ISS-08, UI-ISS-08)', () => {
  it('shows, for each unit and group, the issues raised, the opening, the handled and the closing of the week, and the totals', async () => {
    const h = open(IssueMatrixScreen, () => matrix());
    await screen.findByTestId('flows');
    expect(screen.getByTestId('range').textContent).toBe(text('iss.weekly.range.text', { week: '2026-W20', from: '2026-05-11', to: '2026-05-17' }));
    const first = document.querySelector(`[data-unit="${U1}"][data-group]`) as HTMLElement;
    expect([within(first).getByTestId('opened').textContent, within(first).getByTestId('opening').textContent, within(first).getByTestId('resolved').textContent, within(first).getByTestId('closing').textContent]).toEqual(['3', '1', '2', '2']);
    expect(within(first).getByTestId('unit').textContent).toBe('Ban quản lý 1');
    expect(within(first).getByTestId('group').textContent).toBe('Giải phóng mặt bằng');
    expect([screen.getByTestId('total-opened').textContent, screen.getByTestId('total-opening').textContent, screen.getByTestId('total-resolved').textContent, screen.getByTestId('total-closing').textContent]).toEqual(['4', '2', '2', '4']);
    expect(queryOf(h)[0]).toEqual({ week: '2026-W20' });
  });

  it('UAT-PLAN-25: counts the issues of each unit by the status they had when the week ended, and each count opens the list it counts', async () => {
    open(IssueMatrixScreen, () => matrix());
    await screen.findByTestId('statuses');
    const cellOf = (unit: string, status: string): HTMLElement => document.querySelector(`[data-testid="statuses"] tr[data-unit="${unit}"] td[data-status="${status}"]`) as HTMLElement;
    expect(cellOf(U1, 'OPEN').textContent).toBe('1');
    expect(hrefOf(cellOf(U1, 'OPEN').querySelector('a'))).toBe(`/iss/iss-01?owner_unit_id=${U1}&week=2026-W20&status=OPEN`);
    expect(cellOf(U1, 'CLOSED').textContent).toBe('2');
    expect(cellOf(U1, 'ESCALATED').textContent).toBe('0');
    expect(cellOf(U1, 'ESCALATED').querySelector('a')).toBeNull();
    expect(hrefOf(cellOf(U2, 'REOPENED').querySelector('a'))).toBe(`/iss/iss-01?owner_unit_id=${U2}&week=2026-W20&status=REOPENED`);
    // The closing of a cell counts the issues that were open, so its link keeps out the closed ones.
    expect(hrefOf(document.querySelector(`[data-unit="${U1}"][data-group] [data-testid="closing"] a`))).toBe(`/iss/iss-01?owner_unit_id=${U1}&week=2026-W20&open=true&category_version_id=${CATEGORY}`);
  });

  it('moves a week at a time and keeps the unit, reading the matrix again each time', async () => {
    const h = open(IssueMatrixScreen, () => matrix());
    await screen.findByTestId('flows');
    fireEvent.click(document.querySelector('[data-next]') as HTMLElement);
    await waitFor(() => expect(queryOf(h)).toContainEqual({ week: '2026-W21' }));
    fireEvent.click(document.querySelector('[data-previous]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-previous]') as HTMLElement);
    await waitFor(() => expect(queryOf(h)).toContainEqual({ week: '2026-W19' }));
    await waitFor(() => expect((document.getElementById('weekly-unit') as HTMLSelectElement).options.length).toBe(3));
    fireEvent.change(document.getElementById('weekly-unit') as HTMLElement, { target: { value: U2 } });
    await waitFor(() => expect(queryOf(h)).toContainEqual({ week: '2026-W19', unit_id: U2 }));
    // The units to choose from stay those of the week as a whole while one is chosen, and are read without the right to read the directory of units.
    expect((document.getElementById('weekly-unit') as HTMLSelectElement).options.length).toBe(3);
    expect(h.read.mock.calls.every((call) => call[0] === 'getIssueWeeklyMatrix')).toBe(true);
    fireEvent.click(document.querySelector('[data-next]') as HTMLElement);
    await waitFor(() => expect(queryOf(h)).toContainEqual({ week: '2026-W20', unit_id: U2 }));
  });

  it('keeps the unit that was asked for among the choices even when it has no issue in the week', async () => {
    open(IssueMatrixScreen, () => matrix(), { path: `/iss/iss-08?week=2026-W20&unit=${'00000000-0000-4000-8000-0000000000ff'}` });
    await screen.findByTestId('flows');
    const select = document.getElementById('weekly-unit') as HTMLSelectElement;
    expect(select.value).toBe('00000000-0000-4000-8000-0000000000ff');
    expect(select.options.length).toBe(4);
  });

  it('says a week that is not one is wrong, reads nothing for it, and goes on from the week that was typed', async () => {
    const h = open(IssueMatrixScreen, () => matrix(), { path: '/iss/iss-08?week=2027-W53' });
    expect((await screen.findByTestId('week-problem')).textContent).toBe(text('iss.weekly.week.invalid'));
    expect(queryOf(h)).toEqual([]);
    expect((document.querySelector('[data-next]') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(document.getElementById('weekly-week') as HTMLElement, { target: { value: '2026-W42' } });
    await waitFor(() => expect(queryOf(h)).toContainEqual({ week: '2026-W42' }));
    expect(screen.queryByTestId('week-problem')).toBeNull();
  });

  it('reads the week of today when no week is named', async () => {
    const h = open(IssueMatrixScreen, () => matrix(), { path: '/iss/iss-08' });
    await screen.findByTestId('flows');
    expect(queryOf(h)[0]).toEqual({ week: isoWeekOf(vietnamDay(new Date())) });
  });

  it('says there is nothing in a week with no issue', async () => {
    open(IssueMatrixScreen, () => matrix({ rows: [], units: [], totals: { opening: 0, opened: 0, resolved: 0, closing: 0, overdue: 0, by_status: counts() } }));
    expect((await screen.findByTestId('no-rows')).textContent).toBe(text('iss.weekly.empty.notice'));
    expect(document.querySelector('[data-testid="flows"]')).toBeNull();
  });

  it('shows the seven states: loading, denied, signed out, offline, error, and empty', async () => {
    open(IssueMatrixScreen, () => matrix());
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    cleanup();
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      open(IssueMatrixScreen, () => error);
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const nobody = open(IssueMatrixScreen, () => matrix(), { permissions: ['notification.self'] });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(queryOf(nobody)).toEqual([]);
    cleanup();
    open(IssueMatrixScreen, () => ({ rows: 3 }));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });
});

describe('ISS-06 the progress of the handling by week (ST-ISS-006, UI-ISS-06)', () => {
  it('shows each unit with the new, the overdue and the closed issues of the week and the share of what was open that was closed', async () => {
    const h = open(IssueProgressScreen, () => matrix(), { path: '/iss/iss-06?week=2026-W20' });
    await screen.findByTestId('progress');
    const row = (unit: string): HTMLElement => document.querySelector(`[data-testid="progress"] tr[data-unit="${unit}"]`) as HTMLElement;
    expect([within(row(U1)).getByTestId('new').textContent, within(row(U1)).getByTestId('overdue').textContent, within(row(U1)).getByTestId('closed').textContent, within(row(U1)).getByTestId('percent').textContent]).toEqual(['3', '1', '2', '50%']);
    expect(within(row(U2)).getByTestId('percent').textContent).toBe('0%');
    expect(hrefOf(within(row(U1)).getByRole('link'))).toBe(`/iss/iss-01?owner_unit_id=${U1}&week=2026-W20`);
    expect(queryOf(h)[0]).toEqual({ week: '2026-W20' });
  });

  it('says so for a unit that had nothing open', async () => {
    open(IssueProgressScreen, () => matrix({ units: [{ unit: { id: U1, code: 'U1', name: 'Ban quản lý 1' }, opening: 0, opened: 0, resolved: 0, closing: 0, overdue: 0, by_status: counts() }] }));
    expect((await screen.findByTestId('percent')).textContent).toBe(text('iss.weekly.progress.none'));
  });
});

describe('ISS-01 opened from a cell of the matrix', () => {
  it('asks the server for the issues of the cell, and says the list is narrowed and how to clear it', async () => {
    const h = baseHarness(() => new Error('unexpected read'), () => ({}));
    const readAll = vi.fn(() => Promise.resolve([]));
    (h.client as unknown as { readAll: unknown }).readAll = readAll;
    mountIssue(<IssueListScreen route={routeOf('ISS-01', 'FR-ISS-01')} />, h, { permissions: READER, path: `/iss/iss-01?owner_unit_id=${U1}&week=2026-W20&status=OPEN&surprise=1` });
    const notice = await screen.findByTestId('narrowed');
    expect(notice.textContent).toContain(text('iss.list.narrowed.notice', { week: '2026-W20' }));
    expect(hrefOf(within(notice).getByRole('link'))).toBe('/iss/iss-01');
    expect(readAll).toHaveBeenCalledWith('get_resources_issue', { query: { owner_unit_id: U1, status: 'OPEN', week: '2026-W20' } });
  });

  it('reads the whole list, and shows no notice, when nothing narrows it', async () => {
    const h = baseHarness(() => new Error('unexpected read'), () => ({}));
    const readAll = vi.fn(() => Promise.resolve([]));
    (h.client as unknown as { readAll: unknown }).readAll = readAll;
    mountIssue(<IssueListScreen route={routeOf('ISS-01', 'FR-ISS-01')} />, h, { permissions: READER, path: '/iss/iss-01' });
    await screen.findByTestId('empty-issues');
    expect(readAll).toHaveBeenCalledWith('get_resources_issue');
    expect(document.querySelector('[data-testid="narrowed"]')).toBeNull();
  });
});

describe('the rules of the weeks and the cells', () => {
  it('names the week of a day, and the Monday of a week', () => {
    expect(isoWeekOf('2026-10-12')).toBe('2026-W42');
    expect(isoWeekOf('2027-01-03')).toBe('2026-W53');
    expect(isoWeekOf('2025-12-29')).toBe('2026-W01');
    expect(mondayOf('2026-W42')).toBe('2026-10-12');
    expect(mondayOf('2026-W53')).toBe('2026-12-28');
    for (const bad of ['2027-W53', '2026-W00', '2026-W54', '2026-42', '1999-W10', '']) expect(mondayOf(bad)).toBeUndefined();
    expect([isWeek('2026-W20'), isWeek('x')]).toEqual([true, false]);
  });

  it('moves a week, across the end of a year', () => {
    expect(shiftWeek('2026-W42', 1)).toBe('2026-W43');
    expect(shiftWeek('2026-W42', -1)).toBe('2026-W41');
    expect(shiftWeek('2026-W53', 1)).toBe('2027-W01');
    expect(shiftWeek('2027-W01', -1)).toBe('2026-W53');
    expect(shiftWeek('not a week', 1)).toBe('not a week');
    expect(vietnamDay(new Date('2026-05-10T18:00:00Z'))).toBe('2026-05-11');
  });

  it('builds the link of a cell and the share of progress', () => {
    expect(drillLink({ unitId: U1, week: '2026-W20' })).toBe(`/iss/iss-01?owner_unit_id=${U1}&week=2026-W20`);
    expect(drillLink({ unitId: U1, week: '2026-W20', status: 'CLOSED', categoryVersionId: CATEGORY })).toBe(`/iss/iss-01?owner_unit_id=${U1}&week=2026-W20&status=CLOSED&category_version_id=${CATEGORY}`);
    expect(drillLink({ unitId: U1, week: '2026-W20', open: true })).toBe(`/iss/iss-01?owner_unit_id=${U1}&week=2026-W20&open=true`);
    expect(progressPercent({ opening: 1, opened: 3, resolved: 2 })).toBe(50);
    expect(progressPercent({ opening: 0, opened: 0, resolved: 0 })).toBeUndefined();
    expect(progressPercent({ opening: 1, opened: 0, resolved: 5 })).toBe(100);
    expect(progressPercent({ opening: 3, opened: 0, resolved: 1 })).toBe(33);
  });

  it('reads the matrix leniently', () => {
    expect(toMatrix(null)).toBeUndefined();
    expect(toMatrix({ rows: [], units: [] })).toBeUndefined();
    expect(toMatrix({ week: '2026-W20', rows: [{ unit: { id: 3 } }, { unit: { id: U1 }, category: { version_id: CATEGORY } }, null], units: [{ unit: { id: U1 } }, {}], totals: {} })).toMatchObject({
      week: '2026-W20',
      rows: [{ unit: { id: U1, name: U1 }, categoryVersionId: CATEGORY, closing: 0, byStatus: { OPEN: 0 } }],
      units: [{ unit: { id: U1 } }],
      totals: { opened: 0 },
    });
  });
});

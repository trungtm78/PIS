import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { PERIOD_ID, boardRecord, projectRow } from '../../dis/board/board-test-support';
import { RATE_READER, client, mount, period, routeOf, world } from '../../dis/report/test-support';
import type { World } from '../../dis/report/test-support';
import MonthlyTrackerScreen from './MonthlyTrackerScreen';

const ROUTE = routeOf('PRJ-13', 'FR-PRJ-13');
const PATH = '/prj/prj-13';
const MONTH = { ...period(PERIOD_ID, '2026-M09', 'OPEN'), period_type: 'MONTH', start_date: '2026-09-01', end_date: '2026-09-30' };
const WEEK = period('00000000-0000-4000-8000-0000000000e9', '2026-W01', 'OPEN');

afterEach(cleanup);

const september = projectRow('PB-0001', {
  state: 'SUBMITTED',
  overdue: false,
  report: { id: '00000000-0000-4000-8000-0000000b0001', status: 'ACCEPTED', submitted_at: '2026-10-03T03:00:00Z' },
  narrative: { results: 'Đạt 60% khối lượng', causes: 'Chờ phê duyệt thiết kế', solutions: null, proposals: 'Xin gia hạn' },
});
const nothing = projectRow('PB-0002', { narrative: null });

const open = (board: World['board'], periods = [WEEK, MONTH]) => {
  const h = client(world({ board, periods }));
  mount(<MonthlyTrackerScreen route={ROUTE} />, h, { permissions: RATE_READER, path: PATH });
  return h;
};
const asked = (h: ReturnType<typeof client>): Array<Record<string, unknown>> => h.read.mock.calls.filter((call) => call[0] === 'getSubmissionProgress').map((call) => (call[1] as { query?: Record<string, unknown> }).query ?? {});

describe('PRJ-13 monthly project follow-up', () => {
  it('AC-ST-DIS-015-2 / UAT-AC262: shows the September narrative of the project that wrote it, in its sections, and says plainly that a project that wrote nothing has no narrative', async () => {
    const h = open((query) => ({ ...boardRecord(), state: query.state, projects: [september, nothing], next_cursor: null }));
    expect(await screen.findByRole('heading', { level: 1, name: vi_['prj.monthly.page.title'] })).toBeTruthy();
    const table = await screen.findByTestId('monthly-table');
    const first = table.querySelector('tr[data-project="00000000-0000-4000-8000-000000000001"]') as HTMLElement;
    expect(Array.from(first.querySelectorAll('[data-section]')).map((node) => [node.getAttribute('data-section'), node.textContent])).toEqual([
      ['results', `${vi_['prj.monthly.section.results']}: Đạt 60% khối lượng`],
      ['causes', `${vi_['prj.monthly.section.causes']}: Chờ phê duyệt thiết kế`],
      ['proposals', `${vi_['prj.monthly.section.proposals']}: Xin gia hạn`],
    ]);
    expect(within(first).getByText(vi_['dis.board.state.submitted'])).toBeTruthy();
    const second = table.querySelector('tr[data-project="00000000-0000-4000-8000-000000000002"]') as HTMLElement;
    expect(within(second).getByText(vi_['prj.monthly.narrative.none'])).toBeTruthy();
    expect(asked(h)).toContainEqual({ limit: 100, state: 'MUST_REPORT', with_narrative: 'true' });
  });

  it('opens the month named in the address for a reader who may not list the periods', async () => {
    const h = client(world({ board: (query) => ({ ...boardRecord(), state: query.state, projects: [september], next_cursor: null }) }));
    (h.client as unknown as { readAll: unknown }).readAll = async () => {
      throw new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c' });
    };
    mount(<MonthlyTrackerScreen route={ROUTE} />, h, { permissions: ['report.read'], path: `${PATH}?period=${PERIOD_ID}` });
    expect(await screen.findByTestId('monthly-table')).toBeTruthy();
    expect((screen.getByLabelText(vi_['prj.monthly.period.label']) as HTMLSelectElement).value).toBe(PERIOD_ID);
  });

  it('offers only the months, opens on the month that has started most recently, and loads more projects by cursor', async () => {
    const h = open((query) => ({ ...boardRecord(), state: query.state, projects: query.cursor === undefined ? [september] : [], next_cursor: query.cursor === undefined ? 'more' : null }));
    const select = (await screen.findByLabelText(vi_['prj.monthly.period.label'])) as HTMLSelectElement;
    await waitFor(() => expect(within(select).queryAllByRole('option')).toHaveLength(1));
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['prj.monthly.period.option'].replace('{code}', '2026-M09').replace('{start}', '2026-09-01').replace('{end}', '2026-09-30')]);
    expect(h.read.mock.calls.some((call) => call[0] === 'getSubmissionProgress' && (call[1] as { path: { id: string } }).path.id === PERIOD_ID)).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: vi_['prj.monthly.more.action'] }));
    await waitFor(() => expect(asked(h).some((query) => query.cursor === 'more')).toBe(true));
  });

  it('is in each state of a screen: no month, no project, denied, signed out, offline and error', async () => {
    open(undefined, [WEEK]);
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    open(() => ({ ...boardRecord(), state: 'MUST_REPORT', projects: [], next_cursor: null }));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    const failing = (error: Error) => {
      const state = world({ periods: [MONTH] });
      state.failing.set('getSubmissionProgress', error);
      return client(state);
    };
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      cleanup();
      mount(<MonthlyTrackerScreen route={ROUTE} />, failing(error), { permissions: RATE_READER, path: PATH });
      expect(await screen.findByText(title)).toBeTruthy();
    }
  });
});

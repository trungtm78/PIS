import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { RATE_READER, client, mount, period, routeOf, world } from '../report/test-support';
import type { World } from '../report/test-support';
import SubmissionBoardScreen from './SubmissionBoardScreen';
import { OTHER_UNIT_ID, PERIOD_ID, UNIT_ID, answerWith, boardRecord, projectRow } from './board-test-support';
import { asDrillState, defaultPeriod, describeBoard, drillLink, drillQueryOf, toBoard } from './model';

const ROUTE = routeOf('DIS-15', 'FR-DIS-15');
const PATH = '/dis/dis-15';
const MONTH = { ...period(PERIOD_ID, '2027-M09', 'OPEN'), period_type: 'MONTH', start_date: '2027-09-01', end_date: '2027-09-30' };

afterEach(cleanup);

const open = (path: string, board: World['board'] = answerWith({}), permissions = RATE_READER) => {
  const h = client(world({ board, periods: [MONTH] }));
  mount(<SubmissionBoardScreen route={ROUTE} />, h, { permissions, path });
  return h;
};
const asked = (h: ReturnType<typeof client>): Array<Record<string, unknown>> => h.read.mock.calls.filter((call) => call[0] === 'getSubmissionProgress').map((call) => (call[1] as { query?: Record<string, unknown> }).query ?? {});

describe('DIS-15 submission progress board', () => {
  it('AC-ST-DIS-015-1 / UAT-AC263: shows for U-BQL1 must report 10, submitted 7 (1 of them late), draft 2, not started 1 and overdue 3, with a total row, and says the deadline has passed', async () => {
    open(`${PATH}?period=${PERIOD_ID}`);
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.board.page.title'] })).toBeTruthy();
    const table = await screen.findByTestId('board-table');
    const row = table.querySelector(`tr[data-unit="${UNIT_ID}"]`) as HTMLElement;
    const cell = (key: string): string => row.querySelector(`[data-cell="${key}"]`)?.textContent ?? '';
    expect([cell('MUST_REPORT'), cell('DRAFT'), cell('NOT_STARTED'), cell('OVERDUE')]).toEqual(['10', '2', '1', '3']);
    expect(cell('SUBMITTED')).toBe(`7${vi_['dis.board.late.note'].replace('{count}', '1')}`);
    const late = vi_['dis.board.late.note'].replace('{count}', '1');
    expect(Array.from(screen.getByTestId('board-total').querySelectorAll('td')).map((td) => td.textContent)).toEqual(['12', `9${late}`, '2', '1', '3']);
    expect(screen.getByTestId('board-deadline').textContent).toBe(vi_['dis.board.deadline.passed'].replace('{deadline}', '2027-10-05'));
  });

  it('every number leads to the exact projects it counted: the link carries the period, the unit and the state, and a zero is not a link', async () => {
    open(`${PATH}?period=${PERIOD_ID}`);
    const table = await screen.findByTestId('board-table');
    const link = (unit: string, key: string): string | null => table.querySelector(`tr[data-unit="${unit}"] [data-cell="${key}"] a`)?.getAttribute('href') ?? null;
    expect(link(UNIT_ID, 'OVERDUE')).toBe(`${PATH}?period=${PERIOD_ID}&state=OVERDUE&unit=${UNIT_ID}`);
    expect(link(UNIT_ID, 'MUST_REPORT')).toBe(`${PATH}?period=${PERIOD_ID}&state=MUST_REPORT&unit=${UNIT_ID}`);
    expect(link(OTHER_UNIT_ID, 'DRAFT')).toBeNull();
    expect(link(OTHER_UNIT_ID, 'OVERDUE')).toBeNull();
    // The late ones have a drill of their own: the unit row and the total row each lead to exactly the projects that came in late.
    expect(table.querySelector(`tr[data-unit="${UNIT_ID}"] [data-late-note] a`)?.getAttribute('href')).toBe(`${PATH}?period=${PERIOD_ID}&state=LATE_SUBMITTED&unit=${UNIT_ID}`);
    expect(table.querySelector(`tr[data-unit="${OTHER_UNIT_ID}"] [data-late-note]`)).toBeNull();
    expect(screen.getByTestId('board-total').querySelector('[data-late-note] a')?.getAttribute('href')).toBe(`${PATH}?period=${PERIOD_ID}&state=LATE_SUBMITTED`);
    expect(screen.getByTestId('board-total').querySelector('[data-cell="DRAFT"] a')?.getAttribute('href')).toBe(`${PATH}?period=${PERIOD_ID}&state=DRAFT`);
  });

  it('opens the list of the number that was chosen with the exact projects, their state and flags, and a link to the report', async () => {
    const h = open(`${PATH}?period=${PERIOD_ID}&state=OVERDUE&unit=${UNIT_ID}`, answerWith({ OVERDUE: [projectRow('PB-0007'), projectRow('PB-0009', { state: 'NOT_STARTED', report: null })] }));
    const list = await screen.findByTestId('drill-table');
    const rows = Array.from(list.querySelectorAll('tbody tr')) as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText(vi_['dis.board.state.draft'])).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText(vi_['dis.board.flag.overdue'])).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: vi_['dis.board.drill.report.link'] }).getAttribute('href')).toMatch(/^\/dis\/dis-07\?report=/);
    expect(within(rows[1] as HTMLElement).queryByRole('link')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: vi_['dis.board.drill.title'].replace('{state}', vi_['dis.board.state.overdue']).replace('{unit}', 'Ban quản lý 1') })).toBeTruthy();
    expect(asked(h)).toContainEqual({ limit: 100, state: 'OVERDUE', unit_id: UNIT_ID });
  });

  it('marks a project that came in late as submitted and late, not overdue, and loads more by cursor', async () => {
    const late = projectRow('PB-0001', { state: 'SUBMITTED', is_late: true, overdue: false, report: { id: '00000000-0000-4000-8000-0000000b0001', status: 'ACCEPTED', submitted_at: '2027-10-06T03:00:00Z' } });
    const h = open(`${PATH}?period=${PERIOD_ID}&state=SUBMITTED`, answerWith({ SUBMITTED: [late] }, { SUBMITTED: 'next' }));
    const list = await screen.findByTestId('drill-table');
    expect(within(list).getByText(vi_['dis.board.flag.late'])).toBeTruthy();
    expect(within(list).queryByText(vi_['dis.board.flag.overdue'])).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: vi_['dis.board.drill.more.action'] }));
    await waitFor(() => expect(asked(h).some((query) => query.cursor === 'next')).toBe(true));
  });

  it('says nothing is overdue before the deadline, and asks for the period that was chosen', async () => {
    const h = open(`${PATH}?period=${PERIOD_ID}`, () => boardRecord({ deadline_passed: false, period: { id: PERIOD_ID, code: '2027-M09', period_type: 'MONTH', start_date: '2027-09-01', end_date: '2027-09-30', deadline_at: '2099-10-05T10:00:00.000Z' } }));
    expect((await screen.findByTestId('board-deadline')).textContent).toBe(vi_['dis.board.deadline.open'].replace('{deadline}', '2099-10-05'));
    expect(h.read.mock.calls.some((call) => call[0] === 'getSubmissionProgress' && (call[1] as { path: { id: string } }).path.id === PERIOD_ID)).toBe(true);
  });

  it('loads the board of a period named in the address for a reader who may not list the periods (report.read only), and says denied only when there is no period to open', async () => {
    const state = world({ board: answerWith({}), periods: [MONTH] });
    const h = client(state);
    (h.client as unknown as { readAll: unknown }).readAll = async () => {
      throw new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c' });
    };
    mount(<SubmissionBoardScreen route={ROUTE} />, h, { permissions: ['report.read'], path: `${PATH}?period=${PERIOD_ID}` });
    expect(await screen.findByTestId('board-table')).toBeTruthy();
    expect((screen.getByLabelText(vi_['dis.board.period.label']) as HTMLSelectElement).value).toBe(PERIOD_ID);
    cleanup();
    const bare = client(world({ board: answerWith({}) }));
    (bare.client as unknown as { readAll: unknown }).readAll = async () => {
      throw new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c' });
    };
    mount(<SubmissionBoardScreen route={ROUTE} />, bare, { permissions: ['report.read'], path: PATH });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
  });

  it('opens on the period that has started most recently when none is chosen', async () => {
    const h = open(PATH);
    await screen.findByTestId('board-table');
    expect(h.read.mock.calls.some((call) => call[0] === 'getSubmissionProgress' && (call[1] as { path: { id: string } }).path.id === PERIOD_ID)).toBe(true);
  });

  it('shows the refusal of an unknown period in words, and is in each state of a screen: loading, empty, denied, signed out, offline, error', async () => {
    const missing = client(world({ board: undefined, periods: [MONTH] }));
    mount(<SubmissionBoardScreen route={ROUTE} />, missing, { permissions: RATE_READER, path: `${PATH}?period=${PERIOD_ID}` });
    expect((await screen.findByTestId('board-refusal')).textContent).toBe(vi_['dis.board.problem.notFound']);
    cleanup();
    const failing = (error: Error) => {
      const state = world({ periods: [MONTH] });
      state.failing.set('getSubmissionProgress', error);
      return client(state);
    };
    mount(<SubmissionBoardScreen route={ROUTE} />, failing(new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c' })), { permissions: RATE_READER, path: `${PATH}?period=${PERIOD_ID}` });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    mount(<SubmissionBoardScreen route={ROUTE} />, failing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: RATE_READER, path: `${PATH}?period=${PERIOD_ID}` });
    expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    cleanup();
    mount(<SubmissionBoardScreen route={ROUTE} />, failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: RATE_READER, path: `${PATH}?period=${PERIOD_ID}` });
    expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
    cleanup();
    mount(<SubmissionBoardScreen route={ROUTE} />, failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: RATE_READER, path: `${PATH}?period=${PERIOD_ID}` });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    cleanup();
    open(`${PATH}?period=${PERIOD_ID}`, () => boardRecord({ units: [], total: { must_report: 0, submitted: 0, submitted_late: 0, draft: 0, not_started: 0, overdue: 0 } }));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });
});

describe('the board model', () => {
  it('reads the board and drops what is not whole, builds the links and the query, and picks the period to open on', () => {
    expect(toBoard(undefined)).toBeUndefined();
    expect(toBoard({ period: { id: 'p' }, total: { must_report: -1 } })).toBeUndefined();
    const read = toBoard({ ...boardRecord(), projects: [projectRow('PB-0001'), { project: { id: 'x' } }] });
    expect(read?.units.map((unit) => unit.mustReport)).toEqual([10, 2]);
    expect(read?.projects).toHaveLength(1);
    expect(drillLink('p1', undefined, 'DRAFT')).toBe('/dis/dis-15?period=p1&state=DRAFT');
    expect(asDrillState('OVERDUE')).toBe('OVERDUE');
    expect(asDrillState('NOPE')).toBeUndefined();
    expect(drillQueryOf({ unitId: 'u', state: 'DRAFT', withNarrative: true }, 'c', 50)).toEqual({ limit: 50, state: 'DRAFT', unit_id: 'u', with_narrative: 'true', cursor: 'c' });
    expect(drillQueryOf({ unitId: undefined, state: 'DRAFT', withNarrative: false }, undefined, 50)).toEqual({ limit: 50, state: 'DRAFT' });
    expect(defaultPeriod([{ id: 'a', startDate: '2027-01-01' }, { id: 'b', startDate: '2027-02-01' }, { id: 'c', startDate: '2027-03-01' }], '2027-02-15')?.id).toBe('b');
    expect(defaultPeriod([{ id: 'a', startDate: '2027-05-01' }, { id: 'b', startDate: '2027-06-01' }], '2027-01-01')?.id).toBe('a');
    expect(defaultPeriod([], '2027-01-01')).toBeUndefined();
    expect([describeBoard(new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' })), describeBoard(new ApiError({ status: 422, code: 'VALIDATION_FAILED', correlationId: 'c' })), describeBoard(new Error('x'))]).toEqual(['notFound', 'validation', 'general']);
  });
});

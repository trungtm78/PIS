import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { contractId } from '../../ctr/test-support';
import { READER, client, diaryId, mount, routeOf, world } from '../diary/test-support';
import type { Harness } from '../diary/test-support';
import CoverageScreen from './CoverageScreen';
import { describeCoverage, isMonth, monthGrid, monthRange, toCoverage } from './model';

const ROUTE = routeOf('QMS-11', 'FR-QMS-11');
const word = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(cleanup);

const day = (date: string, state: string, overrides: Record<string, unknown> = {}) => ({
  date,
  state,
  diary_id: state === 'MISSING' ? null : diaryId(Number(date.slice(8, 10))),
  status: state === 'MISSING' ? null : state === 'DRAFT' ? 'DRAFT' : 'CONTRACTOR_SIGNED',
  conflict: false,
  signed_on: state === 'SIGNED' ? date : null,
  working_days_to_sign: state === 'SIGNED' ? 0 : null,
  late_days: 0,
  ...overrides,
});

// June 2026 as the server answers it for a month that is over: 22 working days, 15 signed (one late), 3 draft and 4 missing; two days have a copy in conflict.
const WORKING = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 15, 16, 17, 18, 19, 22, 23, 24, 25, 26, 29, 30];
const MISSING = [11, 18, 25, 30];
const DRAFTS = [5, 12, 19];
const date = (n: number): string => `2026-06-${String(n).padStart(2, '0')}`;
const JUNE = {
  contract_id: contractId(2),
  contract_code: 'HD-A-002',
  calendar_code: 'WORKDAY_VN',
  from: '2026-06-01',
  to: '2026-06-30',
  through: '2026-06-30',
  as_of: '2026-07-01T00:00:00.000Z',
  totals: { working_days: 22, with_diary: 18, signed: 15, draft: 3, missing: 4, late: 1, conflict: 2 },
  days: WORKING.map((n) =>
    day(date(n), MISSING.includes(n) ? 'MISSING' : DRAFTS.includes(n) ? 'DRAFT' : 'SIGNED', {
      ...(n === 4 ? { signed_on: date(10), working_days_to_sign: 4, late_days: 3 } : {}),
      ...(n === 9 || n === 10 ? { conflict: true } : {}),
    }),
  ),
  missing_dates: MISSING.map(date),
};

function open(answer: (input: unknown) => unknown, path = '/qms/qms-11'): Harness {
  const h = client(world());
  const base = h.read.getMockImplementation();
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation !== 'getDiaryCoverage') return (base?.(operation, input) as Promise<unknown>) ?? Promise.reject(new Error(`unexpected read ${operation}`));
    const found = answer(input);
    return found instanceof Error ? Promise.reject(found) : Promise.resolve(found);
  });
  mount(<CoverageScreen route={ROUTE} />, h, { permissions: READER, path });
  return h;
}

const pickContract = async (): Promise<void> => {
  const select = (await screen.findByLabelText(word('qms.coverage.field.contract'))) as HTMLSelectElement;
  await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: contractId(2) } });
};
const setMonth = (month: string): void => {
  fireEvent.change(screen.getByLabelText(word('qms.coverage.field.month')), { target: { value: month } });
};
const cell = (iso: string): HTMLElement => document.querySelector(`[data-date="${iso}"]`) as HTMLElement;

describe('CoverageScreen (QMS-11): the coverage of the site diaries', () => {
  it('UI-QMS-11, UAT-AC364: asks for a contract first, then shows the figures of the month, each working day in words and the days that are missing', async () => {
    const h = open(() => JUNE);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('qms.coverage.title'));
    expect((await screen.findByTestId('no-contract')).textContent).toBe(word('qms.coverage.noContract.notice'));
    expect(h.read.mock.calls.filter((call) => call[0] === 'getDiaryCoverage')).toHaveLength(0);
    setMonth('2026-06');
    await pickContract();
    const totals = await screen.findByTestId('totals');
    expect([...totals.querySelectorAll('[data-figure]')].map((figure) => [figure.getAttribute('data-figure'), figure.querySelector('dd')?.textContent])).toEqual([
      ['workingDays', '22'],
      ['withDiary', '18'],
      ['signed', '15'],
      ['draft', '3'],
      ['missing', '4'],
      ['late', '1'],
      ['conflict', '2'],
    ]);
    const asked = h.read.mock.calls.filter((call) => call[0] === 'getDiaryCoverage').map((call) => call[1] as { path: { id: string }; query: Record<string, string> });
    expect(asked.at(-1)).toMatchObject({ path: { id: contractId(2) }, query: { from: '2026-06-01', to: '2026-06-30' } });
    // The 11th is missing, the 5th is a draft, the 4th is signed and late, the 9th has a copy in conflict.
    expect(cell(date(11)).getAttribute('data-state')).toBe('MISSING');
    expect(cell(date(11)).textContent).toContain(word('qms.coverage.state.missing'));
    expect(cell(date(5)).textContent).toContain(word('qms.coverage.state.draft'));
    expect(cell(date(4)).textContent).toContain(word('qms.coverage.state.signed'));
    expect(cell(date(4)).textContent).toContain(word('qms.coverage.day.late', { days: 3 }));
    expect(cell(date(9)).textContent).toContain(word('qms.coverage.day.conflict'));
    expect(cell(date(2)).textContent).not.toContain(word('qms.coverage.day.late', { days: 0 }));
    // A Saturday and a Sunday are left blank, with the number of the day only.
    expect(cell(date(6)).textContent).toBe('6');
    expect(cell(date(7)).getAttribute('data-state')).toBeNull();
    const missing = screen.getByTestId('missing');
    expect(within(missing).getAllByRole('listitem').map((item) => item.textContent)).toEqual(MISSING.map(date));
    // The calendar has the seven days of the week as columns and opens a draft to write and a signed diary to review.
    const table = screen.getByTestId('calendar');
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((name) => word(`qms.coverage.weekday.${name}`)));
    expect(within(cell(date(5))).getByRole('link').getAttribute('href')).toBe(`/qms/qms-02?diary=${diaryId(5)}`);
    expect(within(cell(date(4))).getByRole('link').getAttribute('href')).toBe(`/qms/qms-03?diary=${diaryId(4)}`);
    expect(within(cell(date(11))).queryByRole('link')).toBeNull();
  });

  it('names the contract by its identifier when the register of contracts cannot be read, and asks only for an identifier that is one', async () => {
    const h = client(world({ failing: new Set(['get_resources_contract']) }));
    const base = h.read.getMockImplementation();
    h.read.mockImplementation((operation: string, input?: unknown) => (operation === 'getDiaryCoverage' ? Promise.resolve(JUNE) : ((base?.(operation, input) as Promise<unknown>) ?? Promise.reject(new Error('unexpected read')))));
    (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = () => Promise.reject(new Error('forbidden'));
    mount(<CoverageScreen route={ROUTE} />, h, { permissions: READER, path: '/qms/qms-11' });
    await waitFor(() => expect(screen.queryByLabelText(word('qms.coverage.field.contract'))).toBeNull());
    const field = screen.getByLabelText(word('qms.coverage.field.contractId')) as HTMLInputElement;
    expect(screen.getByText(word('qms.coverage.field.contract.hint'))).toBeTruthy();
    fireEvent.change(field, { target: { value: 'not an identifier' } });
    expect(await screen.findByText(word('qms.coverage.field.contract.error'))).toBeTruthy();
    expect(h.read.mock.calls.filter((call) => call[0] === 'getDiaryCoverage')).toHaveLength(0);
    fireEvent.change(field, { target: { value: ` ${contractId(2).toUpperCase()} ` } });
    await screen.findByTestId('totals');
    expect((h.read.mock.calls.filter((call) => call[0] === 'getDiaryCoverage').at(-1)?.[1] as { path: { id: string } }).path.id).toBe(contractId(2));
  });

  it('keeps the identifier next to the list: a contract the diaries reach and the register does not is named by it', async () => {
    const h = open(() => JUNE);
    await pickContract();
    const field = screen.getByLabelText(word('qms.coverage.field.contractId')) as HTMLInputElement;
    expect(field.value).toBe(contractId(2));
    const outside = '00000000-0000-4000-8000-0000000000f9';
    fireEvent.change(field, { target: { value: outside } });
    await waitFor(() => expect((h.read.mock.calls.filter((call) => call[0] === 'getDiaryCoverage').at(-1)?.[1] as { path: { id: string } }).path.id).toBe(outside));
    expect((screen.getByLabelText(word('qms.coverage.field.contract')) as HTMLSelectElement).value).toBe('');
  });

  it('starts with the contract the address names', async () => {
    const h = open(() => JUNE, `/qms/qms-11?contract=${contractId(2)}`);
    await screen.findByTestId('totals');
    expect((h.read.mock.calls.filter((call) => call[0] === 'getDiaryCoverage').at(-1)?.[1] as { path: { id: string } }).path.id).toBe(contractId(2));
  });

  it('asks again when the month changes, and does not ask for a month that is not one', async () => {
    const h = open(() => JUNE);
    await pickContract();
    setMonth('2026-06');
    await screen.findByTestId('totals');
    const before = h.read.mock.calls.filter((call) => call[0] === 'getDiaryCoverage').length;
    setMonth('2026-05');
    await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'getDiaryCoverage').length).toBeGreaterThan(before));
    expect((h.read.mock.calls.filter((call) => call[0] === 'getDiaryCoverage').at(-1)?.[1] as { query: Record<string, string> }).query).toEqual({ from: '2026-05-01', to: '2026-05-31' });
    const asked = h.read.mock.calls.filter((call) => call[0] === 'getDiaryCoverage').length;
    setMonth('');
    expect(await screen.findByText(word('qms.coverage.field.month.error'))).toBeTruthy();
    expect(h.read.mock.calls.filter((call) => call[0] === 'getDiaryCoverage')).toHaveLength(asked);
  });

  it('says in words that a month to come has no working day to count, and lists no missing day when none is missing', async () => {
    open(() => ({ ...JUNE, through: null, totals: { working_days: 0, with_diary: 0, signed: 0, draft: 0, missing: 0, late: 0, conflict: 0 }, days: [], missing_dates: [] }));
    await pickContract();
    expect((await screen.findByTestId('not-yet')).textContent).toBe(word('qms.coverage.notYet.notice'));
    expect(screen.queryByTestId('missing')).toBeNull();
  });

  it.each([
    ['RESOURCE_NOT_FOUND', 404, 'notFound'],
    ['CALENDAR_NOT_EFFECTIVE', 422, 'noCalendar'],
    ['VALIDATION_FAILED', 422, 'validation'],
  ] as const)('says in words why the server refused with %s', async (code, status, problem) => {
    open(() => new ApiError({ status, code, correlationId: 'c' }));
    await pickContract();
    expect((await screen.findByTestId('coverage-refusal')).textContent).toBe(word(`qms.coverage.problem.${problem}`));
  });

  it('offers a retry for a failure it can say nothing of', async () => {
    const h = open(() => new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }));
    await pickContract();
    fireEvent.click(await screen.findByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'getDiaryCoverage').length).toBeGreaterThanOrEqual(2));
  });
});

describe('the model of QMS-11', () => {
  it('reads the answer of the server and leaves out what is not a day', () => {
    expect(toCoverage(undefined)).toBeUndefined();
    expect(toCoverage({ from: '2026-06-01' })).toBeUndefined();
    const read = toCoverage({ ...JUNE, days: [null, { date: 'x' }, day(date(1), 'WHATEVER'), day(date(2), 'SIGNED', { late_days: -3 }), day(date(3), 'DRAFT')], missing_dates: ['2026-06-11', 5], totals: { working_days: '22' } });
    expect(read?.days.map((entry) => [entry.date, entry.state, entry.lateDays])).toEqual([
      [date(2), 'SIGNED', 0],
      [date(3), 'DRAFT', 0],
    ]);
    expect(read?.missingDates).toEqual(['2026-06-11']);
    expect(read?.totals.workingDays).toBe(0);
    expect(toCoverage({ from: '2026-06-01', to: '2026-06-30' })).toMatchObject({ contractCode: '', through: null, days: [], missingDates: [] });
  });

  it('knows a month, its range and its weeks from Monday to Sunday', () => {
    expect(isMonth('2026-06')).toBe(true);
    for (const value of ['', '2026-6', '2026-13', '2026-00', '06-2026']) expect(isMonth(value)).toBe(false);
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2028-02').to).toBe('2028-02-29');
    const weeks = monthGrid('2026-06', toCoverage(JUNE)?.days ?? []);
    expect(weeks).toHaveLength(5);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    // 1 June 2026 is a Monday and 30 June a Tuesday: the first week starts full, the last has five blanks.
    expect(weeks[0]?.[0]?.date).toBe('2026-06-01');
    expect(weeks.at(-1)?.filter((entry) => entry === null)).toHaveLength(5);
    expect(weeks[0]?.[0]?.day).toMatchObject({ state: 'SIGNED' });
    expect(weeks[0]?.[5]?.day).toBeUndefined();
    const may = monthGrid('2026-05', []);
    expect(may[0]?.filter((entry) => entry === null)).toHaveLength(4);
  });

  it('reads anything but an error of the server as a general failure', () => {
    expect(describeCoverage(new Error('boom'))).toBe('general');
    expect(describeCoverage(new ApiError({ status: 418, code: 'TEAPOT', correlationId: 'c' }))).toBe('general');
  });
});

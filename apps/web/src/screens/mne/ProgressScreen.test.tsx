import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ProgressScreen from './ProgressScreen';
import { progressOf, summarize, worstFirst } from './progress-model';
import type { ObligationView } from './types';
import { READER, harness, mount, obligationRow, routeOf } from './test-support';

const ROUTE = routeOf('MNE-09', 'FR-MNE-09');
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const page = (items: unknown[], cursor: string | null = null) => ({ items, next_cursor: cursor, as_of: '2026-07-15' });
const answer = (reply: unknown) => (operation: string) => (operation === 'listMneObligations' ? reply : new Error(`unexpected read ${operation}`));
const idOf = (row: { mne_report_id: string }): string => row.mne_report_id;

// The three units of the acceptance criterion: the deadline is 2026-07-10 and today is 2026-07-15.
const U1 = obligationRow(1, { unit_code: 'U1', unit_name: 'Đơn vị 1', due_date: '2026-07-10', status: 'SUBMITTED_EXTERNAL', filed_on: '2026-07-09', is_late: false, days_late: 0, rule_revision: 2 });
const U2 = obligationRow(2, { unit_code: 'U2', unit_name: 'Đơn vị 2', due_date: '2026-07-10', status: 'SUBMITTED_EXTERNAL', filed_on: '2026-07-12', is_late: true, days_late: 2, rule_revision: 2 });
const U3 = obligationRow(3, { unit_code: 'U3', unit_name: 'Đơn vị 3', due_date: '2026-07-10', status: 'DRAFT', filed_on: null, is_late: true, days_late: 5, rule_revision: 2 });
const WAITING = obligationRow(4, { unit_code: 'U4', unit_name: 'Đơn vị 4', due_date: '2027-02-10', period_label: 'YEAR-2026', status: 'DRAFT', filed_on: null, is_late: false, days_late: 0, rule_code: 'OVERALL_ANNUAL' });
const ROWS = [U1, U2, U3, WAITING];

afterEach(cleanup);

describe('MNE-09 filing progress (ST-MNE-006, MNE F2, BR-MNE-04)', () => {
  it('AC-ST-MNE-006-1: UAT-AC293 shows U1 on time, U2 two days late and U3 five days late to date, in words and with the numbers', async () => {
    mount(<ProgressScreen route={ROUTE} />, harness(answer(page(ROWS))), { permissions: READER });
    expect(await screen.findByTestId(`progress-${idOf(U1)}`)).toBeTruthy();
    expect(screen.getByTestId(`progress-${idOf(U1)}`).textContent).toBe(vi_['mne.progress.status.onTime']);
    expect(screen.getByTestId(`progress-${idOf(U2)}`).textContent).toBe(fill(vi_['mne.progress.status.late'], { days: 2 }));
    expect(screen.getByTestId(`progress-${idOf(U3)}`).textContent).toBe(fill(vi_['mne.progress.status.openLate'], { days: 5 }));
    expect(screen.getByTestId(`progress-${idOf(WAITING)}`).textContent).toBe(vi_['mne.progress.status.open']);
    // The day of the filing is shown, and "not filed" says so.
    const row = (item: { mne_report_id: string }) => within(screen.getByTestId(`rule-${idOf(item)}`).closest('tr') as HTMLElement);
    expect(row(U1).getByText('2026-07-09')).toBeTruthy();
    expect(row(U2).getByText('2026-07-12')).toBeTruthy();
    expect(row(U3).getByText(vi_['mne.progress.filed.none'])).toBeTruthy();
    // The lateness is a kind of row, for assistive technology and for the eye, and never only a colour.
    expect(screen.getByTestId(`progress-${idOf(U2)}`).getAttribute('data-progress')).toBe('LATE');
    expect(screen.getByTestId(`progress-${idOf(U3)}`).getAttribute('data-progress')).toBe('OPEN_LATE');
    // An open filing that is already late carries the urgent stripe of the table; the rest carry none.
    expect(screen.getByTestId(`progress-${idOf(U3)}`).closest('tr')?.getAttribute('data-severity')).toBe('URGENT');
    expect(screen.getByTestId(`progress-${idOf(U2)}`).closest('tr')?.getAttribute('data-severity')).toBeNull();
  });

  it('AC-ST-MNE-006-2: UAT-AC299 shows the version of the rule each obligation follows', async () => {
    mount(<ProgressScreen route={ROUTE} />, harness(answer(page(ROWS))), { permissions: READER });
    await screen.findByTestId(`rule-${idOf(U1)}`);
    expect(screen.getByTestId(`rule-${idOf(U1)}`).textContent).toBe(fill(vi_['mne.progress.rule.text'], { code: 'OVERALL_SEMIANNUAL', revision: 2 }));
    expect(screen.getByTestId(`rule-${idOf(WAITING)}`).textContent).toBe(fill(vi_['mne.progress.rule.text'], { code: 'OVERALL_ANNUAL', revision: 1 }));
  });

  it('counts every obligation in the summary, by what became of it, and says the open ones are counted to today', async () => {
    mount(<ProgressScreen route={ROUTE} />, harness(answer(page(ROWS))), { permissions: READER });
    const summary = await screen.findByTestId('progress-summary');
    const text = summary.textContent ?? '';
    for (const sentence of [
      fill(vi_['mne.progress.summary.total'], { count: 4 }),
      fill(vi_['mne.progress.summary.onTime'], { count: 1 }),
      fill(vi_['mne.progress.summary.late'], { count: 1 }),
      fill(vi_['mne.progress.summary.openLate'], { count: 1 }),
      fill(vi_['mne.progress.summary.open'], { count: 1 }),
    ]) {
      expect(text).toContain(sentence);
    }
    expect(screen.getByTestId('progress-today').textContent).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('lists the late ones first, the longest first, and only them when asked', async () => {
    const user = userEvent.setup();
    mount(<ProgressScreen route={ROUTE} />, harness(answer(page(ROWS))), { permissions: READER });
    await screen.findByTestId(`progress-${idOf(U1)}`);
    const order = (): string[] => Array.from(document.querySelectorAll('tbody tr')).map((tr) => (tr.querySelector('[data-testid^="rule-"]')?.getAttribute('data-testid') ?? '').slice('rule-'.length));
    expect(order()).toEqual([idOf(U3), idOf(U2), idOf(U1), idOf(WAITING)]);
    await user.click(screen.getByLabelText(vi_['mne.progress.filter.late']));
    expect(order()).toEqual([idOf(U3), idOf(U2)]);
  });

  it('reads the year the person chose, and reads the next pages so that the summary counts the whole year', async () => {
    const user = userEvent.setup();
    const year = Number(new Date().toISOString().slice(0, 4));
    const h = harness((operation, input) => {
      if (operation !== 'listMneObligations') return new Error('unexpected read');
      const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
      return cursor === undefined ? page([U1, U2], 'next-page') : page([U3, WAITING]);
    });
    mount(<ProgressScreen route={ROUTE} />, h, { permissions: READER });
    await screen.findByTestId(`progress-${idOf(U3)}`);
    expect(screen.getByTestId('progress-summary').textContent).toContain(fill(vi_['mne.progress.summary.total'], { count: 4 }));
    const queries = () => h.read.mock.calls.filter((call) => call[0] === 'listMneObligations').map((call) => (call[1] as { query: Record<string, unknown> }).query);
    expect(queries()[0]).toMatchObject({ report_year: String(year) });
    await user.selectOptions(screen.getByLabelText(vi_['mne.calendar.filter.year.label']), String(year + 1));
    await waitFor(() => expect(queries().at(-1)).toMatchObject({ report_year: String(year + 1) }));
  });

  it('says a late filing that has no day on record is late, without a number', async () => {
    const old = obligationRow(5, { status: 'SUBMITTED_EXTERNAL', filed_on: null, is_late: true, days_late: null });
    mount(<ProgressScreen route={ROUTE} />, harness(answer(page([old]))), { permissions: READER });
    expect((await screen.findByTestId(`progress-${idOf(old)}`)).textContent).toBe(vi_['mne.progress.status.lateUnknown']);
    // It was filed: the cell of the day says the day is not known, and not that it was not filed.
    expect(screen.getByTestId(`filed-${idOf(old)}`).textContent).toBe(vi_['mne.progress.filed.unknown']);
  });

  describe('the seven standard states', () => {
    it.each([
      ['empty', page([]), vi_['states.empty.title']],
      ['denied', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
      ['signed out', new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
    ])('UI-MNE-09 shows the %s state and keeps the filters', async (_name, reply, title) => {
      mount(<ProgressScreen route={ROUTE} />, harness(answer(reply)), { permissions: READER });
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByLabelText(vi_['mne.calendar.filter.year.label'])).toBeTruthy();
    });

    it('UI-MNE-09 shows the loading state first and names the page for assistive technology', () => {
      mount(<ProgressScreen route={ROUTE} />, harness(() => new Promise(() => undefined)));
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['mne.progress.page.title'] })).toBeTruthy();
    });

    it('UI-MNE-09 names every field of the default state and retries after an error', async () => {
      mount(<ProgressScreen route={ROUTE} />, harness(answer(page(ROWS))), { permissions: READER });
      await screen.findByTestId(`progress-${idOf(U1)}`);
      for (const control of [...screen.getAllByRole('combobox'), ...screen.getAllByRole('checkbox')]) expect((control as HTMLInputElement).labels?.length).toBeGreaterThan(0);
      cleanup();
      let failing = true;
      const h = harness(() => (failing ? new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) : page(ROWS)));
      mount(<ProgressScreen route={ROUTE} />, h);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId(`progress-${idOf(U1)}`)).toBeTruthy();
    });
  });
});

describe('the progress of an obligation', () => {
  it('judges a filed report by the day it was filed and an open one by today', () => {
    expect(progressOf({ status: 'SUBMITTED_EXTERNAL', filedOn: '2026-07-09', isLate: false, daysLate: 0 })).toEqual({ kind: 'ON_TIME', days: 0 });
    expect(progressOf({ status: 'SUBMITTED_EXTERNAL', filedOn: '2026-07-12', isLate: true, daysLate: 2 })).toEqual({ kind: 'LATE', days: 2 });
    expect(progressOf({ status: 'DRAFT', filedOn: null, isLate: true, daysLate: 5 })).toEqual({ kind: 'OPEN_LATE', days: 5 });
    expect(progressOf({ status: 'APPROVED', filedOn: null, isLate: false, daysLate: 0 })).toEqual({ kind: 'OPEN', days: 0 });
    // A first revision that a correction superseded is filed when the correction was.
    expect(progressOf({ status: 'SUPERSEDED', filedOn: '2026-07-09', isLate: false, daysLate: 0 }).kind).toBe('ON_TIME');
    expect(progressOf({ status: 'SUPERSEDED', filedOn: null, isLate: true, daysLate: 9 }).kind).toBe('OPEN_LATE');
  });

  it('counts by kind and orders the late ones, the longest first', () => {
    const items: Array<Pick<ObligationView, 'status' | 'filedOn' | 'isLate' | 'daysLate' | 'dueDate'>> = [
      { status: 'SUBMITTED_EXTERNAL', filedOn: '2026-07-09', isLate: false, daysLate: 0, dueDate: '2026-07-10' },
      { status: 'DRAFT', filedOn: null, isLate: true, daysLate: 5, dueDate: '2026-07-10' },
      { status: 'SUBMITTED_EXTERNAL', filedOn: '2026-07-12', isLate: true, daysLate: 2, dueDate: '2026-07-10' },
      { status: 'DRAFT', filedOn: null, isLate: false, daysLate: 0, dueDate: '2026-08-10' },
    ];
    expect(summarize(items)).toEqual({ total: 4, onTime: 1, late: 1, openLate: 1, open: 1 });
    expect(worstFirst(items).map((item) => item.daysLate)).toEqual([5, 2, 0, 0]);
  });
});

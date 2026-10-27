import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import MyWorkScreen from './MyWorkScreen';
import { inBucket, pathOf, toWorkPage } from './work-model';

const ROUTE = routeOf('HOME-02', 'FR-HOME-02');
const READER = ['home.read'];
const E1 = '00000000-0000-4000-8000-000000000e01';
const E2 = '00000000-0000-4000-8000-000000000e02';
const E3 = '00000000-0000-4000-8000-000000000e03';
const R1 = '00000000-0000-4000-8000-000000000d01';
const T1 = '00000000-0000-4000-8000-000000000f01';

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

const work = (id: string, kind: string, bucket: string, overrides: Record<string, unknown> = {}) => ({
  id,
  kind,
  title: `Task ${id.slice(-3)}`,
  subtitle: 'HM-001',
  status: 'REQUESTED',
  due_on: '2027-10-18',
  original_due_on: '2027-10-18',
  bucket,
  overdue: bucket === 'OVERDUE',
  days_late: 0,
  target: { screen: kind === 'EXPLANATION' ? 'PRJ-19' : kind === 'APPROVAL' ? 'ADM-06' : 'DIS-03', id },
  ...overrides,
});
const page = (items: unknown[], counts: Record<string, number> = {}, cursor: string | null = null) => ({ items, counts: { total: items.length, overdue: 0, ...counts }, next_cursor: cursor, as_of: '2027-10-15T03:00:00Z' });

afterEach(cleanup);

describe('HOME-02 my work (ST-HOME-004, HOME 3 F5)', () => {
  it('AC-ST-HOME-004-1: UAT-AC272 shows the 3 explanations, the late one in the late column with the day it was first asked for, and the way to PRJ-19', async () => {
    const items = [
      work(E3, 'EXPLANATION', 'OVERDUE', { status: 'OVERDUE', due_on: '2027-10-12', original_due_on: '2027-10-01', days_late: 3 }),
      work(E1, 'EXPLANATION', 'NEAR'),
      work(E2, 'EXPLANATION', 'LATER', { due_on: '2027-11-30', original_due_on: '2027-11-30' }),
    ];
    mount(<MyWorkScreen route={ROUTE} />, harness(() => page(items, { EXPLANATION: 3, overdue: 1 })), { permissions: READER });
    const summary = await screen.findByTestId('work-summary');
    expect(within(summary).getByRole('heading').textContent).toBe(fill(vi_['home.work.summary.title'], { total: 3, overdue: 1 }));
    expect(summary.querySelector('[data-kind="EXPLANATION"]')?.textContent).toContain('3');
    const late = document.querySelector('[data-bucket="OVERDUE"]') as HTMLElement;
    expect(within(late).getAllByRole('listitem')).toHaveLength(1);
    expect(within(late).getByTestId(`due-${E3}`).textContent).toBe(`${fill(vi_['home.work.due.on'], { date: '2027-10-12' })}, ${fill(vi_['home.work.due.late'], { days: 3 })}, ${fill(vi_['home.work.due.original'], { date: '2027-10-01' })}`);
    expect(within(late).getByRole('link').getAttribute('href')).toBe('/prj/prj-19');
    // The ones that are not late have no mention of lateness, and a day that was not moved has no "first due".
    expect(screen.getByTestId(`due-${E1}`).textContent).toBe(fill(vi_['home.work.due.on'], { date: '2027-10-18' }));
    expect(inBucket(toWorkPage(page(items)).items, 'LATER')).toHaveLength(1);
  });

  it('AC-ST-HOME-004-2: UAT-AC272 shows a report that came back and an approval that waits, each in its kind, and opens the report where it is edited', async () => {
    const items = [work(R1, 'REPORT_RETURNED', 'OVERDUE', { status: 'RETURNED', title: 'W-1', days_late: 5 }), work(T1, 'APPROVAL', 'NEAR', { title: 'reallocation_proposal' })];
    mount(<MyWorkScreen route={ROUTE} />, harness(() => page(items, { REPORT_RETURNED: 1, APPROVAL: 1, overdue: 1 })), { permissions: READER });
    const board = await screen.findByTestId('work-board');
    const report = board.querySelector(`[data-item-id="${R1}"]`) as HTMLElement;
    expect(within(report).getByText(vi_['home.work.kind.reportReturned'])).toBeTruthy();
    expect(within(report).getByRole('link').getAttribute('href')).toBe(`/dis/dis-03?report=${R1}`);
    // The approval waits in the near column; its module has no screen of its own to open it from yet, so there is no link to nowhere.
    const approval = board.querySelector(`[data-item-id="${T1}"]`) as HTMLElement;
    expect(within(approval).getByText(vi_['home.work.kind.approval'])).toBeTruthy();
    expect(within(approval).queryByRole('link')).toBeNull();
  });

  it('says a task that has no day has none, and reads the next page', async () => {
    const user = userEvent.setup();
    const h = harness((_operation, input) => ((input as { query?: { cursor?: string } }).query?.cursor === 'next' ? page([work(E2, 'MNE_OBLIGATION', 'LATER')]) : page([work(T1, 'APPROVAL', 'LATER', { due_on: null, original_due_on: null })], {}, 'next')));
    mount(<MyWorkScreen route={ROUTE} />, h, { permissions: READER });
    expect((await screen.findByTestId(`due-${T1}`)).textContent).toBe(vi_['home.work.due.none']);
    await user.click(screen.getByRole('button', { name: vi_['home.work.more'] }));
    await waitFor(() => expect(document.querySelector(`[data-item-id="${E2}"]`)).toBeTruthy());
    expect(h.read.mock.calls.at(-1)?.[1]).toMatchObject({ query: { cursor: 'next' } });
  });

  it('says the list and the counts are a part only when the server says a source was cut, and says nothing otherwise', async () => {
    mount(<MyWorkScreen route={ROUTE} />, harness(() => ({ ...page([work(E1, 'EXPLANATION', 'NEAR')]), truncated: true })), { permissions: READER });
    expect((await screen.findByTestId('work-truncated')).textContent).toBe(vi_['home.work.truncated']);
    cleanup();
    mount(<MyWorkScreen route={ROUTE} />, harness(() => ({ ...page([work(E1, 'EXPLANATION', 'NEAR')]), truncated: false })), { permissions: READER });
    await screen.findByTestId('work-board');
    expect(screen.queryByTestId('work-truncated')).toBeNull();
  });

  describe('the seven standard states', () => {
    it.each([
      ['empty', page([]), vi_['states.empty.title']],
      ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
      ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
    ])('UI-HOME-02 shows the %s state', async (_name, reply, title) => {
      mount(<MyWorkScreen route={ROUTE} />, harness(() => reply), { permissions: READER });
      expect(await screen.findByText(title)).toBeTruthy();
    });

    it('UI-HOME-02 shows the loading state first, names the page, and retries after an error', async () => {
      mount(<MyWorkScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), { permissions: READER });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['home.work.page.title'] })).toBeTruthy();
      cleanup();
      let failing = true;
      mount(<MyWorkScreen route={ROUTE} />, harness(() => (failing ? failure(500, 'INTERNAL_ERROR') : page([work(E1, 'EXPLANATION', 'NEAR')]))), { permissions: READER });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('work-board')).toBeTruthy();
    });
  });
});

describe('the work as the screen reads it', () => {
  it('leaves out an entry that lacks its id, its kind, its column or its target, and reads the counts as they are', () => {
    const read = toWorkPage({ items: [work(E1, 'EXPLANATION', 'NEAR'), { ...work(E2, 'GUESS', 'NEAR') }, { ...work(E3, 'EXPLANATION', 'SOON') }, { ...work(R1, 'EXPLANATION', 'NEAR'), target: {} }, { ...work('', 'EXPLANATION', 'NEAR') }], counts: { total: 5, overdue: 'x' }, next_cursor: 'n' });
    expect(read.items.map((item) => item.id)).toEqual([E1]);
    expect(read.counts).toEqual({ total: 5, overdue: 0 });
    expect(read.nextCursor).toBe('n');
  });

  it('opens a task in the screen of its module, and says there is none where the module has no screen to open it from', () => {
    expect([pathOf({ target: { screen: 'PRJ-19', id: 'x' } }), pathOf({ target: { screen: 'DIS-03', id: 'x' } }), pathOf({ target: { screen: 'MNE-03', id: 'x' } }), pathOf({ target: { screen: 'ADM-06', id: 'x' } })]).toEqual(['/prj/prj-19', '/dis/dis-03?report=x', '/mne/mne-03?report=x', undefined]);
  });
});

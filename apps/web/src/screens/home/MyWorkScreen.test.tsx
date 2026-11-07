import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as tr } from '../../i18n';
import { harness, mount, routeOf } from '../mne/test-support';
import MyWorkScreen from './MyWorkScreen';
import { pathOf, toWorkPage } from './work-model';

const ROUTE = routeOf('HOME-02', 'FR-HOME-02');
const READER = ['home.read'];
const E1 = '00000000-0000-4000-8000-000000000e01';
const E2 = '00000000-0000-4000-8000-000000000e02';
const E3 = '00000000-0000-4000-8000-000000000e03';
const R1 = '00000000-0000-4000-8000-000000000d01';

const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

const item = (id: string, severity: string, overrides: Record<string, unknown> = {}) => ({
  id,
  kind: 'PERMIT',
  source: 'PERMIT',
  severity,
  title: `Việc ${id.slice(-3)}`,
  subtitle: 'DA-DT205',
  status: 'OPEN',
  due_on: '2999-12-31',
  original_due_on: '2999-12-31',
  bucket: 'LATER',
  overdue: false,
  days_late: 0,
  target: { screen: 'PRJ-19', id },
  lifecycle: 'NEW',
  claimed_by: null,
  assignee: null,
  escalation: null,
  consequence: null,
  snoozed_until: null,
  ...overrides,
});

const sum = (items: Array<{ severity: string }>) => ({ urgent: items.filter((entry) => entry.severity === 'URGENT').length, action: items.filter((entry) => entry.severity === 'ACTION').length, watch: items.filter((entry) => entry.severity === 'WATCH').length, total: items.length });
const list = (view: string, items: Array<{ severity: string }>, extra: Record<string, unknown> = {}) => ({ view, items, counts: sum(items), unavailable_sources: [], as_of: '2026-11-07T02:15:00Z', next_cursor: null, ...extra });
const counts = (view: string, items: Array<{ severity: string }>, extra: Record<string, unknown> = {}) => ({ view, counts: sum(items), unavailable_sources: [], as_of: '2026-11-07T02:15:00Z', ...extra });

const viewOf = (input: unknown): string => (input as { query?: { view?: string } } | undefined)?.query?.view ?? 'mine';

/** The same source as the bell: `getMyWork` and `getMyWorkCounts`, by view; a view that is not given is refused (403). */
function backend(views: Partial<Record<'mine' | 'scope', { items: Array<{ severity: string }>; extra?: Record<string, unknown> }>>) {
  return (operation: string, input: unknown): unknown => {
    const entry = views[viewOf(input) as 'mine' | 'scope'];
    if (entry === undefined) return failure(403, 'FORBIDDEN');
    if (operation === 'getMyWorkCounts') return counts(viewOf(input), entry.items, entry.extra);
    if (operation === 'getMyWork') return list(viewOf(input), entry.items, entry.extra);
    return new Error(`unexpected read ${operation}`);
  };
}

const exact = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="queue-list"] [data-item-id]'));

// The screens read several sources at once; under the load of a whole run the default second is too short to prove them wrong.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });

afterEach(cleanup);

describe('HOME-02 my work: the full queue of the alert source (ST-HOME-004)', () => {
  it('AC-ST-HOME-004-1: UAT-AC272 shows the rows of the queue with their severity, deadline, escalation and actions, and names the page', async () => {
    const items = [
      item(E1, 'URGENT', { title: 'Giấy phép hết hạn', due_on: '2000-01-01', days_late: 3, overdue: true, escalation: { level: 2, of: 3, next_at: null, chain: ['Trưởng phòng', 'Giám đốc'] } }),
      item(E2, 'ACTION', { title: 'Báo cáo tuần 40' }),
    ];
    mount(<MyWorkScreen route={ROUTE} />, harness(backend({ mine: { items }, scope: { items } })), { permissions: READER });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByRole('region', { name: tr('home.queue.title') })).toBeTruthy();
    const urgent = rows()[0] as HTMLElement;
    expect(within(urgent).getByText(tr('alerts.severity.urgent'))).toBeTruthy();
    expect(within(urgent).getByText(fill(tr('alerts.deadline.late'), { days: 3 }))).toBeTruthy();
    expect(urgent.textContent).toContain(fill(tr('alerts.escalation.level'), { level: 2, of: 3 }));
    expect(within(urgent).getByRole('link', { name: new RegExp('Giấy phép hết hạn') }).getAttribute('href')).toBe('/prj/prj-19');
    // An urgent item is claimed or given but not snoozed.
    expect(within(urgent).getByRole('button', { name: tr('alerts.action.claim') })).toBeTruthy();
    expect(within(urgent).queryByRole('button', { name: tr('alerts.action.snooze') })).toBeNull();
    expect(within(rows()[1] as HTMLElement).getByRole('button', { name: tr('alerts.action.snooze') })).toBeTruthy();
  });

  it('AC-ST-HOME-004-2: UAT-AC272 reads "mine" first and the scope when the tab is chosen, from the same two operations as the bell', async () => {
    const user = userEvent.setup();
    const mine = [item(E1, 'ACTION', { title: 'Của tôi' })];
    const scope = [item(E1, 'ACTION', { title: 'Của tôi' }), item(E2, 'URGENT', { title: 'Của đơn vị khác' })];
    const h = harness(backend({ mine: { items: mine }, scope: { items: scope } }));
    mount(<MyWorkScreen route={ROUTE} />, h, { permissions: READER });
    await waitFor(() => expect(rows()).toHaveLength(1));
    const tabs = screen.getByRole('tablist', { name: tr('home.queue.tabs') });
    expect(within(tabs).getByRole('tab', { name: tr('alerts.view.mine') }).getAttribute('aria-selected')).toBe('true');
    await user.click(await within(tabs).findByRole('tab', { name: tr('alerts.view.scope') }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(h.read.mock.calls.some(([operation, input]) => operation === 'getMyWork' && viewOf(input) === 'scope')).toBe(true);
    expect(h.read.mock.calls.every(([operation]) => operation === 'getMyWork' || operation === 'getMyWorkCounts')).toBe(true);
  });

  it('says the scope is hidden from a role that may not read it, and keeps its own work', async () => {
    mount(<MyWorkScreen route={ROUTE} />, harness(backend({ mine: { items: [item(E1, 'WATCH')] } })), { permissions: READER });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(await screen.findByTestId('scope-denied')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: tr('alerts.view.scope') })).toBeNull();
  });

  it('filters by severity with the count of each, and says when the filter found nothing, with a way back', async () => {
    const user = userEvent.setup();
    const items = [item(E1, 'URGENT'), item(E2, 'ACTION'), item(E3, 'ACTION')];
    mount(<MyWorkScreen route={ROUTE} />, harness(backend({ mine: { items } })), { permissions: READER });
    await waitFor(() => expect(rows()).toHaveLength(3));
    const group = screen.getByRole('group', { name: tr('home.queue.filter.label') });
    await user.click(within(group).getByRole('button', { name: exact(fill(tr('home.queue.filter.level'), { label: tr('alerts.severity.action'), count: 2 })) }));
    expect(rows()).toHaveLength(2);
    await user.click(within(group).getByRole('button', { name: exact(fill(tr('home.queue.filter.level'), { label: tr('alerts.severity.watch'), count: 0 })) }));
    const empty = screen.getByTestId('queue-empty');
    expect(empty.getAttribute('data-kind')).toBe('filtered');
    await user.click(within(empty).getByRole('button', { name: tr('home.queue.empty.clear') }));
    expect(rows()).toHaveLength(3);
  });

  it('says there is no work only when the source answered with none', async () => {
    mount(<MyWorkScreen route={ROUTE} />, harness(backend({ mine: { items: [] } })), { permissions: READER });
    const empty = await screen.findByTestId('queue-empty');
    expect(empty.getAttribute('data-kind')).toBe('none');
    expect(empty.textContent).toContain(tr('home.queue.empty.none'));
  });

  it('shows a loading state and never a count of 0 while it waits', async () => {
    mount(<MyWorkScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), { permissions: READER });
    expect(screen.getByTestId('queue-loading').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('queue-empty')).toBeNull();
    expect(screen.queryByText(exact(fill(tr('home.queue.filter.all'), { count: 0 })))).toBeNull();
  });

  it('names the failure of the list and retries in place: a list that could not be read is never "no work"', async () => {
    const user = userEvent.setup();
    let failing = true;
    mount(<MyWorkScreen route={ROUTE} />, harness((operation, input) => (failing ? failure(500, 'INTERNAL_ERROR') : backend({ mine: { items: [item(E1, 'ACTION')] } })(operation, input))), { permissions: READER });
    const error = await screen.findByTestId('queue-error');
    expect(error.textContent).toContain(tr('home.queue.error'));
    expect(screen.queryByTestId('queue-empty')).toBeNull();
    failing = false;
    await user.click(within(error).getByRole('button', { name: tr('home.queue.retry') }));
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  it('names the sources that could not be read and still shows the work of the others', async () => {
    mount(<MyWorkScreen route={ROUTE} />, harness(backend({ mine: { items: [item(E1, 'ACTION')], extra: { unavailable_sources: ['PERMIT', 'GUARANTEE'] } } })), { permissions: READER });
    const note = await screen.findByTestId('queue-unavailable');
    expect(note.textContent).toContain(fill(tr('home.queue.unavailable'), { sources: `${tr('alerts.source.permit')}, ${tr('alerts.source.guarantee')}` }));
    expect(rows()).toHaveLength(1);
  });

  it('claims an item with the idempotent command of the bell and shows the receipt', async () => {
    const user = userEvent.setup();
    const h = harness(backend({ mine: { items: [item(E1, 'ACTION')] } }), () => ({}));
    mount(<MyWorkScreen route={ROUTE} />, h, { permissions: READER });
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(within(rows()[0] as HTMLElement).getByRole('button', { name: tr('alerts.action.claim') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('claimWork');
    expect((h.command.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({ source: 'PERMIT', source_id: E1 });
    await waitFor(() => expect(screen.getByTestId('queue-receipt').textContent).not.toBe(''));
  });

  describe('the standard states', () => {
    it.each([
      ['denied', failure(403, 'FORBIDDEN')],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })],
      ['error', failure(500, 'INTERNAL_ERROR')],
    ])('says the %s state in words and not "no work"', async (_name, error) => {
      mount(<MyWorkScreen route={ROUTE} />, harness(() => error), { permissions: READER });
      expect(screen.getByRole('region', { name: tr('home.queue.title') })).toBeTruthy();
      await waitFor(() => expect(screen.queryByTestId('queue-loading')).toBeNull());
      expect(screen.queryByTestId('queue-empty')).toBeNull();
    });
  });
});

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const work = (id: string, kind: string, bucket: string) => ({ id, kind, title: `Task ${id.slice(-3)}`, subtitle: 'HM-001', status: 'REQUESTED', due_on: '2027-10-18', original_due_on: '2027-10-18', bucket, overdue: bucket === 'OVERDUE', days_late: 0, target: { screen: 'PRJ-19', id } });

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

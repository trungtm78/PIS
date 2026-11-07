import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as tr } from '../../i18n';
import { toSnoozedAnswer } from '../../ui/alerts/types';
import { harness, mount, routeOf } from '../mne/test-support';
import SnoozedWorkScreen from './SnoozedWorkScreen';
import { emptyKindOf, isPartialList, ordinalOf, snoozedRowKey } from './snoozed-model';

const ROUTE = routeOf('HOME-12', 'FR-HOME-12');
const READER = ['home.read'];
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });
afterEach(cleanup);

const snooze = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  by: { id: 'u1', name: 'Nguyễn An' },
  until: '2026-11-09T01:00:00Z',
  at: '2026-11-07T01:00:00Z',
  reason_code: 'WAITING_INFORMATION',
  note: null,
  ordinal: 1,
  of: 2,
  final: false,
  policy_version: 'builtin',
  ...overrides,
});
const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  source: 'PERMIT',
  source_id: id,
  kind: 'PERMIT_EXPIRY',
  title: `Việc ${id}`,
  subtitle: 'DA-DT205',
  severity: 'ACTION',
  due_on: '2026-11-20',
  target: { screen: 'PRJ-19', id },
  snooze: snooze(),
  snooze_count: 1,
  ...overrides,
});
const answer = (items: unknown[], extra: Record<string, unknown> = {}) => ({ items, count: items.length, truncated: false, unavailable_sources: [], policy_version: 'builtin', as_of: '2026-11-07T02:15:00Z', ...extra });
const backend = (value: unknown) => (operation: string): unknown => (operation === 'getSnoozedWork' ? value : new Error(`unexpected read ${operation}`));
const table = () => screen.getByRole('table', { name: tr('home.snoozed.title') });

describe('HOME-12 work on hold: the list', () => {
  it('shows each item with its source, level, who snoozed it, until when, why, which time of the run and the due day', async () => {
    const items = [
      row('p1', { title: 'Giấy phép hết hạn', severity: 'WATCH', snooze: snooze({ note: 'Chờ cơ quan cấp phép' }) }),
      row('g1', { source: 'GUARANTEE', title: 'Bảo lãnh sắp hết', severity: 'ACTION', due_on: null, snooze_count: 2, snooze: snooze({ by: { id: 'u2', name: 'Trần Bình' }, reason_code: 'ON_LEAVE', ordinal: 2, of: 2, until: '2026-11-10T01:00:00Z' }) }),
    ];
    mount(<SnoozedWorkScreen route={ROUTE} />, harness(backend(answer(items))), { permissions: READER });
    const link = await screen.findByRole('link', { name: 'Giấy phép hết hạn' });
    expect(link.getAttribute('href')).toBe('/prj/prj-19');
    const first = link.closest('tr') as HTMLElement;
    expect(within(first).getByText(tr('alerts.source.permit'))).toBeTruthy();
    expect(within(first).getByText(tr('alerts.severity.watch'))).toBeTruthy();
    expect(within(first).getByText('Nguyễn An')).toBeTruthy();
    expect(within(first).getByText(tr('alerts.snooze.reason.waitingInformation'))).toBeTruthy();
    expect(within(first).getByText('Chờ cơ quan cấp phép')).toBeTruthy();
    expect(within(first).getByText(fill(tr('home.snoozed.ordinal'), { n: 1, of: 2 }))).toBeTruthy();
    expect(within(first).getByText('20/11')).toBeTruthy();
    expect(within(first).getByText(/^\d\d:\d\d 09\/11$/)).toBeTruthy();
    const second = screen.getByText('Bảo lãnh sắp hết').closest('tr') as HTMLElement;
    expect(within(second).getByText('Trần Bình')).toBeTruthy();
    expect(within(second).getByText(fill(tr('home.snoozed.ordinal'), { n: 2, of: 2 }))).toBeTruthy();
    expect(within(second).getByText(tr('alerts.snooze.reason.onLeave'))).toBeTruthy();
    expect(within(second).getByText('—', { selector: 'td' })).toBeTruthy();
    for (const header of ['item', 'source', 'severity', 'by', 'until', 'reason', 'ordinal', 'due']) expect(within(table()).getByRole('columnheader', { name: tr(`home.snoozed.column.${header}`) })).toBeTruthy();
  });

  it('names the page, the scope, the number of items, the policy version and when the answer was read', async () => {
    mount(<SnoozedWorkScreen route={ROUTE} />, harness(backend(answer([row('p1')], { policy_version: 'v2' }))), { permissions: READER });
    await screen.findByRole('table', { name: tr('home.snoozed.title') });
    expect(document.querySelector('[data-screen-id="HOME-12"]')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: tr('home.snoozed.title') })).toBeTruthy();
    const context = screen.getByRole('group', { name: tr('ui.contextBar.label') });
    expect(context.textContent).toContain(tr('home.snoozed.ctx.count'));
    expect(context.textContent).toContain(tr('home.snoozed.ctx.policy'));
    expect(context.textContent).toContain('v2');
    expect(context.textContent).toMatch(/\d\d:\d\d 07\/11/);
  });

  it('shows a source or a reason this build has no words for as it came', async () => {
    mount(<SnoozedWorkScreen route={ROUTE} />, harness(backend(answer([row('x1', { source: 'NEW_SOURCE', snooze: snooze({ reason_code: 'NEW_REASON' }) })]))), { permissions: READER });
    await screen.findByRole('table', { name: tr('home.snoozed.title') });
    expect(screen.getByText('NEW_SOURCE')).toBeTruthy();
    expect(screen.getByText('NEW_REASON')).toBeTruthy();
  });

  it('says "Lần n" when the answer does not say how many are allowed', async () => {
    mount(<SnoozedWorkScreen route={ROUTE} />, harness(backend(answer([row('x1', { snooze_count: 3, snooze: snooze({ ordinal: null, of: null }) })]))), { permissions: READER });
    await screen.findByRole('table', { name: tr('home.snoozed.title') });
    expect(screen.getByText(fill(tr('home.snoozed.ordinalOpen'), { n: 3 }))).toBeTruthy();
  });
});

describe('HOME-12 work on hold: the states', () => {
  it('shows a skeleton while it waits, never a count of 0', () => {
    mount(<SnoozedWorkScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), { permissions: READER });
    expect(screen.getByRole('status', { name: tr('states.loading.label') }).getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('snoozed-empty')).toBeNull();
    expect(screen.queryByText(tr('home.snoozed.ctx.count'))).toBeNull();
  });

  it('says there is nothing on hold, and why, only when every source answered', async () => {
    mount(<SnoozedWorkScreen route={ROUTE} />, harness(backend(answer([]))), { permissions: READER });
    const empty = await screen.findByTestId('snoozed-empty');
    expect(empty.getAttribute('data-kind')).toBe('none');
    expect(empty.textContent).toContain(tr('home.snoozed.empty.none'));
    expect(within(empty).getByRole('link', { name: tr('home.snoozed.back') }).getAttribute('href')).toBe('/home/home-02');
  });

  it('does not say "nothing" when a source could not be read: it names the source', async () => {
    mount(<SnoozedWorkScreen route={ROUTE} />, harness(backend(answer([], { unavailable_sources: ['ISSUE'] }))), { permissions: READER });
    const empty = await screen.findByTestId('snoozed-empty');
    expect(empty.getAttribute('data-kind')).toBe('unknownSources');
    expect(empty.textContent).not.toContain(tr('home.snoozed.empty.none'));
    expect(screen.getByTestId('snoozed-unavailable').textContent).toContain(fill(tr('home.snoozed.unavailable'), { sources: tr('alerts.source.issue') }));
  });

  it('names the sources that could not be read and still shows the others, with a retry in place', async () => {
    const user = userEvent.setup();
    const h = harness(backend(answer([row('p1')], { unavailable_sources: ['PERMIT', 'GUARANTEE'] })));
    mount(<SnoozedWorkScreen route={ROUTE} />, h, { permissions: READER });
    const note = await screen.findByTestId('snoozed-unavailable');
    expect(note.textContent).toContain(`${tr('alerts.source.permit')}, ${tr('alerts.source.guarantee')}`);
    expect(screen.getByRole('link', { name: 'Việc p1' })).toBeTruthy();
    await user.click(within(note).getByRole('button', { name: tr('home.snoozed.retry') }));
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'getSnoozedWork').length).toBeGreaterThanOrEqual(2));
  });

  it('says the list is cut when the server cut it', async () => {
    mount(<SnoozedWorkScreen route={ROUTE} />, harness(backend(answer([row('p1')], { count: 40, truncated: true }))), { permissions: READER });
    const note = await screen.findByTestId('snoozed-truncated');
    expect(note.textContent).toContain(fill(tr('home.snoozed.truncated'), { shown: 1, count: 40 }));
  });

  it('keeps the old answer and says it is old when a refresh fails', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const h = harness((operation) => {
      if (operation !== 'getSnoozedWork') return new Error('unexpected');
      calls += 1;
      return calls === 1 ? answer([row('p1')], { unavailable_sources: ['PERMIT'] }) : failure(500, 'INTERNAL_ERROR');
    });
    mount(<SnoozedWorkScreen route={ROUTE} />, h, { permissions: READER });
    const note = await screen.findByTestId('snoozed-unavailable');
    await user.click(within(note).getByRole('button', { name: tr('home.snoozed.retry') }));
    const stale = await screen.findByTestId('snoozed-stale');
    expect(stale.textContent).toMatch(/\d\d:\d\d/);
    expect(screen.getByRole('link', { name: 'Việc p1' })).toBeTruthy();
    expect(within(screen.getByRole('group', { name: tr('ui.contextBar.label') })).getByText(/Số liệu cũ|cũ/)).toBeTruthy();
  });

  it('names a failure with nothing to show and retries in place: it is never "nothing on hold"', async () => {
    const user = userEvent.setup();
    let failing = true;
    mount(<SnoozedWorkScreen route={ROUTE} />, harness((operation) => (failing ? failure(500, 'INTERNAL_ERROR') : backend(answer([row('p1')]))(operation))), { permissions: READER });
    expect(await screen.findByText(tr('states.error.title'))).toBeTruthy();
    expect(screen.queryByTestId('snoozed-empty')).toBeNull();
    failing = false;
    await user.click(screen.getByRole('button', { name: tr('states.retry.action') }));
    expect(await screen.findByRole('link', { name: 'Việc p1' })).toBeTruthy();
  });

  it.each([
    ['denied', failure(403, 'FORBIDDEN'), 'states.denied.title'],
    ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), 'states.offline.title'],
  ])('says the %s state in words and leaks no names', async (_name, error, title) => {
    mount(<SnoozedWorkScreen route={ROUTE} />, harness(() => error), { permissions: READER });
    expect(await screen.findByText(tr(title))).toBeTruthy();
    expect(screen.queryByTestId('snoozed-empty')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('the model of the list', () => {
  it('reads the answer of the API, leaving out a row without its snooze or its id', () => {
    const read = toSnoozedAnswer({ items: [row('p1'), { ...row('p2'), snooze: null }, { ...row('p3'), source_id: '' }, 'x'], count: 7, truncated: true, unavailable_sources: ['ISSUE'], policy_version: 'v2', as_of: '2026-11-07T02:00:00Z' });
    expect(read.items.map((entry) => entry.source_id)).toEqual(['p1']);
    expect(read).toMatchObject({ count: 7, truncated: true, unavailable_sources: ['ISSUE'], policy_version: 'v2' });
  });

  it('keys a row by source and record, and counts the time of the run from the ordinal or, failing that, from the count', () => {
    const [first] = toSnoozedAnswer(answer([row('p1', { snooze_count: 4, snooze: snooze({ ordinal: null, of: 3 }) })])).items;
    if (first === undefined) throw new Error('fixture');
    expect(snoozedRowKey(first)).toBe('PERMIT:p1');
    expect(ordinalOf(first)).toEqual({ n: 4, of: 3 });
  });

  it('tells an empty list from one that might hold work in a source that could not be read, and a whole list from a part', () => {
    expect(emptyKindOf({ items: [], unavailable_sources: [] })).toBe('none');
    expect(emptyKindOf({ items: [], unavailable_sources: ['ISSUE'] })).toBe('unknownSources');
    expect(emptyKindOf(toSnoozedAnswer(answer([row('p1')])))).toBeNull();
    expect(isPartialList({ items: [], count: 0, truncated: false })).toBe(false);
    expect(isPartialList({ items: [], count: 3, truncated: false })).toBe(true);
    expect(isPartialList({ items: [], count: 0, truncated: true })).toBe(true);
  });
});

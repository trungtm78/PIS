import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness, mountInSession } from '../../doc/test-support';
import type { Harness } from '../../doc/test-support';
import { routeOf as baseRoute } from '../../sas/test-support';
import StatsScreen from './StatsScreen';
import { PERIODS, percentOf, rangeOf, statisticsOf, toStatConversation } from './model';

const word = (key: string, params: Record<string, string | number> = {}): string =>
  ((vi_ as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
const ROUTE = { ...baseRoute('OMNI-10', 'FR-OMNI-10'), module: 'OMNI', path: '/omni/omni-10' };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

/** A Wednesday, 2026-11-04 at noon in Vietnam. */
const NOW = Date.parse('2026-11-04T05:00:00Z');

const conversation = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${'0810'}${String(n).padStart(8, '0')}`,
  channel: 'ZALO_OA',
  contact_name: `Người dân ${n}`,
  status: 'Assigned',
  queue_unit_name: 'Ban A',
  created_at: iso(NOW - 2 * DAY),
  sla_first_response_due_at: iso(NOW - 2 * DAY + 4 * HOUR),
  first_response_at: iso(NOW - 2 * DAY + 2 * HOUR),
  ...extra,
});

function open(rows: Array<Record<string, unknown>> | Error, options: { permissions?: readonly string[] | undefined; path?: string } = {}): Harness {
  const h = harness(() => new Error('unexpected read'));
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)));
  mountInSession(<StatsScreen route={ROUTE} />, h, { permissions: 'permissions' in options ? options.permissions : ['conversation.read'] }, options.path ?? '/omni/omni-10');
  return h;
}

afterEach(() => cleanup());

describe('the periods and the figures of the statistics (BR-OMNI-09)', () => {
  it('cuts a period on the days of Vietnam: the last days up to the end of today, or the calendar month', () => {
    expect(rangeOf('last7', NOW)).toMatchObject({ startDay: '2026-10-29', endDay: '2026-11-04' });
    expect(rangeOf('last30', NOW)).toMatchObject({ startDay: '2026-10-06', endDay: '2026-11-04' });
    expect(rangeOf('month', NOW)).toMatchObject({ startDay: '2026-11-01', endDay: '2026-11-30' });
    // 23:30 in Vietnam on the 30th is still the 30th, though the clocks of UTC are on the 30th at 16:30.
    expect(rangeOf('month', Date.parse('2026-11-30T16:30:00Z'))).toMatchObject({ startDay: '2026-11-01', endDay: '2026-11-30' });
    expect(rangeOf('last7', Date.parse('2026-11-30T17:30:00Z'))).toMatchObject({ endDay: '2026-12-01' });
    expect(rangeOf('month', Date.parse('2026-12-15T00:00:00Z'))).toMatchObject({ startDay: '2026-12-01', endDay: '2026-12-31' });
  });

  it('writes a share of whole counts with one decimal, rounding half up, without a floating point number', () => {
    expect(percentOf(7, 8)).toBe('87.5');
    expect(percentOf(1, 3)).toBe('33.3');
    expect(percentOf(2, 3)).toBe('66.7');
    expect(percentOf(3, 3)).toBe('100.0');
    expect(percentOf(0, 5)).toBe('0.0');
  });

  it('reads a conversation by its times and drops what has no time of creation', () => {
    expect(toStatConversation(conversation(1))).toMatchObject({ channel: 'ZALO_OA', unitName: 'Ban A', firstReply: { reported: true, atMs: NOW - 2 * DAY + 2 * HOUR } });
    expect(toStatConversation(conversation(1, { first_response_at: null, queue_unit_name: '', sla_first_response_due_at: 'x' }))).toMatchObject({
      unitName: null,
      dueAtMs: null,
      firstReply: { reported: true, atMs: null },
    });
    const unreported = { ...conversation(1) } as Record<string, unknown>;
    delete unreported.first_response_at;
    expect(toStatConversation(unreported)?.firstReply).toEqual({ reported: false });
    expect(toStatConversation(conversation(1, { created_at: 'nope' }))).toBeUndefined();
    expect(toStatConversation(conversation(1, { created_at: 5 }))).toBeUndefined();
    expect(toStatConversation(conversation(1, { channel: 3 }))).toBeUndefined();
    expect(toStatConversation('x')).toBeUndefined();
    expect(toStatConversation([])).toBeUndefined();
  });

  it('has no basis to compute a rate when no conversation had a deadline in the period (UAT-AC199)', () => {
    const stats = statisticsOf(
      [toStatConversation(conversation(1, { sla_first_response_due_at: null }))].flatMap((entry) => entry ?? []),
      'last7',
      NOW,
    );
    expect(stats).toMatchObject({ basis: 'noBasis', denominator: 0, rate: null, answeredInTime: null, opened: 1 });
    expect(statisticsOf([], 'last7', NOW)).toMatchObject({ basis: 'noBasis', opened: 0, byChannel: [], byUnit: [] });
    // A deadline outside the period is no basis either.
    const old = toStatConversation(conversation(1, { sla_first_response_due_at: iso(NOW - 40 * DAY) }));
    expect(statisticsOf(old === undefined ? [] : [old], 'last7', NOW).basis).toBe('noBasis');
  });

  it('counts the conversations answered within the deadline over those that had one in the period', () => {
    const rows = [
      conversation(1),
      conversation(2, { first_response_at: iso(NOW - 2 * DAY + 5 * HOUR) }),
      conversation(3, { first_response_at: null }),
      conversation(4, { channel: 'EMAIL', queue_unit_name: null, first_response_at: iso(NOW - 2 * DAY + 4 * HOUR) }),
    ].flatMap((row) => toStatConversation(row) ?? []);
    const stats = statisticsOf(rows, 'last7', NOW);
    expect(stats).toMatchObject({ basis: 'computed', denominator: 4, answeredInTime: 2, rate: '50.0', opened: 4 });
    expect(stats.byChannel.map((group) => [group.key, group.denominator, group.answeredInTime])).toEqual([
      ['EMAIL', 1, 1],
      ['ZALO_OA', 3, 1],
    ]);
    expect(stats.byUnit.map((group) => group.key)).toEqual(['', 'Ban A']);
  });

  it('does not compute a rate while the API does not say when the first reply came', () => {
    const unreported = { ...conversation(1) } as Record<string, unknown>;
    delete unreported.first_response_at;
    const stats = statisticsOf(
      [unreported, conversation(2)].flatMap((row) => toStatConversation(row) ?? []),
      'last7',
      NOW,
    );
    expect(stats).toMatchObject({ basis: 'unreported', denominator: 2, rate: null, answeredInTime: null });
  });

  it('knows three periods', () => {
    expect(PERIODS).toEqual(['last7', 'last30', 'month']);
  });
});

describe('OMNI-10: statistics of the interactions (ST-OMNI-008, UI-OMNI-10)', () => {
  // The screen counts from the moment it read: the clock is fixed so the rows stay inside the periods they were written for.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows "No basis to compute" with the denominator and the period when nothing had a deadline (UAT-AC199)', async () => {
    open([conversation(1, { sla_first_response_due_at: null })]);
    const sla = await screen.findByTestId('stats-sla');
    expect(sla.getAttribute('data-basis')).toBe('noBasis');
    expect(within(screen.getByTestId('stats-rate')).getByText(word('omni.stats.rate.noBasis'))).toBeTruthy();
    expect(within(screen.getByTestId('stats-denominator')).getByText('0')).toBeTruthy();
    expect(screen.getByTestId('stats-period-range').textContent).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(screen.getByTestId('stats-response-pending').textContent).toBe(word('omni.stats.response.pending'));
    expect(screen.getByLabelText(word('omni.stats.period.label'))).toBeTruthy();
  });

  it('shows no basis for a tenant with no conversation at all, not the empty state', async () => {
    open([]);
    await screen.findByTestId('stats-sla');
    expect(screen.queryByText(word('states.empty.title'))).toBeNull();
    expect(within(screen.getByTestId('stats-by-channel')).getByText(word('omni.stats.none.notice'))).toBeTruthy();
    expect(within(screen.getByTestId('stats-by-unit')).getByText(word('omni.stats.none.notice'))).toBeTruthy();
  });

  it('shows the rate with its denominator, by channel and by unit, and no message, contact or person', async () => {
    open([conversation(1), conversation(2, { first_response_at: null }), conversation(3, { channel: 'EMAIL', queue_unit_name: null }), conversation(4, { channel: 'VOICE' })]);
    await screen.findByTestId('stats-sla');
    expect(screen.getByTestId('stats-sla').getAttribute('data-basis')).toBe('computed');
    expect(within(screen.getByTestId('stats-rate')).getByText(word('omni.stats.rate.value', { rate: '75.0' }))).toBeTruthy();
    expect(screen.getByTestId('stats-rate').textContent).toContain(word('omni.stats.rate.of', { answered: 3, total: 4 }));
    expect(within(screen.getByTestId('stats-denominator')).getByText('4')).toBeTruthy();
    const byChannel = screen.getByTestId('stats-by-channel');
    expect(byChannel.querySelector('[data-group="ZALO_OA"]')?.textContent).toContain(word('omni.inbox.channel.zalo'));
    expect(byChannel.querySelector('[data-group="EMAIL"]')?.textContent).toContain(word('omni.inbox.channel.email'));
    expect(byChannel.querySelector('[data-group="VOICE"]')?.textContent).toContain('VOICE');
    const byUnit = screen.getByTestId('stats-by-unit');
    expect(byUnit.querySelector('[data-group=""]')?.textContent).toContain(word('omni.stats.unit.tenant'));
    expect(byUnit.querySelector('[data-group="Ban A"]')?.textContent).toContain('66.7%');
    expect(document.body.textContent).not.toContain('Người dân');
  });

  it('shows a dash for the figures a group cannot give and says no basis for a group without deadline', async () => {
    open([conversation(1), conversation(2, { channel: 'EMAIL', sla_first_response_due_at: null, created_at: iso(NOW - 1 * DAY) })]);
    await screen.findByTestId('stats-by-channel');
    const email = screen.getByTestId('stats-by-channel').querySelector('[data-group="EMAIL"]') as HTMLElement;
    expect(email.textContent).toContain(word('omni.stats.rate.noBasis'));
    expect(within(email).getByText('—')).toBeTruthy();
  });

  it('says why there is no rate while the API does not tell when the first reply came', async () => {
    const row = conversation(1) as Record<string, unknown>;
    delete row.first_response_at;
    open([row]);
    await screen.findByTestId('stats-sla');
    expect(screen.getByTestId('stats-sla').getAttribute('data-basis')).toBe('unreported');
    expect(within(screen.getByTestId('stats-rate')).getByText(word('omni.stats.rate.unreported'))).toBeTruthy();
    const cells = screen.getByTestId('stats-by-channel').querySelectorAll('[data-group="ZALO_OA"] td');
    expect(cells[2]?.textContent).toBe('—');
    expect(cells[3]?.textContent).toBe('—');
  });

  it('counts another period when asked, and keeps it in the address', async () => {
    // Created and due 20 days ago: inside the last 30 days, outside the last 7.
    open([conversation(1, { created_at: iso(NOW - 20 * DAY), sla_first_response_due_at: iso(NOW - 20 * DAY + HOUR), first_response_at: iso(NOW - 20 * DAY) })], { path: '/omni/omni-10?period=last7' });
    await screen.findByTestId('stats-sla');
    expect(within(screen.getByTestId('stats-denominator')).getByText('0')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(word('omni.stats.period.label')), { target: { value: 'last30' } });
    await waitFor(() => expect(within(screen.getByTestId('stats-denominator')).getByText('1')).toBeTruthy());
    expect((screen.getByLabelText(word('omni.stats.period.label')) as HTMLSelectElement).value).toBe('last30');
  });

  it('counts the month when asked for it and falls back to 30 days for a period it does not know', async () => {
    open([conversation(1)], { path: '/omni/omni-10?period=forever' });
    await screen.findByTestId('stats-sla');
    expect((screen.getByLabelText(word('omni.stats.period.label')) as HTMLSelectElement).value).toBe('last30');
    fireEvent.change(screen.getByLabelText(word('omni.stats.period.label')), { target: { value: 'month' } });
    await waitFor(() => expect((screen.getByLabelText(word('omni.stats.period.label')) as HTMLSelectElement).value).toBe('month'));
  });

  it('shows the denied state without reading when the member may not read conversations', () => {
    const h = open([conversation(1)], { permissions: ['project.read'] });
    expect(screen.getByTestId('stats-denied')).toBeTruthy();
    expect(screen.getByText(word('states.denied.title'))).toBeTruthy();
    expect(h.client.readAll).not.toHaveBeenCalled();
  });

  it('reads when the permissions are not known; the API decides, and a refusal is the denied state', async () => {
    open(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c-1' }), { permissions: undefined });
    await screen.findByText(word('states.denied.title'));
  });

  it('shows the offline state when the network fails', async () => {
    open(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c-2' }));
    await screen.findByText(word('states.offline.title'));
  });

  it('shows the error state and reads again on retry', async () => {
    const h = harness(() => new Error('x'));
    const readAll = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue([conversation(1)]);
    (h.client as unknown as { readAll: unknown }).readAll = readAll;
    mountInSession(<StatsScreen route={{ ...ROUTE, req: null }} />, h, { permissions: ['conversation.read'] }, '/omni/omni-10');
    await screen.findByText(word('states.error.title'));
    expect((screen.getByLabelText(word('omni.stats.period.label')) as HTMLSelectElement).value).toBe('last30');
    fireEvent.change(screen.getByLabelText(word('omni.stats.period.label')), { target: { value: 'last7' } });
    expect((screen.getByLabelText(word('omni.stats.period.label')) as HTMLSelectElement).value).toBe('last7');
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await screen.findByTestId('stats-sla');
    expect(readAll).toHaveBeenCalledTimes(2);
  });

  it('shows the loading state while the conversations are read', () => {
    const h = harness(() => new Error('x'));
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
    mountInSession(<StatsScreen route={ROUTE} />, h, { permissions: ['conversation.read'] }, '/omni/omni-10');
    expect(screen.getByRole('status', { name: word('states.loading.label') })).toBeTruthy();
  });
});

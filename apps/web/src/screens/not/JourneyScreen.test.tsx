import { NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { failure, harness, mount, rawAttempt, routeOf } from './delivery/test-support';
import JourneyScreen from './JourneyScreen';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('NOT-12', 'FR-NOT-12');
const ENTRY = '/not/not-12?id=a-4';

/** Four failed sends of one channel, a fifth that waits, and the message of the next channel that was accepted. */
const JOURNEY = [
  rawAttempt({ id: 'a-1', attempt_no: 1, status: 'Failed', failure_class: 'RETRYABLE', error_code: 'HTTP_503', failed_at: '2026-10-24T03:00:01.000Z' }),
  rawAttempt({ id: 'a-2', attempt_no: 2, status: 'Failed', failure_class: 'RETRYABLE', error_code: 'HTTP_503', failed_at: '2026-10-24T03:00:35.000Z' }),
  rawAttempt({ id: 'a-3', attempt_no: 3, status: 'Failed', failure_class: 'RETRYABLE', error_code: 'HTTP_503', failed_at: '2026-10-24T03:03:00.000Z' }),
  rawAttempt({ id: 'a-4', attempt_no: 4, status: 'ProviderAccepted', accepted_at: '2026-10-24T03:13:00.000Z', provider_message_id: 'msg-77' }),
  rawAttempt({ id: 'a-5', attempt_no: 5, status: 'Queued', next_retry_at: '2026-10-24T03:43:00.000Z' }),
  rawAttempt({ id: 's-1', channel: 'SMS', attempt_no: 1, status: 'Suppressed', error_code: 'NO_ADDRESS' }),
];

afterEach(cleanup);

function detail(overrides: Record<string, unknown> = {}) {
  return harness((operation) => (operation === 'get_resources_delivery_attempt_id' ? { ...JOURNEY[3], journey: JOURNEY, history: [], ...overrides } : new Error(`unexpected read ${operation}`)));
}

describe('NOT-12 journey of a send (UI-NOT-12, AC-ST-NOT-002-7)', () => {
  it('renders the five retry milestones of the channel with their waits and what became of each', async () => {
    const h = detail();
    mount(<JourneyScreen route={ROUTE} />, h, { entry: ENTRY });
    const milestones = await screen.findByTestId('journey-milestones');
    const items = within(milestones).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(items.map((item) => item.getAttribute('data-state'))).toEqual(['failed', 'failed', 'failed', 'delivered', 'waiting']);
    expect(within(items[0] as HTMLElement).getByText(vi_['not.journey.offset.first'])).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText('Sau khoảng 30 giây')).toBeTruthy();
    expect(within(items[2] as HTMLElement).getByText('Sau khoảng 2 phút')).toBeTruthy();
    expect(within(items[3] as HTMLElement).getByText('Sau khoảng 10 phút')).toBeTruthy();
    expect(within(items[4] as HTMLElement).getByText('Sau khoảng 30 phút')).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('get_resources_delivery_attempt_id', { path: { id: 'a-4' } });
  });

  it('shows the moments of the message and tells a provider read from an acknowledgement', async () => {
    mount(<JourneyScreen route={ROUTE} />, detail({ delivered_at: '2026-10-24T03:14:00.000Z', ack_required: true, acknowledged_at: null }), { entry: ENTRY });
    const timeline = await screen.findByTestId('journey-timeline');
    const rows = within(timeline).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(within(rows[3] as HTMLElement).getByText(vi_['not.journey.timeline.notYet'])).toBeTruthy();
    // The acknowledgement is its own act: required, and not given yet.
    expect(within(rows[4] as HTMLElement).getByText(vi_['not.journey.timeline.acknowledged'])).toBeTruthy();
    expect(within(rows[4] as HTMLElement).getByText(vi_['not.journey.timeline.notYet'])).toBeTruthy();
  });

  it('says an acknowledgement is not required when the notification does not ask for one', async () => {
    mount(<JourneyScreen route={ROUTE} />, detail(), { entry: ENTRY });
    const timeline = await screen.findByTestId('journey-timeline');
    expect(within(timeline).getByText(vi_['not.journey.timeline.notRequired'])).toBeTruthy();
  });

  it('lists every attempt of the notification with its provider reference and the reason it was left out', async () => {
    mount(<JourneyScreen route={ROUTE} />, detail(), { entry: ENTRY });
    const attempts = await screen.findByTestId('journey-attempts');
    const rows = within(attempts).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.getAttribute('data-current') === 'true')).toHaveLength(1);
    expect(within(attempts).getByText('msg-77')).toBeTruthy();
    expect(within(attempts).getByText('NO_ADDRESS')).toBeTruthy();
    expect(within(attempts).getAllByText('HTTP_503')).toHaveLength(3);
    const summary = screen.getByTestId('journey-summary');
    expect(within(summary).getByText('msg-77')).toBeTruthy();
    expect(within(summary).getByText(vi_['not.delivery.status.accepted'])).toBeTruthy();
  });

  it('asks to pick a send when no attempt is named, and reads nothing', () => {
    const h = detail();
    mount(<JourneyScreen route={ROUTE} />, h, { entry: '/not/not-12' });
    expect(screen.getByTestId('journey-select')).toBeTruthy();
    expect(screen.getByText(vi_['not.journey.select.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the loading state while the journey is read', () => {
    mount(<JourneyScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), { entry: ENTRY });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });

  it('is denied without reading anything when the session lacks delivery_attempt.read', () => {
    const h = detail();
    mount(<JourneyScreen route={ROUTE} />, h, { entry: ENTRY, permissions: [] });
    expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it.each([
    ['denied', failure(403, 'SCOPE_DENIED'), 'states.denied.title'],
    ['signedOut', failure(401, 'SESSION_EXPIRED'), 'states.signedOut.title'],
    ['offline', failure(0, NETWORK_ERROR_CODE), 'states.offline.title'],
    ['error', failure(404, 'RESOURCE_NOT_FOUND'), 'states.error.title'],
  ] as const)('shows the %s state when the journey cannot be read', async (_state, error, key) => {
    mount(<JourneyScreen route={ROUTE} />, harness(() => error), { entry: ENTRY });
    expect(await screen.findByText(vi_[key])).toBeTruthy();
  });

  it('links back to the send queue', async () => {
    mount(<JourneyScreen route={ROUTE} />, detail(), { entry: ENTRY });
    const link = await screen.findByRole('link', { name: /Hàng đợi gửi/ });
    expect(link.getAttribute('href')).toBe('/not/not-11');
  });

  it('treats an answer it cannot read as an error rather than showing half a journey', async () => {
    mount(<JourneyScreen route={ROUTE} />, harness(() => ({ nonsense: true })), { entry: ENTRY });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });
});

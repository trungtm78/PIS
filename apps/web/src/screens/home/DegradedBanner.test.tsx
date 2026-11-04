import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import OverviewScreen from './OverviewScreen';
import { DegradedChannelsBanner } from './DegradedBanner';
import { CHANNEL_HEALTH_POLL_MS, toDegradedChannels } from './channel-health';

const OV = routeOf('HOME-01', 'FR-HOME-01');
const READER = ['home.read'];
const SNAPSHOT = '00000000-0000-4000-8000-0000000000f2';

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const center = {
  snapshot_id: SNAPSHOT,
  snapshot_kind: 'PERIOD_CLOSE',
  as_of_date: '2027-10-12',
  treasury_cutoff_date: '2027-10-12',
  freshness: 'FRESH',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  legal_confirmation_refs: [],
  scope: { unit_id: null, denominator_kind: null, projects: 3, scope_hash: 'h' },
  tiles: [],
  projects_without_data: 0,
  open_warnings: 0,
  overdue_explanations: 0,
  pending_reallocations: 0,
  quality_badge: 'NOT_ASSESSED',
};

const open = (channel: string, last: string | null, state = 'OPEN') => ({ channel, state, open_since: '2027-10-15T02:30:00.000Z', last_delivered_at: last });
const health = (...channels: unknown[]) => ({ channels, as_of: '2027-10-15T03:00:00.000Z' });

/** A client that answers the command center and, for the banner, what `channels` returns. */
function client(channels: () => unknown) {
  const h = harness((operation) => {
    if (operation === 'getCommandCenter') return center;
    if (operation === 'getHomeChannelHealth') return channels();
    return new Error(`unexpected read ${operation}`);
  });
  (h.client as unknown as { readAll: () => Promise<unknown[]> }).readAll = () => Promise.resolve([]);
  return h;
}

afterEach(cleanup);

describe('the degraded-state banner of the home screen (ST-KERNEL-073)', () => {
  it('AC-ST-KERNEL-073-2 UAT-NFR-AVAILABILITY-04: when the home screen loads with a breaker open, a banner shows the channel and the time of its latest successful delivery', async () => {
    mount(<OverviewScreen route={OV} />, client(() => health(open('SMS', '2027-10-15T02:10:00.000Z'))), { permissions: READER });
    const banner = await screen.findByTestId('degraded-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(within(banner).getByText(vi_['home.degraded.title'])).toBeInTheDocument();
    const line = banner.querySelector('[data-channel="SMS"]') as HTMLElement;
    // 02:10 UTC is 09:10 in Vietnam.
    expect(line.textContent).toBe(fill(vi_['home.degraded.sent'], { channel: vi_['not.delivery.channel.sms'], time: '09:10 15/10/2027' }));
    expect(line).toHaveAttribute('data-state', 'OPEN');
    expect(within(banner).getByText(vi_['home.degraded.reassure'])).toBeInTheDocument();
    // The screen itself goes on: the banner does not take the place of the figures.
    // The figures are looked up again until they are in the document: the screen draws them again when the health of the channels arrives, and the node found first may be the one that goes.
    await waitFor(() => expect(screen.getByTestId('home-rates')).toBeInTheDocument());
  });

  it('AC-ST-KERNEL-073-2 UAT-NFR-AVAILABILITY-04: names every degraded channel, and says so when a channel has not delivered yet', async () => {
    mount(<DegradedChannelsBanner />, client(() => health(open('EMAIL', '2027-10-15T01:00:00.000Z', 'HALF_OPEN'), open('ZALO_OA', null))), { permissions: READER });
    const banner = await screen.findByTestId('degraded-banner');
    expect(banner.querySelectorAll('li')).toHaveLength(2);
    expect(banner.querySelector('[data-channel="EMAIL"]')).toHaveAttribute('data-state', 'HALF_OPEN');
    expect((banner.querySelector('[data-channel="ZALO_OA"]') as HTMLElement).textContent).toBe(fill(vi_['home.degraded.never'], { channel: vi_['not.delivery.channel.zaloOa'] }));
  });

  it('shows no banner while every channel is healthy', async () => {
    const h = client(() => health());
    mount(<OverviewScreen route={OV} />, h, { permissions: READER });
    await screen.findByTestId('home-rates');
    await waitFor(() => expect(h.read.mock.calls.some(([operation]) => operation === 'getHomeChannelHealth')).toBe(true));
    expect(screen.queryByTestId('degraded-banner')).toBeNull();
  });

  it('shows no banner, and does not break the screen, when the state of the channels cannot be read', async () => {
    const h = client(() => new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', correlationId: 'c' }));
    mount(<OverviewScreen route={OV} />, h, { permissions: READER });
    expect(await screen.findByTestId('home-rates')).toBeInTheDocument();
    await waitFor(() => expect(h.read.mock.calls.some(([operation]) => operation === 'getHomeChannelHealth')).toBe(true));
    expect(screen.queryByTestId('degraded-banner')).toBeNull();
  });

  it('asks again every minute, so that a channel that recovers takes its banner away', () => {
    expect(CHANNEL_HEALTH_POLL_MS).toBe(60_000);
  });
});

describe('toDegradedChannels', () => {
  it('reads the entries of the answer and leaves out any that does not have the shape of one', () => {
    expect(
      toDegradedChannels({
        channels: [
          open('SMS', null),
          { channel: '', state: 'OPEN', open_since: 'x', last_delivered_at: null },
          { channel: 'EMAIL', state: 'CLOSED', open_since: 'x', last_delivered_at: null },
          { channel: 'EMAIL', state: 'OPEN', open_since: 5, last_delivered_at: null },
          { channel: 'EMAIL', state: 'OPEN', open_since: 'x', last_delivered_at: 7 },
          'EMAIL',
          null,
        ],
      }),
    ).toEqual([{ channel: 'SMS', state: 'OPEN', openSince: '2027-10-15T02:30:00.000Z', lastDeliveredAt: null }]);
    for (const raw of [undefined, null, [], {}, { channels: 'SMS' }]) expect(toDegradedChannels(raw)).toEqual([]);
  });
});

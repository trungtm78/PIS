import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import { homeRoot } from './hooks';

/** How often the banner asks again: a channel that recovers takes its banner away within this time. */
export const CHANNEL_HEALTH_POLL_MS = 60_000;

/** A notification channel whose circuit breaker is not closed, with the time of its latest successful delivery (ST-KERNEL-073). */
export interface DegradedChannel {
  channel: string;
  state: 'OPEN' | 'HALF_OPEN';
  openSince: string;
  lastDeliveredAt: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The degraded channels of an answer of `getHomeChannelHealth`. An entry that does not have the shape of one is left out, so that a malformed entry never turns into a banner with a blank channel. */
export function toDegradedChannels(raw: unknown): DegradedChannel[] {
  const channels = isRecord(raw) && Array.isArray(raw.channels) ? raw.channels : [];
  return channels.flatMap((entry): DegradedChannel[] => {
    if (!isRecord(entry) || typeof entry.channel !== 'string' || entry.channel === '' || typeof entry.open_since !== 'string') return [];
    if (entry.state !== 'OPEN' && entry.state !== 'HALF_OPEN') return [];
    if (entry.last_delivered_at !== null && typeof entry.last_delivered_at !== 'string') return [];
    return [{ channel: entry.channel, state: entry.state, openSince: entry.open_since, lastDeliveredAt: entry.last_delivered_at }];
  });
}

/** The degraded channels of the tenant. A failure to read them is not a failure of the screen: the banner stays away. */
export function useChannelHealth() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DegradedChannel[]>({
    queryKey: [...homeRoot(tenant?.id), 'channel-health'],
    queryFn: async () => toDegradedChannels(await client.read('getHomeChannelHealth')),
    enabled: tenant !== undefined,
    refetchInterval: CHANNEL_HEALTH_POLL_MS,
    retry: false,
  });
}

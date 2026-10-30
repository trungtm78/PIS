import { useInfiniteQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toDevicePage } from './model';
import type { DevicePage } from './model';

export const devicesKey = (tenantId: string | undefined, status: string, platform: string) => ['not', 'devices', tenantId, status, platform] as const;

/** The push devices of the tenant, the most recently seen first, a page at a time (`get_resources_device_registration`); read again every minute, as devices come and go. */
export function useDevices(filters: { status: string; platform: string }, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<DevicePage, Error, { pages: DevicePage[] }, ReturnType<typeof devicesKey>, string | undefined>({
    queryKey: devicesKey(tenant?.id, filters.status, filters.platform),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toDevicePage(
        await client.read('get_resources_device_registration', {
          query: {
            ...(filters.status === '' ? {} : { status: filters.status as 'Active' | 'Revoked' }),
            ...(filters.platform === '' ? {} : { platform: filters.platform as 'ios' | 'android' | 'web' }),
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined,
    refetchInterval: 60_000,
    retry: false,
  });
}

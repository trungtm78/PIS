import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import { toBacktest, toHeatmap, toTrend } from './insight-model';
import type { Backtest, Heatmap, HeatView, Trend } from './insight-model';

const base = { retry: false, staleTime: 0, refetchOnWindowFocus: false } as const;

export function useHeatmap(view: HeatView) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Heatmap>({
    queryKey: ['ana', tenant?.id, tenant?.membershipId, 'heatmap', view],
    queryFn: async () => {
      const map = toHeatmap(await client.read('getAnalyticsHeatmap', { query: { view } }));
      if (map === undefined) throw new Error('the heat-map could not be read');
      return map;
    },
    enabled: tenant !== undefined,
    ...base,
  });
}

export function useBacktest(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Backtest>({
    queryKey: ['ana', tenant?.id, tenant?.membershipId, 'backtest'],
    queryFn: async () => {
      const result = toBacktest(await client.read('getAnalyticsBacktest', {}));
      if (result === undefined) throw new Error('the back-test could not be read');
      return result;
    },
    enabled: tenant !== undefined && enabled,
    ...base,
  });
}

export function useTrend() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Trend>({
    queryKey: ['ana', tenant?.id, tenant?.membershipId, 'trend'],
    queryFn: async () => {
      const result = toTrend(await client.read('getAnalyticsTrendRanking', {}));
      if (result === undefined) throw new Error('the trend ranking could not be read');
      return result;
    },
    enabled: tenant !== undefined,
    ...base,
  });
}

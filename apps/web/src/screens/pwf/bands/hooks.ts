import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { usePwfKey } from '../hooks';
import type { BandPreview, BandUnit } from '../model';
import type { Thresholds } from './band-model';

/**
 * What the server says a ladder does at a few days left ("5 days left: green, 2 days: yellow, under 1 day: red"), so the person sees the effect of the numbers before a draft is written.
 * It is asked only for a ladder the editor finds good, and again whenever a number changes.
 */
export function useBandPreview(thresholds: Thresholds | undefined, unit: BandUnit, enabled: boolean) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<BandPreview>({
    queryKey: [...key, 'band-preview', thresholds ?? null, unit],
    queryFn: () => {
      if (thresholds === undefined) throw new Error('NO_LADDER');
      return client.read('previewDeadlineBand', { query: { yellow_days: thresholds.yellow_days, red_days: thresholds.red_days, ...(thresholds.green_days === null ? {} : { green_days: thresholds.green_days }), unit } });
    },
    enabled: enabled && thresholds !== undefined && key[1] !== undefined,
    retry: false,
  });
}

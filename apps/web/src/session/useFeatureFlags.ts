import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../api/ApiClientContext';
import { useSession } from './SessionContext';

export interface FeatureFlags {
  isLoading: boolean;
  isError: boolean;
  /** The flags the tenant of the session has on, by key; the server sends a key for every flag it knows. */
  flags: ReadonlyMap<string, boolean>;
  /** Whether a release flag is on for the tenant: true or false once the answer is in, undefined while it is not (loading, or failed): a screen never guesses. */
  enabled(key: string): boolean | undefined;
  refetch(): void;
}

const NONE: ReadonlyMap<string, boolean> = new Map();

/** The reading of `getMyFeatureFlags`: items of `{ flag_key, enabled }`; a row that is not that shape is dropped. */
export function flagMapOf(raw: unknown): Map<string, boolean> {
  const items = typeof raw === 'object' && raw !== null && Array.isArray((raw as { items?: unknown }).items) ? ((raw as { items: unknown[] }).items) : [];
  const map = new Map<string, boolean>();
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const { flag_key: key, enabled } = item as { flag_key?: unknown; enabled?: unknown };
    if (typeof key === 'string' && typeof enabled === 'boolean') map.set(key, enabled);
  }
  return map;
}

/**
 * The release flags that are on for the tenant of the session (not a commercial right: it only says which released features the tenant may use). Kept per tenant and membership, read once a minute at most, and
 * a failed read is a state of its own (`isError`), never "off".
 */
export function useFeatureFlags(): FeatureFlags {
  const client = useApiClient();
  const { tenant } = useSession();
  const query = useQuery<Map<string, boolean>>({
    queryKey: ['me', 'feature-flags', tenant?.id, tenant?.membershipId],
    queryFn: async () => flagMapOf(await client.read('getMyFeatureFlags')),
    enabled: tenant?.id !== undefined,
    staleTime: 60_000,
    retry: false,
  });
  const flags = query.data ?? NONE;
  return {
    isLoading: query.isLoading,
    isError: query.isError,
    flags,
    enabled: (key) => (query.data === undefined ? undefined : (query.data.get(key) ?? false)),
    refetch: () => void query.refetch(),
  };
}

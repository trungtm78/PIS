import { useQueries, useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import { root, useCommand } from './hooks';
import { toRecord } from './model';
import type { RecordView } from './model';
import { toConversion, toStructure } from './succession-model';
import type { ConversionView, EdgeView, StructureView, SuccessionKind } from './succession-model';

/** The entries of some types as they stood on a date: the ones with a version in force then carry its name and validity. */
export function useRecordsAsOf(masterTypes: readonly string[], date: string, enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<RecordView[]>({
    queryKey: [...root(tenant?.id), 'records-as-of', ...masterTypes, date],
    queryFn: async () => {
      const lists = await Promise.all(masterTypes.map((masterType) => client.readAll('searchMasterRecords', { query: { master_type: masterType, as_of: date } })));
      return lists.flat().flatMap((raw) => toRecord(raw) ?? []);
    },
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** How one entry stood on a date, and into which entries of that day's structure it converts. */
export function useStructureAsOf(recordId: string | undefined, date: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<StructureView | null>({
    queryKey: [...root(tenant?.id), 'as-of', recordId ?? '', date],
    queryFn: async () => toStructure(await client.read('getMasterRecordAsOf', { path: { id: recordId ?? '' }, query: { date } })) ?? null,
    enabled: tenant !== undefined && recordId !== undefined,
    retry: false,
  });
}

/**
 * The successions of a set of entries up to a date, one read per entry (the contract reads the successors of one entry at a time). A read
 * that failed is reported, never left as an entry that has no successor.
 */
export function useConversions(recordIds: readonly string[], date: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  const results = useQueries({
    queries: recordIds.map((recordId) => ({
      queryKey: [...root(tenant?.id), 'successors', recordId, date],
      queryFn: async (): Promise<ConversionView | null> => toConversion(await client.read('getMasterRecordSuccessors', { path: { id: recordId }, query: { date } })) ?? null,
      enabled: tenant !== undefined,
      retry: false,
    })),
  });
  const edges = new Map<string, EdgeView>();
  for (const result of results) for (const edge of result.data?.edges ?? []) edges.set(edge.id, edge);
  return {
    isLoading: results.some((result) => result.isLoading),
    error: results.find((result) => result.error !== null)?.error ?? null,
    conversions: results.flatMap((result) => result.data ?? []),
    edges: [...edges.values()],
    refetch: () => Promise.all(results.map((result) => result.refetch())),
  };
}

export interface RecordSuccessionBody {
  predecessor_record_id: string;
  successor_record_id: string;
  succession_kind: SuccessionKind;
  effective_date: string;
  share_pct?: string;
  legal_basis: string;
  reason: string;
}

export function useRecordSuccession() {
  const client = useApiClient();
  return useCommand<RecordSuccessionBody>((body, attempt) => client.command('recordMasterSuccession', { body, attempt }));
}

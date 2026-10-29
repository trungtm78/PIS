import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { root, useCommand } from '../hooks';
import { toGate, toMapping, toRecon } from './model';
import type { GateView, MappingView, ReconView } from './model';

export const SOURCE_PAGE = 50;

interface Page<T> {
  items: T[];
  next: string | undefined;
}

const page = <T>(raw: unknown, map: (row: unknown) => T | undefined): Page<T> => {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as { items?: unknown; next_cursor?: unknown };
  return { items: Array.isArray(body.items) ? body.items.flatMap((row) => map(row) ?? []) : [], next: typeof body.next_cursor === 'string' ? body.next_cursor : undefined };
};

export interface MappingFilter {
  datasetId: string;
  status: string;
}

export const NO_MAPPING_FILTER: MappingFilter = { datasetId: '', status: '' };

/** The mappings of the datasets the caller may see, the latest first, a page at a time. */
export function useMappings(filter: MappingFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<Page<MappingView>, Error, { pages: Array<Page<MappingView>> }, readonly unknown[], string | undefined>({
    queryKey: [...root(tenant?.id), 'mappings', tenant?.membershipId, filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      page(
        await client.read('listSourceMappings', {
          query: { limit: SOURCE_PAGE, ...(filter.datasetId === '' ? {} : { dataset_id: filter.datasetId }), ...(filter.status === '' ? {} : { status: filter.status }), ...(pageParam === undefined ? {} : { cursor: pageParam }) } as never,
        }),
        toMapping,
      ),
    getNextPageParam: (last) => last.next,
    enabled: tenant !== undefined,
    retry: false,
  });
}

export interface GateFilter {
  datasetId: string;
  outcome: string;
}

export const NO_GATE_FILTER: GateFilter = { datasetId: '', outcome: '' };

/** What the gate did with the batches of the sources, the latest first, a page at a time. */
export function useGates(filter: GateFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<Page<GateView>, Error, { pages: Array<Page<GateView>> }, readonly unknown[], string | undefined>({
    queryKey: [...root(tenant?.id), 'gates', tenant?.membershipId, filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      page(
        await client.read('listBatchGates', {
          query: { limit: SOURCE_PAGE, ...(filter.datasetId === '' ? {} : { dataset_id: filter.datasetId }), ...(filter.outcome === '' ? {} : { outcome: filter.outcome }), ...(pageParam === undefined ? {} : { cursor: pageParam }) } as never,
        }),
        toGate,
      ),
    getNextPageParam: (last) => last.next,
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** The reconciliations, the latest first, a page at a time (the summary of each; the differences are read on the one that is opened). */
export function useReconciliations(result: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<Page<ReconView>, Error, { pages: Array<Page<ReconView>> }, readonly unknown[], string | undefined>({
    queryKey: [...root(tenant?.id), 'reconciliations', tenant?.membershipId, result],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => page(await client.read('listReconciliations', { query: { limit: SOURCE_PAGE, ...(result === '' ? {} : { result }), ...(pageParam === undefined ? {} : { cursor: pageParam }) } as never }), toRecon),
    getNextPageParam: (last) => last.next,
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** One reconciliation with its differences; nothing is read until one is chosen. */
export function useReconciliation(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ReconView | null>({
    queryKey: [...root(tenant?.id), 'reconciliation', tenant?.membershipId, id],
    queryFn: async () => toRecon(await client.read('getReconciliation', { path: { id: id as string } })) ?? null,
    enabled: tenant !== undefined && id !== undefined,
    retry: false,
  });
}

export function useProposeMapping() {
  const client = useApiClient();
  return useCommand<{ body: { dataset_id: string; source_system: string; source_field: string; target_field: string; transform_rule?: string; unit?: string } }>((input, attempt) => client.command('proposeSourceMapping', { body: input.body, attempt }));
}

export function useDecideMapping() {
  const client = useApiClient();
  return useCommand<{ id: string; version: number; body: { decision: string; note?: string } }>((input, attempt) => client.command('decideSourceMapping', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

export function useRunReconciliation() {
  const client = useApiClient();
  return useCommand<{ body: Record<string, string> }>((input, attempt) => client.command('runReconciliation', { body: input.body as never, attempt }));
}

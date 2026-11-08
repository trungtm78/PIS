import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import type { ConnectorList, Detail, Health, Incident, Reject, Run, Agent } from './model';

// What the hub shows depends on the membership as well as the tenant (the right is over the whole tenant): both are part of every key.
function useScopeKey(): readonly ['hub', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['hub', tenant?.id, tenant?.membershipId];
}

const q = (value: Record<string, string | number | boolean | undefined>): never => value as never;
const code = (value: string): never => ({ code: value }) as never;
const id = (value: string): never => ({ id: value }) as never;

export function useConnectors() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ConnectorList>({ queryKey: [...key, 'connectors'], queryFn: () => client.read('listHubConnectors') as Promise<ConnectorList>, enabled: key[1] !== undefined, retry: false });
}

export function useHealth() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Health>({ queryKey: [...key, 'health'], queryFn: () => client.read('getHubHealthSummary') as Promise<Health>, enabled: key[1] !== undefined, retry: false });
}

export function useConnector(connectorCode: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Detail>({
    queryKey: [...key, 'connector', connectorCode ?? ''],
    queryFn: () => client.read('getHubConnector', { path: code(connectorCode as string) }) as Promise<Detail>,
    enabled: key[1] !== undefined && connectorCode !== undefined,
    retry: false,
  });
}

interface Paged<Item> {
  items: Item[];
  next_cursor: string | null;
  as_of: string;
}

/** What a list screen needs of a paged read: every page loaded so far as one list, whether there is more, and the way to ask for it (the cursor is the server's, never made up here). */
function usePaged<Item, Page extends Paged<Item>>(key: readonly unknown[], enabled: boolean, read: (cursor: string | undefined) => Promise<Page>) {
  const query = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => read(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Page) => last.next_cursor ?? undefined,
    enabled,
    retry: false,
  });
  const pages = query.data?.pages;
  const last = pages === undefined ? undefined : (pages[pages.length - 1] as Page);
  const data = last === undefined || pages === undefined ? undefined : ({ ...last, items: pages.flatMap((page) => page.items) } as Page);
  return {
    data,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}

export function useRuns(connectorCode: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return usePaged<Run, Paged<Run>>([...key, 'runs', connectorCode ?? ''], key[1] !== undefined && connectorCode !== undefined, (cursor) =>
    client.read('listHubConnectorRuns', { path: code(connectorCode as string), query: q({ limit: 50, ...(cursor === undefined ? {} : { cursor }) }) }) as Promise<Paged<Run>>,
  );
}

export function useRejects(connectorCode: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return usePaged<Reject, Paged<Reject> & { open_count: number }>([...key, 'rejects', connectorCode ?? ''], key[1] !== undefined && connectorCode !== undefined, (cursor) =>
    client.read('listHubRejects', { path: code(connectorCode as string), query: q({ state: 'OPEN', limit: 100, ...(cursor === undefined ? {} : { cursor }) }) }) as Promise<Paged<Reject> & { open_count: number }>,
  );
}

export function useAgents(connectorCode: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<{ items: Agent[]; stale_after_minutes: number; as_of: string }>({
    queryKey: [...key, 'agents', connectorCode ?? ''],
    queryFn: () => client.read('listHubAgents', { query: q({ ...(connectorCode === undefined ? {} : { connector_code: connectorCode }) }) }) as Promise<{ items: Agent[]; stale_after_minutes: number; as_of: string }>,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export interface IncidentFilter {
  state: Incident['state'] | undefined;
  connectorCode: string | undefined;
}

export function useIncidents(filter: IncidentFilter) {
  const client = useApiClient();
  const key = useScopeKey();
  return usePaged<Incident, Paged<Incident>>([...key, 'incidents', filter.state ?? '', filter.connectorCode ?? ''], key[1] !== undefined, (cursor) =>
    client.read('listHubIncidents', {
      query: q({ ...(filter.state === undefined ? {} : { state: filter.state }), ...(filter.connectorCode === undefined ? {} : { connector_code: filter.connectorCode }), limit: 100, ...(cursor === undefined ? {} : { cursor }) }),
    }) as Promise<Paged<Incident>>,
  );
}

/** One command, one idempotency attempt per intention: the key is kept while the same request is retried and dropped when it ends. */
function useHubCommand<Input, Output = unknown>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Output>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useSetState() {
  const client = useApiClient();
  return useHubCommand<{ code: string; version: number; enabled: boolean; reason: string }>((input, attempt) =>
    client.command('setHubConnectorState', { path: code(input.code), body: { enabled: input.enabled, reason: input.reason }, ifMatchVersion: input.version, attempt }),
  );
}

export function useCaptureSnapshot() {
  const client = useApiClient();
  return useHubCommand<Record<string, never>>((_input, attempt) => client.command('captureHubSnapshot', { body: {}, attempt }));
}

export function useOpenIncident() {
  const client = useApiClient();
  return useHubCommand<{ connectorCode: string; summary: string; severity: Incident['severity'] }>((input, attempt) =>
    client.command('openHubIncident', { body: { connector_code: input.connectorCode, summary: input.summary, severity: input.severity }, attempt }),
  );
}

export function useDecideIncident() {
  const client = useApiClient();
  return useHubCommand<{ id: string; version: number; decision: 'ACKNOWLEDGE' | 'RESOLVE'; reason: string }>((input, attempt) =>
    client.command('decideHubIncident', { path: id(input.id), body: { decision: input.decision, reason: input.reason }, ifMatchVersion: input.version, attempt }),
  );
}

export function useProposeMapping() {
  const client = useApiClient();
  return useHubCommand<{ code: string; pipelineCode: string; mappingVersion: string; fields: Array<Record<string, unknown>> }>((input, attempt) =>
    client.command('proposeHubMapping', { path: code(input.code), body: { pipeline_code: input.pipelineCode, mapping_version: input.mappingVersion, fields: input.fields }, attempt }),
  );
}

export function useDecideMapping() {
  const client = useApiClient();
  return useHubCommand<{ id: string; version: number; decision: 'APPROVE' | 'REJECT'; reason: string }>((input, attempt) =>
    client.command('decideHubMapping', { path: id(input.id), body: { decision: input.decision, reason: input.reason }, ifMatchVersion: input.version, attempt }),
  );
}

export function useDecideReject() {
  const client = useApiClient();
  return useHubCommand<{ id: string; version: number; decision: 'REPROCESS' | 'DISCARD'; reason: string }>((input, attempt) =>
    client.command('decideHubReject', { path: id(input.id), body: { decision: input.decision, reason: input.reason }, ifMatchVersion: input.version, attempt }),
  );
}

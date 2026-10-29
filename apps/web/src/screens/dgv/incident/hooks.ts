import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { root, useCommand } from '../hooks';
import { filterQuery, toException, toIncident } from './model';
import type { ExceptionView, IncidentFilter, IncidentView } from './model';

export const INCIDENT_PAGE = 50;

interface Page<T> {
  items: T[];
  next: string | undefined;
}

const page = <T>(raw: unknown, map: (row: unknown) => T | undefined): Page<T> => {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as { items?: unknown; next_cursor?: unknown };
  return { items: Array.isArray(body.items) ? body.items.flatMap((row) => map(row) ?? []) : [], next: typeof body.next_cursor === 'string' ? body.next_cursor : undefined };
};

/** The incidents of the datasets the caller may see, the latest first, a page at a time. */
export function useIncidents(filter: IncidentFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<Page<IncidentView>, Error, { pages: Array<Page<IncidentView>> }, readonly unknown[], string | undefined>({
    queryKey: [...root(tenant?.id), 'incidents', tenant?.membershipId, filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => page(await client.read('get_resources_quality_incident', { query: { limit: INCIDENT_PAGE, ...filterQuery(filter, tenant?.membershipId), ...(pageParam === undefined ? {} : { cursor: pageParam }) } as never }), toIncident),
    getNextPageParam: (last) => last.next,
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** One incident with its history; nothing is read until one is chosen. */
export function useIncident(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<IncidentView | null>({
    queryKey: [...root(tenant?.id), 'incident', tenant?.membershipId, id],
    queryFn: async () => toIncident(await client.read('get_resources_quality_incident_id', { path: { id: id as string } })) ?? null,
    enabled: tenant !== undefined && id !== undefined,
    retry: false,
  });
}

export interface ExceptionFilter {
  /** Only the exceptions of this incident; none: all of them. */
  incidentId: string | undefined;
  status: string;
}

export const NO_EXCEPTION_FILTER: ExceptionFilter = { incidentId: undefined, status: '' };

/** The exceptions, the latest first, a page at a time (the values hidden by the server where the dataset is not the caller's). A reviewer reaches them whether or not they may read the incident behind. */
export function useExceptions(filter: ExceptionFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<Page<ExceptionView>, Error, { pages: Array<Page<ExceptionView>> }, readonly unknown[], string | undefined>({
    queryKey: [...root(tenant?.id), 'exceptions', tenant?.membershipId, filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      page(
        await client.read('get_resources_quality_exception', {
          query: { limit: INCIDENT_PAGE, ...(filter.incidentId === undefined ? {} : { incident_id: filter.incidentId }), ...(filter.status === '' ? {} : { status: filter.status }), ...(pageParam === undefined ? {} : { cursor: pageParam }) } as never,
        }),
        toException,
      ),
    getNextPageParam: (last) => last.next,
    enabled: tenant !== undefined,
    retry: false,
  });
}

export interface Versioned {
  id: string;
  version: number;
}

export function useAssignIncident() {
  const client = useApiClient();
  return useCommand<Versioned & { body: { assignee_user_id: string; due_at: string; note?: string } }>((input, attempt) => client.command('assignQualityIncident', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useTransitionIncident() {
  const client = useApiClient();
  return useCommand<Versioned & { body: { to_status: string; root_cause?: string; remediation?: string } }>((input, attempt) => client.command('transitionQualityIncident', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

export function useVerifyIncident() {
  const client = useApiClient();
  return useCommand<Versioned & { body: { decision: string; note: string } }>((input, attempt) => client.command('verifyQualityIncident', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

export function useDecideException() {
  const client = useApiClient();
  return useCommand<Versioned & { body: { decision: string; reason: string; waiver_expires_at?: string } }>((input, attempt) => client.command('post_quality_exceptions_id_decision', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

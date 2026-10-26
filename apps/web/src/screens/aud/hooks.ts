import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toEngagementDetail, toEngagementLine } from './model';
import type { CreateBody, EngagementDetail, EngagementLine, EngagementStatus, EngagementType, ScopeKind, StatusBody, StartBody } from './model';

// What the screens show depends on the engagements whose scope the signed-in membership meets, not only on the tenant: the membership is part of every key.
export function useScopeKey(): readonly ['aud', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['aud', tenant?.id, tenant?.membershipId];
}

export interface EngagementFilter {
  status: '' | EngagementStatus;
  type: '' | EngagementType;
}

/** The engagements in the scope of the caller, by code, filtered by the server on status and type. */
export function useEngagements(filter: EngagementFilter) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<EngagementLine[]>({
    queryKey: [...key, 'engagements', filter.status, filter.type],
    queryFn: async () => {
      const items: unknown[] = await client.readAll('listAuditEngagements', {
        query: { ...(filter.status === '' ? {} : { status: filter.status }), ...(filter.type === '' ? {} : { engagement_type: filter.type }) },
      });
      return items.flatMap((raw) => toEngagementLine(raw) ?? []);
    },
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One engagement with its file; an engagement outside the scope of the caller is a 404 like one that does not exist. */
export function useEngagement(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<EngagementDetail | undefined>({
    queryKey: [...key, 'engagement', id ?? ''],
    queryFn: async () => toEngagementDetail(await client.read('getAuditEngagement', { path: { id: id ?? '' } })),
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

/** The registration of an engagement: one idempotency attempt per intention, every cached read of AUD refreshed on success. */
export function useCreateEngagement() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    // The contract leaves the items of the scope open (an object each); the server reads them as a kind and an id.
    mutationFn: (body: CreateBody) => client.command('createAuditEngagement', { body: { ...body, scope: body.scope as unknown as Array<Record<string, never>> }, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface CommandInput<B> {
  id: string;
  version: number;
  body: B;
}

/** The start of an engagement, under the version the caller saw. */
export function useStartEngagement() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: CommandInput<StartBody>) =>
      client.command('startAuditEngagement', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The end of the fieldwork of an engagement. */
export function useEndFieldwork() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: CommandInput<StatusBody>) =>
      client.command('endAuditFieldwork', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The cancellation of an engagement that has no conclusion; the server releases its hold. */
export function useCancelEngagement() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: CommandInput<StatusBody>) =>
      client.command('cancelAuditEngagement', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface PlaceOption {
  id: string;
  code: string;
  name: string;
}

const READ_OF: Readonly<Record<ScopeKind, 'get_resources_organization_unit' | 'get_resources_project' | 'get_resources_contract'>> = {
  UNIT: 'get_resources_organization_unit',
  PROJECT: 'get_resources_project',
  CONTRACT: 'get_resources_contract',
};

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

/** The units, projects or contracts the caller may read, for the scope of an engagement; asked for only once the form is open. */
export function usePlaceOptions(kind: ScopeKind, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PlaceOption[]>({
    queryKey: [...key, 'places', kind],
    queryFn: async () => {
      const items: unknown[] = await client.readAll(READ_OF[kind]);
      return items.flatMap((raw) => {
        const row = asRecord(raw);
        const code = typeof row.code === 'string' ? row.code : '';
        const name = typeof row.name === 'string' ? row.name : typeof row.title === 'string' ? row.title : code;
        return typeof row.id === 'string' ? [{ id: row.id, code, name }] : [];
      });
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

export interface CoordinatorOption {
  id: string;
  name: string;
}

/** The active members that can coordinate an engagement; a caller who may not read the directory gets none and coordinates themselves. */
export function useCoordinatorOptions(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<CoordinatorOption[]>({
    queryKey: [...key, 'coordinators'],
    queryFn: async () => {
      const items: unknown[] = await client.readAll('get_resources_membership');
      return items.flatMap((raw) => {
        const row = asRecord(raw);
        return typeof row.id === 'string' && row.status === 'Active' ? [{ id: row.id, name: typeof row.display_name === 'string' ? row.display_name : row.id }] : [];
      });
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

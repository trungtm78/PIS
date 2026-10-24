import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toDataset, toMember } from './model';
import type { Classification, DatasetView, MemberOption, RegisterBody } from './model';

/** The key every query of the DGV screens of a tenant starts with: a command drops them all. */
export const root = (tenantId: string | undefined) => ['dgv', tenantId] as const;

export interface CatalogFilter {
  text: string;
  domain: string;
  classification: Classification | '';
}

export const NO_FILTER: CatalogFilter = { text: '', domain: '', classification: '' };

/** The datasets the caller may see that match the filter, by code. The server decides who sees what; the screen never filters for access. */
export function useCatalog(filter: CatalogFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DatasetView[]>({
    queryKey: [...root(tenant?.id), 'catalog', filter.text, filter.domain, filter.classification],
    queryFn: async () => {
      const query = {
        ...(filter.text.trim() === '' ? {} : { q: filter.text.trim() }),
        ...(filter.domain === '' ? {} : { domain: filter.domain }),
        ...(filter.classification === '' ? {} : { classification: filter.classification }),
      };
      return (await client.readAll('searchCatalog', { query })).flatMap((raw) => toDataset(raw) ?? []);
    },
    // The list of the previous filter stays on screen while the next one loads, so the form that was used is not replaced by a skeleton.
    placeholderData: keepPreviousData,
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** The active staff that can be chosen as owner or steward; `enabled: false` when the caller may not list members. */
export function useMembers(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<MemberOption[]>({
    queryKey: [...root(tenant?.id), 'members'],
    queryFn: async () => (await client.readAll('get_resources_membership')).flatMap((raw) => toMember(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** A command of the DGV screens: one idempotency attempt per payload, and every DGV query of the tenant is read again once it succeeded. */
export function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useRegisterDataset() {
  const client = useApiClient();
  return useCommand<RegisterBody>((body, attempt) => client.command('registerDataset', { body, attempt }));
}

export interface OwnershipInput {
  id: string;
  version: number;
  ownerId: string;
  stewardId: string;
  reason: string;
}

export function useAssignOwnership() {
  const client = useApiClient();
  return useCommand<OwnershipInput>((input, attempt) =>
    client.command('assignDatasetOwnership', {
      path: { id: input.id },
      body: { owner_user_id: input.ownerId, steward_user_id: input.stewardId, reason: input.reason },
      ifMatchVersion: input.version,
      attempt,
    }),
  );
}

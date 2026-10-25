import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toHouseholdLine, toIdentity } from './model';
import type { HouseholdLine, LinkBody, RegisterBody } from './model';

/** The households of a project in the scope of the caller, by code. They are masked; the reading that opens one is a mutation below and is not cached. */
export function useHouseholds(projectId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<HouseholdLine[]>({
    queryKey: [...key, 'households', projectId ?? ''],
    queryFn: async () => (await client.readAll('listAffectedHouseholds', { query: { project_id: projectId ?? '' } })).flatMap((raw) => toHouseholdLine(raw) ?? []),
    enabled: key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** The registration of a household: one idempotency attempt per intention, every cached read of the land screens refreshed on success. */
export function useRegisterHousehold() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: RegisterBody) => client.command('registerAffectedHousehold', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface LinkInput {
  householdId: string;
  body: LinkBody;
}

/** The link of a household to a parcel and the right it holds there. */
export function useLinkParcel() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: LinkInput) => client.command('linkHouseholdParcel', { path: { id: input.householdId }, body: input.body, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface RevealInput {
  householdId: string;
  reason: string;
}

/**
 * The one reading that opens the personal data of a household. It is a mutation, not a query: the answer is held by the dialog that asked for it and by nothing else (no cache key, no refetch on focus),
 * and every reading is recorded by the server with the reason that was given.
 */
export function useRevealIdentity() {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (input: RevealInput) => {
      const identity = toIdentity(await client.read('revealHouseholdIdentity', { path: { id: input.householdId }, query: { reason: input.reason.trim() } }));
      if (identity === undefined) throw new Error('the reading of the household could not be understood');
      return identity;
    },
    gcTime: 0,
  });
}

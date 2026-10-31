import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toProfile } from './types';
import type { LayoutProfile } from './types';

export const layoutKey = (tenantId: string | undefined) => ['doc', 'layout-profiles', tenantId] as const;

/** Every revision of every profile of the tenant, by code and revision: the pages of the list are followed to the end. */
export function useLayoutProfiles(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<LayoutProfile[]>({
    queryKey: layoutKey(tenant?.id),
    queryFn: async () => (await client.readAll('listDocumentLayoutProfiles')).map(toProfile),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: layoutKey(tenant?.id) });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      // A refusal can follow a step taken by somebody else: the list is read again.
      await queryClient.invalidateQueries({ queryKey: layoutKey(tenant?.id) });
    },
  });
}

/** Drafts the next revision of a profile: every value is judged against the legal ranges by the server. */
export function useCreateLayout() {
  const client = useApiClient();
  return useCommand((body: Record<string, unknown>, attempt) => client.command('createDocumentLayoutProfileRevision', { body: body as never, attempt }));
}

export interface PublishInput {
  id: string;
  version: number;
}

export function usePublishLayout() {
  const client = useApiClient();
  return useCommand((input: PublishInput, attempt) => client.command('publishDocumentLayoutProfile', { path: { id: input.id }, body: {} as never, ifMatchVersion: input.version, attempt }));
}

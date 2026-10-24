import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toPolicy, toPreview } from './model';
import type { PolicyRow, PreviewCounts } from './model';

// What the editor shows is the rule of the tenant for the member that is signed in: switching between two memberships keeps the query client,
// so the membership is part of every key.
function useScopeKey(): readonly ['cap-avc', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['cap-avc', tenant?.id, tenant?.membershipId];
}

/** Every version of every policy of the tenant, the newest first. */
export function usePolicies() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PolicyRow[]>({
    queryKey: [...key, 'policies'],
    queryFn: async () => (await client.readAll('listAvcPolicies')).flatMap((raw) => toPolicy(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The count of lines (or appropriations) the policy would put in OK, WARN and BLOCK now. */
export function usePreview(id: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PreviewCounts>({
    queryKey: [...key, 'preview', id ?? ''],
    queryFn: async () => toPreview(await client.read('previewAvcPolicy', { path: { id: id ?? '' } })),
    enabled: enabled && id !== undefined && key[1] !== undefined,
    retry: false,
  });
}

function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
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

export function useCreatePolicy() {
  const client = useApiClient();
  return useCommand<Record<string, unknown>>((body, attempt) => client.command('createAvcPolicyVersion', { body: body as never, attempt }));
}

export interface PublishInput {
  id: string;
  version: number;
}

export function usePublishPolicy() {
  const client = useApiClient();
  return useCommand<PublishInput>((input, attempt) => client.command('publishAvcPolicy', { path: { id: input.id }, ifMatchVersion: input.version, attempt }));
}

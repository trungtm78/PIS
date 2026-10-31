import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { root } from '../hooks';
import { toBindingList, toTermOption } from './model';
import type { BindingList, TermOption } from './model';

/** The bindings of a dataset with the coverage they give. */
export function useBindings(datasetId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<BindingList>({
    queryKey: [...root(tenant?.id), tenant?.membershipId, 'glossary', datasetId ?? ''],
    queryFn: async () => toBindingList(await client.read('listDatasetGlossaryBindings', { path: { id: datasetId ?? '' } })),
    enabled: tenant !== undefined && datasetId !== undefined,
    retry: false,
  });
}

/** The terms in force that can be bound, read with the right to read the glossary; `enabled: false` for a caller who lacks it. */
export function useTerms(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<TermOption[]>({
    queryKey: [...root(tenant?.id), tenant?.membershipId, 'glossary-terms'],
    queryFn: async () => (await client.readAll('listGlossaryTerms', { query: { status: 'PUBLISHED' } })).flatMap(toTermOption),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

export interface BindInput {
  datasetId: string;
  body: Record<string, unknown>;
}

export function useBindTerm() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: BindInput) => client.command('bindGlossaryTermToDataset', { path: { id: input.datasetId }, body: input.body as never, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toContext } from './model';
import type { NarrativeContext } from './model';

const root = (tenantId: string | undefined) => ['dis', tenantId, 'reports'] as const;

/** What a person needs to write the narrative of one report: the standard causes, the directives of the period, the previous period that can be inherited and what the approved rules say now. */
export function useNarrativeContext(reportId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<NarrativeContext>({
    queryKey: [...root(tenant?.id), 'narrative-context', reportId ?? ''],
    queryFn: async () => toContext(await client.read('getReportNarrativeContext', { path: { id: reportId ?? '' } })),
    enabled: tenant !== undefined && reportId !== undefined,
    retry: false,
  });
}

export interface InheritInput {
  reportId: string;
  version: number;
}

/** Copies the words of the previous period into the empty fields of the draft; the server keeps the trace of the copy and never overwrites what was written. */
export function useInheritNarrative() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: InheritInput) => client.command('inheritReportNarrative', { path: { id: input.reportId }, body: {}, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

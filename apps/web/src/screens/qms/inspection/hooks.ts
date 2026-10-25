import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toInspectionList } from './model';
import type { InspectionLine, RequestBody, ResultBody, ScheduleBody } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['qms-inspections', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['qms-inspections', tenant?.id, tenant?.membershipId];
}

/** The inspections in the scope of the caller, the latest request first; those of one contract when it is named. */
export function useInspections(contractId: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<InspectionLine[]>({
    queryKey: [...key, 'inspections', contractId],
    queryFn: async () => toInspectionList(await client.read('listInspections', { query: contractId === '' ? {} : { contract_id: contractId } })),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the reads of the inspections refreshed once it succeeds. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'qms-inspections' });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useRequestInspection() {
  const client = useApiClient();
  return useCommand<RequestBody>((body, attempt) => client.command('requestInspection', { body, attempt }));
}

export interface VersionedInput<Body> {
  id: string;
  version: number;
  body: Body;
}

export function useScheduleInspection() {
  const client = useApiClient();
  return useCommand<VersionedInput<ScheduleBody>>((input, attempt) => client.command('scheduleInspection', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useRecordInspectionResult() {
  const client = useApiClient();
  return useCommand<VersionedInput<ResultBody>>((input, attempt) => client.command('recordInspectionResult', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useCancelInspection() {
  const client = useApiClient();
  return useCommand<VersionedInput<{ reason: string }>>((input, attempt) => client.command('cancelInspection', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

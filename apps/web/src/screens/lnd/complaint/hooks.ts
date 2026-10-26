import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toComplaintLine } from './model';
import type { ComplaintLine, FileBody, ResolveBody } from './model';

/** The complaints of a project inside the units of the caller, by number. */
export function useComplaints(projectId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ComplaintLine[]>({
    queryKey: [...key, 'complaints', projectId ?? ''],
    queryFn: async () => (await client.readAll('listLandComplaints', { query: { project_id: projectId ?? '' } })).flatMap((raw) => toComplaintLine(raw) ?? []),
    enabled: key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** The filing of a complaint: one idempotency attempt per intention, every cached read of the land screens refreshed on success. */
export function useFileComplaint() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: FileBody) => client.command('fileLandComplaint', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ResolveInput {
  id: string;
  version: number;
  body: ResolveBody;
}

/** The answer to a complaint, under the version the caller saw. */
export function useResolveComplaint() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: ResolveInput) => client.command('resolveLandComplaint', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

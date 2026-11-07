import { ApiError } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toAppraisal, toList } from './model';

export interface ListFilter {
  status: string;
  kind: string;
  q: string;
  projectId: string | undefined;
  offset: number;
}

// What these screens show depends on the scope of the membership that is signed in, not only on the tenant: the membership is part of every key.
export function useScopeKey(): readonly ['fin1', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['fin1', tenant?.id, tenant?.membershipId];
}

export function useAppraisalList(filter: ListFilter) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'list', filter],
    queryFn: async () => {
      const query: Record<string, string | number> = { limit: 50, offset: filter.offset };
      if (filter.status !== '') query.status = filter.status;
      if (filter.kind !== '') query.kind = filter.kind;
      if (filter.q.trim() !== '') query.q = filter.q.trim();
      if (filter.projectId !== undefined) query.project_id = filter.projectId;
      return toList(await client.read('listInvestmentAppraisals' as never, { query } as never));
    },
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** An appraisal, or null when it is not there for the caller (another tenant, or outside the scope: a 404); any other failure is the failure of the read, never "nothing". */
export function useAppraisal(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'one', id ?? ''],
    queryFn: async () => {
      try {
        return toAppraisal(await client.read('getInvestmentAppraisal' as never, { path: { id: id ?? '' } } as never)) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the cached reads refreshed on success. */
function useCommand<Input, Answer = unknown>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Answer>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Answer, Error, Input>({
    mutationFn: (input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface CreateInput {
  body: Record<string, unknown>;
}

export function useCreateAppraisal() {
  const client = useApiClient();
  return useCommand<CreateInput, { resource_id?: string; code?: string }>((input, attempt) => client.command('createInvestmentAppraisal' as never, { body: input.body, attempt } as never) as Promise<{ resource_id?: string; code?: string }>);
}

export interface VersionedInput {
  id: string;
  version: number;
}

export function useUpdateInputs() {
  const client = useApiClient();
  return useCommand<VersionedInput & { body: Record<string, unknown> }>((input, attempt) => client.command('updateInvestmentAppraisalInputs' as never, { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt } as never));
}

export function useRunAppraisal() {
  const client = useApiClient();
  return useCommand<VersionedInput>((input, attempt) => client.command('runInvestmentAppraisal' as never, { path: { id: input.id }, body: {}, ifMatchVersion: input.version, attempt } as never));
}

export function useSubmitAppraisal() {
  const client = useApiClient();
  return useCommand<VersionedInput>((input, attempt) => client.command('submitInvestmentAppraisal' as never, { path: { id: input.id }, body: {}, ifMatchVersion: input.version, attempt } as never));
}

export function useApproveAppraisal() {
  const client = useApiClient();
  return useCommand<VersionedInput & { reason?: string }>((input, attempt) =>
    client.command('approveInvestmentAppraisal' as never, { path: { id: input.id }, body: input.reason === undefined || input.reason === '' ? {} : { reason: input.reason }, ifMatchVersion: input.version, attempt } as never),
  );
}

export function useReturnAppraisal() {
  const client = useApiClient();
  return useCommand<VersionedInput & { reason: string }>((input, attempt) => client.command('returnInvestmentAppraisal' as never, { path: { id: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt } as never));
}

export interface ExportedFile {
  file_name: string;
  media_type: string;
  content_base64: string;
  sha256: string;
}

export function useExportAppraisal() {
  const client = useApiClient();
  return useCommand<{ id: string; format: 'CSV' | 'XLSX' }, ExportedFile>((input, attempt) => client.command('exportInvestmentAppraisal' as never, { path: { id: input.id }, body: { format: input.format }, attempt } as never) as Promise<ExportedFile>);
}

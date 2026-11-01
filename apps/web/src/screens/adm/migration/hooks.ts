import { uploadFile } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { WORKING_REFRESH_MS, isWorking, registerBody, toBatch, toUploadedFile } from './model';
import type { Batch, RegisterForm, UploadedFile } from './model';

// What the list holds depends on the membership that is signed in, not only on the tenant.
const root = (tenantId: string | undefined, membershipId: string | undefined) => ['adm', 'migration', tenantId, membershipId] as const;

/** The batches, newest first; while one is being validated or applied the list is read again, so that it shows the batch finished or stopped. */
export function useBatches() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Batch[]>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'list'],
    queryFn: async () => (await client.readAll('listMigrationBatches')).flatMap((raw) => toBatch(raw) ?? []),
    refetchInterval: (query) => (query.state.data?.some((batch) => isWorking(batch.status)) === true ? WORKING_REFRESH_MS : false),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** One batch with the errors the dry run found row by row. */
export function useBatch(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Batch | undefined>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'one', id],
    queryFn: async () => toBatch(await client.read('getMigrationBatch', { path: { batchId: id as string } })),
    refetchInterval: (query) => (isWorking(query.state.data?.status) ? WORKING_REFRESH_MS : false),
    enabled: id !== undefined && tenant !== undefined,
    retry: false,
  });
}

function useBatchCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id, tenant?.membershipId) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Uploads the file of a conversion; the answer names the id to register it by and what the server read of it. */
export function useUploadFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<UploadedFile | undefined, unknown, File>({
    mutationFn: async (file) =>
      toUploadedFile(
        await uploadFile(client, 'uploadMigrationFile', { file, attempt: attempts.current.forPayload({ name: file.name, size: file.size, type: file.type, modified: file.lastModified }) }),
      ),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

export function useRegister() {
  const client = useApiClient();
  return useBatchCommand<RegisterForm>((form, attempt) => client.command('registerMigrationBatch', { body: registerBody(form) as never, attempt }));
}

export interface BatchActionInput {
  batch: Batch;
  reason: string;
}

export function useDryRun() {
  const client = useApiClient();
  return useBatchCommand<BatchActionInput>((input, attempt) =>
    client.command('dryRunMigrationBatch', { path: { batchId: input.batch.id }, body: { reason: input.reason.trim() } as never, ifMatchVersion: input.batch.version, attempt }),
  );
}

export function useApply() {
  const client = useApiClient();
  return useBatchCommand<BatchActionInput>((input, attempt) =>
    client.command('applyMigrationBatch', { path: { batchId: input.batch.id }, body: { reason: input.reason.trim() } as never, ifMatchVersion: input.batch.version, attempt }),
  );
}

export function useRollback() {
  const client = useApiClient();
  return useBatchCommand<BatchActionInput>((input, attempt) =>
    client.command('rollbackMigrationBatch', { path: { batchId: input.batch.id }, body: { reason: input.reason.trim() } as never, ifMatchVersion: input.batch.version, attempt }),
  );
}

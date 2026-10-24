import { ApiError, uploadFile } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toImportListItem, toImportView, toStagedFile } from './model';
import type { ImportBody, ImportListItem, ImportView, StagedFile } from './model';

// What a Treasury import shows depends on the scope of the membership that is signed in, not only on the tenant: switching between two
// memberships of one tenant keeps the query client, so the membership is part of every key.
export function useScopeKey(): readonly ['pay', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['pay', tenant?.id, tenant?.membershipId];
}

/** One import with the fate of its lines, its differences and the state of the adapter; null when the tenant has none with this id. */
export function useTreasuryImport(importId: string | null | undefined, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ImportView | null>({
    queryKey: [...key, 'import', importId ?? ''],
    queryFn: async () => {
      try {
        return toImportView(await client.read('getTreasuryImport', { path: { id: importId ?? '' } })) ?? null;
      } catch (error) {
        // An import of another tenant, or one this person may not see, is not there for them.
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: enabled && key[1] !== undefined && typeof importId === 'string',
    retry: false,
  });
}

/** The import of a stored statement file: one idempotency attempt per intention, the cached reads refreshed on success. */
export function useImportStatement() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: ImportBody) => client.command('importTreasuryStatement', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The earlier imports of the tenant, the newest first (empty for someone whose read is not on the whole tenant). */
export function useTreasuryImports(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ImportListItem[]>({
    queryKey: [...key, 'imports'],
    queryFn: async () => (await client.readAll('listTreasuryImports')).flatMap(toImportListItem),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** Puts the picked file in the store of the tenant and reads its header; nothing is imported yet. */
export function useUploadStatementFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<StagedFile | undefined, unknown, File>({
    mutationFn: async (file) => toStagedFile(await uploadFile(client, 'uploadTreasuryStatementFile', { file, attempt: attempts.current.forPayload({ name: file.name, size: file.size, type: file.type, modified: file.lastModified }) })),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

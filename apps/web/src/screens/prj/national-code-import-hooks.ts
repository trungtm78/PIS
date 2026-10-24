import { uploadFile } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useScopeKey } from './hooks';
import { holdsOnWholeTenant, toGrantAuthority, toImportResult, toUploadedFile } from './national-code-import-model';
import type { ImportResult, UploadedFile } from './national-code-import-model';

/** Puts the file into the shared upload pipeline (judged by its bytes, scanned); the answer names its key, its hash and what it holds. */
export function useUploadNationalCodeFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<UploadedFile | undefined, unknown, File>({
    mutationFn: async (file) => toUploadedFile(await uploadFile(client, 'uploadNationalCodeFile', { file, attempt: attempts.current.forPayload({ name: file.name, size: file.size, type: file.type, modified: file.lastModified }) })),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ImportInput {
  fileObjectKey: string;
  fileSha256: string;
  dryRun: boolean;
}

/** The dry run or the apply of the stored file: one idempotency attempt per intention; an apply refreshes the register and the board. */
export function useImportNationalCodes() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<ImportResult | undefined, unknown, ImportInput>({
    mutationFn: async (input) =>
      toImportResult(
        await client.command('importNationalProjectCodes', {
          body: { file_object_key: input.fileObjectKey, file_sha256: input.fileSha256, dry_run: input.dryRun },
          attempt: attempts.current.forPayload(input),
        }),
      ),
    onSuccess: async (_result, input) => {
      attempts.current.done();
      if (!input.dryRun) await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/**
 * Whether the caller holds the permission on the whole tenant, which the apply of the national file needs (the dry run does not). Undefined while the
 * grants are being read; a grant list that cannot be read counts as no authority on the whole tenant, so the apply stays closed.
 */
export function useWholeTenantAuthority(permission: string, enabled: boolean): boolean | undefined {
  const client = useApiClient();
  const key = useScopeKey();
  const authority = useQuery<boolean>({
    queryKey: [...key, 'authority', permission],
    queryFn: async () => holdsOnWholeTenant(toGrantAuthority(await client.read('getMyEffectiveAccess')), permission),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
  return authority.isError ? false : authority.data;
}

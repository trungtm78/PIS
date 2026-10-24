import { uploadFile } from '@machvon/api-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useScopeKey } from './hooks';
import { toImportResult, toUploadedFile } from './national-code-import-model';
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

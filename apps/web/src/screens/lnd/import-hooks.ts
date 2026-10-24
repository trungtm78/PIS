import { uploadFile } from '@machvon/api-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useScopeKey } from './hooks';
import { toImportResult, toUploadedFile } from './import-model';
import type { ImportResult, UploadedFile } from './import-model';

/** Puts the file into the shared upload pipeline (judged by its bytes, scanned); the answer names its id, its hash and whether its columns are those of the layout. */
export function useUploadParcelFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<UploadedFile | undefined, unknown, File>({
    mutationFn: async (file) => toUploadedFile(await uploadFile(client, 'uploadLandParcelFile', { file, attempt: attempts.current.forPayload({ name: file.name, size: file.size, type: file.type, modified: file.lastModified }) })),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ImportInput {
  projectId: string;
  fileObjectId: string;
  fileSha256: string;
}

/** The import of the stored file into a project: one idempotency attempt per intention; it refreshes the parcels of the screen. */
export function useImportParcels() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<ImportResult | undefined, unknown, ImportInput>({
    mutationFn: async (input) =>
      toImportResult(
        await client.command('importLandParcels', {
          body: { project_id: input.projectId, file_object_id: input.fileObjectId, file_sha256: input.fileSha256 },
          attempt: attempts.current.forPayload(input),
        }),
      ),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

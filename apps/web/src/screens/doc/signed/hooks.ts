import { uploadFile } from '@machvon/api-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import type { ExternalBody } from './rules';
import { toAttachResult, toFileCheck } from './types';
import type { AttachResult, FileCheck } from './types';

/** Puts the PDF into the shared upload pipeline for DOC and reads what it holds; one attempt per file, so a retry of the same file reuses its key. */
export function useUploadDocumentFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<FileCheck | undefined, unknown, File>({
    mutationFn: async (file) =>
      toFileCheck(await uploadFile(client, 'uploadDocumentFile', { file, attempt: attempts.current.forPayload({ name: file.name, size: file.size, type: file.type, modified: file.lastModified }) })),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

export interface AttachInput {
  documentId: string;
  version: number;
  fileObjectKey: string;
  fileSha256: string;
}

/** Attaches the file the leader signed with their own tool to the document that waits for the signature. */
export function useAttachSigned() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: AttachInput): Promise<AttachResult> =>
      toAttachResult(
        await client.command('uploadLeaderSignedDocument', {
          path: { id: input.documentId },
          body: { file_object_key: input.fileObjectKey, file_sha256: input.fileSha256 },
          ifMatchVersion: input.version,
          attempt: attempts.current.forPayload(input),
        }),
      ),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: ['doc'], predicate: (query) => query.queryKey[2] === tenant?.id });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Registers a document that was signed and numbered in another system as issued. */
export function useRegisterExternal() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (body: ExternalBody): Promise<AttachResult> => toAttachResult(await client.command('registerExternallySignedDocument', { body: { ...body, recipients: body.recipients as unknown as Array<Record<string, never>> }, attempt: attempts.current.forPayload(body) })),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: ['doc'], predicate: (query) => query.queryKey[2] === tenant?.id });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

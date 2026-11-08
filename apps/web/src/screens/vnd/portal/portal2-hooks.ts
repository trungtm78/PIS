import { uploadFile } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../shared/vnd-hooks';
import type { AttachmentLine, UploadPurpose } from './portal2-model';

const ready = (key: readonly [string, string | undefined, string | undefined]): boolean => key[1] !== undefined;

export { useVendorCommand as usePortal2Command } from '../shared/vnd-hooks';

/** The invitations of contractors to the portal, optionally by status and contractor. */
export function useInvitations(filters: { status: string; contractor: string }) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'portal2', 'invitations', filters],
    queryFn: () => client.read('listVendorPortalInvitations', { query: { ...(filters.status === '' ? {} : { status: filters.status }), ...(filters.contractor === '' ? {} : { contractor_id: filters.contractor }) } }),
    enabled: ready(key),
    retry: false,
    placeholderData: (previous) => previous,
  });
}

/** The files of the contractor of the caller (the contractor is never named by the screen). */
export function usePortalAttachments(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'portal2', 'attachments'], queryFn: () => client.read('listPortalAttachments'), enabled: ready(key) && enabled, retry: false });
}

export interface UploadInput {
  file: File;
  purpose: UploadPurpose;
  title: string;
}

/** Sends one file to the portal: the same intention (a retry of the same file) keeps its idempotency key; a success refreshes the list of files. */
export function useUploadPortalAttachment() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<AttachmentLine, unknown, UploadInput>({
    mutationFn: (input) =>
      uploadFile(client, 'uploadPortalAttachment', {
        file: input.file,
        query: { purpose: input.purpose, title: input.title },
        attempt: attempts.current.forPayload({ name: input.file.name, size: input.file.size, type: input.file.type, modified: input.file.lastModified, purpose: input.purpose, title: input.title }),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: [...key, 'portal2', 'attachments'] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

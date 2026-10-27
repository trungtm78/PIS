import { useMutation } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { exportBody, toDownload } from './model';
import type { Download, ExportForm } from './model';

/** Makes the file of a frozen snapshot; the answer names the export. The same request sent again under the same attempt is one export. */
export function useCreateExport() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (form: ExportForm) => client.command('createReportExport', { body: exportBody(form) as never, attempt: attempts.current.forPayload(form) }),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

/** Asks for the link of a file: the permission and the scope are judged again by the server each time, and a link lives a few minutes. */
export function useIssueDownload() {
  const client = useApiClient();
  return useMutation<Download | undefined, Error, string>({
    mutationFn: async (exportId) => toDownload(await client.read('getReportExportDownload', { path: { id: exportId } })),
  });
}

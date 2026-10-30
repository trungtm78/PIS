import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { exportBody, submissionBody, toBatches, toDownload } from './model';
import type { Batches, Download, ExportForm, SubmissionForm } from './model';

// What the screen shows depends on who is signed in, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['ctr-export', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ctr-export', tenant?.id, tenant?.membershipId];
}

/** The batches of the exports, the newest first, a page at a time, with the state of the adapter to the national database (`listContractorExports`). */
export function useBatches(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<Batches | null, Error, { pages: Array<Batches | null> }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'batches'],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toBatches(await client.read('listContractorExports', { query: pageParam === undefined ? { limit: 50 } : { limit: 50, cursor: pageParam } })) ?? null,
    getNextPageParam: (last) => last?.nextCursor,
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One command: one idempotency attempt per intention, and the batches are read again after it, also after a refusal. */
function useExportCommand<Input>(run: (client: ReturnType<typeof useApiClient>, input: Input, attempt: { key: string }) => Promise<unknown>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'ctr-export' });
  return useMutation({
    mutationFn: (input: Input) => run(client, input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await refresh();
    },
    onError: async (error) => {
      attempts.current.ended(error);
      await refresh();
    },
  });
}

export const useExport = () => useExportCommand<ExportForm>((client, form, attempt) => client.command('exportContractorRecords', { body: exportBody(form) as never, attempt }));

export interface SubmitInput {
  id: string;
  form: SubmissionForm;
}

export const useMarkSubmitted = () =>
  useExportCommand<SubmitInput>((client, input, attempt) => client.command('markContractorExportSubmitted', { path: { id: input.id }, body: submissionBody(input.form) as never, attempt }));

/** Asks for the link of a file: the permission is judged again by the server each time, and a link lives a few minutes. */
export function useIssueDownload() {
  const client = useApiClient();
  return useMutation<Download | undefined, Error, string>({
    mutationFn: async (id) => toDownload(await client.read('getContractorExportDownload', { path: { id } })),
  });
}

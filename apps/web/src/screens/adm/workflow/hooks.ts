import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toVersion } from './model';
import type { VersionView } from './model';

const PAGE = 200;
const MAX_PAGES = 25;
const root = (tenantId: string | undefined) => ['adm', 'workflow', tenantId] as const;

/** The versions of a business type, the latest revision first. */
export function useVersions(businessType: string, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<VersionView[]>({
    queryKey: [...root(tenant?.id), 'versions', businessType],
    queryFn: async () => {
      // Every page is read: the one in force may be on any of them, and a new draft starts from it.
      const all: VersionView[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const body = (await client.read('get_resources_workflow_version', { query: { business_type: businessType, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) } as never })) as { items?: unknown; next_cursor?: unknown };
        all.push(...(Array.isArray(body.items) ? body.items : []).flatMap((raw) => toVersion(raw) ?? []));
        if (typeof body.next_cursor !== 'string') break;
        cursor = body.next_cursor;
      }
      return all.sort((a, b) => b.revision - a.revision);
    },
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

function useWorkflowCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useCreateDraft() {
  const client = useApiClient();
  return useWorkflowCommand<{ businessType: string; definition: Record<string, unknown> }>((input, attempt) => client.command('createWorkflowDraft', { body: { business_type: input.businessType, definition: input.definition } as never, attempt }));
}

export function useUpdateDraft() {
  const client = useApiClient();
  return useWorkflowCommand<{ id: string; version: number; businessType: string; definition: Record<string, unknown> }>((input, attempt) =>
    client.command('updateWorkflowDraft', { path: { workflowVersionId: input.id }, body: { business_type: input.businessType, definition: input.definition } as never, ifMatchVersion: input.version, attempt }),
  );
}

export function usePublish() {
  const client = useApiClient();
  return useWorkflowCommand<{ id: string; version: number; reason: string }>((input, attempt) => client.command('publishWorkflowVersion', { path: { workflowVersionId: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
}

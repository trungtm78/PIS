import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toRecipients, toTemplate, toTemplatePage } from './model';
import type { TemplatePage, TemplateView } from './model';

export const templatesKey = (tenantId: string | undefined) => ['not', 'templates', tenantId] as const;
export const recipientsKey = (tenantId: string | undefined) => ['not', 'test-recipients', tenantId] as const;

/** The template revisions of the tenant, newest first, a page at a time (`get_resources_notification_template_version`). */
export function useTemplates(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<TemplatePage, Error, { pages: TemplatePage[] }, ReturnType<typeof templatesKey>, string | undefined>({
    queryKey: templatesKey(tenant?.id),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toTemplatePage(await client.read('get_resources_notification_template_version', { query: pageParam === undefined ? {} : { cursor: pageParam } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** One revision (`get_resources_notification_template_version_id`). */
export function useTemplate(id: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<TemplateView | undefined>({
    queryKey: [...templatesKey(tenant?.id), 'one', id ?? 'none'],
    queryFn: async () => toTemplate(await client.read('get_resources_notification_template_version_id', { path: { id: id as string } })),
    enabled: enabled && tenant !== undefined && id !== undefined,
    retry: false,
  });
}

/** The people a test message may go to (`listNotificationTestRecipients`). */
export function useTestRecipients(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<string[]>({
    queryKey: recipientsKey(tenant?.id),
    queryFn: async () => toRecipients(await client.read('listNotificationTestRecipients')),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

function useTemplateMutation<I>(run: (client: ReturnType<typeof useApiClient>, input: I, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>, keys: (tenantId: string | undefined) => readonly unknown[]) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: I) => run(client, input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: keys(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface CreateInput {
  body: Record<string, unknown>;
}

export const useCreateTemplate = () =>
  useTemplateMutation<CreateInput>((client, input, attempt) => client.command('createTemplateRevision', { body: input.body as never, attempt }), templatesKey);

export interface VersionedInput {
  templateId: string;
  version: number;
  reason: string;
}

export const useSubmitTemplate = () =>
  useTemplateMutation<VersionedInput>(
    (client, input, attempt) => client.command('submitTemplateRevision', { path: { templateId: input.templateId }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }),
    templatesKey,
  );

export const useDecideTemplate = () =>
  useTemplateMutation<VersionedInput & { decision: 'approve' | 'return' | 'reject' }>(
    (client, input, attempt) =>
      client.command('decideTemplateRevision', { path: { templateId: input.templateId }, body: { decision: input.decision, reason: input.reason, evidence_ids: [] } as never, ifMatchVersion: input.version, attempt }),
    templatesKey,
  );

export const useSetTestRecipients = () =>
  useTemplateMutation<{ membershipIds: string[] }>((client, input, attempt) => client.command('setNotificationTestRecipients', { body: { membership_ids: input.membershipIds } as never, attempt }), recipientsKey);

export interface TestSendInput {
  templateId: string;
  recipientIds: string[];
  samples: Record<string, unknown>;
}

export const useTestSend = () =>
  useTemplateMutation<TestSendInput>(
    (client, input, attempt) => client.command('sendTestNotification', { path: { templateId: input.templateId }, body: { test_recipient_ids: input.recipientIds, sample_variables: input.samples } as never, attempt }),
    templatesKey,
  );

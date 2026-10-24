import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import type { ConfirmationBody } from './rules';
import { toTemplatePage } from './types';
import type { TemplateGroup, TemplatePage, TemplateStatus } from './types';

export const PAGE_SIZE = 50;

export interface TemplateFilter {
  group: TemplateGroup | '';
  status: TemplateStatus | '';
  /** A date written year-month-day, or empty for every revision whatever its period. */
  asOf: string;
}

export const templatesRoot = (tenantId: string | undefined) => ['doc', 'templates', tenantId] as const;
export const templatesKey = (tenantId: string | undefined, filter: TemplateFilter) => ['doc', 'templates', tenantId, filter.group, filter.status, filter.asOf] as const;

/** The revisions of the library for the filter, page by page. */
export function useTemplates(filter: TemplateFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<TemplatePage, Error, { pages: TemplatePage[] }, ReturnType<typeof templatesKey>, string | undefined>({
    queryKey: templatesKey(tenant?.id, filter),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toTemplatePage(
        await client.read('listDocumentTemplates', {
          query: {
            limit: PAGE_SIZE,
            ...(filter.group === '' ? {} : { group_code: filter.group }),
            ...(filter.status === '' ? {} : { status: filter.status }),
            ...(filter.asOf === '' ? {} : { as_of_date: filter.asOf }),
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: tenant !== undefined,
    retry: false,
  });
}

export interface VersionedInput {
  templateId: string;
  version: number;
}

export interface ConfirmInput extends VersionedInput {
  body: ConfirmationBody;
}

export interface RetireInput extends VersionedInput {
  reason: string;
}

/** One idempotency attempt per intention: a retry of the same request reuses it, a different request starts a new one. */
function useCommandSupport() {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  const settled = async (): Promise<void> => {
    attempts.current.done();
    await queryClient.invalidateQueries({ queryKey: templatesRoot(tenant?.id) });
  };
  return { attempts, settled };
}

/** Publishes a draft (versioned: the server answers 409 for a stale version, 403 SELF_APPROVAL_DENIED for the drafter). */
export function usePublishTemplate() {
  const client = useApiClient();
  const { attempts, settled } = useCommandSupport();
  return useMutation({
    mutationFn: (input: VersionedInput) =>
      client.command('publishDocumentTemplate', { path: { id: input.templateId }, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: settled,
    onError: (error) => attempts.current.ended(error),
  });
}

/** Records the legal confirmation of a published revision: a reference and the evidence document. */
export function useConfirmTemplate() {
  const client = useApiClient();
  const { attempts, settled } = useCommandSupport();
  return useMutation({
    mutationFn: (input: ConfirmInput) =>
      client.command('confirmDocumentTemplateLegalBasis', {
        path: { id: input.templateId },
        body: input.body,
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: settled,
    onError: (error) => attempts.current.ended(error),
  });
}

export function useRetireTemplate() {
  const client = useApiClient();
  const { attempts, settled } = useCommandSupport();
  return useMutation({
    mutationFn: (input: RetireInput) =>
      client.command('retireDocumentTemplate', {
        path: { id: input.templateId },
        body: { reason: input.reason },
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: settled,
    onError: (error) => attempts.current.ended(error),
  });
}

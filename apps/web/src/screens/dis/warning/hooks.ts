import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { ruleBody, toRules, toWarningPage } from './model';
import type { RuleForm, RuleView, WarningPage, WarningView } from './model';

const root = (tenantId: string | undefined) => ['dis', tenantId, 'warnings'] as const;
const PAGE_SIZE = 25;

export interface WarningFilter {
  status: string;
  severity: string;
  ruleCode: string;
}

/** Every revision of every rule, with what a draft would open on the latest frozen close snapshot. */
export function useRules() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<RuleView[]>({
    queryKey: [...root(tenant?.id), 'rules'],
    queryFn: async () => toRules(await client.read('listEarlyWarningRules')),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** The warnings of the projects in the scope of the caller, newest first, a page at a time, narrowed by the filter. */
export function useWarnings(filter: WarningFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<WarningPage, Error, { pages: WarningPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...root(tenant?.id), 'list', filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toWarningPage(
        await client.read('listEarlyWarnings', {
          query: { limit: PAGE_SIZE, ...(filter.status === '' ? {} : { status: filter.status }), ...(filter.severity === '' ? {} : { severity: filter.severity }), ...(filter.ruleCode === '' ? {} : { rule_code: filter.ruleCode }), ...(pageParam === undefined ? {} : { cursor: pageParam }) },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: tenant !== undefined,
    retry: false,
  });
}

function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** A new revision of a rule, as a draft: nothing is evaluated by it until someone else publishes it. */
export function useCreateRule() {
  const client = useApiClient();
  return useCommand<RuleForm>((form, attempt) => client.command('createEarlyWarningRuleVersion', { body: ruleBody(form), attempt }));
}

/** Publishes a draft under the version the screen showed (the author does not: the server says so). */
export function usePublishRule() {
  const client = useApiClient();
  return useCommand<{ rule: RuleView }>((input, attempt) => client.command('publishEarlyWarningRule', { path: { id: input.rule.id }, ifMatchVersion: input.rule.version, attempt }));
}

export function useAcknowledge() {
  const client = useApiClient();
  return useCommand<{ warning: WarningView; reason: string }>((input, attempt) =>
    client.command('acknowledgeEarlyWarning', { path: { id: input.warning.id }, body: { reason: input.reason }, ifMatchVersion: input.warning.version, attempt }),
  );
}

export function useDismiss() {
  const client = useApiClient();
  return useCommand<{ warning: WarningView; reason: string }>((input, attempt) =>
    client.command('dismissEarlyWarning', { path: { id: input.warning.id }, body: { reason: input.reason }, ifMatchVersion: input.warning.version, attempt }),
  );
}

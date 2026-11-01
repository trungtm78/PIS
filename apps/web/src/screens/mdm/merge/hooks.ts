import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { root, useCommand } from '../hooks';
import { mergeBody, ruleBody, toMerge, toRule, unmergeBody } from './model';
import type { Merge, MergeForm, Overrides, Rule, RuleForm, UnmergeAnswer } from './model';

/** The rules of survivorship, newest first (all the types: a screen filters them). */
export function useRules() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Rule[]>({
    queryKey: [...root(tenant?.id), tenant?.membershipId, 'survivorship-rules'],
    queryFn: async () => (await client.readAll('listSurvivorshipRules')).flatMap((raw) => toRule(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** The merges, newest first. */
export function useMerges() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Merge[]>({
    queryKey: [...root(tenant?.id), tenant?.membershipId, 'master-merges'],
    queryFn: async () => (await client.readAll('listMasterMerges')).flatMap((raw) => toMerge(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function useDraftRule() {
  const client = useApiClient();
  return useCommand<RuleForm>((form, attempt) => client.command('createSurvivorshipRuleVersion', { body: ruleBody(form) as never, attempt }));
}

export interface PublishRuleInput {
  id: string;
  version: number;
}

export function usePublishRule() {
  const client = useApiClient();
  return useCommand<PublishRuleInput>((input, attempt) => client.command('publishSurvivorshipRule', { path: { id: input.id }, body: {} as never, ifMatchVersion: input.version, attempt }));
}

export interface MergeInput {
  form: MergeForm;
  /** The version of the survivor that was read. */
  survivorVersion: number;
  overrides: Overrides;
}

export function useMergeRecords() {
  const client = useApiClient();
  return useCommand<MergeInput>((input, attempt) =>
    client.command('post_master_records_id_merge', { path: { id: input.form.survivorId }, body: mergeBody(input.form, input.overrides) as never, ifMatchVersion: input.survivorVersion, attempt }),
  );
}

export interface UnmergeInput {
  merge: Merge;
  reason: string;
  answers: Record<string, UnmergeAnswer>;
}

export function useUnmerge() {
  const client = useApiClient();
  return useCommand<UnmergeInput>((input, attempt) =>
    client.command('unmergeMasterRecords', { path: { id: input.merge.id }, body: unmergeBody(input.reason, input.answers) as never, ifMatchVersion: input.merge.version, attempt }),
  );
}

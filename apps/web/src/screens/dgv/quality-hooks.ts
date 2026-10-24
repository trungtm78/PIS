import type { components } from '@machvon/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import { root, useCommand } from './hooks';
import { toDataset } from './model';
import type { DatasetView } from './model';
import { toRule, toScorecard, toSummary } from './quality-model';
import type { QualitySummary, RuleDraftBody, RuleView, ScorecardView } from './quality-model';

export interface DashboardFilter {
  domain: string;
}

export const NO_DASHBOARD_FILTER: DashboardFilter = { domain: '' };

export interface DashboardData {
  datasets: DatasetView[];
  /** The picture of every dataset the filter matches, counted by the server: not of the rows shown. */
  summary: QualitySummary;
}

/**
 * The datasets the caller may see with their badge and score, and the summary over all of them (DGV-01). The summary is asked of the server
 * on its own (one row is enough) so it counts every dataset that matches, and a dataset that was never assessed is left out of its average
 * by the server, not by this screen.
 */
export function useQualityDashboard(filter: DashboardFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DashboardData>({
    queryKey: [...root(tenant?.id), 'quality-dashboard', filter.domain],
    queryFn: async () => {
      const query = filter.domain.trim() === '' ? {} : { domain: filter.domain.trim() };
      const [items, first] = await Promise.all([client.readAll('searchCatalog', { query }), client.read('searchCatalog', { query: { ...query, limit: 1 } })]);
      const summary = toSummary((first as { summary?: unknown }).summary);
      if (summary === undefined) throw new Error('searchCatalog answered without a summary');
      return { datasets: items.flatMap((raw) => toDataset(raw) ?? []), summary };
    },
    placeholderData: keepPreviousData,
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** The scorecard of one dataset; `undefined` while no dataset is chosen. */
export function useScorecard(datasetId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ScorecardView>({
    queryKey: [...root(tenant?.id), 'scorecard', datasetId],
    queryFn: async () => {
      const card = toScorecard(await client.read('getQualityScorecard', { path: { id: datasetId as string } }));
      if (card === undefined) throw new Error('getQualityScorecard answered with an unusable scorecard');
      return card;
    },
    enabled: tenant !== undefined && datasetId !== undefined,
    retry: false,
  });
}

/** The rule versions of one dataset, by code and revision. */
export function useQualityRules(datasetId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<RuleView[]>({
    queryKey: [...root(tenant?.id), 'quality-rules', datasetId],
    queryFn: async () => (await client.readAll('get_resources_quality_rule_version', { query: { dataset_id: datasetId as string } as Record<string, string> })).flatMap((raw) => toRule(raw) ?? []),
    enabled: enabled && tenant !== undefined && datasetId !== undefined,
    retry: false,
  });
}

export function useCreateRule() {
  const client = useApiClient();
  return useCommand<RuleDraftBody>((body, attempt) => client.command('createQualityRuleVersion', { body: body as components['schemas']['DgvRuleDraft'], attempt }));
}

export interface ApproveInput {
  id: string;
  version: number;
}

export function useApproveRule() {
  const client = useApiClient();
  return useCommand<ApproveInput>((input, attempt) => client.command('approveQualityRuleVersion', { path: { id: input.id }, ifMatchVersion: input.version, attempt }));
}

export interface RunInput {
  contractId: string;
  snapshotId: string;
}

export function useRunChecks() {
  const client = useApiClient();
  return useCommand<RunInput>((input, attempt) =>
    client.command('runQualityChecks', { body: { dataset_contract_id: input.contractId, snapshot_id: input.snapshotId, trigger: 'MANUAL' }, attempt }),
  );
}

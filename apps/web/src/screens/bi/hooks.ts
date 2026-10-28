import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { metricBody, toMetric } from './bi-model';
import type { Metric, MetricValues } from './bi-model';
import { toDataset, toVersion } from './dataset-model';
import type { Dataset, DatasetVersion } from './dataset-model';
import { policyBody, toPolicy } from './policy-model';
import { toQueryResult } from './query-model';
import type { QueryResult } from './query-model';
import type { Policy, PolicyValues } from './policy-model';

/** Every read and every mutation of the BI screens lives under this key of the tenant, so one command refreshes them all. */
export const biRoot = (tenantId: string | undefined) => ['bi', tenantId] as const;

/** The registry of the tenant, every revision of it, by code. */
export function useMetrics() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Metric[]>({
    queryKey: [...biRoot(tenant?.id), 'metrics', tenant?.membershipId],
    queryFn: async () => (await client.readAll('get_resources_metric_definition')).flatMap((raw) => toMetric(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** One revision of a metric. */
export function useMetric(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Metric>({
    queryKey: [...biRoot(tenant?.id), 'metric', tenant?.membershipId, id],
    queryFn: async () => {
      const metric = toMetric(await client.read('get_resources_metric_definition_id', { path: { id: id as string } }));
      if (metric === undefined) throw new Error('the metric could not be read');
      return metric;
    },
    enabled: tenant !== undefined && id !== undefined,
    retry: false,
  });
}

/** Drafts a metric of the tenant: one idempotency attempt per intention, the cached reads refreshed on success. */
export function useCreateMetric() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (values: MetricValues) => client.command('createTenantMetricDefinition', { body: metricBody(values), attempt: attempts.current.forPayload(values) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The datasets of BI, with the approved joins and the version that serves. */
export function useDatasets() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Dataset[]>({
    queryKey: [...biRoot(tenant?.id), 'datasets', tenant?.membershipId],
    queryFn: async () => (await client.readAll('listBiDatasets')).flatMap((raw) => toDataset(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** The versions of one dataset by period, the newest first. */
export function useDatasetVersions(datasetId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DatasetVersion[]>({
    queryKey: [...biRoot(tenant?.id), 'dataset-versions', tenant?.membershipId, datasetId],
    queryFn: async () => (await client.readAll('listBiDatasetVersions', { path: { id: datasetId as string } })).flatMap((raw) => toVersion(raw) ?? []),
    enabled: tenant !== undefined && datasetId !== undefined,
    retry: false,
  });
}

export interface BuildValues {
  datasetId: string;
  asOfPeriod: string;
}

/** Builds the version of a period: one idempotency attempt per intention, the cached reads refreshed on success. */
export function useBuildVersion() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (values: BuildValues) => client.command('buildBiDatasetVersion', { path: { id: values.datasetId }, body: { as_of_period: values.asOfPeriod.trim() }, attempt: attempts.current.forPayload(values) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The row and column policies, of one dataset when it is named. */
export function usePolicies(datasetId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Policy[]>({
    queryKey: [...biRoot(tenant?.id), 'policies', tenant?.membershipId, datasetId ?? ''],
    queryFn: async () => (await client.readAll('listBiAccessPolicies', datasetId === undefined ? undefined : { query: { dataset_id: datasetId } })).flatMap((raw) => toPolicy(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** Drafts a policy: one idempotency attempt per intention, the cached reads refreshed on success. */
export function useCreatePolicy() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (values: PolicyValues) => client.command('createBiAccessPolicy', { body: policyBody(values), attempt: attempts.current.forPayload(values) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** One query of a metric over a snapshot, cut by a dimension: a fresh idempotency key each time (the same question asked later gets a new answer, from the cache or not). */
export function useRunQuery() {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (input: { metricId: string; snapshotId: string; dimension?: string | undefined; contextToken?: string | undefined }) =>
      toQueryResult(
        await client.command('post_dashboard_queries', {
          body: { metric_version_id: input.metricId, snapshot_id: input.snapshotId, dimensions: input.dimension === undefined ? [] : [input.dimension], filters: [], ...(input.contextToken === undefined ? {} : { context_token: input.contextToken }) },
        }),
      ),
  });
}

/** One step down a drill: the token of a group and the dimension to cut it by. */
export function useExplain() {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (input: { token: string; dimension: string }) => toQueryResult(await client.read('explainBiMetric', { query: { drill_token: input.token, child_dimension: input.dimension } })),
  });
}

/** A new context on the newest snapshot of the period of a token. */
export function useRefreshContext() {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (token: string) => {
      const answer = (await client.command('refreshBiQueryContext', { body: { drill_token: token } })) as unknown as { snapshot_id?: string; drill_token?: string };
      return { snapshotId: answer.snapshot_id, token: answer.drill_token };
    },
  });
}

/** The tile of a metric over a snapshot, for the board: the total, with nothing cut. */
export function useTile(metricId: string, snapshotId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<QueryResult>({
    queryKey: [...biRoot(tenant?.id), 'tile', tenant?.membershipId, metricId, snapshotId],
    queryFn: async () => {
      const result = toQueryResult(await client.command('post_dashboard_queries', { body: { metric_version_id: metricId, snapshot_id: snapshotId as string, dimensions: [], filters: [] } }));
      if (result === undefined) throw new Error('the answer could not be read');
      return result;
    },
    enabled: tenant !== undefined && snapshotId !== undefined,
    retry: false,
    staleTime: 60_000,
  });
}

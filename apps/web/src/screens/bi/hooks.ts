import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { metricBody, toMetric } from './bi-model';
import type { Metric, MetricValues } from './bi-model';
import { createBody, toDashboard } from './dashboard-model';
import type { CreateForm, Dashboard } from './dashboard-model';
import { exportBody, scheduleBody, toDownload, toExportJob, toSchedule } from './export-model';
import type { ExportForm, ExportJob, ExportSchedule, ScheduleForm } from './export-model';
import { toDataset, toVersion } from './dataset-model';
import type { Dataset, DatasetVersion } from './dataset-model';
import { policyBody, toPolicy } from './policy-model';
import { JOB_WAIT, resolveQuery, toQueryResult } from './query-model';
import type { JobWatch } from './query-model';
import type { QueryResult } from './query-model';
import type { Policy, PolicyValues } from './policy-model';
import { decisionBody, requestBody, toRequest } from './publication-model';
import type { Decision, PublicationRequest, RequestForm } from './publication-model';
import { lineageParams, toMetricLineage } from './metric-lineage-model';
import type { MetricLineage, MetricLineageQuery } from './metric-lineage-model';
import { LOG_PAGE_SIZE, filterQuery, toRunPage } from './query-log-model';
import type { RunFilter, RunPage } from './query-log-model';
import { shareBody } from './share-model';
import type { ShareForm } from './share-model';

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

/** The versions of several datasets at once (the board asks each dataset its own snapshot); same cache entries as `useDatasetVersions`, one result per id in the order given. */
export function useDatasetsVersions(datasetIds: readonly string[]) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQueries({
    queries: datasetIds.map((datasetId) => ({
      queryKey: [...biRoot(tenant?.id), 'dataset-versions', tenant?.membershipId, datasetId],
      queryFn: async (): Promise<DatasetVersion[]> => (await client.readAll('listBiDatasetVersions', { path: { id: datasetId } })).flatMap((raw) => toVersion(raw) ?? []),
      enabled: tenant !== undefined,
      retry: false,
    })),
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
    mutationFn: (values: BuildValues) =>
      client.command('buildBiDatasetVersion', { path: { id: values.datasetId }, body: { as_of_period: values.asOfPeriod.trim() }, attempt: attempts.current.forPayload(values) }),
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
/**
 * What a question that became a job waits with: the run of the job is looked at through the client of the session, and the question is dropped when the screen is left, when its query is cancelled or when the member or the tenant is
 * another than the one that asked (a request of the old tenant is never sent with the credentials of the new one).
 */
function useJobWatch(): (signal?: AbortSignal) => JobWatch {
  const client = useApiClient();
  const { tenant } = useSession();
  const identity = `${tenant?.id ?? ''}:${tenant?.membershipId ?? ''}`;
  const current = useRef(identity);
  current.current = identity;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (signal) => {
    const asked = current.current;
    return {
      poll: (id) => client.read('getBiQueryRun', { path: { id } }),
      cancelled: () => !mounted.current || current.current !== asked || signal?.aborted === true,
      ...JOB_WAIT,
    };
  };
}

export function useRunQuery() {
  const client = useApiClient();
  const watch = useJobWatch();
  return useMutation({
    mutationFn: async (input: { metricId: string; snapshotId: string; dimension?: string | undefined; contextToken?: string | undefined }) =>
      resolveQuery(
        () =>
          client.command('post_dashboard_queries', {
            body: {
              metric_version_id: input.metricId,
              snapshot_id: input.snapshotId,
              dimensions: input.dimension === undefined ? [] : [input.dimension],
              filters: [],
              ...(input.contextToken === undefined ? {} : { context_token: input.contextToken }),
            },
          }),
        watch(),
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
export function useTile(metricId: string, snapshotId: string | undefined, dimension?: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  const watch = useJobWatch();
  return useQuery<QueryResult>({
    queryKey: [...biRoot(tenant?.id), 'tile', tenant?.membershipId, metricId, snapshotId, dimension ?? ''],
    queryFn: async ({ signal }) => {
      const result = await resolveQuery(
        () => client.command('post_dashboard_queries', { body: { metric_version_id: metricId, snapshot_id: snapshotId as string, dimensions: dimension === undefined ? [] : [dimension], filters: [] } }),
        watch(signal),
      );
      if (result === undefined) throw new Error('the answer could not be read');
      return result;
    },
    enabled: tenant !== undefined && snapshotId !== undefined,
    retry: false,
    staleTime: 60_000,
  });
}

/** The library of the dashboards of the caller, with the state of the version each points to. */
export function useDashboards() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Dashboard[]>({
    queryKey: [...biRoot(tenant?.id), 'dashboards', tenant?.membershipId],
    queryFn: async () => (await client.readAll('listDashboards')).flatMap((raw) => toDashboard(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** One dashboard with its versions, the newest first. */
export function useDashboard(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Dashboard>({
    queryKey: [...biRoot(tenant?.id), 'dashboard', tenant?.membershipId, id],
    queryFn: async () => {
      const dashboard = toDashboard(await client.read('getDashboard', { path: { id: id as string } }));
      if (dashboard === undefined) throw new Error('the dashboard could not be read');
      return dashboard;
    },
    enabled: tenant !== undefined && id !== undefined,
    retry: false,
  });
}

/** Makes a dashboard: one idempotency attempt per intention, the cached reads refreshed on success and on a refusal (another may have taken the code). */
export function useCreateDashboard() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (values: CreateForm) => client.command('createDashboard', { body: createBody(values), attempt: attempts.current.forPayload(values) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface SaveVersionInput {
  dashboardId: string;
  version: number;
  body: Record<string, unknown>;
}

/** Saves the next version of a dashboard, under the version of the dashboard it was read at. */
export function useSaveVersion() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: SaveVersionInput) =>
      client.command('saveDashboardVersion', { path: { id: input.dashboardId }, body: input.body as never, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      // A refusal can follow a step taken by somebody else: what is shown is read again.
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
  });
}

/** The requests to publish, the newest first, narrowed by their state when one is given. */
export function usePublications(status: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PublicationRequest[]>({
    queryKey: [...biRoot(tenant?.id), 'publications', tenant?.membershipId, status ?? 'all'],
    queryFn: async () => (await client.readAll('listBiPublicationRequests', status === undefined ? {} : { query: { status } as never })).flatMap((raw) => toRequest(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** Asks to publish an object: one idempotency attempt per intention, every read of the screens refreshed on success and on a refusal. */
export function useSubmitPublication() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (form: RequestForm) => client.command('submitBiPublication', { body: requestBody(form) as never, attempt: attempts.current.forPayload(form) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
  });
}

export interface DecideInput {
  requestId: string;
  version: number;
  decision: Decision;
  comment: string;
}

/** Decides a request under the version it was read at: another's decision in the meantime is a conflict, and what is shown is read again. */
export function useDecidePublication() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: DecideInput) =>
      client.command('decideBiPublication', {
        path: { id: input.requestId },
        body: decisionBody(input.decision, input.comment) as never,
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
  });
}

export interface ShareInput {
  dashboardId: string;
  version: number;
  form: ShareForm;
}

/** Shares a dashboard under the version of the dashboard it was read at: one idempotency attempt per intention, every read refreshed on success and on a refusal. */
export function useShareDashboard() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: ShareInput) =>
      client.command('shareDashboard', { path: { id: input.dashboardId }, body: shareBody(input.form) as never, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
  });
}

export interface RevokeInput {
  shareId: string;
  version: number;
}

/** Takes a share back, under the version of the share it was read at. */
export function useRevokeShare() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: RevokeInput) => client.command('revokeDashboardShare', { path: { id: input.shareId }, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
  });
}

/** The files of the exports made for the caller, the newest first. */
export function useExports() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ExportJob[]>({
    queryKey: [...biRoot(tenant?.id), 'exports', tenant?.membershipId],
    queryFn: async () => (await client.readAll('listBiExports')).flatMap((raw) => toExportJob(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** Asks for an export: one idempotency attempt per intention, every read refreshed on success and on a refusal (a refusal is kept as a job). */
export function useRequestExport() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (form: ExportForm) => client.command('requestBiExport', { body: exportBody(form) as never, attempt: attempts.current.forPayload(form) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
  });
}

/** The link to the file of one job: the server judges the person again when it gives it, so it is asked for at the moment of the download. */
export function useExportLink() {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const download = toDownload(await client.read('getBiExport', { path: { id } }));
      if (download === undefined) throw new Error('the export has no file to download');
      return download;
    },
  });
}

/** The schedules of the exports of the caller, the newest first. */
export function useSchedules() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ExportSchedule[]>({
    queryKey: [...biRoot(tenant?.id), 'export-schedules', tenant?.membershipId],
    queryFn: async () => (await client.readAll('listBiExportSchedules')).flatMap((raw) => toSchedule(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** Makes a schedule: one idempotency attempt per intention, every read refreshed on success and on a refusal. */
export function useCreateSchedule() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (form: ScheduleForm) => client.command('createBiExportSchedule', { body: scheduleBody(form) as never, attempt: attempts.current.forPayload(form) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      await queryClient.invalidateQueries({ queryKey: biRoot(tenant?.id) });
    },
  });
}

/** The log of the queries, newest first, a page at a time, narrowed by the filter applied (the server validates each of them). It is read over the whole tenant: a person with less is refused. */
export function useQueryRuns(filter: RunFilter, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<RunPage, Error, { pages: RunPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...biRoot(tenant?.id), 'query-runs', tenant?.membershipId, filter.status, filter.period.trim()],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toRunPage(await client.read('listBiQueryRuns', { query: { limit: LOG_PAGE_SIZE, ...filterQuery(filter), ...(pageParam === undefined ? {} : { cursor: pageParam }) } as never })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The lineage of a metric, up or down: the server decides which nodes the person sees and shows the others as restricted; nothing is asked until a metric is chosen. */
export function useMetricLineage(query: MetricLineageQuery | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<MetricLineage>({
    queryKey: [...biRoot(tenant?.id), 'lineage', tenant?.membershipId, query?.metricId, query?.direction, query?.depth],
    queryFn: async () => {
      const lineage = toMetricLineage(await client.read('getBiLineage', { path: { id: (query as MetricLineageQuery).metricId }, query: lineageParams(query as MetricLineageQuery) as never }));
      if (lineage === undefined) throw new Error('the lineage could not be read');
      return lineage;
    },
    enabled: tenant !== undefined && query !== undefined,
    retry: false,
  });
}

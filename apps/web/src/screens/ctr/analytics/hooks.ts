import { useMutation, useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { queryParams, toConcentrationView, toCurveView, toReportFile, toReportView, toSnapshotRef } from './model';
import type { AnalyticsQuery, ConcentrationView, CurveView, ReportCode, ReportFile, ReportView, SnapshotRef } from './model';

// What these screens show depends on the scope of the membership that is signed in, not only on the tenant: the membership is part of every key.
export function useScopeKey(): readonly ['ctr-analytics', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ctr-analytics', tenant?.id, tenant?.membershipId];
}

const malformed = (what: string): Error => new Error(`${what}: the answer is not what the contract says`);

/**
 * The portfolio (CTR-01, CTR-29): one page and the totals of everything that matches, made by the server. A body that cannot be read is a failure of the read, never an empty table. Each choice (filter, sort, page) is
 * part of the key, so a change of it reads again.
 */
export function usePortfolio(query: AnalyticsQuery, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  const params = queryParams(query);
  return useQuery<ReportView>({
    queryKey: [...key, 'portfolio', params],
    queryFn: async () => {
      const view = toReportView(await client.read('getContractPortfolio' as never, { query: params } as never));
      if (view === undefined) throw malformed('getContractPortfolio');
      return view;
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
    placeholderData: (previous) => previous,
  });
}

/** A report R1 to R7 by its code. */
export function useReport(code: Exclude<ReportCode, 'contractor-concentration'>, query: AnalyticsQuery, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  const params = queryParams(query);
  return useQuery<ReportView>({
    queryKey: [...key, 'report', code, params],
    queryFn: async () => {
      const view = toReportView(await client.read('getContractReport' as never, { path: { code }, query: params } as never));
      if (view === undefined) throw malformed('getContractReport');
      return view;
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
    placeholderData: (previous) => previous,
  });
}

/** The S-curve of the contracts a filter selects (R3): the curve is read apart from the table, so a failure of it leaves the figures in place. Live only: a frozen period holds no earned value. */
export function useScheduleCurve(query: AnalyticsQuery, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  const params = queryParams({ ...query, filter: { ...query.filter, period: '' } }, false);
  delete params.sort;
  delete params.dir;
  return useQuery<CurveView>({
    queryKey: [...key, 'report', 'schedule-delay', 's-curve', params],
    queryFn: async () => {
      const view = toCurveView(await client.read('getContractScheduleSCurve' as never, { query: params } as never));
      if (view === undefined) throw malformed('getContractScheduleSCurve');
      return view;
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
    placeholderData: (previous) => previous,
  });
}

/** The report R14, read without paging (the groups and the contractors are the whole answer). */
export function useConcentration(query: AnalyticsQuery, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  const params = queryParams(query, false);
  return useQuery<ConcentrationView>({
    queryKey: [...key, 'report', 'contractor-concentration', params],
    queryFn: async () => {
      const view = toConcentrationView(await client.read('getContractReport' as never, { path: { code: 'contractor-concentration' }, query: params } as never));
      if (view === undefined) throw malformed('getContractReport');
      return view;
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
    placeholderData: (previous) => previous,
  });
}

/** The frozen contract facts, newest first with their lineage: what the period selector reads. */
export function useFactSnapshots(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<SnapshotRef[]>({
    queryKey: [...key, 'snapshots'],
    queryFn: async () => {
      const body = (await client.read('listContractFactSnapshots' as never, {} as never)) as { items?: unknown } | undefined;
      if (body === undefined || !Array.isArray(body.items)) throw malformed('listContractFactSnapshots');
      return body.items.flatMap((item) => toSnapshotRef(item) ?? []);
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
    // The list of periods is a convenience: a failure of it leaves the selector empty and does not stop the figures.
    staleTime: 60_000,
  });
}

export type ExportFormat = 'xlsx' | 'csv' | 'pdf' | 'docx';

/** The file of a report in the format asked, as the server made it (the header of the file says the scope, the period, the cut-off day and the freshness). */
export function useExportReport(code: ReportCode) {
  const client = useApiClient();
  return useMutation<ReportFile, unknown, { format: ExportFormat; query: AnalyticsQuery }>({
    mutationFn: async ({ format, query }) => {
      const file = toReportFile(await client.read('exportContractReport' as never, { path: { code }, query: { format, ...queryParams(query, false) } } as never));
      if (file === undefined) throw malformed('exportContractReport');
      return file;
    },
  });
}


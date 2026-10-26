import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toProjectOption } from '../model';
import type { ProjectOption } from '../model';
import { createBody, queryOf, saveBody, toReportDetail, toReportPage } from './model';
import type { Basis, FilterState, FundingForm, ReportDetail, ReportPage } from './model';

const root = (tenantId: string | undefined) => ['dis', tenantId, 'reports'] as const;

/** One page of the list of reports with the figures of the filter and of the whole scope; the cursor of the page is part of the key, so a page is read once. */
export function useReportPage(filter: FilterState, cursor: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ReportPage>({
    queryKey: [...root(tenant?.id), 'page', filter, cursor ?? ''],
    queryFn: async () => {
      const query = queryOf(filter, cursor);
      const year = query.fiscal_year;
      return toReportPage(
        await client.read('get_resources_report_revision', {
          query: {
            ...query,
            ...(year === undefined ? {} : { fiscal_year: Number(year) }),
            limit: 25,
          },
        }),
      );
    },
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** One report with its project, period, plan version and cells; a report outside the scope of the caller is a 404 like one that does not exist. */
export function useReport(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ReportDetail | undefined>({
    queryKey: [...root(tenant?.id), 'one', id ?? ''],
    queryFn: async () => toReportDetail(await client.read('getReportRevision', { path: { id: id ?? '' } })),
    enabled: tenant !== undefined && id !== undefined,
    retry: false,
  });
}

/** The projects the caller can report on (the register answers only what the caller may see). */
export function useProjectOptions() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ProjectOption[]>({
    queryKey: [...root(tenant?.id), 'projects'],
    queryFn: async () => (await client.readAll('get_resources_project')).flatMap((raw) => toProjectOption(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** An annual plan the caller can filter by. */
export interface PlanOption {
  id: string;
  code: string;
  year: number | null;
  revision: number;
}

function toPlanOption(raw: unknown): PlanOption | undefined {
  const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const year = row.plan_year;
  return typeof row.id === 'string' && typeof row.plan_code === 'string' && typeof row.revision === 'number' && row.plan_kind === 'ANNUAL'
    ? { id: row.id, code: row.plan_code, year: typeof year === 'number' ? year : null, revision: row.revision }
    : undefined;
}

/** The annual plans, for the filter of the list. A caller who may not read plans gets none and the filter is not offered. */
export function usePlanOptions() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PlanOption[]>({
    queryKey: [...root(tenant?.id), 'plans'],
    queryFn: async () => {
      try {
        return (await client.readAll('get_resources_plan_version')).flatMap((raw) => toPlanOption(raw) ?? []);
      } catch {
        return [];
      }
    },
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

/** Starts the draft of a project for a period; the answer names the report. */
export function useCreateReport() {
  const client = useApiClient();
  return useCommand<{ projectId: string; periodId: string; basis: Basis }>(async (input, attempt) => {
    const done = await client.command('post_reports', { body: createBody(input), attempt });
    return done;
  });
}

export interface SaveInput {
  detail: ReportDetail;
  form: FundingForm;
}

/** Saves the entries of a draft under the version the screen showed (If-Match). */
export function useSaveReport() {
  const client = useApiClient();
  return useCommand<SaveInput>((input, attempt) =>
    client.command('post_reports_id_revisions', { path: { id: input.detail.id }, body: saveBody(input.detail, input.form), ifMatchVersion: input.detail.version, attempt }),
  );
}

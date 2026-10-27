import { uploadFile } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toProjectOption } from '../model';
import type { ProjectOption } from '../model';
import { toAttachment } from './detail-parts';
import type { Attachment } from './detail-parts';
import type { CorrectionBody, DecisionBody } from './decision-model';
import { importRequest, toImportBatch, toStoredWorkbook } from './import-model';
import type { ImportBatch, StoredWorkbook } from './import-model';
import { reasonBody } from './lifecycle-model';
import { createBody, queryOf, saveBody, toReportDetail, toReportLine, toReportPage } from './model';
import type { Basis, FilterState, FundingForm, ReportDetail, ReportDraftBody, ReportLine, ReportPage } from './model';

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
  return useCommand<{ projectId: string; periodId: string; basis: Basis; reportType?: 'WEEKLY' | 'MONTHLY' }>(async (input, attempt) => {
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

export interface DraftSave {
  detail: ReportDetail;
  body: ReportDraftBody;
}

/** Saves a step of the draft (the volumes, the registration for next month, the notes or the files) under the version the screen showed: the body keeps what the other steps entered. */
export function useSaveDraft() {
  const client = useApiClient();
  return useCommand<DraftSave>((input, attempt) => client.command('post_reports_id_revisions', { path: { id: input.detail.id }, body: input.body, ifMatchVersion: input.detail.version, attempt }));
}

/** Puts a file into the upload door of the report (judged by its bytes, scanned); the answer names the file the draft can then attach. */
export function useUploadReportFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Attachment | undefined, unknown, File>({
    mutationFn: async (file) => toAttachment(await uploadFile(client, 'uploadReportFile', { file, attempt: attempts.current.forPayload({ name: file.name, size: file.size, type: file.type, modified: file.lastModified }) })),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

export interface DecideInput {
  detail: ReportDetail;
  body: DecisionBody;
}

/** A reviewer's decision on a report that was handed in, under the version the screen showed (If-Match). */
export function useDecide() {
  const client = useApiClient();
  return useCommand<DecideInput>((input, attempt) => client.command('post_reports_id_decision', { path: { id: input.detail.id }, body: input.body, ifMatchVersion: input.detail.version, attempt }));
}

export interface CorrectInput {
  detail: ReportDetail;
  body: CorrectionBody;
}

/** A correction of a report: the answer names the new revision, a draft. */
export function useCorrect() {
  const client = useApiClient();
  return useCommand<CorrectInput>((input, attempt) => client.command('post_reports_id_corrections', { path: { id: input.detail.id }, body: input.body, ifMatchVersion: input.detail.version, attempt }));
}

/** The revisions of a project in a period, the first first: what DIS-11 offers to compare. */
export function useRevisionsOf(projectId: string | undefined, periodId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ReportLine[]>({
    queryKey: [...root(tenant?.id), 'revisions', projectId ?? '', periodId ?? ''],
    queryFn: async () => {
      const all = await client.readAll('get_resources_report_revision', { query: { project_id: projectId ?? '', period_id: periodId ?? '' } });
      return all.flatMap((raw) => toReportLine(raw) ?? []).sort((a, b) => a.revision - b.revision);
    },
    enabled: tenant !== undefined && projectId !== undefined && periodId !== undefined,
    retry: false,
  });
}

export interface RemovalInput {
  detail: ReportDetail;
  reason: string;
}

/** A maker takes back a report that was handed in and is not being reviewed (DIS-09). */
export function useWithdraw() {
  const client = useApiClient();
  return useCommand<RemovalInput>((input, attempt) => client.command('withdrawReport', { path: { id: input.detail.id }, body: reasonBody(input.reason), ifMatchVersion: input.detail.version, attempt }));
}

/** A draft is deleted softly, with the reason (DIS-09). */
export function useDeleteDraft() {
  const client = useApiClient();
  return useCommand<RemovalInput>((input, attempt) => client.command('deleteDraftReport', { path: { id: input.detail.id }, body: reasonBody(input.reason), ifMatchVersion: input.detail.version, attempt }));
}

/** A draft that was deleted is brought back within the window; the server judges the permission of the person now. */
export function useRestoreDraft() {
  const client = useApiClient();
  return useCommand<{ detail: ReportDetail }>((input, attempt) => client.command('restoreDraftReport', { path: { id: input.detail.id }, ifMatchVersion: input.detail.version, attempt }));
}

/** The drafts that were deleted and can still be restored, what DIS-01 offers apart from the reports that stand. */
export function useDeletedDrafts(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ReportLine[]>({
    queryKey: [...root(tenant?.id), 'deleted'],
    queryFn: async () => (await client.readAll('get_resources_report_revision', { query: { deleted: true } })).flatMap((raw) => toReportLine(raw) ?? []),
    enabled: tenant !== undefined && enabled,
    retry: false,
  });
}

/** Puts the workbook into the upload door (judged by its bytes, scanned); the answer names the file and how many rows and columns it has. */
export function useUploadImportFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<StoredWorkbook | undefined, unknown, File>({
    mutationFn: async (file) => toStoredWorkbook(await uploadFile(client, 'uploadReportImportFile', { file, attempt: attempts.current.forPayload({ name: file.name, size: file.size, type: file.type, modified: file.lastModified }) }), file.name),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

/** The dry run of a workbook for a period: every row is judged and its faults kept; the answer names the batch. */
export function useCreateImport() {
  const client = useApiClient();
  return useCommand<{ periodId: string; file: StoredWorkbook }>((input, attempt) => client.command('createReportImport', { body: importRequest(input.periodId, input.file), attempt }));
}

/** Applies a batch that has no fault, under the version the screen showed: the drafts are made, none is handed in. */
export function useApplyImport() {
  const client = useApiClient();
  return useCommand<{ batch: ImportBatch }>((input, attempt) => client.command('applyReportImport', { path: { id: input.batch.id }, ifMatchVersion: input.batch.version, attempt }));
}

/** A batch of the bulk import with what was found in every row of its file. */
export function useImportBatch(id: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ImportBatch | undefined>({
    queryKey: [...root(tenant?.id), 'import', id],
    queryFn: async () => toImportBatch(await client.read('getReportImport', { path: { id } })),
    enabled: tenant !== undefined,
    retry: false,
  });
}

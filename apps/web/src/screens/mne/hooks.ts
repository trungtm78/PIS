import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { ApiError } from '@machvon/api-client';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { revisionBody, ruleBody } from './model';
import type { RevisionValues, RuleValues } from './model';
import { toForm, toGeneration, toObligationPage, toReport, toReportResult, toRule } from './types';
import type { ExportTarget, FormView, GenerationResult, ObligationPage, PackageFormat, ReportCommandResult, ReportKind, ReportStatus, ReportView, RuleView } from './types';

export const PAGE_SIZE = 100;
const LIVE_INTERVAL_MS = 5000;
const LINK_REFRESH_MS = 4 * 60_000;

/** Every read and every mutation of the MNE screens lives under this key of the tenant, so one command refreshes them all. */
export const mneRoot = (tenantId: string | undefined) => ['mne', tenantId] as const;

export interface FormFilter {
  reportKind: ReportKind | '';
  /** A date written year-month-day, or empty for every revision whatever its period. */
  effectiveOn: string;
}

/** The revisions of the catalogue for the filter (the whole catalogue: it holds a few dozen forms). */
export function useForms(filter: FormFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<FormView[]>({
    queryKey: [...mneRoot(tenant?.id), 'forms', filter.reportKind, filter.effectiveOn],
    queryFn: async () =>
      (
        await client.readAll('listMneForms', {
          query: { ...(filter.reportKind === '' ? {} : { report_kind: filter.reportKind }), ...(filter.effectiveOn === '' ? {} : { effective_on: filter.effectiveOn }) },
        })
      ).flatMap((raw) => toForm(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** Every revision of the obligation rules of the tenant, newest first (the list holds a few dozen rules). */
export function useRules() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<RuleView[]>({
    queryKey: [...mneRoot(tenant?.id), 'rules'],
    queryFn: async () => (await client.readAll('listMneObligationRules')).flatMap((raw) => toRule(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

export interface ObligationFilter {
  year: number;
  status: ReportStatus | '';
}

/** The obligations of a year, page by page, in the scope of the caller (the server narrows by unit). */
export function useObligations(filter: ObligationFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<ObligationPage, Error, { pages: ObligationPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...mneRoot(tenant?.id), 'obligations', filter.year, filter.status],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toObligationPage(
        await client.read('listMneObligations', {
          query: {
            report_year: String(filter.year),
            limit: PAGE_SIZE,
            ...(filter.status === '' ? {} : { status: filter.status }),
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** One idempotency attempt per intention: a retry of the same request reuses it, a different request starts a new one. */
function useCommandSupport() {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  const settled = async (): Promise<void> => {
    attempts.current.done();
    await queryClient.invalidateQueries({ queryKey: mneRoot(tenant?.id) });
  };
  // A conflict means the screen holds a version that has moved (a file was downloaded, someone else wrote): the read is made again so that the next attempt carries the version that stands.
  const failed = (error: unknown): void => {
    attempts.current.ended(error);
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') void queryClient.invalidateQueries({ queryKey: mneRoot(tenant?.id) });
  };
  return { attempts, settled, failed };
}

export interface PublishInput {
  formId: string;
  version: number;
}

/** Publishes a draft revision (versioned: 409 for a stale version, 403 SELF_APPROVAL_DENIED for its maker). */
export function usePublishForm() {
  const client = useApiClient();
  const { attempts, settled, failed } = useCommandSupport();
  return useMutation({
    mutationFn: (input: PublishInput) => client.command('publishMneForm', { path: { id: input.formId }, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: settled,
    onError: failed,
  });
}

/**
 * The body of createMneFormVersion in the type the generated contract gives it. openapi.json declares `schema_json` as a bare `object`,
 * which the generator renders as a record of `never`: the structure of a form is free JSON, so it is the one field that needs the cast.
 */
function contractBody(values: RevisionValues) {
  const body = revisionBody(values);
  return { ...body, schema_json: body.schema_json as Record<string, never> };
}

/** Drafts the next revision of a form code. */
export function useCreateForm() {
  const client = useApiClient();
  const { attempts, settled, failed } = useCommandSupport();
  return useMutation({
    mutationFn: (values: RevisionValues) => client.command('createMneFormVersion', { body: contractBody(values), attempt: attempts.current.forPayload(values) }),
    onSuccess: settled,
    onError: failed,
  });
}

/**
 * The body of createMneObligationRule in the type the generated contract gives it: `due_rule_json` is a bare `object` in openapi.json,
 * rendered as a record of `never`, and the formula is free JSON, so it is the one field that needs the cast.
 */
function contractRuleBody(values: RuleValues) {
  const body = ruleBody(values);
  return { ...body, due_rule_json: body.due_rule_json as Record<string, never> };
}

/** Drafts the next revision of an obligation rule. */
export function useCreateRule() {
  const client = useApiClient();
  const { attempts, settled, failed } = useCommandSupport();
  return useMutation({
    mutationFn: (values: RuleValues) => client.command('createMneObligationRule', { body: contractRuleBody(values), attempt: attempts.current.forPayload(values) }),
    onSuccess: settled,
    onError: failed,
  });
}

/** Publishes a draft rule revision (versioned: 409 for a stale version, 403 SELF_APPROVAL_DENIED for its maker). */
export function usePublishRule() {
  const client = useApiClient();
  const { attempts, settled, failed } = useCommandSupport();
  return useMutation({
    mutationFn: (input: { ruleId: string; version: number }) =>
      client.command('publishMneObligationRule', { path: { id: input.ruleId }, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: settled,
    onError: failed,
  });
}

/** Generates the obligations of a year; running it again adds nothing. */
export function useGenerateObligations() {
  const client = useApiClient();
  const { attempts, settled, failed } = useCommandSupport();
  return useMutation<GenerationResult, Error, number>({
    mutationFn: async (year) => toGeneration(await client.command('generateMneObligations', { body: { report_year: year }, attempt: attempts.current.forPayload({ year }) })),
    onSuccess: settled,
    onError: failed,
  });
}

/** One report, in the units of the caller: what is shown depends on who asks, so the cache is of the member as well as the tenant. */
export function useReport(id: string, options: { live?: boolean; links?: boolean } = {}) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ReportView>({
    queryKey: [...mneRoot(tenant?.id), 'report', tenant?.membershipId, id],
    queryFn: async () => {
      const report = toReport(await client.read('getMneReport', { path: { id } }));
      if (report === undefined) throw new Error('the report could not be read');
      return report;
    },
    enabled: tenant !== undefined && id !== '',
    retry: false,
    // While DOC has the report the screen follows it: the state of the document moves without anyone asking.
    refetchInterval: (query) => {
      if (options.live === true && query.state.data?.status === 'ISSUING') return LIVE_INTERVAL_MS;
      // The links of the files are good for five minutes: while there are any, the report is read again before they run out.
      return options.links === true && query.state.data?.packages.some((item) => item.downloadUrl !== null) === true ? LINK_REFRESH_MS : false;
    },
  });
}

export interface EditReportInput {
  id: string;
  version: number;
  /** The cells that changed; an emptied cell is null. */
  narrative: Record<string, string | null>;
  /** The frozen snapshot to attach (or to replace the one attached): the locked cells are filled again from it. */
  snapshotId?: string | undefined;
}

/** Writes the text cells of a draft and, when one is named, attaches a snapshot (versioned: 409 VERSION_CONFLICT when the report moved). */
export function useEditReport() {
  const client = useApiClient();
  const { attempts, settled, failed } = useCommandSupport();
  return useMutation<ReportCommandResult, Error, EditReportInput>({
    mutationFn: async (input) =>
      toReportResult(
        await client.command('editMneReport', {
          path: { id: input.id },
          ifMatchVersion: input.version,
          // `narrative` is a bare `object` in openapi.json, which the generator renders as a record of `never`: free JSON is the one field that needs the cast.
          body: { narrative: input.narrative as Record<string, never>, ...(input.snapshotId === undefined ? {} : { snapshot_id: input.snapshotId }) },
          attempt: attempts.current.forPayload(input),
        }),
      ),
    onSuccess: settled,
    onError: failed,
  });
}

/** Hands a draft in for review (versioned). */
export function useSubmitReport() {
  const client = useApiClient();
  const { attempts, settled, failed } = useCommandSupport();
  return useMutation<ReportCommandResult, Error, { id: string; version: number }>({
    mutationFn: async (input) => toReportResult(await client.command('submitMneReport', { path: { id: input.id }, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) })),
    onSuccess: settled,
    onError: failed,
  });
}

export interface DecideReportInput {
  id: string;
  version: number;
  decision: 'approve' | 'return';
  reason: string;
}

/** Approves a report in review or returns it to its preparer, with the reason (versioned: 403 SELF_APPROVAL_DENIED for who wrote or handed it in). */
export function useDecideReport() {
  const client = useApiClient();
  const { attempts, settled, failed } = useCommandSupport();
  return useMutation<ReportCommandResult, Error, DecideReportInput>({
    mutationFn: async (input) =>
      toReportResult(await client.command('decideMneReport', { path: { id: input.id }, ifMatchVersion: input.version, body: { decision: input.decision, reason: input.reason }, attempt: attempts.current.forPayload(input) })),
    onSuccess: settled,
    onError: failed,
  });
}

/** Asks DOC to issue an approved report (versioned): the report is ISSUING until DOC says it issued it. */
export function useRequestIssue() {
  const client = useApiClient();
  const { attempts, settled, failed } = useCommandSupport();
  return useMutation<ReportCommandResult, Error, { id: string; version: number }>({
    mutationFn: async (input) => toReportResult(await client.command('requestMneReportIssue', { path: { id: input.id }, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) })),
    onSuccess: settled,
    onError: failed,
  });
}

export interface GenerateExportInput {
  reportId: string;
  version: number;
  target: ExportTarget;
  formats: readonly PackageFormat[];
}

/** Makes the files of an issued report for a target (versioned on the report): the same content asked for again is the same package. */
export function useGenerateExport() {
  const client = useApiClient();
  const { attempts, settled, failed } = useCommandSupport();
  return useMutation<ReportCommandResult, Error, GenerateExportInput>({
    mutationFn: async (input) =>
      toReportResult(await client.command('generateMneExportPackage', { path: { id: input.reportId }, ifMatchVersion: input.version, body: { target_system: input.target, formats: [...input.formats] }, attempt: attempts.current.forPayload(input) })),
    onSuccess: settled,
    onError: failed,
  });
}

export interface RecordReceiptInput {
  packageId: string;
  version: number;
  reference: string;
  /** The moment the person filed, as an ISO instant. */
  submittedAt: string;
}

/** Writes down the receipt of a filing made by hand (versioned on the package): the report is then filed. */
export function useRecordReceipt() {
  const client = useApiClient();
  const { attempts, settled, failed } = useCommandSupport();
  return useMutation<ReportCommandResult, Error, RecordReceiptInput>({
    mutationFn: async (input) =>
      toReportResult(await client.command('recordMneSubmissionReceipt', { path: { id: input.packageId }, ifMatchVersion: input.version, body: { receipt_reference: input.reference, submitted_at: input.submittedAt }, attempt: attempts.current.forPayload(input) })),
    onSuccess: settled,
    onError: failed,
  });
}

export interface CreateReportInput {
  body: Record<string, string | number>;
}

/** Makes a report by hand from a form, a period and a frozen snapshot (the cells that have a source are filled from the snapshot); the answer names the report made. */
export function useCreateReport() {
  const client = useApiClient();
  const { attempts, settled, failed } = useCommandSupport();
  return useMutation<unknown, Error, CreateReportInput>({
    mutationFn: (input) => client.command('createMneReport', { body: input.body as never, attempt: attempts.current.forPayload(input) }),
    onSuccess: settled,
    onError: failed,
  });
}

export interface CorrectReportInput {
  id: string;
  version: number;
  body: Record<string, string>;
}

/** Corrects an issued report: a new revision with the reason (versioned); the revision it replaces is kept as it was issued. */
export function useCorrectReport() {
  const client = useApiClient();
  const { attempts, settled, failed } = useCommandSupport();
  return useMutation<unknown, Error, CorrectReportInput>({
    mutationFn: (input) => client.command('correctMneReport', { path: { id: input.id }, ifMatchVersion: input.version, body: input.body as never, attempt: attempts.current.forPayload(input) }),
    onSuccess: settled,
    onError: failed,
  });
}

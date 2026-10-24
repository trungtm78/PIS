import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { revisionBody } from './model';
import type { RevisionValues } from './model';
import { toForm, toGeneration, toObligationPage } from './types';
import type { FormView, GenerationResult, ObligationPage, ReportKind, ReportStatus } from './types';

export const PAGE_SIZE = 100;

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
  return { attempts, settled };
}

export interface PublishInput {
  formId: string;
  version: number;
}

/** Publishes a draft revision (versioned: 409 for a stale version, 403 SELF_APPROVAL_DENIED for its maker). */
export function usePublishForm() {
  const client = useApiClient();
  const { attempts, settled } = useCommandSupport();
  return useMutation({
    mutationFn: (input: PublishInput) => client.command('publishMneForm', { path: { id: input.formId }, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: settled,
    onError: (error) => attempts.current.ended(error),
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
  const { attempts, settled } = useCommandSupport();
  return useMutation({
    mutationFn: (values: RevisionValues) => client.command('createMneFormVersion', { body: contractBody(values), attempt: attempts.current.forPayload(values) }),
    onSuccess: settled,
    onError: (error) => attempts.current.ended(error),
  });
}

/** Generates the obligations of a year; running it again adds nothing. */
export function useGenerateObligations() {
  const client = useApiClient();
  const { attempts, settled } = useCommandSupport();
  return useMutation<GenerationResult, Error, number>({
    mutationFn: async (year) => toGeneration(await client.command('generateMneObligations', { body: { report_year: year }, attempt: attempts.current.forPayload({ year }) })),
    onSuccess: settled,
    onError: (error) => attempts.current.ended(error),
  });
}

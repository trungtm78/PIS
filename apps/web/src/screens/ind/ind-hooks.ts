import { uploadFile } from '@machvon/api-client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { HISTORY_PAGE_SIZE, toApplied, toDictionary, toEntryResult, toFigureList, toIndicatorDetail, toMappingDetail, toMappingList, toPreview, toRuleList, toRunPage, toRunRows, toUploadedFile, toVerdict } from './ind-model';
import type { Applied, Dictionary, DictionaryFilter, EntryLine, EntryResult, FigureList, IndicatorDetail, MappingDetail, MappingList, PeriodStatus, Preview, RuleList, RunPage, RunRows, Surface, UploadedFile, Verdict } from './ind-model';

// What the screens show depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['ind', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ind', tenant?.id, tenant?.membershipId];
}

const q = (value: Record<string, string | number | undefined>): never => value as never;

/** The dictionary in force, narrowed by the filter (the server filters; the findings are always about the whole dictionary). */
export function useDictionary(filter: DictionaryFilter) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Dictionary | undefined>({
    queryKey: [...key, 'dictionary', filter.category, filter.valueKind, filter.enterableOnly, filter.q.trim()],
    queryFn: async () =>
      toDictionary(
        await client.read('listIndicators', {
          query: q({ category: filter.category === '' ? undefined : filter.category, value_kind: filter.valueKind === '' ? undefined : filter.valueKind, enterable: filter.enterableOnly ? 'true' : undefined, q: filter.q.trim() === '' ? undefined : filter.q.trim() }),
        }),
      ),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One indicator with its versions, who made and approved each, and where it is used. */
export function useIndicatorDetail(code: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<IndicatorDetail | undefined>({
    queryKey: [...key, 'indicator', code],
    queryFn: async () => toIndicatorDetail(await client.read('getIndicator', { query: q({ code }) })),
    enabled: key[1] !== undefined && code !== undefined,
    retry: false,
  });
}

/** The figures in force of a project in a period, read when the person has named both. */
export function useFigures(projectId: string | undefined, periodId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<FigureList | undefined>({
    queryKey: [...key, 'figures', projectId, periodId],
    queryFn: async () => toFigureList(await client.read('listIndicatorFigures', { query: q({ project_id: projectId, period_id: periodId }) })),
    enabled: key[1] !== undefined && projectId !== undefined && periodId !== undefined,
    retry: false,
  });
}

/** Every revision of one figure, newest first. */
export function useFigureHistory(target: { projectId: string; periodId: string; indicatorCode: string } | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<FigureList | undefined>({
    queryKey: [...key, 'figure-history', target?.projectId, target?.periodId, target?.indicatorCode],
    queryFn: async () => toFigureList(await client.read('listIndicatorFigureHistory', { query: q({ project_id: target?.projectId, period_id: target?.periodId, indicator_code: target?.indicatorCode }) })),
    enabled: key[1] !== undefined && target !== undefined,
    retry: false,
  });
}

export interface EntryInput {
  projectId: string;
  periodId: string;
  lines: EntryLine[];
}

/** Enters the figures; a success refreshes the figures of the project (the entry rules judged them on the server). */
export function useEnterFigures() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<EntryResult | undefined, unknown, EntryInput>({
    mutationFn: async (input) =>
      toEntryResult(
        await client.command('enterIndicatorFigures', {
          body: { project_id: input.projectId, period_id: input.periodId, figures: input.lines.map((line) => ({ indicator_code: line.indicatorCode, value: line.value.trim(), ...(line.reason.trim() === '' ? {} : { reason: line.reason.trim() }) })) },
          attempt: attempts.current.forPayload(input),
        }),
      ),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: [...key, 'figures'] });
      await queryClient.invalidateQueries({ queryKey: [...key, 'figure-history'] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The entry rules of the tenant: approved ones in force and the starting templates, which hold no entry. */
export function useRules() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<RuleList | undefined>({
    queryKey: [...key, 'rules'],
    queryFn: async () => toRuleList(await client.read('listIndicatorEntryRules')),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export interface EvaluateInput {
  surface: Surface;
  values: Record<string, string>;
  periodStatus: PeriodStatus | '';
  includeTemplates: boolean;
}

/** Holds a set of numbers up to the rules of a surface; nothing is written. */
export function useEvaluate() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Verdict | undefined, unknown, EvaluateInput>({
    mutationFn: async (input) =>
      toVerdict(
        await client.command('evaluateIndicatorEntry', {
          body: { surface: input.surface, values: input.values, ...(input.periodStatus === '' ? {} : { period_status: input.periodStatus }), include_templates: input.includeTemplates },
          attempt: attempts.current.forPayload(input),
        }),
      ),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

export function useMappings() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<MappingList | undefined>({
    queryKey: [...key, 'mappings'],
    queryFn: async () => toMappingList(await client.read('listIndicatorImportMappings')),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export function useMappingDetail(code: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<MappingDetail | undefined>({
    queryKey: [...key, 'mapping', code],
    queryFn: async () => toMappingDetail(await client.read('getIndicatorImportMapping', { query: q({ code }) })),
    enabled: key[1] !== undefined && code !== undefined,
    retry: false,
  });
}

/** Puts the file into the shared upload pipeline (judged by its bytes, scanned): the answer names its key, hash, columns and the approved mappings that read it. */
export function useUploadFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<UploadedFile | undefined, unknown, File>({
    mutationFn: async (file) => toUploadedFile(await uploadFile(client, 'uploadIndicatorFile', { file, attempt: attempts.current.forPayload({ name: file.name, size: file.size, type: file.type, modified: file.lastModified }) })),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ImportInput {
  mappingCode: string;
  fileObjectKey: string;
  fileSha256: string;
  projectCode: string;
  periodCode: string;
}

const bodyOf = (input: ImportInput) => ({
  mapping_code: input.mappingCode,
  file_object_key: input.fileObjectKey,
  file_sha256: input.fileSha256,
  ...(input.projectCode.trim() === '' ? {} : { project_code: input.projectCode.trim() }),
  ...(input.periodCode.trim() === '' ? {} : { period_code: input.periodCode.trim() }),
});

/** The dry run: reads the stored file through the mapping exactly as the apply will and writes nothing. */
export function usePreviewImport() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Preview | undefined, unknown, ImportInput>({
    mutationFn: async (input) => toPreview(await client.command('previewIndicatorImport', { body: bodyOf(input), attempt: attempts.current.forPayload(input) }), new Date().toISOString()),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

/** The apply: once per file; a success refreshes the history and the figures. */
export function useApplyImport() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Applied | undefined, unknown, ImportInput>({
    mutationFn: async (input) => toApplied(await client.command('importIndicatorFile', { body: bodyOf(input), attempt: attempts.current.forPayload(input) })),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The past imports, newest first, a page at a time (the cursor of the server). */
export function useImportHistory() {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<RunPage, unknown, { pages: RunPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'runs'],
    queryFn: async ({ pageParam }) => {
      const page = toRunPage(await client.read('listIndicatorImports', { query: q({ ...(pageParam === undefined ? {} : { cursor: pageParam }), limit: HISTORY_PAGE_SIZE }) }));
      if (page === undefined) throw new Error('listIndicatorImports answered with something that is not a page');
      return page;
    },
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The rows one import refused and the differences it left. */
export function useRunRows(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<RunRows | undefined>({
    queryKey: [...key, 'run-rows', id],
    queryFn: async () => toRunRows(await client.read('listIndicatorImportRows', { query: q({ import_id: id }) })),
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

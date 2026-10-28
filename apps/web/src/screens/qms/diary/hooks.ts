import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { filterQuery, toDiaryLine, toDiaryPage } from './model';
import type { CorrectBody, DiaryFilter, DiaryLine, DiaryPage, SaveBody, SignBody } from './model';

export const DIARY_PAGE = 50;

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['qms-diaries', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['qms-diaries', tenant?.id, tenant?.membershipId];
}

/** The diaries in the scope of the caller, the latest day first, a page at a time; a new filter keeps the list on the screen until the new one is there. */
export function useDiaries(filter: DiaryFilter) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<DiaryPage, Error, { pages: DiaryPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'list', filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toDiaryPage(await client.read('get_resources_site_diary', { query: { limit: DIARY_PAGE, ...filterQuery(filter), ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.next,
    placeholderData: keepPreviousData,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One diary; nothing is read until one is named. */
export function useDiary(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<DiaryLine | null>({
    queryKey: [...key, 'one', id],
    queryFn: async () => toDiaryLine(await client.read('get_resources_site_diary_id', { path: { id: id as string } })) ?? null,
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the reads of the diaries refreshed once it succeeds. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith('qms-') });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useSaveDiary() {
  const client = useApiClient();
  return useCommand<SaveBody>((body, attempt) => client.command('saveSiteDiaryDraft', { body, attempt }));
}

export interface VersionedInput<Body> {
  id: string;
  version: number;
  body: Body;
}

export function useReviseDiary() {
  const client = useApiClient();
  return useCommand<VersionedInput<{ content: Record<string, unknown>; client_operation_id: string }>>((input, attempt) => client.command('reviseSiteDiaryDraft', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useContractorSign() {
  const client = useApiClient();
  return useCommand<VersionedInput<SignBody>>((input, attempt) => client.command('signSiteDiaryByContractor', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useSupervise() {
  const client = useApiClient();
  return useCommand<VersionedInput<SignBody & { remark: string }>>((input, attempt) => client.command('addSupervisorRemark', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useOwnerConfirm() {
  const client = useApiClient();
  return useCommand<VersionedInput<SignBody & { note?: string }>>((input, attempt) => client.command('confirmSiteDiaryByOwner', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useLockDiary() {
  const client = useApiClient();
  return useCommand<VersionedInput<{ reason?: string }>>((input, attempt) => client.command('lockSiteDiary', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useCorrectDiary() {
  const client = useApiClient();
  return useCommand<{ id: string; body: CorrectBody }>((input, attempt) => client.command('correctSiteDiary', { path: { id: input.id }, body: input.body, attempt }));
}

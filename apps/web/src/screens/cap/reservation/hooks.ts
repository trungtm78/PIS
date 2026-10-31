import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toReservationPage } from './model';
import type { ReservationPage, Status } from './model';

const PAGE_SIZE = 25;

function useScopeKey(): readonly ['cap-reservations', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['cap-reservations', tenant?.id, tenant?.membershipId];
}

/** The reservations of the projects the caller sees capital of, newest first, a page at a time; the membership is part of the key because what is seen depends on it. */
export function useReservations(status: Status | '') {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<ReservationPage, Error, { pages: ReservationPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'list', status],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toReservationPage(await client.read('listFundReservations', { query: { limit: PAGE_SIZE, ...(status === '' ? {} : { status }), ...(pageParam === undefined ? {} : { cursor: pageParam }) } as never })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: ['cap-reservations'] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useCreateReservation() {
  const client = useApiClient();
  return useCommand<Record<string, unknown>>((body, attempt) => client.command('createFundReservation', { body: body as never, attempt }));
}

export interface ReleaseInput {
  id: string;
  version: number;
  reason: string;
}

export function useReleaseReservation() {
  const client = useApiClient();
  return useCommand<ReleaseInput>((input, attempt) => client.command('releaseFundReservation', { path: { id: input.id }, body: { reason: input.reason.trim() }, ifMatchVersion: input.version, attempt }));
}

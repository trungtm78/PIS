import { ApiError } from '@machvon/api-client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toItem, toItemAnswer, toItemPage, toMember, toSettlement, toTracking, toTransaction } from './model';
import type { ItemAnswer, ItemPage, MemberOption, ReconItem, Resolution, Settlement, TrackingRow, Transaction } from './model';

export interface ItemFilter {
  status?: string | null;
  ownerId?: string | null;
}

/** The items of difference the caller may see, the ones due first, with what the board counts; a page of the server is enough for a board. */
export function useItems(filter: ItemFilter, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  const query: Record<string, string> = { limit: '200' };
  if (filter.status) query.status = filter.status;
  if (filter.ownerId) query.owner_membership_id = filter.ownerId;
  return useQuery<ItemPage>({
    queryKey: [...key, 'recon-items', filter.status ?? '', filter.ownerId ?? ''],
    queryFn: async () => toItemPage(await client.read('listReconciliationItems', { query })),
    // The table of the previous filter stays on screen while the next one loads, so the filter that was used is not replaced by a skeleton.
    placeholderData: keepPreviousData,
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One item; null when it is not there for the caller (another tenant, or outside the scope: a 404). */
export function useItem(id: string | null | undefined, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ReconItem | null>({
    queryKey: [...key, 'recon-item', id ?? ''],
    queryFn: async () => {
      try {
        return toItem(await client.read('getReconciliationItem', { path: { id: id ?? '' } })) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: enabled && key[1] !== undefined && typeof id === 'string',
    retry: false,
  });
}

/** The Treasury transactions the caller may see (the read model of PAY), the latest first. */
export function useTransactions(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Transaction[]>({
    queryKey: [...key, 'recon-transactions'],
    queryFn: async () => (await client.readAll('get_resources_treasury_transaction')).flatMap((raw) => toTransaction(raw) ?? []),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** Where the projects stand with the Treasury (PAY-09). */
export function useTracking(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<TrackingRow[]>({
    queryKey: [...key, 'recon-tracking'],
    queryFn: async () => (await client.readAll('getTreasuryTracking')).flatMap((raw) => toTracking(raw) ?? []),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The active staff that can be given a difference; `enabled: false` when the caller may not list members. */
export function useMembers(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<MemberOption[]>({
    queryKey: [...key, 'recon-members'],
    queryFn: async () => (await client.readAll('get_resources_membership')).flatMap((raw) => toMember(raw) ?? []),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the cached reads of PAY refreshed on success, and the answer of the server given back. */
function useCommand<Input, Answer>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>, read: (value: unknown) => Answer | undefined) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Answer | undefined, Error, Input>({
    mutationFn: async (input) => read(await send(input, attempts.current.forPayload(input))),
    // A refusal that is itself a record (the amounts did not agree and a difference was opened) changes what the board shows, so it too reads again.
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      if (error instanceof ApiError && error.code === 'AMOUNT_MISMATCH_OPENED') await queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export interface MatchInput {
  transactionId: string;
  body: { payment_request_id: string; note?: string };
}

/** Matches a transaction to a payment request: equal amounts settle it; unequal amounts are refused with the difference that was opened. */
export function useMatch() {
  const client = useApiClient();
  return useCommand<MatchInput, Settlement>((input, attempt) => client.command('matchTreasuryTransaction', { path: { id: input.transactionId }, body: input.body, attempt }), toSettlement);
}

export interface AssignInput {
  id: string;
  version: number;
  body: { owner_membership_id: string; due_at: string };
}

export function useAssign() {
  const client = useApiClient();
  return useCommand<AssignInput, ItemAnswer>((input, attempt) => client.command('assignReconciliationItem', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }), toItemAnswer);
}

export interface ResolveInput {
  id: string;
  version: number;
  body: { resolution: Resolution; note: string; approval_document_version_id?: string };
}

export function useResolve() {
  const client = useApiClient();
  return useCommand<ResolveInput, ItemAnswer>((input, attempt) => client.command('resolveReconciliationItem', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }), toItemAnswer);
}

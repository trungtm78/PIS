import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { CONSENT_TEXT_VERSION, READ_PAGE_SIZE, toConsent } from './model';
import type { ConsentChannel, ConsentItem, ConsentPurpose } from './model';

export const consentsKey = (tenantId: string | undefined) => ['not', 'consents', tenantId] as const;

export interface ConsentPage {
  items: ConsentItem[];
  /** The cursor of the next page; undefined on the last page. */
  next: string | undefined;
}

export const consentsOf = (data: InfiniteData<ConsentPage> | undefined): ConsentItem[] | undefined => data?.pages.flatMap((page) => page.items);

/** The consent history of the member, newest first, one keyset page at a time; keyed by tenant so a switch never shows another tenant's history. */
export function useConsentPages() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<ConsentPage, Error, InfiniteData<ConsentPage>, ReturnType<typeof consentsKey>, string | undefined>({
    queryKey: consentsKey(tenant?.id),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => {
      const page = (await client.read('listMyConsents', { query: { limit: READ_PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } })) as {
        items?: unknown[];
        next_cursor?: string | null;
      };
      return { items: (page.items ?? []).flatMap((item) => toConsent(item) ?? []), next: page.next_cursor ?? undefined };
    },
    getNextPageParam: (last) => last.next,
    enabled: tenant !== undefined,
    retry: false,
  });
}

export interface GrantInput {
  channel: ConsentChannel;
  purpose: ConsentPurpose;
}

/** Gives a consent against the current text; one idempotency attempt per intention, so a second click or a retry is one consent. */
export function useGrantConsent() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: GrantInput) =>
      client.command('grantMyConsent', {
        body: { channel: input.channel, purpose: input.purpose, consent_text_version: CONSENT_TEXT_VERSION, capture_method: 'IN_APP' },
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: consentsKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface WithdrawInput {
  id: string;
  version: number;
  reason: string;
}

/** Withdraws a consent under the version the person saw; it takes effect at once for every message that has not gone out. */
export function useWithdrawConsent() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: WithdrawInput) =>
      client.command('withdrawMyConsent', {
        path: { consentId: input.id },
        body: { reason: input.reason },
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: consentsKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

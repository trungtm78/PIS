import { ApiError } from '@machvon/api-client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toSettlementForm } from './forms-model';
import type { SettlementForm } from './forms-model';
import { toAnswer, toSettlement } from './model';
import type { Answer, Outcome, Scope, Settlement } from './model';

/** The settlements the caller may see, the newest first; a page of the server is enough for a workspace. */
export function useSettlements(status: string | null, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  const query: Record<string, string> = { limit: '200' };
  if (status) query.status = status;
  return useQuery<Settlement[]>({
    queryKey: [...key, 'settlements', status ?? ''],
    queryFn: async () => {
      const page = await client.read('get_resources_settlement_revision', { query });
      const items = (page as { items?: unknown }).items;
      return Array.isArray(items) ? items.flatMap((raw) => toSettlement(raw) ?? []) : [];
    },
    // The table of the previous filter stays on screen while the next one loads, so the filter that was used is not replaced by a skeleton.
    placeholderData: keepPreviousData,
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** Every settlement the caller may see, page after page: the calendar and the choice of PAY-16 must not stop at the first page. */
export function useAllSettlements(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Settlement[]>({
    queryKey: [...key, 'settlements-all'],
    queryFn: async () => (await client.readAll('get_resources_settlement_revision', { query: { limit: 200 } })).flatMap((raw) => toSettlement(raw) ?? []),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One settlement; null when it is not there for the caller (another tenant, or outside the scope: a 404). */
export function useSettlement(id: string | null | undefined, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Settlement | null>({
    queryKey: [...key, 'settlement', id ?? ''],
    queryFn: async () => {
      try {
        return toSettlement(await client.read('get_resources_settlement_revision_id', { path: { id: id ?? '' } })) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: enabled && key[1] !== undefined && typeof id === 'string',
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, every cached read of PAY read again on success, and the answer of the server given back. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Answer | undefined, Error, Input>({
    mutationFn: async (input) => toAnswer(await send(input, attempts.current.forPayload(input))),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface VersionedInput<Body> {
  id: string;
  version: number;
  body: Body;
}

export interface OpenInput {
  body: { project_id: string; settlement_scope: Scope; contract_id?: string; fiscal_year?: number };
}

export function useOpenSettlement() {
  const client = useApiClient();
  return useCommand<OpenInput>((input, attempt) => client.command('openSettlement', { body: input.body, attempt }));
}

export function useRefreshSettlement() {
  const client = useApiClient();
  return useCommand<VersionedInput<{ note?: string }>>((input, attempt) =>
    client.command('refreshSettlementFigures', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

export function useSubmitSettlement() {
  const client = useApiClient();
  return useCommand<VersionedInput<{ submitted_on: string }>>((input, attempt) =>
    client.command('submitSettlement', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

export function useVerifySettlement() {
  const client = useApiClient();
  return useCommand<VersionedInput<{ outcome: Outcome; findings: string; audit_finding_refs?: string[] }>>((input, attempt) =>
    client.command('recordSettlementVerification', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

export function useApproveException() {
  const client = useApiClient();
  return useCommand<VersionedInput<{ reason: string; approval_document_version_id: string }>>((input, attempt) =>
    client.command('approveSettlementException', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

export function useCloseSettlement() {
  const client = useApiClient();
  return useCommand<VersionedInput<{ decision: 'approve'; reason: string; evidence_ids: string[]; decision_document_version_id: string }>>((input, attempt) =>
    client.command('post_settlements_id_close', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

/** The forms of one settlement, the ones that stand first and then the ones they replaced; null when the settlement is not there for the caller (a 404). */
export function useSettlementForms(id: string | null | undefined, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<SettlementForm[] | null>({
    queryKey: [...key, 'settlement-forms', id ?? ''],
    queryFn: async () => {
      try {
        const page = await client.read('listSettlementForms', { path: { id: id ?? '' } });
        const items = (page as { items?: unknown }).items;
        return Array.isArray(items) ? items.flatMap((raw) => toSettlementForm(raw) ?? []) : [];
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: enabled && key[1] !== undefined && typeof id === 'string',
    retry: false,
  });
}

export interface GenerateInput {
  id: string;
  body: { form_codes: string[]; place: string };
}

/** Drawing the forms: one idempotency attempt per intention, every cached read of PAY read again on success. */
export function useGenerateSettlementForms() {
  const client = useApiClient();
  return useCommand<GenerateInput>((input, attempt) => client.command('generateSettlementForms', { path: { id: input.id }, body: input.body as never, attempt }));
}

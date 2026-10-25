import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { useTenantList } from '../tenants/hooks';
import { toPreview, toTenantSubscription } from './model';
import type { Effective, PreviewResult, TenantSubscription } from './model';

export const subscriptionKey = (sessionTenantId: string | undefined, tenantId: string | undefined) => ['sas', 'subscription', sessionTenantId, tenantId ?? 'none'] as const;

export interface TenantChoice {
  /** The tenant the screen reads: the one in the address, else the first of the registry. */
  chosen: string | undefined;
  options: Array<{ id: string; code: string; name: string }>;
  isLoading: boolean;
  error: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  refetch: () => void;
  choose: (tenantId: string) => void;
}

/** The tenant these screens work on (they are control-plane screens, like SAS-25): named in the address (`?tenant=`) or the first one of the registry. */
export function useTenantChoice(): TenantChoice {
  const [params, setParams] = useSearchParams();
  const tenants = useTenantList(true);
  const loaded = tenants.data?.pages.flatMap((page) => page.items) ?? [];
  const chosen = params.get('tenant') ?? loaded[0]?.id;
  // A tenant named in the address may lie beyond the pages loaded so far: it still has an option, so the select shows what is read.
  const options = chosen !== undefined && !loaded.some((tenant) => tenant.id === chosen) ? [...loaded, { id: chosen, name: chosen, code: '' }] : loaded;
  return {
    chosen,
    options,
    isLoading: tenants.isLoading,
    error: tenants.error,
    hasNextPage: tenants.hasNextPage === true,
    isFetchingNextPage: tenants.isFetchingNextPage,
    fetchNextPage: () => void tenants.fetchNextPage(),
    refetch: () => void tenants.refetch(),
    choose: (tenantId) => setParams((current) => ({ ...Object.fromEntries(current), tenant: tenantId })),
  };
}

/** The live subscription of a tenant with its plans and its latest changes (`getTenantSubscription`). */
export function useTenantSubscription(tenantId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<TenantSubscription>({
    queryKey: subscriptionKey(tenant?.id, tenantId),
    queryFn: async () => toTenantSubscription(await client.read('getTenantSubscription', { path: { tenantId: tenantId ?? '' } })),
    enabled: tenant !== undefined && tenantId !== undefined,
    retry: false,
  });
}

function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: ['sas', 'subscription', tenant?.id] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useCreateSubscription() {
  const client = useApiClient();
  return useCommand<{ tenantId: string; body: Record<string, unknown> }>((input, attempt) =>
    client.command('createSubscription', { path: { tenantId: input.tenantId }, body: input.body as never, attempt }),
  );
}

export interface PreviewInput {
  subscriptionId: string;
  targetPlanVersionId: string;
  effective: Effective;
}

/** The preview is asked, not changed: it is a command of the contract (it is audited), but it leaves the screens' data as it is, so it does not refresh them. */
export function usePreviewPlanChange() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<PreviewResult, Error, PreviewInput>({
    mutationFn: async (input) =>
      toPreview(
        await client.command('previewPlanChange', {
          path: { subscriptionId: input.subscriptionId },
          body: { target_plan_version_id: input.targetPlanVersionId, effective: input.effective } as never,
          // A new key per ask: two previews of one payload on different days are two answers.
          attempt: attempts.current.forPayload({ ...input, at: Date.now() }),
        }),
      ),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ChangeInput extends PreviewInput {
  version: number;
  previewHash: string;
  reason: string;
}

export function useChangePlan() {
  const client = useApiClient();
  return useCommand<ChangeInput>((input, attempt) =>
    client.command('changeSubscriptionPlan', {
      path: { subscriptionId: input.subscriptionId },
      body: { target_plan_version_id: input.targetPlanVersionId, effective: input.effective, preview_hash: input.previewHash, reason: input.reason } as never,
      ifMatchVersion: input.version,
      attempt,
    }),
  );
}

export interface CancelInput {
  subscriptionId: string;
  version: number;
  reason: string;
}

export function useCancelSubscription() {
  const client = useApiClient();
  return useCommand<CancelInput>((input, attempt) => client.command('cancelSubscription', { path: { subscriptionId: input.subscriptionId }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));
}

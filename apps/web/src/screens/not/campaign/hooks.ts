import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toCampaignPage, toPreview } from './model';
import type { Campaign, CampaignStatus, Preview } from './model';

// The campaigns a person reads depend on who they are in the tenant (whoever lacks the permission on the whole tenant reads their own), so the membership is part of the key.
export const campaignsKey = (tenantId: string | undefined, membershipId: string | undefined) => ['not', 'campaigns', tenantId, membershipId] as const;

/** The campaigns of the tenant, newest first, every page (`listCampaigns`); read again every 30 seconds while a screen shows them, since the sending moves on by itself. */
export function useCampaigns(status: CampaignStatus | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Campaign[]>({
    queryKey: [...campaignsKey(tenant?.id, tenant?.membershipId), status ?? 'all'],
    queryFn: async () => toCampaignPage({ items: await client.readAll('listCampaigns', { query: status === undefined ? {} : { status } }) }).items,
    enabled: enabled && tenant !== undefined,
    refetchInterval: 30_000,
    retry: false,
  });
}

/** One command of the campaign: keeps its idempotency attempt across retries and refreshes the lists when it succeeds. */
function useCampaignCommand<Input, Output>(run: (input: Input, attempt: { key: string }, client: ReturnType<typeof useApiClient>) => Promise<Output>, payloadOf: (input: Input) => unknown) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => run(input, attempts.current.forPayload(payloadOf(input)), client),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: campaignsKey(tenant?.id, tenant?.membershipId) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useCreateCampaign() {
  return useCampaignCommand<Record<string, unknown>, { resource_id?: string }>(
    (body, attempt, client) => client.command('createCampaign', { body: body as never, attempt }) as Promise<{ resource_id?: string }>,
    (body) => body,
  );
}

export interface PreviewInput {
  campaign: Pick<Campaign, 'id' | 'version'>;
  reason: string;
}

export function usePreviewCampaign() {
  return useCampaignCommand<PreviewInput, Preview>(
    async (input, attempt, client) => toPreview(await client.command('previewCampaignRecipients', { path: { campaignId: input.campaign.id }, body: { reason: input.reason }, ifMatchVersion: input.campaign.version, attempt })),
    (input) => input,
  );
}

export interface SubmitInput {
  campaign: Pick<Campaign, 'id' | 'version'>;
  previewHash: string;
  reason: string | undefined;
}

export function useSubmitCampaign() {
  return useCampaignCommand<SubmitInput, unknown>(
    (input, attempt, client) =>
      client.command('submitCampaign', {
        path: { campaignId: input.campaign.id },
        body: { preview_hash: input.previewHash, ...(input.reason === undefined ? {} : { reason: input.reason }) },
        ifMatchVersion: input.campaign.version,
        attempt,
      }),
    (input) => input,
  );
}

export interface DecideInput {
  campaign: Pick<Campaign, 'id' | 'version'>;
  decision: 'approve' | 'return' | 'reject';
  reason: string;
}

export function useDecideCampaign() {
  return useCampaignCommand<DecideInput, unknown>(
    (input, attempt, client) =>
      client.command('decideCampaign', { path: { campaignId: input.campaign.id }, body: { decision: input.decision, reason: input.reason, evidence_ids: [] }, ifMatchVersion: input.campaign.version, attempt }),
    (input) => input,
  );
}

export interface CancelInput {
  campaign: Pick<Campaign, 'id' | 'version'>;
  reason: string;
}

export function useCancelCampaign() {
  return useCampaignCommand<CancelInput, unknown>(
    (input, attempt, client) => client.command('cancelCampaign', { path: { campaignId: input.campaign.id }, body: { reason: input.reason }, ifMatchVersion: input.campaign.version, attempt }),
    (input) => input,
  );
}

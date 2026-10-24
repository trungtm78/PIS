import { ApiError } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toDossier, toDossierLine, toPermitDetail } from './dossier-model';
import { toExpiringPermit } from './expiry-model';
import type { ExpiringPermitView } from './expiry-model';
import type { DossierLineView, DossierView, PermitDetailView } from './dossier-model';
import { toPermitType } from './model';
import type { PermitTypeView, PublishTypeBody } from './model';

/** Every read and every mutation of the permit screens lives under this key of the tenant, so one command refreshes them all. */
export const pmtRoot = (tenantId: string | undefined) => ['pmt', tenantId] as const;

/** One mutation hook: one idempotency attempt per intention, the cached reads of the tenant refreshed on success. */
export function useCommand<Input, Result = unknown>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Result>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: pmtRoot(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Publishes a permit type version, or the next revision of the code that already exists. */
export function usePublishPermitType() {
  const client = useApiClient();
  return useCommand<PublishTypeBody>((body, attempt) => client.command('publishPermitType', { body, attempt }));
}

export interface RetireTypeInput {
  id: string;
  effectiveUntil: string;
}

/** Ends a version on its last day; the row stays, so the permits written under it keep their version. */
export function useRetirePermitType() {
  const client = useApiClient();
  return useCommand<RetireTypeInput>((input, attempt) => client.command('retirePermitType', { path: { id: input.id }, body: { effective_until: input.effectiveUntil }, attempt }));
}

/** Every version of the catalogue of the tenant, in the order of the read (newest first). */
export function usePermitTypes() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PermitTypeView[]>({
    queryKey: [...pmtRoot(tenant?.id), 'permit-types'],
    queryFn: async () => (await client.readAll('get_resources_permit_type')).flatMap((raw) => toPermitType(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** A read by id: a record that does not exist or lies outside the scope of the caller (404) is null, not a failure of the screen. */
async function orMissing<Row>(read: Promise<unknown>, convert: (raw: unknown) => Row | undefined): Promise<Row | null> {
  try {
    return convert(await read) ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Every dossier in the scope of the caller, in the order of the read (by project code). */
export function useDossiers() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DossierLineView[]>({
    // The list depends on the scope of the membership, not only on the tenant.
    queryKey: [...pmtRoot(tenant?.id), tenant?.membershipId, 'dossiers'],
    queryFn: async () => (await client.readAll('get_resources_permit_dossier')).flatMap((raw) => toDossierLine(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** One dossier with its permits; null when none is named or the one named is not in the scope of the caller (404). */
export function useDossier(dossierId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DossierView | null>({
    queryKey: [...pmtRoot(tenant?.id), tenant?.membershipId, 'dossier', dossierId ?? ''],
    queryFn: async () => orMissing(client.read('get_resources_permit_dossier_id', { path: { id: dossierId ?? '' } }), toDossier),
    enabled: tenant !== undefined && dossierId !== undefined,
    retry: false,
  });
}

/** One permit with its milestones; null when none is named or the one named is not in the scope of the caller. */
export function usePermit(permitId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PermitDetailView | null>({
    queryKey: [...pmtRoot(tenant?.id), tenant?.membershipId, 'permit', permitId ?? ''],
    queryFn: async () => orMissing(client.read('get_resources_permit_id', { path: { id: permitId ?? '' } }), toPermitDetail),
    enabled: tenant !== undefined && permitId !== undefined,
    retry: false,
  });
}

/** The permits that run out within `withinDays` days, and the expired ones no renewal has replaced, in the scope of the caller (the board of PMT-05). */
export function useExpiringPermits(withinDays: number) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ExpiringPermitView[]>({
    queryKey: [...pmtRoot(tenant?.id), tenant?.membershipId, 'expiring', withinDays],
    queryFn: async () => (await client.readAll('listExpiringPermits', { query: { within_days: withinDays } })).flatMap((raw) => toExpiringPermit(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

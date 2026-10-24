import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toPermitType } from './model';
import type { PermitTypeView, PublishTypeBody } from './model';

/** Every read and every mutation of the permit screens lives under this key of the tenant, so one command refreshes them all. */
export const pmtRoot = (tenantId: string | undefined) => ['pmt', tenantId] as const;

/** One mutation hook: one idempotency attempt per intention, the cached reads of the tenant refreshed on success. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
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

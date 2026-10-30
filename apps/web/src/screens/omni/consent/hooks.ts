import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toConsents } from './model';
import type { Consent } from './model';

// Who reads is part of the key, as for every read that depends on the permission of the person.
export const consentsKey = (tenantId: string | undefined, membershipId: string | undefined) => ['omni', 'contact-consents', tenantId, membershipId] as const;

/** The consents of one contact: the ones it gave and those of the contacts that were merged into it (`get_resources_contact_consent`, filtered by `contact_id`). */
export function useConsents(contactId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Consent[]>({
    queryKey: [...consentsKey(tenant?.id, tenant?.membershipId), contactId ?? 'none'],
    queryFn: async () => toConsents(await client.readAll('get_resources_contact_consent', { query: { contact_id: contactId as string } })),
    enabled: enabled && contactId !== undefined && tenant !== undefined,
    retry: false,
  });
}

function useConsentCommand<Input>(run: (client: ReturnType<typeof useApiClient>, input: Input, attempt: { key: string }) => Promise<unknown>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => run(client, input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: consentsKey(tenant?.id, tenant?.membershipId) });
    },
    // A refusal can follow a change made by someone else (a consent already ended): the list is read again.
    onError: async (error) => {
      attempts.current.ended(error);
      await queryClient.invalidateQueries({ queryKey: consentsKey(tenant?.id, tenant?.membershipId) });
    },
  });
}

export interface GrantInput {
  contactId: string;
  body: Record<string, unknown>;
}

export function useGrantConsent() {
  return useConsentCommand<GrantInput>((client, input, attempt) => client.command('recordContactConsent', { path: { contactId: input.contactId }, body: input.body as never, attempt }));
}

export interface WithdrawInput {
  consentId: string;
  version: number;
  reason: string;
}

export function useWithdrawConsent() {
  return useConsentCommand<WithdrawInput>((client, input, attempt) =>
    client.command('withdrawContactConsent', { path: { consentId: input.consentId }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }),
  );
}

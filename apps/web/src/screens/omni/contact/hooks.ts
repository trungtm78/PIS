import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toContactPage } from './model';
import type { ContactPage } from './model';

// Who reads the directory is part of the key, as for every read that depends on the permission of the person.
export const contactsKey = (tenantId: string | undefined, membershipId: string | undefined) => ['omni', 'contacts', tenantId, membershipId] as const;

/** The contacts of the tenant, newest first, a page at a time (`get_resources_contact`). */
export function useContacts(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<ContactPage, Error, { pages: ContactPage[] }, readonly unknown[], string | undefined>({
    queryKey: contactsKey(tenant?.id, tenant?.membershipId),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toContactPage(await client.read('get_resources_contact', { query: pageParam === undefined ? {} : { cursor: pageParam } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** One command of the directory: keeps its idempotency attempt across retries and reads the directory again when it succeeds. */
function useContactCommand<Input>(run: (client: ReturnType<typeof useApiClient>, input: Input, attempt: { key: string }) => Promise<unknown>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => run(client, input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: contactsKey(tenant?.id, tenant?.membershipId) });
    },
    // A refusal can be committed with the work it counted (a wrong code raises the version of the identity): the directory is read again, so the form does not go on with a version that is gone.
    onError: async (error) => {
      attempts.current.ended(error);
      await queryClient.invalidateQueries({ queryKey: contactsKey(tenant?.id, tenant?.membershipId) });
    },
  });
}

export function useCreateContact() {
  return useContactCommand<Record<string, unknown>>((client, body, attempt) => client.command('createContact', { body: body as never, attempt }));
}

export interface AddIdentityInput {
  contactId: string;
  channel: string;
  externalId: string;
}

export function useAddIdentity() {
  return useContactCommand<AddIdentityInput>((client, input, attempt) =>
    client.command('addContactIdentity', { path: { contactId: input.contactId }, body: { channel: input.channel as 'PHONE', external_id: input.externalId }, attempt }),
  );
}

export interface VerifyInput {
  contactId: string;
  identityId: string;
  version: number;
  body: Record<string, unknown>;
}

export function useVerifyIdentity() {
  return useContactCommand<VerifyInput>((client, input, attempt) =>
    client.command('verifyContactIdentity', { path: { contactId: input.contactId, identityId: input.identityId }, body: input.body as never, ifMatchVersion: input.version, attempt }),
  );
}

export interface MergeInput {
  survivorId: string;
  mergedId: string;
  identityId: string;
  reason: string;
}

export function useMergeContacts() {
  return useContactCommand<MergeInput>((client, input, attempt) =>
    client.command('mergeContacts', { body: { survivor_contact_id: input.survivorId, merged_contact_id: input.mergedId, shared_verified_identity_id: input.identityId, reason: input.reason }, attempt }),
  );
}

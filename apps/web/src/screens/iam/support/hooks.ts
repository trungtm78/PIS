import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toTicket } from './model';
import type { TicketBody, TicketView } from './model';

// What the list shows is the membership's (a member sees their own tickets), so the membership is part of the key.
const rootKey = (tenantId: string | undefined, membershipId: string | undefined) => ['iam', 'support', tenantId, membershipId] as const;

/** The tickets the caller may see, newest first. */
export function useTickets() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<TicketView[]>({
    queryKey: [...rootKey(tenant?.id, tenant?.membershipId), 'tickets'],
    queryFn: async () => (await client.readAll('get_resources_support_ticket')).flatMap((raw) => toTicket(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** Raises a ticket: one idempotency attempt per intention, the list refreshed on success. */
export function useCreateTicket() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: TicketBody) => client.command('createSupportTicket', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: rootKey(tenant?.id, tenant?.membershipId) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

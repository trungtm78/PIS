import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import { pmtRoot, useCommand } from './hooks';
import { toWaiver } from './waiver-model';
import type { GrantBody, WaiverView } from './waiver-model';

/** The waivers of the projects in the scope of the caller, newest first (the key carries the membership: the scope is the membership's). */
export function useWaivers() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<WaiverView[]>({
    queryKey: [...pmtRoot(tenant?.id), tenant?.membershipId, 'gate-waivers'],
    queryFn: async () => (await client.readAll('get_resources_permit_gate_waiver')).flatMap((raw) => toWaiver(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** Grants a waiver of a gate for one permit type of one project. */
export function useGrantWaiver() {
  const client = useApiClient();
  return useCommand<GrantBody>((body, attempt) => client.command('grantPermitGateWaiver', { body, attempt }));
}

export interface RevokeWaiverInput {
  id: string;
  reason: string;
}

/** Ends a waiver in force with the words that explain it; the row stays, so the decision can be explained later. */
export function useRevokeWaiver() {
  const client = useApiClient();
  return useCommand<RevokeWaiverInput>((input, attempt) => client.command('revokePermitGateWaiver', { path: { id: input.id }, body: { reason: input.reason.trim() }, attempt }));
}

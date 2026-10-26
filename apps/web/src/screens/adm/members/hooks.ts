import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import type { RoleView } from '../roles/types';
import { PAGE_SIZE, toContractOption, toMemberPage, toSeatUsage, toUnitOption } from './types';
import type { ContractOption, MemberPage, MembershipType, SeatUsage, UnitOption } from './types';

// What a directory, a unit list or a role list contains depends on the scope of the membership that is signed in, not only on the
// tenant: switching between two memberships of one tenant (IAM-04) keeps the query client, so the membership is part of every key.
function useScopeKey(): readonly [string | undefined, string | undefined] {
  const { tenant } = useSession();
  return [tenant?.id, tenant?.membershipId];
}

const MEMBERS_KEY = 'adm-members';
const UNITS_KEY = 'adm-members-units';
const SEATS_KEY = 'adm-members-seats';
const ROLES_KEY = 'adm-members-roles';
const CONTRACTS_KEY = 'adm-members-contracts';

/** The memberships of the directory, page by page; `type` limits them to one kind (ADM-17 lists the guests only). */
export function useMembers(type: MembershipType | undefined, enabled: boolean) {
  const client = useApiClient();
  const [tenantId, membershipId] = useScopeKey();
  return useInfiniteQuery<MemberPage, Error, { pages: MemberPage[] }, readonly unknown[], string | undefined>({
    queryKey: [MEMBERS_KEY, tenantId, membershipId, type ?? 'all'],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toMemberPage(
        await client.read('get_resources_membership', {
          query: { limit: PAGE_SIZE, ...(type === undefined ? {} : { membership_type: type }), ...(pageParam === undefined ? {} : { cursor: pageParam }) },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenantId !== undefined,
    retry: false,
  });
}

/** The seats in use and their limits, for the line above the members; asked for only by someone who may read the subscription. */
export function useSeatUsage(enabled: boolean) {
  const client = useApiClient();
  const [tenantId, membershipId] = useScopeKey();
  return useQuery<SeatUsage>({
    queryKey: [SEATS_KEY, tenantId, membershipId],
    queryFn: async () => toSeatUsage(await client.read('getMyUsage')),
    enabled: enabled && tenantId !== undefined,
    retry: false,
  });
}

/** The units of the tenant the caller may read: the invitation picks the unit of the new member from them. */
export function useUnits(enabled: boolean) {
  const client = useApiClient();
  const [tenantId, membershipId] = useScopeKey();
  return useQuery<UnitOption[]>({
    queryKey: [UNITS_KEY, tenantId, membershipId],
    queryFn: async () => (await client.readAll('get_resources_organization_unit')).flatMap(toUnitOption),
    enabled: enabled && tenantId !== undefined,
    retry: false,
  });
}

/** The roles the signed-in user could hand out; the invitation offers nothing else. */
export function useGrantableRoles(enabled: boolean) {
  const client = useApiClient();
  const [tenantId, membershipId] = useScopeKey();
  return useQuery<RoleView[]>({
    queryKey: [ROLES_KEY, tenantId, membershipId],
    queryFn: async () => (await client.readAll('get_resources_role_definition', { query: { grantable: true } })) as RoleView[],
    enabled: enabled && tenantId !== undefined,
    retry: false,
  });
}

/** The contracts the caller reaches (the picker of the guest invitation). */
export function useContracts(enabled: boolean) {
  const client = useApiClient();
  const [tenantId, membershipId] = useScopeKey();
  return useQuery<ContractOption[]>({
    queryKey: [CONTRACTS_KEY, tenantId, membershipId],
    queryFn: async () => (await client.readAll('get_resources_contract')).flatMap(toContractOption),
    enabled: enabled && tenantId !== undefined,
    retry: false,
  });
}

/** Reloads the directory after a command changed a membership. */
export function useRefreshMembers(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(() => queryClient.invalidateQueries({ queryKey: [MEMBERS_KEY] }), [queryClient]);
}

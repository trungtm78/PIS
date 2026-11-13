import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toOrgUnits } from './types';
import type { OrgUnit, UnitType } from './types';

export const orgUnitsKey = (tenantId: string | undefined) => ['org-units', tenantId] as const;

export interface CreateUnitBody {
  code: string;
  name: string;
  parent_id: string;
  unit_type: UnitType;
  valid_from: string;
  is_investor?: boolean;
  administrative_code?: string;
  legal_basis_ref?: string;
}

export interface UpdateUnitBody {
  code?: string;
  name?: string;
  is_investor?: boolean;
  administrative_code?: string;
  legal_basis_ref?: string;
}

export interface MoveUnitBody {
  new_parent_id: string;
  effective_from: string;
  reason: string;
}

// The registry is shared by every screen that sends commands (notifications use it too).
export { AttemptRegistry };

/** Every unit of the tenant the caller may read (all pages), keyed by tenant so a tenant switch never shows another tenant's tree. */
export function useOrgUnits(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<OrgUnit[]>({
    queryKey: orgUnitsKey(tenant?.id),
    queryFn: async () => toOrgUnits(await client.readAll('get_resources_organization_unit')),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The three unit commands; each refreshes the list on success and keeps its idempotency attempt across retries. */
export function useUnitCommands() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  const refresh = () => queryClient.invalidateQueries({ queryKey: orgUnitsKey(tenant?.id) });
  const finish = async () => {
    attempts.current.done();
    await refresh();
  };

  const create = useMutation({
    mutationFn: (body: CreateUnitBody) => client.command('createOrganizationUnit', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: finish,
  });
  const update = useMutation({
    mutationFn: (input: { unit: OrgUnit; body: UpdateUnitBody }) =>
      client.command('updateOrganizationUnit', {
        path: { unitId: input.unit.id },
        body: input.body,
        ifMatchVersion: input.unit.version,
        attempt: attempts.current.forPayload({ id: input.unit.id, version: input.unit.version, body: input.body }),
      }),
    onSuccess: finish,
  });
  const move = useMutation({
    mutationFn: (input: { unit: OrgUnit; body: MoveUnitBody }) =>
      client.command('moveOrganizationUnit', {
        path: { unitId: input.unit.id },
        body: input.body,
        ifMatchVersion: input.unit.version,
        attempt: attempts.current.forPayload({ id: input.unit.id, version: input.unit.version, body: input.body }),
      }),
    onSuccess: finish,
  });
  return { create, update, move, refresh };
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { WORKING_REFRESH_MS, isWorking, toReorganization } from './model';
import type { ReorganizationView } from './model';

// What a list and a directory contain depends on the scope of the membership that is signed in, not only on the tenant.
const root = (tenantId: string | undefined, membershipId: string | undefined) => ['adm', 'reorganization', tenantId, membershipId] as const;

/** The proposals, newest first. */
export function useReorganizations(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ReorganizationView[]>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'list'],
    queryFn: async () => (await client.readAll('get_resources_unit_reorganization')).flatMap((raw) => toReorganization(raw) ?? []),
    // While a saga is being carried out the list is read again, so that it shows it applied or stopped.
    refetchInterval: (query) => (query.state.data?.some((row) => isWorking(row.status)) === true ? WORKING_REFRESH_MS : false),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** One proposal with the steps the saga has done. */
export function useReorganization(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ReorganizationView | undefined>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'one', id],
    queryFn: async () => toReorganization(await client.read('get_resources_unit_reorganization_id', { path: { id: id as string } })),
    refetchInterval: (query) => (isWorking(query.state.data?.status) ? WORKING_REFRESH_MS : false),
    enabled: id !== undefined && tenant !== undefined,
    retry: false,
  });
}

/** How many active members each unit holds, from the directory: the wizard shows what moves. */
export function useHeadcount(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Map<string, number>>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'headcount'],
    queryFn: async () => {
      const counts = new Map<string, number>();
      for (const raw of await client.readAll('get_resources_membership')) {
        const row = raw as { organization_id?: unknown; status?: unknown };
        if (typeof row.organization_id === 'string' && row.status === 'Active') counts.set(row.organization_id, (counts.get(row.organization_id) ?? 0) + 1);
      }
      return counts;
    },
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

function useReorganizationCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id, tenant?.membershipId) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function usePropose() {
  const client = useApiClient();
  return useReorganizationCommand<Record<string, unknown>>((body, attempt) => client.command('proposeUnitReorganization', { body: body as never, attempt }));
}

export function useDecide() {
  const client = useApiClient();
  return useReorganizationCommand<{ id: string; version: number; decision: 'approve' | 'return' | 'reject'; reason: string }>((input, attempt) =>
    client.command('decideUnitReorganization', { path: { reorgId: input.id }, body: { decision: input.decision, reason: input.reason, evidence_ids: [] } as never, ifMatchVersion: input.version, attempt }),
  );
}

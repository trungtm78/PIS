import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../../api/attempt-registry';
import { useSession } from '../../../../session/SessionContext';
import { toDetail, toList } from './model';
import type { EquipmentStage, ListResult } from './model';

// What the screens show depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['eqp', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['eqp', tenant?.id, tenant?.membershipId];
}

const q = (value: Record<string, string | boolean | undefined>): never => value as never;

export interface ListFilter {
  projectId: string | undefined;
  stage: EquipmentStage | undefined;
  includeCancelled: boolean;
}

/** The lines in the scope of the caller, with the state of the file import that feeds them. */
export function useEquipmentLines(filter: ListFilter, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ListResult>({
    queryKey: [...key, 'lines', filter.projectId ?? 'all', filter.stage ?? 'all', filter.includeCancelled],
    queryFn: async () =>
      toList(await client.read('listEquipmentProcurement', { query: q({ ...(filter.projectId === undefined ? {} : { project_id: filter.projectId }), ...(filter.stage === undefined ? {} : { stage: filter.stage }), ...(filter.includeCancelled ? { include_cancelled: true } : {}) }) })),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

export function useEquipmentLine(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'line', id ?? ''],
    queryFn: async () => toDetail(await client.read('getEquipmentProcurement', { path: { id: id as string } })),
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

export interface ProjectOption {
  id: string;
  code: string;
  name: string;
}

/** The projects the caller may read, for the choice of the project of a new line. */
export function useProjectOptions(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ProjectOption[]>({
    queryKey: [...key, 'projects'],
    queryFn: async () =>
      (await client.readAll('get_resources_project')).flatMap((raw): ProjectOption[] => {
        const row = raw as { id?: unknown; code?: unknown; name?: unknown };
        return typeof row.id === 'string' && typeof row.code === 'string' ? [{ id: row.id, code: row.code, name: typeof row.name === 'string' ? row.name : row.code }] : [];
      }),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: [key[0], key[1]] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useCreateLine() {
  const client = useApiClient();
  return useCommand<Record<string, string>>((body, attempt) => client.command('createEquipmentProcurementItem', { body: body as never, attempt }));
}

export interface UpdateInput {
  id: string;
  version: number;
  body: Record<string, string>;
}

export function useUpdateLine() {
  const client = useApiClient();
  return useCommand<UpdateInput>((input, attempt) => client.command('updateEquipmentProcurementItem', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

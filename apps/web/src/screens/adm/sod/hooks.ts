import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toMember } from '../../dgv/model';
import type { MemberOption } from '../../dgv/model';
import { toException, toMatrix, toUse } from './model';
import type { ExceptionView, MatrixView, Outcome, Status, UseView } from './model';

const root = (tenantId: string | undefined) => ['adm', 'sod', tenantId] as const;

/** The matrix in force, with the version that decided, its formula and where its numbers come from. */
export function useSodMatrix(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<MatrixView>({
    queryKey: [...root(tenant?.id), 'matrix'],
    queryFn: async () => {
      const matrix = toMatrix(await client.read('getSodMatrix'));
      if (matrix === undefined) throw new Error('the matrix is not in the shape of the contract');
      return matrix;
    },
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The register of exceptions, newest first (every page); `status` EXPIRED is the one derived from the last day. */
export function useSodExceptions(status: Status | undefined, enabled: boolean, audit = false) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ExceptionView[]>({
    queryKey: [...root(tenant?.id), audit ? 'audit-exceptions' : 'exceptions', status ?? 'all'],
    queryFn: async () => (await client.readAll(audit ? 'listSodAuditExceptions' : 'listSodExceptions', { query: status === undefined ? {} : { status } })).flatMap((raw) => toException(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** What the auditor reads: the commands that went through an exception or a warning, and the ones that were refused. */
export function useSodUses(outcome: Outcome | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<UseView[]>({
    queryKey: [...root(tenant?.id), 'uses', outcome ?? 'all'],
    queryFn: async () => (await client.readAll('listSodAuditUses', { query: outcome === undefined ? {} : { outcome } })).flatMap((raw) => toUse(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

export interface SubjectOption {
  id: string;
  label: string;
}

const subjectOf = (raw: unknown, name: 'title' | 'name'): SubjectOption | undefined => {
  const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
  if (row === undefined || typeof row.id !== 'string') return undefined;
  const code = typeof row.code === 'string' ? row.code : row.id.slice(0, 8);
  const title = typeof row[name] === 'string' ? (row[name] as string) : '';
  return { id: row.id, label: title === '' ? code : `${code} - ${title}` };
};

/** The contracts, projects or packages an exception can be bound to (empty for a scope that has no list: the record is then named by its id). */
export function useSubjects(kind: 'project' | 'contract' | 'package' | 'record', enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<SubjectOption[]>({
    queryKey: [...root(tenant?.id), 'subjects', kind],
    queryFn: async () => {
      if (kind === 'record') return [];
      const operation = kind === 'contract' ? 'get_resources_contract' : kind === 'project' ? 'get_resources_project' : 'get_resources_procurement_package';
      return (await client.readAll(operation)).flatMap((raw) => subjectOf(raw, kind === 'project' ? 'name' : 'title') ?? []);
    },
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The active staff an exception can cover. */
export function useStaff(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<MemberOption[]>({
    queryKey: [...root(tenant?.id), 'staff'],
    queryFn: async () => (await client.readAll('get_resources_membership')).flatMap((raw) => toMember(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

function useSodCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useRequestException() {
  const client = useApiClient();
  return useSodCommand<Record<string, unknown>>((body, attempt) => client.command('requestSodException', { body: body as never, attempt }));
}

export function useApproveException() {
  const client = useApiClient();
  return useSodCommand<{ id: string; version: number; comment: string | undefined }>((input, attempt) =>
    client.command('approveSodException', { path: { id: input.id }, body: (input.comment === undefined ? {} : { comment: input.comment }) as never, ifMatchVersion: input.version, attempt }),
  );
}

export function useRejectException() {
  const client = useApiClient();
  return useSodCommand<{ id: string; version: number; reason: string }>((input, attempt) => client.command('rejectSodException', { path: { id: input.id }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));
}

export function useRevokeException() {
  const client = useApiClient();
  return useSodCommand<{ id: string; version: number; reason: string }>((input, attempt) => client.command('revokeSodException', { path: { id: input.id }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));
}

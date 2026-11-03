import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toReportList } from './model';
import type { CreateBody, Report, SignBody } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['bid-reports', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-reports', tenant?.id, tenant?.membershipId];
}

/** The reports of a package, the newest first; none is asked for until a package is chosen and the caller may. */
export function useReports(packageId: string, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Report[]>({
    queryKey: [...key, 'list', packageId],
    queryFn: async () => toReportList(await client.read('listEvaluationReports', { path: { id: packageId } })),
    enabled: enabled && key[1] !== undefined && packageId !== '',
    retry: false,
  });
}

/** Making the draft: one idempotency attempt for each intention. The reports are read again whatever the answer was. */
export function useCreateReport() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: CreateBody) => client.command('createEvaluationReport', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

export interface SignInput {
  report: Report;
  body: SignBody;
}

/**
 * The signature of a member. It names the version of the report the person saw (If-Match), and each report keeps the idempotency attempt of its own intention, so a retry after a lost answer is the same request
 * (same version, same key) and a different dissent is a new one. A refusal ends the intention; the reports are read again whatever the answer was, so that a person who met a stale report or a version conflict
 * sees what stands now.
 */
export function useSignOff() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new Map<string, AttemptRegistry>());
  const registryOf = (id: string): AttemptRegistry => {
    const found = attempts.current.get(id) ?? new AttemptRegistry();
    attempts.current.set(id, found);
    return found;
  };
  return useMutation<unknown, unknown, SignInput>({
    mutationFn: ({ report, body }) =>
      client.command('signOffEvaluationReport', { path: { id: report.id }, body, ifMatchVersion: report.version, attempt: registryOf(report.id).forPayload({ id: report.id, version: report.version, body }) }),
    onSuccess: (_answer, { report }) => attempts.current.delete(report.id),
    onError: (error, { report }) => registryOf(report.id).ended(error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toMatrix } from './model';
import type { DoaMatrixView, matrixBody } from './model';

/** The queries that show matrix versions begin with this key: a command refreshes all of them. */
const matricesKey = (tenantId: string | undefined) => ['adm', 'doa-matrices', tenantId] as const;

/** Every version of the matrix of the tenant with its rules, keyed by tenant. `enabled` false keeps a screen that may not read the matrix from asking. */
export function useDoaMatrices(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DoaMatrixView[]>({
    queryKey: matricesKey(tenant?.id),
    queryFn: async () => (await client.readAll('get_resources_doa_matrix_version')).flatMap((raw) => toMatrix(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

export interface RoleOption {
  id: string;
  code: string;
}

/** The roles an approver can be named by (the role catalogue of the tenant). */
export function useRoleOptions(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<RoleOption[]>({
    queryKey: ['adm', 'doa-roles', tenant?.id],
    queryFn: async () =>
      (await client.readAll('get_resources_role_definition')).flatMap((raw) => {
        const row = raw as Record<string, unknown>;
        return typeof row.id === 'string' && typeof row.code === 'string' ? [{ id: row.id, code: row.code }] : [];
      }),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** Runs a mutation that refreshes the matrix versions on success and keeps one idempotency attempt per intention. */
function useMatrixCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>, client: ReturnType<typeof useApiClient>) => Promise<unknown>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input), client),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: matricesKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export type MatrixBody = ReturnType<typeof matrixBody>;

/** Writes the next draft revision. */
export function useCreateMatrixDraft() {
  return useMatrixCommand((body: MatrixBody, attempt, client) => client.command('createDoaMatrixDraft', { body, attempt }));
}

export interface UpdateInput {
  id: string;
  version: number;
  body: MatrixBody;
}

/** Replaces a draft as a whole (versioned: a stale version is a 409). */
export function useUpdateMatrixDraft() {
  return useMatrixCommand((input: UpdateInput, attempt, client) =>
    client.command('updateDoaMatrixDraft', { path: { matrixId: input.id }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

export interface ReasonInput {
  id: string;
  version: number;
  reason: string;
}

/** Submits a draft for approval. */
export function useSubmitMatrix() {
  return useMatrixCommand((input: ReasonInput, attempt, client) =>
    client.command('submitDoaMatrix', { path: { matrixId: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }),
  );
}

export type DecisionKind = 'approve' | 'return' | 'reject';

export interface DecisionInput extends ReasonInput {
  decision: DecisionKind;
}

/** Decides a version that waits for approval; the server refuses the author and the last editor with SELF_APPROVAL_DENIED. */
export function useDecideMatrix() {
  return useMatrixCommand((input: DecisionInput, attempt, client) =>
    client.command('decideDoaMatrix', {
      path: { matrixId: input.id },
      body: { decision: input.decision, reason: input.reason, evidence_ids: [] },
      ifMatchVersion: input.version,
      attempt,
    }),
  );
}

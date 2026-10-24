import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';

/** The plan a command acts on and the version of it the person saw: the command is refused if another person changed the plan since. */
export interface PlanCommand {
  planId: string;
  version: number;
}

export interface DecideInput extends PlanCommand {
  decision: 'approve' | 'reject' | 'return';
  reason: string;
}

export interface PublishInput extends PlanCommand {
  body: { decision_document_id: string; effective_at?: string };
}

/** One mutation hook: one idempotency attempt per intention, the cached reads of the capital refreshed on success. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<{ resource_id?: string; resource_version?: number }>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: ['cap', tenant?.id, tenant?.membershipId] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useSubmitPlan() {
  const client = useApiClient();
  return useCommand<PlanCommand>((input, attempt) => client.command('submitCapitalPlan', { path: { id: input.planId }, ifMatchVersion: input.version, attempt }));
}

export function useDecidePlan() {
  const client = useApiClient();
  return useCommand<DecideInput>((input, attempt) =>
    client.command('decideCapitalPlan', { path: { id: input.planId }, body: { decision: input.decision, reason: input.reason }, ifMatchVersion: input.version, attempt }),
  );
}

export function usePublishPlan() {
  const client = useApiClient();
  return useCommand<PublishInput>((input, attempt) => client.command('post_plans_id_publish', { path: { id: input.planId }, body: input.body, ifMatchVersion: input.version, attempt }));
}

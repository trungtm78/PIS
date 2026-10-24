import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import { toEvaluation, toGateRule } from './gate-model';
import type { EvaluationView, GateCode, GateRuleView, PublishGateBody } from './gate-model';
import { pmtRoot, useCommand } from './hooks';

/** Every version of the gate rules of the tenant, newest first (the legal data of the whole tenant, so the key has no membership). */
export function useGateRules() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<GateRuleView[]>({
    queryKey: [...pmtRoot(tenant?.id), 'gate-rules'],
    queryFn: async () => (await client.readAll('get_resources_permit_gate_rule')).flatMap((raw) => toGateRule(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** Publishes a rule, or the next revision of the rule of the same gate and permit type. */
export function usePublishGateRule() {
  const client = useApiClient();
  return useCommand<PublishGateBody>((body, attempt) => client.command('publishPermitGateRule', { body, attempt }));
}

export interface RetireGateInput {
  id: string;
  effectiveUntil: string;
}

/** Ends a rule on its last day; the row stays, so an evaluation of a past day can still be explained. */
export function useRetireGateRule() {
  const client = useApiClient();
  return useCommand<RetireGateInput>((input, attempt) => client.command('retirePermitGateRule', { path: { id: input.id }, body: { effective_until: input.effectiveUntil }, attempt }));
}

/** Whether the gates pass for a project on a day (all five when no gate is named), in the scope of the caller. */
export function useGateEvaluation(projectId: string | undefined, gate: GateCode | undefined, asOf: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<EvaluationView | undefined>({
    queryKey: [...pmtRoot(tenant?.id), tenant?.membershipId, 'gate-evaluation', projectId, gate ?? 'all', asOf ?? 'today'],
    queryFn: async () =>
      toEvaluation(await client.read('evaluatePermitGates', { path: { id: projectId as string }, query: { ...(gate === undefined ? {} : { gate_code: gate }), ...(asOf === undefined ? {} : { as_of: asOf }) } })),
    enabled: tenant !== undefined && projectId !== undefined,
    retry: false,
  });
}

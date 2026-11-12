import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { toAppraisalView } from '../appraisal-model';
import type { AppraisalView } from '../appraisal-model';
import { useScopeKey } from '../hooks';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** One step of the stage history of a project, as the lifecycle read lists it. */
export interface StageStep {
  from: string;
  to: string;
  operation: string;
  actorName: string | null;
  reason: string | null;
  occurredAt: string | null;
  hasDecisionDocument: boolean;
}

export interface LifecycleBlock {
  appraisal: AppraisalView | null;
  history: StageStep[];
}

export function toStageHistory(raw: unknown): StageStep[] {
  const rows = asRecord(raw)?.history;
  return (Array.isArray(rows) ? rows : []).flatMap((item): StageStep[] => {
    const row = asRecord(item);
    const from = nullableText(row?.from);
    const to = nullableText(row?.to);
    const operation = nullableText(row?.operation);
    if (row === undefined || from === null || to === null || operation === null) return [];
    return [{ from, to, operation, actorName: nullableText(row.actor_name), reason: nullableText(row.reason), occurredAt: nullableText(row.occurred_at), hasDecisionDocument: nullableText(row.decision_document_id) !== null }];
  });
}

/** The step in which the proposal was submitted for appraisal. */
export function proposalStep(history: readonly StageStep[]): StageStep | undefined {
  return history.find((step) => step.operation === 'submitProjectForAppraisal');
}

/** The latest decision of an appraisal. */
export function decisionStep(history: readonly StageStep[]): StageStep | undefined {
  return [...history].reverse().find((step) => step.operation === 'decideProjectAppraisal');
}

/** The lifecycle read of one project: the appraisal block (criteria, sheets) and the stage history, from one request. */
export function useLifecycleBlock(projectId: string | undefined) {
  const client = useApiClient();
  const scope = useScopeKey();
  return useQuery<LifecycleBlock>({
    queryKey: [...scope, 'ws', 'lifecycle', projectId ?? ''],
    queryFn: async () => {
      const raw = await client.read('getProjectLifecycle', { path: { id: projectId ?? '' } });
      return { appraisal: toAppraisalView(raw) ?? null, history: toStageHistory(raw) };
    },
    enabled: scope[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { toPackageLine } from '../../bid/plan-model';
import type { PackageLine } from '../../bid/plan-model';
import { toPlan, toPlanLines } from '../../cap/plan-model';
import type { PlanLine, PlanSummary } from '../../cap/plan-model';
import { toContractLine } from '../../ctr/model';
import type { ContractLine } from '../../ctr/model';
import { useScopeKey } from '../hooks';

const PAGE_SIZE = 200;
const MAX_PAGES = 50;

/** The plan revision in force of one kind: published, the latest year and the latest revision. */
export function inForce(plans: readonly PlanSummary[], kind: PlanSummary['planKind']): PlanSummary | undefined {
  return plans
    .filter((plan) => plan.planKind === kind && plan.status === 'PUBLISHED')
    .sort((a, b) => b.periodToYear - a.periodToYear || b.periodFromYear - a.periodFromYear || b.revision - a.revision)[0];
}

export interface ProjectCapital {
  plan: PlanSummary;
  lines: PlanLine[];
}

/** The lines of one project in the revision in force of the annual plan and of the medium-term plan; a kind with no published revision is left out. */
export function useProjectCapital(projectId: string) {
  const client = useApiClient();
  const scope = useScopeKey();
  return useQuery<ProjectCapital[]>({
    queryKey: [...scope, 'ws-plan', 'capital', projectId],
    queryFn: async () => {
      const plans = (await client.readAll('get_resources_plan_version')).flatMap((raw) => toPlan(raw) ?? []);
      const chosen = (['ANNUAL', 'MEDIUM_TERM'] as const).flatMap((kind) => inForce(plans, kind) ?? []);
      return Promise.all(
        chosen.map(async (plan) => {
          const lines: PlanLine[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < MAX_PAGES; page += 1) {
            const answer = toPlanLines(await client.read('listCapitalPlanLines', { path: { id: plan.id }, query: { project_id: projectId, limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) } }));
            if (answer === undefined) break;
            lines.push(...answer.lines.filter((line) => line.project.id === projectId));
            cursor = answer.nextCursor ?? undefined;
            if (cursor === undefined) break;
          }
          return { plan, lines };
        }),
      );
    },
    enabled: scope[1] !== undefined,
    retry: false,
  });
}

/** The procurement packages of one project (the read has no project filter: the register in scope is filtered here). */
export function useProjectPackages(projectId: string) {
  const client = useApiClient();
  const scope = useScopeKey();
  return useQuery<PackageLine[]>({
    queryKey: [...scope, 'ws-plan', 'packages', projectId],
    queryFn: async () => (await client.readAll('get_resources_procurement_package')).flatMap((raw) => toPackageLine(raw) ?? []).filter((item) => item.project.id === projectId),
    enabled: scope[1] !== undefined,
    retry: false,
  });
}

/** The contracts of one project (the register in scope, filtered here). */
export function useProjectContracts(projectId: string) {
  const client = useApiClient();
  const scope = useScopeKey();
  return useQuery<ContractLine[]>({
    queryKey: [...scope, 'ws-plan', 'contracts', projectId],
    queryFn: async () => (await client.readAll('get_resources_contract')).flatMap((raw) => toContractLine(raw) ?? []).filter((item) => item.projectId === projectId),
    enabled: scope[1] !== undefined,
    retry: false,
  });
}

import { GovernancePolicyPort } from '@machvon/db';
import type { MasterLabel, TenantTx } from '@machvon/db';
import { MILESTONE_RULE, milestonesOfResolved } from './ent-catalogue.ts';
import { investmentProfileOf, planRevisionsOf } from './investment-profile.ts';
import type { HeldMilestone, InvestmentProfile, OriginLine, PlanRevision } from './investment-profile.ts';

/**
 * The database half of the investment profile (MD.01, MD.02, CN.01): the milestones a project holds, the plan version the split is read from and the plan lines of that version with their origin and decision document
 * (`v_project_origin_decision`), and the milestone catalogue in force (governance rules of the tenant, else the built-in entries). It reads inside the transaction of the caller, so row-level security keeps the tenants
 * apart, and it writes nothing. The caller has already judged that the project is in the scope of the reader.
 */
interface MilestoneSql {
  code: string;
  planned_on: string;
  actual_on: string | null;
  status: HeldMilestone['status'];
}

interface PlanSql {
  id: string;
  plan_code: string | null;
  status: string;
  revision: number;
}

const planOf = (row: PlanSql): PlanRevision => ({ id: row.id, planCode: row.plan_code, status: row.status, revision: row.revision });

interface OriginSql {
  origin: string;
  decision_kind: string | null;
  decision_symbol: string | null;
  decision_issued_on: string | null;
  issuing_authority: string | null;
  amount_vnd: string;
}

export interface ProfileRequest {
  projectId: string;
  projectType: MasterLabel | null;
  projectStartYear: number | null;
  planYear: number;
  /** The business day (Vietnam time) the catalogue is read for. */
  today: string;
  /** Whether the caller drafts or approves plans: only then may the split be read from a revision that is not yet published (the visibility rule of the plan reads, CAP 3.1 section 7). */
  drafts: boolean;
}

export class InvestmentProfileStore {
  private readonly rules = new GovernancePolicyPort();

  private async projectTypeOf(tx: TenantTx, projectType: MasterLabel | null): Promise<InvestmentProfile['projectType']> {
    if (projectType === null) return null;
    const [row] = await tx.query<{ kind: string | null }>('select attributes ->> $2 as kind from machvon.master_record_version where id = $1::uuid', [projectType.versionId, 'kind']);
    return { code: projectType.businessKey, label: projectType.label, kind: row?.kind ?? null };
  }

  /**
   * The revisions of the ANNUAL plans of the project in the year that can be a plan at all (a medium-term plan has a first year too, and its lines are not the capital of that year; a rejected or superseded revision is no plan);
   * which one stands for each plan is the rule of `planRevisionsOf`.
   */
  private async plansOf(tx: TenantTx, projectId: string, planYear: number, drafts: boolean): Promise<PlanRevision[]> {
    const rows = await tx.query<PlanSql>(
      `select pv.id, cp.plan_code, pv.status, pv.revision
         from machvon.plan_version pv left join machvon.capital_plan cp on cp.tenant_id = pv.tenant_id and cp.id = pv.capital_plan_id
        where pv.project_id = $1::uuid and pv.fiscal_year = $2 and pv.status in ('DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED') and (pv.capital_plan_id is null or cp.plan_kind = 'ANNUAL')`,
      [projectId, planYear],
    );
    return planRevisionsOf(rows.map(planOf), drafts);
  }

  async read(tx: TenantTx, request: ProfileRequest): Promise<InvestmentProfile> {
    const resolved = await this.rules.getAll(tx, MILESTONE_RULE, request.today);
    const held = await tx.query<MilestoneSql>(
      `select code, planned_date::text as planned_on, actual_date::text as actual_on, status from machvon.project_milestone where project_id = $1::uuid order by planned_date, code`,
      [request.projectId],
    );
    const plans = await this.plansOf(tx, request.projectId, request.planYear, request.drafts);
    const origins =
      plans.length === 0
        ? []
        : await tx.query<OriginSql>(
            `select origin, decision_kind, decision_symbol, decision_issued_on::text as decision_issued_on, issuing_authority, amount_vnd::text as amount_vnd
               from machvon.v_project_origin_decision where project_id = $1::uuid and plan_version_id = any($2::uuid[]) order by origin, decision_symbol, allocation_line_id`,
            [request.projectId, plans.map((one) => one.id)],
          );
    return investmentProfileOf({
      catalogue: milestonesOfResolved(resolved),
      projectType: await this.projectTypeOf(tx, request.projectType),
      projectStartYear: request.projectStartYear,
      held: held.map((one): HeldMilestone => ({ code: one.code, plannedOn: one.planned_on, actualOn: one.actual_on, status: one.status })),
      plans: plans.map((one) => ({ planCode: one.planCode, status: one.status, revision: one.revision })),
      origins: origins.map((one): OriginLine => ({ origin: one.origin, decisionKind: one.decision_kind, decisionSymbol: one.decision_symbol, decisionIssuedOn: one.decision_issued_on, issuingAuthority: one.issuing_authority, amountVnd: one.amount_vnd })),
      planYear: request.planYear,
    });
  }
}

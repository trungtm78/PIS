import { GovernancePolicyPort } from '@machvon/db';
import type { MasterLabel, TenantTx } from '@machvon/db';
import { MILESTONE_RULE, milestonesOfResolved } from './ent-catalogue.ts';
import { investmentProfileOf } from './investment-profile.ts';
import type { HeldMilestone, InvestmentProfile, OriginLine } from './investment-profile.ts';

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
  status: string;
  revision: number;
}

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
}

export class InvestmentProfileStore {
  private readonly rules = new GovernancePolicyPort();

  private async projectTypeOf(tx: TenantTx, projectType: MasterLabel | null): Promise<InvestmentProfile['projectType']> {
    if (projectType === null) return null;
    const [row] = await tx.query<{ kind: string | null }>('select attributes ->> $2 as kind from machvon.master_record_version where id = $1::uuid', [projectType.versionId, 'kind']);
    return { code: projectType.businessKey, label: projectType.label, kind: row?.kind ?? null };
  }

  /** The plan version of the year the split is read from: the published one, else the newest that is still alive (a rejected or superseded version is no plan of the project). */
  private async planOf(tx: TenantTx, projectId: string, planYear: number): Promise<PlanSql | undefined> {
    const [row] = await tx.query<PlanSql>(
      `select id, status, revision from machvon.plan_version
        where project_id = $1::uuid and fiscal_year = $2 and status in ('DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED')
        order by (status = 'PUBLISHED') desc, revision desc limit 1`,
      [projectId, planYear],
    );
    return row;
  }

  async read(tx: TenantTx, request: ProfileRequest): Promise<InvestmentProfile> {
    const resolved = await this.rules.getAll(tx, MILESTONE_RULE, request.today);
    const held = await tx.query<MilestoneSql>(
      `select code, planned_date::text as planned_on, actual_date::text as actual_on, status from machvon.project_milestone where project_id = $1::uuid order by planned_date, code`,
      [request.projectId],
    );
    const plan = await this.planOf(tx, request.projectId, request.planYear);
    const origins =
      plan === undefined
        ? []
        : await tx.query<OriginSql>(
            `select origin, decision_kind, decision_symbol, decision_issued_on::text as decision_issued_on, issuing_authority, amount_vnd::text as amount_vnd
               from machvon.v_project_origin_decision where project_id = $1::uuid and plan_version_id = $2::uuid order by origin, decision_symbol, allocation_line_id`,
            [request.projectId, plan.id],
          );
    return investmentProfileOf({
      catalogue: milestonesOfResolved(resolved),
      projectType: await this.projectTypeOf(tx, request.projectType),
      projectStartYear: request.projectStartYear,
      held: held.map((one): HeldMilestone => ({ code: one.code, plannedOn: one.planned_on, actualOn: one.actual_on, status: one.status })),
      plan: plan === undefined ? null : { status: plan.status, revision: plan.revision },
      origins: origins.map((one): OriginLine => ({ origin: one.origin, decisionKind: one.decision_kind, decisionSymbol: one.decision_symbol, decisionIssuedOn: one.decision_issued_on, issuingAuthority: one.issuing_authority, amountVnd: one.amount_vnd })),
      planYear: request.planYear,
    });
  }
}

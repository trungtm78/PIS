import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PrjProjectStore, TenantDatabase, planReadScope, projectScope } from '@machvon/db';
import { InvestmentProfileStore } from '@machvon/edition-enterprise/src/server.ts';
import type { InvestmentProfile } from '@machvon/edition-enterprise/src/server.ts';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const MIN_PLAN_YEAR = 2000;
const MAX_PLAN_YEAR = 2100;

/** The plan year of the query: a whole year within the range the plans of the register can have; absent, the year of today (Vietnam time). */
export function planYearOf(value: unknown, today: string): number {
  if (value === undefined) return Number(today.slice(0, 4));
  const year = typeof value === 'string' && /^\d{4}$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(year) || year < MIN_PLAN_YEAR || year > MAX_PLAN_YEAR) throw new DomainError('VALIDATION_FAILED', 422, 'plan_year');
  return year;
}

/** The profile as the contract names it (`ProjectInvestmentProfile`): snake_case, money as text, every key present. */
export function investmentProfileView(projectId: string, asOf: string, profile: InvestmentProfile): Record<string, unknown> {
  return {
    project_id: projectId,
    plan_year: profile.planYear,
    as_of: asOf,
    project_type: profile.projectType,
    start_flag: profile.startFlag,
    start_year: profile.startYear,
    start_year_basis: profile.startYearBasis,
    plans: profile.plans.map((one) => ({ plan_code: one.planCode, status: one.status, revision: one.revision })),
    milestones: profile.milestones.map((one) => ({
      code: one.code,
      label: one.label,
      sequence: one.sequence,
      phase: one.phase,
      required: one.required,
      evidence_kinds: [...one.evidenceKinds],
      state: one.state,
      planned_on: one.plannedOn,
      actual_on: one.actualOn,
    })),
    findings: profile.findings,
    origin_split: {
      total_vnd: profile.originSplit.totalVnd,
      group_assigned_vnd: profile.originSplit.groupAssignedVnd,
      board_approved_vnd: profile.originSplit.boardApprovedVnd,
      other_vnd: profile.originSplit.otherVnd,
      origins: profile.originSplit.origins.map((one) => ({
        origin: one.origin,
        amount_vnd: one.amountVnd,
        lines: one.lines,
        decisions: one.decisions.map((decision) => ({ kind: decision.kind, symbol: decision.symbol, issued_on: decision.issuedOn, authority: decision.authority })),
      })),
    },
  };
}

/**
 * The investment profile of one project of the enterprise edition (MD.01 type and flag of the stage, MD.02 milestones against the catalogue, CN.01 split of the plan between the resolution of the group and the decision of
 * the company). A read in the scope of the caller over the project: a project outside it is as absent as one that does not exist.
 */
@Controller('projects')
export class InvestmentProfileController {
  private readonly projects = new PrjProjectStore();
  private readonly profiles = new InvestmentProfileStore();

  private readonly database: TenantDatabase;

  constructor(@Inject(TenantDatabase) database: TenantDatabase) {
    this.database = database;
  }

  @Get(':id/investment-profile')
  @OperationId('getProjectInvestmentProfile')
  async get(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('plan_year') planYear?: unknown,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    const today = vietnamDateOf(now);
    const year = planYearOf(planYear, today);
    const profile = await this.database.withTenant(tenant, async (tx) => {
      const project = await this.projects.find(tx, id, projectScope(access, PERMISSIONS.getProjectInvestmentProfile, now));
      if (project === undefined) return undefined;
      // The revisions of a plan that are still in work are seen by who drafts or approves plans, as everywhere else in CAP.
      const { drafts } = planReadScope(access, PERMISSIONS.getProjectInvestmentProfile, now);
      return this.profiles.read(tx, { projectId: project.id, projectType: project.projectType, projectStartYear: project.startYear, planYear: year, today, drafts });
    });
    if (profile === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return investmentProfileView(id, today, profile);
  }
}

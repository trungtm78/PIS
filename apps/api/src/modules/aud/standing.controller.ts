import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditStandingStore, TenantDatabase } from '@machvon/db';
import type { InvestorStanding } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertWholeTenant, todayOf } from '../gov12-support';

const view = (unit: InvestorStanding): Record<string, unknown> => ({
  unit_id: unit.unitId,
  unit_code: unit.unitCode,
  unit_name: unit.unitName,
  follow_up_rank: unit.rank,
  score: unit.score,
  total: unit.total,
  open: unit.open,
  overdue: unit.overdue,
  disputed: unit.disputed,
  closed: unit.closed,
  closed_pct: unit.closedPct,
  owed_vnd: unit.owedVnd,
  // The position in the disbursement ranking is read beside the standing and never changes it, and it never changes the ranking.
  disbursement_rank: unit.disbursementRank,
  disbursement_rate_pct: unit.disbursementRatePct,
});

/**
 * The standing of the investors with the recommendations of the auditors (G4-10): the order in which follow-up should start, and the profile of one investor with its recommendations and its place in both orders. It is a standing
 * for follow-up, not a verdict; the red flags of procurement, which are confidential, are not in it. Whole tenant only.
 */
@Controller()
export class InvestorStandingReadsController {
  private readonly store = new AuditStandingStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private static rule(reading: { version: number; unverified: boolean; policy: { weight_overdue: number; weight_disputed: number; weight_open: number; money_step_vnd: string; weight_money: number } }): Record<string, unknown> {
    return { version: reading.version, unverified: reading.unverified, weights: { overdue: reading.policy.weight_overdue, disputed: reading.policy.weight_disputed, open: reading.policy.weight_open, money: reading.policy.weight_money }, money_step_vnd: reading.policy.money_step_vnd };
  }

  @Get('investor-standings')
  @OperationId('listInvestorStandings')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.listInvestorStandings);
    const today = todayOf(new Date());
    const reading = await this.database.withTenant(tenant, (tx) => this.store.standings(tx, today));
    return { as_of: today, ranking_as_of: reading.snapshotAsOf, rule: InvestorStandingReadsController.rule(reading.policy), items: reading.units.map(view) };
  }

  @Get('investor-standings/:unit_id')
  @OperationId('getInvestorProfile')
  async profile(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('unit_id', ParseUUIDPipe) unitId: string): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.getInvestorProfile);
    const today = todayOf(new Date());
    const found = await this.database.withTenant(tenant, (tx) => this.store.profile(tx, unitId.toLowerCase(), today));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'unit_id');
    return {
      as_of: today,
      ranking_as_of: found.snapshotAsOf,
      ranked_units: found.of,
      rule: InvestorStandingReadsController.rule(found.policy),
      ...view(found.standing),
      recommendations: found.recommendations.map((entry) => ({ id: entry.id, code: entry.recCode, type: entry.recType, status: entry.status, due_on: entry.dueOn, amount_vnd: entry.amountVnd, recovered_vnd: entry.recoveredVnd, project_id: entry.projectId, overdue: entry.overdue })),
    };
  }
}

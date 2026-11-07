import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CapContractAvcStore, TenantDatabase, contractScope, projectScope } from '@machvon/db';
import type { ContractAvcStatement, ProjectEacStatement } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const CONTRACT_READ = PERMISSIONS.getContractAvailability;
const EAC_READ = PERMISSIONS.getProjectEacControl;

function verdictView(verdict: { state: string; reason: string | null; consumptionPct: string; usedVnd: string; availableVnd: string } | null): Record<string, unknown> | null {
  return verdict === null ? null : { state: verdict.state, reason: verdict.reason, consumption_pct: verdict.consumptionPct, used_vnd: verdict.usedVnd, available_vnd: verdict.availableVnd };
}

/** The statement of a contract as openapi.json exposes it (x-exposure dto): an allowlist, so a column added later is not shown until it is listed here. */
export function contractAvailabilityView(statement: ContractAvcStatement): Record<string, unknown> {
  const { money, line } = statement;
  return {
    contract: { id: statement.contract.id, code: statement.contract.code, status: statement.contract.status, project_id: statement.contract.projectId },
    money: {
      current_price_vnd: money.currentPriceVnd,
      original_price_vnd: money.originalPriceVnd,
      approved_variation_vnd: money.approvedVariationVnd,
      pending_increase_vnd: money.pendingIncreaseVnd,
      requested_total_vnd: money.requestedTotalVnd,
      paid_total_vnd: money.paidTotalVnd,
      advance_outstanding_vnd: money.advanceOutstandingVnd,
      cash_out_vnd: money.cashOutVnd,
      remaining_payable_vnd: money.remainingPayableVnd,
      cash_headroom_vnd: money.cashHeadroomVnd,
      requested_pct: money.requestedPct,
      within_price: money.withinPrice,
    },
    line:
      line === null
        ? null
        : { allocation_line_id: line.allocationLineId, allocated_vnd: line.figures.allocatedVnd, reserved_vnd: line.figures.reservedVnd, committed_vnd: line.figures.committedVnd, disbursed_vnd: line.figures.disbursedVnd, contract_committed_vnd: line.committedVnd, contract_commits_within_line: line.contractCommitsWithinLine, verdict: verdictView(line.verdict) },
    change_orders: statement.changeOrders.map((change) => ({ id: change.id, code: change.code, status: change.status, delta_vnd: change.deltaVnd, allocation_line_id: change.allocationLineId, verdict: verdictView(change.verdict) })),
    as_of: statement.asOf,
  };
}

export function eacControlView(statement: ProjectEacStatement): Record<string, unknown> {
  return {
    project_id: statement.projectId,
    project_code: statement.projectCode,
    eac_vnd: statement.control.eacVnd,
    approved_total_vnd: statement.control.approvedTotalVnd,
    verdict: statement.control.verdict,
    over_by_vnd: statement.control.overByVnd,
    over_pct: statement.control.overPct,
    raises_alert: statement.control.raisesAlert,
    allocated_vnd: statement.allocatedVnd,
    funding_gap_vnd: statement.fundingGapVnd,
    method: statement.method,
    contract_count: statement.contractCount,
    policy: { version: statement.policy.version, source: statement.policy.source, eac_alert_above_pct: statement.policy.eacAlertAbovePct },
    as_of: statement.asOf,
  };
}

/**
 * The availability control extended down to the contract and its changes (governance deepening G1-6, CAP-17): the cumulative payments of a contract against the price in force, the capital line it commits
 * against and each change order against the line it would be paid from; and the estimate at completion of a project against its approved total investment. Reads only: the commands that move money keep
 * their own refusals, this is where a person sees why one of them refuses.
 */
@Controller()
export class ContractAvcController {
  private readonly avc = new CapContractAvcStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('contracts/:id/availability')
  @OperationId('getContractAvailability')
  async contract(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const statement = await this.database.withTenant(tenant, (tx) => this.avc.contractStatement(tx, id.toLowerCase(), contractScope(access, CONTRACT_READ, now), vietnamDateOf(now)));
    // A contract in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (statement === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return contractAvailabilityView(statement);
  }

  @Get('projects/:id/eac-control')
  @OperationId('getProjectEacControl')
  async eac(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const statement = await this.database.withTenant(tenant, (tx) => this.avc.eacStatement(tx, id.toLowerCase(), projectScope(access, EAC_READ, now), vietnamDateOf(now)));
    if (statement === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return eacControlView(statement);
  }
}

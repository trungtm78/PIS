import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PayAdvanceRecoveryReads, TenantDatabase, contractScope } from '@machvon/db';
import type { AdvancePolicyVersion, ContractAdvancePosition } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = PERMISSIONS.getAdvanceRecoveryTable;

/** The advances of a contract against what is left to pay, as openapi.json exposes it (x-exposure dto): an allowlist. */
export function advancePositionView(position: ContractAdvancePosition): Record<string, unknown> {
  return {
    contract_id: position.contractId,
    contract_code: position.contractCode,
    outstanding_vnd: position.outstandingVnd,
    remaining_payable_vnd: position.remainingPayableVnd,
    exceeds_remaining: position.exceedsRemaining,
    unrecoverable_vnd: position.unrecoverableVnd,
    current_price_vnd: position.money.currentPriceVnd,
    requested_total_vnd: position.money.requestedTotalVnd,
    paid_total_vnd: position.money.paidTotalVnd,
    final_payment_requires_full_recovery: position.finalPaymentRequiresFullRecovery,
    policy: { version: position.policy.version, source: position.policy.source, tolerance_vnd: position.policy.toleranceVnd },
  };
}

function policyView(version: AdvancePolicyVersion): Record<string, unknown> {
  return {
    version_id: version.versionId,
    advance_category: version.advanceCategory,
    revision: version.revision,
    valid_from: version.validFrom,
    valid_until: version.validUntil,
    in_force: version.inForce,
    legal_basis: version.legalBasis,
    // The cap is configuration with a flagged default, never a rule of the system: a screen that applies it says it still waits for confirmation.
    awaiting_confirmation: version.awaitingConfirmation,
    cxn: version.cxn,
    recovery_threshold_pct: version.recoveryThresholdPct,
    tiers: version.tiers.map((tier) => ({ min_value_vnd: tier.minValueVnd, cap_pct: tier.capPct })),
  };
}

/**
 * The recovery of an advance against what is left to pay (governance deepening G1-11, PAY-07, PAY-11, PAY-12): the planned recovery next to the actual one for each payment request that recovered, the
 * position of the contract (what is owed against the payments left to recover it, and whether the final payment waits for the recovery), and the policy of the cap as data with the days it is in force.
 * Reads only; the final payment is refused by `PayClaimStore` when it is sent.
 */
@Controller()
export class AdvanceRecoveryReadsController {
  private readonly reads = new PayAdvanceRecoveryReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('advances/:id/recovery-table')
  @OperationId('getAdvanceRecoveryTable')
  async table(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const found = await this.database.withTenant(tenant, (tx) => this.reads.table(tx, id.toLowerCase(), contractScope(access, READ_PERMISSION, now), vietnamDateOf(now)));
    // An advance in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const { advance } = found;
    return {
      advance: {
        id: advance.id,
        status: advance.status,
        kind: advance.kind,
        tranche_no: advance.trancheNo,
        contract: { id: advance.contract.id, code: advance.contract.code },
        party: { id: advance.party.id, name: advance.party.name, work_value_vnd: advance.party.workValueVnd },
        paid_vnd: advance.paidVnd,
        recovered_vnd: advance.recoveredVnd,
        outstanding_vnd: advance.outstandingVnd,
        recovery_threshold_pct: advance.thresholdPct,
        cap_rule_awaiting_confirmation: advance.capRuleAwaitingConfirmation,
        cap_rule_cxn: advance.capRuleCxn,
      },
      rows: found.rows.map((row) => ({
        kind: row.kind,
        request_no: row.requestNo,
        on: row.on,
        at_pct: row.atPct,
        gross_cum_vnd: row.grossCumVnd,
        planned_recovered_vnd: row.plannedRecoveredVnd,
        actual_recovered_vnd: row.actualRecoveredVnd,
        behind_vnd: row.behindVnd,
      })),
      position: advancePositionView(found.position),
      formula: 'planned = floor(paid x min(1, gross to date / (threshold x work value of the member)))',
      as_of: found.asOf,
    };
  }

  @Get('contracts/:id/advance-position')
  @OperationId('getContractAdvancePosition')
  async position(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const found = await this.database.withTenant(tenant, (tx) => this.reads.positionOfContract(tx, id.toLowerCase(), contractScope(access, PERMISSIONS.getContractAdvancePosition, now), vietnamDateOf(now)));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { ...advancePositionView(found), as_of: now.toISOString() };
  }

  @Get('advance-policy')
  @OperationId('listAdvancePolicy')
  async policy(@CurrentTenant() tenant: TenantContext, @Query('as_of') asOf?: unknown): Promise<Record<string, unknown>> {
    const now = new Date();
    if (asOf !== undefined && (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf))) throw new DomainError('VALIDATION_FAILED', 422, 'as_of');
    const day = typeof asOf === 'string' ? asOf : vietnamDateOf(now);
    const versions = await this.database.withTenant(tenant, (tx) => this.reads.policy(tx, day));
    return { items: versions.map(policyView), as_of: day };
  }
}

import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { BidContractorHistoryReads, BidContractorStore, SCORECARD_READ_PERMISSION, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractorHistory } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

/** The history as the contract exposes it: an allowlist. */
export function historyView(history: ContractorHistory, now: Date): Record<string, unknown> {
  return {
    contractor: { id: history.contractor.id, legal_name: history.contractor.legalName },
    scorecards: history.scorecards.map((line) => ({
      id: line.id,
      contract_id: line.contractId,
      contract_code: line.contractCode,
      kind: line.kind,
      period_label: line.periodLabel,
      revision: line.revision,
      scores: line.scores,
      overall_score: line.overallScore,
      rating: line.rating,
      approved_at: line.approvedAt,
    })),
    approved_count: history.approvedCount,
    average_overall_score: history.averageOverallScore,
    contracts: history.contracts.map((contract) => ({ id: contract.id, code: contract.code, status: contract.status })),
    restrictions: history.restrictions.map((restriction) => ({
      id: restriction.id,
      kind: restriction.kind,
      source: restriction.source,
      effective_from: restriction.effectiveFrom,
      effective_until: restriction.effectiveUntil,
      in_force: restriction.inForce,
    })),
    restriction_in_force: history.restrictionInForce,
    as_of: now.toISOString(),
  };
}

/**
 * The history of a contractor for the evaluators of a bid (ST-BID-013, BID 3.1 F9, BID-14, BID-21): the scorecards of CTR that are approved and stand, the contracts they come from, and the restrictions on the
 * contractor with their source and validity. BID keeps no scorecard of its own. The scorecards and the contracts are those of the contracts the caller reads; a guest contractor reads none of it.
 */
@Controller()
export class ContractorHistoryController {
  private readonly contractors = new BidContractorStore();
  private readonly history = new BidContractorHistoryReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('contractors/:id/history')
  @OperationId('getContractorHistory')
  async read(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const found = await this.database.withSnapshot(tenant, async (tx) => {
      if ((await this.contractors.callerOf(tx, tenant.membershipId)).guest) throw new DomainError('SCOPE_DENIED', 403);
      return this.history.read(tx, id.toLowerCase(), contractScope(access, SCORECARD_READ_PERMISSION, now), now);
    });
    return historyView(found, now);
  }
}

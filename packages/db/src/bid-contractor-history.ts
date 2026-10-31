import { DomainError, vietnamDateOf } from '@machvon/kernel';
import { BidContractorStore } from './bid-contractor-store.ts';
import type { RestrictionRow } from './bid-contractor-store.ts';
import { CtrScorecardStore } from './ctr-scorecard-store.ts';
import type { EvaluationLine, ScorecardContract } from './ctr-scorecard-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The history of a contractor that the evaluators of a bid rely on (ST-BID-013, BID 3.1 F9, BID-14, BID-21). BID writes no scorecard of its own: the scorecards are those of CTR (`contractor_performance`) and only the
 * APPROVED ones that stand count (a draft, a submitted one and one replaced by a newer revision are not history). The scorecards and the contracts shown are those of the contracts the caller reads. The restrictions are
 * all of those of the contractor, with their source and validity and whether each applies today in Vietnamese time; the decision and the note stay with the register of contractors.
 */
export interface HistoryRestriction {
  id: string;
  kind: RestrictionRow['kind'];
  source: RestrictionRow['source'];
  effectiveFrom: string;
  effectiveUntil: string | null;
  inForce: boolean;
}

export interface ContractorHistory {
  contractor: { id: string; legalName: string };
  /** The approved scorecards that stand, the latest approval first. */
  scorecards: EvaluationLine[];
  /** How many approved scorecards there are in the scope of the caller: the list above is bounded. */
  approvedCount: number;
  /** The average of their overall scores, two decimals; null when there is none. */
  averageOverallScore: string | null;
  contracts: ScorecardContract[];
  restrictions: HistoryRestriction[];
  restrictionInForce: boolean;
}

export class BidContractorHistoryReads {
  private readonly contractors = new BidContractorStore();
  private readonly scorecards = new CtrScorecardStore();

  /** A contractor that does not exist in the tenant is 404; one with no contract in the scope of the caller has a history with no scorecard and no contract, and its restrictions. */
  async read(tx: TenantTx, contractorId: string, scope: ScopeBuilder, now: Date = new Date()): Promise<ContractorHistory> {
    const found = await tx.query<{ id: string; legal_name: string }>('select id, legal_name from machvon.contractor where id = $1::uuid', [contractorId]);
    const contractor = found[0];
    if (contractor === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const card = await this.scorecards.approvedHistory(tx, contractorId, scope);
    const today = vietnamDateOf(now);
    const restrictions = ((await this.contractors.restrictionsOf(tx, [contractorId])).get(contractorId) ?? []).map(
      (row): HistoryRestriction => ({
        id: row.id,
        kind: row.kind,
        source: row.source,
        effectiveFrom: row.effectiveFrom,
        effectiveUntil: row.effectiveUntil,
        inForce: row.effectiveFrom <= today && (row.effectiveUntil === null || row.effectiveUntil >= today),
      }),
    );
    return {
      contractor: { id: contractor.id, legalName: contractor.legal_name },
      scorecards: card.evaluations,
      approvedCount: card.approvedCount,
      averageOverallScore: card.averageOverallScore,
      contracts: card.contracts,
      restrictions,
      restrictionInForce: restrictions.some((restriction) => restriction.inForce),
    };
  }
}

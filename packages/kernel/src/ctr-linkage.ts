import { compareDecimal } from './decimal.ts';

/**
 * The coherence of what ties a contract to its project, its package and its contractor (G1-18, CTR 3.1, BID results): the contract is created from an awarded package of the same project and for the contractor that
 * won it (or one of the parties of the joint venture that won it), and its price stays within the award price unless a change order explains the difference. Those rules are enforced when the contract is made;
 * this is the read that proves they still hold on the record, so an auditor sees the chain and any break in it. Pure: the facts come in, findings come out.
 */

export const LINKAGE_CODES = ['PACKAGE_PROJECT_MISMATCH', 'PACKAGE_NOT_AWARDED', 'CONTRACTOR_NOT_WINNER', 'PRICE_ABOVE_AWARD', 'NO_PARTY_LEAD'] as const;
export type LinkageCode = (typeof LINKAGE_CODES)[number];

export interface LinkageFacts {
  contract: { projectId: string; packageId: string; contractorId: string; originalValueVnd: string; currentValueVnd: string; isJointVenture: boolean };
  /** The package the contract names; null when it cannot be read. */
  package: { projectId: string; code: string } | null;
  /** What the procurement result says: the winner and the award price; null when the package has no approved result. */
  award: { winnerContractorId: string; awardPriceVnd: string } | null;
  /** The contractors that are parties of the contract (the leader and the members of a joint venture), with their shares in percent. */
  parties: ReadonlyArray<{ contractorId: string; lead: boolean }>;
  /** The change orders that took effect raise the value above the original: the increase over the award price is explained by them. */
  effectiveChangeCount: number;
}

export interface LinkageFinding {
  code: LinkageCode;
  /** `ERROR` is a broken chain; `WARNING` is a difference somebody has to explain. */
  severity: 'ERROR' | 'WARNING';
  field: string;
}

export interface LinkageReading {
  ok: boolean;
  findings: LinkageFinding[];
  /** The original value of the contract less the award price (signed, whole dong); null without an award. */
  awardGapVnd: string | null;
}

export function judgeLinkage(facts: LinkageFacts): LinkageReading {
  const findings: LinkageFinding[] = [];
  if (facts.package === null || facts.package.projectId !== facts.contract.projectId) findings.push({ code: 'PACKAGE_PROJECT_MISMATCH', severity: 'ERROR', field: 'package_id' });
  if (facts.award === null) findings.push({ code: 'PACKAGE_NOT_AWARDED', severity: 'ERROR', field: 'package_id' });
  else {
    const winner = facts.award.winnerContractorId;
    const partyIds = new Set(facts.parties.map((party) => party.contractorId));
    const leadIsWinner = facts.contract.contractorId === winner;
    const winnerIsParty = facts.contract.isJointVenture && partyIds.has(winner);
    if (!leadIsWinner && !winnerIsParty) findings.push({ code: 'CONTRACTOR_NOT_WINNER', severity: 'ERROR', field: 'contractor_id' });
    // The first version may not be above the price that was awarded; a later version above it is the work of change orders, which carry their own tiers.
    if (compareDecimal(facts.contract.originalValueVnd, facts.award.awardPriceVnd) > 0) findings.push({ code: 'PRICE_ABOVE_AWARD', severity: 'WARNING', field: 'contract_value_vnd' });
  }
  if (facts.contract.isJointVenture && !facts.parties.some((party) => party.lead)) findings.push({ code: 'NO_PARTY_LEAD', severity: 'ERROR', field: 'parties' });
  const gap = facts.award === null ? null : (BigInt(facts.contract.originalValueVnd) - BigInt(facts.award.awardPriceVnd)).toString();
  return { ok: findings.every((finding) => finding.severity !== 'ERROR'), findings, awardGapVnd: gap };
}

import type { CheckRow, FinancialPeriodRow, IndependenceFindingRow, InterestRow, PackageControlRow } from '@machvon/db';
import { FINDING_DECISIONS, decisionFitsFinding } from '@machvon/kernel';
import type { IndependenceGate } from '@machvon/kernel';

/** What a screen needs of an interest of a person; the identity number of a relative is never here (only that one was given). */
export const interestDto = (row: InterestRow): Record<string, unknown> => ({
  id: row.id,
  membership_id: row.membershipId,
  member_name: row.memberName,
  kind: row.kind,
  related_name: row.relatedName,
  relation: row.relation,
  has_related_identity: row.hasRelatedIdentity,
  contractor_id: row.contractorId,
  contractor_name: row.contractorName,
  tax_head: row.taxHead,
  share_pct: row.sharePct,
  since_on: row.sinceOn,
  ended_on: row.endedOn,
  ended_reason: row.endedReason,
  document_id: row.documentId,
  created_by: row.createdBy,
  version: row.version,
});

export const checkDto = (row: CheckRow): Record<string, unknown> => ({
  id: row.id,
  run_by: row.runBy,
  run_at: row.runAt,
  rule_version: row.ruleVersion,
  rule_unverified: row.ruleUnverified,
  inputs_digest: row.inputsDigest,
  panel_ids: row.panelIds,
  staff_ids: row.staffIds,
  owner_tax_head: row.ownerTaxHead,
  bidders_count: row.biddersCount,
  findings_count: row.findingsCount,
  strong_count: row.strongCount,
});

/** A finding as a screen shows it, with the decisions that fit it and whether the caller may decide it now (another person than the one who raised it and the one who ran the check). */
export const findingDto = (row: IndependenceFindingRow, caller: { membershipId: string; mayDecide: boolean }, runBy: string): Record<string, unknown> => ({
  id: row.id,
  check_id: row.checkId,
  fingerprint: row.fingerprint,
  kind: row.kind,
  strength: row.strength,
  parties: row.parties.map((party, index) => ({ kind: party.kind, id: party.id, name: row.partyNames[index] ?? null })),
  evidence: row.evidence,
  raised_by: row.raisedBy,
  carried_from_id: row.carriedFromId,
  decision: row.decision,
  decided_by: row.decidedBy,
  decided_at: row.decidedAt,
  decision_reason: row.decisionReason,
  allowed_decisions: FINDING_DECISIONS.filter((decision) => decisionFitsFinding(row.kind, decision)),
  can_decide: caller.mayDecide && row.decision === null && caller.membershipId !== row.raisedBy && caller.membershipId !== runBy,
  version: row.version,
});

export const gateDto = (gate: IndependenceGate | undefined): Record<string, unknown> =>
  gate === undefined
    ? { checked: false, open: true, blocked: 0, undecided_strong: 0, undecided: 0, cleared: 0, recused: 0 }
    : { checked: true, open: gate.open, blocked: gate.blocked, undecided_strong: gate.undecidedStrong, undecided: gate.undecided, cleared: gate.cleared, recused: gate.recused };

export const periodDto = (row: FinancialPeriodRow): Record<string, unknown> => ({
  id: row.id,
  fiscal_year: row.year,
  revenue: row.revenue,
  total_assets: row.totalAssets,
  current_assets: row.currentAssets,
  current_liabilities: row.currentLiabilities,
  total_debt: row.totalDebt,
  equity: row.equity,
  ebit: row.ebit,
  interest_expense: row.interestExpense,
  document_id: row.documentId,
  verified: row.verified,
  verified_by: row.verifiedBy,
  verified_at: row.verifiedAt,
  created_by: row.createdBy,
  version: row.version,
  ratios: { current_ratio: row.ratios.currentRatio, debt_to_assets_pct: row.ratios.debtToAssetsPct, interest_cover: row.ratios.interestCover, equity_to_assets_pct: row.ratios.equityToAssetsPct },
});

export const controlsDto = (row: PackageControlRow): Record<string, unknown> => ({
  package_id: row.packageId,
  security_base_amount: row.securityBaseAmount,
  bid_valid_until: row.bidValidUntil,
  estimated_value: row.estimatedValue,
  duration_months: row.durationMonths,
  budget_vnd: row.budgetVnd,
  version: row.version,
});

import type { PackageLine, PlanLine } from '@machvon/db';

/**
 * A plan as the lists show it: an explicit allowlist, so a column added to the table reaches no screen until it is named here. The people
 * behind the plan (maker, submitter, approver) are not in it: who decided is in the audit trail, not on a screen of the plans.
 */
export function planView(line: PlanLine): Record<string, unknown> {
  return {
    id: line.id,
    project: { id: line.project.id, code: line.project.code, name: line.project.name, status: line.project.status },
    revision: line.revision,
    title: line.title,
    legal_basis: line.legalBasis,
    total_value_vnd: line.totalVnd,
    status: line.status,
    supersedes_id: line.supersedesId,
    decision_document: line.decisionDocument === null ? null : { id: line.decisionDocument.id, symbol: line.decisionDocument.symbol, issued_on: line.decisionDocument.issuedOn },
    approved_at: line.approvedAt,
    package_count: line.packageCount,
    last_decision: line.lastDecision === null ? null : { decision: line.lastDecision.kind, comment: line.lastDecision.comment, decided_at: line.lastDecision.decidedAt },
    version: line.version,
  };
}

/** A package as the lists show it, with the plan it belongs to and the fund source that pays for it. */
export function packageView(line: PackageLine): Record<string, unknown> {
  return {
    id: line.id,
    code: line.code,
    title: line.title,
    project: { id: line.project.id, code: line.project.code, name: line.project.name, status: line.project.status },
    plan: line.plan === null ? null : { id: line.plan.id, revision: line.plan.revision, status: line.plan.status },
    budget_vnd: line.budgetVnd,
    method: line.method,
    contract_type: line.contractType,
    bidding_form: line.biddingForm,
    allocation_line_id: line.allocationLineId,
    fund_source: line.fundSource === null ? null : { business_key: line.fundSource.businessKey, label: line.fundSource.label },
    planned_start_period: line.plannedStartPeriod,
    duration_days: line.durationDays,
    status: line.status,
    approved_decision_id: line.approvedDecisionId,
    version: line.version,
  };
}

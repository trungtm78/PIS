import type { CapitalPlanListRow, PlanLineRow, PlanProjectRow, PlanTotals } from '@machvon/db';

const IN_WORK: readonly string[] = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED'];

function totalsView(totals: PlanTotals): Record<string, unknown> {
  return { line_count: totals.lineCount, allocated_vnd: totals.allocatedVnd, ctmtqg_subset_vnd: totals.ctmtqgSubsetVnd, ceiling_vnd: totals.ceilingVnd };
}

/**
 * A plan revision as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not shown until it is
 * listed here. The totals are those of the lines the caller may see; the decision document is shown by its citation (symbol and date).
 */
export function planView(plan: CapitalPlanListRow): Record<string, unknown> {
  return {
    id: plan.id,
    plan_code: plan.planCode,
    plan_kind: plan.planKind,
    plan_year: plan.planYear,
    period_from_year: plan.periodFromYear,
    period_to_year: plan.periodToYear,
    scope_unit: { id: plan.scopeUnit.id, name: plan.scopeUnit.name },
    revision: plan.revision,
    status: plan.status,
    decision_document: plan.decisionDocumentId === null ? null : { id: plan.decisionDocumentId, symbol: plan.decisionSymbol, issued_on: plan.decisionIssuedOn },
    supersedes_id: plan.supersedesId,
    effective_at: plan.effectiveAt,
    published_at: plan.publishedAt,
    submitted_at: plan.submittedAt,
    decided_at: plan.decidedAt,
    // The reason of a decision is for the circle that drafts and approves the revision; a published or superseded plan does not carry it.
    decision_reason: IN_WORK.includes(plan.status) ? plan.decisionReason : null,
    totals: totalsView(plan.totals),
    fund_sources: plan.fundSources.map((source) => ({ version_id: source.versionId, business_key: source.businessKey, label: source.label })),
    version: plan.version,
  };
}

export function planProjectView(row: PlanProjectRow): Record<string, unknown> {
  return { project_id: row.projectId, project_code: row.projectCode, project_name: row.projectName, line_count: row.lineCount, allocated_vnd: row.allocatedVnd };
}

/**
 * A line of a plan: the project, the source it draws on with what that source has left, the amount (the part that is CTMTQG is inside it, never
 * added), the carry-over facts, and the balance once the plan is published. Amounts are decimal strings in whole VND.
 */
export function lineView(row: PlanLineRow): Record<string, unknown> {
  return {
    id: row.id,
    capital_plan_id: row.capitalPlanId,
    plan_code: row.planCode,
    plan_status: row.planStatus,
    project: { id: row.project.id, code: row.project.code, name: row.project.name },
    fund_source: { version_id: row.fundSource.versionId, business_key: row.fundSource.businessKey, label: row.fundSource.label, category: row.fundSource.category },
    appropriation:
      row.appropriation === null
        ? null
        : {
            id: row.appropriation.id,
            plan_year: row.appropriation.planYear,
            amount_vnd: row.appropriation.amountVnd,
            allocated_total_vnd: row.appropriation.allocatedTotalVnd,
            remaining_vnd: row.appropriation.remainingVnd,
          },
    bucket: row.bucket,
    source_year: row.sourceYear,
    amount_vnd: row.amountVnd,
    ctmtqg_subset_vnd: row.ctmtqgSubsetVnd,
    budget_level: row.budgetLevel,
    origin: row.origin,
    is_extended: row.isExtended,
    extended_to: row.extendedTo,
    extension_document: row.extensionDocument === null ? null : { id: row.extensionDocument.id, symbol: row.extensionDocument.symbol, issued_on: row.extensionDocument.issuedOn },
    program: row.program === null ? null : { version_id: row.program.versionId, business_key: row.program.businessKey, label: row.program.label },
    previous_line_id: row.previousLineId,
    committed_vnd: row.committedVnd,
    reserved_vnd: row.reservedVnd,
    disbursed_vnd: row.disbursedVnd,
    version: row.version,
  };
}

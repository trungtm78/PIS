import type { GroupSuggestion, MasterLabel, ProjectDetail, ProjectListRow } from '@machvon/db';

function masterView(label: MasterLabel | null): Record<string, unknown> | null {
  return label === null ? null : { version_id: label.versionId, business_key: label.businessKey, label: label.label };
}

function suggestionView(suggestion: GroupSuggestion | null): Record<string, unknown> | null {
  if (suggestion === null) return null;
  return {
    group_key: suggestion.groupKey,
    sector_key: suggestion.sectorKey,
    as_of: suggestion.asOf,
    rule_version_id: suggestion.ruleVersionId,
    rule_revision: suggestion.ruleRevision,
    legal_basis: suggestion.legalBasis,
    awaiting_confirmation: suggestion.awaitingConfirmation,
    cxn: suggestion.cxn,
  };
}

/**
 * The line of the register as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not
 * shown until it is listed here. The national code, the stage and the leader in charge are the same for the web list and the mobile screens.
 */
export function projectLineView(row: ProjectListRow): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    owner_unit_id: row.ownerUnitId,
    owner_unit_name: row.ownerUnitName,
    investor_unit_id: row.investorUnitId,
    investor_unit_name: row.investorUnitName,
    project_group: row.projectGroup,
    status: row.status,
    national_project_code: row.nationalProjectCode,
    leader_in_charge: row.leader === null ? null : { membership_id: row.leader.membershipId, display_name: row.leader.displayName },
    version: row.version,
  };
}

/** The workspace of one project: the line, the master data it names by the version chosen, the money as a decimal string and the group suggestion. */
export function projectDetailView(detail: ProjectDetail, suggestion: GroupSuggestion | null): Record<string, unknown> {
  return {
    ...projectLineView(detail),
    decision_authority_unit_id: detail.decisionAuthorityUnitId,
    decision_authority_unit_name: detail.decisionAuthorityUnitName,
    area: masterView(detail.area),
    sector: masterView(detail.sector),
    project_type: masterView(detail.projectType),
    program: masterView(detail.program),
    classification: detail.classification,
    total_investment_vnd: detail.totalInvestmentVnd,
    start_year: detail.startYear,
    end_year: detail.endYear,
    appraisal_score: detail.appraisalScore,
    pipeline_priority: detail.pipelinePriority,
    status_changed_at: detail.statusChangedAt,
    created_at: detail.createdAt,
    proposed_on: detail.proposedOn,
    group_suggestion: suggestionView(suggestion),
  };
}

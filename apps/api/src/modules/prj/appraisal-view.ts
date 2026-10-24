import type { AppraisalOverview, AppraisalSheetView } from '@machvon/db';

function sheetView(sheet: AppraisalSheetView, viewer: string): Record<string, unknown> {
  return {
    id: sheet.id,
    version: sheet.version,
    round: sheet.round,
    status: sheet.status,
    mine: sheet.appraiserMembershipId.toLowerCase() === viewer.toLowerCase(),
    appraiser: { membership_id: sheet.appraiserMembershipId, display_name: sheet.appraiserName },
    scores: sheet.scores.map((entry) => ({ criterion_code: entry.criterionCode, score: entry.score, evidence_ids: entry.evidenceIds })),
    total_score: sheet.totalScore,
    recommendation: sheet.recommendation,
    note: sheet.note,
    decision: sheet.decision,
    decided_at: sheet.decidedAt,
    updated_at: sheet.updatedAt,
  };
}

/**
 * The appraisal of a project as the lifecycle read exposes it (PRJ-10, PRJ-15), an explicit allowlist: the set of criteria to score against
 * with the weights and the threshold (and the confirmation they still wait for), the sheets the caller may see, and for a decision maker the
 * mean of the sheets, what the threshold recommends and which decisions would need an override reason. The total of a sheet is the server's.
 */
export function appraisalView(overview: AppraisalOverview, viewer: string): Record<string, unknown> {
  const { criteriaSet, summary, decisionTarget } = overview;
  return {
    round: overview.round,
    project_status: overview.status,
    viewer_is_proposer: overview.viewerIsProposer,
    can_record: overview.canRecord,
    can_decide: overview.canDecide,
    criteria_set:
      criteriaSet === null
        ? null
        : {
            version_id: criteriaSet.reading.versionId,
            key: criteriaSet.reading.businessKey,
            revision: criteriaSet.reading.revision,
            valid_from: criteriaSet.reading.validFrom,
            legal_basis: criteriaSet.reading.legalBasis,
            awaiting_confirmation: criteriaSet.reading.awaitingConfirmation,
            cxn: criteriaSet.reading.cxn,
            pass_threshold: criteriaSet.passThreshold,
            criteria: criteriaSet.criteria.map((criterion) => ({ code: criterion.code, name: criterion.name, weight: criterion.weight })),
          },
    sheets: overview.sheets.map((sheet) => sheetView(sheet, viewer)),
    summary:
      summary === null
        ? null
        : { sheet_count: summary.sheetCount, mean_score: summary.meanScore, threshold_recommendation: summary.thresholdRecommendation, override_required: summary.overrideRequired },
    decision_target: decisionTarget,
  };
}

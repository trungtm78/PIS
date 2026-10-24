import type { QualityRuleRow, QualityRunRow, QualityScorecard, QualityScorecardDimension, QualityScorecardRule } from '@machvon/db';

/**
 * The views of the quality rules, runs and scorecards: explicit allowlists of what a reader is given. The rows that the runs found failing are
 * not among them (the opaque keys stay in the result table for the follow-up of the exceptions), and neither is any value of a row of the data.
 */

export function ruleViewOf(row: QualityRuleRow): Record<string, unknown> {
  return {
    id: row.id,
    contract_id: row.contractId,
    dataset_id: row.datasetId,
    dataset_code: row.datasetCode,
    code: row.code,
    revision: row.revision,
    dimension: row.dimension,
    field_path: row.fieldPath,
    expression_ast: row.expressionAst,
    severity: row.severity,
    threshold_json: row.thresholdJson,
    action_on_fail: row.actionOnFail,
    criticality_weight: row.criticalityWeight,
    status: row.status,
    created_by: row.createdBy,
    created_by_name: row.createdByName,
    approved_by: row.approvedBy,
    approved_by_name: row.approvedByName,
    approved_at: row.approvedAt,
    created_at: row.createdAt,
    version: row.version,
  };
}

export function runViewOf(row: QualityRunRow): Record<string, unknown> {
  return {
    id: row.id,
    dataset_id: row.datasetId,
    dataset_code: row.datasetCode,
    dataset_contract_id: row.datasetContractId,
    snapshot_id: row.snapshotId,
    trigger: row.trigger,
    status: row.status,
    overall_result: row.overallResult,
    score: row.score,
    hard_fail: row.hardFail,
    certified_blocked: row.certifiedBlocked,
    failure_code: row.failureCode,
    rule_count: row.ruleCount,
    passed_count: row.passedCount,
    failed_count: row.failedCount,
    quarantined_count: row.quarantinedCount,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
  };
}

function scorecardRuleView(rule: QualityScorecardRule): Record<string, unknown> {
  return {
    rule_version_id: rule.ruleVersionId,
    code: rule.code,
    revision: rule.revision,
    dimension: rule.dimension,
    severity: rule.severity,
    action_on_fail: rule.actionOnFail,
    criticality_weight: rule.criticalityWeight,
    field_path: rule.fieldPath,
    evaluated_count: rule.evaluatedCount,
    passed_count: rule.passedCount,
    failed_count: rule.failedCount,
    quarantined_count: rule.quarantinedCount,
    measured_value: rule.measuredValue,
    threshold: rule.thresholdSnapshot,
    result: rule.result,
    error_code: rule.errorCode,
    incident_id: rule.incidentId,
  };
}

const dimensionView = (dimension: QualityScorecardDimension): Record<string, unknown> => ({
  dimension: dimension.dimension,
  assessed: dimension.assessed,
  score: dimension.score,
  rules_total: dimension.rulesTotal,
  rules_failed: dimension.rulesFailed,
});

/**
 * The scorecard of a dataset. `badge` and `score` are those of the latest finished run: NOT_ASSESSED with a null score when none has finished,
 * STALE once it is older than the freshness SLO. `snapshot_id` is the frozen snapshot that run read, `snapshot_as_of` the instant that
 * snapshot's figures are as of, and `as_of` the instant this answer was read. A run that is waiting or that could not be measured is shown as
 * `pending_attempt`, never in place of the result.
 */
export function scorecardViewOf(card: QualityScorecard, now: Date): Record<string, unknown> {
  const { dataset, latestRun } = card;
  return {
    dataset_id: dataset.id,
    dataset_code: dataset.datasetCode,
    title: dataset.title,
    domain: dataset.domain,
    producer_module: dataset.producerModule,
    is_critical: dataset.isCritical,
    badge: dataset.qualityBadge,
    assessed: latestRun !== null,
    score: dataset.qualityScore,
    hard_fail: dataset.qualityHardFail,
    certified_blocked: latestRun === null ? null : latestRun.certifiedBlocked,
    freshness: { slo_seconds: dataset.freshnessSloSeconds, age_seconds: card.ageSeconds },
    snapshot_id: latestRun === null ? null : latestRun.snapshotId,
    snapshot_as_of: latestRun === null ? null : latestRun.snapshotAsOf,
    definition_status: latestRun === null ? null : latestRun.definitionStatus,
    as_of: now.toISOString(),
    latest_run: latestRun === null ? null : { ...runViewOf(latestRun), snapshot_as_of: latestRun.snapshotAsOf, definition_status: latestRun.definitionStatus },
    pending_attempt: card.pendingAttempt === null ? null : runViewOf(card.pendingAttempt),
    dimensions: card.dimensions.map(dimensionView),
    rules: card.rules.map(scorecardRuleView),
    open_incidents: card.openIncidents,
    overdue_incidents: card.overdueIncidents,
  };
}

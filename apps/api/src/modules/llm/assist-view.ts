import type { AssistDecisionRow, AssistRunRow, ChecklistRow, CriteriaSetRow, ExceptionRow, ExceptionUseRow, ReadableSource } from '@machvon/db';
import type { CheckedStatement } from '@machvon/kernel';

/** What a screen reads of a run: the statements as verified for this reader, the sources they may still open, and the decision of the person if there is one; never the hash of the input or the request of the gateway. */
export interface RunViewParts {
  statements: readonly CheckedStatement[];
  result: unknown;
  sources: readonly ReadableSource[];
  withheld: number;
  decision: AssistDecisionRow | undefined;
}

const countOf = (statements: readonly CheckedStatement[], verification: CheckedStatement['verification']): number => statements.filter((statement) => statement.verification === verification).length;

export function decisionView(decision: AssistDecisionRow): Record<string, unknown> {
  return {
    id: decision.id,
    decision: decision.decision,
    rationale: decision.rationale,
    items: decision.items,
    accepted_result: decision.acceptedResult,
    ai_decision_record_id: decision.aiDecisionRecordId,
    decided_by: decision.decidedBy,
    decided_at: decision.decidedAt,
  };
}

export function runView(run: AssistRunRow, parts: RunViewParts): Record<string, unknown> {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    refusal_code: run.refusalCode,
    advisory: true,
    request_text: run.requestText,
    subject_id: run.subjectId,
    checklist_id: run.checklistId,
    criteria_set_id: run.criteriaSetId,
    ai_request_id: run.aiRequestId,
    data_classification: run.dataClassification,
    route_class: run.routeClass,
    sources: parts.sources.map((source) => ({ kind: source.kind, id: source.id, title: source.title, classification: source.classification })),
    statements: parts.statements,
    result: parts.result,
    counts: {
      statements: parts.statements.length,
      verified: countOf(parts.statements, 'VERIFIED'),
      unsupported: countOf(parts.statements, 'UNSUPPORTED'),
      assumptions: countOf(parts.statements, 'ASSUMPTION_OPEN'),
      withheld_citations: run.withheldCitationCount + parts.withheld,
      injection_signals: run.injectionSignalCount,
    },
    completeness: run.completeness,
    decision: parts.decision === undefined ? null : decisionView(parts.decision),
    decision_status: parts.decision?.decision ?? null,
    asked_by: run.askedBy,
    created_at: run.createdAt,
  };
}

/** A row of the history of runs: the figures and the state of the decision, without the statements (the screen of the run has them, verified for the reader at that moment). */
export function runListView(run: AssistRunRow, decided: AssistDecisionRow['decision'] | undefined): Record<string, unknown> {
  return {
    ...runView(run, { statements: [], result: {}, sources: [], withheld: 0, decision: undefined }),
    counts: {
      statements: run.statementCount,
      verified: run.verifiedCount,
      unsupported: run.unsupportedCount,
      assumptions: run.statementCount - run.verifiedCount - run.unsupportedCount,
      withheld_citations: run.withheldCitationCount,
      injection_signals: run.injectionSignalCount,
    },
    decision_status: decided ?? null,
  };
}

export function checklistView(row: ChecklistRow): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    revision: row.revision,
    title: row.title,
    applies_to: row.appliesTo,
    status: row.status,
    items: row.items.map((item) => ({ code: item.code, label: item.label, kind: item.kind, severity: item.severity, params: item.params })),
    created_by: row.createdBy,
    created_at: row.createdAt,
    published_by: row.publishedBy,
    published_at: row.publishedAt,
    version: row.version,
  };
}

export function criteriaSetView(row: CriteriaSetRow): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    revision: row.revision,
    title: row.title,
    scale_max: row.scaleMax,
    status: row.status,
    criteria: row.criteria.map((criterion) => ({ code: criterion.code, label: criterion.label, guidance: criterion.guidance, weight_bp: criterion.weightBp, evidence_required: criterion.evidenceRequired })),
    weights_total_bp: row.criteria.reduce((sum, criterion) => sum + criterion.weightBp, 0),
    created_by: row.createdBy,
    created_at: row.createdAt,
    published_by: row.publishedBy,
    published_at: row.publishedAt,
    version: row.version,
  };
}

export function exceptionView(row: ExceptionRow, now: Date, uses?: readonly ExceptionUseRow[]): Record<string, unknown> {
  const inForce = row.status === 'APPROVED' && row.validFrom !== null && row.validUntil !== null && new Date(row.validFrom).getTime() <= now.getTime() && now.getTime() < new Date(row.validUntil).getTime();
  return {
    id: row.id,
    provider_id: row.providerId,
    provider_code: row.providerCode,
    route_class: row.routeClass,
    task_type: row.taskType,
    max_classification: row.maxClassification,
    reason: row.reason,
    requested_by: row.requestedBy,
    requested_at: row.requestedAt,
    requested_valid_days: row.requestedValidDays,
    status: row.status,
    in_force: inForce,
    decided_by: row.decidedBy,
    decided_at: row.decidedAt,
    decision_note: row.decisionNote,
    approval_ref: row.approvalRef,
    valid_from: row.validFrom,
    valid_until: row.validUntil,
    revoked_by: row.revokedBy,
    revoked_at: row.revokedAt,
    revoke_reason: row.revokeReason,
    use_count: row.useCount,
    ...(uses === undefined
      ? {}
      : { uses: uses.map((use) => ({ id: use.id, ai_request_id: use.aiRequestId, task_type: use.taskType, data_classification: use.dataClassification, route_class: use.routeClass, used_at: use.usedAt })) }),
    version: row.version,
  };
}

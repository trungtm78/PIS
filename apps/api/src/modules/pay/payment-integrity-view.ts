import { PAYMENT_INTEGRITY_CODE, PAYMENT_INTEGRITY_TYPE, provenanceOf } from '@machvon/kernel';
import type { DisbursementException, IntegrityFindingLine, IntegrityRunView } from '@machvon/db';

/** The run as the approver and the auditor read it: the rule that decided (with where its numbers come from and whether anyone confirmed them), the day, what was found and what could not be read. */
export function runView(run: IntegrityRunView): Record<string, unknown> {
  const provenance = provenanceOf(PAYMENT_INTEGRITY_TYPE, PAYMENT_INTEGRITY_CODE);
  return {
    id: run.id,
    trigger: run.trigger,
    outcome: run.outcome,
    rule: {
      type: PAYMENT_INTEGRITY_TYPE,
      code: PAYMENT_INTEGRITY_CODE,
      version: run.ruleVersion,
      source: run.ruleSource,
      unverified: run.ruleUnverified,
      params: run.ruleParams,
      formula: provenance?.formula ?? null,
      origin: provenance?.source ?? null,
      as_of: provenance?.asOf ?? null,
    },
    as_of: run.asOf,
    invariant_count: run.invariantCount,
    signal_count: run.signalCount,
    excused_count: run.excusedCount,
    unavailable: run.unavailable,
    figures: run.figures,
    created_by: run.createdBy,
    created_at: run.createdAt,
    findings: run.findings.map((one) => ({ id: one.id, code: one.code, kind: one.kind, severity: one.severity, excused: one.excused, exception_id: one.exceptionId, subject: one.subject, params: one.params })),
  };
}

export const findingLineView = (line: IntegrityFindingLine): Record<string, unknown> => ({
  id: line.id,
  run_id: line.runId,
  payment_request_id: line.paymentRequestId,
  request_no: line.requestNo,
  contract_id: line.contractId,
  contract_code: line.contractCode,
  project_code: line.projectCode,
  code: line.code,
  kind: line.kind,
  severity: line.severity,
  excused: line.excused,
  exception_id: line.exceptionId,
  subject: line.subject,
  params: line.params,
  trigger: line.trigger,
  outcome: line.outcome,
  rule_version: line.ruleVersion,
  created_at: line.createdAt,
});

export const exceptionView = (item: DisbursementException): Record<string, unknown> => ({
  id: item.id,
  payment_request_id: item.paymentRequestId,
  request_no: item.requestNo,
  contract_id: item.contractId,
  contract_code: item.contractCode,
  ceiling: item.ceiling,
  allowed_amount_vnd: item.allowedAmountVnd,
  valid_to: item.validTo,
  reason: item.reason,
  status: item.view,
  stored_status: item.status,
  requested_by: item.requestedBy,
  requested_at: item.requestedAt,
  decided_by: item.decidedBy,
  decided_at: item.decidedAt,
  decision_note: item.decisionNote,
  used_at: item.usedAt,
  days_left: item.daysLeft,
  version: item.version,
});

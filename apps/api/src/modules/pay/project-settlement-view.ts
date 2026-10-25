import type { SettlementView } from '@machvon/db';
import { hasOutstanding, isSettlementEditable } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { reaches, refsOf } from '../ctr/contract.controller';

export interface SettlementPermissions {
  open: string;
  submit: string;
  verify: string;
  exception: string;
  close: string;
  /** The right to read the conclusions of AUD, which the references of a verification point to. */
  findings: string;
}

export interface SettlementActions {
  refresh: boolean;
  submit: boolean;
  take_up: boolean;
  verify: boolean;
  return: boolean;
  approve_exception: boolean;
  close: boolean;
}

/**
 * What the caller may do with the settlement as it stands: the right over the project, the state it is in, and the people it keeps apart (whoever sent it does not verify it; whoever opened or sent it
 * neither approves its exception nor closes it). A button is shown for exactly these; the server judges each command again.
 */
export function settlementActionsOf(view: SettlementView, access: EffectiveAccess, now: Date, permissions: SettlementPermissions, viewer: string): SettlementActions {
  const refs = refsOf(view.reach, view.reach.projectId);
  const is = (person: string | null): boolean => person !== null && person.toLowerCase() === viewer.toLowerCase();
  const prepared = is(view.createdBy) || is(view.submittedBy);
  const owes = hasOutstanding({ outstandingVnd: view.outstandingVnd, unrecoveredAdvanceVnd: view.unrecoveredAdvanceVnd });
  const checker = reaches(access, permissions.verify, refs, now) && !is(view.submittedBy);
  return {
    refresh: isSettlementEditable(view.status) && reaches(access, permissions.open, refs, now),
    submit: isSettlementEditable(view.status) && reaches(access, permissions.submit, refs, now),
    take_up: view.status === 'SUBMITTED' && checker,
    verify: view.status === 'VERIFYING' && checker,
    return: (view.status === 'SUBMITTED' || view.status === 'VERIFYING') && checker,
    approve_exception: view.status === 'VERIFIED' && owes && view.exceptionApprovedAt === null && reaches(access, permissions.exception, refs, now) && !prepared,
    close: view.status === 'VERIFIED' && (!owes || view.exceptionApprovedAt !== null) && reaches(access, permissions.close, refs, now) && !prepared,
  };
}

/**
 * A settlement as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not shown until it is listed here. The references to the conclusions of AUD are
 * shown only to who may read AUD.
 */
export function settlementView(view: SettlementView, actions: SettlementActions, canSeeFindings: boolean): Record<string, unknown> {
  return {
    id: view.id,
    project: { id: view.projectId, code: view.projectCode, name: view.projectName },
    contract: view.contractId === null ? null : { id: view.contractId, code: view.contractCode },
    settlement_scope: view.scope,
    fiscal_year: view.fiscalYear,
    revision: view.revision,
    status: view.status,
    settled_amount_vnd: view.settledAmountVnd,
    outstanding_vnd: view.outstandingVnd,
    unrecovered_advance_vnd: view.unrecoveredAdvanceVnd,
    figures_refreshed_at: view.figuresRefreshedAt,
    figures_note: view.figuresNote,
    project_group: view.projectGroup,
    submitted_on: view.submittedOn,
    submitted_by: view.submittedBy,
    submitted_at: view.submittedAt,
    verification_due_on: view.verificationDueOn,
    deadline_days: view.deadlineDays,
    deadline_rule_version_id: view.deadlineRuleVersionId,
    deadline_rule_awaiting_confirmation: view.deadlineRuleAwaitingConfirmation,
    verified_on: view.verifiedOn,
    verified_by: view.verifiedBy,
    verified_at: view.verifiedAt,
    verification_findings: view.verificationFindings,
    audit_finding_refs: canSeeFindings ? view.auditFindingRefs : null,
    exception_reason: view.exceptionReason,
    exception_approved_by: view.exceptionApprovedBy,
    exception_approved_at: view.exceptionApprovedAt,
    exception_approval_document_version_id: view.exceptionApprovalDocumentVersionId,
    decision_document_version_id: view.decisionDocumentVersionId,
    closed_by: view.closedBy,
    closed_at: view.closedAt,
    close_reason: view.closeReason,
    close_evidence_ids: view.closeEvidenceIds,
    supersedes_id: view.supersedesId,
    created_by: view.createdBy,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
    actions,
    version: view.version,
  };
}

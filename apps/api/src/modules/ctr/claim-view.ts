import type { ClaimDetail, ClaimListItem, ClaimStepRow, ClaimTermRow, ClaimTermTemplate, PolicyBasis } from '@machvon/db';
import type { ClaimReportTotals, Deadline, Limitation } from '@machvon/kernel';

/** The names of the people a page mentions, by membership id (an id with no name reads as null, never as a guess). */
export type Names = ReadonlyMap<string, string>;
export const nameOf = (names: Names, id: string | null | undefined): string | null => (id === null || id === undefined ? null : (names.get(id) ?? null));

/** The numbers of a rule as an "i" shows them: where they come from and whether anybody confirmed them. */
export function ruleBasisDto(basis: PolicyBasis): Record<string, unknown> {
  return { source: basis.source, version: basis.version, unverified: basis.unverified, formula: basis.formula, source_text: basis.sourceText, as_of: basis.asOf, legal_status: basis.legalStatus };
}

export function termDto(row: ClaimTermRow, names: Names, canDecide: boolean): Record<string, unknown> {
  return {
    id: row.id,
    contract_id: row.contractId,
    claimant_side: row.term.claimantSide,
    notice_days: row.term.noticeDays,
    particulars_days: row.term.particularsDays,
    response_days: row.term.responseDays,
    settlement_days: row.term.settlementDays,
    basis: row.term.basis,
    particulars_from: row.term.particularsFrom,
    bar_effect: row.term.barEffect,
    clause_reference: row.term.clauseReference,
    basis_document_version_id: row.basisDocumentVersionId,
    template_code: row.templateCode,
    status: row.status,
    decision_note: row.decisionNote,
    proposed_by_name: nameOf(names, row.proposedBy),
    proposed_at: row.proposedAt,
    decided_by_name: nameOf(names, row.decidedBy),
    decided_at: row.decidedAt,
    superseded_by_id: row.supersededById,
    can_decide: canDecide && row.status === 'PROPOSED',
    version: row.version,
  };
}

export const templateDto = (template: ClaimTermTemplate): Record<string, unknown> => ({
  code: template.code,
  notice_days: template.noticeDays,
  particulars_days: template.particularsDays,
  response_days: template.responseDays,
  settlement_days: template.settlementDays,
  basis: template.basis,
  particulars_from: template.particularsFrom,
  bar_effect: template.barEffect,
  rule: ruleBasisDto(template.basisOf),
});

export const deadlineDto = (deadline: Deadline): Record<string, unknown> => ({
  code: deadline.code,
  state: deadline.state,
  started_on: deadline.startedOn,
  due_on: deadline.dueOn,
  done_on: deadline.doneOn,
  days_left: deadline.daysLeft,
  period_days: deadline.periodDays,
  basis: deadline.basis,
  owed_by: deadline.owedBy,
  owed_by_owner: deadline.owedByOwner,
});

export const limitationDto = (limitation: Limitation): Record<string, unknown> => ({
  status: limitation.status,
  due_on: limitation.dueOn,
  code: limitation.code,
  days_left: limitation.daysLeft,
  bar_effect: limitation.barEffect,
  missed: limitation.missed,
});

export function claimLineDto(item: ClaimListItem, names: Names): Record<string, unknown> {
  const row = item.claim;
  return {
    id: row.id,
    code: row.code,
    contract: { id: row.contractId, code: row.contractCode },
    project_code: row.projectCode,
    claimant_side: row.claimantSide,
    kind: row.kind,
    title: row.title,
    status: row.status,
    awareness_on: row.awarenessOn,
    claimed_amount_vnd: row.claimedAmountVnd,
    claimed_days: row.claimedDays,
    settled_amount_vnd: row.settledAmountVnd,
    granted_days: row.grantedDays,
    has_term: row.termId !== null,
    limitation: limitationDto(item.limitation),
    open: item.open,
    responsible_name: nameOf(names, row.responsibleMembershipId),
    version: row.version,
  };
}

export function totalsDto(totals: ClaimReportTotals): Record<string, unknown> {
  return {
    count: totals.count,
    open: totals.open,
    by_status: totals.byStatus,
    by_side: totals.bySide,
    by_limitation: totals.byLimitation,
    claimed_vnd: totals.claimedVnd,
    settled_vnd: totals.settledVnd,
    open_claimed_vnd: totals.openClaimedVnd,
    claimed_days: totals.claimedDays,
    granted_days: totals.grantedDays,
    without_term: totals.withoutTerm,
  };
}

export const stepDto = (step: ClaimStepRow, names: Names): Record<string, unknown> => ({
  id: step.id,
  ordinal: step.ordinal,
  kind: step.kind,
  occurred_on: step.occurredOn,
  note: step.note,
  decision: step.decision,
  claimed_amount_vnd: step.claimedAmountVnd,
  claimed_days: step.claimedDays,
  settled_amount_vnd: step.settledAmountVnd,
  granted_days: step.grantedDays,
  evidence_document_version_id: step.evidenceDocumentVersionId,
  actor_name: nameOf(names, step.actorId),
  created_at: step.createdAt,
});

/** What the caller may do with a claim now: the steps its state allows, filtered by the rights the caller holds over the contract. */
export interface ClaimRights {
  manage: boolean;
  settle: boolean;
  bar: boolean;
}

export function claimDto(detail: ClaimDetail, names: Names, rights: ClaimRights, asOf: string, canDecideTerm: boolean): Record<string, unknown> {
  const row = detail.row;
  return {
    id: row.id,
    code: row.code,
    contract: { id: row.contractId, code: row.contractCode },
    project_code: row.projectCode,
    claimant_side: row.claimantSide,
    kind: row.kind,
    title: row.title,
    event_description: row.eventDescription,
    event_on: row.eventOn,
    awareness_on: row.awarenessOn,
    status: row.status,
    claimed_amount_vnd: row.claimedAmountVnd,
    claimed_days: row.claimedDays,
    settled_amount_vnd: row.settledAmountVnd,
    granted_days: row.grantedDays,
    notice_on: row.noticeOn,
    particulars_on: row.particularsOn,
    response_on: row.responseOn,
    response_decision: row.responseDecision,
    settled_on: row.settledOn,
    closed_on: row.closedOn,
    responsible_name: nameOf(names, row.responsibleMembershipId),
    registered_by_name: nameOf(names, row.registeredBy),
    settlement_proposed_by_name: nameOf(names, row.settlementProposedBy),
    settlement_approved_by_name: nameOf(names, row.settlementApprovedBy),
    term: detail.term === null ? null : termDto(detail.term, names, canDecideTerm),
    deadlines: { NOTICE: deadlineDto(detail.deadlines.NOTICE), PARTICULARS: deadlineDto(detail.deadlines.PARTICULARS), RESPONSE: deadlineDto(detail.deadlines.RESPONSE), SETTLEMENT: deadlineDto(detail.deadlines.SETTLEMENT) },
    limitation: limitationDto(detail.limitation),
    change_request: row.changeRequestId === null ? null : { id: row.changeRequestId, code: row.changeRequestCode },
    payment_request: detail.payment === null ? null : { id: detail.payment.id, status: detail.payment.status, gross_vnd: detail.payment.grossVnd, net_vnd: detail.payment.netVnd },
    steps: detail.steps.map((step) => stepDto(step, names)),
    allowed: {
      steps: rights.manage ? detail.allowed.steps : [],
      decide_settlement: rights.settle && detail.allowed.decideSettlement,
      declare_bar: rights.bar && detail.allowed.declareBar,
      link: rights.manage,
    },
    calendar_published: detail.calendarPublished,
    policy: ruleBasisDto(detail.policy),
    as_of: asOf,
    version: row.version,
  };
}

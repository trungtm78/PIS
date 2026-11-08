import type { useTranslation } from '../../../i18n';
import type { Tone } from '../../../ui';
import type { ActingPhase, ActingProblem, DelegationStatus, EndKind, Problem, RequestStatus, ReviewProblem, ScopeProblem, ScopeStatus, StandingProblem, actingRefusal } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function requestStatusLabel(t: Translate, status: RequestStatus): string {
  switch (status) {
    case 'Pending':
      return t('adm.authority.request.status.pending');
    case 'Approved':
      return t('adm.authority.request.status.approved');
    case 'Rejected':
      return t('adm.authority.request.status.rejected');
    case 'Cancelled':
      return t('adm.authority.request.status.cancelled');
    case 'Lapsed':
      return t('adm.authority.request.status.lapsed');
  }
}

export function requestStatusTone(status: RequestStatus): Tone {
  return status === 'Approved' ? 'success' : status === 'Pending' ? 'warning' : status === 'Rejected' ? 'danger' : 'neutral';
}

export function delegationStatusLabel(t: Translate, status: DelegationStatus): string {
  switch (status) {
    case 'Scheduled':
      return t('adm.authority.permanent.status.scheduled');
    case 'Active':
      return t('adm.authority.permanent.status.active');
    case 'Ended':
      return t('adm.authority.permanent.status.ended');
    case 'Revoked':
      return t('adm.authority.permanent.status.revoked');
  }
}

export function delegationStatusTone(status: DelegationStatus): Tone {
  return status === 'Active' ? 'success' : status === 'Scheduled' ? 'warning' : 'neutral';
}

export function endKindLabel(t: Translate, kind: EndKind): string {
  switch (kind) {
    case 'SOURCE_HOLDS':
      return t('adm.authority.end.kind.source');
    case 'UNTIL_EVENT':
      return t('adm.authority.end.kind.event');
    case 'UNTIL_DATE':
      return t('adm.authority.end.kind.date');
  }
}

export function endReasonLabel(t: Translate, reason: string | null): string {
  switch (reason) {
    case 'REVIEW_LAPSED':
      return t('adm.authority.end.reason.review');
    case 'END_CONDITION_MET':
      return t('adm.authority.end.reason.condition');
    case 'SOURCE_ENDED':
      return t('adm.authority.end.reason.source');
    case 'EXPIRED':
      return t('adm.authority.end.reason.expired');
    default:
      return '';
  }
}

export function scopeKindLabel(t: Translate, kind: string): string {
  switch (kind) {
    case 'UNIT_SUBTREE':
      return t('adm.authority.scope.subtree');
    case 'UNIT_ONLY':
      return t('adm.authority.scope.only');
    default:
      return kind;
  }
}

export function phaseLabel(t: Translate, phase: ActingPhase): string {
  switch (phase) {
    case 'PENDING':
      return t('adm.authority.acting.phase.pending');
    case 'REQUEST_LAPSED':
      return t('adm.authority.acting.phase.lapsed');
    case 'REJECTED':
      return t('adm.authority.acting.phase.rejected');
    case 'CANCELLED':
      return t('adm.authority.acting.phase.cancelled');
    case 'ACTIVE':
      return t('adm.authority.acting.phase.active');
    case 'ENDED':
      return t('adm.authority.acting.phase.ended');
    case 'REVOKED':
      return t('adm.authority.acting.phase.revoked');
  }
}

export function phaseTone(phase: ActingPhase): Tone {
  return phase === 'ACTIVE' ? 'success' : phase === 'PENDING' ? 'warning' : phase === 'REJECTED' || phase === 'REVOKED' ? 'danger' : 'neutral';
}

export function scopeStatusLabel(t: Translate, status: ScopeStatus): string {
  return status === 'Active' ? t('adm.authority.scopes.status.active') : t('adm.authority.scopes.status.lifted');
}

export function scopeStatusTone(status: ScopeStatus): Tone {
  return status === 'Active' ? 'success' : 'neutral';
}

export function standingProblemMessage(t: Translate, problem: StandingProblem): string {
  switch (problem) {
    case 'delegateRequired':
      return t('adm.authority.problem.delegate');
    case 'permissionsRequired':
      return t('adm.authority.problem.permissions');
    case 'unitRequired':
      return t('adm.authority.problem.unit');
    case 'reviewInvalid':
      return t('adm.authority.problem.review.invalid');
    case 'reviewTooFar':
      return t('adm.authority.problem.review.tooFar');
    case 'reviewPast':
      return t('adm.authority.problem.review.past');
    case 'startPast':
      return t('adm.authority.problem.startPast');
    case 'endTextShort':
      return t('adm.authority.problem.end.text');
    case 'endOnRequired':
      return t('adm.authority.problem.end.required');
    case 'endOnInvalid':
      return t('adm.authority.problem.end.invalid');
    case 'reviewAfterEnd':
      return t('adm.authority.problem.review.afterEnd');
    case 'reasonShort':
      return t('adm.authority.problem.reason');
    case 'periodMalformed':
      return t('adm.authority.problem.period.malformed');
    case 'periodOverlap':
      return t('adm.authority.problem.period.overlap');
    case 'periodTooMany':
      return t('adm.authority.problem.period.tooMany');
  }
}

export function reviewProblemMessage(t: Translate, problem: ReviewProblem): string {
  switch (problem) {
    case 'reviewInvalid':
      return t('adm.authority.problem.review.invalid');
    case 'reviewTooFar':
      return t('adm.authority.problem.review.tooFar');
    case 'reviewNotForward':
      return t('adm.authority.problem.review.notForward');
    case 'reviewAfterEnd':
      return t('adm.authority.problem.review.afterEnd');
  }
}

export function actingProblemMessage(t: Translate, problem: ActingProblem): string {
  switch (problem) {
    case 'subjectRequired':
      return t('adm.authority.problem.subject');
    case 'permissionsRequired':
      return t('adm.authority.problem.permissions');
    case 'permissionRefused':
      return t('adm.authority.problem.permissionRefused');
    case 'hoursInvalid':
      return t('adm.authority.problem.hours');
    case 'reasonShort':
      return t('adm.authority.problem.actingReason');
    case 'periodMalformed':
      return t('adm.authority.problem.period.malformed');
    case 'periodOverlap':
      return t('adm.authority.problem.period.overlap');
    case 'periodTooMany':
      return t('adm.authority.problem.period.tooMany');
  }
}

export function scopeProblemMessage(t: Translate, problem: ScopeProblem): string {
  switch (problem) {
    case 'grantRequired':
      return t('adm.authority.problem.grant');
    case 'periodsRequired':
      return t('adm.authority.problem.period.required');
    case 'reasonShort':
      return t('adm.authority.problem.reason');
    case 'periodMalformed':
      return t('adm.authority.problem.period.malformed');
    case 'periodOverlap':
      return t('adm.authority.problem.period.overlap');
    case 'periodTooMany':
      return t('adm.authority.problem.period.tooMany');
  }
}

export function refusedWhyLabel(t: Translate, why: NonNullable<ReturnType<typeof actingRefusal>>): string {
  switch (why) {
    case 'malformed':
      return t('adm.authority.refused.malformed');
    case 'wildcard':
      return t('adm.authority.refused.wildcard');
    case 'administrative':
      return t('adm.authority.refused.administrative');
    case 'decision':
      return t('adm.authority.refused.decision');
  }
}

/** The words for a defect code of the server; a code this screen does not know is said as the code itself. */
export function defectLabel(t: Translate, code: string): string {
  switch (code) {
    case 'TOO_LONG':
      return t('adm.authority.defect.tooLong');
    case 'TOO_SHORT':
      return t('adm.authority.defect.tooShort');
    case 'BEFORE_START':
      return t('adm.authority.defect.beforeStart');
    case 'IN_THE_PAST':
      return t('adm.authority.defect.past');
    case 'ALREADY_ENDED':
      return t('adm.authority.defect.ended');
    case 'REVIEW_AFTER_END':
      return t('adm.authority.defect.reviewAfterEnd');
    case 'ADMINISTRATIVE':
      return t('adm.authority.defect.administrative');
    case 'DECISION':
      return t('adm.authority.defect.decision');
    case 'WILDCARD':
      return t('adm.authority.defect.wildcard');
    case 'DUPLICATE':
      return t('adm.authority.defect.duplicate');
    case 'OVERLAP':
      return t('adm.authority.defect.overlap');
    case 'REQUIRED':
      return t('adm.authority.defect.required');
    case 'MALFORMED':
      return t('adm.authority.defect.malformed');
    case 'UNSUPPORTED':
      return t('adm.authority.defect.unsupported');
    case 'NOT_ALLOWED':
      return t('adm.authority.defect.notAllowed');
    default:
      return code;
  }
}

export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'chain':
      return t('adm.authority.error.chain');
    case 'escalation':
      return t('adm.authority.error.escalation');
    case 'self':
      return t('adm.authority.error.self');
    case 'cycle':
      return t('adm.authority.error.cycle');
    case 'selfApproval':
      return t('adm.authority.error.selfApproval');
    case 'actingSelf':
      return t('adm.authority.error.actingSelf');
    case 'actingInvalid':
      return t('adm.authority.error.actingInvalid');
    case 'periodDenied':
      return t('adm.authority.error.periodDenied');
    case 'periodInvalid':
      return t('adm.authority.error.periodInvalid');
    case 'periodState':
      return t('adm.authority.error.periodState');
    case 'invalid':
      return t('adm.authority.error.invalid');
    case 'inactive':
      return t('adm.authority.error.inactive');
    case 'notFound':
      return t('adm.authority.error.notFound');
    case 'versionConflict':
      return t('adm.authority.error.versionConflict');
    case 'stateInvalid':
      return t('adm.authority.error.stateInvalid');
    case 'denied':
      return t('adm.authority.error.denied');
    case 'general':
      return t('adm.authority.error.general');
  }
}

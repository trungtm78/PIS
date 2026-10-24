import type { useTranslation } from '../../i18n';
import type { BiddingForm, ContractType, FieldProblem, PlanDecision, PlanStatus, ProblemView, SelectionMethod } from './plan-model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function planStatusLabel(t: Translate, status: PlanStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('bid.planStatus.draft.label');
    case 'IN_REVIEW':
      return t('bid.planStatus.inReview.label');
    case 'APPROVED':
      return t('bid.planStatus.approved.label');
    case 'SUPERSEDED':
      return t('bid.planStatus.superseded.label');
    case 'CANCELLED':
      return t('bid.planStatus.cancelled.label');
  }
}

export function methodLabel(t: Translate, method: string): string {
  switch (method as SelectionMethod) {
    case 'OPEN_BIDDING':
      return t('bid.method.open.label');
    case 'LIMITED_BIDDING':
      return t('bid.method.limited.label');
    case 'DIRECT_APPOINTMENT':
      return t('bid.method.appointment.label');
    case 'COMPETITIVE_QUOTATION':
      return t('bid.method.quotation.label');
    case 'DIRECT_PURCHASE':
      return t('bid.method.purchase.label');
    case 'SELF_EXECUTION':
      return t('bid.method.self.label');
    case 'COMMUNITY_PARTICIPATION':
      return t('bid.method.community.label');
    case 'SPECIAL_CASE':
      return t('bid.method.special.label');
    default:
      return method;
  }
}

export function contractTypeLabel(t: Translate, type: ContractType): string {
  switch (type) {
    case 'LUMP_SUM':
      return t('bid.contractType.lumpSum.label');
    case 'FIXED_UNIT_PRICE':
      return t('bid.contractType.fixedUnit.label');
    case 'ADJUSTABLE_UNIT_PRICE':
      return t('bid.contractType.adjustableUnit.label');
    case 'TIME_BASED':
      return t('bid.contractType.timeBased.label');
    case 'MIXED':
      return t('bid.contractType.mixed.label');
  }
}

export function biddingFormLabel(t: Translate, form: BiddingForm): string {
  return form === 'ONLINE' ? t('bid.biddingForm.online.label') : t('bid.biddingForm.offline.label');
}

export function decisionLabel(t: Translate, decision: PlanDecision): string {
  switch (decision) {
    case 'APPROVE':
      return t('bid.decision.approve.label');
    case 'RETURN':
      return t('bid.decision.return.label');
    case 'REJECT':
      return t('bid.decision.reject.label');
  }
}

/** What a decision recorded on a plan is called, as it was taken (the history keeps the past tense). */
export function lastDecisionLabel(t: Translate, kind: string): string {
  switch (kind) {
    case 'APPROVED':
      return t('bid.lastDecision.approved.label');
    case 'REJECTED':
      return t('bid.lastDecision.rejected.label');
    default:
      return t('bid.lastDecision.returned.label');
  }
}

export function planFieldMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('bid.planField.required.error');
    case 'tooShort':
      return t('bid.planField.tooShort.error');
    case 'tooLong':
      return t('bid.planField.tooLong.error');
    case 'invalidId':
      return t('bid.planField.invalidId.error');
    case 'invalidAmount':
      return t('bid.planField.invalidAmount.error');
    case 'invalidPeriod':
      return t('bid.planField.invalidPeriod.error');
    case 'invalidDuration':
      return t('bid.planField.invalidDuration.error');
    case 'duplicateCode':
      return t('bid.planField.duplicateCode.error');
  }
}

/** The sentence for a refusal of a command of the plans; a problem the screens have no sentence for is the general one. */
export function planProblemMessage(t: Translate, problem: ProblemView): string {
  switch (problem.reason) {
    case 'budgetExceeds':
      return t('bid.planProblem.budgetExceeds.error');
    case 'lineInvalid':
      return t('bid.planProblem.lineInvalid.error');
    case 'stageInvalid':
      return t('bid.planProblem.stageInvalid.error');
    case 'stateInvalid':
      return t('bid.planProblem.stateInvalid.error');
    case 'codeDuplicate':
      return t('bid.planProblem.codeDuplicate.error');
    case 'selfApproval':
      return t('bid.planProblem.selfApproval.error');
    case 'decisionNotEffective':
      return t('bid.planProblem.decisionNotEffective.error');
    case 'versionConflict':
      return t('bid.planProblem.versionConflict.error');
    case 'validation':
      return problem.field === undefined ? t('bid.planProblem.validation.error') : t('bid.planProblem.validationField.error', { field: problem.field });
    case 'notFound':
      return t('bid.planProblem.notFound.error');
    case 'denied':
      return t('bid.planProblem.denied.error');
    case 'general':
      return t('bid.planProblem.general.error');
  }
}

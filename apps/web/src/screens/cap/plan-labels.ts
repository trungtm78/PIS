import type { useTranslation } from '../../i18n';
import { vndText } from './model';
import type { Bucket, GridProblem, PlanFormProblem, PlanKind, PlanProblemView, PlanStatus, ProposalProblem } from './plan-model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function kindLabel(t: Translate, kind: PlanKind): string {
  return kind === 'ANNUAL' ? t('cap.planKind.annual.label') : t('cap.planKind.medium.label');
}

export function planStatusLabel(t: Translate, status: PlanStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('cap.planStatus.draft.label');
    case 'IN_REVIEW':
      return t('cap.planStatus.inReview.label');
    case 'APPROVED':
      return t('cap.planStatus.approved.label');
    case 'PUBLISHED':
      return t('cap.planStatus.published.label');
    case 'SUPERSEDED':
      return t('cap.planStatus.superseded.label');
    case 'REJECTED':
      return t('cap.planStatus.rejected.label');
  }
}

/** The bucket of a line: the capital of the year, the capital carried over from an earlier year, or another. */
export function bucketLabel(t: Translate, bucket: Bucket): string {
  switch (bucket) {
    case 'CURRENT_YEAR':
      return t('cap.bucket.currentYear.label');
    case 'CARRYOVER':
      return t('cap.bucket.carryover.label');
    case 'OTHER':
      return t('cap.bucket.other.label');
  }
}

export function proposalProblemMessage(t: Translate, problem: ProposalProblem): string {
  switch (problem) {
    case 'required':
      return t('cap.proposal.required.error');
    case 'invalidAmount':
      return t('cap.proposal.invalidAmount.error');
    case 'subsetExceeds':
      return t('cap.proposal.subsetExceeds.error');
    case 'exceedsRemaining':
      return t('cap.proposal.exceedsRemaining.error');
  }
}

export function planFormProblemMessage(t: Translate, problem: PlanFormProblem): string {
  switch (problem) {
    case 'required':
      return t('cap.plans.required.error');
    case 'invalidYear':
      return t('cap.plans.invalidYear.error');
    case 'tooLong':
      return t('cap.plans.tooLong.error');
    case 'periodOrder':
      return t('cap.plans.periodOrder.error');
  }
}

export function gridProblemMessage(t: Translate, problem: GridProblem): string {
  return problem === 'invalidAmount' ? t('cap.grid.invalidAmount.error') : t('cap.grid.subsetExceeds.error');
}

/** The sentence for a refusal of a planning command; a refusal the screens have no sentence for is the general one. */
export function planProblemMessage(t: Translate, problem: PlanProblemView, locale: string): string {
  switch (problem.reason) {
    case 'ceilingExceeded':
      return problem.availableVnd === undefined ? t('cap.planProblem.ceilingExceeded.error') : t('cap.planProblem.ceilingAvailable.error', { available: vndText(problem.availableVnd, locale) });
    case 'subsetExceeds':
      return t('cap.planProblem.subsetExceeds.error');
    case 'planNotDraft':
      return t('cap.planProblem.planNotDraft.error');
    case 'yearLocked':
      return t('cap.planProblem.yearLocked.error');
    case 'stageInvalid':
      return t('cap.planProblem.stageInvalid.error');
    case 'appropriationNotPublished':
      return t('cap.planProblem.notPublished.error');
    case 'planCodeDuplicate':
      return t('cap.planProblem.codeDuplicate.error');
    case 'versionConflict':
      return t('cap.planProblem.versionConflict.error');
    case 'notAllowed':
      return t('cap.planProblem.notAllowed.error');
    case 'validation':
      return problem.field === undefined ? t('cap.planProblem.validation.error') : t('cap.planProblem.validationField.error', { field: problem.field });
    case 'notFound':
      return t('cap.planProblem.notFound.error');
    case 'denied':
      return t('cap.planProblem.denied.error');
    case 'general':
      return t('cap.planProblem.general.error');
  }
}

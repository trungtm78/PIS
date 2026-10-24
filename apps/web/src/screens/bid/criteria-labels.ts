import type { useTranslation } from '../../i18n';
import type { CriteriaStatus, CriterionKind, FieldProblem, ProblemView } from './criteria-model';
import { MAX_CRITERIA, MAX_EVIDENCE, TOTAL_WEIGHT } from './criteria-model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function criteriaStatusLabel(t: Translate, status: CriteriaStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('bid.criteria.status.draft.label');
    case 'APPROVED':
      return t('bid.criteria.status.approved.label');
    case 'SUPERSEDED':
      return t('bid.criteria.status.superseded.label');
  }
}

export function criterionKindLabel(t: Translate, kind: CriterionKind): string {
  return kind === 'SCORED' ? t('bid.criteria.kind.scored.label') : t('bid.criteria.kind.passFail.label');
}

export function criteriaFieldMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('bid.criteria.field.required.error');
    case 'tooShort':
      return t('bid.criteria.field.tooShort.error');
    case 'tooLong':
      return t('bid.criteria.field.tooLong.error');
    case 'invalidId':
      return t('bid.criteria.field.invalidId.error');
    case 'invalidCode':
      return t('bid.criteria.field.invalidCode.error');
    case 'duplicateCode':
      return t('bid.criteria.field.duplicateCode.error');
    case 'invalidWhole':
      return t('bid.criteria.field.invalidWhole.error');
    case 'outOfRange':
      return t('bid.criteria.field.outOfRange.error');
    case 'tooMany':
      return t('bid.criteria.field.tooMany.error', { max: MAX_CRITERIA, evidence: MAX_EVIDENCE });
    case 'weightTotal':
      return t('bid.criteria.field.weightTotal.error', { total: TOTAL_WEIGHT });
  }
}

/** The sentence for a refusal of a command of the criteria; a problem the screen has no sentence for is the general one. */
export function criteriaProblemMessage(t: Translate, problem: ProblemView): string {
  switch (problem.reason) {
    case 'weight':
      return t('bid.criteria.problem.weight.error', { sum: problem.weightsSum ?? 0, total: TOTAL_WEIGHT });
    case 'prohibited':
      return t('bid.criteria.problem.prohibited.error', { code: problem.criterionCode ?? '' });
    case 'packageState':
      return t('bid.criteria.problem.packageState.error');
    case 'stateInvalid':
      return t('bid.criteria.problem.stateInvalid.error');
    case 'lockedByRun':
      return t('bid.criteria.problem.lockedByRun.error');
    case 'selfApproval':
      return t('bid.criteria.problem.selfApproval.error');
    case 'versionConflict':
      return t('bid.criteria.problem.versionConflict.error');
    case 'validation':
      return problem.field === undefined ? t('bid.criteria.problem.validation.error') : t('bid.criteria.problem.validationField.error', { field: problem.field });
    case 'notFound':
      return t('bid.criteria.problem.notFound.error');
    case 'denied':
      return t('bid.criteria.problem.denied.error');
    case 'general':
      return t('bid.criteria.problem.general.error');
  }
}

import type { useTranslation } from '../../i18n';
import type { AppraisalProblem, FieldProblem, Recommendation, SheetStatus } from './appraisal-model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function recommendationLabel(t: Translate, recommendation: Recommendation): string {
  switch (recommendation) {
    case 'ADMIT':
      return t('prj.appraisal.recommendation.admit.label');
    case 'REJECT':
      return t('prj.appraisal.recommendation.reject.label');
    case 'RETURN':
      return t('prj.appraisal.recommendation.return.label');
  }
}

export function sheetStatusLabel(t: Translate, status: SheetStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('prj.appraisal.status.draft.label');
    case 'SUBMITTED':
      return t('prj.appraisal.status.submitted.label');
    case 'DECIDED':
      return t('prj.appraisal.status.decided.label');
    case 'VOID':
      return t('prj.appraisal.status.void.label');
  }
}

export function fieldProblemMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('prj.appraisal.field.required.error');
    case 'tooShort':
      return t('prj.appraisal.field.tooShort.error');
    case 'tooLong':
      return t('prj.appraisal.field.tooLong.error');
    case 'invalidId':
      return t('prj.appraisal.field.invalidId.error');
    case 'invalidDate':
      return t('prj.appraisal.field.invalidDate.error');
    case 'scoresIncomplete':
      return t('prj.appraisal.field.scoresIncomplete.error');
    case 'evidenceInvalid':
      return t('prj.appraisal.field.evidenceInvalid.error');
    case 'overrideShort':
      return t('prj.appraisal.field.overrideShort.error');
  }
}

/** The sentence for a refusal of a command of the appraisal; a problem the screen has no sentence for is the general one. */
export function problemMessage(t: Translate, problem: AppraisalProblem): string {
  switch (problem) {
    case 'selfApproval':
      return t('prj.appraisal.problem.selfApproval.error');
    case 'criteriaWeight':
      return t('prj.appraisal.problem.criteriaWeight.error');
    case 'scoreRange':
      return t('prj.appraisal.problem.scoreRange.error');
    case 'overrideRequired':
      return t('prj.appraisal.problem.overrideRequired.error');
    case 'groupRequired':
      return t('prj.appraisal.problem.groupRequired.error');
    case 'decisionRequired':
      return t('prj.appraisal.problem.decisionRequired.error');
    case 'incomplete':
      return t('prj.appraisal.problem.incomplete.error');
    case 'transitionDenied':
      return t('prj.appraisal.problem.transitionDenied.error');
    case 'versionConflict':
      return t('prj.appraisal.problem.versionConflict.error');
    case 'validation':
      return t('prj.appraisal.problem.validation.error');
    case 'notFound':
      return t('prj.appraisal.problem.notFound.error');
    case 'denied':
      return t('prj.appraisal.problem.denied.error');
    case 'general':
      return t('prj.appraisal.problem.general.error');
  }
}

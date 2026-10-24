import type { useTranslation } from '../../i18n';
import type { Classification, FieldProblem, ProblemView, ProjectStatus } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

/** The stage of the PIMA life cycle a project is in (PRJ 3.1 section 4). */
export function stageLabel(t: Translate, status: ProjectStatus): string {
  switch (status) {
    case 'CONCEPT':
      return t('prj.stage.concept.label');
    case 'APPRAISAL':
      return t('prj.stage.appraisal.label');
    case 'PIPELINE':
      return t('prj.stage.pipeline.label');
    case 'BUDGETED':
      return t('prj.stage.budgeted.label');
    case 'IMPLEMENTATION':
      return t('prj.stage.implementation.label');
    case 'SUSPENDED':
      return t('prj.stage.suspended.label');
    case 'COMPLETED':
      return t('prj.stage.completed.label');
    case 'SETTLED':
      return t('prj.stage.settled.label');
    case 'CLOSED':
      return t('prj.stage.closed.label');
    case 'REJECTED':
      return t('prj.stage.rejected.label');
    case 'CANCELLED':
      return t('prj.stage.cancelled.label');
  }
}

/** Whether the project is still open or has reached an end (closed, rejected or cancelled). */
export function lifeLabel(t: Translate, status: ProjectStatus): string {
  return status === 'CLOSED' || status === 'REJECTED' || status === 'CANCELLED' ? t('prj.life.ended.label') : t('prj.life.open.label');
}

export function classificationLabel(t: Translate, classification: Classification): string {
  switch (classification) {
    case 'PUBLIC':
      return t('prj.classification.public.label');
    case 'INTERNAL':
      return t('prj.classification.internal.label');
    case 'CONFIDENTIAL':
      return t('prj.classification.confidential.label');
  }
}

export function fieldProblemMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('prj.field.required.error');
    case 'tooShort':
      return t('prj.field.tooShort.error');
    case 'tooLong':
      return t('prj.field.tooLong.error');
    case 'invalidAmount':
      return t('prj.field.invalidAmount.error');
    case 'invalidYear':
      return t('prj.field.invalidYear.error');
    case 'order':
      return t('prj.field.order.error');
  }
}

/** The sentence for a refusal of a command; a problem the screen has no sentence for is the general one. */
export function problemMessage(t: Translate, problem: ProblemView): string {
  switch (problem.reason) {
    case 'duplicateCode':
      return t('prj.problem.duplicateCode.error');
    case 'masterNotEffective':
      return problem.field === undefined ? t('prj.problem.masterNotEffective.error') : t('prj.problem.masterNotEffectiveField.error', { field: problem.field });
    case 'versionConflict':
      return t('prj.problem.versionConflict.error');
    case 'stageLocked':
      return problem.field === undefined ? t('prj.problem.stageLocked.error') : t('prj.problem.stageLockedField.error', { field: problem.field });
    case 'notAllowed':
      return t('prj.problem.notAllowed.error');
    case 'validation':
      return problem.field === undefined ? t('prj.problem.validation.error') : t('prj.problem.validationField.error', { field: problem.field });
    case 'notFound':
      return t('prj.problem.notFound.error');
    case 'denied':
      return t('prj.problem.denied.error');
    case 'general':
      return t('prj.problem.general.error');
  }
}

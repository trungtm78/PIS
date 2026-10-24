import type { useTranslation } from '../../i18n';
import type { AssignProblem, ReconcileProblem, ReconcileState } from './national-code-model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function reconcileStateLabel(t: Translate, state: ReconcileState): string {
  return state === 'HAS_CODE' ? t('prj.reconcile.state.hasCode.label') : t('prj.reconcile.state.missing.label');
}

export function assignProblemMessage(t: Translate, problem: AssignProblem): string {
  switch (problem) {
    case 'codeRequired':
      return t('prj.reconcile.field.codeRequired.error');
    case 'codeTooLong':
      return t('prj.reconcile.field.codeTooLong.error');
    case 'codeInvalid':
      return t('prj.reconcile.field.codeInvalid.error');
    case 'evidenceInvalid':
      return t('prj.reconcile.field.evidenceInvalid.error');
    case 'evidenceRequired':
      return t('prj.reconcile.field.evidenceRequired.error');
  }
}

/** The sentence for a refusal of the assignment; a problem the screen has no sentence for is the general one. */
export function reconcileProblemMessage(t: Translate, problem: ReconcileProblem): string {
  switch (problem) {
    case 'formatInvalid':
      return t('prj.reconcile.problem.formatInvalid.error');
    case 'duplicate':
      return t('prj.reconcile.problem.duplicate.error');
    case 'evidenceRequired':
      return t('prj.reconcile.problem.evidenceRequired.error');
    case 'stageLocked':
      return t('prj.reconcile.problem.stageLocked.error');
    case 'versionConflict':
      return t('prj.reconcile.problem.versionConflict.error');
    case 'validation':
      return t('prj.reconcile.problem.validation.error');
    case 'notFound':
      return t('prj.reconcile.problem.notFound.error');
    case 'denied':
      return t('prj.reconcile.problem.denied.error');
    case 'general':
      return t('prj.reconcile.problem.general.error');
  }
}

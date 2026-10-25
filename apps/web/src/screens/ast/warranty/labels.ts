import type { useTranslation } from '../../../i18n';
import type { ConstructionGrade, FormProblem, Problem, ProblemView, WarrantyStatus } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: WarrantyStatus): string {
  switch (status) {
    case 'ACTIVE':
      return t('ast.warranty.status.active');
    case 'EXPIRED':
      return t('ast.warranty.status.expired');
    case 'CLOSED':
      return t('ast.warranty.status.closed');
  }
}

export function gradeLabel(t: Translate, grade: ConstructionGrade | null): string {
  switch (grade) {
    case 'SPECIAL':
      return t('ast.warranty.grade.special');
    case 'I':
      return t('ast.warranty.grade.i');
    case 'II':
      return t('ast.warranty.grade.ii');
    case 'III':
      return t('ast.warranty.grade.iii');
    case 'IV':
      return t('ast.warranty.grade.iv');
    case null:
      return t('ast.warranty.grade.unknown');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('ast.warranty.problem.required');
    case 'date':
      return t('ast.warranty.problem.date');
    case 'uuid':
      return t('ast.warranty.problem.uuid');
    case 'tooLong':
      return t('ast.warranty.problem.tooLong');
    case 'amount':
      return t('ast.warranty.problem.amount');
    case 'period':
      return t('ast.warranty.problem.period');
    case 'cover':
      return t('ast.warranty.problem.cover');
  }
}

function baseMessage(t: Translate, view: ProblemView): string {
  const problem: Problem = view.problem;
  switch (problem) {
    case 'belowMinimum':
      return t('ast.warranty.error.belowMinimum', { minimum: view.minimum ?? '', period: view.period ?? '' });
    case 'noRule':
      return t('ast.warranty.error.noRule');
    case 'guaranteeRequired':
      return t('ast.warranty.error.guaranteeRequired');
    case 'handoverNotAccepted':
      return t('ast.warranty.error.handoverNotAccepted');
    case 'notExpired':
      return t('ast.warranty.error.notExpired', { day: view.endsOn ?? '' });
    case 'openClaims':
      return t('ast.warranty.error.openClaims', { count: view.claims.length, claims: view.claims.join(', ') });
    case 'stateInvalid':
      return t('ast.warranty.error.stateInvalid');
    case 'validation':
      return t('ast.warranty.error.validation');
    case 'notFound':
      return t('ast.warranty.error.notFound');
    case 'denied':
      return t('ast.warranty.error.denied');
    case 'session':
      return t('ast.warranty.error.session');
    case 'general':
      return t('ast.warranty.error.general');
  }
}

/** What a refusal of a command says, in words: the minimum term and the one that was asked, the last day of a warranty that has not run out, the claims that are still open. */
export const problemMessage = (t: Translate, view: ProblemView): string => baseMessage(t, view);

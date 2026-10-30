import type { useTranslation } from '../../../i18n';
import type { FormProblem, Problem } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('ast.omlink.problem.required');
    case 'uuid':
      return t('ast.omlink.problem.uuid');
    case 'cycle':
      return t('ast.omlink.problem.cycle');
    case 'date':
      return t('ast.omlink.problem.date');
    case 'tooLong':
      return t('ast.omlink.problem.tooLong');
  }
}

/** What a refusal of the server says, in words. */
export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'notTransferred':
      return t('ast.omlink.error.notTransferred');
    case 'linked':
      return t('ast.omlink.error.linked');
    case 'notClean':
      return t('ast.omlink.error.notClean');
    case 'validation':
      return t('ast.omlink.error.validation');
    case 'notFound':
      return t('ast.omlink.error.notFound');
    case 'denied':
      return t('ast.omlink.error.denied');
    case 'session':
      return t('ast.omlink.error.session');
    case 'general':
      return t('ast.omlink.error.general');
  }
}

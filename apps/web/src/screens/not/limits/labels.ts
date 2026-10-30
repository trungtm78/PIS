import type { Translator } from '../../../i18n';
import type { LimitsProblem, ProblemView } from './model';

type T = Translator['t'];

export function limitsProblemMessage(t: T, problem: LimitsProblem): string {
  switch (problem) {
    case 'cap':
      return t('not.limits.form.cap.invalid');
    case 'budget':
      return t('not.limits.form.budget.invalid');
    case 'reason':
      return t('not.limits.form.reason.invalid');
    case 'nothing':
      return t('not.limits.form.nothing.invalid');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'invalid':
      return problem.field === undefined ? t('not.limits.problem.invalid') : t('not.limits.problem.invalidAt', { field: problem.field });
    case 'state':
      return t('not.limits.problem.state');
    case 'conflict':
      return t('not.limits.problem.conflict');
    case 'denied':
      return t('not.limits.problem.denied');
    case 'notFound':
      return t('not.limits.problem.notFound');
    case 'session':
      return t('not.limits.problem.session');
    case 'general':
      return t('not.limits.problem.general');
  }
}

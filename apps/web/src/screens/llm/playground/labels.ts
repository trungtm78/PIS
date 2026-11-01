import type { Translator } from '../../../i18n';
import type { FieldProblem, Reason } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function problemMessage(t: T, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('llm.playground.problem.required');
    case 'invalid':
      return t('llm.playground.problem.invalid');
    case 'tooMany':
      return t('llm.playground.problem.tooMany');
    case 'tooLong':
      return t('llm.playground.problem.tooLong');
  }
}

export function reasonMessage(t: T, reason: Reason): string {
  switch (reason) {
    case 'quota':
      return t('llm.playground.reason.quota');
    case 'budget':
      return t('llm.playground.reason.budget');
    case 'routeNotAllowed':
      return t('llm.playground.reason.routeNotAllowed');
    case 'killSwitch':
      return t('llm.playground.reason.killSwitch');
    case 'validation':
      return t('llm.playground.reason.validation');
    case 'scope':
      return t('llm.playground.reason.scope');
    case 'general':
      return t('llm.playground.reason.general');
  }
}

import type { Translator } from '../../../i18n';
import type { ProblemView } from './model';

type T = Translator['t'];

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'invalid':
      return t('omni.convert.problem.invalid');
    case 'state':
      return t('omni.convert.problem.state');
    case 'already':
      return t('omni.convert.problem.already');
    case 'conflict':
      return t('omni.convert.problem.conflict');
    case 'denied':
      return t('omni.convert.problem.denied');
    case 'notFound':
      return t('omni.convert.problem.notFound');
    case 'rejected':
      return t('omni.convert.problem.rejected');
    case 'session':
      return t('omni.convert.problem.session');
    case 'general':
      return t('omni.convert.problem.general');
  }
}

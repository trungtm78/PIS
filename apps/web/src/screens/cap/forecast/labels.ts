import type { useTranslation } from '../../../i18n';
import type { AssumptionProblem } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

/** The sentence for an assumption that is wrong before anything is sent. */
export function assumptionMessage(t: Translate, problem: AssumptionProblem): string {
  switch (problem) {
    case 'required':
      return t('cap.estimate.assumption.required.error');
    case 'tooLong':
      return t('cap.estimate.assumption.tooLong.error');
    case 'invalidText':
      return t('cap.estimate.assumption.invalid.error');
  }
}

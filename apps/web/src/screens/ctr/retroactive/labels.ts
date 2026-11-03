import type { useTranslation } from '../../../i18n';
import { formProblemMessage } from '../change/labels';
import type { AdjustProblem } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function adjustProblemMessage(t: Translate, problem: AdjustProblem): string {
  switch (problem) {
    case 'date':
      return t('ctr.retro.problem.date');
    case 'notPast':
      return t('ctr.retro.problem.notPast');
    case 'json':
      return t('ctr.retro.problem.json');
    case 'tooMany':
      return t('ctr.retro.problem.tooMany');
    default:
      return formProblemMessage(t, problem);
  }
}

/** A change of the schedule as a signed number of days: "+10 days" when it extends the time, "-3 days" when it shortens it. */
export function daysText(t: Translate, days: number): string {
  return t('ctr.retro.days.value', { days: days > 0 ? `+${days}` : `${days}` });
}

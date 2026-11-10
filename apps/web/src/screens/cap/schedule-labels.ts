import type { useTranslation } from '../../i18n';
import type { Bucket } from './plan-model';
import type { RegistrationProblem, ScheduleProblem } from './schedule-model';

type Translate = ReturnType<typeof useTranslation>['t'];

/** The source groups of the registration as the mockup names them: capital of the year, carried-over capital and other capital. */
export function sourceLabel(t: Translate, bucket: Bucket): string {
  switch (bucket) {
    case 'CURRENT_YEAR':
      return t('cap.schedule.column.year');
    case 'CARRYOVER':
      return t('cap.schedule.column.carryover');
    case 'EQUITY':
      return t('cap.bucket.equity.label');
    case 'LOAN':
      return t('cap.bucket.loan.label');
    case 'OTHER':
      return t('cap.schedule.column.other');
  }
}

export function monthLabel(t: Translate, month: number, adjustment: boolean): string {
  return adjustment ? t('cap.schedule.month.adjustment.label') : t('cap.schedule.month.label', { month });
}

export function amountProblemMessage(t: Translate, problem: RegistrationProblem): string {
  switch (problem) {
    case 'required':
      return t('cap.schedule.amount.required.error');
    case 'invalidAmount':
      return t('cap.schedule.amount.invalid.error');
    case 'subsetExceeds':
      return t('cap.schedule.ctmtqg.exceeds.error');
    case 'tooLong':
      return t('cap.schedule.reason.tooLong.error');
  }
}

export function ctmtqgProblemMessage(t: Translate, problem: RegistrationProblem): string {
  return problem === 'subsetExceeds' ? t('cap.schedule.ctmtqg.exceeds.error') : t('cap.schedule.ctmtqg.invalid.error');
}

export function scheduleProblemMessage(t: Translate, problem: ScheduleProblem): string {
  switch (problem) {
    case 'subset':
      return t('cap.schedule.subset.error');
    case 'periodLocked':
      return t('cap.schedule.periodLocked.error');
    case 'yearLocked':
      return t('cap.schedule.yearLocked.error');
    case 'stage':
      return t('cap.schedule.stage.error');
    case 'denied':
      return t('cap.schedule.denied.error');
    case 'notFound':
      return t('cap.schedule.notFound.error');
    case 'validation':
      return t('cap.schedule.validation.error');
    case 'general':
      return t('cap.schedule.general.error');
  }
}

import type { useTranslation } from '../../../i18n';
import type { HandoverProblem, SectionStatus } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function sectionStatusLabel(t: Translate, status: SectionStatus): string {
  switch (status) {
    case 'NOT_READY':
      return t('lnd.sections.status.notReady');
    case 'PARTIAL':
      return t('lnd.sections.status.partial');
    case 'HANDED_OVER':
      return t('lnd.sections.status.handedOver');
  }
}

export function handoverProblemMessage(t: Translate, problem: HandoverProblem): string {
  switch (problem) {
    case 'required':
      return t('lnd.field.required.error');
    case 'tooLong':
      return t('lnd.field.tooLong.error');
    case 'invalid':
      return t('lnd.field.invalid.error');
    case 'future':
      return t('lnd.field.future.error');
    case 'notIncreasing':
      return t('lnd.sections.problem.notIncreasing.error');
    case 'exceeds':
      return t('lnd.sections.problem.exceeds.error');
    case 'beforeLast':
      return t('lnd.sections.problem.beforeLast.error');
  }
}

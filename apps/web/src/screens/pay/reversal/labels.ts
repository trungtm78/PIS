import type { useTranslation } from '../../../i18n';
import type { Problem, ReversalProblem } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function problemMessage(t: Translate, problem: ReversalProblem): string {
  switch (problem) {
    case 'required':
      return t('pay.reversal.problem.required');
    case 'tooLong':
      return t('pay.reversal.problem.tooLong');
    case 'uuid':
      return t('pay.reversal.problem.uuid');
  }
}

/** What a refusal says; a refund that is not the refund of this payment says why. */
export function refusalMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'refundMissing':
      return t('pay.reversal.error.refundMissing');
    case 'refundNotFound':
      return t('pay.reversal.error.refundNotFound');
    case 'refundNotRefund':
      return t('pay.reversal.error.refundNotRefund');
    case 'refundOther':
      return t('pay.reversal.error.refundOther');
    case 'refundAmount':
      return t('pay.reversal.error.refundAmount');
    case 'refundUsed':
      return t('pay.reversal.error.refundUsed');
    case 'approvalRequired':
      return t('pay.reversal.error.approvalRequired');
    case 'notClean':
      return t('pay.reversal.error.notClean');
    case 'selfApproval':
      return t('pay.reversal.error.selfApproval');
    case 'paymentState':
      return t('pay.reversal.error.paymentState');
    case 'retentionReleased':
      return t('pay.reversal.error.retentionReleased');
    case 'advanceState':
      return t('pay.reversal.error.advanceState');
    case 'valueExceeded':
      return t('pay.reversal.error.valueExceeded');
    case 'versionConflict':
      return t('pay.reversal.error.versionConflict');
    case 'validation':
      return t('pay.reversal.error.validation');
    case 'notFound':
      return t('pay.reversal.error.notFound');
    case 'denied':
      return t('pay.reversal.error.denied');
    case 'session':
      return t('pay.reversal.error.session');
    case 'general':
      return t('pay.reversal.error.general');
  }
}

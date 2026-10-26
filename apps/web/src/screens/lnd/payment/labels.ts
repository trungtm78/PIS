import type { useTranslation } from '../../../i18n';
import type { CommandProblem, FormProblem, PaymentLine, PaymentMethod } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function paymentMethodLabel(t: Translate, method: PaymentMethod | 'DEPOSITED'): string {
  switch (method) {
    case 'BANK_TRANSFER':
      return t('lnd.paymentMethod.bankTransfer.label');
    case 'CASH_VOUCHER':
      return t('lnd.paymentMethod.cashVoucher.label');
    case 'TREASURY':
      return t('lnd.paymentMethod.treasury.label');
    case 'DEPOSITED':
      return t('lnd.paymentMethod.deposited.label');
  }
}

export function paymentStatusLabel(t: Translate, status: PaymentLine['status']): string {
  switch (status) {
    case 'PENDING':
      return t('lnd.paymentStatus.pending.label');
    case 'PAID':
      return t('lnd.paymentStatus.paid.label');
    case 'DEPOSITED':
      return t('lnd.paymentStatus.deposited.label');
    case 'CANCELLED':
      return t('lnd.paymentStatus.cancelled.label');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('lnd.field.required.error');
    case 'tooLong':
      return t('lnd.field.tooLong.error');
    case 'invalid':
      return t('lnd.field.invalid.error');
    case 'future':
      return t('lnd.payments.field.future.error');
    case 'early':
      return t('lnd.payments.field.early.error');
  }
}

/** The sentence for a refusal of a command; a problem the screen has no sentence for is the general one. */
export function commandProblemMessage(t: Translate, problem: CommandProblem): string {
  switch (problem) {
    case 'exceedsHousehold':
      return t('lnd.payments.problem.exceedsHousehold.error');
    case 'exceedsPlan':
      return t('lnd.payments.problem.exceedsPlan.error');
    case 'planState':
      return t('lnd.payments.problem.planState.error');
    case 'paymentState':
      return t('lnd.payments.problem.paymentState.error');
    case 'lateReason':
      return t('lnd.payments.problem.lateReason.error');
    case 'advanceExceeded':
      return t('lnd.payments.problem.advanceExceeded.error');
    case 'advanceState':
      return t('lnd.payments.problem.advanceState.error');
    case 'documentNotClean':
      return t('lnd.payments.problem.documentNotClean.error');
    case 'ruleUnconfirmed':
      return t('lnd.payments.problem.ruleUnconfirmed.error');
    case 'versionConflict':
      return t('lnd.problem.versionConflict.error');
    case 'scopeDenied':
      return t('lnd.payments.problem.scopeDenied.error');
    case 'validation':
      return t('lnd.problem.validation.error');
    case 'notFound':
      return t('lnd.problem.notFound.error');
    case 'general':
      return t('lnd.problem.general.error');
  }
}

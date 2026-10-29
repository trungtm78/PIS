import type { Translator } from '../../../i18n';
import type { PaymentMethod, PaymentStatus } from '../billing/model';
import type { ProblemView } from './model';

type T = Translator['t'];

export function paymentStatusLabel(t: T, status: PaymentStatus): string {
  switch (status) {
    case 'Unmatched':
      return t('sas.payments.status.unmatched');
    case 'PendingReview':
      return t('sas.payments.status.review');
    case 'Matched':
      return t('sas.payments.status.matched');
    case 'Reversed':
      return t('sas.payments.status.reversed');
  }
}

export function paymentStatusTone(status: PaymentStatus): 'ok' | 'warn' | 'red' | 'gray' {
  switch (status) {
    case 'Matched':
      return 'ok';
    case 'Unmatched':
      return 'warn';
    case 'PendingReview':
      return 'red';
    case 'Reversed':
      return 'gray';
  }
}

export function methodLabel(t: T, method: PaymentMethod): string {
  switch (method) {
    case 'BANK_TRANSFER':
      return t('sas.payments.method.bank');
    case 'GATEWAY':
      return t('sas.payments.method.gateway');
    case 'TREASURY_TRANSFER':
      return t('sas.payments.method.treasury');
  }
}

export function problemMessage(t: T, problem: ProblemView, format: (amount: string) => string): string {
  switch (problem.reason) {
    case 'mismatch':
      return problem.outstandingVnd === undefined ? t('sas.payments.problem.mismatch') : t('sas.payments.problem.mismatchAmount', { amount: format(problem.outstandingVnd) });
    case 'paymentState':
      return t('sas.payments.problem.paymentState');
    case 'invoiceState':
      return t('sas.payments.problem.invoiceState');
    case 'conflict':
      return t('sas.payments.problem.conflict');
    case 'invalid':
      return problem.field === undefined ? t('sas.payments.problem.invalid') : t('sas.payments.problem.invalidAt', { field: problem.field });
    case 'denied':
      return t('sas.payments.problem.denied');
    case 'notFound':
      return t('sas.payments.problem.notFound');
    case 'session':
      return t('sas.payments.problem.session');
    case 'general':
      return t('sas.payments.problem.general');
  }
}

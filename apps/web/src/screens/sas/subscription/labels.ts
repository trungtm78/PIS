import type { Translator } from '../../../i18n';
import type { Effective, FieldProblem, PaymentMethod, ProblemView, SubscriptionStatus } from './model';

type T = Translator['t'];

export function statusLabel(t: T, status: SubscriptionStatus): string {
  switch (status) {
    case 'Trialing':
      return t('sas.subscription.status.trialing');
    case 'Active':
      return t('sas.subscription.status.active');
    case 'PastDue':
      return t('sas.subscription.status.pastDue');
    case 'Paused':
      return t('sas.subscription.status.paused');
    case 'Cancelled':
      return t('sas.subscription.status.cancelled');
    case 'Expired':
      return t('sas.subscription.status.expired');
  }
}

export function statusTone(status: SubscriptionStatus): 'ok' | 'warn' | 'red' | 'gray' {
  switch (status) {
    case 'Active':
      return 'ok';
    case 'Trialing':
    case 'Paused':
      return 'warn';
    case 'PastDue':
    case 'Expired':
      return 'red';
    case 'Cancelled':
      return 'gray';
  }
}

export function methodLabel(t: T, method: PaymentMethod): string {
  switch (method) {
    case 'BANK_TRANSFER':
      return t('sas.subscription.method.bank');
    case 'TREASURY_TRANSFER':
      return t('sas.subscription.method.treasury');
    case 'GATEWAY':
      return t('sas.subscription.method.gateway');
  }
}

export function effectiveLabel(t: T, effective: Effective): string {
  return effective === 'NOW' ? t('sas.planChange.effective.now') : t('sas.planChange.effective.next');
}

export function fieldProblemMessage(t: T, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('sas.subscription.field.required');
    case 'notDate':
      return t('sas.subscription.field.notDate');
    case 'notWhole':
      return t('sas.subscription.field.notWhole');
    case 'outOfRange':
      return t('sas.subscription.field.outOfRange');
    case 'tooLong':
      return t('sas.subscription.field.tooLong');
  }
}

/** Why the server refused, in the words of both screens; a refusal that names a field says which. */
export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'exists':
      return t('sas.subscription.problem.exists');
    case 'notPublished':
      return t('sas.subscription.problem.notPublished');
    case 'stale':
      return t('sas.planChange.problem.stale');
    case 'conflict':
      return t('sas.subscription.problem.conflict');
    case 'stateInvalid':
      return t('sas.subscription.problem.stateInvalid');
    case 'tenantState':
      return t('sas.subscription.problem.tenantState');
    case 'invalid':
      return problem.field === undefined ? t('sas.subscription.problem.invalid') : t('sas.subscription.problem.invalidAt', { field: problem.field });
    case 'denied':
      return t('sas.subscription.problem.denied');
    case 'notFound':
      return t('sas.subscription.problem.notFound');
    case 'session':
      return t('sas.subscription.problem.session');
    case 'general':
      return t('sas.subscription.problem.general');
  }
}

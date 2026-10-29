import type { Translator } from '../../../i18n';
import type { InvoiceStatus, LineKind, ProblemView, RunProblem } from './model';

type T = Translator['t'];

export function statusLabel(t: T, status: InvoiceStatus): string {
  switch (status) {
    case 'Draft':
      return t('sas.billing.status.draft');
    case 'Discarded':
      return t('sas.billing.status.discarded');
    case 'PendingIssue':
      return t('sas.billing.status.pendingIssue');
    case 'IssueFailed':
      return t('sas.billing.status.issueFailed');
    case 'Issued':
      return t('sas.billing.status.issued');
    case 'Sent':
      return t('sas.billing.status.sent');
    case 'PartiallyPaid':
      return t('sas.billing.status.partiallyPaid');
    case 'Paid':
      return t('sas.billing.status.paid');
    case 'Overdue':
      return t('sas.billing.status.overdue');
    case 'Adjusted':
      return t('sas.billing.status.adjusted');
    case 'Replaced':
      return t('sas.billing.status.replaced');
  }
}

export function statusTone(status: InvoiceStatus): 'ok' | 'warn' | 'red' | 'gray' {
  switch (status) {
    case 'Issued':
    case 'Sent':
    case 'Paid':
      return 'ok';
    case 'PendingIssue':
    case 'PartiallyPaid':
      return 'warn';
    case 'IssueFailed':
    case 'Overdue':
      return 'red';
    case 'Draft':
    case 'Discarded':
    case 'Adjusted':
    case 'Replaced':
      return 'gray';
  }
}

export function kindLabel(t: T, kind: LineKind): string {
  switch (kind) {
    case 'SUBSCRIPTION':
      return t('sas.billing.kind.subscription');
    case 'USAGE':
      return t('sas.billing.kind.usage');
    case 'ADJUSTMENT':
      return t('sas.billing.kind.adjustment');
    case 'DISCOUNT':
      return t('sas.billing.kind.discount');
  }
}

export function fieldProblemMessage(t: T, problem: RunProblem): string {
  switch (problem) {
    case 'required':
      return t('sas.billing.field.required');
    case 'notDate':
      return t('sas.billing.field.notDate');
    case 'backwards':
      return t('sas.billing.field.backwards');
    case 'tooLong':
      return t('sas.billing.field.tooLong');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'period':
      return t('sas.billing.problem.period');
    case 'stateInvalid':
      return t('sas.billing.problem.stateInvalid');
    case 'conflict':
      return t('sas.billing.problem.conflict');
    case 'provider':
      return t('sas.billing.problem.provider');
    case 'invalid':
      return problem.field === undefined ? t('sas.billing.problem.invalid') : t('sas.billing.problem.invalidAt', { field: problem.field });
    case 'denied':
      return t('sas.billing.problem.denied');
    case 'notFound':
      return t('sas.billing.problem.notFound');
    case 'session':
      return t('sas.billing.problem.session');
    case 'general':
      return t('sas.billing.problem.general');
  }
}

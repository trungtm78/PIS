import type { useTranslation } from '../../../i18n';
import type { Tone } from '../../../ui';
import type { FormProblem, Outcome, Problem, Scope, Status } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

/** The plain-words name of a duty of the matrix (`SOD_ACTIONS` of the kernel); a code the screen does not know is shown as it is. */
export function actionLabel(t: Translate, code: string): string {
  switch (code) {
    case 'contract.draft':
      return t('govd.sod.action.contractDraft');
    case 'contract.approve':
      return t('govd.sod.action.contractApprove');
    case 'measurement.record':
      return t('govd.sod.action.measurementRecord');
    case 'measurement.approve':
      return t('govd.sod.action.measurementApprove');
    case 'acceptance.record':
      return t('govd.sod.action.acceptanceRecord');
    case 'acceptance.approve':
      return t('govd.sod.action.acceptanceApprove');
    case 'payment.request':
      return t('govd.sod.action.paymentRequest');
    case 'payment.verify':
      return t('govd.sod.action.paymentVerify');
    case 'payment.approve':
      return t('govd.sod.action.paymentApprove');
    case 'advance.request':
      return t('govd.sod.action.advanceRequest');
    case 'advance.approve':
      return t('govd.sod.action.advanceApprove');
    case 'bid.evaluate':
      return t('govd.sod.action.bidEvaluate');
    case 'bid.award':
      return t('govd.sod.action.bidAward');
    case 'bid.sign_off':
      return t('govd.sod.action.bidSignOff');
    default:
      return code;
  }
}

export function scopeLabel(t: Translate, scope: Scope): string {
  switch (scope) {
    case 'SAME_RECORD':
      return t('govd.sod.scope.record');
    case 'SAME_PROJECT':
      return t('govd.sod.scope.project');
    case 'SAME_CONTRACT':
      return t('govd.sod.scope.contract');
    case 'SAME_PACKAGE':
      return t('govd.sod.scope.package');
  }
}

export function severityLabel(t: Translate, severity: 'BLOCK' | 'WARN'): string {
  return severity === 'BLOCK' ? t('govd.sod.severity.block') : t('govd.sod.severity.warn');
}

export const severityTone = (severity: 'BLOCK' | 'WARN'): Tone => (severity === 'BLOCK' ? 'danger' : 'warning');

export function statusLabel(t: Translate, status: Status): string {
  switch (status) {
    case 'REQUESTED':
      return t('govd.sod.status.requested');
    case 'APPROVED':
      return t('govd.sod.status.approved');
    case 'REJECTED':
      return t('govd.sod.status.rejected');
    case 'REVOKED':
      return t('govd.sod.status.revoked');
    case 'EXPIRED':
      return t('govd.sod.status.expired');
  }
}

export function statusTone(status: Status): Tone {
  switch (status) {
    case 'APPROVED':
      return 'success';
    case 'REQUESTED':
      return 'info';
    case 'REJECTED':
    case 'REVOKED':
      return 'danger';
    case 'EXPIRED':
      return 'neutral';
  }
}

export function outcomeLabel(t: Translate, outcome: Outcome): string {
  switch (outcome) {
    case 'EXCEPTION_USED':
      return t('govd.sod.outcome.used');
    case 'WARNED':
      return t('govd.sod.outcome.warned');
    case 'BLOCKED':
      return t('govd.sod.outcome.blocked');
  }
}

export function outcomeTone(outcome: Outcome): Tone {
  return outcome === 'BLOCKED' ? 'danger' : outcome === 'WARNED' ? 'warning' : 'info';
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'pairRequired':
      return t('govd.sod.problem.pair');
    case 'noException':
      return t('govd.sod.problem.noException');
    case 'subjectRequired':
      return t('govd.sod.problem.subject');
    case 'memberRequired':
      return t('govd.sod.problem.member');
    case 'reasonShort':
      return t('govd.sod.problem.reason');
    case 'datesInvalid':
      return t('govd.sod.problem.dates');
    case 'inThePast':
      return t('govd.sod.problem.past');
    case 'tooLong':
      return t('govd.sod.problem.tooLong');
  }
}

export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'self':
      return t('govd.sod.refusal.self');
    case 'state':
      return t('govd.sod.refusal.state');
    case 'window':
      return t('govd.sod.refusal.window');
    case 'stale':
      return t('govd.sod.refusal.stale');
    case 'invalid':
      return t('govd.sod.refusal.invalid');
    case 'scope':
      return t('govd.sod.refusal.scope');
    case 'general':
      return t('govd.sod.refusal.general');
  }
}

import type { useTranslation } from '../../../i18n';
import { amountText } from '../model';
import type { Blocker, FormProblem, Problem, ProblemView, ReleaseCondition, RetentionStatus } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: RetentionStatus): string {
  switch (status) {
    case 'HELD':
      return t('ctr.retention.status.held');
    case 'PARTIALLY_RELEASED':
      return t('ctr.retention.status.partiallyReleased');
    case 'RELEASED':
      return t('ctr.retention.status.released');
    case 'FORFEITED':
      return t('ctr.retention.status.forfeited');
  }
}

export function conditionLabel(t: Translate, condition: ReleaseCondition): string {
  switch (condition) {
    case 'WARRANTY_END':
      return t('ctr.retention.condition.warrantyEnd');
    case 'COMPLETION':
      return t('ctr.retention.condition.completion');
    case 'MANUAL_DECISION':
      return t('ctr.retention.condition.manualDecision');
  }
}

/** Why the money may not be released yet; what the day is, for the earliest day. */
export function blockerLabel(t: Translate, blocker: Blocker, notBefore: string | null | undefined): string {
  switch (blocker) {
    case 'NOT_BEFORE':
      return t('ctr.retention.blocker.notBefore', { day: notBefore ?? '' });
    case 'NO_WARRANTY':
      return t('ctr.retention.blocker.noWarranty');
    case 'WARRANTY_OPEN':
      return t('ctr.retention.blocker.warrantyOpen');
    case 'CONTRACT_NOT_COMPLETED':
      return t('ctr.retention.blocker.contractNotCompleted');
    case 'DECISION_REQUIRED':
      return t('ctr.retention.blocker.decisionRequired');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('ctr.retention.problem.required');
    case 'uuid':
      return t('ctr.retention.problem.uuid');
    case 'tooLong':
      return t('ctr.retention.problem.tooLong');
    case 'amount':
      return t('ctr.retention.problem.amount');
    case 'exceeds':
      return t('ctr.retention.problem.exceeds');
  }
}

function baseMessage(t: Translate, view: ProblemView, locale: string): string {
  const problem: Problem = view.problem;
  switch (problem) {
    case 'conditionNotMet':
      return t('ctr.retention.error.conditionNotMet', { reason: view.blocker === undefined ? t('ctr.retention.blocker.unknown') : blockerLabel(t, view.blocker, view.notBefore) });
    case 'exceedsHeld':
      return t('ctr.retention.error.exceedsHeld', { left: amountText(view.leftVnd ?? '0', locale) });
    case 'selfApproval':
      return t('ctr.retention.error.selfApproval');
    case 'notClean':
      return t('ctr.retention.error.notClean');
    case 'versionConflict':
      return t('ctr.retention.error.versionConflict');
    case 'paymentState':
      return t('ctr.retention.error.paymentState');
    case 'validation':
      return t('ctr.retention.error.validation');
    case 'notFound':
      return t('ctr.retention.error.notFound');
    case 'denied':
      return t('ctr.retention.error.denied');
    case 'session':
      return t('ctr.retention.error.session');
    case 'general':
      return t('ctr.retention.error.general');
  }
}

/** What a refusal of the release says, in words: what the condition waits for, how much is still held, who may not release. */
export const problemMessage = (t: Translate, view: ProblemView, locale: string): string => baseMessage(t, view, locale);

import type { Translator } from '../../../i18n';
import { formProblemMessage } from '../labels';
import { formatVnd } from '../conclusion/model';
import type { ActionStatus, DisputeOutcome, RemediationFormProblem, RemediationProblem } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function actionStatusLabel(t: T, status: ActionStatus): string {
  switch (status) {
    case 'PLANNED':
      return t('aud.actionStatus.planned');
    case 'DONE':
      return t('aud.actionStatus.done');
    case 'CANCELLED':
      return t('aud.actionStatus.cancelled');
  }
}

export function disputeOutcomeLabel(t: T, outcome: DisputeOutcome): string {
  return outcome === 'ACCEPTED_BY_AUTHORITY' ? t('aud.disputeOutcome.accepted') : t('aud.disputeOutcome.rejected');
}

/** The problem with a field of these forms: the ones the engagement forms share, and a day after the deadline of the conclusion. */
export function remediationFormProblemMessage(t: T, problem: RemediationFormProblem): string {
  return problem === 'afterDeadline' ? t('aud.formProblem.afterDeadline') : formProblemMessage(t, problem);
}

/** What a dialog says of a command that was refused; the deadline and what is left to recover are told when the server told them. */
export function remediationProblemMessage(t: T, problem: RemediationProblem, figures: { deadline?: string | undefined; remainingVnd?: string | undefined } = {}): string {
  switch (problem) {
    case 'notOwner':
      return t('aud.remediationProblem.notOwner');
    case 'ownerOutOfScope':
      return t('aud.remediationProblem.ownerOutOfScope');
    case 'dueAfterDeadline':
      return t('aud.remediationProblem.dueAfterDeadline', { deadline: figures.deadline ?? '' });
    case 'recommendationState':
      return t('aud.remediationProblem.recommendationState');
    case 'actionState':
      return t('aud.remediationProblem.actionState');
    case 'actionDuplicate':
      return t('aud.remediationProblem.actionDuplicate');
    case 'evidenceRequired':
      return t('aud.remediationProblem.evidenceRequired');
    case 'openActions':
      return t('aud.remediationProblem.openActions');
    case 'recoveryIncomplete':
      return t('aud.remediationProblem.recoveryIncomplete', { remaining: formatVnd(figures.remainingVnd ?? '0') });
    case 'selfApproval':
      return t('aud.remediationProblem.selfApproval');
    case 'documentNotEffective':
      return t('aud.remediationProblem.documentNotEffective');
    case 'decisionNotEffective':
      return t('aud.remediationProblem.decisionNotEffective');
    case 'engagementState':
      return t('aud.remediationProblem.engagementState');
    case 'versionConflict':
      return t('aud.remediationProblem.versionConflict');
    case 'scopeDenied':
      return t('aud.remediationProblem.scopeDenied');
    case 'validation':
      return t('aud.remediationProblem.validation');
    case 'notFound':
      return t('aud.remediationProblem.notFound');
    case 'general':
      return t('aud.remediationProblem.general');
  }
}

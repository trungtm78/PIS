import type { useTranslation } from '../../../i18n';
import type { CommandProblem, FeedbackChannel, FeedbackStatus, FormProblem, TimerStatus } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function feedbackChannelLabel(t: Translate, channel: FeedbackChannel): string {
  switch (channel) {
    case 'IN_PERSON':
      return t('lnd.feedbackChannel.inPerson.label');
    case 'LETTER':
      return t('lnd.feedbackChannel.letter.label');
    case 'PORTAL':
      return t('lnd.feedbackChannel.portal.label');
    case 'MEETING':
      return t('lnd.feedbackChannel.meeting.label');
  }
}

export function feedbackStatusLabel(t: Translate, status: FeedbackStatus): string {
  return status === 'OPEN' ? t('lnd.feedbackStatus.open.label') : t('lnd.feedbackStatus.handled.label');
}

export function timerStatusLabel(t: Translate, status: TimerStatus): string {
  switch (status) {
    case 'RUNNING':
      return t('lnd.posting.timerStatus.running.label');
    case 'SATISFIED':
      return t('lnd.posting.timerStatus.satisfied.label');
    case 'BREACHED':
      return t('lnd.posting.timerStatus.breached.label');
    case 'CANCELLED':
      return t('lnd.posting.timerStatus.cancelled.label');
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
      return t('lnd.posting.field.future.error');
    case 'early':
      return t('lnd.posting.field.early.error');
  }
}

/** The sentence for a refusal of a command; a problem the screen has no sentence for is the general one. */
export function commandProblemMessage(t: Translate, problem: CommandProblem): string {
  switch (problem) {
    case 'stateInvalid':
      return t('lnd.posting.problem.stateInvalid.error');
    case 'noItems':
      return t('lnd.posting.problem.noItems.error');
    case 'notConfirmed':
      return t('lnd.posting.problem.notConfirmed.error');
    case 'ruleUnconfirmed':
      return t('lnd.posting.problem.ruleUnconfirmed.error');
    case 'notElapsed':
      return t('lnd.posting.problem.notElapsed.error');
    case 'unresolved':
      return t('lnd.posting.problem.unresolved.error');
    case 'selfApproval':
      return t('lnd.posting.problem.selfApproval.error');
    case 'decisionRequired':
      return t('lnd.posting.problem.decisionRequired.error');
    case 'documentNotClean':
      return t('lnd.posting.problem.documentNotClean.error');
    case 'alreadyHandled':
      return t('lnd.posting.problem.alreadyHandled.error');
    case 'versionConflict':
      return t('lnd.problem.versionConflict.error');
    case 'scopeDenied':
      return t('lnd.posting.problem.scopeDenied.error');
    case 'validation':
      return t('lnd.problem.validation.error');
    case 'notFound':
      return t('lnd.problem.notFound.error');
    case 'general':
      return t('lnd.problem.general.error');
  }
}

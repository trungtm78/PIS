import type { Translator } from '../../../i18n';
import type { AttemptStatus, FailureClass, MilestoneState, ProblemReason } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function statusLabel(t: T, status: AttemptStatus): string {
  switch (status) {
    case 'Queued':
      return t('not.delivery.status.queued');
    case 'Sending':
      return t('not.delivery.status.sending');
    case 'ProviderAccepted':
      return t('not.delivery.status.accepted');
    case 'Delivered':
      return t('not.delivery.status.delivered');
    case 'Read':
      return t('not.delivery.status.read');
    case 'Failed':
      return t('not.delivery.status.failed');
    case 'Unknown':
      return t('not.delivery.status.unknown');
    case 'Cancelled':
      return t('not.delivery.status.cancelled');
    case 'Suppressed':
      return t('not.delivery.status.suppressed');
  }
}

/** A send that failed or whose result is unknown is red, one that waits grey, one that went through plain, one that was stopped amber. */
export function statusPill(status: AttemptStatus): string {
  switch (status) {
    case 'Failed':
    case 'Unknown':
      return 'pill red';
    case 'Cancelled':
    case 'Suppressed':
      return 'pill warn';
    case 'Queued':
    case 'Sending':
      return 'pill gray';
    case 'ProviderAccepted':
    case 'Delivered':
    case 'Read':
      return 'pill';
  }
}

/** The name of a channel; a channel this screen does not know is shown by its code. */
export function channelLabel(t: T, channel: string): string {
  switch (channel) {
    case 'IN_APP':
      return t('not.delivery.channel.inApp');
    case 'EMAIL':
      return t('not.delivery.channel.email');
    case 'SMS':
      return t('not.delivery.channel.sms');
    case 'PUSH_FCM':
      return t('not.delivery.channel.pushFcm');
    case 'PUSH_APNS':
      return t('not.delivery.channel.pushApns');
    case 'ZALO_OA':
      return t('not.delivery.channel.zaloOa');
    case 'ZALO_ZNS':
      return t('not.delivery.channel.zaloZns');
    case 'WHATSAPP':
      return t('not.delivery.channel.whatsapp');
    default:
      return channel;
  }
}

export function failureClassLabel(t: T, failureClass: FailureClass | null): string {
  switch (failureClass) {
    case 'RETRYABLE':
      return t('not.delivery.class.retryable');
    case 'PERMANENT':
      return t('not.delivery.class.permanent');
    case 'UNKNOWN':
      return t('not.delivery.class.unknown');
    case null:
      return t('not.delivery.class.none');
  }
}

export function milestoneLabel(t: T, state: MilestoneState): string {
  switch (state) {
    case 'delivered':
      return t('not.journey.milestone.done');
    case 'failed':
      return t('not.journey.milestone.failed');
    case 'sending':
      return t('not.journey.milestone.sending');
    case 'waiting':
      return t('not.journey.milestone.waiting');
    case 'unreached':
      return t('not.journey.milestone.unreached');
  }
}

/** The wait before a milestone, as the schedule states it: none for the first send, then 30 seconds, 2, 10 and 30 minutes. */
export function offsetLabel(t: T, seconds: number): string {
  if (seconds === 0) return t('not.journey.offset.first');
  return seconds < 60 ? t('not.journey.offset.seconds', { count: seconds }) : t('not.journey.offset.minutes', { count: seconds / 60 });
}

export function problemMessage(t: T, reason: ProblemReason): string {
  switch (reason) {
    case 'reconcile':
      return t('not.delivery.problem.reconcile');
    case 'expired':
      return t('not.delivery.problem.expired');
    case 'stateInvalid':
      return t('not.delivery.problem.stateInvalid');
    case 'conflict':
      return t('not.delivery.problem.conflict');
    case 'notFound':
      return t('not.delivery.problem.notFound');
    case 'denied':
      return t('not.delivery.problem.denied');
    case 'invalid':
      return t('not.delivery.problem.invalid');
    case 'session':
      return t('not.delivery.problem.session');
    case 'general':
      return t('not.delivery.problem.general');
  }
}

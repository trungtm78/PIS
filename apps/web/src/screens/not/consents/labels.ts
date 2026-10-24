import type { Translator } from '../../../i18n';
import type { ConsentStatus, ProblemReason } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function channelName(t: T, channel: string): string {
  switch (channel) {
    case 'EMAIL':
      return t('not.consent.channel.email');
    case 'SMS':
      return t('not.consent.channel.sms');
    case 'ZALO':
      return t('not.consent.channel.zalo');
    case 'WHATSAPP':
      return t('not.consent.channel.whatsapp');
    case 'PUSH':
      return t('not.consent.channel.push');
    default:
      return channel;
  }
}

export function purposeName(t: T, purpose: string): string {
  switch (purpose) {
    case 'OPERATIONAL':
      return t('not.consent.purpose.operational');
    case 'REMINDER':
      return t('not.consent.purpose.reminder');
    case 'ANNOUNCEMENT':
      return t('not.consent.purpose.announcement');
    case 'SUPPORT_CONVERSATION':
      return t('not.consent.purpose.support');
    default:
      return purpose;
  }
}

export function statusName(t: T, status: ConsentStatus): string {
  switch (status) {
    case 'Granted':
      return t('not.consent.status.granted');
    case 'Withdrawn':
      return t('not.consent.status.withdrawn');
    case 'Expired':
      return t('not.consent.status.expired');
  }
}

/** A consent in force is plain, one that ended is grey. */
export const statusPill = (status: ConsentStatus): string => (status === 'Granted' ? 'pill' : 'pill gray');

export function problemMessage(t: T, reason: ProblemReason): string {
  switch (reason) {
    case 'alreadyGranted':
      return t('not.consent.problem.alreadyGranted');
    case 'identity':
      return t('not.consent.problem.identity');
    case 'stale':
      return t('not.consent.problem.stale');
    case 'ended':
      return t('not.consent.problem.ended');
    case 'notFound':
      return t('not.consent.problem.notFound');
    case 'denied':
      return t('not.consent.problem.denied');
    case 'invalid':
      return t('not.consent.problem.invalid');
    case 'session':
      return t('not.consent.problem.session');
    case 'general':
      return t('not.consent.problem.general');
  }
}

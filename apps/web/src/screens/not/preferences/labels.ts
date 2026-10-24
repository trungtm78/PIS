import type { Translator } from '../../../i18n';
import type { DigestMode, PreferenceChannel, ProblemReason } from './model';
import { ALL_CATEGORIES } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function channelName(t: T, channel: PreferenceChannel): string {
  switch (channel) {
    case 'IN_APP':
      return t('not.pref.channel.inApp');
    case 'EMAIL':
      return t('not.pref.channel.email');
    case 'PUSH':
      return t('not.pref.channel.push');
    case 'SMS':
      return t('not.pref.channel.sms');
    case 'ZALO':
      return t('not.pref.channel.zalo');
    case 'WHATSAPP':
      return t('not.pref.channel.whatsapp');
  }
}

export function digestName(t: T, mode: DigestMode): string {
  switch (mode) {
    case 'IMMEDIATE':
      return t('not.pref.digest.immediate');
    case 'HOURLY':
      return t('not.pref.digest.hourly');
    case 'DAILY':
      return t('not.pref.digest.daily');
  }
}

/** The name of a category: every category, or the module-level name of the events (shown by its code). */
export const categoryName = (t: T, category: string): string => (category === ALL_CATEGORIES ? t('not.pref.category.all') : category);

export function problemMessage(t: T, reason: ProblemReason): string {
  switch (reason) {
    case 'locked':
      return t('not.pref.problem.locked');
    case 'stale':
      return t('not.pref.problem.stale');
    case 'invalid':
      return t('not.pref.problem.invalid');
    case 'denied':
      return t('not.pref.problem.denied');
    case 'session':
      return t('not.pref.problem.session');
    case 'general':
      return t('not.pref.problem.general');
  }
}

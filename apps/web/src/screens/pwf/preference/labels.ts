import type { Translator } from '../../../i18n';
import { MAX_REMINDERS } from '../bands/band-model';
import type { Thresholds } from '../bands/band-model';
import type { Level, PreferenceProblem, PreferenceRefusal } from './model';

type T = Translator['t'];

// Each key is written out in a switch so that the i18n check can see it is in use.

export function levelWord(t: T, level: Level): string {
  switch (level) {
    case 'green_days':
      return t('pwf.pref.level.green.word');
    case 'yellow_days':
      return t('pwf.pref.level.yellow.word');
    case 'red_days':
      return t('pwf.pref.level.red.word');
  }
}

export function levelLabel(t: T, level: Level): string {
  switch (level) {
    case 'green_days':
      return t('pwf.pref.green.label');
    case 'yellow_days':
      return t('pwf.pref.yellow.label');
    case 'red_days':
      return t('pwf.pref.red.label');
  }
}

/** "official: 5" beside a level; a green line the official policy does not set says so. */
export function officialText(t: T, level: Level, official: Thresholds): string {
  const value = official[level];
  return value === null ? t('pwf.pref.officialNone.text') : t('pwf.pref.official.text', { value });
}

/** A problem of the form, found before anything is sent. */
export function problemText(t: T, problem: PreferenceProblem): string {
  switch (problem.kind) {
    case 'integer':
      return t('pwf.pref.problem.integer.error');
    case 'range':
      return t('pwf.pref.problem.range.error', { min: problem.min ?? 0, max: problem.max ?? 0 });
    case 'order':
      return problem.path === 'green_days' ? t('pwf.pref.problem.orderGreen.error') : t('pwf.pref.problem.orderYellow.error');
    case 'notEarlier':
      return t('pwf.pref.problem.notEarlier.error', { official: problem.official ?? 0 });
    case 'listSize':
      return t('pwf.pref.problem.listSize.error', { max: problem.max ?? MAX_REMINDERS });
    case 'reminderOrder':
      return t('pwf.pref.problem.reminderOrder.error');
    case 'reminderNotEarlier':
      return t('pwf.pref.problem.reminderNotEarlier.error', { official: problem.official ?? 0 });
  }
}

/** A refusal of the save, in the words of this screen. */
export function refusalText(t: T, refusal: PreferenceRefusal): string {
  switch (refusal.kind) {
    case 'conflict':
      return t('pwf.pref.refusal.conflict.error');
    case 'order':
      return t('pwf.pref.refusal.order.error');
    case 'notEarlier':
      return t('pwf.pref.refusal.notEarlier.error');
    case 'denied':
      return t('pwf.pref.refusal.denied.error');
    case 'validation':
      return t('pwf.pref.refusal.validation.error');
    case 'general':
      return t('pwf.pref.refusal.general.error');
  }
}

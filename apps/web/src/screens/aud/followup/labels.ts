import type { Translator } from '../../../i18n';
import type { Level } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function levelLabel(t: T, level: Level): string {
  switch (level) {
    case 'dueSoon':
      return t('aud.followup.level.dueSoon');
    case 'leader':
      return t('aud.followup.level.leader');
    case 'second':
      return t('aud.followup.level.second');
  }
}

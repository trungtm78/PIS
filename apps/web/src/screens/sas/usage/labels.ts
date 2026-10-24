import type { Translator } from '../../../i18n';
import type { Level } from './model';

type T = Translator['t'];

/** What a counter counts, in the words of the screens; a counter the screen does not know is shown as the server wrote it. */
export function counterLabel(t: T, counter: string): string {
  switch (counter) {
    case 'notification.messages':
      return t('sas.usage.counter.messages');
    case 'ai.tokens':
      return t('sas.usage.counter.ai');
    case 'storage.gb_day':
      return t('sas.usage.counter.storage');
    case 'bi.queries':
      return t('sas.usage.counter.bi');
    default:
      return counter;
  }
}

export function unitLabel(t: T, unit: string): string {
  switch (unit) {
    case 'message':
      return t('sas.usage.unit.message');
    case 'token':
      return t('sas.usage.unit.token');
    case 'gb_day':
      return t('sas.usage.unit.gbDay');
    case 'query':
      return t('sas.usage.unit.query');
    default:
      return unit;
  }
}

export function levelLabel(t: T, level: Level): string {
  switch (level) {
    case 'ok':
      return t('sas.usage.level.ok');
    case 'near':
      return t('sas.usage.level.near');
    case 'full':
      return t('sas.usage.level.full');
    case 'over':
      return t('sas.usage.level.over');
    case 'none':
      return t('sas.usage.level.none');
  }
}

/** The tone of a pill by level; the label says the same in words, so colour never carries the meaning alone. */
export function levelTone(level: Level): 'ok' | 'warn' | 'red' | 'gray' {
  switch (level) {
    case 'ok':
      return 'ok';
    case 'near':
      return 'warn';
    case 'full':
    case 'over':
      return 'red';
    case 'none':
      return 'gray';
  }
}

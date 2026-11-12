import type { Translator } from '../../../i18n';
import { unitWord } from '../labels';
import type { BandUnit } from '../model';
import { sentenceOf } from './band-model';
import type { Thresholds } from './band-model';

type T = Translator['t'];

/**
 * The ladder in the owner's words, with the unit of the source ("5 working days left: green, 2 working days left: yellow, under 1 working day: red").
 * The policy editor (PWF-08) and the personal reminders (PWF-15) say a ladder with the same words.
 */
export function sentenceText(t: T, thresholds: Thresholds, unit: BandUnit): string {
  const word = unitWord(t, unit);
  const sentence = sentenceOf(thresholds);
  const green = sentence.green.kind === 'upTo' ? t('pwf.bands.part.green.text', { days: sentence.green.days, unit: word }) : t('pwf.bands.part.greenOpen.text', { days: sentence.green.days, unit: word });
  const yellow = t('pwf.bands.part.yellow.text', { days: sentence.yellow.days, unit: word });
  const red = sentence.red.kind === 'under' ? t('pwf.bands.part.red.text', { days: sentence.red.days, unit: word }) : t('pwf.bands.part.redOverdue.text');
  const text = [green, yellow, red].join(', ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

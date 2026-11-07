import type { Tone } from '../../ui';

/** The tone of a pill from the word the screen's own rules give it ("green", "warn", "gray", "red"); the text of the pill is always written too. */
const TONES: Readonly<Record<string, Tone>> = { green: 'success', '': 'success', warn: 'warning', gray: 'neutral', red: 'danger' };

export const pillTone = (word: string): Tone => TONES[word] ?? 'neutral';

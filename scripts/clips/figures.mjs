import { loadNumerals } from './common.mjs';
import { decimalToWords } from './numbers.mjs';

/** A placeholder in a narration or caption: the figure comes from the data manifest at record time, never from the text. */
export const FIGURE_PATTERN = /\{\{figure:([a-z0-9][a-z0-9-]*)\}\}/gu;

export const FIGURE_KINDS = ['count', 'percent', 'money-billion', 'days', 'text'];

export function figureIds(text) {
  return [...text.matchAll(FIGURE_PATTERN)].map((found) => found[1]);
}

/** A number with a decimal comma and a fixed count of decimals (`72,5`). */
function commaNumber(value, digits) {
  return Number(value).toFixed(digits).replace('.', ',');
}

/** How a figure is shown (subtitles, captions) and how it is spoken (TTS). */
export function formatFigure(kind, value, digits, numerals = loadNumerals()) {
  if (!FIGURE_KINDS.includes(kind)) throw new Error(`unknown figure kind ${kind}`);
  const unit = numerals.units[kind];
  if (kind === 'text') return { display: String(value), speech: String(value) };
  if (value === null || value === undefined || Number.isNaN(Number(value))) throw new Error(`a ${kind} figure needs a number, got ${String(value)}`);
  const decimals = kind === 'count' || kind === 'days' ? 0 : digits;
  const number = commaNumber(value, decimals);
  const spoken = decimalToWords(number.replace('-', ''), numerals);
  const sign = Number(value) < 0 ? `${numerals.negative} ` : '';
  const display = `${number}${unit.display}`;
  const speech = `${sign}${spoken}${unit.speech === '' ? '' : ` ${unit.speech}`}`;
  return { display, speech };
}

/**
 * Replaces every `{{figure:id}}` of a text. `mode` is `display` or `speech` (values from the manifest: a figure with no value is an error, a value is never invented)
 * or `sample` / `sample-speech` (the nominal sample of the declaration, used only to estimate durations at authoring time).
 */
export function resolveFigures(text, declarations, manifest, mode = 'display', numerals = loadNumerals()) {
  return text.replace(FIGURE_PATTERN, (_, id) => {
    const declaration = declarations[id];
    if (declaration === undefined) throw new Error(`figure ${id} is not declared in the scenario`);
    const sampled = mode.startsWith('sample');
    let value;
    if (sampled) {
      value = declaration.sample;
    } else {
      const entry = manifest?.figures?.[id];
      if (entry === undefined || entry.value === undefined || entry.value === null) throw new Error(`figure ${id} has no value in the data manifest (figures come from the seeded data, never from the script)`);
      value = entry.value;
    }
    const formatted = formatFigure(declaration.kind, value, declaration.digits ?? 1, numerals);
    return mode.endsWith('speech') ? formatted.speech : formatted.display;
  });
}

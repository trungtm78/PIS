import { loadNumerals, loadPhonetics, loadSpec } from './common.mjs';
import { resolveFigures } from './figures.mjs';
import { numbersToSpeech } from './numbers.mjs';
import { applyPhonetics } from './phonetics.mjs';

/**
 * The text sent to TTS: figures resolved to words, numbers spelled out, foreign words respelled. The subtitles never use this text.
 * `mode` is `manifest` (record time, values from the data manifest) or `sample` (authoring time, nominal values for duration estimates).
 */
export function speechText(narration, { figures = {}, manifest, mode = 'manifest', phonetics = loadPhonetics(), numerals = loadNumerals() } = {}) {
  const resolved = resolveFigures(narration, figures, manifest, mode === 'sample' ? 'sample-speech' : 'speech', numerals);
  return applyPhonetics(numbersToSpeech(resolved, numerals), phonetics).replace(/\s+/gu, ' ').trim();
}

/** The text of subtitles and captions: the figures resolved, the words exactly as written. */
export function displayText(text, { figures = {}, manifest, mode = 'manifest' } = {}) {
  return resolveFigures(text, figures, manifest, mode === 'sample' ? 'sample' : 'display');
}

/** Sentences of a text, each keeping its closing punctuation. */
export function sentencesOf(text) {
  return (text.match(/[^.!?;…]+(?:[.!?;…]+|$)/gu) ?? []).map((part) => part.trim()).filter((part) => part !== '');
}

/** Syllables of a spoken text: Vietnamese writes one syllable per word, and a hyphen of the respelling joins syllables. */
export function syllableCount(text) {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

/** The length of the voice for a spoken text, estimated (the measured length of the audio replaces it at record time). */
export function estimateVoiceMs(spoken, speed = 1, spec = loadSpec()) {
  const rate = spec.narration.syllablesPerSecondAtSpeed1 * speed;
  const sentences = Math.max(1, sentencesOf(spoken).length);
  return Math.round((syllableCount(spoken) / rate) * 1000 + (sentences - 1) * spec.narration.sentencePauseMs);
}

/** The length of a scene: the voice with the lead-in and the tail, but not less than the shortest scene a viewer can follow. */
export function sceneMsFromVoice(voiceMs, spec = loadSpec()) {
  return Math.max(spec.narration.minSceneSec * 1000, voiceMs + spec.narration.leadInMs + spec.narration.tailMs);
}

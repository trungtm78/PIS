import { loadPhonetics } from './common.mjs';

const LETTERS = /[\p{L}\p{N}]+/gu;
const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}])';
const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}])';

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

function patternFor(terms) {
  const alternatives = [...terms].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return alternatives.length === 0 ? null : alternatives.join('|');
}

/** Applies the respelling table to a text for TTS: exact (case-sensitive) terms first, then the any-case terms; the output of a replacement is never replaced again. */
export function applyPhonetics(text, table = loadPhonetics()) {
  const exact = new Map(table.terms.filter((entry) => entry.caseInsensitive !== true).map((entry) => [entry.term, entry.say]));
  const loose = new Map(table.terms.filter((entry) => entry.caseInsensitive === true).map((entry) => [entry.term.toLowerCase(), entry.say]));
  let segments = [{ text, done: false }];
  const pass = (map, flags, key) => {
    const body = patternFor([...map.keys()]);
    if (body === null) return;
    const regex = new RegExp(`${BOUNDARY_BEFORE}(?:${body})${BOUNDARY_AFTER}`, flags);
    segments = segments.flatMap((segment) => {
      if (segment.done) return [segment];
      const out = [];
      let last = 0;
      for (const found of segment.text.matchAll(regex)) {
        if (found.index > last) out.push({ text: segment.text.slice(last, found.index), done: false });
        out.push({ text: map.get(key(found[0])), done: true });
        last = found.index + found[0].length;
      }
      if (last < segment.text.length) out.push({ text: segment.text.slice(last), done: false });
      return out;
    });
  };
  pass(exact, 'gu', (value) => value);
  pass(loose, 'giu', (value) => value.toLowerCase());
  return segments.map((segment) => segment.text).join('');
}

const TONES = /[\u0300\u0301\u0303\u0309\u0323]/gu;
const SYLLABLE = /^(ngh|ng|gh|gi|ch|kh|nh|ph|qu|th|tr|[bcd\u0111ghklmnprstvx])?[a\u0103\u00e2e\u00eaio\u00f4\u01a1u\u01b0y]{1,3}(ch|ng|nh|c|m|n|p|t)?$/u;

/** Whether a lower case token can be one Vietnamese syllable (tones ignored). It is a spelling test, not a dictionary. */
export function isVietnameseSyllable(token) {
  const bare = token.normalize('NFD').replace(TONES, '').normalize('NFC').toLowerCase();
  return SYLLABLE.test(bare);
}

/** Tokens of a text that a Vietnamese voice would not read right as written: acronyms, tokens with digits and letters, and spellings that cannot be a Vietnamese syllable. */
export function foreignTokens(text) {
  const found = new Set();
  for (const [token] of text.matchAll(LETTERS)) {
    if (/^\d+$/u.test(token)) continue;
    const upper = (token.match(/\p{Lu}/gu) ?? []).length;
    const acronym = token.length > 1 && (upper >= 2 || /\d/u.test(token));
    if (acronym || !isVietnameseSyllable(token)) found.add(token);
  }
  return [...found];
}

/** Foreign tokens that the table does not cover (after the table is applied). */
export function uncoveredTerms(text, table = loadPhonetics()) {
  return foreignTokens(applyPhonetics(text, table)).filter((token) => !(table.passThrough ?? []).includes(token));
}

import { DomainError } from './errors.ts';

const MAX_PATTERN_LENGTH = 200;
const TOKEN = /\{([^{}]*)\}/g;
const ALLOWED_TOKENS = ['number', 'type', 'agency', 'unit'] as const;
type SymbolToken = (typeof ALLOWED_TOKENS)[number];
// A letter right behind the number ("12a/...") is the a/b suffix BR-DOC-03 forbids, and so is a token right behind it: the
// value it stands for could be a letter. The number is followed by a separator or by nothing.
const LETTER_SUFFIX = /\{number\}[\p{L}{]/u;
const UNSAFE_VALUE = /[\s/{}]/;
// Vietnam is UTC+7 all year (no daylight saving), so the offset can be applied as plain arithmetic.
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

export interface SymbolParts {
  number: number;
  type?: string;
  agency?: string;
  unit?: string;
}

/** BR-DOC-06: a number below ten shows two digits, the stored value stays an integer. */
export function formatRegisterNumber(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('a register number is a positive integer');
  return value < 10 ? `0${value}` : String(value);
}

/**
 * A symbol pattern (`doc_type.symbol_pattern`, BR-DOC-05) holds exactly one `{number}` and may use `{type}`, `{agency}`
 * and `{unit}`; the number never carries an a/b suffix (BR-DOC-03).
 */
export function validateSymbolPattern(pattern: string): void {
  const invalid = (detail: string): DomainError => new DomainError('SYMBOL_PATTERN_INVALID', 409, detail);
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) throw invalid('symbol_pattern');
  if (hasControlCharacter(pattern)) throw invalid('symbol_pattern');
  const withoutTokens = pattern.replace(TOKEN, '');
  if (withoutTokens.includes('{') || withoutTokens.includes('}')) throw invalid('symbol_pattern');
  const tokens = [...pattern.matchAll(TOKEN)].map((match) => match[1] ?? '');
  if (tokens.some((token) => !(ALLOWED_TOKENS as readonly string[]).includes(token))) throw invalid('symbol_pattern');
  if (tokens.filter((token) => token === 'number').length !== 1) throw invalid('symbol_pattern');
  if (LETTER_SUFFIX.test(pattern)) throw invalid('symbol_pattern');
}

/** Builds the symbol of a document ("05/QD-UBND") from a pattern and the parts of the register entry. */
export function buildSymbol(pattern: string, parts: SymbolParts): string {
  validateSymbolPattern(pattern);
  return pattern.replace(TOKEN, (_match, name: string) => {
    const token = name as SymbolToken;
    if (token === 'number') return formatRegisterNumber(parts.number);
    const value = parts[token];
    if (value === undefined || value === '' || UNSAFE_VALUE.test(value) || hasControlCharacter(value)) throw new DomainError('SYMBOL_FORMAT_INVALID', 409, token);
    return value;
  });
}

function vietnamDate(instant: Date): Date {
  if (Number.isNaN(instant.getTime())) throw new RangeError('invalid date');
  return new Date(instant.getTime() + VIETNAM_OFFSET_MS);
}

/** The calendar year of an instant in Asia/Ho_Chi_Minh (BR-DOC-02: the year of a number is the year of its issue date). */
export function vietnamYearOf(instant: Date): number {
  return vietnamDate(instant).getUTCFullYear();
}

/** The calendar date `YYYY-MM-DD` of an instant in Asia/Ho_Chi_Minh. */
export function vietnamDateOf(instant: Date): string {
  return vietnamDate(instant).toISOString().slice(0, 10);
}

/** The moment of a signature as the line under the signature shows it (BR-DOC-13): ISO 8601 in the zone of Vietnam, `2026-10-22T09:15:30+07:00`. */
export function signingTimeText(instant: Date): string {
  return `${vietnamDate(instant).toISOString().slice(0, 19)}+07:00`;
}

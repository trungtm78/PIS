import { vietnameseData } from './vietnamese-data.ts';

export const PROHIBITED_CATEGORIES = ['PERSONAL_ATTRIBUTE', 'REGION'] as const;
export type ProhibitedCategory = (typeof PROHIBITED_CATEGORIES)[number];

/** One kind of criterion that may not be asked of a contractor, with the terms that name it and the law that forbids it. */
export interface ProhibitedRule {
  code: string;
  category: ProhibitedCategory;
  /** Phrases as written; they are matched on whole words, without regard to case or Vietnamese accents. */
  terms: readonly string[];
  legalBasis: string;
}

/**
 * The criteria that BID 3 F4 refuses (BR-BID-11: personal characteristics that have nothing to do with the work, and the region). The list is
 * data with its legal basis: a rule is added here when the legal department asks for it, and the approval of a version judges the list again,
 * so a version drafted before a rule was added cannot be approved. The basis names the principle the law states (fair competition, no
 * restriction of participation); the article that fits each rule is for the legal department to confirm (TODOS.md, ST-BID-003, CXN-BID-01).
 */
const TEXT = vietnameseData<{ basis: string; terms: Record<string, readonly string[]> }>('bid-criteria-rules');
const BASIS = TEXT.basis;
/** The phrases of a rule as written in the data file (Vietnamese phrases with their English counterparts). */
const termsOf = (code: string): readonly string[] => TEXT.terms[code] ?? [];

export const PROHIBITED_RULES: readonly ProhibitedRule[] = [
  { code: 'GENDER', category: 'PERSONAL_ATTRIBUTE', terms: termsOf('GENDER'), legalBasis: BASIS },
  { code: 'ETHNICITY', category: 'PERSONAL_ATTRIBUTE', terms: termsOf('ETHNICITY'), legalBasis: BASIS },
  { code: 'RELIGION', category: 'PERSONAL_ATTRIBUTE', terms: termsOf('RELIGION'), legalBasis: BASIS },
  { code: 'MARITAL_STATUS', category: 'PERSONAL_ATTRIBUTE', terms: termsOf('MARITAL_STATUS'), legalBasis: BASIS },
  { code: 'AGE', category: 'PERSONAL_ATTRIBUTE', terms: termsOf('AGE'), legalBasis: BASIS },
  { code: 'ORIGIN', category: 'PERSONAL_ATTRIBUTE', terms: termsOf('ORIGIN'), legalBasis: BASIS },
  { code: 'LOCAL_PRESENCE', category: 'REGION', terms: termsOf('LOCAL_PRESENCE'), legalBasis: BASIS },
];

/** Text as it is matched: lower case, without accents, every run of non-letters one space, so a text with accents and capitals and the same text typed without accents are the same. */
export function normalizedForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/\u0111/gi, 'd') // the Vietnamese letter d-with-stroke (and its upper case)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const COMPILED = PROHIBITED_RULES.map((rule) => ({ rule, terms: rule.terms.map((term) => ` ${normalizedForMatch(term)} `) }));

/** The rule a text falls under, if any: a term of the rule appears in it as whole words. */
export function prohibitedRuleOf(text: string): ProhibitedRule | undefined {
  const padded = ` ${normalizedForMatch(text)} `;
  return COMPILED.find((candidate) => candidate.terms.some((term) => padded.includes(term)))?.rule;
}

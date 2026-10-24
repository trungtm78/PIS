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
const BASIS = 'Luật Đấu thầu 22/2023/QH15 và Nghị định 214/2025/NĐ-CP: cạnh tranh công bằng, không hạn chế sự tham gia của nhà thầu [CXN-BID-01]';

export const PROHIBITED_RULES: readonly ProhibitedRule[] = [
  { code: 'GENDER', category: 'PERSONAL_ATTRIBUTE', terms: ['giới tính', 'nam giới', 'nữ giới', 'gender'], legalBasis: BASIS },
  { code: 'ETHNICITY', category: 'PERSONAL_ATTRIBUTE', terms: ['dân tộc', 'ethnicity', 'ethnic origin'], legalBasis: BASIS },
  { code: 'RELIGION', category: 'PERSONAL_ATTRIBUTE', terms: ['tôn giáo', 'tín ngưỡng', 'religion'], legalBasis: BASIS },
  { code: 'MARITAL_STATUS', category: 'PERSONAL_ATTRIBUTE', terms: ['tình trạng hôn nhân', 'đã kết hôn', 'độc thân', 'marital status'], legalBasis: BASIS },
  { code: 'AGE', category: 'PERSONAL_ATTRIBUTE', terms: ['độ tuổi', 'tuổi đời', 'age of the director'], legalBasis: BASIS },
  { code: 'ORIGIN', category: 'PERSONAL_ATTRIBUTE', terms: ['quê quán', 'nơi sinh', 'hộ khẩu', 'place of birth'], legalBasis: BASIS },
  {
    code: 'LOCAL_PRESENCE',
    category: 'REGION',
    terms: [
      'người địa phương',
      'doanh nghiệp địa phương',
      'nhà thầu địa phương',
      'nhà thầu trong tỉnh',
      'trụ sở tại địa phương',
      'trụ sở trong tỉnh',
      'local person',
      'local resident',
      'local contractor',
    ],
    legalBasis: BASIS,
  },
];

/** Text as it is matched: lower case, without accents, every run of non-letters one space, so "Giám đốc là NGƯỜI địa-phương" and "giam doc la nguoi dia phuong" are the same. */
export function normalizedForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/gi, 'd')
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

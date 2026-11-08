import { DomainError } from './errors.ts';
import { MIN_QUOTE_CHARS, normaliseQuote } from './bid-analysis.ts';
import { FEASIBILITY_SECTIONS, SOURCE_KINDS, materialKey, restoreQuote } from './ai-assist.ts';
import type { AssistKind, ReadableIndex, SourceKind } from './ai-assist.ts';

/**
 * What is checked after the model has answered (AI.01, AI.02, AI.04, AI.05): every statement is labelled SOURCE, ASSUMPTION or INFERENCE and what carries the label is verified, not believed. A citation counts only when the
 * source it names is among those the asker may read, the part it points at exists, and the words it quotes are in that part; one that points at anything else is dropped and only counted, so that the answer can never
 * show, nor reveal the existence of, a record the asker cannot read. A statement that says SOURCE and has no citation that holds is presented as unsupported; an inference rests on the statements it lists; an assumption
 * is shown as an assumption. The checks of a checklist and the total of an evaluation are computed here, in code, from what was verified: the model proposes, it does not score. Pure functions of their input.
 */

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATEMENT_ID = /^s[0-9]{1,3}$/;
const EXCERPT_CHARS = 300;
export const MAX_STATEMENTS = 60;
export const MAX_STATEMENT_CHARS = 1500;
export const MAX_CITATIONS_PER_STATEMENT = 5;

export type Basis = 'SOURCE' | 'ASSUMPTION' | 'INFERENCE';
export type StatementVerification = 'VERIFIED' | 'UNSUPPORTED' | 'ASSUMPTION_OPEN';
export const STATEMENT_BASES: readonly Basis[] = ['SOURCE', 'ASSUMPTION', 'INFERENCE'];

export interface CheckedCitation {
  kind: SourceKind;
  id: string;
  locator: string;
  /** The words the model quoted, when they were found in the part. */
  quote: string | null;
  /** The beginning of the part the citation points at, so that a reader sees what it rests on. */
  excerpt: string;
  title: string;
}

export interface CheckedStatement {
  id: string;
  text: string;
  /** What the model said it is. */
  claimed_basis: Basis;
  /** What it is shown as: its own label when it holds, `UNSUPPORTED` when a SOURCE or an INFERENCE does not. */
  presented_as: Basis | 'UNSUPPORTED';
  verification: StatementVerification;
  citations: CheckedCitation[];
  depends_on: string[];
  problems: string[];
  section: string | null;
  item_code: string | null;
  criterion_code: string | null;
  result: 'PASS' | 'FAIL' | 'UNKNOWN' | null;
  score: number | null;
}

export type CitationProblem = 'NOT_READABLE' | 'LOCATOR_MISSING' | 'QUOTE_NOT_FOUND' | 'MALFORMED';

/**
 * Verifies one citation against what the asker may read. An id that is not in the index is `NOT_READABLE` whether the record does not exist, belongs to another tenant or is outside the scope of the asker: the
 * answer is the same, so a citation cannot be used to find out which. A quote is only demanded of a document (a record has fields, not words to quote) and is present when its words are in the part.
 */
export function checkCitation(raw: unknown, index: ReadableIndex): { ok: true; citation: CheckedCitation } | { ok: false; problem: CitationProblem } {
  if (!isRecord(raw)) return { ok: false, problem: 'MALFORMED' };
  const { kind, id, locator, quote } = raw;
  if (typeof kind !== 'string' || !(SOURCE_KINDS as readonly string[]).includes(kind) || typeof id !== 'string' || !UUID.test(id) || typeof locator !== 'string' || locator === '') return { ok: false, problem: 'MALFORMED' };
  if (quote !== undefined && typeof quote !== 'string') return { ok: false, problem: 'MALFORMED' };
  const material = index.get(materialKey(kind, id));
  if (material === undefined) return { ok: false, problem: 'NOT_READABLE' };
  const part = material.parts.find((candidate) => candidate.locator === locator);
  if (part === undefined) return { ok: false, problem: 'LOCATOR_MISSING' };
  let found: string | null = null;
  if (quote !== undefined && quote.trim() !== '') {
    const wanted = normaliseQuote(restoreQuote(quote));
    if (wanted.length < MIN_QUOTE_CHARS || !normaliseQuote(part.text).includes(wanted)) return { ok: false, problem: 'QUOTE_NOT_FOUND' };
    found = quote.trim();
  } else if (material.kind === 'DOCUMENT_VERSION') {
    // A document is cited with the words that support the statement: a page number alone proves nothing.
    return { ok: false, problem: 'QUOTE_NOT_FOUND' };
  }
  return { ok: true, citation: { kind: material.kind, id: material.id, locator, quote: found, excerpt: [...part.text].slice(0, EXCERPT_CHARS).join(''), title: material.title } };
}

export interface VerifiedAnswer {
  statements: CheckedStatement[];
  openQuestions: string[];
  counts: { statements: number; verified: number; unsupported: number; assumptions: number; withheldCitations: number };
  /** FULL: no statement is unsupported (assumptions are labelled, not hidden). PARTIAL: some are, some are not. NONE: nothing is supported. */
  completeness: 'FULL' | 'PARTIAL' | 'NONE';
}

const cap = (text: string): string => text.trim();
const optionalText = (value: unknown, max: number): string | null | undefined => {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '' || [...value].length > max) return undefined;
  return value.trim();
};

/**
 * The answer of the gateway, parsed and verified against what the asker may read. An answer that is not an object with a list of statements of the shape the contract says is `OUTPUT_INVALID` (the gateway already checks
 * the schema of the profile; this is the second look, because a profile may be looser than the contract). Dependencies of an inference name earlier statements only.
 */
export function parseAndVerifyAnswer(output: string, index: ReadableIndex): { ok: true; value: VerifiedAnswer } | { ok: false; code: 'OUTPUT_INVALID' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { ok: false, code: 'OUTPUT_INVALID' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.statements) || parsed.statements.length > MAX_STATEMENTS) return { ok: false, code: 'OUTPUT_INVALID' };
  const statements: CheckedStatement[] = [];
  const byId = new Map<string, CheckedStatement>();
  let withheld = 0;
  for (const raw of parsed.statements) {
    if (!isRecord(raw)) return { ok: false, code: 'OUTPUT_INVALID' };
    const { id, text, basis, citations, depends_on: dependsOn } = raw;
    if (typeof id !== 'string' || !STATEMENT_ID.test(id) || byId.has(id)) return { ok: false, code: 'OUTPUT_INVALID' };
    if (typeof text !== 'string' || cap(text) === '' || [...text].length > MAX_STATEMENT_CHARS) return { ok: false, code: 'OUTPUT_INVALID' };
    if (typeof basis !== 'string' || !(STATEMENT_BASES as readonly string[]).includes(basis)) return { ok: false, code: 'OUTPUT_INVALID' };
    if (!Array.isArray(citations) || citations.length > MAX_CITATIONS_PER_STATEMENT) return { ok: false, code: 'OUTPUT_INVALID' };
    if (dependsOn !== undefined && (!Array.isArray(dependsOn) || dependsOn.length > 10 || dependsOn.some((entry) => typeof entry !== 'string' || !STATEMENT_ID.test(entry)))) return { ok: false, code: 'OUTPUT_INVALID' };
    const section = optionalText(raw.section, 40);
    const itemCode = optionalText(raw.item_code, 40);
    const criterionCode = optionalText(raw.criterion_code, 40);
    if (section === undefined || itemCode === undefined || criterionCode === undefined) return { ok: false, code: 'OUTPUT_INVALID' };
    if (section !== null && !(FEASIBILITY_SECTIONS as readonly string[]).includes(section)) return { ok: false, code: 'OUTPUT_INVALID' };
    const result = raw.result === undefined ? null : raw.result;
    if (result !== null && result !== 'PASS' && result !== 'FAIL' && result !== 'UNKNOWN') return { ok: false, code: 'OUTPUT_INVALID' };
    const score = raw.score === undefined ? null : raw.score;
    if (score !== null && !(typeof score === 'number' && Number.isInteger(score) && score >= 0 && score <= 1000)) return { ok: false, code: 'OUTPUT_INVALID' };

    const problems: string[] = [];
    const kept: CheckedCitation[] = [];
    for (const entry of citations) {
      const checked = checkCitation(entry, index);
      if (checked.ok) {
        if (!kept.some((citation) => citation.kind === checked.citation.kind && citation.id === checked.citation.id && citation.locator === checked.citation.locator)) kept.push(checked.citation);
      } else {
        withheld += 1;
        // The kind of the problem, never the id: an id the asker cannot read is not repeated.
        problems.push(`CITATION_${checked.problem}`);
      }
    }
    const deps = [...new Set((dependsOn as string[] | undefined) ?? [])];
    const claimed = basis as Basis;
    let verification: StatementVerification;
    let presented: CheckedStatement['presented_as'] = claimed;
    let effective = kept;
    if (claimed === 'SOURCE') {
      verification = kept.length > 0 ? 'VERIFIED' : 'UNSUPPORTED';
    } else if (claimed === 'ASSUMPTION') {
      verification = 'ASSUMPTION_OPEN';
    } else {
      const known = deps.map((dependency) => byId.get(dependency));
      if (deps.length === 0 || known.some((entry) => entry === undefined)) {
        verification = 'UNSUPPORTED';
        problems.push('INFERENCE_WITHOUT_BASIS');
      } else {
        const parents = known as CheckedStatement[];
        if (parents.every((parent) => parent.verification === 'VERIFIED')) verification = 'VERIFIED';
        else if (parents.every((parent) => parent.verification !== 'UNSUPPORTED')) verification = 'ASSUMPTION_OPEN';
        else {
          verification = 'UNSUPPORTED';
          problems.push('INFERENCE_RESTS_ON_UNSUPPORTED');
        }
        effective = mergeCitations([...parents.flatMap((parent) => parent.citations), ...kept]);
      }
    }
    if (verification === 'UNSUPPORTED') {
      presented = 'UNSUPPORTED';
      if (claimed === 'SOURCE') problems.push('SOURCE_WITHOUT_CITATION');
    }
    const statement: CheckedStatement = {
      id,
      text: cap(text),
      claimed_basis: claimed,
      presented_as: presented,
      verification,
      citations: effective,
      depends_on: deps,
      problems: [...new Set(problems)],
      section,
      item_code: itemCode,
      criterion_code: criterionCode,
      result,
      score,
    };
    statements.push(statement);
    byId.set(id, statement);
  }
  const openQuestions = Array.isArray(parsed.open_questions) ? parsed.open_questions.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '' && [...entry].length <= 500).map(cap).slice(0, 10) : [];
  const verified = statements.filter((statement) => statement.verification === 'VERIFIED').length;
  const unsupported = statements.filter((statement) => statement.verification === 'UNSUPPORTED').length;
  const assumptions = statements.filter((statement) => statement.verification === 'ASSUMPTION_OPEN').length;
  const completeness = statements.length === 0 || verified + assumptions === 0 ? 'NONE' : unsupported === 0 ? 'FULL' : 'PARTIAL';
  return { ok: true, value: { statements, openQuestions, counts: { statements: statements.length, verified, unsupported, assumptions, withheldCitations: withheld }, completeness } };
}

function mergeCitations(citations: readonly CheckedCitation[]): CheckedCitation[] {
  const seen = new Set<string>();
  const merged: CheckedCitation[] = [];
  for (const citation of citations) {
    const key = `${citation.kind}:${citation.id}:${citation.locator}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(citation);
    }
  }
  return merged;
}

/**
 * Checks the citations of a statement stored earlier against what the reader may read now: a source the reader cannot read any more (or never could) is taken out, and the statement is shown as it stands without it.
 * A SOURCE left with no citation is shown as unsupported. This is what keeps a stored run from showing a record to someone who has lost the right to read it.
 */
export function reverifyStatements(statements: readonly CheckedStatement[], index: ReadableIndex): { statements: CheckedStatement[]; withheld: number } {
  let withheld = 0;
  const out: CheckedStatement[] = [];
  const byId = new Map<string, CheckedStatement>();
  for (const statement of statements) {
    const kept = statement.citations.filter((citation) => index.has(materialKey(citation.kind, citation.id)));
    withheld += statement.citations.length - kept.length;
    let next: CheckedStatement = { ...statement, citations: kept };
    if (statement.claimed_basis === 'SOURCE' && kept.length === 0 && statement.verification === 'VERIFIED') {
      next = { ...next, verification: 'UNSUPPORTED', presented_as: 'UNSUPPORTED', problems: [...new Set([...statement.problems, 'CITATION_NOT_READABLE', 'SOURCE_WITHOUT_CITATION'])] };
    } else if (kept.length < statement.citations.length) {
      next = { ...next, problems: [...new Set([...statement.problems, 'CITATION_NOT_READABLE'])] };
    }
    if (statement.claimed_basis === 'INFERENCE' && statement.verification !== 'UNSUPPORTED') {
      const parents = statement.depends_on.map((dependency) => byId.get(dependency));
      if (parents.some((parent) => parent?.verification === 'UNSUPPORTED')) next = { ...next, verification: 'UNSUPPORTED', presented_as: 'UNSUPPORTED', problems: [...new Set([...next.problems, 'INFERENCE_RESTS_ON_UNSUPPORTED'])] };
    }
    out.push(next);
    byId.set(next.id, next);
  }
  return { statements: out, withheld };
}

// ---- the review of a file against a checklist (AI.02) -------------------------------------------------------------------------------------------

export const CHECK_KINDS = ['REQUIRED_TERMS', 'MIN_WORDS', 'PATTERN', 'AI_QUESTION'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
export const CHECK_SEVERITIES = ['BLOCKER', 'WARNING', 'INFO'] as const;
export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];
const ITEM_CODE = /^[A-Z][A-Z0-9_.-]{0,39}$/;
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)[+*{]/;
export const MAX_CHECKLIST_ITEMS = 50;

export interface ReviewItemDef {
  code: string;
  label: string;
  kind: CheckKind;
  params: Record<string, unknown>;
  severity: CheckSeverity;
}

/** The items of a checklist as an author writes them, each checked for the parameters its kind reads; what is accepted is what the rules run on, so a typo is refused when it is written. */
export function parseChecklistItems(raw: unknown, field = 'items'): ReviewItemDef[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CHECKLIST_ITEMS) throw invalid(field);
  const seen = new Set<string>();
  return raw.map((entry, position) => {
    const at = `${field}[${position}]`;
    if (!isRecord(entry)) throw invalid(at);
    const { code, label, kind, severity } = entry;
    if (typeof code !== 'string' || !ITEM_CODE.test(code) || seen.has(code)) throw invalid(`${at}.code`);
    seen.add(code);
    if (typeof label !== 'string' || label.trim().length < 2 || label.trim().length > 500) throw invalid(`${at}.label`);
    if (typeof kind !== 'string' || !(CHECK_KINDS as readonly string[]).includes(kind)) throw invalid(`${at}.kind`);
    if (typeof severity !== 'string' || !(CHECK_SEVERITIES as readonly string[]).includes(severity)) throw invalid(`${at}.severity`);
    const params = entry.params === undefined ? {} : entry.params;
    if (!isRecord(params)) throw invalid(`${at}.params`);
    return { code, label: label.trim(), kind: kind as CheckKind, severity: severity as CheckSeverity, params: checkParams(kind as CheckKind, params, `${at}.params`) };
  });
}

function checkParams(kind: CheckKind, params: Record<string, unknown>, at: string): Record<string, unknown> {
  if (kind === 'REQUIRED_TERMS') {
    const terms = params.terms;
    if (!Array.isArray(terms) || terms.length < 1 || terms.length > 20 || terms.some((term) => typeof term !== 'string' || term.trim().length < 1 || term.trim().length > 100)) throw invalid(`${at}.terms`);
    const match = params.match === undefined ? 'ALL' : params.match;
    if (match !== 'ALL' && match !== 'ANY') throw invalid(`${at}.match`);
    return { terms: (terms as string[]).map((term) => term.trim()), match };
  }
  if (kind === 'MIN_WORDS') {
    const min = params.min;
    if (typeof min !== 'number' || !Number.isInteger(min) || min < 1 || min > 100_000) throw invalid(`${at}.min`);
    return { min };
  }
  if (kind === 'PATTERN') {
    const pattern = params.pattern;
    if (typeof pattern !== 'string' || pattern.length < 1 || pattern.length > 200 || NESTED_QUANTIFIER.test(pattern)) throw invalid(`${at}.pattern`);
    try {
      new RegExp(pattern, 'u');
    } catch {
      throw invalid(`${at}.pattern`);
    }
    const mustMatch = params.must_match === undefined ? true : params.must_match;
    if (typeof mustMatch !== 'boolean') throw invalid(`${at}.must_match`);
    return { pattern, must_match: mustMatch };
  }
  const question = params.question;
  if (typeof question !== 'string' || question.trim().length < 5 || question.trim().length > 500) throw invalid(`${at}.question`);
  return { question: question.trim() };
}

export interface ReviewItemOutcome {
  item_code: string;
  label: string;
  kind: CheckKind;
  severity: CheckSeverity;
  result: 'PASS' | 'FAIL' | 'UNKNOWN';
  /** COMPUTED: the server ran the rule on the text. ASSISTANT: the assistant answered and the server checked its citations. */
  by: 'COMPUTED' | 'ASSISTANT';
  detail: string | null;
  statement_id: string | null;
  citations: CheckedCitation[];
}

/** Whether the text holds the words the rule asks for, and how long it is: a rule of the checklist that needs no model. Nothing of the text is returned but the names of what is missing. */
export function runComputedCheck(item: ReviewItemDef, text: string): Pick<ReviewItemOutcome, 'result' | 'detail'> {
  if (item.kind === 'REQUIRED_TERMS') {
    const terms = item.params.terms as string[];
    const haystack = normaliseQuote(text).toLowerCase();
    const missing = terms.filter((term) => !haystack.includes(normaliseQuote(term).toLowerCase()));
    const any = item.params.match === 'ANY';
    const passed = any ? missing.length < terms.length : missing.length === 0;
    return { result: passed ? 'PASS' : 'FAIL', detail: passed ? null : `MISSING:${missing.join('|')}` };
  }
  if (item.kind === 'MIN_WORDS') {
    const words = text.split(/\s+/).filter((word) => word !== '').length;
    const min = item.params.min as number;
    return { result: words >= min ? 'PASS' : 'FAIL', detail: words >= min ? null : `WORDS:${words}<${min}` };
  }
  if (item.kind === 'PATTERN') {
    const found = new RegExp(item.params.pattern as string, 'u').test(text.slice(0, 500_000));
    const wanted = item.params.must_match !== false;
    return { result: found === wanted ? 'PASS' : 'FAIL', detail: found === wanted ? null : wanted ? 'PATTERN_ABSENT' : 'PATTERN_PRESENT' };
  }
  return { result: 'UNKNOWN', detail: 'NOT_COMPUTABLE' };
}

export interface ReviewResult {
  items: ReviewItemOutcome[];
  /** READY: nothing blocks and nothing needs a second look. NEEDS_ATTENTION: no blocker fails but a warning fails or cannot be shown. NOT_READY: a blocker fails or cannot be shown. The verdict is advice: sending a file up is not blocked by it. */
  verdict: 'READY' | 'NEEDS_ATTENTION' | 'NOT_READY';
  counts: { pass: number; fail: number; unknown: number; blockers_open: number };
  advisory: true;
}

/**
 * The review of a file: the rules of the checklist run on its text, the questions are answered by the statements of the assistant, and the verdict is computed here from the severities. A question passes only with a
 * citation that was verified; a question the assistant did not answer, or answered PASS without evidence, is UNKNOWN, never a pass.
 */
export function composeReview(items: readonly ReviewItemDef[], text: string, statements: readonly CheckedStatement[]): ReviewResult {
  const outcomes: ReviewItemOutcome[] = items.map((item) => {
    const base = { item_code: item.code, label: item.label, kind: item.kind, severity: item.severity };
    if (item.kind !== 'AI_QUESTION') return { ...base, ...runComputedCheck(item, text), by: 'COMPUTED' as const, statement_id: null, citations: [] };
    const answered = statements.find((statement) => statement.item_code === item.code);
    if (answered === undefined || answered.result === null) return { ...base, result: 'UNKNOWN' as const, by: 'ASSISTANT' as const, detail: 'NOT_ANSWERED', statement_id: answered?.id ?? null, citations: [] };
    if (answered.result === 'PASS' && answered.verification !== 'VERIFIED') return { ...base, result: 'UNKNOWN' as const, by: 'ASSISTANT' as const, detail: 'PASS_WITHOUT_EVIDENCE', statement_id: answered.id, citations: answered.citations };
    return { ...base, result: answered.result, by: 'ASSISTANT' as const, detail: null, statement_id: answered.id, citations: answered.citations };
  });
  const open = (outcome: ReviewItemOutcome): boolean => outcome.result !== 'PASS';
  const blockers = outcomes.filter((outcome) => outcome.severity === 'BLOCKER' && open(outcome)).length;
  const warnings = outcomes.filter((outcome) => outcome.severity === 'WARNING' && open(outcome)).length;
  return {
    items: outcomes,
    verdict: blockers > 0 ? 'NOT_READY' : warnings > 0 ? 'NEEDS_ATTENTION' : 'READY',
    counts: { pass: outcomes.filter((outcome) => outcome.result === 'PASS').length, fail: outcomes.filter((outcome) => outcome.result === 'FAIL').length, unknown: outcomes.filter((outcome) => outcome.result === 'UNKNOWN').length, blockers_open: blockers },
    advisory: true,
  };
}

// ---- the evaluation of a contract (AI.04) -------------------------------------------------------------------------------------------------------

export interface CriterionDef {
  code: string;
  label: string;
  guidance: string;
  weightBp: number;
  evidenceRequired: boolean;
}

export const MAX_ASSIST_CRITERIA = 30;
export const WEIGHT_TOTAL_BP = 10_000;

/** The criteria of a set as an author writes them. The weights are in basis points and add up to 10000 when the set is published (a draft may be partial). */
export function parseCriteria(raw: unknown, scaleMax: number, field = 'criteria'): CriterionDef[] {
  if (!Number.isInteger(scaleMax) || scaleMax < 1 || scaleMax > 1000) throw invalid('scale_max');
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ASSIST_CRITERIA) throw invalid(field);
  const seen = new Set<string>();
  return raw.map((entry, position) => {
    const at = `${field}[${position}]`;
    if (!isRecord(entry)) throw invalid(at);
    const { code, label, guidance, weight_bp: weight, evidence_required: evidence } = entry;
    if (typeof code !== 'string' || !ITEM_CODE.test(code) || seen.has(code)) throw invalid(`${at}.code`);
    seen.add(code);
    if (typeof label !== 'string' || label.trim().length < 2 || label.trim().length > 300) throw invalid(`${at}.label`);
    if (guidance !== undefined && (typeof guidance !== 'string' || guidance.length > 2000)) throw invalid(`${at}.guidance`);
    if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 1 || weight > WEIGHT_TOTAL_BP) throw invalid(`${at}.weight_bp`);
    if (evidence !== undefined && typeof evidence !== 'boolean') throw invalid(`${at}.evidence_required`);
    return { code, label: label.trim(), guidance: typeof guidance === 'string' ? guidance.trim() : '', weightBp: weight, evidenceRequired: evidence !== false };
  });
}

/** A set is published only when its weights add up to exactly 10000 basis points. */
export function assertWeightsComplete(criteria: readonly CriterionDef[]): void {
  if (criteria.reduce((sum, criterion) => sum + criterion.weightBp, 0) !== WEIGHT_TOTAL_BP) throw new DomainError('CRITERIA_WEIGHTS_INVALID', 422, 'weight_bp');
}

export interface CriterionProposal {
  criterion_code: string;
  label: string;
  weight_bp: number;
  /** The score the assistant proposed, or null when it is withheld. */
  proposed_score: number | null;
  status: 'PROPOSED' | 'NEEDS_EVIDENCE' | 'NOT_ASSESSED' | 'OUT_OF_SCALE';
  statement_id: string | null;
  citations: CheckedCitation[];
}

/**
 * The proposal of a score for each criterion, from the statements that carry its code. A score is proposed when it is in the scale and, for a criterion that needs evidence, the statement is verified; otherwise it is
 * withheld, and a person scores it or leaves it. Nothing here is a decision: the weighted total is computed only from the scores a person accepted.
 */
export function proposeScores(criteria: readonly CriterionDef[], scaleMax: number, statements: readonly CheckedStatement[]): CriterionProposal[] {
  return criteria.map((criterion) => {
    const base = { criterion_code: criterion.code, label: criterion.label, weight_bp: criterion.weightBp };
    const statement = statements.find((candidate) => candidate.criterion_code === criterion.code && candidate.score !== null);
    if (statement === undefined) return { ...base, proposed_score: null, status: 'NOT_ASSESSED' as const, statement_id: null, citations: [] };
    const score = statement.score as number;
    if (score > scaleMax) return { ...base, proposed_score: null, status: 'OUT_OF_SCALE' as const, statement_id: statement.id, citations: statement.citations };
    if (criterion.evidenceRequired && statement.verification !== 'VERIFIED') return { ...base, proposed_score: null, status: 'NEEDS_EVIDENCE' as const, statement_id: statement.id, citations: statement.citations };
    return { ...base, proposed_score: score, status: 'PROPOSED' as const, statement_id: statement.id, citations: statement.citations };
  });
}

/**
 * The weighted total of the scores of a person, in the units of the scale with two places ("78.50"), rounded half up; it needs a score for every criterion, otherwise it is not computed (null) rather than guessed.
 * Integer arithmetic only: the weights are basis points.
 */
export function weightedTotal(criteria: readonly CriterionDef[], scores: ReadonlyMap<string, number>, scaleMax: number): string | null {
  let sum = 0;
  for (const criterion of criteria) {
    const score = scores.get(criterion.code);
    if (score === undefined || !Number.isInteger(score) || score < 0 || score > scaleMax) return null;
    sum += criterion.weightBp * score;
  }
  // sum / 10000 is the total; times 100 for two places: sum / 100, rounded half up.
  const hundredths = Math.floor((sum + 50) / 100);
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`;
}

// ---- what a person decides about a run (AI.04 "a human accepts") --------------------------------------------------------------------------------

export const ASSIST_DECISIONS = ['ACCEPTED', 'ACCEPTED_WITH_CHANGE', 'REJECTED'] as const;
export type AssistDecision = (typeof ASSIST_DECISIONS)[number];

export interface DecisionItem {
  item_key: string;
  action: 'KEEP' | 'DROP' | 'SET_SCORE';
  score?: number | undefined;
}

export function parseDecisionItems(raw: unknown): DecisionItem[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) throw invalid('items');
  const seen = new Set<string>();
  return raw.map((entry, position) => {
    if (!isRecord(entry) || typeof entry.item_key !== 'string' || entry.item_key === '' || entry.item_key.length > 40 || seen.has(entry.item_key)) throw invalid(`items[${position}].item_key`);
    seen.add(entry.item_key);
    const action = entry.action;
    if (action !== 'KEEP' && action !== 'DROP' && action !== 'SET_SCORE') throw invalid(`items[${position}].action`);
    if (action === 'SET_SCORE' && !(typeof entry.score === 'number' && Number.isInteger(entry.score) && entry.score >= 0)) throw invalid(`items[${position}].score`);
    if (action !== 'SET_SCORE' && entry.score !== undefined) throw invalid(`items[${position}].score`);
    return { item_key: entry.item_key, action, score: action === 'SET_SCORE' ? (entry.score as number) : undefined };
  });
}

export interface AcceptedResult {
  /** The statements of a note, a summary, an answer or an analysis that the person kept. */
  kept_statements?: string[];
  /** For a contract evaluation: the score of each criterion the person accepted, and the weighted total computed from them. */
  scores?: Record<string, number>;
  total?: string;
}

export interface DecisionContext {
  kind: AssistKind;
  statements: readonly CheckedStatement[];
  criteria?: readonly CriterionDef[] | undefined;
  scaleMax?: number | undefined;
  proposals?: readonly CriterionProposal[] | undefined;
}

/**
 * What a decision about a run comes to. Rejected keeps nothing. Accepted keeps every statement that is verified or an open assumption (an unsupported statement is never kept) and, for a contract evaluation, accepts
 * the scores that were proposed (it is refused when one was withheld: the person scores it). Accepted with change applies the items: statements dropped, scores set. The person who decides answers for the result.
 */
export function resolveDecision(decision: AssistDecision, items: readonly DecisionItem[], context: DecisionContext): AcceptedResult {
  if (decision === 'REJECTED') {
    if (items.length > 0) throw invalid('items');
    return {};
  }
  if (decision === 'ACCEPTED' && items.length > 0) throw invalid('items');
  const keep = (): string[] => {
    const dropped = new Set(items.filter((item) => item.action === 'DROP').map((item) => item.item_key));
    const known = new Set(context.statements.map((statement) => statement.id));
    for (const item of items) {
      if (item.action === 'SET_SCORE' && context.kind !== 'CONTRACT_EVAL') throw invalid('items');
      if (context.kind !== 'CONTRACT_EVAL' && !known.has(item.item_key)) throw invalid('items');
    }
    const forced = items.filter((item) => item.action === 'KEEP').map((item) => item.item_key);
    for (const id of forced) if (context.statements.find((statement) => statement.id === id)?.verification === 'UNSUPPORTED') throw new DomainError('AI_STATEMENT_UNSUPPORTED', 422, 'items');
    return context.statements.filter((statement) => statement.verification !== 'UNSUPPORTED' && !dropped.has(statement.id)).map((statement) => statement.id);
  };
  if (context.kind !== 'CONTRACT_EVAL') return { kept_statements: keep() };
  const criteria = context.criteria ?? [];
  const scores = new Map<string, number>();
  for (const proposal of context.proposals ?? []) if (proposal.proposed_score !== null) scores.set(proposal.criterion_code, proposal.proposed_score);
  const codes = new Set(criteria.map((criterion) => criterion.code));
  for (const item of items) {
    if (!codes.has(item.item_key)) throw invalid('items');
    if (item.action === 'DROP') scores.delete(item.item_key);
    if (item.action === 'SET_SCORE') {
      if ((item.score as number) > (context.scaleMax ?? 100)) throw invalid('items');
      scores.set(item.item_key, item.score as number);
    }
  }
  const total = weightedTotal(criteria, scores, context.scaleMax ?? 100);
  // A person may leave a criterion unscored, but then there is no total: the result says so rather than guessing.
  const accepted: AcceptedResult = { kept_statements: keep(), scores: Object.fromEntries([...scores.entries()].sort(([a], [b]) => a.localeCompare(b))) };
  if (total !== null) accepted.total = total;
  if (decision === 'ACCEPTED' && total === null) throw new DomainError('AI_EVALUATION_INCOMPLETE', 422, 'items');
  return accepted;
}

// ---- what is shown of a stored result, and the coverage of a feasibility analysis -----------------------------------------------------------------------

/**
 * A stored result with every citation the reader may not read taken out, wherever it stands in the result (the items of a review and the proposals of an evaluation carry citations too). Only the count of what was
 * taken out is returned, never what it pointed at.
 */
export function redactCitations(value: unknown, index: ReadableIndex): { value: unknown; withheld: number } {
  let withheld = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isRecord(node)) return node;
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(node)) {
      if (key === 'citations' && Array.isArray(entry)) {
        const kept = entry.filter((citation) => isRecord(citation) && typeof citation.kind === 'string' && typeof citation.id === 'string' && index.has(materialKey(citation.kind, citation.id)));
        withheld += entry.length - kept.length;
        copy[key] = kept;
      } else {
        copy[key] = walk(entry);
      }
    }
    return copy;
  };
  return { value: walk(value), withheld };
}

export interface SectionCoverage {
  sections: Array<{ code: string; statement_ids: string[] }>;
  /** The sections of a feasibility analysis that no supported statement covers: the person sees what the assistant left out. */
  missing: string[];
}

/** Which sections of a feasibility analysis the supported statements cover. A statement that is unsupported does not cover its section. */
export function sectionCoverage(statements: readonly CheckedStatement[]): SectionCoverage {
  const sections = FEASIBILITY_SECTIONS.map((code) => ({ code: code as string, statement_ids: statements.filter((statement) => statement.section === code && statement.verification !== 'UNSUPPORTED').map((statement) => statement.id) }));
  return { sections, missing: sections.filter((section) => section.statement_ids.length === 0).map((section) => section.code) };
}

/**
 * A stored review judged again against the statements as they stand for a reader who may read less now: a question the assistant passed on a citation that is no longer readable by the reader is UNKNOWN again, and the
 * verdict follows. The rules computed in code are not touched (they ran on the text, which is not stored).
 */
export function refreshReview(review: ReviewResult, statements: readonly CheckedStatement[]): ReviewResult {
  const items = review.items.map((item) => {
    if (item.by !== 'ASSISTANT' || item.result !== 'PASS' || item.statement_id === null) return item;
    const statement = statements.find((candidate) => candidate.id === item.statement_id);
    return statement?.verification === 'VERIFIED' ? { ...item, citations: statement.citations } : { ...item, result: 'UNKNOWN' as const, detail: 'PASS_WITHOUT_EVIDENCE', citations: statement?.citations ?? [] };
  });
  const open = (item: ReviewItemOutcome): boolean => item.result !== 'PASS';
  const blockers = items.filter((item) => item.severity === 'BLOCKER' && open(item)).length;
  const warnings = items.filter((item) => item.severity === 'WARNING' && open(item)).length;
  return {
    items,
    verdict: blockers > 0 ? 'NOT_READY' : warnings > 0 ? 'NEEDS_ATTENTION' : 'READY',
    counts: { pass: items.filter((item) => item.result === 'PASS').length, fail: items.filter((item) => item.result === 'FAIL').length, unknown: items.filter((item) => item.result === 'UNKNOWN').length, blockers_open: blockers },
    advisory: true,
  };
}

import { DomainError } from './errors.ts';
import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { assertNotProposer } from './contract-halt.ts';
import { FIN_FORMULA_VERSION, FIN_LINE_KINDS, FIN_PERIOD_UNITS, buildReport, inputsHash as finInputsHash, reportHash } from './fin-analysis.ts';
import type { FinModelInput, FinReport, FinScenarioInput, FinSensitivityConfig } from './fin-analysis.ts';
import { scoreCriteria } from './fin-criteria.ts';
import type { FinCriteriaResult, FinCriteriaSet, FinCriterionScoreInput } from './fin-criteria.ts';

/**
 * The life of an investment appraisal record (lane FIN-1): the statuses, who answers for each input, and the conditions of submitting and approving. Pure rules, kept apart from the database: the
 * numbers come from `fin-analysis.ts`, which the server runs; nothing a client sends is a result.
 */

export const FIN_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED'] as const;
export type FinStatus = (typeof FIN_STATUSES)[number];

export const FIN_KINDS = ['FINANCIAL', 'NON_FINANCIAL'] as const;
export type FinKind = (typeof FIN_KINDS)[number];

/** Where the figure of an input comes from. `LAW` is a legal number: it is configuration to be confirmed, never a rule the system enforces. */
export const FIN_SOURCE_KINDS = ['DOCUMENT', 'ESTIMATE', 'MARKET', 'STANDARD', 'LAW', 'OTHER'] as const;
export type FinSourceKind = (typeof FIN_SOURCE_KINDS)[number];

export const FIN_ASSUMPTION_KEY = /^(HORIZON|DISCOUNT_RATE|BENEFIT|CAPEX|OPEX|MAINTENANCE|RESIDUAL|SCENARIO:[A-Z][A-Z0-9_]{1,31})$/;
const MAX_TEXT = 500;

export interface FinAssumptionInput {
  key: string;
  /** What the assumption states, in words (for example "8% a year, the rate of the lending programme"). */
  value: string;
  /** Unit of account: the unit the value is in. */
  unit: string;
  sourceKind: string;
  /** The document, estimate or reasoning the value rests on. */
  source: string;
  /** The membership of the person who answers for the input. */
  ownerId: string;
}

const invalid = (field: string, reason: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, { extensions: { reason } });

export const isFinStatus = (value: unknown): value is FinStatus => typeof value === 'string' && (FIN_STATUSES as readonly string[]).includes(value);
export const isFinKind = (value: unknown): value is FinKind => typeof value === 'string' && (FIN_KINDS as readonly string[]).includes(value);

/** The inputs a person has to answer for before the appraisal is submitted: the horizon and the rate, every kind of line that has an amount, and every scenario. */
export function requiredAssumptionKeys(model: FinModelInput, scenarios: readonly FinScenarioInput[]): string[] {
  const keys = ['HORIZON', 'DISCOUNT_RATE'];
  for (const kind of FIN_LINE_KINDS) {
    const used = model.lines.some((line) => {
      const amount = line[kind];
      return amount !== undefined && amount !== '' && /[1-9]/.test(amount);
    });
    if (used) keys.push(kind.toUpperCase());
  }
  for (const scenario of scenarios) keys.push(`SCENARIO:${scenario.code}`);
  return keys;
}

/** Checks the form of the assumptions (a key once, a source and an owner each) without asking whether they are complete: a draft may be incomplete. */
export function assertAssumptionForm(assumptions: readonly FinAssumptionInput[]): void {
  const seen = new Set<string>();
  assumptions.forEach((entry, index) => {
    if (typeof entry.key !== 'string' || !FIN_ASSUMPTION_KEY.test(entry.key)) throw invalid(`assumptions[${index}].key`, 'NOT_AN_INPUT');
    if (seen.has(entry.key)) throw invalid(`assumptions[${index}].key`, 'DUPLICATE_KEY');
    seen.add(entry.key);
    for (const field of ['value', 'unit', 'source'] as const) {
      const text = entry[field];
      if (typeof text !== 'string' || text.trim() === '' || text.trim() !== text || text.length > MAX_TEXT) throw invalid(`assumptions[${index}].${field}`, 'EMPTY');
    }
    if (!(FIN_SOURCE_KINDS as readonly string[]).includes(entry.sourceKind)) throw invalid(`assumptions[${index}].source_kind`, 'UNKNOWN_SOURCE_KIND');
    if (typeof entry.ownerId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.ownerId)) throw invalid(`assumptions[${index}].owner_id`, 'NOT_AN_ID');
  });
}

export function assertPeriodUnit(value: unknown): void {
  if (typeof value !== 'string' || !(FIN_PERIOD_UNITS as readonly string[]).includes(value)) throw invalid('period_unit', 'UNKNOWN_PERIOD_UNIT');
}

/** 422 `APPRAISAL_ASSUMPTION_MISSING` naming the first input nobody answers for yet, with all of them in `missing`. */
export function assertAssumptionsComplete(required: readonly string[], assumptions: readonly FinAssumptionInput[]): void {
  const have = new Set(assumptions.map((entry) => entry.key));
  const missing = required.filter((key) => !have.has(key));
  if (missing.length > 0) throw new DomainError('APPRAISAL_ASSUMPTION_MISSING', 422, missing[0], { extensions: { missing } });
}

export interface SubmitFacts {
  kind: FinKind;
  lineCount: number;
  criteriaCategory: string | null;
  criteriaScored: boolean;
  /** The hash of the inputs the stored result was computed from; null when it was never computed. */
  resultInputsHash: string | null;
  currentInputsHash: string;
  /** The formula version the stored result was computed with and the one in force now. */
  resultFormulaVersion: string | null;
  currentFormulaVersion: string;
}

/**
 * What it takes to submit: something to appraise, every input answered for (checked apart), and a result that the server computed from exactly these inputs under the formula in force now. A result that
 * is missing or belongs to other inputs is `APPRAISAL_RESULTS_STALE`; an appraisal with nothing to appraise is `APPRAISAL_INPUT_INCOMPLETE`.
 */
export function assertSubmittable(facts: SubmitFacts): void {
  if (facts.kind === 'FINANCIAL' && facts.lineCount === 0) throw new DomainError('APPRAISAL_INPUT_INCOMPLETE', 422, 'lines', { extensions: { reason: 'NO_CASH_FLOW' } });
  if (facts.kind === 'NON_FINANCIAL') {
    if (facts.criteriaCategory === null) throw new DomainError('APPRAISAL_INPUT_INCOMPLETE', 422, 'criteria_category', { extensions: { reason: 'NO_CRITERIA_CATEGORY' } });
    if (!facts.criteriaScored) throw new DomainError('APPRAISAL_INPUT_INCOMPLETE', 422, 'scores', { extensions: { reason: 'NO_SCORES' } });
  }
  if (facts.resultInputsHash === null || facts.resultInputsHash !== facts.currentInputsHash || facts.resultFormulaVersion !== facts.currentFormulaVersion) {
    throw new DomainError('APPRAISAL_RESULTS_STALE', 409, 'results', { extensions: { computed: facts.resultInputsHash !== null } });
  }
}

/** The approver is neither who made the appraisal, nor who last edited it, nor who submitted it. */
export function assertApprover(actor: string, people: { createdBy: string; updatedBy: string; submittedBy: string | null }): void {
  assertNotProposer(actor, [people.createdBy, people.updatedBy, people.submittedBy]);
}

/** The state a command starts from; 409 `APPRAISAL_STATE_INVALID` otherwise, naming the status the record is in. */
export function assertStatus(actual: string, allowed: readonly FinStatus[]): void {
  if (!(allowed as readonly string[]).includes(actual)) throw new DomainError('APPRAISAL_STATE_INVALID', 409, 'status', { extensions: { appraisal_status: actual, allowed: [...allowed] } });
}

// ---- Computing an appraisal ------------------------------------------------------------------------------------------------------------

export interface AppraisalComputeInput {
  kind: FinKind;
  /** The cash flow; null when the appraisal has none (a non-financial appraisal may have no cash flow at all). */
  model: FinModelInput | null;
  scenarios: readonly FinScenarioInput[];
  sensitivity: FinSensitivityConfig | null;
  /** The set of criteria in force when the appraisal is scored (the weights come from rule data), and the scores. */
  criteria: { set: FinCriteriaSet; scores: readonly FinCriterionScoreInput[] } | null;
}

export interface AppraisalComputed {
  report: FinReport | null;
  criteria: FinCriteriaResult | null;
  /** The fingerprint of everything the appraisal says, with the formula version. */
  resultHash: string;
  formulaVersion: string;
}

const hasCashFlow = (model: FinModelInput | null): model is FinModelInput => model !== null && model.lines.length > 0;

/**
 * The hash of what the results rest on: the financial inputs (through the hash of the formula module), the category of the criteria and the scores. The weights are not in it: a rule approved after the
 * computation does not make a computed appraisal stale, because the criteria are frozen with the set they were scored with.
 */
export function appraisalInputsHash(input: { model: FinModelInput | null; scenarios: readonly FinScenarioInput[]; sensitivity: FinSensitivityConfig | null; category: string | null; scores: readonly FinCriterionScoreInput[] }): string {
  const scores = [...input.scores].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((entry) => ({ key: entry.key, score: entry.score, evidence: entry.evidence }));
  return sha256Hex(canonicalJson({ fin: hasCashFlow(input.model) ? finInputsHash({ model: input.model, scenarios: input.scenarios, ...(input.sensitivity === null ? {} : { sensitivity: input.sensitivity }) }) : null, category: input.category, scores }));
}

/** Runs the formula module and the scoring on the inputs; nothing in the result is taken from anywhere else. */
export function computeAppraisal(input: AppraisalComputeInput): AppraisalComputed {
  if (input.kind === 'FINANCIAL' && !hasCashFlow(input.model)) throw new DomainError('APPRAISAL_INPUT_INCOMPLETE', 422, 'lines', { extensions: { reason: 'NO_CASH_FLOW' } });
  if (input.kind === 'NON_FINANCIAL' && input.criteria === null) throw new DomainError('APPRAISAL_INPUT_INCOMPLETE', 422, 'scores', { extensions: { reason: 'NO_SCORES' } });
  const report = hasCashFlow(input.model) ? buildReport({ model: input.model, scenarios: input.scenarios, ...(input.sensitivity === null ? {} : { sensitivity: input.sensitivity }) }) : null;
  const criteria = input.criteria === null ? null : scoreCriteria(input.criteria.set, input.criteria.scores);
  const resultHash = sha256Hex(canonicalJson({ formulaVersion: FIN_FORMULA_VERSION, report: report === null ? null : reportHash(report), criteria }));
  return { report, criteria, resultHash, formulaVersion: FIN_FORMULA_VERSION };
}

import { addDecimal, compareDecimal, convertDecimal, roundDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';
import { FINDING_STATUSES } from './bid-analysis.ts';
import type { FindingStatus, RunStatus } from './bid-analysis.ts';

/**
 * The review of the findings of an analysis by an expert, and the comparison of proposals built from what the experts decided (ST-BID-010, BID 3 F6, BR-BID-03/09/10/11).
 * What an expert decides about a finding is a record of its own that points at the finding, never a change to it; the status that stands is the latest decision, and a finding nobody decided stands
 * for nothing. Everything that judges a review or assembles a comparison lives here as pure functions: the reason, the score, the decision that records what the expert did with what the model said,
 * the run that may be reviewed, and the table that sets the proposals of a package side by side on the same criteria without ever naming a winner.
 */

export const REVIEW_DECISIONS = ['ACCEPTED', 'ACCEPTED_WITH_CHANGE', 'REJECTED'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** A change to what the model said is made for a reason a colleague can read: at least this many characters once trimmed. */
export const MIN_REVIEW_REASON = 20;
export const MAX_REVIEW_REASON = 4000;
/** The citations an expert says they checked are some of the citations of the finding, not the whole page of them. */
export const MAX_CHECKED_EVIDENCE = 20;

const SCORE = /^(0|[1-9][0-9]{0,4})(\.[0-9]{1,2})?$/;

/** The reason an expert gives, in their words: 422 `REASON_REQUIRED` when it is not there, too short once trimmed or too long. */
export function reviewReasonOf(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < MIN_REVIEW_REASON || text.length > MAX_REVIEW_REASON) {
    throw new DomainError('REASON_REQUIRED', 422, 'reason', { extensions: { min_length: MIN_REVIEW_REASON, max_length: MAX_REVIEW_REASON } });
  }
  return text;
}

/** The status an expert sets, one of the four a finding can have. */
export function reviewStatusOf(value: unknown): FindingStatus {
  const status = FINDING_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'to_status');
  return status;
}

export interface ScoredCriterion {
  /** The top of the scale of a scored criterion; null for a criterion that is met or not. */
  maxScore: number | null;
}

/**
 * The score an expert gives a criterion: none for one that is met or not (422), otherwise a number from 0 to the top of its scale with at most two decimals (422). Not giving one leaves the score as it stood.
 */
export function reviewScoreOf(value: unknown, criterion: ScoredCriterion): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SCORE.test(value) || criterion.maxScore === null || compareDecimal(value, String(criterion.maxScore)) === 1) throw new DomainError('VALIDATION_FAILED', 422, 'score_after');
  return roundDecimal(value, 2, 'HALF_UP');
}

/** The run is one whose findings experts decide on: it waits for them or has all of them decided; anything else has no findings to decide (422 `RUN_NOT_COMPLETED`). */
export function assertRunReviewable(status: RunStatus): void {
  if (status !== 'AWAITING_REVIEW' && status !== 'COMPLETED') throw new DomainError('RUN_NOT_COMPLETED', 422, 'status', { extensions: { run_status: status } });
}

export interface ReviewFacts {
  fromStatus: FindingStatus;
  toStatus: FindingStatus;
  scoreBefore: string | null;
  scoreAfter: string | null;
}

/**
 * What the expert did with what stood (BR-BID-09), as the record of the decision of a person about an answer of the AI says it: the same status and score is ACCEPTED; setting the finding back to
 * NEEDS_REVIEW, so that no conclusion stands, is REJECTED; any other status or score is ACCEPTED_WITH_CHANGE.
 */
export function reviewDecision(facts: ReviewFacts): ReviewDecision {
  const sameScore = facts.scoreAfter === null || (facts.scoreBefore !== null && compareDecimal(facts.scoreAfter, facts.scoreBefore) === 0);
  if (facts.toStatus === facts.fromStatus && sameScore) return 'ACCEPTED';
  return facts.toStatus === 'NEEDS_REVIEW' && facts.fromStatus !== 'NEEDS_REVIEW' ? 'REJECTED' : 'ACCEPTED_WITH_CHANGE';
}

/** The score that stands after a review that gave none: the score that stood. */
export function scoreAfterReview(scoreBefore: string | null, scoreAfter: string | null): string | null {
  return scoreAfter ?? scoreBefore;
}

/** The version of a finding that an `If-Match` names: one more than the number of decisions made about it, so that two experts deciding at once do not overwrite each other. */
export function findingVersion(reviewCount: number): number {
  return reviewCount + 1;
}

/** The decision form of the baseline operation: `approve` keeps what the model said, `reject` sets it aside; `return` has nothing to return a finding to. */
export const FINDING_DECISION_FORMS = ['approve', 'reject'] as const;
export type FindingDecisionForm = (typeof FINDING_DECISION_FORMS)[number];

export function decisionFormOf(value: unknown): FindingDecisionForm {
  const form = FINDING_DECISION_FORMS.find((candidate) => candidate === value);
  if (form === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'decision');
  return form;
}

/** The status the baseline form sets: `approve` is the status that stands, `reject` leaves no conclusion standing. */
export function statusForForm(form: FindingDecisionForm, standing: FindingStatus): FindingStatus {
  return form === 'approve' ? standing : 'NEEDS_REVIEW';
}

// ---- the comparison -------------------------------------------------------------------------------------------------------------------------

export const PROPOSAL_EXCLUSION_REASONS = ['CRITERIA_VERSION_MISMATCH', 'NO_ANALYSIS_RUN'] as const;
export type ProposalExclusionReason = (typeof PROPOSAL_EXCLUSION_REASONS)[number];

export const CELL_RISKS = ['UNDECIDED', 'NONE', 'ATTENTION', 'MANDATORY_NOT_MET'] as const;
export type CellRisk = (typeof CELL_RISKS)[number];

export interface ComparisonCriterion {
  code: string;
  name: string;
  kind: string;
  weight: number | null;
  maxScore: number | null;
  threshold: number | null;
  mandatory: boolean;
  /** The rule of the criteria nobody may ask for that the text of this criterion falls under, when one does: such a criterion is never compared. */
  prohibitedRule: string | null;
}

export interface DecidedFinding {
  findingId: string;
  status: FindingStatus;
  score: string | null;
  decision: ReviewDecision;
  decidedAt: string;
}

export interface ComparisonRunInput {
  proposalId: string;
  contractor: { id: string; name: string };
  /** The analysis that stands for the proposal: its latest run that was not cancelled, refused or failed. */
  run: { id: string; status: RunStatus; criteriaVersionId: string } | null;
  findings: Array<{ findingId: string; criterionCode: string; decided: DecidedFinding | null }>;
}

export interface ComparisonInput {
  criteriaVersionId: string;
  criteria: readonly ComparisonCriterion[];
  runs: readonly ComparisonRunInput[];
  /** The attributes the comparison never looks at, by rule. */
  excludedAttributes: readonly string[];
}

export interface ComparedProposal {
  proposalId: string;
  contractor: { id: string; name: string };
  runId: string;
  runStatus: RunStatus;
  criteriaCount: number;
  decidedCount: number;
  mandatoryNotMet: number;
  /** The weighted sum of the scores the experts gave, out of 100; null until every scored criterion has a score a person gave. */
  weightedScore: string | null;
}

export interface ExcludedProposal {
  proposalId: string;
  contractor: { id: string; name: string };
  runId: string | null;
  criteriaVersionId: string | null;
  reason: ProposalExclusionReason;
}

export interface ComparisonCell {
  proposalId: string;
  findingId: string | null;
  /** What a person decided; null while nobody has. What the model said is not part of the comparison. */
  decided: DecidedFinding | null;
  risk: CellRisk;
}

export interface ComparisonRow {
  criterion: ComparisonCriterion;
  cells: ComparisonCell[];
}

export interface Comparison {
  criteriaVersionId: string;
  proposals: ComparedProposal[];
  rows: ComparisonRow[];
  excluded: ExcludedProposal[];
  excludedCriteria: Array<{ code: string; rule: string }>;
  excludedAttributes: string[];
}

const NOT_MET: readonly FindingStatus[] = ['CONTRADICTED', 'MISSING'];

/**
 * How a decided finding bears on the evaluation: nothing decided is UNDECIDED; a mandatory criterion that the expert found contradicted or missing, or scored below its threshold, is MANDATORY_NOT_MET;
 * any other finding that is not supported is ATTENTION.
 */
export function cellRisk(criterion: ComparisonCriterion, decided: DecidedFinding | null): CellRisk {
  if (decided === null) return 'UNDECIDED';
  const belowThreshold = decided.score !== null && criterion.threshold !== null && compareDecimal(decided.score, String(criterion.threshold)) === -1;
  if (criterion.mandatory && (NOT_MET.includes(decided.status) || belowThreshold)) return 'MANDATORY_NOT_MET';
  return decided.status === 'SUPPORTED' && !belowThreshold ? 'NONE' : 'ATTENTION';
}

/** The weighted sum of the scores of the scored criteria, out of the total weight; null as long as one scored criterion has no score a person gave. */
function weightedScore(criteria: readonly ComparisonCriterion[], cells: ReadonlyMap<string, ComparisonCell>): string | null {
  let sum = '0';
  let scored = 0;
  for (const criterion of criteria) {
    if (criterion.kind !== 'SCORED' || criterion.weight === null || criterion.maxScore === null) continue;
    scored += 1;
    const score = cells.get(criterion.code)?.decided?.score ?? null;
    if (score === null) return null;
    sum = addDecimal(sum, convertDecimal(score, String(criterion.weight), String(criterion.maxScore), 6, 'HALF_UP'));
  }
  return scored === 0 ? null : roundDecimal(sum, 2, 'HALF_UP');
}

const byContractor = (a: { contractor: { name: string }; proposalId: string }, b: { contractor: { name: string }; proposalId: string }): number =>
  a.contractor.name.localeCompare(b.contractor.name) || a.proposalId.localeCompare(b.proposalId);

/**
 * Sets the proposals of a package side by side (BID-10, BR-BID-09/10/11). Only the analyses that ran on the criteria asked for are compared: a proposal whose standing analysis ran on other criteria is
 * excluded as CRITERIA_VERSION_MISMATCH, one with no analysis as NO_ANALYSIS_RUN. A criterion whose text falls under a rule of the criteria nobody may ask for is left out and named, and so are the attributes
 * the comparison never looks at. A cell holds only what a person decided; the table has no total that names a winner and no order that ranks: the proposals stand in the order of the names of the contractors.
 */
export function compareProposals(input: ComparisonInput): Comparison {
  const usable = input.criteria.filter((criterion) => criterion.prohibitedRule === null);
  const excludedCriteria = input.criteria.flatMap((criterion) => (criterion.prohibitedRule === null ? [] : [{ code: criterion.code, rule: criterion.prohibitedRule }]));
  const excluded: ExcludedProposal[] = [];
  const compared: Array<{ input: ComparisonRunInput; run: NonNullable<ComparisonRunInput['run']> }> = [];
  for (const entry of input.runs) {
    const base = { proposalId: entry.proposalId, contractor: entry.contractor };
    if (entry.run === null) excluded.push({ ...base, runId: null, criteriaVersionId: null, reason: 'NO_ANALYSIS_RUN' });
    else if (entry.run.criteriaVersionId !== input.criteriaVersionId) excluded.push({ ...base, runId: entry.run.id, criteriaVersionId: entry.run.criteriaVersionId, reason: 'CRITERIA_VERSION_MISMATCH' });
    else compared.push({ input: entry, run: entry.run });
  }
  compared.sort((a, b) => byContractor(a.input, b.input));
  excluded.sort(byContractor);

  const cellsOf = new Map<string, Map<string, ComparisonCell>>();
  for (const { input: entry } of compared) {
    const cells = new Map<string, ComparisonCell>();
    for (const criterion of usable) {
      const finding = entry.findings.find((candidate) => candidate.criterionCode === criterion.code);
      const decided = finding?.decided ?? null;
      cells.set(criterion.code, { proposalId: entry.proposalId, findingId: finding?.findingId ?? null, decided, risk: cellRisk(criterion, decided) });
    }
    cellsOf.set(entry.proposalId, cells);
  }

  const proposals = compared.map(({ input: entry, run }): ComparedProposal => {
    const cells = cellsOf.get(entry.proposalId) as Map<string, ComparisonCell>;
    const own = [...cells.values()];
    return {
      proposalId: entry.proposalId,
      contractor: entry.contractor,
      runId: run.id,
      runStatus: run.status,
      criteriaCount: usable.length,
      decidedCount: own.filter((cell) => cell.decided !== null).length,
      mandatoryNotMet: own.filter((cell) => cell.risk === 'MANDATORY_NOT_MET').length,
      weightedScore: weightedScore(usable, cells),
    };
  });
  const rows = usable.map((criterion): ComparisonRow => ({ criterion, cells: compared.map(({ input: entry }) => (cellsOf.get(entry.proposalId) as Map<string, ComparisonCell>).get(criterion.code) as ComparisonCell) }));
  return { criteriaVersionId: input.criteriaVersionId, proposals, rows, excluded, excludedCriteria, excludedAttributes: [...input.excludedAttributes] };
}

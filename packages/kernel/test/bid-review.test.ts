import type { DomainError } from '../src/errors';
import {
  CELL_RISKS,
  PROPOSAL_EXCLUSION_REASONS,
  FINDING_DECISION_FORMS,
  MAX_REVIEW_REASON,
  MIN_REVIEW_REASON,
  REVIEW_DECISIONS,
  assertRunReviewable,
  cellRisk,
  compareProposals,
  decisionFormOf,
  findingVersion,
  reviewDecision,
  reviewReasonOf,
  reviewScoreOf,
  reviewStatusOf,
  scoreAfterReview,
  statusForForm,
} from '../src/bid-review';
import type { ComparisonCriterion, ComparisonRunInput, DecidedFinding } from '../src/bid-review';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const CV2 = '22222222-2222-4222-8222-222222222222';
const CV1 = '11111111-1111-4111-8111-111111111111';
const LONG = 'The contract of the bridge was not accepted, so the experience is not met.';

const criterion = (overrides: Partial<ComparisonCriterion> & { code: string }): ComparisonCriterion => ({
  name: `Criterion ${overrides.code}`,
  kind: 'SCORED',
  weight: 40,
  maxScore: 10,
  threshold: 6,
  mandatory: false,
  prohibitedRule: null,
  ...overrides,
});

const decided = (overrides: Partial<DecidedFinding> = {}): DecidedFinding => ({ findingId: 'f', status: 'SUPPORTED', score: '8.00', decision: 'ACCEPTED', decidedAt: '2026-11-02T01:00:00.000Z', ...overrides });

describe('the review of the findings of an analysis and the comparison of proposals (ST-BID-010)', () => {
  it('names the decisions, the reasons a proposal is left out and the risks a cell can carry', () => {
    expect(REVIEW_DECISIONS).toEqual(['ACCEPTED', 'ACCEPTED_WITH_CHANGE', 'REJECTED']);
    expect(PROPOSAL_EXCLUSION_REASONS).toEqual(['CRITERIA_VERSION_MISMATCH', 'NO_ANALYSIS_RUN']);
    expect(CELL_RISKS).toEqual(['UNDECIDED', 'NONE', 'ATTENTION', 'MANDATORY_NOT_MET']);
    expect(FINDING_DECISION_FORMS).toEqual(['approve', 'reject']);
    expect(MIN_REVIEW_REASON).toBe(20);
    expect(MAX_REVIEW_REASON).toBe(4000);
  });

  describe('the reason (BR-BID-09)', () => {
    it('refuses a short one, an empty one and one that is not text with 422 REASON_REQUIRED, and keeps a long one trimmed', () => {
      for (const value of ['short', '   short   ', '', undefined, 12, 'x'.repeat(MAX_REVIEW_REASON + 1)]) {
        const error = refusal(() => reviewReasonOf(value));
        expect(error.code).toBe('REASON_REQUIRED');
        expect(error.status).toBe(422);
      }
      expect(reviewReasonOf(`  ${LONG}  `)).toBe(LONG);
      expect(reviewReasonOf('x'.repeat(MIN_REVIEW_REASON))).toHaveLength(MIN_REVIEW_REASON);
    });

    it('counts the characters of the trimmed text, not of what was sent', () => {
      expect(refusal(() => reviewReasonOf(`${' '.repeat(30)}${'x'.repeat(MIN_REVIEW_REASON - 1)}`)).code).toBe('REASON_REQUIRED');
    });
  });

  describe('the status and the score', () => {
    it('takes one of the four statuses and refuses any other', () => {
      expect(reviewStatusOf('CONTRADICTED')).toBe('CONTRADICTED');
      expect(refusal(() => reviewStatusOf('APPROVED')).code).toBe('VALIDATION_FAILED');
      expect(refusal(() => reviewStatusOf(undefined)).code).toBe('VALIDATION_FAILED');
    });

    it('takes a score from 0 to the top of the scale with two decimals, and none when none is given', () => {
      expect(reviewScoreOf(undefined, { maxScore: 5 })).toBeNull();
      expect(reviewScoreOf(null, { maxScore: 5 })).toBeNull();
      expect(reviewScoreOf('2', { maxScore: 5 })).toBe('2.00');
      expect(reviewScoreOf('0', { maxScore: 5 })).toBe('0.00');
      expect(reviewScoreOf('5', { maxScore: 5 })).toBe('5.00');
      expect(reviewScoreOf('4.25', { maxScore: 5 })).toBe('4.25');
    });

    it('refuses a score above the scale, a negative one, a malformed one and any score for a criterion that is met or not', () => {
      for (const value of ['5.01', '6', '-1', '1.234', 'abc', '', '01', 4]) expect(refusal(() => reviewScoreOf(value, { maxScore: 5 })).code).toBe('VALIDATION_FAILED');
      expect(refusal(() => reviewScoreOf('1', { maxScore: null })).code).toBe('VALIDATION_FAILED');
      expect(refusal(() => reviewScoreOf('1', { maxScore: null })).detail).toBe('score_after');
    });
  });

  describe('the run that may be reviewed', () => {
    it('lets the experts decide on a run that waits for them or has all its findings decided, and on no other', () => {
      expect(() => assertRunReviewable('AWAITING_REVIEW')).not.toThrow();
      expect(() => assertRunReviewable('COMPLETED')).not.toThrow();
      for (const status of ['QUEUED', 'RUNNING', 'FAILED', 'CANCELLED', 'REJECTED_BY_POLICY'] as const) {
        const error = refusal(() => assertRunReviewable(status));
        expect(error.code).toBe('RUN_NOT_COMPLETED');
        expect(error.status).toBe(422);
      }
    });
  });

  describe('what the expert did with what the model said', () => {
    it('is ACCEPTED when the status and the score are the ones that stood, also when no score is given', () => {
      expect(reviewDecision({ fromStatus: 'SUPPORTED', toStatus: 'SUPPORTED', scoreBefore: '4.00', scoreAfter: '4' })).toBe('ACCEPTED');
      expect(reviewDecision({ fromStatus: 'SUPPORTED', toStatus: 'SUPPORTED', scoreBefore: '4.00', scoreAfter: null })).toBe('ACCEPTED');
      expect(reviewDecision({ fromStatus: 'SUPPORTED', toStatus: 'SUPPORTED', scoreBefore: null, scoreAfter: null })).toBe('ACCEPTED');
    });

    it('is ACCEPTED_WITH_CHANGE when the status or the score is not the one that stood', () => {
      expect(reviewDecision({ fromStatus: 'SUPPORTED', toStatus: 'CONTRADICTED', scoreBefore: '4.00', scoreAfter: '2.00' })).toBe('ACCEPTED_WITH_CHANGE');
      expect(reviewDecision({ fromStatus: 'SUPPORTED', toStatus: 'MISSING', scoreBefore: null, scoreAfter: null })).toBe('ACCEPTED_WITH_CHANGE');
      expect(reviewDecision({ fromStatus: 'SUPPORTED', toStatus: 'SUPPORTED', scoreBefore: '4.00', scoreAfter: '3.00' })).toBe('ACCEPTED_WITH_CHANGE');
      expect(reviewDecision({ fromStatus: 'SUPPORTED', toStatus: 'SUPPORTED', scoreBefore: null, scoreAfter: '3.00' })).toBe('ACCEPTED_WITH_CHANGE');
    });

    it('is REJECTED when the expert sets the finding back to NEEDS_REVIEW, so that no conclusion stands', () => {
      expect(reviewDecision({ fromStatus: 'SUPPORTED', toStatus: 'NEEDS_REVIEW', scoreBefore: null, scoreAfter: null })).toBe('REJECTED');
      expect(reviewDecision({ fromStatus: 'NEEDS_REVIEW', toStatus: 'NEEDS_REVIEW', scoreBefore: null, scoreAfter: null })).toBe('ACCEPTED');
      expect(reviewDecision({ fromStatus: 'NEEDS_REVIEW', toStatus: 'SUPPORTED', scoreBefore: null, scoreAfter: null })).toBe('ACCEPTED_WITH_CHANGE');
    });

    it('keeps the score that stood when none is given', () => {
      expect(scoreAfterReview('4.00', null)).toBe('4.00');
      expect(scoreAfterReview('4.00', '2.00')).toBe('2.00');
      expect(scoreAfterReview(null, null)).toBeNull();
    });

    it('numbers a finding by the decisions made about it, from one', () => {
      expect(findingVersion(0)).toBe(1);
      expect(findingVersion(3)).toBe(4);
    });
  });

  describe('the decision form of the baseline operation', () => {
    it('knows approve and reject, and has no way to return a finding', () => {
      expect(decisionFormOf('approve')).toBe('approve');
      expect(decisionFormOf('reject')).toBe('reject');
      expect(refusal(() => decisionFormOf('return')).code).toBe('VALIDATION_FAILED');
      expect(refusal(() => decisionFormOf(undefined)).detail).toBe('decision');
    });

    it('keeps the status that stands for approve and leaves no conclusion standing for reject', () => {
      expect(statusForForm('approve', 'CONTRADICTED')).toBe('CONTRADICTED');
      expect(statusForForm('reject', 'CONTRADICTED')).toBe('NEEDS_REVIEW');
    });
  });

  describe('how a decided finding bears on the evaluation', () => {
    const mandatory = criterion({ code: 'M', mandatory: true });
    const optional = criterion({ code: 'O' });

    it('is UNDECIDED while nobody decided', () => {
      expect(cellRisk(mandatory, null)).toBe('UNDECIDED');
    });

    it('is MANDATORY_NOT_MET for a mandatory criterion found contradicted or missing, or scored below its threshold', () => {
      expect(cellRisk(mandatory, decided({ status: 'CONTRADICTED', score: null }))).toBe('MANDATORY_NOT_MET');
      expect(cellRisk(mandatory, decided({ status: 'MISSING', score: null }))).toBe('MANDATORY_NOT_MET');
      expect(cellRisk(mandatory, decided({ status: 'SUPPORTED', score: '5.99' }))).toBe('MANDATORY_NOT_MET');
      expect(cellRisk(mandatory, decided({ status: 'SUPPORTED', score: '6.00' }))).toBe('NONE');
    });

    it('is ATTENTION for a criterion that is not mandatory and is not supported or is below its threshold, and NONE for one that is supported', () => {
      expect(cellRisk(optional, decided({ status: 'CONTRADICTED', score: null }))).toBe('ATTENTION');
      expect(cellRisk(optional, decided({ status: 'NEEDS_REVIEW', score: null }))).toBe('ATTENTION');
      expect(cellRisk(optional, decided({ status: 'SUPPORTED', score: '2.00' }))).toBe('ATTENTION');
      expect(cellRisk(optional, decided({ status: 'SUPPORTED', score: null }))).toBe('NONE');
      expect(cellRisk(criterion({ code: 'P', kind: 'PASS_FAIL', threshold: null, maxScore: null, weight: null, mandatory: true }), decided({ status: 'NEEDS_REVIEW', score: null }))).toBe('ATTENTION');
    });
  });

  describe('the comparison (BID-10, BR-BID-10/11)', () => {
    const criteria = [criterion({ code: 'C1', kind: 'PASS_FAIL', weight: null, maxScore: null, threshold: null, mandatory: true }), criterion({ code: 'C2', weight: 60 }), criterion({ code: 'C3', weight: 40, maxScore: 5, threshold: null })];
    const run = (id: string, criteriaVersionId: string) => ({ id, status: 'AWAITING_REVIEW' as const, criteriaVersionId });
    const entry = (name: string, id: string, overrides: Partial<ComparisonRunInput> = {}): ComparisonRunInput => ({
      proposalId: id,
      contractor: { id: `c-${id}`, name },
      run: run(`run-${id}`, CV2),
      findings: [],
      ...overrides,
    });
    const compare = (runs: ComparisonRunInput[], list: readonly ComparisonCriterion[] = criteria) => compareProposals({ criteriaVersionId: CV2, criteria: list, runs, excludedAttributes: ['GENDER', 'AGE'] });

    it('compares only the analyses that ran on the criteria asked for and says why another is left out (UAT-AC17)', () => {
      const result = compare([entry('Alpha', 'a'), entry('Beta', 'b', { run: run('run-b', CV1) }), entry('Gamma', 'g', { run: null })]);
      expect(result.proposals.map((proposal) => proposal.proposalId)).toEqual(['a']);
      expect(result.excluded).toEqual([
        { proposalId: 'b', contractor: { id: 'c-b', name: 'Beta' }, runId: 'run-b', criteriaVersionId: CV1, reason: 'CRITERIA_VERSION_MISMATCH' },
        { proposalId: 'g', contractor: { id: 'c-g', name: 'Gamma' }, runId: null, criteriaVersionId: null, reason: 'NO_ANALYSIS_RUN' },
      ]);
      expect(result.criteriaVersionId).toBe(CV2);
      expect(result.excludedAttributes).toEqual(['GENDER', 'AGE']);
    });

    it('sets the proposals in the order of the names of the contractors, never ranked, and gives every criterion a cell for each', () => {
      const result = compare([entry('Zeta', 'z'), entry('Alpha', 'a'), entry('Alpha', 'a0')]);
      expect(result.proposals.map((proposal) => proposal.proposalId)).toEqual(['a', 'a0', 'z']);
      expect(result.rows.map((row) => row.criterion.code)).toEqual(['C1', 'C2', 'C3']);
      for (const row of result.rows) expect(row.cells.map((cell) => cell.proposalId)).toEqual(['a', 'a0', 'z']);
      expect(Object.keys(result.proposals[0] ?? {})).not.toContain('rank');
      expect(Object.keys(result.proposals[0] ?? {})).not.toContain('winner');
    });

    it('holds only what a person decided: a finding nobody decided is an undecided cell, with no status', () => {
      const result = compare([
        entry('Alpha', 'a', {
          findings: [
            { findingId: 'f1', criterionCode: 'C1', decided: decided({ findingId: 'f1', status: 'SUPPORTED', score: null }) },
            { findingId: 'f2', criterionCode: 'C2', decided: null },
          ],
        }),
      ]);
      const [c1, c2, c3] = result.rows.map((row) => row.cells[0]);
      expect(c1?.decided?.status).toBe('SUPPORTED');
      expect(c1?.risk).toBe('NONE');
      expect(c2).toEqual({ proposalId: 'a', findingId: 'f2', decided: null, risk: 'UNDECIDED' });
      expect(c3).toEqual({ proposalId: 'a', findingId: null, decided: null, risk: 'UNDECIDED' });
      expect(result.proposals[0]).toMatchObject({ criteriaCount: 3, decidedCount: 1, mandatoryNotMet: 0, weightedScore: null });
    });

    it('computes the weighted score of the scores the experts gave, exactly, once every scored criterion has one', () => {
      const result = compare([
        entry('Alpha', 'a', {
          findings: [
            { findingId: 'f1', criterionCode: 'C1', decided: decided({ status: 'SUPPORTED', score: null }) },
            { findingId: 'f2', criterionCode: 'C2', decided: decided({ status: 'SUPPORTED', score: '7.50' }) },
            { findingId: 'f3', criterionCode: 'C3', decided: decided({ status: 'SUPPORTED', score: '2.5' }) },
          ],
        }),
      ]);
      // 7.5 / 10 * 60 = 45 and 2.5 / 5 * 40 = 20
      expect(result.proposals[0]?.weightedScore).toBe('65.00');
    });

    it('rounds the weighted score half up to two decimals', () => {
      const result = compare(
        [
          entry('Alpha', 'a', {
            findings: [
              { findingId: 'f2', criterionCode: 'C2', decided: decided({ score: '3.33' }) },
              { findingId: 'f3', criterionCode: 'C3', decided: decided({ score: '1.11' }) },
            ],
          }),
        ],
        [criterion({ code: 'C2', weight: 60, maxScore: 10 }), criterion({ code: 'C3', weight: 40, maxScore: 3 })],
      );
      // 3.33 * 60 / 10 = 19.98 and 1.11 * 40 / 3 = 14.80
      expect(result.proposals[0]?.weightedScore).toBe('34.78');
    });

    it('counts the mandatory criteria that are not met and gives no weighted score to a set of criteria that has no scored one', () => {
      const result = compare(
        [entry('Alpha', 'a', { findings: [{ findingId: 'f1', criterionCode: 'C1', decided: decided({ status: 'CONTRADICTED', score: null }) }] })],
        [criteria[0] as ComparisonCriterion],
      );
      expect(result.proposals[0]).toMatchObject({ mandatoryNotMet: 1, decidedCount: 1, weightedScore: null });
    });

    it('leaves out a criterion whose text falls under a rule of the criteria nobody may ask for, and names it', () => {
      const result = compare([entry('Alpha', 'a')], [...criteria, criterion({ code: 'C9', prohibitedRule: 'GENDER' })]);
      expect(result.rows.map((row) => row.criterion.code)).toEqual(['C1', 'C2', 'C3']);
      expect(result.excludedCriteria).toEqual([{ code: 'C9', rule: 'GENDER' }]);
      expect(result.proposals[0]?.criteriaCount).toBe(3);
    });

    it('is empty and says so when no proposal ran on the criteria', () => {
      const result = compare([entry('Beta', 'b', { run: run('run-b', CV1) })]);
      expect(result.proposals).toEqual([]);
      expect(result.rows.every((row) => row.cells.length === 0)).toBe(true);
      expect(result.excluded).toHaveLength(1);
    });
  });
});

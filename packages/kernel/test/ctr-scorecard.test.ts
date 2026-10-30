import {
  EVALUATION_STATUSES,
  assertConfirmation,
  assertEvaluable,
  assertEvaluation,
  assertNotTheAuthor,
  assertViolable,
  assertViolation,
  needsDecisionDocument,
  overallHundredths,
  overallScoreOf,
  ratingOf,
} from '../src/ctr-scorecard';

const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};
const scores = (quality: number, schedule: number, safetyEnv: number, cooperation: number, financial: number) => ({ quality, schedule, safetyEnv, cooperation, financial });
const EVALUATION = { evaluation_kind: 'PERIODIC', period_label: '2026-Q3', score_quality: 80, score_schedule: 70, score_safety_env: 90, score_cooperation: 60, score_financial: 100 };
const VIOLATION = { violation_kind: 'DELAY', severity: 'MAJOR', occurred_on: '2026-09-01', description: 'Chậm tiến độ đợt 2' };
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';

describe('the scorecard of a contractor and the log of its violations (ST-CTR-014, BR-CTR-11, CTR.SCORECARD)', () => {
  it('UAT-AC315: weights the scores 80/70/90/60/100 by 30/25/20/10/15 into 80.50, and rates it GOOD', () => {
    expect(overallHundredths(scores(80, 70, 90, 60, 100))).toBe(8050);
    expect(overallScoreOf(scores(80, 70, 90, 60, 100))).toBe('80.50');
    expect(ratingOf(scores(80, 70, 90, 60, 100))).toBe('GOOD');
  });

  it('writes the overall score to two places with no rounding error, at the edges of the scale', () => {
    expect(overallScoreOf(scores(0, 0, 0, 0, 0))).toBe('0.00');
    expect(overallScoreOf(scores(100, 100, 100, 100, 100))).toBe('100.00');
    expect(overallScoreOf(scores(1, 0, 0, 0, 0))).toBe('0.30');
    expect(overallScoreOf(scores(33, 33, 33, 33, 33))).toBe('33.00');
    expect(overallScoreOf(scores(99, 97, 95, 93, 91))).toBe('95.90');
  });

  it('rates by the thresholds 90, 75 and 60, each one inclusive, and POOR below them', () => {
    expect(ratingOf(scores(90, 90, 90, 90, 90))).toBe('EXCELLENT');
    expect(ratingOf(scores(89, 90, 90, 90, 90))).toBe('GOOD');
    expect(ratingOf(scores(75, 75, 75, 75, 75))).toBe('GOOD');
    expect(ratingOf(scores(74, 75, 75, 75, 75))).toBe('FAIR');
    expect(ratingOf(scores(60, 60, 60, 60, 60))).toBe('FAIR');
    expect(ratingOf(scores(59, 60, 60, 60, 60))).toBe('POOR');
    expect(ratingOf(scores(0, 0, 0, 0, 0))).toBe('POOR');
  });

  it('takes an evaluation with a kind, a period and five whole scores from 0 to 100', () => {
    expect(assertEvaluation({ ...EVALUATION, remarks: '  Đạt yêu cầu  ' })).toEqual({ kind: 'PERIODIC', periodLabel: '2026-Q3', scores: scores(80, 70, 90, 60, 100), remarks: 'Đạt yêu cầu' });
    expect(assertEvaluation(EVALUATION).remarks).toBeUndefined();
    expect(refusal(() => assertEvaluation({ ...EVALUATION, evaluation_kind: 'ANNUAL' })).detail).toBe('evaluation_kind');
    for (const period_label of [undefined, '', '   ', 'x'.repeat(41), 7]) expect(refusal(() => assertEvaluation({ ...EVALUATION, period_label })).detail).toBe('period_label');
    for (const field of ['score_quality', 'score_schedule', 'score_safety_env', 'score_cooperation', 'score_financial']) {
      for (const value of [undefined, -1, 101, 70.5, '70', Number.NaN]) expect(refusal(() => assertEvaluation({ ...EVALUATION, [field]: value })).detail).toBe(field);
    }
    expect(refusal(() => assertEvaluation({ ...EVALUATION, remarks: '' })).detail).toBe('remarks');
  });

  it('judges the kind of evaluation by the status of the contract: a periodic one once it has started, the others when it has ended that way', () => {
    for (const status of EVALUATION_STATUSES.PERIODIC) expect(() => assertEvaluable('PERIODIC', status)).not.toThrow();
    for (const status of ['DRAFT', 'IN_REVIEW', 'SIGNED', 'CANCELLED']) expect(refusal(() => assertEvaluable('PERIODIC', status))).toEqual({ code: 'CONTRACT_STATE_INVALID', detail: 'evaluation_kind', status: 409 });
    expect(() => assertEvaluable('COMPLETION', 'COMPLETED')).not.toThrow();
    expect(refusal(() => assertEvaluable('COMPLETION', 'ACTIVE')).code).toBe('CONTRACT_STATE_INVALID');
    expect(() => assertEvaluable('TERMINATION', 'TERMINATED')).not.toThrow();
    expect(refusal(() => assertEvaluable('TERMINATION', 'COMPLETED')).code).toBe('CONTRACT_STATE_INVALID');
  });

  it('takes a violation only on a started contract, and keeps the author apart from the one who approves or confirms', () => {
    for (const status of ['ACTIVE', 'SUSPENDED', 'COMPLETED', 'TERMINATED', 'CLOSED']) expect(() => assertViolable(status)).not.toThrow();
    for (const status of ['DRAFT', 'IN_REVIEW', 'SIGNED', 'CANCELLED']) expect(refusal(() => assertViolable(status)).code).toBe('CONTRACT_STATE_INVALID');
    expect(() => assertNotTheAuthor('a', 'b')).not.toThrow();
    expect(refusal(() => assertNotTheAuthor('a', 'a'))).toEqual({ code: 'SELF_APPROVAL_DENIED', detail: 'id', status: 403 });
  });

  it('takes a violation with a kind, a severity, a day that has come and words; one from another module names its record', () => {
    expect(assertViolation(VIOLATION, '2026-09-30')).toEqual({ kind: 'DELAY', severity: 'MAJOR', occurredOn: '2026-09-01', description: 'Chậm tiến độ đợt 2', evidenceDocumentVersionId: undefined, sourceModule: 'CTR', sourceRefId: undefined });
    expect(assertViolation({ ...VIOLATION, occurred_on: '2026-09-30' }, '2026-09-30').occurredOn).toBe('2026-09-30');
    const fromQms = assertViolation({ ...VIOLATION, source_module: 'QMS', source_ref_id: DOCUMENT.toUpperCase(), evidence_document_version_id: DOCUMENT }, '2026-09-30');
    expect([fromQms.sourceModule, fromQms.sourceRefId, fromQms.evidenceDocumentVersionId]).toEqual(['QMS', DOCUMENT, DOCUMENT]);
    expect(refusal(() => assertViolation({ ...VIOLATION, occurred_on: '2026-10-01' }, '2026-09-30')).detail).toBe('occurred_on');
    for (const occurred_on of [undefined, '2026-02-30', '30/09/2026', '2026-9-1']) expect(refusal(() => assertViolation({ ...VIOLATION, occurred_on }, '2026-09-30')).detail).toBe('occurred_on');
    expect(refusal(() => assertViolation({ ...VIOLATION, violation_kind: 'THEFT' }, '2026-09-30')).detail).toBe('violation_kind');
    expect(refusal(() => assertViolation({ ...VIOLATION, severity: 'HIGH' }, '2026-09-30')).detail).toBe('severity');
    expect(refusal(() => assertViolation({ ...VIOLATION, description: '' }, '2026-09-30')).detail).toBe('description');
    expect(refusal(() => assertViolation({ ...VIOLATION, source_module: 'HR' }, '2026-09-30')).detail).toBe('source_module');
    expect(refusal(() => assertViolation({ ...VIOLATION, source_module: 'ISS' }, '2026-09-30')).detail).toBe('source_ref_id');
    expect(refusal(() => assertViolation({ ...VIOLATION, source_ref_id: 'x' }, '2026-09-30')).detail).toBe('source_ref_id');
    expect(refusal(() => assertViolation({ ...VIOLATION, evidence_document_version_id: 'x' }, '2026-09-30')).detail).toBe('evidence_document_version_id');
  });

  it('takes a sanction with an amount only for liquidated damages, which need one', () => {
    expect(assertConfirmation({ penalty_kind: 'WARNING' })).toEqual({ penaltyKind: 'WARNING', penaltyAmountVnd: '0', decisionDocumentVersionId: undefined });
    expect(assertConfirmation({ penalty_kind: 'NONE', penalty_amount_vnd: '000', decision_document_version_id: DOCUMENT })).toEqual({ penaltyKind: 'NONE', penaltyAmountVnd: '0', decisionDocumentVersionId: DOCUMENT });
    expect(assertConfirmation({ penalty_kind: 'LIQUIDATED_DAMAGES', penalty_amount_vnd: '0150000000' }).penaltyAmountVnd).toBe('150000000');
    for (const penalty_amount_vnd of [undefined, '0', '00']) expect(refusal(() => assertConfirmation({ penalty_kind: 'LIQUIDATED_DAMAGES', penalty_amount_vnd })).detail).toBe('penalty_amount_vnd');
    for (const penalty_kind of ['NONE', 'WARNING', 'TERMINATION', 'DEBARMENT_PROPOSAL']) expect(refusal(() => assertConfirmation({ penalty_kind, penalty_amount_vnd: '1' })).detail).toBe('penalty_amount_vnd');
    for (const penalty_amount_vnd of ['-1', '1.5', 'x', 7, '9'.repeat(25)]) expect(refusal(() => assertConfirmation({ penalty_kind: 'LIQUIDATED_DAMAGES', penalty_amount_vnd })).detail).toBe('penalty_amount_vnd');
    expect(refusal(() => assertConfirmation({ penalty_kind: 'FINE' })).detail).toBe('penalty_kind');
    expect(refusal(() => assertConfirmation({ penalty_kind: 'WARNING', decision_document_version_id: 'x' })).detail).toBe('decision_document_version_id');
  });

  it('asks for a document of decision for every sanction and for none when there is no sanction', () => {
    expect(needsDecisionDocument('NONE')).toBe(false);
    for (const kind of ['WARNING', 'LIQUIDATED_DAMAGES', 'TERMINATION', 'DEBARMENT_PROPOSAL'] as const) expect(needsDecisionDocument(kind)).toBe(true);
  });
});

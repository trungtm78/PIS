import type { DomainError } from '../src/errors';
import { MNE_EVALUATION_KINDS, INITIAL_EVALUATION_MONTHS, EVALUATION_SUBMITTABLE, assertEvaluationDecider, assertKindAtStage, assertEvaluationSubmission } from '../src/mne-evaluation';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

describe('the investment evaluation of a project (ST-MNE-009, UAT-AC292, UAT-PLAN-74)', () => {
  it('allows each kind at its stage, and an ad hoc evaluation at every stage', () => {
    expect(MNE_EVALUATION_KINDS).toEqual(['INITIAL', 'MIDTERM', 'FINAL', 'IMPACT', 'AD_HOC']);
    for (const status of ['CONCEPT', 'IMPLEMENTATION', 'COMPLETED', 'SETTLED', 'CLOSED', 'CANCELLED']) expect(() => assertKindAtStage('AD_HOC', status, null, '2026-10-31')).not.toThrow();
    expect(() => assertKindAtStage('MIDTERM', 'IMPLEMENTATION', null, '2026-10-31')).not.toThrow();
    expect(() => assertKindAtStage('FINAL', 'COMPLETED', null, '2026-10-31')).not.toThrow();
    expect(() => assertKindAtStage('FINAL', 'SETTLED', null, '2026-10-31')).not.toThrow();
    expect(() => assertKindAtStage('IMPACT', 'CLOSED', null, '2026-10-31')).not.toThrow();
  });

  it('refuses a kind at the wrong stage with 409 and names the kind and the stage', () => {
    expect(failure(() => assertKindAtStage('FINAL', 'IMPLEMENTATION', null, '2026-10-31'))).toMatchObject({
      code: 'STAGE_TRANSITION_DENIED',
      status: 409,
      detail: 'evaluation_kind',
      extensions: { evaluation_kind: 'FINAL', project_status: 'IMPLEMENTATION' },
    });
    expect(failure(() => assertKindAtStage('MIDTERM', 'COMPLETED', null, '2026-10-31')).code).toBe('STAGE_TRANSITION_DENIED');
    expect(failure(() => assertKindAtStage('IMPACT', 'COMPLETED', null, '2026-10-31')).code).toBe('STAGE_TRANSITION_DENIED');
    expect(failure(() => assertKindAtStage('INITIAL', 'COMPLETED', null, '2026-10-31')).code).toBe('STAGE_TRANSITION_DENIED');
  });

  it('allows the initial evaluation within twelve months of the start of the implementation and not after', () => {
    expect(INITIAL_EVALUATION_MONTHS).toBe(12);
    expect(() => assertKindAtStage('INITIAL', 'IMPLEMENTATION', '2025-11-01', '2026-10-31')).not.toThrow();
    expect(() => assertKindAtStage('INITIAL', 'IMPLEMENTATION', '2025-10-31', '2026-10-30')).not.toThrow();
    expect(failure(() => assertKindAtStage('INITIAL', 'IMPLEMENTATION', '2025-10-31', '2026-10-31'))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', extensions: { reason: 'INITIAL_WINDOW_PASSED' } });
    expect(failure(() => assertKindAtStage('INITIAL', 'IMPLEMENTATION', '2024-01-15', '2026-10-31')).status).toBe(409);
    // When the day the stage began is not known, the stage alone decides.
    expect(() => assertKindAtStage('INITIAL', 'IMPLEMENTATION', null, '2026-10-31')).not.toThrow();
    expect(() => assertKindAtStage('INITIAL', 'IMPLEMENTATION', 'x', '2026-10-31')).not.toThrow();
    // The day of the month counts: a day short of the twelfth month is still inside.
    expect(() => assertKindAtStage('INITIAL', 'IMPLEMENTATION', '2025-11-15', '2026-11-14')).not.toThrow();
  });

  it('asks a submission for a conclusion of the three and a day that is not in the future', () => {
    expect(assertEvaluationSubmission({ findings: [{ topic: 'a' }], conclusion: 'SATISFACTORY', completedDate: '2026-10-30' }, '2026-10-31')).toBe('SATISFACTORY');
    expect(assertEvaluationSubmission({ findings: [], conclusion: 'UNSATISFACTORY', completedDate: '2026-10-31' }, '2026-10-31')).toBe('UNSATISFACTORY');
    expect(failure(() => assertEvaluationSubmission({ findings: [], conclusion: undefined, completedDate: '2026-10-30' }, '2026-10-31'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'conclusion' });
    expect(failure(() => assertEvaluationSubmission({ findings: [], conclusion: 'GOOD', completedDate: '2026-10-30' }, '2026-10-31')).detail).toBe('conclusion');
    expect(failure(() => assertEvaluationSubmission({ findings: [], conclusion: 'SATISFACTORY', completedDate: undefined }, '2026-10-31')).detail).toBe('completed_date');
    expect(failure(() => assertEvaluationSubmission({ findings: [], conclusion: 'SATISFACTORY', completedDate: '2026-02-30' }, '2026-10-31')).detail).toBe('completed_date');
    expect(failure(() => assertEvaluationSubmission({ findings: [], conclusion: 'SATISFACTORY', completedDate: 'soon' }, '2026-10-31')).detail).toBe('completed_date');
    expect(failure(() => assertEvaluationSubmission({ findings: [], conclusion: 'SATISFACTORY', completedDate: '2026-11-01' }, '2026-10-31'))).toMatchObject({ detail: 'completed_date', extensions: { reason: 'IN_THE_FUTURE' } });
    for (const odd of ['text', 3, null, ['x']]) expect(failure(() => assertEvaluationSubmission({ findings: [odd], conclusion: 'SATISFACTORY', completedDate: '2026-10-30' }, '2026-10-31')).detail).toBe('findings');
  });

  it('is submitted from planned, in progress or returned, and decided by neither the planner nor the submitter', () => {
    expect(EVALUATION_SUBMITTABLE).toEqual(['PLANNED', 'IN_PROGRESS', 'RETURNED']);
    expect(() => assertEvaluationDecider('c', 'a', 'b')).not.toThrow();
    expect(() => assertEvaluationDecider('c', 'a', null)).not.toThrow();
    expect(failure(() => assertEvaluationDecider('A', 'a', 'b'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    expect(failure(() => assertEvaluationDecider('b', 'a', 'B')).code).toBe('SELF_APPROVAL_DENIED');
  });
});

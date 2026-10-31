import type { DomainError } from '../src/errors';
import { EVALUATION_TRIGGER_KINDS, assertTriggerStage, earliestDueOn, isPostHandoverKind, nextTriggerStatus } from '../src/ast-evaluation';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

describe('the trigger of the evaluation after the investment (ST-AST-006, UC-AST-04, UAT-AC394)', () => {
  it('falls due 12 or 24 months after the acceptance of the handover, and only a trigger after a handover has such a day', () => {
    expect(earliestDueOn('POST_HANDOVER_12M', '2027-01-15')).toBe('2028-01-15');
    expect(earliestDueOn('POST_HANDOVER_24M', '2027-01-15')).toBe('2029-01-15');
    expect(earliestDueOn('POST_HANDOVER_12M', '2028-02-29')).toBe('2029-02-28');
    expect(earliestDueOn('SETTLEMENT_CLOSED', '2027-01-15')).toBeUndefined();
    expect(earliestDueOn('MANUAL', '2027-01-15')).toBeUndefined();
    expect(EVALUATION_TRIGGER_KINDS.filter(isPostHandoverKind)).toEqual(['POST_HANDOVER_12M', 'POST_HANDOVER_24M']);
  });

  it('is set only at a stage of the project that admits it: not before the work is under way, not on a rejected or cancelled project', () => {
    for (const status of ['IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED', 'CLOSED']) expect(() => assertTriggerStage('MANUAL', status)).not.toThrow();
    for (const status of ['CONCEPT', 'APPRAISAL', 'PIPELINE', 'BUDGETED', 'REJECTED', 'CANCELLED']) {
      expect(failure(() => assertTriggerStage('POST_HANDOVER_12M', status))).toMatchObject({ code: 'PROJECT_STAGE_INVALID', status: 422, extensions: { status } });
    }
  });

  it('waits for the settlement of the project before the trigger of the closed settlement', () => {
    for (const status of ['SETTLED', 'CLOSED']) expect(() => assertTriggerStage('SETTLEMENT_CLOSED', status)).not.toThrow();
    for (const status of ['IMPLEMENTATION', 'COMPLETED']) expect(failure(() => assertTriggerStage('SETTLEMENT_CLOSED', status))).toMatchObject({ code: 'PROJECT_STAGE_INVALID' });
  });

  it('moves from scheduled to fired to acknowledged and by no other way', () => {
    expect(nextTriggerStatus('SCHEDULED', 'FIRE')).toBe('FIRED');
    expect(nextTriggerStatus('FIRED', 'ACKNOWLEDGE')).toBe('ACKNOWLEDGED');
    for (const [from, move] of [
      ['SCHEDULED', 'ACKNOWLEDGE'],
      ['FIRED', 'FIRE'],
      ['ACKNOWLEDGED', 'ACKNOWLEDGE'],
      ['ACKNOWLEDGED', 'FIRE'],
      ['CANCELLED', 'FIRE'],
      ['CANCELLED', 'ACKNOWLEDGE'],
    ] as const) {
      expect(failure(() => nextTriggerStatus(from, move))).toMatchObject({ code: 'TRIGGER_STATE_INVALID', status: 409, extensions: { status: from } });
    }
  });
});

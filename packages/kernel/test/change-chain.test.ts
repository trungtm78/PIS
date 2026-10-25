import {
  CHANGEABLE_CONTRACT_STATUSES,
  CHANGE_EVENT_KINDS,
  CHANGE_STAGES,
  CHANGE_STATUSES,
  DomainError,
  EVALUATED_STAGES,
  OPEN_CHANGE_STATUSES,
  TIER_COUNTS,
  changeCode,
  nextStageOf,
  scheduleDays,
  signedVnd,
  stagesOf,
  startStageOf,
  tierCountOf,
} from '../src/index.ts';

const refusal = (work: () => unknown): DomainError | undefined => {
  try {
    work();
  } catch (error) {
    return error instanceof DomainError ? error : undefined;
  }
  return undefined;
};

describe('the tiers of a project (BR-CTR-07)', () => {
  it('AC-ST-CTR-006-1, UAT-AC307: goes through ChangeEvent, PCO and CO with 3 tiers, PCO and CO with 2, and CO alone with 1', () => {
    expect(TIER_COUNTS).toEqual([1, 2, 3]);
    expect(stagesOf(3)).toEqual(['EVENT', 'PCO', 'CO']);
    expect(stagesOf(2)).toEqual(['PCO', 'CO']);
    expect(stagesOf(1)).toEqual(['CO']);
    expect(CHANGE_STAGES).toEqual(['EVENT', 'PCO', 'CO']);
  });

  it('starts at the first tier of the chain', () => {
    expect([3, 2, 1].map((count) => startStageOf(count as 1 | 2 | 3))).toEqual(['EVENT', 'PCO', 'CO']);
  });

  it('AC-ST-CTR-006-2, UAT-AC308: promotes from one tier to the next and stops at the CO; a tier that is not in the chain has no next', () => {
    expect(nextStageOf('EVENT', 3)).toBe('PCO');
    expect(nextStageOf('PCO', 3)).toBe('CO');
    expect(nextStageOf('CO', 3)).toBeUndefined();
    expect(nextStageOf('PCO', 2)).toBe('CO');
    expect(nextStageOf('EVENT', 2)).toBeUndefined();
    expect(nextStageOf('EVENT', 1)).toBeUndefined();
    expect(nextStageOf('CO', 1)).toBeUndefined();
  });

  it('reads a tier count only when it is 1, 2 or 3', () => {
    expect(tierCountOf(1)).toBe(1);
    expect(tierCountOf(3)).toBe(3);
    for (const wrong of [0, 4, '2', null, undefined, 2.5]) expect(tierCountOf(wrong)).toBeUndefined();
  });
});

describe('the vocabulary of a change', () => {
  it('has the statuses and the kinds of event of the specification', () => {
    expect(CHANGE_STATUSES).toEqual(['DRAFT', 'SUBMITTED', 'EVALUATED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'PROMOTED']);
    expect(CHANGE_EVENT_KINDS).toHaveLength(7);
    expect(OPEN_CHANGE_STATUSES).toEqual(['SUBMITTED', 'EVALUATED']);
    expect(EVALUATED_STAGES).toEqual(['PCO', 'CO']);
    expect(CHANGEABLE_CONTRACT_STATUSES).toEqual(['ACTIVE', 'SUSPENDED']);
  });

  it('numbers the requests of a tier by the code of the tier', () => {
    expect(changeCode('EVENT', 1)).toBe('CE-001');
    expect(changeCode('PCO', 12)).toBe('PCO-012');
    expect(changeCode('CO', 1000)).toBe('CO-1000');
  });
});

describe('signedVnd', () => {
  it('takes a whole signed amount and writes it as the number it is', () => {
    expect(signedVnd('500000000', 'x')).toBe('500000000');
    expect(signedVnd('-8000000000', 'x')).toBe('-8000000000');
    expect(signedVnd(' 007 ', 'x')).toBe('7');
    expect(signedVnd('-0', 'x')).toBe('0');
    expect(signedVnd('9'.repeat(24), 'x')).toBe('9'.repeat(24));
  });

  it('refuses what is not a whole amount, naming the field', () => {
    for (const wrong of ['', '1.5', 'abc', '--1', '+5', '1e3', '9'.repeat(25), '1 000']) {
      expect(refusal(() => signedVnd(wrong, 'estimated_delta_vnd'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'estimated_delta_vnd' });
    }
  });
});

describe('scheduleDays', () => {
  it('takes a whole number of days, positive or negative, within a hundred years', () => {
    expect(scheduleDays(0, 'x')).toBe(0);
    expect(scheduleDays(45, 'x')).toBe(45);
    expect(scheduleDays(-10, 'x')).toBe(-10);
    expect(scheduleDays(36_500, 'x')).toBe(36_500);
    for (const wrong of [1.5, 36_501, -36_501, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(refusal(() => scheduleDays(wrong, 'schedule_impact_days'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'schedule_impact_days' });
    }
  });
});

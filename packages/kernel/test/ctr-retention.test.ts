import type { DomainError } from '../src/errors';
import {
  RELEASE_BLOCKERS,
  RELEASE_CONDITIONS,
  RETENTION_STATUSES,
  assertNotTheMaker,
  assertReleasable,
  assertReleaseAmount,
  assertSomethingHeld,
  releaseBlocker,
  retentionLeft,
  statusAfterRelease,
} from '../src/ctr-retention';
import type { ReleaseFacts } from '../src/ctr-retention';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const facts = (overrides: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
  condition: 'WARRANTY_END',
  notBefore: null,
  today: '2028-03-02',
  contractStatus: 'COMPLETED',
  warranty: { obligations: 1, notClosed: 0 },
  hasDecision: false,
  ...overrides,
});

describe('the retention held back from a payment (ST-CTR-010, BR-CTR-09, UAT-AC309, UAT-AC397)', () => {
  it('lists the statuses, the conditions and the reasons a release can wait for', () => {
    expect(RETENTION_STATUSES).toEqual(['HELD', 'PARTIALLY_RELEASED', 'RELEASED', 'FORFEITED']);
    expect(RELEASE_CONDITIONS).toEqual(['WARRANTY_END', 'COMPLETION', 'MANUAL_DECISION']);
    expect(RELEASE_BLOCKERS).toEqual(['NOT_BEFORE', 'NO_WARRANTY', 'WARRANTY_OPEN', 'CONTRACT_NOT_COMPLETED', 'DECISION_REQUIRED']);
  });

  it('AC-ST-CTR-010-1, UAT-AC309: waits for the warranty to end: every obligation of the contract closed, and at least one', () => {
    expect(releaseBlocker(facts())).toBeUndefined();
    expect(releaseBlocker(facts({ warranty: { obligations: 3, notClosed: 0 } }))).toBeUndefined();
    expect(releaseBlocker(facts({ warranty: { obligations: 2, notClosed: 1 } }))).toBe('WARRANTY_OPEN');
    expect(releaseBlocker(facts({ warranty: { obligations: 0, notClosed: 0 } }))).toBe('NO_WARRANTY');
  });

  it('waits for the earliest day, whatever the condition: the day itself is enough', () => {
    expect(releaseBlocker(facts({ notBefore: '2028-03-02' }))).toBeUndefined();
    expect(releaseBlocker(facts({ notBefore: '2028-03-03' }))).toBe('NOT_BEFORE');
    expect(releaseBlocker(facts({ notBefore: '2028-03-03', condition: 'MANUAL_DECISION', hasDecision: true }))).toBe('NOT_BEFORE');
    expect(releaseBlocker(facts({ notBefore: '2028-03-03', warranty: { obligations: 2, notClosed: 1 } }))).toBe('NOT_BEFORE');
  });

  it('waits for the completion of the contract, or for the decision of the authority', () => {
    for (const contractStatus of ['COMPLETED', 'CLOSED']) expect(releaseBlocker(facts({ condition: 'COMPLETION', contractStatus }))).toBeUndefined();
    for (const contractStatus of ['ACTIVE', 'SUSPENDED', 'TERMINATED']) expect(releaseBlocker(facts({ condition: 'COMPLETION', contractStatus }))).toBe('CONTRACT_NOT_COMPLETED');
    expect(releaseBlocker(facts({ condition: 'MANUAL_DECISION', hasDecision: true }))).toBeUndefined();
    expect(releaseBlocker(facts({ condition: 'MANUAL_DECISION' }))).toBe('DECISION_REQUIRED');
  });

  it('AC-ST-CTR-010-1, UAT-AC309: refuses a release before its condition is met, with the condition, the reason and what the reason is about', () => {
    expect(() => assertReleasable(facts())).not.toThrow();
    expect(failure(() => assertReleasable(facts({ warranty: { obligations: 2, notClosed: 1 } })))).toMatchObject({
      code: 'RELEASE_CONDITION_NOT_MET',
      status: 422,
      extensions: { condition: 'WARRANTY_END', reason: 'WARRANTY_OPEN', open_obligations: 1 },
    });
    expect(failure(() => assertReleasable(facts({ notBefore: '2028-03-03' })))).toMatchObject({ extensions: { reason: 'NOT_BEFORE', release_not_before: '2028-03-03' } });
    expect(failure(() => assertReleasable(facts({ condition: 'COMPLETION', contractStatus: 'ACTIVE' }))).extensions).toEqual({ condition: 'COMPLETION', reason: 'CONTRACT_NOT_COMPLETED' });
  });

  it('works out what is left, and whether anything is', () => {
    expect(retentionLeft('100000000', '30000000')).toBe('70000000');
    expect(() => assertSomethingHeld('100000000', '99999999')).not.toThrow();
    expect(failure(() => assertSomethingHeld('100000000', '100000000'))).toMatchObject({
      code: 'RELEASE_EXCEEDS_HELD',
      status: 422,
      extensions: { held_vnd: '100000000', released_vnd: '100000000', left_vnd: '0' },
    });
  });

  it('AC-ST-CTR-010-1, UAT-AC309: releases what is left, and not a dong more', () => {
    expect(() => assertReleaseAmount('100000000', '0', '100000000')).not.toThrow();
    expect(() => assertReleaseAmount('100000000', '40000000', '60000000')).not.toThrow();
    expect(() => assertReleaseAmount('100000000', '0', '1')).not.toThrow();
    expect(failure(() => assertReleaseAmount('100000000', '0', '100000001'))).toMatchObject({
      code: 'RELEASE_EXCEEDS_HELD',
      status: 422,
      extensions: { held_vnd: '100000000', released_vnd: '0', left_vnd: '100000000', amount_vnd: '100000001' },
    });
    expect(failure(() => assertReleaseAmount('100000000', '40000000', '60000001')).code).toBe('RELEASE_EXCEEDS_HELD');
    expect(failure(() => assertReleaseAmount('100000000', '0', '0'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'amount_vnd' });
  });

  it('moves a hold to released only when everything held has been released', () => {
    expect(statusAfterRelease('100000000', '100000000')).toBe('RELEASED');
    expect(statusAfterRelease('100000000', '99999999')).toBe('PARTIALLY_RELEASED');
    expect(statusAfterRelease('100000000', '1')).toBe('PARTIALLY_RELEASED');
  });

  it('does not let whoever put the money on hold release it', () => {
    expect(() => assertNotTheMaker('accountant', 'officer')).not.toThrow();
    expect(failure(() => assertNotTheMaker('officer', 'officer'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
  });
});

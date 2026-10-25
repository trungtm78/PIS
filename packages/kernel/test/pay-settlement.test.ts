import type { DomainError } from '../src/errors';
import {
  RECONCILIATION_RESOLUTIONS,
  RECONCILIATION_STATUSES,
  amountsAgree,
  assertWriteOff,
  isWaiting,
  reconciliationTarget,
  requiredNote,
  reconciliationDifference,
} from '../src/pay-settlement';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

describe('the amount of a transaction against the net of a request (ST-PAY-007, UAT-AC335, UAT-AC12)', () => {
  it('agrees only when the two are the same number of dong', () => {
    expect(amountsAgree('2100000000', '2100000000')).toBe(true);
    expect(amountsAgree('1000000000', '990000000')).toBe(false);
    expect(amountsAgree('1000000000', '1000000001')).toBe(false);
  });

  it('refuses an amount that is not a whole number of dong instead of rounding it', () => {
    expect(failure(() => amountsAgree('100', '100.5')).code).toBe('VALIDATION_FAILED');
  });

  it('shows the difference as the confirmed figure less the internal one, signed, whichever is larger', () => {
    expect(reconciliationDifference('1000000000', '990000000')).toBe('-10000000');
    expect(reconciliationDifference('990000000', '1000000000')).toBe('10000000');
    expect(reconciliationDifference('5', '5')).toBe('0');
  });
});

describe('the moves of a reconciliation item (UAT-AC12, UAT-AC336)', () => {
  it('explains an open item, resolves an explained one and writes off one that still waits', () => {
    expect(reconciliationTarget('OPEN', 'EXPLAINED')).toBe('EXPLAINED');
    expect(reconciliationTarget('EXPLAINED', 'RESOLVED')).toBe('RESOLVED');
    expect(reconciliationTarget('OPEN', 'WRITTEN_OFF')).toBe('WRITTEN_OFF_APPROVED');
    expect(reconciliationTarget('EXPLAINED', 'WRITTEN_OFF')).toBe('WRITTEN_OFF_APPROVED');
  });

  it('allows no other move, and nothing leaves a status that ended', () => {
    expect(reconciliationTarget('OPEN', 'RESOLVED')).toBeUndefined();
    expect(reconciliationTarget('EXPLAINED', 'EXPLAINED')).toBeUndefined();
    for (const ended of ['RESOLVED', 'WRITTEN_OFF_APPROVED'] as const) {
      for (const resolution of RECONCILIATION_RESOLUTIONS) expect(reconciliationTarget(ended, resolution)).toBeUndefined();
    }
  });

  it('says which statuses still wait for a person', () => {
    expect(RECONCILIATION_STATUSES.filter(isWaiting)).toEqual(['OPEN', 'EXPLAINED']);
  });
});

describe('the write-off of a difference (UAT-AC336)', () => {
  const owner = '00000000-0000-4000-8000-0000000000aa';
  const approver = '00000000-0000-4000-8000-0000000000bb';
  const document = '00000000-0000-4000-8000-0000000000cc';

  it('asks for the approving document before it asks who signs', () => {
    expect(failure(() => assertWriteOff({ ownerMembershipId: owner, actor: owner, approvalDocumentVersionId: undefined })).code).toBe('APPROVAL_REQUIRED');
  });

  it('refuses the owner of the difference, whatever the case of the identifier', () => {
    const refusal = failure(() => assertWriteOff({ ownerMembershipId: owner, actor: owner.toUpperCase(), approvalDocumentVersionId: document }));
    expect([refusal.code, refusal.status]).toEqual(['SELF_APPROVAL_DENIED', 403]);
  });

  it('lets another approver write it off with the document', () => {
    expect(() => assertWriteOff({ ownerMembershipId: owner, actor: approver, approvalDocumentVersionId: document })).not.toThrow();
  });
});

describe('the words of a note', () => {
  it('trims them and refuses an empty or an overlong one, naming the field', () => {
    expect(requiredNote('  Kho bạc trừ phí  ', 'note')).toBe('Kho bạc trừ phí');
    expect(failure(() => requiredNote('   ', 'note')).extensions).toBeUndefined();
    expect(failure(() => requiredNote(undefined, 'note')).code).toBe('VALIDATION_FAILED');
    expect(failure(() => requiredNote('x'.repeat(2001), 'note')).code).toBe('VALIDATION_FAILED');
    expect(requiredNote('x'.repeat(2000), 'note')).toHaveLength(2000);
  });
});

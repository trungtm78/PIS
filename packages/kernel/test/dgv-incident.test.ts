import { DomainError } from '../src/errors';
import { MAX_WAIVER_DAYS, assertAssignable, assertRerunPassed, assertVerifiable, assertWorkStep, judgeExceptionDecision, maskReference, maskValue, nextWorkStep, resolutionText } from '../src/dgv-incident';

const refusal = (run: () => unknown): [string, number, string | undefined] | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof DomainError ? [error.code, error.status, error.detail] : undefined;
  }
  return undefined;
};

describe('the chain of an incident (DGV F4)', () => {
  it('lets the handler take one step at a time and nobody skip', () => {
    expect(assertWorkStep('ASSIGNED', 'ACKNOWLEDGED')).toBe('ACKNOWLEDGED');
    expect(assertWorkStep('REOPENED', 'ACKNOWLEDGED')).toBe('ACKNOWLEDGED');
    expect(assertWorkStep('ACKNOWLEDGED', 'IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(assertWorkStep('IN_PROGRESS', 'RESOLVED_PENDING_VERIFICATION')).toBe('RESOLVED_PENDING_VERIFICATION');
    for (const [from, to] of [
      ['ASSIGNED', 'IN_PROGRESS'],
      ['ASSIGNED', 'RESOLVED_PENDING_VERIFICATION'],
      ['ACKNOWLEDGED', 'RESOLVED_PENDING_VERIFICATION'],
      ['OPEN', 'ACKNOWLEDGED'],
      ['CLOSED', 'ACKNOWLEDGED'],
      ['RESOLVED_PENDING_VERIFICATION', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'ACKNOWLEDGED'],
    ] as const) expect([from, to, refusal(() => assertWorkStep(from, to))]).toEqual([from, to, ['INCIDENT_STATE_INVALID', 409, 'status']]);
    expect(nextWorkStep('ASSIGNED')).toBe('ACKNOWLEDGED');
    expect(nextWorkStep('CLOSED')).toBeUndefined();
    expect(nextWorkStep('OPEN')).toBeUndefined();
  });

  it('gives an incident to a handler until it is resolved', () => {
    for (const status of ['OPEN', 'REOPENED', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS'] as const) expect(refusal(() => assertAssignable(status))).toBeUndefined();
    for (const status of ['RESOLVED_PENDING_VERIFICATION', 'CLOSED'] as const) expect(refusal(() => assertAssignable(status))).toEqual(['INCIDENT_STATE_INVALID', 409, 'status']);
  });

  it('AC-ST-DGV-003-1: UAT-AC487 asks for the cause and the measure before an incident is resolved, judged after trimming', () => {
    expect(refusal(() => resolutionText({ rootCause: undefined, remediation: 'Sửa upstream: thêm ràng buộc duy nhất.' }))).toEqual(['ROOT_CAUSE_REQUIRED', 422, 'root_cause']);
    expect(refusal(() => resolutionText({ rootCause: '          ', remediation: 'Sửa upstream: thêm ràng buộc duy nhất.' }))).toEqual(['ROOT_CAUSE_REQUIRED', 422, 'root_cause']);
    expect(refusal(() => resolutionText({ rootCause: 'Trùng lặp do nhập hai lần.', remediation: 'ngắn' }))).toEqual(['ROOT_CAUSE_REQUIRED', 422, 'remediation']);
    expect(resolutionText({ rootCause: '  Trùng lặp do nhập hai lần.  ', remediation: ' Sửa upstream: thêm ràng buộc duy nhất. ' })).toEqual({ rootCause: 'Trùng lặp do nhập hai lần.', remediation: 'Sửa upstream: thêm ràng buộc duy nhất.' });
  });

  it('AC-ST-DGV-003-1: UAT-AC487 does not let the handler verify, nor verify what has not been resolved', () => {
    expect(refusal(() => assertVerifiable({ status: 'RESOLVED_PENDING_VERIFICATION', assigneeUserId: 'eng', verifierUserId: 'eng' }))).toEqual(['SELF_APPROVAL_DENIED', 403, undefined]);
    expect(refusal(() => assertVerifiable({ status: 'RESOLVED_PENDING_VERIFICATION', assigneeUserId: 'eng', verifierUserId: 'steward' }))).toBeUndefined();
    expect(refusal(() => assertVerifiable({ status: 'RESOLVED_PENDING_VERIFICATION', assigneeUserId: null, verifierUserId: 'steward' }))).toBeUndefined();
    expect(refusal(() => assertVerifiable({ status: 'IN_PROGRESS', assigneeUserId: 'eng', verifierUserId: 'steward' }))).toEqual(['INCIDENT_STATE_INVALID', 409, 'status']);
  });

  it('AC-ST-DGV-003-1: UAT-AC487 closes only after a run that finished after the resolution and in which the rule passed', () => {
    const resolvedAt = '2026-10-28T03:00:00.000000Z';
    const rerun = (finishedAt: string, result: 'PASS' | 'WARN' | 'FAIL' | 'ERROR') => ({ resolvedAt, rerun: { finishedAt, result } });
    expect(refusal(() => assertRerunPassed({ resolvedAt, rerun: undefined }))).toEqual(['RERUN_NOT_PASSED', 422, undefined]);
    expect(refusal(() => assertRerunPassed(rerun('2026-10-28T04:00:00.000000Z', 'FAIL')))).toEqual(['RERUN_NOT_PASSED', 422, undefined]);
    expect(refusal(() => assertRerunPassed(rerun('2026-10-28T04:00:00.000000Z', 'WARN')))).toEqual(['RERUN_NOT_PASSED', 422, undefined]);
    expect(refusal(() => assertRerunPassed(rerun('2026-10-28T04:00:00.000000Z', 'ERROR')))).toEqual(['RERUN_NOT_PASSED', 422, undefined]);
    // A pass from before the resolution is not a rerun.
    expect(refusal(() => assertRerunPassed(rerun('2026-10-28T02:00:00.000000Z', 'PASS')))).toEqual(['RERUN_NOT_PASSED', 422, undefined]);
    expect(refusal(() => assertRerunPassed(rerun('2026-10-28T03:00:00.000000Z', 'PASS')))).toEqual(['RERUN_NOT_PASSED', 422, undefined]);
    expect(refusal(() => assertRerunPassed(rerun('2026-10-28T04:00:00.000000Z', 'PASS')))).toBeUndefined();
  });
});

describe('the decision on an exception (BR-DGV-06)', () => {
  const now = new Date('2026-10-29T03:00:00Z');
  const base = { decision: 'WAIVED' as const, reason: 'Dữ liệu cũ, chờ nguồn sửa.', waiverExpiresAt: new Date('2026-11-30T16:59:00Z'), now, ownerUserId: 'owner', deciderUserId: 'steward' };

  it('waives for a while, with a reason, by someone who is not the owner', () => {
    expect(judgeExceptionDecision(base)).toEqual({ reason: 'Dữ liệu cũ, chờ nguồn sửa.', waiverExpiresAt: new Date('2026-11-30T16:59:00Z') });
    expect(refusal(() => judgeExceptionDecision({ ...base, deciderUserId: 'owner' }))).toEqual(['SELF_APPROVAL_DENIED', 403, undefined]);
    expect(refusal(() => judgeExceptionDecision({ ...base, reason: '   ngắn   ' }))).toEqual(['VALIDATION_FAILED', 422, 'reason']);
  });

  it('asks for an end that is after now and at most 180 days away', () => {
    expect(refusal(() => judgeExceptionDecision({ ...base, waiverExpiresAt: undefined }))).toEqual(['VALIDATION_FAILED', 422, 'waiver_expires_at']);
    expect(refusal(() => judgeExceptionDecision({ ...base, waiverExpiresAt: new Date('2026-10-29T03:00:00Z') }))).toEqual(['VALIDATION_FAILED', 422, 'waiver_expires_at']);
    expect(refusal(() => judgeExceptionDecision({ ...base, waiverExpiresAt: new Date('2026-10-01T00:00:00Z') }))).toEqual(['VALIDATION_FAILED', 422, 'waiver_expires_at']);
    expect(refusal(() => judgeExceptionDecision({ ...base, waiverExpiresAt: new Date('invalid') }))).toEqual(['VALIDATION_FAILED', 422, 'waiver_expires_at']);
    const limit = new Date(now.getTime() + MAX_WAIVER_DAYS * 86_400_000);
    expect(refusal(() => judgeExceptionDecision({ ...base, waiverExpiresAt: limit }))).toBeUndefined();
    expect(refusal(() => judgeExceptionDecision({ ...base, waiverExpiresAt: new Date(limit.getTime() + 1) }))).toEqual(['VALIDATION_FAILED', 422, 'waiver_expires_at']);
  });

  it('resolves with a reason and no end', () => {
    expect(judgeExceptionDecision({ ...base, decision: 'RESOLVED', waiverExpiresAt: undefined })).toEqual({ reason: 'Dữ liệu cũ, chờ nguồn sửa.', waiverExpiresAt: undefined });
    expect(refusal(() => judgeExceptionDecision({ ...base, decision: 'RESOLVED' }))).toEqual(['VALIDATION_FAILED', 422, 'waiver_expires_at']);
  });
});

describe('what a reader without the rights to the dataset sees (AC-ST-DGV-003-3, UAT-AC55)', () => {
  it('hides all but the last four characters of a value', () => {
    expect(maskValue('012345672345')).toBe('***2345');
    expect(maskValue('abcd')).toBe('***');
    expect(maskValue('')).toBe('***');
    expect(maskValue('Nguyễn Văn An')).toBe('***n An');
  });

  it('keeps the shape of a reference and hides every value in it', () => {
    expect(maskReference({ row_id: '0123456789012', national_id: '012345672345', nested: [{ amount: 1234567 }, 'ab'], flag: true, none: null })).toEqual({
      row_id: '***9012',
      national_id: '***2345',
      nested: [{ amount: '***4567' }, '***'],
      flag: '***',
      none: null,
    });
  });
});

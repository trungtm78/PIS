import { CHECK_FORMULA, CHECK_FROZEN_VERSION, CHECK_GROUPS, CHECK_ROWS, PUBLICATION_KINDS, assertDecisionReason, failedCheck, reproductionChecks } from '../src/bi-publication.ts';

describe('the checks of a publication request (BI 3 F5)', () => {
  it('passes every check of a metric whose rerun saw the rows the snapshot has and groups that add up', () => {
    const checks = reproductionChecks(true, { storedRows: 12, countedRows: 12, reconciles: true });
    expect(checks.map((check) => check.code)).toEqual([CHECK_FORMULA, CHECK_FROZEN_VERSION, CHECK_ROWS, CHECK_GROUPS]);
    expect(failedCheck(checks)).toBeUndefined();
  });

  it('fails the rows when the rerun counts what the snapshot does not say, and the groups when they do not add up', () => {
    expect(failedCheck(reproductionChecks(true, { storedRows: 12, countedRows: 11, reconciles: true }))).toEqual({ code: CHECK_ROWS, passed: false });
    expect(failedCheck(reproductionChecks(true, { storedRows: 12, countedRows: 12, reconciles: false }))).toEqual({ code: CHECK_GROUPS, passed: false });
  });

  it('does not pass a check that could not be made: no frozen version fails it, a formula that cannot be computed fails all of them', () => {
    expect(reproductionChecks(true, undefined).filter((check) => !check.passed).map((check) => check.code)).toEqual([CHECK_FROZEN_VERSION, CHECK_ROWS, CHECK_GROUPS]);
    expect(reproductionChecks(false, { storedRows: 1, countedRows: 1, reconciles: true }).every((check) => !check.passed)).toBe(true);
  });

  it('asks for the reason of a rejection and keeps the comment of an approval as it is, if there is one', () => {
    expect(() => assertDecisionReason('REJECTED', undefined)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422 }));
    expect(() => assertDecisionReason('REJECTED', '   ')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(assertDecisionReason('REJECTED', ' Sai mẫu số ')).toBe('Sai mẫu số');
    expect(assertDecisionReason('APPROVED', undefined)).toBeNull();
    expect(PUBLICATION_KINDS).toEqual(['METRIC', 'DASHBOARD', 'ACCESS_POLICY']);
  });
});

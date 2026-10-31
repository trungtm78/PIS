import type { DomainError } from '../src/errors';
import { FAILED_TEST_ACTION_DAYS, FAILED_TEST_SEVERITY, MATERIAL_RESULTS, MATERIAL_TEST_STATUSES, assertCanRecordResult, failedTestDueAt, failedTestWords } from '../src/qms-material';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

describe('the testing of materials and the non-conformance of a failed test (ST-QMS-007, UAT-AC362)', () => {
  it('knows the results a laboratory reports and the statuses of a test', () => {
    expect([...MATERIAL_RESULTS]).toEqual(['PASS', 'FAIL']);
    expect([...MATERIAL_TEST_STATUSES]).toEqual(['REGISTERED', 'RESULT_RECORDED', 'ACCEPTED', 'REJECTED']);
  });

  it('records the result once, on a test that is only registered, and says the status of any other', () => {
    expect(() => assertCanRecordResult('REGISTERED')).not.toThrow();
    for (const status of ['RESULT_RECORDED', 'ACCEPTED', 'REJECTED'] as const) {
      expect(failure(() => assertCanRecordResult(status))).toMatchObject({ code: 'MATERIAL_TEST_STATE_INVALID', status: 409, extensions: { status } });
    }
  });

  it('makes the non-conformance of a failed test a major one that is due fourteen days after it is raised', () => {
    expect(FAILED_TEST_SEVERITY).toBe('MAJOR');
    expect(FAILED_TEST_ACTION_DAYS).toBe(14);
    expect(failedTestDueAt(new Date('2026-10-31T03:00:00Z'))).toBe('2026-11-14T03:00:00.000Z');
    expect(failedTestDueAt(new Date('2026-12-25T10:00:00Z'))).toBe('2027-01-08T10:00:00.000Z');
  });

  it('words the non-conformance from the sample, the material and the standard, and from nothing the laboratory measured', () => {
    const words = failedTestWords({ sampleCode: 'BT-0601', materialKind: 'Concrete B02', standardRef: 'STD-BT-30' });
    expect(words.title).toBe('Material test failed: BT-0601');
    expect(words.description).toBe('The sample BT-0601 of Concrete B02 did not meet STD-BT-30; the report of the laboratory is attached to the test.');
  });
});

import { DomainError } from './errors.ts';
import type { NcrSeverity } from './qms-nonconformance.ts';

/**
 * The testing of materials and the non-conformance a failed test raises (ST-QMS-007, QMS 3.3, BR-QMS-07, UAT-AC362): the results a laboratory reports, the statuses of a test, the one move a command makes, and what the
 * non-conformance of a failed test looks like. Pure functions of their input, kept apart from the database.
 */

export const MATERIAL_RESULTS = ['PASS', 'FAIL'] as const;
export type MaterialResult = (typeof MATERIAL_RESULTS)[number];

export const MATERIAL_TEST_STATUSES = ['REGISTERED', 'RESULT_RECORDED', 'ACCEPTED', 'REJECTED'] as const;
export type MaterialTestStatus = (typeof MATERIAL_TEST_STATUSES)[number];

/**
 * The seriousness of the non-conformance a failed test raises, and the days the person who answers for it has to put it right in. The specification says only that the seriousness follows a rule and gives none
 * (QMS UAT-AC362), so a failed test is a major non-conformance and the answer is due in fourteen days: both are [ASSUMPTIONS], kept in this one place.
 */
export const FAILED_TEST_SEVERITY: NcrSeverity = 'MAJOR';
export const FAILED_TEST_ACTION_DAYS = 14;

/** The result is recorded once, on a test that is only registered: 409 `MATERIAL_TEST_STATE_INVALID` with the status the test is in. */
export function assertCanRecordResult(status: MaterialTestStatus): void {
  if (status !== 'REGISTERED') throw new DomainError('MATERIAL_TEST_STATE_INVALID', 409, 'status', { extensions: { status } });
}

/** The instant a failed test's non-conformance is due: the days of the term after it is raised, so that the time to put it right never starts in the past whatever the day of the test. */
export const failedTestDueAt = (raisedAt: Date): string => new Date(raisedAt.getTime() + FAILED_TEST_ACTION_DAYS * 86_400_000).toISOString();

/** The title and the description of the non-conformance a failed test raises: the sample, the material and the standard it failed, never the values of the laboratory. */
export function failedTestWords(test: { sampleCode: string; materialKind: string; standardRef: string }): { title: string; description: string } {
  return {
    title: `Material test failed: ${test.sampleCode}`,
    description: `The sample ${test.sampleCode} of ${test.materialKind} did not meet ${test.standardRef}; the report of the laboratory is attached to the test.`,
  };
}

// Vitest reporter of a UAT run (scripts/uat-run.mjs): one JSON line for each test case that ended, in the journal named by UAT_JOURNAL (the same lines as scripts/uat-jest-reporter.mjs, suite `vitest`).
import { appendFileSync } from 'node:fs';

const STATUS = { passed: 'passed', failed: 'failed', skipped: 'skipped', pending: 'pending' };

/** The journal line of one finished test case. */
export function journalLine(testCase, now = Date.now()) {
  const duration = testCase.diagnostic()?.duration ?? 0;
  const state = testCase.result().state;
  return {
    kind: 'result',
    suite: 'vitest',
    file: testCase.module.moduleId,
    name: testCase.fullName,
    status: STATUS[state] ?? 'failed',
    durationMs: Math.round(duration),
    at: new Date(now - duration).toISOString(),
  };
}

export default class UatVitestReporter {
  onTestCaseResult(testCase) {
    const file = process.env.UAT_JOURNAL;
    if (file === undefined || file === '') return;
    appendFileSync(file, `${JSON.stringify(journalLine(testCase))}\n`);
  }
}

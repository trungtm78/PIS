// Jest reporter of a UAT run (scripts/uat-run.mjs): one JSON line for each test case that ended, in the journal named by UAT_JOURNAL.
import { appendFileSync } from 'node:fs';

export default class UatJestReporter {
  onTestCaseResult(test, result) {
    const file = process.env.UAT_JOURNAL;
    if (file === undefined || file === '') return;
    const line = {
      kind: 'result',
      suite: 'jest',
      file: test.path,
      name: result.fullName,
      status: result.status,
      durationMs: result.duration ?? 0,
      at: new Date(result.startAt ?? Date.now()).toISOString(),
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  }
}

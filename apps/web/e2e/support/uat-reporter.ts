import { appendFileSync } from 'node:fs';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/**
 * Playwright reporter of a UAT run (scripts/uat-run.mjs): one JSON line for each browser test that ended, in the journal named by
 * UAT_JOURNAL, with the times of the test so that the requests of the API stack that fall in them are the requests it made
 * (the tests run one at a time, so no two overlap).
 */
export default class UatReporter implements Reporter {
  private readonly journal = process.env.UAT_JOURNAL;

  onTestEnd(test: TestCase, result: TestResult): void {
    if (this.journal === undefined || this.journal === '') return;
    // A test that is retried reports each attempt: only the last one counts, and it is the one that tells the status.
    const line = {
      kind: 'result',
      suite: 'playwright',
      file: test.location.file,
      name: test.titlePath().filter((part) => part !== '').slice(2).join(' '),
      status: result.status === 'passed' ? 'passed' : result.status === 'skipped' ? 'skipped' : 'failed',
      retry: result.retry,
      durationMs: result.duration,
      at: result.startTime.toISOString(),
      endedAt: new Date(result.startTime.getTime() + result.duration).toISOString(),
    };
    appendFileSync(this.journal, `${JSON.stringify(line)}\n`);
  }
}

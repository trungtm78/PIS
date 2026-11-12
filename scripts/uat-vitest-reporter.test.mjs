import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import UatVitestReporter, { journalLine } from './uat-vitest-reporter.mjs';

const testCase = (state, duration) => ({
  module: { moduleId: '/r/apps/web/src/a.test.tsx' },
  fullName: 'screen UAT-AC01 shows the figure',
  result: () => ({ state }),
  diagnostic: () => (duration === undefined ? undefined : { duration }),
});

test('the journal line of a finished Vitest test names the file, the full name and the status', () => {
  const line = journalLine(testCase('passed', 1000), Date.parse('2026-11-04T10:00:02.000Z'));
  assert.deepEqual(line, { kind: 'result', suite: 'vitest', file: '/r/apps/web/src/a.test.tsx', name: 'screen UAT-AC01 shows the figure', status: 'passed', durationMs: 1000, at: '2026-11-04T10:00:01.000Z' });
  assert.equal(journalLine(testCase('skipped')).status, 'skipped');
  assert.equal(journalLine(testCase('failed', 5)).status, 'failed');
  assert.equal(journalLine(testCase('weird', 5)).status, 'failed');
});

test('the reporter appends one line to the journal when UAT_JOURNAL is set and writes nothing otherwise', () => {
  const directory = mkdtempSync(join(tmpdir(), 'uat-vitest-'));
  const file = join(directory, 'journal.jsonl');
  const before = process.env.UAT_JOURNAL;
  try {
    delete process.env.UAT_JOURNAL;
    new UatVitestReporter().onTestCaseResult(testCase('passed', 1));
    process.env.UAT_JOURNAL = file;
    new UatVitestReporter().onTestCaseResult(testCase('passed', 1));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).suite, 'vitest');
  } finally {
    if (before === undefined) delete process.env.UAT_JOURNAL;
    else process.env.UAT_JOURNAL = before;
    rmSync(directory, { recursive: true, force: true });
  }
});

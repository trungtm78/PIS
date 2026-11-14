import assert from 'node:assert/strict';
import { test } from 'node:test';
import uatNodeReporter, { journalLine } from './uat-node-reporter.mjs';

test('uat-node-reporter: a case carries the names of the suites around it, a suite itself is not a case', () => {
  const stack = ['the release gate'];
  const passed = journalLine({ type: 'test:pass', data: { name: 'UAT-NFR-OPERABILITY-02: refuses', nesting: 1, file: 'a.test.mjs', details: { duration_ms: 12.4 } } }, stack, 1000);
  assert.deepEqual(passed, { kind: 'result', suite: 'jest', file: 'a.test.mjs', name: 'the release gate UAT-NFR-OPERABILITY-02: refuses', status: 'passed', durationMs: 12, at: new Date(1000 - 12.4).toISOString() });
  assert.equal(journalLine({ type: 'test:pass', data: { name: 'the release gate', nesting: 0, details: { type: 'suite' } } }, []), undefined);
});

test('uat-node-reporter: a failure is failed, a skipped or todo case is never passed', () => {
  const data = { name: 'one', nesting: 0, file: 'a.test.mjs', details: { duration_ms: 1 } };
  assert.equal(journalLine({ type: 'test:fail', data }, []).status, 'failed');
  assert.equal(journalLine({ type: 'test:pass', data: { ...data, skip: true } }, []).status, 'skipped');
  assert.equal(journalLine({ type: 'test:pass', data: { ...data, todo: true } }, []).status, 'todo');
});

test('uat-node-reporter: the stream of events gives one line for each case, with the names of the open suites', async () => {
  async function* events() {
    yield { type: 'test:start', data: { name: 'suite', nesting: 0, file: 'a.test.mjs' } };
    yield { type: 'test:start', data: { name: 'case', nesting: 1, file: 'a.test.mjs' } };
    yield { type: 'test:fail', data: { name: 'case', nesting: 1, file: 'a.test.mjs', details: { duration_ms: 2 } } };
    yield { type: 'test:pass', data: { name: 'suite', nesting: 0, file: 'a.test.mjs', details: { type: 'suite', duration_ms: 3 } } };
  }
  const before = process.env.UAT_JOURNAL;
  delete process.env.UAT_JOURNAL;
  const lines = [];
  for await (const line of uatNodeReporter(events())) lines.push(line);
  if (before !== undefined) process.env.UAT_JOURNAL = before;
  assert.deepEqual(lines, ['not ok suite case\n']);
});

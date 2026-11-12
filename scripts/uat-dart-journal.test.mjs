import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, sep } from 'node:path';
import { dartJournal, parseEvents } from './uat-dart-journal.mjs';

const path = resolve('apps', 'mobile', 'test', 'a_test.dart').split(sep).join('/');
const events = [
  { type: 'suite', suite: { id: 0, platform: 'vm', path } },
  { type: 'testStart', test: { id: 1, name: 'loading a_test.dart', suiteID: 0 }, time: 1 },
  { type: 'testDone', testID: 1, result: 'success', hidden: true, time: 2 },
  { type: 'testStart', test: { id: 5, name: 'orphan', suiteID: 7 }, time: 3 },
  { type: 'testDone', testID: 5, result: 'success', hidden: false, time: 4 },
  { type: 'testStart', test: { id: 2, name: 'account UAT-AC505 warns about the drafts', suiteID: 0 }, time: 10 },
  { type: 'testDone', testID: 2, result: 'success', hidden: false, skipped: false, time: 25 },
  { type: 'testStart', test: { id: 3, name: 'account broken', suiteID: 0 }, time: 30 },
  { type: 'testDone', testID: 3, result: 'failure', hidden: false, skipped: false, time: 31 },
  { type: 'testStart', test: { id: 4, name: 'account skipped', suiteID: 0 }, time: 40 },
  { type: 'testDone', testID: 4, result: 'success', hidden: false, skipped: true, time: 40 },
  { type: 'testDone', testID: 99, result: 'success', hidden: false, time: 41 },
];

test('a Flutter test that ended becomes a journal line with its file, full name and status; hidden loading steps and unknown tests are left out', () => {
  const lines = dartJournal(events, Date.parse('2026-11-04T10:00:00.000Z'));
  assert.deepEqual(
    lines.map((line) => [line.suite, line.name, line.status, line.durationMs]),
    [
      ['dart', 'account UAT-AC505 warns about the drafts', 'passed', 15],
      ['dart', 'account broken', 'failed', 1],
      ['dart', 'account skipped', 'skipped', 0],
    ],
  );
  assert.equal(lines[0].file, resolve('apps', 'mobile', 'test', 'a_test.dart'));
  assert.equal(lines[0].at, '2026-11-04T10:00:00.010Z');
});

test('the output of the reporter is read line by line and a line that is not JSON is left out', () => {
  assert.deepEqual(parseEvents('{"type":"start"}\r\n\nnot json\n{"type":"done"}\n'), [{ type: 'start' }, { type: 'done' }]);
});

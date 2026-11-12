import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { annotationCommand, annotationText, escapeMessage, escapeProperty, failureBlocks, main } from './ci-annotate.mjs';

const JEST_LOG = [
  'PASS src/a.test.ts',
  'FAIL src/b.test.ts',
  '  ● the total > adds the lines',
  '    expect(received).toBe(expected)',
  '    Expected: 3',
  '    Received: 2',
  'PASS src/c.test.ts',
  'Tests:       1 failed, 40 passed, 41 total',
].join('\n');

test('escapes the message as a workflow command requires', () => {
  assert.equal(escapeMessage('a%b\r\nc'), 'a%25b%0D%0Ac');
  assert.equal(escapeProperty('a:b,c'), 'a%3Ab%2Cc');
});

test('jest: the failing suite and its first error lines are one block, the passing ones are left out', () => {
  const blocks = failureBlocks(JEST_LOG, 'jest');
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /FAIL src\/b\.test\.ts/);
  assert.match(blocks[0], /Expected: 3/);
  assert.doesNotMatch(blocks[0], /PASS src\/a/);
});

test('dart: the [E] line and the lines after it are kept, colours are removed', () => {
  const log = ['00:01 +3: ok', '\u001b[31m00:02 +3 -1: test/x_test.dart: moment in the zone [E]\u001b[0m', '  Expected: \'07:00\'', '    Actual: \'00:00\'', '00:03 +4 -1: Some tests failed.'].join('\n');
  const blocks = failureBlocks(log, 'dart');
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /x_test\.dart: moment in the zone \[E\]/);
  assert.match(blocks[0], /Actual: '00:00'/);
  assert.equal(blocks[0].includes(String.fromCharCode(27)), false);
});

test('playwright: numbered failures and the summary line are reported', () => {
  const log = ['Running 40 tests using 1 worker', '  1) [chromium] > route.spec.ts:10:5 > the walk', '    Error: expect(locator).toBeVisible()', '  1 failed', '  39 passed'].join('\n');
  const text = annotationText(log, 'playwright');
  assert.match(text, /the walk/);
  assert.match(text, /1 failed/);
});

test('gates: a FAIL line is found', () => {
  assert.equal(failureBlocks('ok 1 - a\nFAIL  coverage-floor: 80 < 90\nok 2 - b', 'gates').length, 1);
});

test('a log with no matching line reports its last lines instead of nothing', () => {
  const text = annotationText('line one\n\nline two', 'jest');
  assert.match(text, /no failure line matched/);
  assert.match(text, /line two/);
});

test('many blocks are limited and a long message is cut below the limit of the check-run API', () => {
  const many = Array.from({ length: 200 }, (_, index) => `FAIL src/f${index}.test.ts\n${'x'.repeat(380)}\n\n\n\n\n\n\n\nfiller`).join('\n');
  const text = annotationText(many, 'jest');
  assert.ok(text.length < 49_000);
  assert.match(text, /first 60 shown/);
  const huge = annotationText(`FAIL a\n${'y'.repeat(400)}\n`.repeat(1), 'jest');
  assert.ok(huge.length < 49_000);
});

test('the command line is a single line with an escaped title', () => {
  const line = annotationCommand(JEST_LOG, 'jest', 'Tests: all');
  assert.ok(line.startsWith('::error title=Tests%3A all::'));
  assert.equal(line.includes('\n'), false);
});

test('an unknown kind throws, the entry point never fails the step', () => {
  assert.throws(() => failureBlocks('x', 'nope'), /unknown kind/);
  const lines = [];
  assert.equal(main([], (line) => lines.push(line)), 0);
  assert.match(lines[0], /usage/);
  assert.equal(main([join(tmpdir(), 'does-not-exist-ci-annotate.log'), 'jest'], (line) => lines.push(line)), 0);
  assert.match(lines[1], /does not exist/);
  const dir = mkdtempSync(join(tmpdir(), 'ci-annotate-'));
  const file = join(dir, 'log.txt');
  writeFileSync(file, JEST_LOG);
  assert.equal(main([file, 'jest', '--title', 'Mine'], (line) => lines.push(line)), 0);
  assert.match(lines[2], /^::error title=Mine::/);
  assert.equal(main([file, 'jest'], (line) => lines.push(line)), 0);
  assert.match(lines[3], /^::error title=Failures \(jest\)::/);
});

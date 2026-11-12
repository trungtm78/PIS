import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { annotationCommands, annotationText, chunksOf, escapeMessage, escapeProperty, failureBlocks, main } from './ci-annotate.mjs';

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

test('jest kind: failures of the node test runner (TAP) and of a coverage floor in the same log are found', () => {
  const log = ['ok 1 - a', 'not ok 2 - the script test that fails', '  ---', '  error: boom', '  ...', 'Error: 82.00% line coverage does not meet threshold 90%'].join('\n');
  const text = annotationText(log, 'jest');
  assert.match(text, /not ok 2 - the script test that fails/);
  assert.match(text, /does not meet threshold/);
});

test('dart: the [E] line and the lines after it are kept, colours are removed', () => {
  const log = ['00:01 +3: ok', '\u001b[31m00:02 +3 -1: test/x_test.dart: moment in the zone [E]\u001b[0m', "  Expected: '07:00'", "    Actual: '00:00'", '00:03 +4 -1: Some tests failed.'].join('\n');
  const blocks = failureBlocks(log, 'dart');
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /x_test\.dart: moment in the zone \[E\]/);
  assert.match(blocks[0], /Actual: '00:00'/);
  assert.equal(blocks[0].includes(String.fromCharCode(27)), false);
});

test('dart: the github reporter marks a failed test with a cross, passing tests are left out', () => {
  const log = ['✅ /w/test/a_test.dart: group fine', '❌ /w/test/b_test.dart: group the moment shows 07:00', 'Expected: 07:00', '2401 tests passed, 2 failed, 1 skipped.'].join('\n');
  const text = annotationText(log, 'dart');
  assert.match(text, /❌ \/w\/test\/b_test\.dart/);
  assert.doesNotMatch(text.split('--- end of the log:')[0], /group fine/);
});

test('playwright: numbered failures and the summary line are reported', () => {
  const log = ['Running 40 tests using 1 worker', '  1) [chromium] > route.spec.ts:10:5 > the walk', '    Error: expect(locator).toBeVisible()', '  1 failed', '  39 passed'].join('\n');
  const text = annotationText(log, 'playwright');
  assert.match(text, /the walk/);
  assert.match(text, /1 failed/);
});

test('the end of the log is always part of the text, so a killed step shows where the log stops', () => {
  const text = annotationText(['FAIL src/a.test.ts', 'step one', 'step two', 'the log stops here'].join('\n'), 'jest');
  assert.match(text, /--- end of the log:\n[\s\S]*the log stops here$/);
});

test('gates: a FAIL line is found', () => {
  assert.equal(failureBlocks('ok 1 - a\nFAIL  coverage-floor: 80 < 90\nok 2 - b', 'gates').length, 1);
});

test('a log with no matching line reports its last lines instead of nothing', () => {
  const text = annotationText('line one\n\nline two', 'jest');
  assert.match(text, /no failure line matched/);
  assert.match(text, /line two/);
});

test('many blocks are limited and the message is cut into chunks under the 4 KB an annotation shows', () => {
  const many = Array.from({ length: 200 }, (_, index) => `FAIL src/f${index}.test.ts\n${['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => letter.repeat(230)).join('\n')}`).join('\n');
  const text = annotationText(many, 'jest');
  assert.match(text, /first 80 shown/);
  const chunks = chunksOf(text);
  assert.equal(chunks.length, 8);
  assert.ok(chunks.every((chunk) => chunk.length < 4000));
  assert.match(chunks[7], /\[cut: \d+ more chunk/);
  assert.equal(chunksOf('short').length, 1);
  assert.equal(chunksOf('y'.repeat(9000))[0].length, 3600);
});

test('lines of passing tests inside a block are left out', () => {
  const blocks = failureBlocks(['  1) the walk', '  ✓ passes one', '  ✅ passes two', 'ok 3 - passes three', 'Error: boom'].join('\n'), 'playwright');
  assert.equal(blocks.length, 1);
  assert.doesNotMatch(blocks[0], /passes/);
  assert.match(blocks[0], /boom/);
});

test('every chunk is its own single-line command with a numbered, escaped title', () => {
  const [single] = annotationCommands(JEST_LOG, 'jest', 'Tests: all');
  assert.ok(single.startsWith('::error title=Tests%3A all::'));
  assert.equal(single.includes('\n'), false);
  const many = Array.from({ length: 60 }, (_, index) => `FAIL src/f${index}.test.ts\n${'x'.repeat(230)}`).join('\n');
  const commands = annotationCommands(many, 'jest', 'T');
  assert.ok(commands.length > 1);
  assert.ok(commands[0].startsWith(`::error title=T (1/${commands.length})::`));
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

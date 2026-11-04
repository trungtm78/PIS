import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { THRESHOLD, coverageOfLibraries, main } from './coverage-libs.mjs';

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

/** The report of one file: one statement on each line, run or not as `hits` says. */
function report(path, hits) {
  const statementMap = {};
  const s = {};
  hits.forEach((hit, index) => {
    statementMap[String(index)] = { start: { line: index + 1, column: 0 }, end: { line: index + 1, column: 1 } };
    s[String(index)] = hit;
  });
  return { path, statementMap, fnMap: {}, branchMap: {}, s, f: {}, b: {} };
}

const source = (root, library, name) => join(root, 'packages', library, 'src', name);
const run = (root) => {
  const lines = [];
  const code = main(['--root', root, '--locale', 'en'], { log: (line) => lines.push(line) });
  return { code, lines };
};

function worldFor(spec) {
  const root = mkdtempSync(join(tmpdir(), 'coverage-libs-'));
  roots.push(root);
  const reports = spec(root);
  for (const [directory, files] of Object.entries(reports)) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, 'coverage-final.json'), JSON.stringify(Object.fromEntries(files.map((file) => [file.path, file]))));
  }
  return root;
}

test('the threshold is 90 per cent of lines', () => {
  assert.equal(THRESHOLD, 90);
});

test('a line that any suite ran counts, so the lines the library suite missed and the api suite ran are covered', () => {
  const root = worldFor((r) => ({
    'packages/db/coverage': [report(source(r, 'db', 'store.ts'), [1, 0, 0, 0])],
    'packages/kernel/coverage': [report(source(r, 'kernel', 'rule.ts'), [1, 1])],
    'apps/api/coverage': [report(source(r, 'db', 'store.ts'), [0, 1, 1, 1])],
  }));
  const { missing, results } = coverageOfLibraries(root);
  assert.deepEqual(missing, []);
  assert.deepEqual(
    results.map(({ name, files, covered, total, pct }) => ({ name, files, covered, total, pct })),
    [
      { name: 'db', files: 1, covered: 4, total: 4, pct: 100 },
      { name: 'kernel', files: 1, covered: 2, total: 2, pct: 100 },
    ],
  );
  const { code, lines } = run(root);
  assert.equal(code, 0);
  assert.match(lines[0], /^db: 100\.00% of lines run \(4\/4\), threshold 90%$/);
  assert.equal(lines.at(-1), 'The coverage of the libraries meets the threshold');
});

test('a library under the threshold fails the run and says how many lines were run', () => {
  const root = worldFor((r) => ({
    'packages/db/coverage': [report(source(r, 'db', 'store.ts'), [1, 0, 0, 0])],
    'packages/kernel/coverage': [report(source(r, 'kernel', 'rule.ts'), [1, 1])],
    'apps/api/coverage': [report(source(r, 'db', 'store.ts'), [1, 0, 0, 0])],
  }));
  const { code, lines } = run(root);
  assert.equal(code, 1);
  assert.match(lines[0], /^db: 25\.00% of lines run \(1\/4\), threshold 90%$/);
  assert.equal(lines.at(-1), '1 coverage item(s) failed: add tests for the lines that were not run');
});

test('a report that is missing fails the run: the suites were not run, so nothing is known', () => {
  const root = worldFor((r) => ({
    'packages/db/coverage': [report(source(r, 'db', 'store.ts'), [1, 1])],
    'packages/kernel/coverage': [report(source(r, 'kernel', 'rule.ts'), [1, 1])],
  }));
  const { code, lines } = run(root);
  assert.equal(code, 1);
  assert.match(lines[0], /^Coverage report not found: .*apps.api.coverage.coverage-final\.json \(run npm test first\)$/);
});

test('a library with no source in any report fails: no data is not a pass', () => {
  const root = worldFor((r) => ({
    'packages/db/coverage': [report(source(r, 'db', 'store.ts'), [1, 1])],
    'packages/kernel/coverage': [report(join(r, 'packages', 'kernel', 'other', 'x.ts'), [1, 1])],
    'apps/api/coverage': [report(source(r, 'db', 'store.ts'), [1, 1])],
  }));
  const { code, lines } = run(root);
  assert.equal(code, 1);
  assert.match(lines.find((line) => line.startsWith('kernel:')) ?? '', /^kernel: 0\.00% of lines run \(0\/0\)/);
});

test('the files of other packages and the test files are not counted', () => {
  const root = worldFor((r) => ({
    'packages/db/coverage': [
      report(source(r, 'db', 'store.ts'), [1, 1]),
      report(source(r, 'db', 'store.test.ts'), [0, 0, 0, 0]),
      report(join(r, 'apps', 'api', 'src', 'app.ts'), [0, 0, 0, 0]),
    ],
    'packages/kernel/coverage': [report(source(r, 'kernel', 'rule.ts'), [1, 1])],
    'apps/api/coverage': [report(source(r, 'db', 'store.ts'), [1, 1])],
  }));
  const { results } = coverageOfLibraries(root);
  assert.deepEqual(results.map(({ name, total }) => [name, total]), [['db', 2], ['kernel', 2]]);
});

test('the messages are in both languages', () => {
  const root = worldFor((r) => ({
    'packages/db/coverage': [report(source(r, 'db', 'store.ts'), [1])],
    'packages/kernel/coverage': [report(source(r, 'kernel', 'rule.ts'), [1])],
    'apps/api/coverage': [report(source(r, 'db', 'store.ts'), [1])],
  }));
  const lines = [];
  assert.equal(main(['--root', root], { log: (line) => lines.push(line) }), 0);
  assert.match(lines.at(-1), /Độ phủ/);
});

// Bridge of the UAT run r6: turns the journals the repo's own reporters wrote (UAT_JOURNAL of Jest and Playwright, see scripts/uat-run.mjs)
// into the `checks` format that merge_results.py of the uat-test-only skill reads. It decides nothing: a design case takes the worst state of the
// tests whose title names it (the rule of scripts/uat-run.mjs, which this file imports).
//
// node journal-to-checks.mjs --cases <OUT>/cases.json --suite jest|playwright --out <file> <journal>...
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const { values, positionals } = parseArgs({
  options: { cases: { type: 'string' }, suite: { type: 'string' }, out: { type: 'string' }, repo: { type: 'string', default: '.' } },
  allowPositionals: true,
});
const repo = resolve(values.repo);
const { readJournal, testsOfRun, resultsOfTests } = await import(pathToFileURL(resolve(repo, 'scripts', 'uat-run.mjs')).href);

const plan = JSON.parse(readFileSync(values.cases, 'utf8').replace(/^﻿/, ''));
const planned = plan.cases.map((entry) => entry.tc_id);
// The design id is the case id without the "TC-" the writer adds.
const design = new Map(planned.map((id) => [id.replace(/^TC-/, ''), id]));
const known = new Set(design.keys());

const lines = positionals.flatMap((path) => readJournal(readFileSync(path, 'utf8')));
const tests = testsOfRun(lines, repo).filter((test) => values.suite === undefined || test.suite === values.suite);
const results = resultsOfTests(tests, known);

const checks = [];
for (const [id, entry] of [...results].sort(([left], [right]) => left.localeCompare(right))) {
  const tcId = design.get(id);
  if (tcId === undefined) continue;
  const failed = entry.tests.filter((test) => test.status !== 'passed' && !['skipped', 'pending', 'todo', 'disabled'].includes(test.status));
  const record = { tc_id: tcId, name: entry.tests.map((test) => test.name).slice(0, 3).join(' | ').slice(0, 300), duration_ms: entry.tests.reduce((sum, test) => sum + (test.durationMs ?? 0), 0) };
  if (entry.result === 'PASS') checks.push({ ...record, status: 'PASS', reasons: [] });
  else if (entry.result === 'FAIL') checks.push({ ...record, status: 'FAIL', reasons: failed.map((test) => `${test.file} :: ${test.name} -> ${test.status}`).slice(0, 5), reason: 'failed' });
  else checks.push({ ...record, status: 'KHONG_CHAY', reason: 'bi-bo-qua', reasons: ['every test that names the case was skipped'] });
}
writeFileSync(values.out, `${JSON.stringify({ checks }, null, 2)}\n`);
const count = (status) => checks.filter((check) => check.status === status).length;
console.log(`journal-to-checks: ${tests.length} tests -> ${checks.length} planned cases named (PASS ${count('PASS')}, FAIL ${count('FAIL')}, skipped ${count('KHONG_CHAY')}) -> ${values.out}`);

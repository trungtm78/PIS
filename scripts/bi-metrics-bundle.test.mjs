import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildBundle, main, metricFiles } from './bi-metrics-bundle.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = [];
const directory = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'bi-metrics-'));
  scratch.push(root);
  mkdirSync(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), typeof text === 'string' ? text : JSON.stringify(text));
  return root;
};
const field = (name) => ({ op: 'field', name });
const sum = (name) => ({ op: 'sum', args: [field(name)] });
const RATE = { code: 'disbursement_rate', grain: 'project', aggregation_type: 'ratio', numerator: sum('GIAI_NGAN'), denominator: sum('KE_HOACH_TTG'), unit: 'percent', effective_from: '2026-01-01' };
const BALANCE = { code: 'capital_balance', grain: 'fund', aggregation_type: 'semi_additive', expression: sum('SO_DU'), unit: 'VND', effective_from: '2026-01-01' };
const silent = { log: () => undefined, error: () => undefined };

after(() => {
  for (const root of scratch) rmSync(root, { recursive: true, force: true });
});

describe('the bundle of the metric files (ST-BI-001, TK-BI-001-5)', () => {
  it('AC-ST-BI-001-1: builds a bundle sorted by code whose hash is the hash of its bytes, whatever order the files are listed in', async () => {
    const a = await buildBundle(directory({ 'z.metric.json': RATE, 'a.metric.json': BALANCE, 'notes.txt': 'ignored' }));
    const b = await buildBundle(directory({ 'a.metric.json': RATE, 'b.metric.json': BALANCE }));
    assert.equal(a.ok, true);
    assert.equal(a.count, 2);
    assert.equal(a.sha256, createHash('sha256').update(a.bytes).digest('hex'));
    assert.deepEqual(JSON.parse(a.bytes.toString()).metrics.map((metric) => metric.code), ['capital_balance', 'disbursement_rate']);
    assert.equal(a.sha256, b.sha256);
  });

  it('reads the YAML of the repository with the library it loads, and builds nothing from a directory that has no metric', async () => {
    const root = directory({ 'rate.metric.yaml': 'code: x' });
    const loaded = [];
    const result = await buildBundle(root, { loadYaml: async () => ({ load: (text) => (loaded.push(text), { ...RATE, code: 'from_yaml' }) }) });
    assert.equal(result.ok, true);
    assert.deepEqual(loaded, ['code: x']);
    assert.equal((await buildBundle(join(root, 'missing'))).count, 0);
    assert.equal((await buildBundle(directory({}))).count, 0);
  });

  it('refuses, naming the file, a metric the server would refuse, a file that cannot be read and a code defined twice', async () => {
    const result = await buildBundle(
      directory({
        'a.metric.json': RATE,
        'b.metric.json': { ...RATE, unit: '' },
        'c.metric.json': { ...BALANCE, expression: { op: 'raw_sql' } },
        'd.metric.json': '{ not json',
        'e.metric.json': RATE,
        'f.metric.yaml': 'code: x',
      }),
      { loadYaml: async () => ({ load: () => { throw new Error('bad yaml'); } }) },
    );
    assert.equal(result.ok, false);
    const text = result.problems.join('\n');
    assert.match(text, /b\.metric\.json: METRIC_DEFINITION_INVALID \(unit\)/);
    assert.match(text, /c\.metric\.json: METRIC_DEFINITION_INVALID \(expression\)|c\.metric\.json: EXPRESSION_NOT_ALLOWED \(expression\)/);
    assert.match(text, /d\.metric\.json:/);
    assert.match(text, /e\.metric\.json: the code disbursement_rate is already defined in .*a\.metric\.json/);
    assert.match(text, /f\.metric\.yaml: bad yaml/);
  });

  it('refuses more metrics than the server accepts in one bundle', async () => {
    const kernel = await import('../packages/kernel/src/bi-metric.ts');
    const result = await buildBundle(directory({ 'a.metric.json': RATE, 'b.metric.json': BALANCE }), { kernel: { ...kernel, METRIC_MAX_BUNDLE: 1 } });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /2 metrics, more than the 1 a bundle may hold/);
    assert.equal((await buildBundle(directory({ 'a.metric.json': RATE, 'b.metric.json': BALANCE }), { kernel: { ...kernel, METRIC_MAX_BUNDLE: 2 } })).ok, true);
  });

  it('lists only metric files, in the order of their names', () => {
    const root = directory({ 'b.metric.yml': '', 'a.metric.yaml': '', 'c.metric.json': '', 'c.json': '' });
    assert.deepEqual(metricFiles(root).map((file) => file.slice(root.length + 1)), ['a.metric.yaml', 'b.metric.yml', 'c.metric.json']);
  });

  it('writes the bundle to a file and prints its hash, checks without writing, and fails on a bad file', async () => {
    const root = directory({ 'a.metric.json': RATE });
    const out = join(root, 'bundle.json');
    const logged = [];
    assert.equal(await main(['--dir', root, '--out', out], { log: (line) => logged.push(line), error: () => undefined }), 0);
    assert.match(logged[0], /^metrics=1 sha256=[0-9a-f]{64}$/);
    assert.equal(createHash('sha256').update(readFileSync(out)).digest('hex'), logged[0].split('sha256=')[1]);
    const other = join(root, 'other.json');
    assert.equal(await main(['--dir', root, '--out', other, '--check'], silent), 0);
    assert.throws(() => readFileSync(other));
    const errors = [];
    assert.equal(await main(['--dir', directory({ 'a.metric.json': { ...RATE, unit: '' } })], { log: () => undefined, error: (line) => errors.push(line) }), 1);
    assert.equal(errors.length, 1);
  });

  it('AC-ST-BI-001-1: builds the metric files that are in the repository', async () => {
    const result = await buildBundle(join(REPO, 'metrics'));
    assert.equal(result.ok, true);
    assert.ok(result.count >= 1);
  });
});

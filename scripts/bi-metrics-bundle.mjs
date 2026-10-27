import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const METRIC_FILE = /\.metric\.(ya?ml|json)$/;

/** Every metric file under a directory, in the order of their names: the order of the bundle never depends on the order the disk lists them. */
export function metricFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => METRIC_FILE.test(name))
    .sort()
    .map((name) => join(directory, name));
}

/** The YAML library is loaded only when a YAML file is read, so a repository of JSON files needs none. */
async function readDocument(file, loadYaml) {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.json')) return JSON.parse(text);
  const yaml = await loadYaml();
  return yaml.load(text);
}

/**
 * Turns the metric files of the repository into the bundle the deploy pipeline hands to `syncMetricRegistry` (ST-BI-001, BI 3 F1): a JSON document with a version and the metrics sorted by code, and the
 * SHA-256 of its bytes. Every metric is judged by the validator of the kernel, the one the server uses, so a file the server would refuse fails here, in the pull request, naming the file.
 */
export async function buildBundle(directory, options = {}) {
  const kernel = options.kernel ?? (await import(pathToFileURL(join(REPO_ROOT, 'packages', 'kernel', 'src', 'bi-metric.ts')).href));
  const loadYaml = options.loadYaml ?? (() => import('js-yaml'));
  const problems = [];
  const metrics = [];
  const seen = new Map();
  for (const file of metricFiles(directory)) {
    let document;
    try {
      document = await readDocument(file, loadYaml);
    } catch (error) {
      problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const checked = kernel.metricOfDocument(document);
    if (!checked.ok) {
      problems.push(`${file}: ${checked.problem.code} (${checked.problem.field})`);
      continue;
    }
    if (seen.has(checked.value.code)) {
      problems.push(`${file}: the code ${checked.value.code} is already defined in ${seen.get(checked.value.code)}`);
      continue;
    }
    seen.set(checked.value.code, file);
    metrics.push(document);
  }
  // The server refuses a bundle with more metrics than this: the pull request must not approve what the sync cannot deploy.
  if (metrics.length > kernel.METRIC_MAX_BUNDLE) problems.push(`${directory}: ${metrics.length} metrics, more than the ${kernel.METRIC_MAX_BUNDLE} a bundle may hold`);
  if (problems.length > 0) return { ok: false, problems };
  metrics.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const bytes = Buffer.from(JSON.stringify({ version: 1, metrics }), 'utf8');
  return { ok: true, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), count: metrics.length };
}

export async function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  const { values } = parseArgs({ args: argv, options: { dir: { type: 'string', default: join(REPO_ROOT, 'metrics') }, out: { type: 'string' }, check: { type: 'boolean', default: false } } });
  const result = await buildBundle(values.dir);
  if (!result.ok) {
    for (const problem of result.problems) io.error(problem);
    return 1;
  }
  if (values.out !== undefined && !values.check) writeFileSync(values.out, result.bytes);
  io.log(`metrics=${result.count} sha256=${result.sha256}`);
  return 0;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}

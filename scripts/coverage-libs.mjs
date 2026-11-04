import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import libCoverage from 'istanbul-lib-coverage';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_LOCALE = 'vi';
/** The share of lines of the sources of a library that all the suites together must run. */
export const THRESHOLD = 90;
/** The libraries whose code is exercised by the suites of other workspaces too (the stores of db through the routes of the api). */
export const LIBRARIES = ['db', 'kernel'];
/** The reports (`coverage-final.json`) of the suites that run the code of the libraries: their own, and the api suite, which also measures them. */
export const REPORT_DIRECTORIES = ['packages/db/coverage', 'packages/kernel/coverage', 'apps/api/coverage'];

function loadMessages(locale) {
  return JSON.parse(readFileSync(join(SCRIPT_DIR, 'messages', `${locale}.json`), 'utf8'));
}

function format(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

const slashed = (path) => path.split('\\').join('/').toLowerCase();

/**
 * The lines of the sources of each library that the suites ran, all the reports merged: a line counts when any suite ran it. Returns the
 * reports that are missing (the suites were not run) and, for each library, how many of its lines were run.
 */
export function coverageOfLibraries(root, { libraries = LIBRARIES, directories = REPORT_DIRECTORIES } = {}) {
  const missing = [];
  const merged = libCoverage.createCoverageMap({});
  for (const directory of directories) {
    const path = join(root, directory, 'coverage-final.json');
    if (!existsSync(path)) {
      missing.push(path);
      continue;
    }
    merged.merge(libCoverage.createCoverageMap(JSON.parse(readFileSync(path, 'utf8'))));
  }
  const results = libraries.map((name) => {
    const prefix = `${slashed(join(root, 'packages', name, 'src'))}/`;
    const own = libCoverage.createCoverageMap({});
    for (const file of merged.files()) if (slashed(file).startsWith(prefix) && !file.endsWith('.test.ts')) own.addFileCoverage(merged.fileCoverageFor(file));
    const { lines } = own.getCoverageSummary();
    return { name, files: own.files().length, total: lines.total, covered: lines.covered, pct: lines.total === 0 ? 0 : (lines.covered / lines.total) * 100 };
  });
  return { missing, results };
}

export function main(argv, { log = console.log } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: { root: { type: 'string', default: REPO_ROOT }, locale: { type: 'string', default: DEFAULT_LOCALE } },
  });
  const messages = loadMessages(values.locale);
  const { missing, results } = coverageOfLibraries(resolve(values.root));
  for (const path of missing) log(format(messages['coverage.report.missing'], { path }));
  for (const result of results) {
    log(format(messages['coverage.library.line'], { name: result.name, pct: result.pct.toFixed(2), covered: result.covered, total: result.total, threshold: THRESHOLD }));
  }
  const below = results.filter((result) => result.total === 0 || result.pct < THRESHOLD);
  if (missing.length > 0 || below.length > 0) {
    log(format(messages['coverage.summary.fail'], { count: missing.length + below.length }));
    return 1;
  }
  log(messages['coverage.summary.pass']);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}

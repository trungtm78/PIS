// Builds the demo templates of the six report forms (RPT-1, owner decision of 2026-11-08): the .xlsx template of each form and the .docx narrative skeleton of the forms that have a narrative part, written into
// packages/edition-enterprise/templates/demo/. The forms are designed by the system (status DEMO: demo forms designed by the system, not the official forms); the bytes are deterministic, so
//   node packages/edition-enterprise/scripts/build-demo-templates.mjs            writes the files;
//   node packages/edition-enterprise/scripts/build-demo-templates.mjs --check    exits 1 when a committed file differs from what the layouts give (or a file is missing or unknown);
//   node packages/edition-enterprise/scripts/build-demo-templates.mjs --out <dir> writes into another folder.
// The builder is TypeScript (src/report-forms/template-builder.ts) loaded by Node itself; run it with Node 22.6 or newer.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, '..');
export const DEFAULT_OUT = join(PACKAGE_DIR, 'templates', 'demo');

/** Loads the builder (TypeScript) and returns every template file the six layouts give. */
export async function buildFiles() {
  const { buildDemoTemplates } = await import(pathToFileURL(join(PACKAGE_DIR, 'src', 'report-forms', 'template-builder.ts')).href);
  return buildDemoTemplates();
}

/** Writes the files into `out`. */
export function writeFiles(files, out) {
  mkdirSync(out, { recursive: true });
  for (const file of files) writeFileSync(join(out, file.name), file.bytes);
}

/** Compares the files with the ones in `out`: the names that are missing, stale or not expected. Empty means the folder is exactly what the layouts give. */
export function checkFiles(files, out) {
  const problems = [];
  const expected = new Set(files.map((file) => file.name));
  for (const file of files) {
    const path = join(out, file.name);
    if (!existsSync(path)) problems.push(`${file.name}: missing`);
    else if (!Buffer.from(file.bytes).equals(readFileSync(path))) problems.push(`${file.name}: stale (rebuild with npm run templates:build -w @machvon/edition-enterprise)`);
  }
  if (existsSync(out)) for (const name of readdirSync(out)) if (!expected.has(name)) problems.push(`${name}: not a template of any demo form`);
  return problems;
}

async function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean', default: false }, out: { type: 'string' } } });
  const out = values.out === undefined ? DEFAULT_OUT : resolve(values.out);
  const files = await buildFiles();
  if (values.check) {
    const problems = checkFiles(files, out);
    if (problems.length > 0) {
      for (const problem of problems) process.stderr.write(`${problem}\n`);
      process.exit(1);
    }
    process.stdout.write(`The ${files.length} demo templates in ${out} are what the layouts give\n`);
    return;
  }
  writeFiles(files, out);
  process.stdout.write(`Wrote ${files.length} demo templates to ${out}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
}

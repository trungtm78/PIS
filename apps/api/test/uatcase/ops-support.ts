import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * What the operations cases (NFR operability, security pipeline, legal, availability) share. Those cases are proved by the checkers the pipeline runs (`scripts/*.mjs`, one per gate): a case builds a
 * scratch copy of the repository files the checker reads, makes the change the case describes, runs the real checker, and reads what it says and how it ends.
 */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
export const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');

/**
 * Runs `body` (the body of an async function, ES module syntax with top-level `load(name)` for a script of `scripts/`) in a node process of its own and returns what it returned, as JSON. A checker is an ES module
 * that is also a command line tool, so it is run the way the pipeline runs it, in a process, and not pulled into the Jest module registry. The input arrives as the variable `input`.
 */
export function runChecker<T>(body: string, input: Record<string, unknown> = {}): T {
  const code = [
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const input = JSON.parse(readFileSync(0, 'utf8'));",
    'const load = (name) => import(pathToFileURL(join(input.scripts, name)).href);',
    `const result = await (async () => {\n${body}\n})();`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  const reply = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    input: JSON.stringify({ ...input, scripts: SCRIPTS_DIR }),
    encoding: 'utf8',
    cwd: REPO_ROOT,
    maxBuffer: 1 << 26,
  });
  if (reply.status !== 0) throw new Error(`the checker process ended with ${String(reply.status)}: ${reply.stderr}`);
  return JSON.parse(reply.stdout) as T;
}

/** The scratch directories of a suite; `removeScratch` clears them. */
const made: string[] = [];

export function scratchDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), `machvon-${prefix}-`));
  made.push(directory);
  return directory;
}

export function removeScratch(): void {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
}

export function writeText(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export function readJson<T>(root: string, path: string): T {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as T;
}

export function editJson<T>(root: string, path: string, change: (value: T) => void): void {
  const value = readJson<T>(root, path);
  change(value);
  writeText(root, path, JSON.stringify(value, null, 2));
}

/** A scratch copy of the infrastructure declarations and their runbooks, the files `scripts/infra-check.mjs` reads. */
export function scratchInfrastructure(): string {
  const root = scratchDirectory('infra');
  cpSync(join(REPO_ROOT, 'infra'), join(root, 'infra'), { recursive: true });
  if (existsSync(join(REPO_ROOT, 'docs', 'runbooks', 'infra'))) cpSync(join(REPO_ROOT, 'docs', 'runbooks', 'infra'), join(root, 'docs', 'runbooks', 'infra'), { recursive: true });
  return root;
}


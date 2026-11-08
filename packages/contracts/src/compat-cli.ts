import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runCompat } from './compat.ts';
import type { OpenApiDocument } from './openapi-document.ts';

export interface CliDeps {
  log(line: string): void;
  /** Directory the git commands run in; defaults to the process working directory. */
  cwd?: string;
}

const DEFAULT_SPEC = '../../Design/MACHVON_Design/03_Engineering/openapi.json';
const DEFAULT_BASE_REF = 'origin/main';
const DEFAULT_ALLOW_FILE = 'compat-allow.json';
const GIT_BUFFER_BYTES = 256 * 1024 * 1024;

// The variables with which git names the repository, a work tree or an index: a git hook (the pre-push gate) runs with them set, and they would point every command below at the repository of the hook instead of the one found from `cwd`.
const REPOSITORY_VARIABLES = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']);

export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => !REPOSITORY_VARIABLES.has(name)));
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, env: gitEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_BUFFER_BYTES });
  } catch {
    return undefined;
  }
}

// The contract at `baseRef`, or undefined when the reference or the file is not there.
function readAtRef(cwd: string, baseRef: string, specPath: string): OpenApiDocument | undefined {
  if (git(cwd, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]) === undefined) return undefined;
  const root = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (root === undefined) return undefined;
  // Both paths are expanded first: Windows may hand out 8.3 short names for one and long names for the other.
  const repositoryPath = relative(realpathSync.native(root), realpathSync.native(specPath)).split('\\').join('/');
  const text = git(cwd, ['show', `${baseRef}:${repositoryPath}`]);
  return text === undefined ? undefined : (JSON.parse(text) as OpenApiDocument);
}

/** Exit codes: 0 compatible or skipped, 1 breaking changes, 2 usage or file errors. */
export function main(argv: string[], deps: CliDeps): number {
  const cwd = deps.cwd ?? process.cwd();
  const { values } = parseArgs({
    args: argv,
    options: {
      spec: { type: 'string', default: resolve(cwd, DEFAULT_SPEC) },
      'base-ref': { type: 'string', default: DEFAULT_BASE_REF },
      allow: { type: 'string' },
    },
  });
  const specPath = resolve(cwd, values.spec);
  const defaultAllow = resolve(cwd, DEFAULT_ALLOW_FILE);
  const allowFile = values.allow !== undefined ? resolve(cwd, values.allow) : existsSync(defaultAllow) ? defaultAllow : undefined;
  let current: OpenApiDocument;
  try {
    current = JSON.parse(readFileSync(specPath, 'utf8')) as OpenApiDocument;
  } catch (error) {
    deps.log(`cannot read ${specPath}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  return runCompat(
    { baseRef: values['base-ref'], allowFile },
    { log: deps.log, readCurrent: () => current, readPrevious: (baseRef) => readAtRef(cwd, baseRef, specPath) },
  ).exitCode;
}

// Runs only when started as a script (node src/compat-cli.ts), never when imported by tests.
if (process.argv[1] !== undefined && /[\\/]compat-cli\.ts$/.test(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2), { log: (line) => process.stdout.write(`${line}\n`) });
}

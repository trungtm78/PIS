import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_OPENAPI = join(REPO_ROOT, 'Design', 'MACHVON_Design', '03_Engineering', 'openapi.json');
const DEFAULT_LOCALE = 'vi';
const MATRIX_RELATIVE_PATH = join('apps', 'api', 'test', 'authz', 'matrix-commands.json');
const VALIDATORS_RELATIVE_PATH = join('packages', 'contracts', 'src', 'request-schemas.generated.ts');
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage']);
const WRITE_METHODS = ['post', 'put', 'patch', 'delete'];
const WRITE_DECORATOR = /^@(Post|Put|Patch|Delete)\(/;
const OPERATION_ID = /^@OperationId\(\s*['"`]([^'"`]+)['"`]/;
// `@IdentityCommand` marks a command that runs before a tenant is chosen (an identity token, no tenant principal): it
// cannot use the command interceptor, counts as a command for this gate and is listed under "identityCommands".
const COMMAND_DECORATOR = /^@(Command|IdentityCommand)\(/;

function loadMessages(locale) {
  return JSON.parse(readFileSync(join(SCRIPT_DIR, 'messages', `${locale}.json`), 'utf8'));
}

function format(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

function* controllerFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* controllerFiles(path);
    else if (entry.name.endsWith('.ts')) yield path;
  }
}

function applicationSources(root) {
  const base = join(root, 'apps');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'src')))
    .map((entry) => join(base, entry.name, 'src'));
}

// A handler's decorators are the consecutive lines starting with `@` above its signature (one per line).
function* decoratorBlocks(text) {
  let block = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('@')) block.push(line);
    else if (line === '') continue;
    else {
      if (block.length > 0) yield block;
      block = [];
    }
  }
  if (block.length > 0) yield block;
}

const JSON_BODY = 'application/json';

// Write operations whose request declares a JSON body: the ones that need generated validation.
function bodyOperationIds(openapiPath) {
  const doc = JSON.parse(readFileSync(openapiPath, 'utf8'));
  const ids = new Set();
  for (const item of Object.values(doc.paths ?? {})) {
    for (const method of WRITE_METHODS) {
      const operation = item[method];
      if (typeof operation?.operationId === 'string' && operation.requestBody?.content?.[JSON_BODY] !== undefined) ids.add(operation.operationId);
    }
  }
  return ids;
}

// The operations that the generated request schemas cover: the keys of REQUEST_BODIES in the generated module.
function validatedOperations(validatorsPath) {
  if (!existsSync(validatorsPath)) return new Set();
  const source = readFileSync(validatorsPath, 'utf8');
  const start = source.indexOf('REQUEST_BODIES');
  const ids = new Set();
  if (start < 0) return ids;
  for (const match of source.slice(start).matchAll(/^\s*"([^"]+)":\s*"[^"]+",?\s*$/gm)) ids.add(match[1]);
  return ids;
}

function writeOperationIds(openapiPath) {
  const doc = JSON.parse(readFileSync(openapiPath, 'utf8'));
  const ids = [];
  for (const item of Object.values(doc.paths ?? {})) {
    for (const method of WRITE_METHODS) {
      const operation = item[method];
      if (operation !== undefined && typeof operation.operationId === 'string') ids.push(operation.operationId);
    }
  }
  return ids;
}

// The commands that the negative authorization matrices have fixtures for: {"commands": [operationId, ...]} for the
// tenant plane, an optional "controlCommands": [operationId, ...] for the control plane (matrix on realm roles) and an
// optional "identityCommands": [operationId, ...] for commands tested with identity tokens (no role matrix applies) and an optional
// "enterpriseCommands": [operationId, ...] for the commands that exist in the enterprise edition only (ENT-2): the public application does not implement them, so the matrix of the public
// application must not list them, and their negative cases run against the enterprise application (apps/api/test/editions/*.enterprise.test.ts).
// A missing file means the matrices cover nothing.
function matrixCommands(matrixPath) {
  if (!existsSync(matrixPath)) return new Set();
  const parsed = JSON.parse(readFileSync(matrixPath, 'utf8'));
  const isIdList = (value) => Array.isArray(value) && value.every((id) => typeof id === 'string');
  const optional = (value) => value === undefined || isIdList(value);
  if (!isIdList(parsed?.commands) || !optional(parsed.controlCommands) || !optional(parsed.identityCommands) || !optional(parsed.enterpriseCommands)) {
    throw new Error(`${matrixPath} must be {"commands": [operationId, ...], "controlCommands"?: [operationId, ...], "identityCommands"?: [operationId, ...], "enterpriseCommands"?: [operationId, ...]}`);
  }
  return new Set([...parsed.commands, ...(parsed.controlCommands ?? []), ...(parsed.identityCommands ?? []), ...(parsed.enterpriseCommands ?? [])]);
}

/**
 * Finds the write handlers (`@Post`, `@Put`, `@Patch`, `@Delete` with `@OperationId`) under apps/(star)/src of
 * `root` and returns the operationIds that lack `@Command` (`uncovered`) and the implemented ones that the
 * OpenAPI document does not define as write operations (`unknown`). With a `matrixPath` it also returns the
 * implemented commands that have no fixture in the negative authorization matrix (`unmatrixed`). With a
 * `validatorsPath` it also returns the implemented commands that declare a JSON body but are missing from the
 * generated request schemas (`unvalidated`), so a command can never ship without generated body validation.
 */
export function commandCoverage(root, openapiPath = DEFAULT_OPENAPI, matrixPath = undefined, validatorsPath = undefined) {
  const defined = new Set(writeOperationIds(openapiPath));
  const implemented = new Set();
  const uncovered = new Set();
  for (const source of applicationSources(root)) {
    for (const file of controllerFiles(source)) {
      for (const block of decoratorBlocks(readFileSync(file, 'utf8'))) {
        if (!block.some((line) => WRITE_DECORATOR.test(line))) continue;
        const id = block.map((line) => OPERATION_ID.exec(line)?.[1]).find((value) => value !== undefined);
        if (id === undefined) continue;
        implemented.add(id);
        if (!block.some((line) => COMMAND_DECORATOR.test(line))) uncovered.add(id);
      }
    }
  }
  const matrixed = matrixPath === undefined ? undefined : matrixCommands(matrixPath);
  const withBody = validatorsPath === undefined ? undefined : bodyOperationIds(openapiPath);
  const validated = validatorsPath === undefined ? undefined : validatedOperations(validatorsPath);
  return {
    writeOperations: defined.size,
    implemented: [...implemented].sort(),
    uncovered: [...uncovered].sort(),
    unknown: [...implemented].filter((id) => !defined.has(id)).sort(),
    unmatrixed: matrixed === undefined ? [] : [...implemented].filter((id) => !matrixed.has(id)).sort(),
    unvalidated: validated === undefined ? [] : [...implemented].filter((id) => withBody.has(id) && !validated.has(id)).sort(),
  };
}

export function main(argv, { log = console.log } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string', default: REPO_ROOT },
      openapi: { type: 'string', default: DEFAULT_OPENAPI },
      matrix: { type: 'string' },
      validators: { type: 'string' },
      locale: { type: 'string', default: DEFAULT_LOCALE },
    },
  });
  const messages = loadMessages(values.locale);
  const root = resolve(values.root);
  const validatorsPath = values.validators === undefined ? join(root, VALIDATORS_RELATIVE_PATH) : resolve(values.validators);
  const result = commandCoverage(root, resolve(values.openapi), values.matrix === undefined ? join(root, MATRIX_RELATIVE_PATH) : resolve(values.matrix), validatorsPath);
  for (const id of result.uncovered) log(format(messages['commands.uncovered'], { operation: id }));
  for (const id of result.unknown) log(format(messages['commands.unknown'], { operation: id }));
  for (const id of result.unmatrixed) log(format(messages['commands.unmatrixed'], { operation: id }));
  for (const id of result.unvalidated) log(format(messages['commands.unvalidated'], { operation: id }));
  const failures = result.uncovered.length + result.unknown.length + result.unmatrixed.length + result.unvalidated.length;
  log(
    failures === 0
      ? format(messages['commands.summary.pass'], { implemented: result.implemented.length, total: result.writeOperations })
      : format(messages['commands.summary.fail'], { count: failures }),
  );
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}

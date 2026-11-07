import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FILES,
  PatchError,
  addErrorCode,
  addOperation,
  addSchema,
  addScreen,
  applySteps,
  buildOperation,
  checkFiles,
  main,
  parseDocument,
  registerBlock,
  render,
  setLocale,
  stepFromOptions,
  unifiedDiff,
} from './contract-patch.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'contract-patch.mjs');
const REPO_ROOT = resolve(dirname(SCRIPT), '..');

setLocale('en');

const problem = { description: 'x', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } };
const OPENAPI = {
  openapi: '3.1.0',
  paths: {
    '/things': {
      get: {
        operationId: 'listThings',
        summary: 'List',
        tags: ['PAY'],
        'x-permission': 'thing.read',
        parameters: [],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } }, 400: problem },
      },
    },
  },
  components: { schemas: { Problem: { type: 'object' }, CommandResult: { type: 'object' }, Thing: { type: 'object' } } },
};
const ERROR_CODES = {
  note: 'n',
  canonical: { SCOPE_DENIED: 'The actor lacks the scope (403).', VERSION_CONFLICT: 'If-Match did not match (409).' },
  aliases: { OLD_SPELLING: 'SCOPE_DENIED' },
  excluded: { IN_PROGRESS: 'Not a code.' },
  registry: {
    VALIDATION_FAILED: { status: 400, title: 'Validation failed', meaning: 'Sai dữ liệu', module: 'KERNEL', statusBasis: 'spec', source: 'spec:KERNEL' },
  },
};
const SCREENS = [
  { id: 'PAY-01', module: 'PAY', moduleName: 'Thanh toán', title: 'Một', kind: 'table', fields: ['A'], role: 'R', rule: 'r', phase: 'P1', platform: 'web', req: 'FR-PAY-01', source: 's' },
  { id: 'PAY-02', module: 'PAY', moduleName: 'Thanh toán', title: 'Hai', kind: 'form', fields: ['A', 'B'], role: 'R', rule: 'r', phase: 'P1', platform: 'web', req: 'FR-PAY-02', source: 's' },
];
const BLOCKS = { platform: { from: 3, to: 99, retired: [5] }, slices: [{ slice: 'KERNEL-1', from: 1000, to: 1019 }, { slice: 'GOV-1', from: 1850, to: 1869 }] };

/** A temp root laid out like the repository: LF files, and blocks.json with CRLF as the real one has. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'machvon-contract-patch-'));
  const put = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  put(FILES.openapi, render(OPENAPI));
  put(FILES.errorCodes, render(ERROR_CODES));
  put(FILES.screens, render(SCREENS));
  put(FILES.blocks, render(BLOCKS, { eol: '\r\n' }));
  const read = (target) => readFileSync(join(root, FILES[target]), 'utf8');
  const json = (target) => JSON.parse(read(target));
  return { root, read, json, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const rejects = (key) => (error) => error instanceof PatchError && error.key === key;
const clone = (value) => JSON.parse(JSON.stringify(value));
const ERROR_STEP = { command: 'add-error-code', code: 'PAY_X_DENIED', status: 422, en: 'X denied', vi: 'X bị từ chối', module: 'PAY' };

// --- documents -------------------------------------------------------------------------------------------------------

test('a file renders back to exactly itself, with its own line ending and final newline', () => {
  for (const style of [{ eol: '\n', trailing: true }, { eol: '\r\n', trailing: true }, { eol: '\n', trailing: false }]) {
    const text = render({ a: [1, { b: 'ễ\n' }], c: {} }, style);
    assert.deepEqual(parseDocument(text).style, style);
  }
});

test('a file that is not the exact canonical rendering is refused rather than reformatted', () => {
  assert.throws(() => parseDocument('{"a":1}\n'), rejects('notCanonical'));
  assert.throws(() => parseDocument('{\n    "a": 1\n}\n'), rejects('notCanonical'));
  assert.throws(() => parseDocument('{\r\n  "a": 1\n}\r\n'), rejects('notCanonical'));
  assert.throws(() => parseDocument('{ nope', 'x.json'), rejects('notJson'));
});

test('checkFiles reports each shared file', () => {
  const f = fixture();
  try {
    assert.deepEqual(checkFiles(f.root).map((report) => report.ok), [true, true, true, true]);
    writeFileSync(join(f.root, FILES.blocks), '{"platform": {}}');
    assert.equal(checkFiles(f.root).filter((report) => !report.ok).length, 1);
  } finally {
    f.cleanup();
  }
});

// --- error codes -----------------------------------------------------------------------------------------------------

test('an error code is appended with status, English title and Vietnamese meaning', () => {
  const doc = clone(ERROR_CODES);
  assert.deepEqual(addErrorCode(doc, ERROR_STEP), { status: 'added', name: 'PAY_X_DENIED' });
  assert.deepEqual(Object.keys(doc.registry), ['VALIDATION_FAILED', 'PAY_X_DENIED']);
  assert.deepEqual(doc.registry.PAY_X_DENIED, { status: 422, title: 'X denied', meaning: 'X bị từ chối', module: 'PAY', statusBasis: 'spec', source: 'spec:PAY' });
});

test('an error code can carry other statuses and a different source; the module may come from the source', () => {
  const doc = clone(ERROR_CODES);
  addErrorCode(doc, { ...ERROR_STEP, module: undefined, source: 'spec:CTR', otherStatuses: '409,422', statusBasis: 'plan' });
  assert.deepEqual(doc.registry.PAY_X_DENIED, { status: 422, title: 'X denied', meaning: 'X bị từ chối', module: 'CTR', statusBasis: 'plan', source: 'spec:CTR', otherStatuses: [409, 422] });
});

test('adding the same error code again changes nothing; different content needs --replace', () => {
  const doc = clone(ERROR_CODES);
  addErrorCode(doc, ERROR_STEP);
  const before = JSON.stringify(doc);
  assert.equal(addErrorCode(doc, ERROR_STEP).status, 'unchanged');
  assert.equal(JSON.stringify(doc), before);
  assert.throws(() => addErrorCode(doc, { ...ERROR_STEP, status: 409 }), rejects('codeExists'));
  assert.equal(addErrorCode(doc, { ...ERROR_STEP, status: 409, replace: true }).status, 'replaced');
  assert.equal(doc.registry.PAY_X_DENIED.status, 409);
  assert.deepEqual(Object.keys(doc.registry), ['VALIDATION_FAILED', 'PAY_X_DENIED']);
});

test('canonical, alias and excluded names are never added to the registry', () => {
  for (const code of ['SCOPE_DENIED', 'OLD_SPELLING', 'IN_PROGRESS']) {
    assert.throws(() => addErrorCode(clone(ERROR_CODES), { ...ERROR_STEP, code, replace: true }), rejects('codeReserved'));
  }
});

test('an error code is validated: spelling, status, messages, module', () => {
  const doc = clone(ERROR_CODES);
  assert.throws(() => addErrorCode(doc, { ...ERROR_STEP, code: 'lower' }), rejects('invalidValue'));
  assert.throws(() => addErrorCode(doc, { ...ERROR_STEP, status: 200 }), rejects('invalidValue'));
  assert.throws(() => addErrorCode(doc, { ...ERROR_STEP, status: 'abc' }), rejects('invalidValue'));
  assert.throws(() => addErrorCode(doc, { ...ERROR_STEP, vi: undefined }), rejects('missingOption'));
  assert.throws(() => addErrorCode(doc, { ...ERROR_STEP, en: '' }), rejects('missingOption'));
  assert.throws(() => addErrorCode(doc, { ...ERROR_STEP, module: undefined }), rejects('missingOption'));
  assert.throws(() => addErrorCode(doc, { ...ERROR_STEP, otherStatuses: '9' }), rejects('invalidValue'));
});

// --- schemas ---------------------------------------------------------------------------------------------------------

test('a schema is added at the end of components.schemas, then left alone, then replaced only on request', () => {
  const doc = clone(OPENAPI);
  const schema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false };
  assert.equal(addSchema(doc, { name: 'PayFoo', schema }).status, 'added');
  assert.equal(Object.keys(doc.components.schemas).at(-1), 'PayFoo');
  assert.equal(addSchema(doc, { name: 'PayFoo', schema }).status, 'unchanged');
  assert.throws(() => addSchema(doc, { name: 'PayFoo', schema: { type: 'string' } }), rejects('schemaExists'));
  assert.equal(addSchema(doc, { name: 'PayFoo', schema: { type: 'string' }, replace: true }).status, 'replaced');
  assert.deepEqual(doc.components.schemas.PayFoo, { type: 'string' });
  assert.throws(() => addSchema(doc, { name: '1bad', schema }), rejects('invalidValue'));
  assert.throws(() => addSchema(doc, { name: 'Ok', schema: [] }), rejects('invalidValue'));
});

test('a schema can be added to a document without components', () => {
  const doc = {};
  assert.equal(addSchema(doc, { name: 'A', schema: { type: 'object' } }).status, 'added');
  assert.deepEqual(doc, { components: { schemas: { A: { type: 'object' } } } });
});

// --- operations ------------------------------------------------------------------------------------------------------

const COMMAND_BUILD = {
  operationId: 'clearThing',
  summary: 'Clear a thing',
  tags: ['PAY'],
  permission: 'thing.clear',
  requestRef: 'ClearThing',
  errorCodes: ['VALIDATION_FAILED', 'VERSION_CONFLICT'],
  domainEvents: ['pay.thing.cleared.v1'],
  ifMatch: true,
};

test('a command operation is built like the neighbouring commands', () => {
  const operation = buildOperation(COMMAND_BUILD, { path: '/things/{id}/clear', method: 'post' });
  assert.deepEqual(Object.keys(operation), ['operationId', 'summary', 'tags', 'x-permission', 'parameters', 'requestBody', 'responses', 'x-error-codes', 'x-idempotency', 'x-domain-events']);
  assert.deepEqual(operation.parameters.map((p) => p.name), ['id', 'Idempotency-Key', 'If-Match']);
  assert.deepEqual(operation.parameters[0], { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
  assert.deepEqual(Object.keys(operation.responses), ['200', '400', '401', '403', '404', '409', '422', '429', '503']);
  assert.equal(operation.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/CommandResult');
  assert.equal(operation.responses['422'].content['application/problem+json'].schema.$ref, '#/components/schemas/Problem');
  assert.deepEqual(operation.requestBody, { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ClearThing' } } } });
  assert.deepEqual(operation['x-error-codes'], ['VALIDATION_FAILED', 'VERSION_CONFLICT']);
  assert.match(operation['x-idempotency'], /IDEMPOTENCY_CONFLICT/);
});

test('a read operation is a DTO read model with query parameters and extra x- fields after the standard ones', () => {
  const operation = buildOperation(
    { operationId: 'getThing', summary: 'Read', tags: ['PAY'], permission: 'thing.read', responseRef: 'Thing', query: [{ name: 'as_of', type: 'string', format: 'date' }], pathParams: { id: 'uuid' }, extra: { 'x-plane': 'tenant' } },
    { path: '/things/{id}', method: 'get' },
  );
  assert.deepEqual(Object.keys(operation), ['operationId', 'summary', 'tags', 'x-permission', 'parameters', 'x-read-model', 'x-exposure', 'x-exposure-reason', 'responses', 'x-error-codes', 'x-plane']);
  assert.deepEqual(operation.parameters.map((p) => p.name), ['id', 'as_of']);
  assert.equal(operation.parameters[1].required, false);
  assert.equal(operation['x-exposure'], 'dto');
  assert.equal(operation.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/Thing');
});

test('the builder asks for what it cannot guess', () => {
  const at = { path: '/things', method: 'post' };
  assert.throws(() => buildOperation({ ...COMMAND_BUILD, operationId: undefined }, at), rejects('missingOption'));
  assert.throws(() => buildOperation({ ...COMMAND_BUILD, tags: [] }, at), rejects('missingOption'));
  assert.throws(() => buildOperation({ ...COMMAND_BUILD, permission: undefined }, at), rejects('missingOption'));
  assert.throws(() => buildOperation({ ...COMMAND_BUILD, summary: undefined }, at), rejects('missingOption'));
  assert.throws(() => buildOperation({ operationId: 'a', summary: 's', tags: ['T'], permission: 'p' }, { path: '/x', method: 'get' }), rejects('missingOption'));
  assert.throws(() => buildOperation({ ...COMMAND_BUILD, query: [{ type: 'string' }] }, at), rejects('invalidValue'));
});

test('an operation is added under a new path or a new method, then left alone, then replaced only on request', () => {
  const doc = clone(OPENAPI);
  const step = { path: '/things/{id}/clear', method: 'POST', build: COMMAND_BUILD };
  assert.equal(addOperation(doc, step).status, 'added');
  assert.deepEqual(Object.keys(doc.paths), ['/things', '/things/{id}/clear']);
  assert.equal(addOperation(doc, step).status, 'unchanged');
  assert.equal(addOperation(doc, { path: '/things', method: 'post', build: { ...COMMAND_BUILD, operationId: 'createThing' } }).status, 'added');
  assert.deepEqual(Object.keys(doc.paths['/things']), ['get', 'post']);
  const changed = { ...step, build: { ...COMMAND_BUILD, summary: 'Other' } };
  assert.throws(() => addOperation(doc, changed), rejects('operationExists'));
  assert.equal(addOperation(doc, { ...changed, replace: true }).status, 'replaced');
  assert.equal(doc.paths['/things/{id}/clear'].post.summary, 'Other');
});

test('an operationId used elsewhere, a bad path or method, or an incomplete operation is refused', () => {
  const doc = clone(OPENAPI);
  assert.throws(() => addOperation(doc, { path: '/other', method: 'post', build: { ...COMMAND_BUILD, operationId: 'listThings' } }), rejects('operationIdTaken'));
  assert.throws(() => addOperation(doc, { path: 'other', method: 'get', build: COMMAND_BUILD }), rejects('invalidValue'));
  assert.throws(() => addOperation(doc, { path: '/other', method: 'trace', build: COMMAND_BUILD }), rejects('invalidValue'));
  assert.throws(() => addOperation(doc, { path: '/o', method: 'get', operation: 'no' }), rejects('invalidValue'));
  assert.throws(() => addOperation(doc, { path: '/o', method: 'get', operation: { operationId: 'a', responses: { 200: {} } } }), rejects('missingOption'));
  assert.throws(() => addOperation(doc, { path: '/o', method: 'get', operation: { operationId: 'a', 'x-permission': 'p' } }), rejects('missingOption'));
  assert.throws(() => addOperation(doc, { path: '/o', method: 'get', operation: { operationId: 'a', 'x-permission': 'p', responses: { 200: {} }, tags: 'PAY' } }), rejects('invalidValue'));
  assert.throws(() => addOperation(doc, { method: 'get', build: COMMAND_BUILD }), rejects('missingOption'));
});

// --- screens ---------------------------------------------------------------------------------------------------------

const SCREEN = { command: 'add-screen', module: 'PAY', title: 'Ba', kind: 'detail', fields: ['X'], role: 'Kế toán', rule: 'quy tắc', phase: 'P1', source: 'nguồn' };

test('a screen takes the next free id of its module and the module name of its neighbours', () => {
  const doc = clone(SCREENS);
  assert.deepEqual(addScreen(doc, SCREEN), { status: 'added', name: 'PAY-03' });
  assert.deepEqual(doc.at(-1), { id: 'PAY-03', module: 'PAY', moduleName: 'Thanh toán', title: 'Ba', kind: 'detail', fields: ['X'], role: 'Kế toán', rule: 'quy tắc', phase: 'P1', platform: 'web', req: 'FR-PAY-03', source: 'nguồn' });
  assert.equal(addScreen(doc, { ...SCREEN, title: 'Bốn' }).name, 'PAY-04');
});

test('the same screen again is the same entry; changing it needs --replace and keeps the id', () => {
  const doc = clone(SCREENS);
  addScreen(doc, SCREEN);
  assert.equal(addScreen(doc, SCREEN).status, 'unchanged');
  assert.equal(doc.length, 3);
  assert.throws(() => addScreen(doc, { ...SCREEN, rule: 'khác' }), rejects('screenExists'));
  assert.deepEqual(addScreen(doc, { ...SCREEN, rule: 'khác', replace: true }), { status: 'replaced', name: 'PAY-03' });
  assert.equal(doc.length, 3);
  assert.equal(doc[2].rule, 'khác');
});

test('a new module needs its name; an explicit id must match the module and be free', () => {
  const doc = clone(SCREENS);
  assert.throws(() => addScreen(doc, { ...SCREEN, module: 'GOV' }), rejects('missingOption'));
  assert.deepEqual(addScreen(doc, { ...SCREEN, module: 'GOV', moduleName: 'Quản trị' }), { status: 'added', name: 'GOV-01' });
  assert.equal(addScreen(doc, { ...SCREEN, id: 'PAY-10', title: 'Mười' }).name, 'PAY-10');
  assert.equal(addScreen(doc, { ...SCREEN, title: 'Mười một' }).name, 'PAY-11');
  assert.throws(() => addScreen(doc, { ...SCREEN, id: 'PAY-01', title: 'Khác' }), rejects('screenIdTaken'));
  assert.throws(() => addScreen(doc, { ...SCREEN, id: 'CAP-01', title: 'Z' }), rejects('invalidValue'));
});

test('a screen is validated', () => {
  const doc = clone(SCREENS);
  assert.throws(() => addScreen(doc, { ...SCREEN, module: 'pay' }), rejects('invalidValue'));
  assert.throws(() => addScreen(doc, { ...SCREEN, fields: [] }), rejects('missingOption'));
  assert.throws(() => addScreen(doc, { ...SCREEN, phase: 'X' }), rejects('invalidValue'));
  assert.throws(() => addScreen(doc, { ...SCREEN, title: undefined }), rejects('missingOption'));
  assert.throws(() => addScreen({}, SCREEN), rejects('notJson'));
});

// --- blocks ----------------------------------------------------------------------------------------------------------

test('a slice block of 20 numbers is registered at the end; the same registration is a no-op', () => {
  const doc = clone(BLOCKS);
  assert.equal(registerBlock(doc, { slice: 'GOV-3', from: 1790 }).status, 'added');
  assert.deepEqual(doc.slices.at(-1), { slice: 'GOV-3', from: 1790, to: 1809 });
  assert.equal(registerBlock(doc, { slice: 'GOV-3', from: '1790' }).status, 'unchanged');
  assert.equal(registerBlock(doc, { slice: 'GOV-3' }).status, 'unchanged');
  assert.equal(doc.slices.length, 3);
});

test('a block that overlaps the platform block or another slice is refused with the free number', () => {
  const doc = clone(BLOCKS);
  assert.throws(() => registerBlock(doc, { slice: 'GOV-3', from: 1860 }), (error) => error.key === 'blockOverlap' && error.params.other === 'GOV-1' && error.params.free === 1870);
  assert.throws(() => registerBlock(doc, { slice: 'GOV-3', from: 1840 }), rejects('blockOverlap'));
  assert.throws(() => registerBlock(doc, { slice: 'GOV-3', from: 1000 }), rejects('blockOverlap'));
  assert.throws(() => registerBlock(doc, { slice: 'GOV-3', from: 90 }), (error) => error.params.other === 'platform');
  assert.equal(registerBlock(doc, { slice: 'GOV-3', from: 1870 }).status, 'added');
  assert.equal(registerBlock(doc, { slice: 'GOV-4', from: 1850 - 20 }).status, 'added');
});

test('a registered slice does not move; a block needs a start and a good name', () => {
  const doc = clone(BLOCKS);
  assert.throws(() => registerBlock(doc, { slice: 'GOV-1', from: 1900 }), rejects('blockMoved'));
  assert.throws(() => registerBlock(doc, { slice: 'GOV-9' }), rejects('missingOption'));
  assert.throws(() => registerBlock(doc, { slice: 'gov' , from: 2000 }), rejects('invalidValue'));
  assert.throws(() => registerBlock(doc, { slice: 'GOV-9', from: 'x' }), rejects('invalidValue'));
  assert.throws(() => registerBlock({}, { slice: 'GOV-9', from: 2000 }), rejects('notJson'));
});

// --- plan runner -----------------------------------------------------------------------------------------------------

const BATCH = [
  { command: 'add-schema', name: 'ClearThing', schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } } },
  { command: 'add-operation', path: '/things/{id}/clear', method: 'post', build: COMMAND_BUILD },
  ERROR_STEP,
  SCREEN,
  { command: 'register-block', slice: 'GOV-3', from: 1790 },
];

test('a batch patches all five files, keeps each file canonical and its line endings, and is idempotent', async () => {
  const f = fixture();
  try {
    const first = await applySteps(BATCH, { root: f.root });
    assert.deepEqual(first.results.map((r) => r.status), ['added', 'added', 'added', 'added', 'added']);
    assert.equal(first.changed.length, 4);
    for (const target of ['openapi', 'errorCodes', 'screens', 'blocks']) parseDocument(f.read(target));
    assert.ok(f.read('blocks').includes('\r\n') && !/[^\r]\n/.test(f.read('blocks')), 'blocks.json keeps CRLF');
    assert.ok(f.json('openapi').paths['/things/{id}/clear'].post);
    assert.ok(f.json('errorCodes').registry.PAY_X_DENIED);
    assert.equal(f.json('screens').at(-1).id, 'PAY-03');
    assert.equal(f.json('blocks').slices.at(-1).slice, 'GOV-3');
    const snapshot = ['openapi', 'errorCodes', 'screens', 'blocks'].map((target) => f.read(target));
    const second = await applySteps(BATCH, { root: f.root });
    assert.deepEqual(second.results.map((r) => r.status), ['unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged']);
    assert.deepEqual(second.changed, []);
    assert.deepEqual(['openapi', 'errorCodes', 'screens', 'blocks'].map((target) => f.read(target)), snapshot);
    assert.deepEqual(readdirSync(dirname(join(f.root, FILES.openapi))).filter((name) => /\.(lock|tmp)$/.test(name)), []);
  } finally {
    f.cleanup();
  }
});

test('only the inserted lines differ from the original text', async () => {
  const f = fixture();
  try {
    const before = f.read('errorCodes');
    await applySteps([ERROR_STEP], { root: f.root });
    const after = f.read('errorCodes');
    const added = after.split('\n').length - before.split('\n').length;
    assert.equal(added, 8);
    assert.ok(after.startsWith(before.slice(0, before.lastIndexOf('    }\n  }\n}\n'))));
    assert.ok(after.endsWith('}\n'));
  } finally {
    f.cleanup();
  }
});

test('a failing step writes nothing to any file', async () => {
  const f = fixture();
  try {
    const before = ['openapi', 'errorCodes', 'screens', 'blocks'].map((target) => f.read(target));
    await assert.rejects(applySteps([ERROR_STEP, SCREEN, { command: 'register-block', slice: 'BAD-1', from: 1850 }], { root: f.root }), rejects('blockOverlap'));
    assert.deepEqual(['openapi', 'errorCodes', 'screens', 'blocks'].map((target) => f.read(target)), before);
    assert.deepEqual(readdirSync(dirname(join(f.root, FILES.openapi))).filter((name) => /\.(lock|tmp)$/.test(name)), []);
  } finally {
    f.cleanup();
  }
});

test('--dry-run reports the diff and the statuses and writes nothing', async () => {
  const f = fixture();
  try {
    const before = f.read('openapi');
    const logs = [];
    const code = await main(['apply', '--spec', specFile(f, BATCH), '--dry-run', '--root', f.root, '--locale', 'en'], { log: (line) => logs.push(line), error: (line) => logs.push(`ERR ${line}`) });
    assert.equal(code, 0);
    assert.equal(f.read('openapi'), before);
    assert.ok(!f.read('errorCodes').includes('PAY_X_DENIED'));
    const text = logs.join('\n');
    assert.match(text, /^--- Design\/MACHVON_Design\/03_Engineering\/error_codes\.json/m);
    assert.match(text, /^\+ {4}"PAY_X_DENIED": \{/m);
    assert.match(text, /Dry run: 4 file\(s\)/);
  } finally {
    f.cleanup();
  }
});

test('schema and error code references of an added operation must resolve', async () => {
  const f = fixture();
  try {
    const noSchema = { command: 'add-operation', path: '/a', method: 'post', build: COMMAND_BUILD };
    await assert.rejects(applySteps([noSchema], { root: f.root }), rejects('refMissing'));
    await assert.rejects(applySteps([{ command: 'add-schema', name: 'S', schema: { properties: { x: { $ref: '#/components/schemas/Nope' } } } }], { root: f.root }), rejects('refMissing'));
    await assert.rejects(applySteps([{ command: 'add-schema', name: 'S', schema: { $ref: 'other.json#/x' } }], { root: f.root }), rejects('refMissing'));
    const withSchema = { command: 'add-schema', name: 'ClearThing', schema: { type: 'object' } };
    await assert.rejects(applySteps([withSchema, { ...noSchema, build: { ...COMMAND_BUILD, errorCodes: ['NOPE_CODE'] } }], { root: f.root }), rejects('errorCodeUnknown'));
    const outcome = await applySteps([withSchema, { ...noSchema, build: { ...COMMAND_BUILD, errorCodes: ['VALIDATION_FAILED'] } }], { root: f.root });
    assert.deepEqual(outcome.results.map((r) => r.status), ['added', 'added']);
    // An operation may use a code added in the same batch.
    const late = { command: 'add-operation', path: '/b', method: 'post', build: { ...COMMAND_BUILD, operationId: 'late', errorCodes: ['PAY_X_DENIED'] } };
    assert.equal((await applySteps([ERROR_STEP, late], { root: f.root })).results[1].status, 'added');
  } finally {
    f.cleanup();
  }
});

test('an operation is not checked against the registry when the registry file is absent', async () => {
  const f = fixture();
  try {
    rmSync(join(f.root, FILES.errorCodes));
    const step = { command: 'add-operation', path: '/a', method: 'post', build: { ...COMMAND_BUILD, requestRef: undefined, errorCodes: ['ANYTHING'] } };
    assert.equal((await applySteps([step], { root: f.root })).results[0].status, 'added');
  } finally {
    f.cleanup();
  }
});

test('--replace on the command line applies to steps that do not say otherwise', async () => {
  const f = fixture();
  try {
    await applySteps([ERROR_STEP], { root: f.root });
    await assert.rejects(applySteps([{ ...ERROR_STEP, status: 409 }], { root: f.root }), rejects('codeExists'));
    assert.equal((await applySteps([{ ...ERROR_STEP, status: 409 }], { root: f.root, replace: true })).results[0].status, 'replaced');
    assert.equal(f.json('errorCodes').registry.PAY_X_DENIED.status, 409);
  } finally {
    f.cleanup();
  }
});

test('a file that is not canonical (a lane mid-edit) stops the plan before any write', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, FILES.screens), JSON.stringify(SCREENS));
    const before = f.read('errorCodes');
    await assert.rejects(applySteps([ERROR_STEP, SCREEN], { root: f.root }), rejects('notCanonical'));
    assert.equal(f.read('errorCodes'), before);
    rmSync(join(f.root, FILES.screens));
    await assert.rejects(applySteps([SCREEN], { root: f.root }), rejects('notJson'));
  } finally {
    f.cleanup();
  }
});

test('an unknown command is refused', async () => {
  await assert.rejects(applySteps([{ command: 'drop-table' }]), rejects('unknownCommand'));
});

// --- locking ---------------------------------------------------------------------------------------------------------

test('a lock left by a dead process or an old lock is reclaimed; a live fresh lock makes the tool wait and time out', async () => {
  const f = fixture();
  try {
    const lock = `${join(f.root, FILES.errorCodes)}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, token: 'x' }));
    assert.equal((await applySteps([ERROR_STEP], { root: f.root, lockOptions: { timeoutMs: 3000 } })).results[0].status, 'added');
    assert.equal(existsSync(lock), false);

    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'live' }));
    old(lock);
    assert.equal((await applySteps([{ ...ERROR_STEP, code: 'PAY_Y_DENIED' }], { root: f.root, lockOptions: { staleMs: 1000, timeoutMs: 3000 } })).results[0].status, 'added');

    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'live' }));
    await assert.rejects(applySteps([{ ...ERROR_STEP, code: 'PAY_Z_DENIED' }], { root: f.root, lockOptions: { timeoutMs: 150, pollMs: 10 } }), rejects('lockTimeout'));
    assert.equal(existsSync(lock), true, 'the foreign lock is left alone');
    assert.ok(!f.read('errorCodes').includes('PAY_Z_DENIED'));
  } finally {
    f.cleanup();
  }
});

function old(path) {
  const past = new Date(Date.now() - 3600_000);
  utimesSync(path, past, past);
}

function run(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args, '--locale', 'en'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => done({ code, output }));
  });
}

test('concurrent processes each get their change in, none lost, the file stays canonical', async () => {
  const f = fixture();
  try {
    const codes = Array.from({ length: 8 }, (_, index) => `PAY_RACE_${index}`);
    const runs = await Promise.all(codes.map((code) => run(['add-error-code', '--code', code, '--status', '409', '--vi', 'vi', '--en', 'en', '--module', 'PAY', '--root', f.root])));
    assert.deepEqual(runs.map((r) => r.code), codes.map(() => 0), runs.map((r) => r.output).join('\n'));
    const { data } = parseDocument(f.read('errorCodes'));
    assert.deepEqual(Object.keys(data.registry).slice(1).sort(), [...codes].sort());
    const screens = await Promise.all(Array.from({ length: 5 }, (_, index) => run(['add-screen', '--module', 'PAY', '--title', `Race ${index}`, '--kind', 'form', '--fields', 'A;B', '--role', 'R', '--rule', 'r', '--phase', 'P1', '--source', 's', '--root', f.root])));
    assert.deepEqual(screens.map((r) => r.code), [0, 0, 0, 0, 0], screens.map((r) => r.output).join('\n'));
    assert.deepEqual(f.json('screens').map((screen) => screen.id), ['PAY-01', 'PAY-02', 'PAY-03', 'PAY-04', 'PAY-05', 'PAY-06', 'PAY-07']);
  } finally {
    f.cleanup();
  }
});

// --- diff ------------------------------------------------------------------------------------------------------------

test('unifiedDiff shows an insertion, a replacement and a deletion with context, and nothing for equal texts', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n'), '');
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  const edited = [...lines.slice(0, 5), 'inserted', ...lines.slice(5, 20), 'changed 20', ...lines.slice(21, 30), ...lines.slice(31)];
  const diff = unifiedDiff(lines.join('\n'), edited.join('\n'), 'f.json').split('\n');
  assert.deepEqual(diff.filter((line) => /^[+-][^+-]/.test(line)), ['+inserted', '-line 20', '+changed 20', '-line 30']);
  assert.equal(diff.filter((line) => line.startsWith('@@')).length, 3);
  assert.ok(diff.includes(' line 4') && diff.includes(' line 5'));
  assert.equal(unifiedDiff('x', 'y').split('\n').filter((line) => /^[+-][^+-]/.test(line)).join(','), '-x,+y');
});

test('unifiedDiff aligns an insertion among repeated blocks instead of matching a repeat of the block', () => {
  const block = ['      "x": {', '        "a": 1', '      },'];
  const repeated = Array.from({ length: 12 }, () => block).flat();
  const before = ['{', ...repeated, '    }', '  },', '  "tail": {', ...Array.from({ length: 30 }, (_, index) => `    "k${index}": ${index}`), '}'];
  const inserted = ['    },', '    "new": {', ...repeated.slice(0, 20)];
  const after = [...before.slice(0, 1 + repeated.length), ...inserted, ...before.slice(1 + repeated.length)];
  const diff = unifiedDiff(before.join(String.fromCharCode(10)), after.join(String.fromCharCode(10)), 'f.json').split(String.fromCharCode(10));
  const removed = diff.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  const added = diff.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  assert.equal(added - removed, inserted.length);
  assert.ok(removed <= 1, `a minimal diff removes at most the closing line, removed ${removed}`);
  assert.equal(diff.filter((line) => line.startsWith('@@')).length, 1);
});

test('unifiedDiff joins nearby changes into one hunk and handles a tail with no common lines', () => {
  const diff = unifiedDiff('a\nb\nc\nd\ne\nf\n', 'a\nB\nc\nD\ne\nf\n').split('\n');
  assert.equal(diff.filter((line) => line.startsWith('@@')).length, 1);
  const tail = unifiedDiff('same\nold1\nold2', 'same\nnew1\nnew2\nnew3').split('\n');
  assert.deepEqual(tail.filter((line) => /^[+-][^+-]/.test(line)), ['-old1', '-old2', '+new1', '+new2', '+new3']);
});

// --- command line ----------------------------------------------------------------------------------------------------

function specFile(f, steps, wrap = true) {
  const file = join(f.root, 'spec.json');
  writeFileSync(file, JSON.stringify(wrap ? { steps } : steps));
  return file;
}

function capture() {
  const out = [];
  return { out, io: { log: (line) => out.push(line), error: (line) => out.push(`ERR ${line}`) } };
}

test('add-error-code through the command line writes the entry and reports it; re-running reports no change', async () => {
  const f = fixture();
  try {
    const args = ['add-error-code', '--code', 'PAY_CLI', '--status', '422', '--vi', 'Tiếng Việt', '--en', 'English', '--module', 'PAY', '--root', f.root];
    const first = capture();
    assert.equal(await main(args, first.io), 0);
    assert.match(first.out.join('\n'), /Đã thêm error code PAY_CLI/);
    assert.equal(f.json('errorCodes').registry.PAY_CLI.meaning, 'Tiếng Việt');
    const again = capture();
    const before = f.read('errorCodes');
    assert.equal(await main([...args, '--locale', 'en'], again.io), 0);
    assert.match(again.out.join('\n'), /Unchanged: error code PAY_CLI/);
    assert.equal(f.read('errorCodes'), before);
  } finally {
    f.cleanup();
  }
});

test('every command is reachable from flags', async () => {
  const f = fixture();
  try {
    const io = capture().io;
    const base = ['--root', f.root, '--locale', 'en'];
    assert.equal(await main(['add-schema', '--name', 'ClearThing', '--schema', '{"type":"object"}', ...base], io), 0);
    writeFileSync(join(f.root, 'schema.json'), JSON.stringify({ type: 'object', required: ['a'] }));
    assert.equal(await main(['add-schema', '--name', 'FromFile', '--schema-file', join(f.root, 'schema.json'), ...base], io), 0);
    assert.equal(
      await main(['add-operation', '--path', '/things/{id}/clear', '--method', 'post', '--operation-id', 'clearThing', '--summary', 'Clear', '--tags', 'PAY,CTR', '--permission', 'thing.clear', '--request-ref', 'ClearThing', '--error-codes', 'VALIDATION_FAILED', '--domain-events', 'a.b.v1', '--if-match', '--path-param', 'id:uuid', '--extra', '{"x-plane":"tenant"}', ...base], io),
      0,
    );
    assert.equal(
      await main(['add-operation', '--path', '/things/{id}', '--method', 'get', '--operation-id', 'getThing', '--summary', 'Get', '--tags', 'PAY', '--permission', 'thing.read', '--response-ref', 'Thing', '--query', 'as_of:string:date:required', ...base], io),
      0,
    );
    writeFileSync(join(f.root, 'op.json'), JSON.stringify({ operationId: 'fromFile', 'x-permission': 'p.q', responses: { 200: { description: 'ok' } } }));
    assert.equal(await main(['add-operation', '--path', '/ff', '--method', 'put', '--operation-file', join(f.root, 'op.json'), ...base], io), 0);
    assert.equal(await main(['add-screen', '--module', 'GOV', '--module-name', 'Quản trị', '--title', 'Hộp', '--kind', 'board', '--fields', 'A; B', '--role', 'R', '--rule', 'r', '--phase', 'P0', '--platform', 'mobile', '--req', 'FR-X', '--source', 's', ...base], io), 0);
    assert.equal(await main(['register-block', '--slice', 'GOV-3', '--from', '1790', ...base], io), 0);
    const openapi = f.json('openapi');
    assert.equal(openapi.paths['/things/{id}/clear'].post['x-plane'], 'tenant');
    assert.deepEqual(openapi.paths['/things/{id}'].get.parameters[1], { name: 'as_of', in: 'query', required: true, schema: { type: 'string', format: 'date' } });
    assert.ok(openapi.paths['/ff'].put);
    assert.deepEqual(f.json('screens').at(-1).fields, ['A', 'B']);
    assert.equal(f.json('screens').at(-1).req, 'FR-X');
    assert.equal(f.json('blocks').slices.at(-1).to, 1809);
  } finally {
    f.cleanup();
  }
});

test('a spec may be a plain array; errors exit 1 with the message; usage and check work; bad invocations exit 2', async () => {
  const f = fixture();
  try {
    const base = ['--root', f.root, '--locale', 'en'];
    const plain = capture();
    assert.equal(await main(['apply', '--spec', specFile(f, [ERROR_STEP], false), ...base], plain.io), 0);
    assert.equal(await main(['add-error-code', '--spec', specFile(f, [ERROR_STEP]), ...base], capture().io), 0);

    const failed = capture();
    assert.equal(await main(['add-error-code', '--code', 'SCOPE_DENIED', '--status', '403', '--vi', 'v', '--en', 'e', '--module', 'X', ...base], failed.io), 1);
    assert.match(failed.out.join(''), /ERR Code SCOPE_DENIED belongs to canonical/);

    for (const bad of [[], { steps: [] }, { steps: [1] }, 'x']) {
      assert.equal(await main(['apply', '--spec', specFile(f, bad, false), ...base], capture().io), 1);
    }
    assert.equal(await main(['apply', '--spec', join(f.root, 'missing.json'), ...base], capture().io), 1);
    assert.equal(await main(['apply', ...base], capture().io), 1);
    assert.equal(await main(['add-widget', ...base], capture().io), 1);
    assert.equal(await main(['add-widget', '--spec', specFile(f, [ERROR_STEP]), ...base], capture().io), 1);
    assert.equal(await main(['add-schema', '--name', 'S', '--schema', '{nope', ...base], capture().io), 1);

    const usage = capture();
    assert.equal(await main(['--help', '--locale', 'en'], usage.io), 0);
    assert.match(usage.out[0], /Usage: node scripts\/contract-patch\.mjs <add-operation\|add-schema/);
    assert.equal(await main(['--locale', 'en'], capture().io), 2);
    assert.equal(await main(['--nonsense'], capture().io), 2);
    assert.equal(await main(['check', '--locale', 'xx'], capture().io), 2);

    const ok = capture();
    assert.equal(await main(['check', ...base], ok.io), 0);
    assert.equal(ok.out.length, 4);
    writeFileSync(join(f.root, FILES.blocks), '{"a":1}');
    const broken = capture();
    assert.equal(await main(['check', ...base], broken.io), 1);
    assert.match(broken.out.join('\n'), /blocks\.json: cannot be patched safely/);
  } finally {
    f.cleanup();
  }
});

test('stepFromOptions maps flags to the step a spec would carry', () => {
  const step = stepFromOptions('add-error-code', { code: 'A', status: '409', vi: 'v', en: 'e', module: 'M', 'status-basis': 'plan', 'other-statuses': '422', replace: true });
  assert.deepEqual(step, { command: 'add-error-code', replace: true, code: 'A', status: '409', vi: 'v', en: 'e', module: 'M', statusBasis: 'plan', otherStatuses: '422' });
});

// --- the real files --------------------------------------------------------------------------------------------------

test('on temp copies of the real contract files: canonical, patched and idempotent, and the real files stay untouched', async (t) => {
  const real = Object.values(FILES).map((file) => join(REPO_ROOT, file));
  const hashes = real.map(sha);
  const root = mkdtempSync(join(tmpdir(), 'machvon-contract-copy-'));
  try {
    for (const file of Object.values(FILES)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(join(REPO_ROOT, file), join(root, file));
    }
    const reports = checkFiles(root);
    if (reports.some((report) => !report.ok && report.error.key === 'notJson')) return t.skip('a shared file is being written right now');
    assert.deepEqual(reports.filter((report) => !report.ok).map((report) => `${report.file}: ${report.error.message}`), [], 'every real file must be a byte-exact round trip');
    const steps = [
      { command: 'add-schema', name: 'ContractPatchProbe', schema: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
      { command: 'add-operation', path: '/contract-patch-probe/{id}/run', method: 'post', build: { operationId: 'runContractPatchProbe', summary: 'Probe', tags: ['PAY'], permission: 'probe.run', requestRef: 'ContractPatchProbe', errorCodes: ['VALIDATION_FAILED', 'VERSION_CONFLICT'] } },
      { command: 'add-error-code', code: 'CONTRACT_PATCH_PROBE', status: 422, en: 'Probe', vi: 'Thăm dò', module: 'KERNEL' },
      { command: 'add-screen', module: 'PAY', title: 'Màn hình thăm dò', kind: 'table', fields: ['A'], role: 'R', rule: 'r', phase: 'P1', source: 's' },
      { command: 'register-block', slice: 'PROBE-1', from: 9000 },
    ];
    const first = await applySteps(steps, { root });
    assert.deepEqual(first.results.map((r) => r.status), ['added', 'added', 'added', 'added', 'added']);
    // The diff of an addition to a real file is the addition (a closing line gains a comma), not a rewrite of what follows.
    for (const diff of first.diffs) assert.ok(diff.split(/\r?\n/).filter((line) => line.startsWith('-') && !line.startsWith('---')).length <= 3, diff.slice(0, 600));
    const copies = Object.values(FILES).map((file) => readFileSync(join(root, file), 'utf8'));
    for (const text of copies) parseDocument(text);
    const second = await applySteps(steps, { root });
    assert.deepEqual(second.changed, []);
    assert.deepEqual(Object.values(FILES).map((file) => readFileSync(join(root, file), 'utf8')), copies);
    const screens = JSON.parse(copies[2]);
    const payNumbers = screens.filter((s) => s.module === 'PAY').map((s) => Number(s.id.slice(4)));
    assert.equal(screens.at(-1).id, `PAY-${Math.max(...payNumbers.slice(0, -1)) + 1}`);
    // Only the lines of the five additions differ from the originals.
    for (const [index, file] of Object.values(FILES).entries()) {
      const original = readFileSync(join(REPO_ROOT, file), 'utf8');
      assert.ok(copies[index].length > original.length);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(real.map(sha), hashes, 'the tests never modify the real files');
});

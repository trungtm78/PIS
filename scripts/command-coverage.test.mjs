import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandCoverage, main } from './command-coverage.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPENAPI = {
  openapi: '3.1.0',
  paths: {
    '/things': {
      get: { operationId: 'get_things' },
      post: { operationId: 'post_things' },
    },
    '/things/{id}': {
      put: { operationId: 'put_things_id' },
      delete: { operationId: 'delete_things_id' },
    },
  },
};

function layout(files, matrix = ['delete_things_id', 'post_things', 'put_things_id']) {
  const root = mkdtempSync(join(tmpdir(), 'machvon-commands-'));
  const all = { 'openapi.json': JSON.stringify(OPENAPI), 'matrix.json': JSON.stringify({ commands: matrix }), ...files };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, openapi: join(root, 'openapi.json'), matrix: join(root, 'matrix.json'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const DECORATED = `
@Controller('things')
export class ThingsController {
  @Post()
  @HttpCode(200)
  @OperationId('post_things')
  @Command({ operation: 'createThing' })
  async create() {}

  @Get()
  @OperationId('get_things')
  list() {}
}
`;

const UNDECORATED = `
@Controller('things')
export class ThingsController {
  @Put(':id')
  @OperationId('put_things_id')
  async update() {}

  @Delete(':id')
  @Command({ operation: 'deleteThing' })
  @OperationId('delete_things_id')
  async remove() {}
}
`;

test('a write handler with @OperationId but without @Command is reported as uncovered', () => {
  const { root, openapi, matrix, cleanup } = layout({ 'apps/api/src/things.controller.ts': UNDECORATED });
  try {
    const result = commandCoverage(root, openapi, matrix);
    assert.deepEqual(result.uncovered, ['put_things_id']);
    assert.deepEqual(result.implemented, ['delete_things_id', 'put_things_id']);
    assert.equal(result.writeOperations, 3);
    assert.deepEqual(result.unknown, []);
  } finally {
    cleanup();
  }
});

test('decorated write handlers and read handlers are not reported', () => {
  const { root, openapi, matrix, cleanup } = layout({ 'apps/api/src/things.controller.ts': DECORATED });
  try {
    const result = commandCoverage(root, openapi, matrix);
    assert.deepEqual(result.uncovered, []);
    assert.deepEqual(result.implemented, ['post_things']);
  } finally {
    cleanup();
  }
});

test('an implemented operation that the OpenAPI document does not define is reported as unknown', () => {
  const source = DECORATED.replace('post_things', 'post_nothing');
  const { root, openapi, matrix, cleanup } = layout({ 'apps/api/src/things.controller.ts': source });
  try {
    assert.deepEqual(commandCoverage(root, openapi, matrix).unknown, ['post_nothing']);
  } finally {
    cleanup();
  }
});

test('test directories and node_modules are not scanned', () => {
  const { root, openapi, matrix, cleanup } = layout({
    'apps/api/test/sample.controller.ts': UNDECORATED,
    'apps/api/src/node_modules/x/index.ts': UNDECORATED,
  });
  try {
    assert.deepEqual(commandCoverage(root, openapi, matrix).implemented, []);
  } finally {
    cleanup();
  }
});

test('main exits 1 and names the operation when a write handler lacks @Command, 0 otherwise', () => {
  const bad = layout({ 'apps/api/src/things.controller.ts': UNDECORATED });
  const good = layout({ 'apps/api/src/things.controller.ts': DECORATED });
  try {
    const lines = [];
    assert.equal(main(['--root', bad.root, '--openapi', bad.openapi, '--matrix', bad.matrix], { log: (line) => lines.push(line) }), 1);
    assert.ok(lines.some((line) => line.includes('put_things_id')));
    assert.equal(main(['--root', good.root, '--openapi', good.openapi, '--matrix', good.matrix], { log: () => undefined }), 0);
  } finally {
    bad.cleanup();
    good.cleanup();
  }
});

test('an implemented command without a row in the negative matrix is reported as unmatrixed', () => {
  const { root, openapi, matrix, cleanup } = layout({ 'apps/api/src/things.controller.ts': DECORATED }, []);
  try {
    assert.deepEqual(commandCoverage(root, openapi, matrix).unmatrixed, ['post_things']);
    const lines = [];
    assert.equal(main(['--root', root, '--openapi', openapi, '--matrix', matrix], { log: (line) => lines.push(line) }), 1);
    assert.ok(lines.some((line) => line.includes('post_things')));
  } finally {
    cleanup();
  }
});

test('a missing matrix file leaves every implemented command unmatrixed, and no matrix check runs without a path', () => {
  const { root, openapi, cleanup } = layout({ 'apps/api/src/things.controller.ts': DECORATED });
  try {
    assert.deepEqual(commandCoverage(root, openapi, join(root, 'absent.json')).unmatrixed, ['post_things']);
    assert.deepEqual(commandCoverage(root, openapi).unmatrixed, []);
  } finally {
    cleanup();
  }
});

test('a matrix file that is not {"commands": string[]} is refused', () => {
  const { root, openapi, cleanup } = layout({ 'apps/api/src/things.controller.ts': DECORATED, 'bad-matrix.json': '{"commands": 3}' });
  try {
    assert.throws(() => commandCoverage(root, openapi, join(root, 'bad-matrix.json')), /commands/);
  } finally {
    cleanup();
  }
});

const BODY_OPENAPI = {
  openapi: '3.1.0',
  paths: {
    '/things': {
      post: { operationId: 'post_things', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } },
    },
    '/things/{id}': { put: { operationId: 'put_things_id' }, delete: { operationId: 'delete_things_id' } },
  },
};

function validatorsLayout(bodies) {
  const lines = bodies.map((id) => `  "${id}": "Schema",`);
  const source = ['export const REQUEST_SCHEMAS = {', '  "Schema": {},', '};', '', 'export const REQUEST_BODIES = {', ...lines, '};', ''].join(String.fromCharCode(10));
  return source;
}

test('an implemented command with a JSON body but no generated request schema is reported as unvalidated', () => {
  const { root, cleanup } = layout({
    'apps/api/src/things.controller.ts': DECORATED,
    'openapi-body.json': JSON.stringify(BODY_OPENAPI),
    'with.ts': validatorsLayout(['post_things']),
    'without.ts': validatorsLayout(['other_operation']),
  });
  try {
    const openapi = join(root, 'openapi-body.json');
    assert.deepEqual(commandCoverage(root, openapi, undefined, join(root, 'with.ts')).unvalidated, []);
    assert.deepEqual(commandCoverage(root, openapi, undefined, join(root, 'without.ts')).unvalidated, ['post_things']);
    assert.deepEqual(commandCoverage(root, openapi, undefined, join(root, 'absent.ts')).unvalidated, ['post_things']);
    assert.deepEqual(commandCoverage(root, openapi).unvalidated, []);
    const lines = [];
    const matrix = join(root, 'matrix.json');
    assert.equal(main(['--root', root, '--openapi', openapi, '--matrix', matrix, '--validators', join(root, 'without.ts')], { log: (line) => lines.push(line) }), 1);
    assert.ok(lines.some((line) => line.includes('post_things') && line.includes('contracts:generate')));
    assert.equal(main(['--root', root, '--openapi', openapi, '--matrix', matrix, '--validators', join(root, 'with.ts')], { log: () => undefined }), 0);
  } finally {
    cleanup();
  }
});

test('an implemented command without a JSON body needs no generated request schema', () => {
  const { root, openapi, cleanup } = layout({ 'apps/api/src/things.controller.ts': DECORATED });
  try {
    assert.deepEqual(commandCoverage(root, openapi, undefined, join(root, 'absent.ts')).unvalidated, []);
  } finally {
    cleanup();
  }
});

test('a command listed under controlCommands counts as matrixed, and a controlCommands that is not a list is refused', () => {
  const { root, openapi, cleanup } = layout(
    { 'apps/api/src/things.controller.ts': DECORATED, 'control-matrix.json': JSON.stringify({ commands: [], controlCommands: ['post_things'] }), 'bad-control.json': JSON.stringify({ commands: [], controlCommands: 'post_things' }) },
    [],
  );
  try {
    assert.deepEqual(commandCoverage(root, openapi, join(root, 'control-matrix.json')).unmatrixed, []);
    assert.throws(() => commandCoverage(root, openapi, join(root, 'bad-control.json')), /controlCommands/);
  } finally {
    cleanup();
  }
});

test('a command listed under enterpriseCommands counts as matrixed, and an enterpriseCommands that is not a list is refused', () => {
  const { root, openapi, cleanup } = layout(
    { 'apps/api/src/things.controller.ts': DECORATED, 'enterprise-matrix.json': JSON.stringify({ commands: [], enterpriseCommands: ['post_things'] }), 'bad-enterprise.json': JSON.stringify({ commands: [], enterpriseCommands: 7 }) },
    [],
  );
  try {
    assert.deepEqual(commandCoverage(root, openapi, join(root, 'enterprise-matrix.json')).unmatrixed, []);
    assert.throws(() => commandCoverage(root, openapi, join(root, 'bad-enterprise.json')), /enterpriseCommands/);
  } finally {
    cleanup();
  }
});

test('the real repository has no write handler without @Command', () => {
  assert.equal(main(['--root', REPO_ROOT], { log: () => undefined }), 0);
});

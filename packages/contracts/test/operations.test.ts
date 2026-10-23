import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OPERATIONS_FILE, generateOperations, generateStepUp, main, renderOperationsModule } from '../src/generate';
import { listOperations } from '../src/openapi-document';
import { OPERATIONS } from '../src/operations.generated';
import { documentWith, loadRealDocument } from './fixtures';

const GENERATED_DIR = resolve(__dirname, '..', 'src');

const small = documentWith({
  '/things/{id}': {
    put: {
      operationId: 'update_thing',
      'x-permission': 'thing.update',
      parameters: [{ name: 'id', in: 'path' }, { name: 'Idempotency-Key', in: 'header' }, { name: 'If-Match', in: 'header', required: true }],
      responses: {},
    },
    get: { operationId: 'get_thing', 'x-permission': 'thing.read', responses: {} },
  },
  '/things': {
    post: {
      operationId: 'create_thing',
      'x-permission': 'thing.create',
      'x-step-up': 'aal2',
      parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
      responses: {},
    },
  },
});
small.components = { ...small.components, parameters: { IdempotencyKey: { name: 'Idempotency-Key', in: 'header' } } };

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'contracts-ops-'));
}

describe('generateOperations', () => {
  it('describes method, path, version header, step-up and permission of every operation', () => {
    expect(generateOperations(small)).toEqual({
      create_thing: { method: 'post', path: '/things', versioned: false, stepUp: 'aal2', permission: 'thing.create' },
      get_thing: { method: 'get', path: '/things/{id}', versioned: false, stepUp: null, permission: 'thing.read' },
      update_thing: { method: 'put', path: '/things/{id}', versioned: true, stepUp: null, permission: 'thing.update' },
    });
  });

  it('recognises If-Match in any letter case and through a shared parameter reference', () => {
    const doc = documentWith({
      '/a': {
        patch: { operationId: 'patch_a', 'x-permission': 'a.update', parameters: [{ $ref: '#/components/parameters/IfMatch' }, { name: 'if-match', in: 'header', required: true }], responses: {} },
      },
    });
    doc.components = { ...doc.components, parameters: { IfMatch: { name: 'If-Match', in: 'header', required: true } } };
    expect(generateOperations(doc).patch_a?.versioned).toBe(true);
  });

  it('does not call an operation versioned when it only offers If-Match as an optional header (a create has no version to name)', () => {
    const doc = documentWith({
      '/a': { post: { operationId: 'post_a', 'x-permission': 'a.create', parameters: [{ name: 'If-Match', in: 'header' }], responses: {} } },
      '/b': { post: { operationId: 'post_b', 'x-permission': 'b.create', parameters: [{ name: 'If-Match', in: 'header', required: false }], responses: {} } },
    });
    expect([generateOperations(doc).post_a?.versioned, generateOperations(doc).post_b?.versioned]).toEqual([false, false]);
  });

  it('ignores an unresolvable parameter reference instead of failing', () => {
    const doc = documentWith({
      '/a': { post: { operationId: 'post_a', 'x-permission': 'a.create', parameters: [{ $ref: '#/components/parameters/Missing' }], responses: {} } },
    });
    expect(generateOperations(doc).post_a?.versioned).toBe(false);
  });

  it('throws on an operation without x-permission, a duplicate operationId or an unsupported step-up', () => {
    expect(() => generateOperations(documentWith({ '/a': { get: { operationId: 'x', responses: {} } } }))).toThrow('x has no x-permission');
    const duplicate = documentWith({
      '/a': { get: { operationId: 'dup', 'x-permission': 'a.read', responses: {} } },
      '/b': { get: { operationId: 'dup', 'x-permission': 'b.read', responses: {} } },
    });
    expect(() => generateOperations(duplicate)).toThrow('Duplicate operationId: dup');
    const step = documentWith({ '/a': { post: { operationId: 'y', 'x-permission': 'a.do', 'x-step-up': 'aal3', responses: {} } } });
    expect(() => generateOperations(step)).toThrow('y has an unsupported x-step-up');
  });

  it('covers every operation of the design contract and agrees with the step-up table', () => {
    const doc = loadRealDocument();
    const operations = generateOperations(doc);
    const all = Object.values(operations);
    expect(all).toHaveLength(listOperations(doc).length);
    expect(all.filter((operation) => operation.stepUp !== null)).toHaveLength(Object.keys(generateStepUp(doc)).length);
    expect(all.filter((operation) => operation.versioned).length).toBeGreaterThan(300);
    expect(all.filter((operation) => operation.method === 'get' && operation.versioned)).toHaveLength(0);
  });
});

describe('renderOperationsModule', () => {
  it('is sorted by operationId, deterministic, typed and ends with a newline', () => {
    const text = renderOperationsModule(generateOperations(small));
    expect(text.indexOf('"create_thing"')).toBeLessThan(text.indexOf('"update_thing"'));
    expect(text).toContain('export const OPERATIONS = {');
    expect(text).toContain('} as const;');
    expect(text).toContain('export type OperationName = keyof typeof OPERATIONS;');
    expect(text.endsWith('\n')).toBe(true);
    const reversed = Object.fromEntries(Object.entries(generateOperations(small)).reverse());
    expect(renderOperationsModule(reversed)).toBe(text);
  });
});

describe('committed operations module', () => {
  it('matches what the generator produces from the design contract', () => {
    const committed = readFileSync(join(GENERATED_DIR, OPERATIONS_FILE), 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(renderOperationsModule(generateOperations(loadRealDocument())));
  });

  it('knows the commands the web uses', () => {
    expect(OPERATIONS.moveOrganizationUnit).toEqual({
      method: 'post',
      path: '/org-units/{unitId}/move',
      versioned: true,
      stepUp: null,
      permission: 'iam.unit.manage',
    });
    expect(OPERATIONS.grantRole.stepUp).toBe('aal2');
    expect(OPERATIONS.get_resources_organization_unit.method).toBe('get');
  });
});

describe('main and the operations file', () => {
  it('writes the operations module and --check fails when it is stale', async () => {
    const out = scratchDir();
    const specPath = join(scratchDir(), 'openapi.json');
    writeFileSync(specPath, JSON.stringify(small));
    const lines: string[] = [];
    const io = { log: (line: string) => lines.push(line) };
    expect(await main(['--spec', specPath, '--out', out], io)).toBe(0);
    expect(readFileSync(join(out, OPERATIONS_FILE), 'utf8')).toContain('"update_thing"');
    expect(await main(['--spec', specPath, '--out', out, '--check'], io)).toBe(0);
    writeFileSync(join(out, OPERATIONS_FILE), 'stale\n');
    expect(await main(['--spec', specPath, '--out', out, '--check'], io)).toBe(1);
    expect(lines.join('\n')).toContain(OPERATIONS_FILE);
  });
});

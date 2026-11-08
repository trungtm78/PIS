import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listOperations } from '../src/openapi-document';
import { generateModules, generatePermissions, generatePlanes, generateStepUp, generateTypes, main, renderPermissionsModule } from '../src/generate';
import { PLANES, STEP_UP } from '../src/permissions.generated';
import { documentWith, jsonResponse, loadRealDocument } from './fixtures';

const GENERATED_DIR = resolve(__dirname, '..', 'src');

const small = documentWith({
  '/b': {
    post: {
      operationId: 'post_b',
      'x-permission': 'b.create',
      responses: jsonResponse({ type: 'object', properties: { id: { type: 'string' } } }),
    },
  },
  '/a': { get: { operationId: 'get_a', 'x-permission': 'a.read', responses: jsonResponse({ type: 'string' }) } },
});

function capture() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'contracts-'));
}

function specFor(doc: unknown): string {
  const path = join(scratchDir(), 'openapi.json');
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

describe('generatePermissions', () => {
  it('maps operationId to x-permission', () => {
    expect(generatePermissions(small)).toEqual({ get_a: 'a.read', post_b: 'b.create' });
  });

  it('has one key per operation of the design contract', () => {
    const operations = listOperations(loadRealDocument());
    expect(Object.keys(generatePermissions(loadRealDocument()))).toHaveLength(operations.length);
  });

  it('throws on a duplicate operationId', () => {
    const doc = documentWith({
      '/a': { get: { operationId: 'dup', 'x-permission': 'a.read', responses: {} } },
      '/b': { get: { operationId: 'dup', 'x-permission': 'b.read', responses: {} } },
    });
    expect(() => generatePermissions(doc)).toThrow('Duplicate operationId: dup');
  });

  it('throws on an operation without x-permission', () => {
    const doc = documentWith({ '/a': { get: { operationId: 'x', responses: {} } } });
    expect(() => generatePermissions(doc)).toThrow('x has no x-permission');
  });
});

describe('generateStepUp and generatePlanes', () => {
  const doc = documentWith({
    '/a': { post: { operationId: 'grant_a', 'x-permission': 'a.grant', 'x-step-up': 'aal2', 'x-plane': 'tenant', responses: {} } },
    '/b': { get: { operationId: 'get_b', 'x-permission': 'b.read', 'x-plane': 'control', responses: {} } },
    '/c': { get: { operationId: 'get_c', 'x-permission': 'c.read', responses: {} } },
  });

  it('lists only the operations that require step-up', () => {
    expect(generateStepUp(doc)).toEqual({ grant_a: 'aal2' });
  });

  it('maps every operation to its plane and defaults to tenant', () => {
    expect(generatePlanes(doc)).toEqual({ get_b: 'control', get_c: 'tenant', grant_a: 'tenant' });
  });

  it('throws on an unknown step-up level or plane', () => {
    const badStep = documentWith({ '/a': { get: { operationId: 'x', 'x-permission': 'a.read', 'x-step-up': 'aal3', responses: {} } } });
    expect(() => generateStepUp(badStep)).toThrow('x has an unsupported x-step-up');
    const badPlane = documentWith({ '/a': { get: { operationId: 'y', 'x-permission': 'a.read', 'x-plane': 'moon', responses: {} } } });
    expect(() => generatePlanes(badPlane)).toThrow('y has an unsupported x-plane');
  });

  it('are rendered into the module and match the design contract', () => {
    const text = renderPermissionsModule({ a: 'a.do' }, { a: 'aal2' }, { a: 'control' });
    expect(text).toContain('export const STEP_UP = {');
    expect(text).toContain('"a": "aal2",');
    expect(text).toContain('export const PLANES = {');
    expect(text).toContain('"a": "control",');
    expect(STEP_UP.grantRole).toBe('aal2');
    expect(PLANES.grantRole).toBe('tenant');
    const operations = listOperations(loadRealDocument());
    expect(Object.keys(STEP_UP).sort()).toEqual(operations.filter((entry) => entry.operation['x-step-up'] !== undefined).map((entry) => entry.operation.operationId).sort());
    expect(Object.values(PLANES).filter((plane) => plane === 'control')).toHaveLength(
      operations.filter((entry) => entry.operation['x-plane'] === 'control').length,
    );
    expect(Object.keys(PLANES)).toHaveLength(operations.length);
  });

  it('is deterministic', () => {
    expect(renderPermissionsModule({ b: 'b.do', a: 'a.do' }, { b: 'aal2' }, { b: 'tenant', a: 'edge' })).toBe(
      renderPermissionsModule({ a: 'a.do', b: 'b.do' }, { b: 'aal2' }, { a: 'edge', b: 'tenant' }),
    );
  });
});

describe('renderPermissionsModule', () => {
  it('is sorted by operationId, deterministic and ends with a newline', () => {
    const text = renderPermissionsModule({ z_op: 'z.do', a_op: 'a.do' });
    expect(text.indexOf('"a_op"')).toBeLessThan(text.indexOf('"z_op"'));
    expect(text).toBe(renderPermissionsModule({ a_op: 'a.do', z_op: 'z.do' }));
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('export type OperationId = keyof typeof PERMISSIONS;');
  });
});

describe('generateTypes', () => {
  it('renders openapi-typescript output for the document', async () => {
    const text = await generateTypes(small);
    expect(text).toContain('export interface paths');
    expect(text).toContain('get_a');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('is deterministic', async () => {
    expect(await generateTypes(small)).toBe(await generateTypes(small));
  });
});

describe('committed generated files', () => {
  it('match what the generator produces from the design contract', async () => {
    const doc = loadRealDocument();
    const normalize = (text: string) => text.replace(/\r\n/g, '\n');
    expect(normalize(readFileSync(join(GENERATED_DIR, 'permissions.generated.ts'), 'utf8'))).toBe(
      renderPermissionsModule(generatePermissions(doc), generateStepUp(doc), generatePlanes(doc), generateModules(doc)),
    );
    expect(normalize(readFileSync(join(GENERATED_DIR, 'types.generated.ts'), 'utf8'))).toBe(await generateTypes(doc));
  }, 120_000);
});

describe('main', () => {
  it('writes both files and then passes --check', async () => {
    const out = scratchDir();
    const spec = specFor(small);
    const io = capture();
    expect(await main(['--spec', spec, '--out', out], io)).toBe(0);
    expect(readFileSync(join(out, 'permissions.generated.ts'), 'utf8')).toContain('"get_a": "a.read"');
    expect(readFileSync(join(out, 'types.generated.ts'), 'utf8')).toContain('export interface paths');
    expect(await main(['--spec', spec, '--out', out, '--check'], io)).toBe(0);
  });

  it('fails --check when a committed file is missing or differs, naming the file', async () => {
    const out = scratchDir();
    const spec = specFor(small);
    const first = capture();
    expect(await main(['--spec', spec, '--out', out, '--check'], first)).toBe(1);
    expect(first.lines.join('\n')).toContain('permissions.generated.ts');

    await main(['--spec', spec, '--out', out], capture());
    writeFileSync(join(out, 'types.generated.ts'), 'stale\n');
    const second = capture();
    expect(await main(['--spec', spec, '--out', out, '--check'], second)).toBe(1);
    expect(second.lines.join('\n')).toContain('types.generated.ts');
    expect(second.lines.join('\n')).not.toContain('permissions.generated.ts');
  });

  it('accepts CRLF line endings in committed files when checking', async () => {
    const out = scratchDir();
    const spec = specFor(small);
    await main(['--spec', spec, '--out', out], capture());
    for (const name of ['permissions.generated.ts', 'types.generated.ts']) {
      const path = join(out, name);
      writeFileSync(path, readFileSync(path, 'utf8').replace(/\n/g, '\r\n'));
    }
    expect(await main(['--spec', spec, '--out', out, '--check'], capture())).toBe(0);
  });

  it('refuses to generate from a document that fails lint', async () => {
    const bad = documentWith({ '/a': { get: { operationId: 'no_perm', responses: {} } } });
    const io = capture();
    expect(await main(['--spec', specFor(bad), '--out', scratchDir()], io)).toBe(1);
    expect(io.lines.join('\n')).toContain('no_perm');
    expect(io.lines.join('\n')).toContain('missing_x_permission');
  });

  it('exits 2 as a script without arguments and 1 when the spec cannot be read', () => {
    const script = join(GENERATED_DIR, 'generate.ts');
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, ...args], { encoding: 'utf8' });
    expect(run([]).status).toBe(2);
    const missing = run(['--spec', join(scratchDir(), 'absent.json'), '--out', scratchDir()]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('ENOENT');
  });

  it('requires --spec and --out', async () => {
    const io = capture();
    expect(await main([], io)).toBe(2);
    expect(io.lines.join('\n')).toContain('--spec');
  });
});

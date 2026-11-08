import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnvironment, main } from '../src/compat-cli';
import { REPO_ROOT, documentWith, jsonResponse } from './fixtures';

const SPEC_PATH = 'api/openapi.json';

function spec(permission: string): string {
  return JSON.stringify(
    documentWith({ '/a': { get: { operationId: 'getA', 'x-permission': permission, responses: jsonResponse({ type: 'object' }) } } }),
  );
}

function git(directory: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, env: gitEnvironment(), stdio: 'ignore' });
}

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'machvon-compat-repo-'));
  git(directory, 'init', '-q', '-b', 'main');
  mkdirSync(join(directory, 'api'));
  writeFileSync(join(directory, SPEC_PATH), spec('a.read'));
  git(directory, 'add', '.');
  git(directory, 'commit', '-q', '-m', 'base');
  return directory;
}

describe('git environment', () => {
  it('drops the variables that name a repository, as a git hook sets them, and keeps the others', () => {
    const cleaned = gitEnvironment({ GIT_DIR: '/hook/.git', GIT_INDEX_FILE: 'index.lock', GIT_WORK_TREE: '/hook', PATH: '/bin', GIT_AUTHOR_NAME: 'a' });
    expect(cleaned).toEqual({ PATH: '/bin', GIT_AUTHOR_NAME: 'a' });
  });
});

describe('contracts:compat command line', () => {
  it('compares the working tree with the committed contract and fails on a breaking change', () => {
    const directory = repository();
    writeFileSync(join(directory, SPEC_PATH), spec('a.admin'));
    const lines: string[] = [];
    const code = main(['--spec', join(directory, SPEC_PATH), '--base-ref', 'HEAD'], { log: (line) => lines.push(line), cwd: directory });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('PERMISSION_CHANGED getA');
  });

  it('passes for an unchanged working tree', () => {
    const directory = repository();
    const lines: string[] = [];
    expect(main(['--spec', join(directory, SPEC_PATH), '--base-ref', 'HEAD'], { log: (line) => lines.push(line), cwd: directory })).toBe(0);
    expect(lines.join('\n')).toContain('compatible');
  });

  it('reports SKIPPED with exit 0 when the base reference does not exist', () => {
    const directory = repository();
    const lines: string[] = [];
    expect(main(['--spec', join(directory, SPEC_PATH), '--base-ref', 'origin/nowhere'], { log: (line) => lines.push(line), cwd: directory })).toBe(0);
    expect(lines.join('\n')).toContain('SKIPPED');
  });

  it('exits 2 for a missing specification file', () => {
    const directory = repository();
    const lines: string[] = [];
    expect(main(['--spec', join(directory, 'missing.json')], { log: (line) => lines.push(line), cwd: directory })).toBe(2);
    expect(lines.join('\n')).toContain('cannot read');
  });

  it('forwards the options given to the root script to the CLI', () => {
    // npm consumes anything after the script name unless the root script ends in an argument separator.
    const output = execFileSync('npm', ['run', 'contracts:compat', '--', '--base-ref', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', shell: true });
    expect(output).toContain('--base-ref HEAD');
    expect(output).toContain('compatible with HEAD');
  });
});

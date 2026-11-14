import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from '../src/dart-cli.ts';
import { DART_OUTPUT_PATH } from '../src/dart.ts';
import { DESIGN_TOKENS_PATH } from '../src/generate.ts';
import { VECTORS_PATH } from '../src/vectors.ts';
import { REPO_ROOT } from './support.ts';

function scratchRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'machvon-dart-'));
  const source = join(root, DESIGN_TOKENS_PATH);
  mkdirSync(dirname(source), { recursive: true });
  copyFileSync(join(REPO_ROOT, DESIGN_TOKENS_PATH), source);
  return root;
}

function capture(): { lines: string[]; io: { log: (line: string) => void } } {
  const lines: string[] = [];
  return { lines, io: { log: (line) => lines.push(line) } };
}

describe('dart cli', () => {
  it('generate writes the Dart theme and the shared vectors with LF endings, check then passes', () => {
    const root = scratchRoot();
    const out = capture();
    expect(main(['generate', '--root', root], out.io)).toBe(0);
    expect(out.lines.join('\n')).toContain(DART_OUTPUT_PATH);
    expect(out.lines.join('\n')).toContain(VECTORS_PATH);
    expect(readFileSync(join(root, DART_OUTPUT_PATH), 'utf8')).not.toContain('\r');
    expect(JSON.parse(readFileSync(join(root, VECTORS_PATH), 'utf8'))).toHaveProperty('contrast');
    expect(main(['check', '--root', root], capture().io)).toBe(0);
  });

  it('the committed Dart theme and vectors are what the generator writes', () => {
    expect(main(['check', '--root', REPO_ROOT], capture().io)).toBe(0);
  });

  it('check fails and names the file when a generated file is edited by hand or missing', () => {
    const root = scratchRoot();
    main(['generate', '--root', root], capture().io);
    writeFileSync(join(root, DART_OUTPUT_PATH), `${readFileSync(join(root, DART_OUTPUT_PATH), 'utf8')}// hand edit\n`);
    const edited = capture();
    expect(main(['check', '--root', root], edited.io)).toBe(1);
    expect(edited.lines.join('\n')).toContain(DART_OUTPUT_PATH);

    const missing = scratchRoot();
    const absent = capture();
    expect(main(['check', '--root', missing], absent.io)).toBe(1);
    expect(absent.lines.join('\n')).toContain(VECTORS_PATH);
  });

  it('check ignores CRLF line endings that Git may add on checkout', () => {
    const root = scratchRoot();
    main(['generate', '--root', root], capture().io);
    for (const file of [DART_OUTPUT_PATH, VECTORS_PATH]) {
      writeFileSync(join(root, file), readFileSync(join(root, file), 'utf8').replace(/\n/g, '\r\n'));
    }
    expect(main(['check', '--root', root], capture().io)).toBe(0);
  });

  it('prints usage and exits 2 for an unknown command', () => {
    const out = capture();
    expect(main(['bogus'], out.io)).toBe(2);
    expect(out.lines.join('\n')).toContain('Usage');
  });
});

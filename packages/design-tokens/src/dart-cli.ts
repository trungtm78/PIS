import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DART_OUTPUT_PATH, generateDart } from './dart.ts';
import { DESIGN_TOKENS_PATH } from './generate.ts';
import { DART_V2_OUTPUT_PATH, generateMobileV2Dart } from './mobile-v2.ts';
import type { DesignTokens } from './types.ts';
import { VECTORS_PATH, buildContrastVectors, renderVectors } from './vectors.ts';

export interface Io {
  log: (line: string) => void;
}

const USAGE = 'Usage: dart-cli.ts <generate|check> [--root <repository root>]';
const stdoutIo: Io = { log: (line) => process.stdout.write(`${line}\n`) };

function normaliseEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function generated(root: string): Array<{ path: string; text: string }> {
  const json = JSON.parse(readFileSync(join(root, DESIGN_TOKENS_PATH), 'utf8')) as DesignTokens;
  return [
    { path: DART_OUTPUT_PATH, text: generateDart(json) },
    { path: DART_V2_OUTPUT_PATH, text: generateMobileV2Dart(json) },
    { path: VECTORS_PATH, text: renderVectors(buildContrastVectors()) },
  ];
}

function readCommitted(path: string): string | undefined {
  try {
    return normaliseEol(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Exit codes: 0 ok, 1 a generated file is stale or missing, 2 usage error. */
export function main(argv: string[], io: Io = stdoutIo): number {
  const { values, positionals } = parseArgs({ args: argv, options: { root: { type: 'string', default: '.' } }, allowPositionals: true });
  const root = resolve(values.root);
  switch (positionals[0]) {
    case 'generate':
      for (const file of generated(root)) {
        const target = join(root, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.text);
        io.log(`Wrote: ${file.path}`);
      }
      return 0;
    case 'check': {
      const stale = generated(root).filter((file) => readCommitted(join(root, file.path)) !== file.text);
      for (const file of stale) io.log(`Out of date: ${file.path}. Run \`npm run dart:generate -w @machvon/design-tokens\`.`);
      return stale.length === 0 ? 0 : 1;
    }
    default:
      io.log(USAGE);
      return 2;
  }
}

// Runs only when started as a script (node src/dart-cli.ts), never when imported by tests.
if (process.argv[1] !== undefined && /[\\/]dart-cli\.ts$/.test(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}

#!/usr/bin/env node
// Copies the operator tools of the repository into one directory, at the relative paths they have in the api image of the Windows deployment (they import each other):
// for an installation whose image was built before a tool existed (host\demo-tenant.ps1 -Tools <dir> mounts the directory read-only into its one-shot container).
//
//   node scripts/demo-tools-pack.mjs --out <directory>
//
// Nothing secret and nothing of the application is copied: the tools of infra/onprem-windows/tools and the scripts they import (TOOL_SCRIPTS of the pack).
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TOOL_SCRIPTS } from './onprem-windows-pack.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The files of the tools directory, as [source, target] relative paths. Pure. */
export function toolFiles(scripts = TOOL_SCRIPTS) {
  return [...scripts.map((file) => [join('scripts', file), join('scripts', file)]), [join('infra', 'onprem-windows', 'tools'), join('infra', 'onprem-windows', 'tools')]];
}

export function main(argv, { log = (line) => process.stdout.write(`${line}\n`), root = ROOT } = {}) {
  const { values } = parseArgs({ args: argv, options: { out: { type: 'string' } }, allowPositionals: false });
  if (typeof values.out !== 'string' || values.out === '') {
    log('demo-tools-pack: --out <directory> is required');
    return 2;
  }
  const out = resolve(values.out);
  rmSync(out, { recursive: true, force: true });
  for (const [source, target] of toolFiles()) {
    mkdirSync(dirname(join(out, target)), { recursive: true });
    cpSync(join(root, source), join(out, target), { recursive: true });
  }
  log(`demo-tools-pack: the tools are in ${out}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}

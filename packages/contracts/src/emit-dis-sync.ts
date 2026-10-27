import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mobileContractMarkdown, syncRulesYaml } from './dis-sync.ts';

/**
 * Writes the two files that are made from the sync contract of the weekly report (ST-DIS-017): the sync rules of PowerSync and the contract pack of the mobile group. With `--check` it writes
 * nothing and fails when a file is not what the source says, which is what keeps the rules and the pack from drifting away from the code.
 */
// The script is run as a file (`node src/emit-dis-sync.ts`), so its place is its own argument; the package is built as CommonJS, where `import.meta` is not allowed.
const ROOT = resolve(dirname(process.argv[1] ?? '.'), '..', '..', '..');
const FILES = [
  { path: resolve(ROOT, 'infra', 'powersync', 'sync-rules.reference.yaml'), content: (): string => syncRulesYaml() },
  { path: resolve(ROOT, 'docs', 'dis-mobile-contract.md'), content: (): string => mobileContractMarkdown(JSON.parse(readFileSync(resolve(ROOT, 'Design', 'MACHVON_Design', '03_Engineering', 'openapi.json'), 'utf8'))) },
];

const check = process.argv.includes('--check');
const normal = (text: string): string => text.replace(/\r\n/g, '\n');
let stale = 0;
for (const file of FILES) {
  const wanted = file.content();
  let current: string | undefined;
  try {
    current = normal(readFileSync(file.path, 'utf8'));
  } catch {
    current = undefined;
  }
  if (current === wanted) continue;
  if (check) {
    stale += 1;
    process.stderr.write(`out of date: ${file.path.replace(ROOT, '.')}\n`);
  } else {
    writeFileSync(file.path, wanted);
    process.stdout.write(`written: ${file.path.replace(ROOT, '.')}\n`);
  }
}
if (stale > 0) process.exit(1);

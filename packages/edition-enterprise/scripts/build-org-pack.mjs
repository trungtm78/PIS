// Builds the files that are made from the PVFCCo template pack (ENT-3d):
//   templates/org-pack/pvfcco-template.csv                      the file an administrator registers as a migration batch (target entity ORG_PACK, mapping ORG-PACK-1);
//   infra/keycloak/onprem/ad-group-role-map.json  tenantMappings  the directory groups that fill the seats of the pack.
//   node packages/edition-enterprise/scripts/build-org-pack.mjs            writes both;
//   node packages/edition-enterprise/scripts/build-org-pack.mjs --check    exits 1 when a committed file differs from what the pack gives.
// The pack is TypeScript loaded by Node itself; run it with Node 22.6 or newer.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(PACKAGE_DIR, '..', '..');
export const CSV_PATH = join(PACKAGE_DIR, 'templates', 'org-pack', 'pvfcco-template.csv');
export const MAP_PATH = join(ROOT, 'infra', 'keycloak', 'onprem', 'ad-group-role-map.json');

/** The two files as the pack gives them. */
export async function buildOutputs() {
  const kernel = await import(pathToFileURL(join(ROOT, 'packages', 'kernel', 'src', 'index.ts')).href);
  const { pvfccoTemplatePack } = await import(pathToFileURL(join(PACKAGE_DIR, 'src', 'org-pack', 'pvfcco-template.ts')).href);
  const pack = pvfccoTemplatePack();
  const csv = kernel.orgPackCsv(pack);
  const tenantMappings = kernel.directoryMappings(pack).map((one) => ({ adGroup: one.adGroup, tenantRole: one.tenantRole, scopeKind: one.scopeKind, unit: one.unit, pack: pack.label }));
  const current = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  const next = { ...current, tenantMappings };
  // The file keeps its CRLF line ends.
  const map = `${JSON.stringify(next, null, 2).replace(/\n/g, '\r\n')}\r\n`;
  return { csv, map };
}

export async function main(argv) {
  const { csv, map } = await buildOutputs();
  if (argv.includes('--check')) {
    const problems = [];
    if (!existsSync(CSV_PATH) || readFileSync(CSV_PATH, 'utf8') !== csv) problems.push('templates/org-pack/pvfcco-template.csv is stale (npm run org-pack:build -w @machvon/edition-enterprise)');
    if (readFileSync(MAP_PATH, 'utf8') !== map) problems.push('ad-group-role-map.json tenantMappings is stale (npm run org-pack:build -w @machvon/edition-enterprise)');
    process.stderr.write(problems.map((problem) => `${problem}\n`).join(''));
    return problems.length === 0 ? 0 : 1;
  }
  mkdirSync(dirname(CSV_PATH), { recursive: true });
  writeFileSync(CSV_PATH, csv);
  writeFileSync(MAP_PATH, map);
  return 0;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));

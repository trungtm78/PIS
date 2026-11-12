import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * Registers the screen-contract cases (tc_id TC-UI-<SCREEN>, platform web) of docs/uat/<module>/uat.json with the browser spec that decides them
 * (apps/web/e2e/screen-contract.spec.ts): writes the table the spec reads (apps/web/e2e/support/screen-contract-cases.json) and sets the `automation`
 * of each case in its handoff file. A case whose screen is a route of the web route table is AUTOMATED (suite and registry, which `npm run uat:check` reads);
 * a case whose screen is not a web route is MANUAL, with the reason. `--check` fails when either file is not what the generator would write.
 *
 *   node scripts/uat-screen-contract.mjs generate
 *   node scripts/uat-screen-contract.mjs check
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
export const SUITE = 'apps/web/e2e/screen-contract.spec.ts';
export const REGISTRY = 'apps/web/e2e/support/screen-contract-cases.json';
const ROUTES = join('apps', 'web', 'src', 'routes', 'routes.generated.json');
const CATALOGUE = join('Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json');

const CASE_PREFIX = 'TC-UI-';

const slash = (path) => path.split(sep).join('/');

/** The handoff files of the modules, `critical` (a slice that repeats cases of the module folders) left out. */
function handoffFiles(root) {
  const directory = join(root, 'docs', 'uat');
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'critical')
    .map((entry) => join(directory, entry.name, 'uat.json'))
    .filter((file) => existsSync(file));
}

/** Screens whose address names one record of the tenant (an approval task, a directive): without that record there is no page of the screen to measure. */
export const NEEDS_A_RECORD = {
  'PWA-05': 'Màn hình PWA-05 là chi tiết của một việc phê duyệt (/m/approvals/<mã việc>): địa chỉ cần một việc có thật của tenant mà stack e2e có sẵn không có (PWA-02 hiện trạng thái rỗng); địa chỉ với mã bịa chỉ hiện thẻ "không thấy việc", không phải màn chi tiết',
  'PWA-06': 'Màn hình PWA-06 là chi tiết của một chỉ đạo (/m/directives/<mã chỉ đạo>): địa chỉ cần một chỉ đạo có thật của tenant mà stack e2e có sẵn không có (PWA-04 hiện trạng thái rỗng); dựng một chỉ đạo cần cuộc giao ban và các bước của phân hệ DIR ngoài bộ dữ liệu của stack',
};

/**
 * The reason a screen-contract case cannot be decided by the browser spec, or undefined when it can. The spec opens the route of the web route table with the
 * development session; a screen that is not a web route has no address to open.
 */
export function manualReason(screen, routeIds, catalogue) {
  if (Object.hasOwn(NEEDS_A_RECORD, screen)) return NEEDS_A_RECORD[screen];
  if (routeIds.has(screen)) return undefined;
  const entry = catalogue.get(screen);
  if (entry === undefined) return `Mã ${screen} không có trong danh mục màn hình: không có trang để mở`;
  if (entry.platform !== 'web') {
    return `Màn hình ${screen} chỉ có trên điện thoại (nền tảng ${entry.platform} trong danh mục), không có địa chỉ web để mở; kịch bản Maestro của điện thoại là nơi kiểm`;
  }
  return `Màn hình ${screen} không có tuyến trong bảng tuyến web`;
}

/** The text of the `automation` block of a case, at the indent of its properties. */
function automationText(automation, indent) {
  const inner = `${indent}  `;
  const lines = Object.entries(automation).map(([key, value]) => `${inner}${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `${indent}"automation": {\n${lines.join(',\n')}\n${indent}}`;
}

/**
 * Sets the automation of the case `tcId` in the text of a handoff file, changing nothing else (the generator of the files writes some numbers with a trailing `.0` that a
 * re-serialisation would drop). Returns the new text.
 */
export function withAutomation(text, tcId, automation) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(`"tc_id": ${JSON.stringify(tcId)}`));
  if (start < 0) throw new Error(`the case ${tcId} is not in the handoff file`);
  const propertyIndent = /^\s*/.exec(lines[start])[0];
  const closeIndent = propertyIndent.slice(2);
  let end = start;
  while (end < lines.length && !(lines[end].startsWith(`${closeIndent}}`) && lines[end].trim().replace(/,$/, '') === '}')) end += 1;
  if (end >= lines.length) throw new Error(`the case ${tcId} has no end`);
  const block = automationText(automation, propertyIndent).split('\n');
  const existing = lines.slice(start, end).findIndex((line) => line.trim() === '"automation": {');
  if (existing >= 0) {
    let last = start + existing;
    while (!lines[last].startsWith(`${propertyIndent}}`)) last += 1;
    // The block is a property of the object: it is followed by a comma unless it is the last one.
    const trailingComma = lines[last].trim().endsWith(',') ? ',' : '';
    block[block.length - 1] += trailingComma;
    lines.splice(start + existing, last - (start + existing) + 1, ...block);
  } else {
    // Appended after the last property: that property gets the comma.
    lines[end - 1] = `${lines[end - 1]},`;
    lines.splice(end, 0, ...block);
  }
  return lines.join(eol);
}

/** What the generator writes for a repository: the table of the spec and the new text of each handoff file that changes. */
export function planOf(root) {
  const routeIds = new Set(JSON.parse(readFileSync(join(root, ROUTES), 'utf8')).routes.map((route) => route.id));
  const catalogue = new Map(JSON.parse(readFileSync(join(root, CATALOGUE), 'utf8')).map((screen) => [screen.id, screen]));
  const rows = [];
  const files = new Map();
  const seen = new Set();
  for (const file of handoffFiles(root)) {
    const original = readFileSync(file, 'utf8');
    let text = original;
    for (const test of JSON.parse(original).test_cases ?? []) {
      if (!String(test.tc_id).startsWith(CASE_PREFIX) || test.platform !== 'web' || typeof test.screen_id !== 'string') continue;
      if (seen.has(test.tc_id)) continue;
      seen.add(test.tc_id);
      const reason = manualReason(test.screen_id, routeIds, catalogue);
      if (reason === undefined) {
        rows.push({ id: test.tc_id.slice(3), tc: test.tc_id, screen: test.screen_id, module: test.module, priority: test.priority, expected: test.expected });
        text = withAutomation(text, test.tc_id, { state: 'AUTOMATED', suite: SUITE, registry: REGISTRY });
      } else {
        text = withAutomation(text, test.tc_id, { state: 'MANUAL', reason });
      }
    }
    if (text !== original) files.set(file, text);
  }
  rows.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { registry: `${JSON.stringify(rows, null, 2)}\n`, files };
}

export function main(argv, { root = REPO_ROOT, log = console.log } = {}) {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true });
  const mode = positionals[0] ?? 'check';
  if (mode !== 'generate' && mode !== 'check') {
    log('usage: node scripts/uat-screen-contract.mjs generate|check');
    return 2;
  }
  const plan = planOf(root);
  const registryPath = join(root, REGISTRY);
  const registryNow = existsSync(registryPath) ? readFileSync(registryPath, 'utf8').replace(/\r\n/g, '\n') : undefined;
  if (mode === 'generate') {
    writeFileSync(registryPath, plan.registry);
    for (const [file, text] of plan.files) writeFileSync(file, text);
    log(`screen contract: ${JSON.parse(plan.registry).length} cases in ${REGISTRY}, ${plan.files.size} handoff files changed`);
    return 0;
  }
  const stale = [];
  if (registryNow !== plan.registry) stale.push(REGISTRY);
  for (const file of plan.files.keys()) stale.push(slash(relative(root, file)));
  for (const path of stale) log(`stale: ${path} (run node scripts/uat-screen-contract.mjs generate)`);
  return stale.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}

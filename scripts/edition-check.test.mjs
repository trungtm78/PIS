import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ENTERPRISE_HOMES,
  ENTERPRISE_SEAMS,
  FINDING_CODES,
  checkEdition,
  dartOverlayKeys,
  distCodeNameHits,
  distHits,
  inEnterpriseHome,
  main,
  mayImportEnterprise,
  namesCodeName,
  namesEnterprise,
  specifiersOf,
} from './edition-check.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const scratch = [];
const NAME_VI = 'Phần mềm thử nghiệm bản doanh nghiệp';
const NAME_EN = 'Enterprise test software';
const PACK = 'enterprise-test-pack';

// A manifest without imports, so that a temporary layout can load it as the real one is loaded.
const MANIFEST = `export const ENTERPRISE_EDITION_MANIFEST = {
  edition: 'enterprise',
  productName: { vi: '${NAME_VI}', en: '${NAME_EN}' },
  terminology: { web: ['shell.a.b.c', 'shell.a.b.d'], mobile: ['mob.a.b.c'] },
  rulePacks: ['${PACK}'],
};
`;

const DART_OVERLAY = `const String kEnterpriseProductNameVi = '${NAME_VI}';
const StringTable kEnterpriseStrings = StringTable(
  vi: <String, String>{'mob.a.b.c': 'Một'},
  en: <String, String>{'mob.a.b.c': 'One'},
);
`;

const DART_BASE = `const StringTable kBase = StringTable(
  vi: <String, String>{'mob.a.b.c': 'Một cũ', 'mob.x.y.z': 'x'},
  en: <String, String>{'mob.a.b.c': 'Old one', 'mob.x.y.z': 'x'},
);
`;

const BASE = {
  'package.json': '{"type":"module"}\n',
  'packages/edition-enterprise/src/manifest.ts': MANIFEST,
  'packages/edition-enterprise/src/index.ts': "import './manifest.ts';\nexport const X = 1;\n",
  'apps/web/src/editions/enterprise/index.ts': "export const bundle = 1;\n",
  'apps/web/src/editions/enterprise/overlay.vi.json': JSON.stringify({ 'shell.a.b.c': 'Một', 'shell.a.b.d': 'Hai' }),
  'apps/web/src/editions/enterprise/overlay.en.json': JSON.stringify({ 'shell.a.b.c': 'One', 'shell.a.b.d': 'Two' }),
  'apps/web/src/i18n/vi.json': JSON.stringify({ 'shell.a.b.c': 'm', 'shell.a.b.d': 'h', 'shell.q.r.s': 'q' }),
  'apps/web/src/i18n/en.json': JSON.stringify({ 'shell.a.b.c': 'o', 'shell.a.b.d': 't', 'shell.q.r.s': 'q' }),
  'apps/web/src/editions/load.ts': "export const loader = () => import('./enterprise');\n",
  'apps/web/src/main.tsx': "import { loader } from './editions/load';\nexport default loader;\n",
  'apps/api/src/editions/load-enterprise.ts': "export const load = () => import('@machvon/edition-enterprise');\n",
  'apps/api/src/modules/registry.ts': "export const MODULES = [];\n",
  'apps/mobile/lib/editions/enterprise/enterprise_strings.dart': DART_OVERLAY,
  'apps/mobile/lib/app/edition_seam.dart': "import '../editions/enterprise/enterprise_strings.dart';\n",
  'apps/mobile/lib/features/base_strings.dart': DART_BASE,
};

function layout(files = {}, drop = []) {
  const root = mkdtempSync(join(tmpdir(), 'machvon-edition-'));
  scratch.push(root);
  const all = { ...BASE, ...files };
  for (const path of drop) delete all[path];
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

after(() => {
  for (const root of scratch) rmSync(root, { recursive: true, force: true });
});

const codesOf = async (root, extra = {}) => (await checkEdition({ root, ...extra })).findings.map((entry) => entry.code);

describe('the repository itself', () => {
  it('holds nothing of the enterprise edition outside its homes', async () => {
    const { findings, summary } = await checkEdition({ root: REPO });
    assert.deepEqual(findings, []);
    assert.equal(summary.manifest, true);
    assert.ok(summary.words >= 3);
  });

  it('keeps the list of importers equal to the module rule of .dependency-cruiser.cjs', () => {
    const rule = require(join(REPO, '.dependency-cruiser.cjs')).forbidden.find((entry) => entry.name === 'enterprise-edition-code-only-from-its-homes');
    assert.ok(rule, 'the rule exists');
    const importers = new RegExp(rule.from.pathNot);
    const targets = new RegExp(rule.to.path);
    const samples = [
      'packages/edition-enterprise/src/index.ts',
      'apps/web/src/editions/enterprise/index.ts',
      'apps/web/src/editions/load.ts',
      'apps/web/src/editions/edition.ts',
      'apps/web/src/main.tsx',
      'apps/api/src/editions/load-enterprise.ts',
      'apps/api/src/editions/load-edition.ts',
      'apps/api/src/editions/enterprise/hpm.controller.ts',
      'apps/api/src/bootstrap.ts',
      'apps/mobile/lib/editions/enterprise/enterprise_profile.dart',
      'apps/mobile/lib/app/edition_seam.dart',
      'apps/mobile/lib/app/app.dart',
      'apps/web/src/editions/overlay.enterprise.test.ts',
      'apps/web/src/editions/edition.test.tsx',
      'packages/kernel/src/edition.ts',
    ];
    for (const sample of samples) {
      // The cruiser tests ts and tsx; the seam of the phone is Dart, which the cruiser does not read, so only the check judges it.
      if (sample.endsWith('.dart')) continue;
      assert.equal(importers.test(sample), mayImportEnterprise(sample), sample);
    }
    for (const home of ENTERPRISE_HOMES) assert.ok(targets.test(`${home}file.ts`), home);
    assert.ok(targets.test('@machvon/edition-enterprise'));
    assert.ok(!targets.test('packages/kernel/src/edition.ts'));
    for (const seam of ENTERPRISE_SEAMS.filter((path) => path.endsWith('.ts'))) assert.ok(importers.test(seam), seam);
  });
});

describe('a clean layout', () => {
  it('has no finding', async () => {
    const { findings, summary } = await checkEdition({ root: layout() });
    assert.deepEqual(findings, []);
    assert.equal(summary.words, 3);
  });

  it('prints the sentence of a pass and exits 0', async () => {
    const lines = [];
    assert.equal(await main(['--root', layout()], (line) => lines.push(line)), 0);
    assert.match(lines.join('\n'), /holds nothing of the enterprise edition/);
  });

  it('knows its own finding codes', () => {
    assert.equal(new Set(FINDING_CODES).size, FINDING_CODES.length);
  });
});

describe('imports of the enterprise edition', () => {
  it('reports a public file that imports the package, by name', async () => {
    const root = layout({ 'apps/api/src/app.module.ts': "import { X } from '@machvon/edition-enterprise';\nexport { X };\n" });
    const { findings } = await checkEdition({ root });
    assert.deepEqual(findings.map((entry) => [entry.code, entry.file]), [['ENT_IMPORTS_ENTERPRISE', 'apps/api/src/app.module.ts']]);
  });

  it('reports a relative import of a home, a dynamic import, a re-export and a require', async () => {
    const root = layout({
      'apps/web/src/a.ts': "import { x } from './editions/enterprise/index';\nexport { x };\n",
      'apps/web/src/b.tsx': "export const load = () => import('./editions/enterprise');\n",
      'apps/web/src/c.ts': "export * from './editions/enterprise/index';\n",
      'apps/web/src/d.ts': "const x = require('./editions/enterprise/index');\nexport { x };\n",
      'apps/web/src/screens/deep/e.ts': "import { x } from '../../editions/enterprise/index';\nexport { x };\n",
    });
    assert.deepEqual(
      (await checkEdition({ root })).findings.map((entry) => entry.file).sort(),
      ['apps/web/src/a.ts', 'apps/web/src/b.tsx', 'apps/web/src/c.ts', 'apps/web/src/d.ts', 'apps/web/src/screens/deep/e.ts'],
    );
  });

  it('reports an alias that names the enterprise folder, and a package of another app that imports a home by path', async () => {
    const root = layout({ 'apps/web/src/a.ts': "import { x } from '@/editions/enterprise';\nexport { x };\n", 'apps/api/src/b.ts': "import { x } from '../../../packages/edition-enterprise/src/index';\nexport { x };\n" });
    assert.deepEqual((await checkEdition({ root })).findings.map((entry) => entry.file).sort(), ['apps/api/src/b.ts', 'apps/web/src/a.ts']);
  });

  it('lets the homes, the loaders and the tests named for the purpose import it', async () => {
    const root = layout({
      'apps/web/src/editions/enterprise/more.ts': "import { x } from '../../../../../packages/edition-enterprise/src/index';\nexport { x };\n",
      'packages/edition-enterprise/src/more.ts': "import { x } from './index';\nexport { x };\n",
      'apps/web/src/editions/overlay.enterprise.test.ts': "import { bundle } from './enterprise';\nexport { bundle };\n",
      'apps/web/src/editions/overlay.enterprise.test.tsx': "import { bundle } from './enterprise';\nexport { bundle };\n",
      'apps/mobile/test/editions/edition_enterprise_test.dart': "import 'package:machvon_mobile/editions/enterprise/enterprise_strings.dart';\n",
    });
    assert.deepEqual((await checkEdition({ root })).findings, []);
  });

  it('does not let an ordinary test import it, nor a file whose name only ends alike', async () => {
    const root = layout({ 'apps/web/src/editions/edition.test.ts': "import { bundle } from './enterprise';\nexport { bundle };\n", 'apps/web/src/editions/x.enterprise.ts': "import { bundle } from './enterprise';\nexport { bundle };\n" });
    assert.deepEqual((await checkEdition({ root })).findings.map((entry) => entry.file).sort(), ['apps/web/src/editions/edition.test.ts', 'apps/web/src/editions/x.enterprise.ts']);
  });

  it('reports the Dart files that import the enterprise folder, by package path and by relative path', async () => {
    const root = layout({
      'apps/mobile/lib/app/app.dart': "import 'package:machvon_mobile/editions/enterprise/enterprise_strings.dart';\n",
      'apps/mobile/lib/core/x.dart': "import '../editions/enterprise/enterprise_strings.dart';\nexport '../editions/enterprise/enterprise_profile.dart';\n",
    });
    const found = (await checkEdition({ root })).findings;
    assert.deepEqual(found.map((entry) => entry.file), ['apps/mobile/lib/app/app.dart', 'apps/mobile/lib/core/x.dart', 'apps/mobile/lib/core/x.dart']);
    assert.ok(found.every((entry) => entry.code === 'ENT_IMPORTS_ENTERPRISE'));
  });

  it('ignores an unrelated import that merely sounds alike', async () => {
    const root = layout({ 'apps/web/src/a.ts': "import { x } from '@machvon/kernel/src/edition.ts';\nimport { y } from './editions/edition';\nexport { x, y };\n" });
    assert.deepEqual((await checkEdition({ root })).findings, []);
  });
});

describe('words of the enterprise edition in public sources', () => {
  it('reports the product name in a source, a catalogue and a Dart file, and a rule pack in a source', async () => {
    const root = layout({
      'apps/web/src/a.ts': `export const name = '${NAME_VI}';\n`,
      'apps/web/src/i18n/parts/x.vi.json': JSON.stringify({ 'shell.a.b.c': NAME_EN }),
      'apps/mobile/lib/app/b.dart': `const name = '${NAME_VI}';\n`,
      'apps/api/src/c.ts': `export const pack = '${PACK}';\n`,
    });
    const found = (await checkEdition({ root })).findings;
    assert.deepEqual(found.map((entry) => entry.file).sort(), ['apps/api/src/c.ts', 'apps/mobile/lib/app/b.dart', 'apps/web/src/a.ts', 'apps/web/src/i18n/parts/x.vi.json']);
    assert.ok(found.every((entry) => entry.code === 'ENT_ENTERPRISE_WORD_IN_PUBLIC_SOURCE'));
  });

  it('lets tests say the words, and the homes', async () => {
    const root = layout({
      'apps/web/src/a.test.ts': `export const name = '${NAME_VI}';\n`,
      'apps/api/test/editions/x.test.ts': `export const name = '${NAME_VI}';\n`,
      'apps/mobile/test/y_test.dart': `const name = '${NAME_VI}';\n`,
      'packages/edition-enterprise/src/names.ts': `export const name = '${NAME_VI}';\n`,
    });
    assert.deepEqual((await checkEdition({ root })).findings, []);
  });

  it('reports no word when there is no enterprise manifest to read them from, and a manifest that cannot be loaded', async () => {
    assert.deepEqual(await codesOf(layout({}, ['packages/edition-enterprise/src/manifest.ts'])), []);
    const broken = layout({ 'packages/edition-enterprise/src/manifest.ts': 'export const OTHER = 1;\n' });
    assert.deepEqual(await codesOf(broken), ['ENT_MANIFEST_UNREADABLE']);
  });
});

describe('modules of the API registry', () => {
  it('reports a module that exists in the enterprise edition only', async () => {
    const root = layout({ 'apps/api/src/modules/hpm/index.ts': "export const hpmModule = defineModule({ code: 'HPM', controllers: [], editions: ['enterprise'] });\n" });
    assert.deepEqual((await checkEdition({ root })).findings.map((entry) => entry.code), ['ENT_ENTERPRISE_ONLY_MODULE']);
  });

  it('lets a module of both editions, of the public one and a list that is empty, and a test', async () => {
    const root = layout({
      'apps/api/src/modules/a/index.ts': "export const a = { editions: ['public', 'enterprise'] };\n",
      'apps/api/src/modules/b/index.ts': 'export const b = { editions: [\'public\'] };\n',
      'apps/api/src/modules/c/index.ts': 'export const c = { editions: [] };\n',
      'apps/api/src/modules/d/d.test.ts': "export const d = { editions: ['enterprise'] };\n",
    });
    assert.deepEqual((await checkEdition({ root })).findings, []);
  });
});

describe('the overlays', () => {
  it('reports a web overlay that lacks a listed key, holds one that is not listed, or one the catalogue does not know', async () => {
    const lacking = layout({ 'apps/web/src/editions/enterprise/overlay.vi.json': JSON.stringify({ 'shell.a.b.c': 'Một' }) });
    assert.match((await checkEdition({ root: lacking })).findings.map((entry) => entry.message).join('|'), /lacks keys the manifest lists: shell.a.b.d/);
    const extra = layout({ 'apps/web/src/editions/enterprise/overlay.en.json': JSON.stringify({ 'shell.a.b.c': 'One', 'shell.a.b.d': 'Two', 'shell.q.r.s': 'Q' }) });
    assert.match((await checkEdition({ root: extra })).findings.map((entry) => entry.message).join('|'), /does not list: shell.q.r.s/);
    const unknown = layout({
      'apps/web/src/editions/enterprise/overlay.vi.json': JSON.stringify({ 'shell.a.b.c': 'Một', 'shell.a.b.d': 'Hai' }),
      'apps/web/src/i18n/vi.json': JSON.stringify({ 'shell.a.b.c': 'm' }),
    });
    assert.match((await checkEdition({ root: unknown })).findings.map((entry) => entry.message).join('|'), /base catalogue does not know.*shell.a.b.d/);
  });

  it('reads the keys of the catalogue parts as well', async () => {
    const root = layout({
      'apps/web/src/i18n/vi.json': JSON.stringify({ 'shell.a.b.c': 'm' }),
      'apps/web/src/i18n/parts/lane.vi.json': JSON.stringify({ 'shell.a.b.d': 'h' }),
    });
    assert.deepEqual((await checkEdition({ root })).findings, []);
  });

  it('reports a missing web overlay file', async () => {
    const root = layout({}, ['apps/web/src/editions/enterprise/overlay.en.json']);
    assert.match((await checkEdition({ root })).findings.map((entry) => entry.message).join('|'), /overlay.en.json is missing/);
  });

  it('reports a phone overlay that differs from the manifest in either language, or from the base strings', async () => {
    const lacking = layout({ 'apps/mobile/lib/editions/enterprise/enterprise_strings.dart': DART_OVERLAY.replace("vi: <String, String>{'mob.a.b.c': 'Một'}", 'vi: <String, String>{}') });
    assert.match((await checkEdition({ root: lacking })).findings.map((entry) => entry.message).join('|'), /phone overlay \(vi\) lacks keys the manifest lists: mob.a.b.c/);
    const extra = layout({ 'apps/mobile/lib/editions/enterprise/enterprise_strings.dart': DART_OVERLAY.replace("en: <String, String>{'mob.a.b.c': 'One'}", "en: <String, String>{'mob.a.b.c': 'One', 'mob.x.y.z': 'z'}") });
    assert.match((await checkEdition({ root: extra })).findings.map((entry) => entry.message).join('|'), /phone overlay \(en\) holds keys the manifest does not list: mob.x.y.z/);
    const unknown = layout({ 'apps/mobile/lib/features/base_strings.dart': "const StringTable kBase = StringTable(vi: <String, String>{'mob.x.y.z': 'x'}, en: <String, String>{'mob.x.y.z': 'x'});\n" });
    assert.match((await checkEdition({ root: unknown })).findings.map((entry) => entry.message).join('|'), /base strings do not know: mob.a.b.c/);
  });

  it('reports a phone product name that is not the manifest name, and a phone overlay without its two maps', async () => {
    const renamed = layout({ 'apps/mobile/lib/editions/enterprise/enterprise_strings.dart': DART_OVERLAY.replace(NAME_VI, 'Tên khác') });
    assert.match((await checkEdition({ root: renamed })).findings.map((entry) => entry.message).join('|'), /kEnterpriseProductNameVi \(Tên khác\) must equal/);
    const shapeless = layout({ 'apps/mobile/lib/editions/enterprise/enterprise_strings.dart': `const String kEnterpriseProductNameVi = '${NAME_VI}';\n` });
    assert.match((await checkEdition({ root: shapeless })).findings.map((entry) => entry.message).join('|'), /declare a vi: map and then an en: map/);
    const nameless = layout({ 'apps/mobile/lib/editions/enterprise/enterprise_strings.dart': 'const x = 1;\n' });
    assert.match((await checkEdition({ root: nameless })).findings.map((entry) => entry.message).join('|'), /kEnterpriseProductNameVi \(missing\)/);
  });

  it('reports a manifest that lists phone keys while the phone overlay file is missing, and passes when it lists none', async () => {
    const missing = layout({}, ['apps/mobile/lib/editions/enterprise/enterprise_strings.dart']);
    assert.match((await checkEdition({ root: missing })).findings.map((entry) => entry.message).join('|'), /phone overlay file is missing/);
    const none = layout({ 'packages/edition-enterprise/src/manifest.ts': MANIFEST.replace("mobile: ['mob.a.b.c']", 'mobile: []') }, ['apps/mobile/lib/editions/enterprise/enterprise_strings.dart']);
    assert.deepEqual((await checkEdition({ root: none })).findings, []);
  });

  it('reads the two maps of a Dart string table', () => {
    assert.deepEqual(dartOverlayKeys(DART_OVERLAY), { vi: ['mob.a.b.c'], en: ['mob.a.b.c'] });
    assert.equal(dartOverlayKeys('const x = 1;'), undefined);
    assert.equal(dartOverlayKeys("en: <String, String>{'mob.a.b.c': 'x'}, vi: <String, String>{}"), undefined);
  });
});

describe('a build', () => {
  const dist = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'machvon-dist-'));
    scratch.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  };

  it('passes a public build that says only its own name', async () => {
    const publicDist = dist({ 'assets/index.js': 'console.log("Hệ thống quản lý đầu tư công")', 'index.html': '<title>x</title>' });
    assert.deepEqual(await codesOf(layout(), { publicDist: [publicDist] }), []);
  });

  it('reports a public build that carries the product name, a rule pack or a path of the enterprise folder', async () => {
    for (const hit of [NAME_VI, NAME_EN, PACK, 'src/editions/enterprise/index.ts', '@machvon/edition-enterprise']) {
      const publicDist = dist({ 'assets/index.js': `x("${hit}")` });
      assert.deepEqual(await codesOf(layout(), { publicDist: [publicDist] }), ['ENT_DIST_HOLDS_ENTERPRISE'], hit);
    }
  });

  it('reports a source map that names the enterprise folder, and reads only the files a build is made of', async () => {
    const publicDist = dist({ 'assets/index.js.map': '{"sources":["../src/editions/enterprise/index.ts"]}', 'assets/logo.png': NAME_VI });
    assert.deepEqual(distHits(publicDist, [NAME_VI]), ['editions/enterprise']);
  });

  it('requires an enterprise build to carry the enterprise name, so that the scan is not blind', async () => {
    const good = dist({ 'assets/index.js': `x("${NAME_VI}")` });
    const blind = dist({ 'assets/index.js': 'x("Hệ thống quản lý đầu tư công")' });
    assert.deepEqual(await codesOf(layout(), { enterpriseDist: [good] }), []);
    assert.deepEqual(await codesOf(layout(), { enterpriseDist: [blind] }), ['ENT_DIST_LACKS_ENTERPRISE']);
  });

  it('reports a build that does not exist', async () => {
    const gone = join(tmpdir(), 'machvon-dist-not-here');
    assert.deepEqual(await codesOf(layout(), { publicDist: [gone], enterpriseDist: [gone] }), ['ENT_DIST_MISSING', 'ENT_DIST_MISSING']);
  });

  it('is run from the command line with --public-dist and --enterprise-dist', async () => {
    const publicDist = dist({ 'a.js': `x("${NAME_EN}")` });
    const enterpriseDist = dist({ 'a.js': `x("${NAME_VI}")` });
    const lines = [];
    const code = await main(['--root', layout(), '--public-dist', publicDist, '--enterprise-dist', enterpriseDist], (line) => lines.push(line));
    assert.equal(code, 1);
    assert.match(lines[0], /^ENT_DIST_HOLDS_ENTERPRISE: /);
    assert.match(lines.at(-1), /^1 edition finding\(s\)/);
  });
});

describe('the helpers', () => {
  it('knows the homes and the seams', () => {
    assert.equal(inEnterpriseHome('packages/edition-enterprise/src/index.ts'), true);
    assert.equal(inEnterpriseHome('apps/web/src/editions/enterprise/index.ts'), true);
    assert.equal(inEnterpriseHome('apps/mobile/lib/editions/enterprise/x.dart'), true);
    assert.equal(inEnterpriseHome('apps/api/src/editions/enterprise/hpm.controller.ts'), true);
    assert.equal(inEnterpriseHome('apps/api/src/editions/load-enterprise.ts'), false);
    assert.equal(inEnterpriseHome('apps/web/src/editions/load.ts'), false);
    assert.equal(mayImportEnterprise('apps/web/src/editions/load.ts'), true);
    assert.equal(mayImportEnterprise('apps/web/src/editions/edition.ts'), false);
    assert.equal(mayImportEnterprise('apps/api/src/editions/load-enterprise.ts'), true);
    assert.equal(mayImportEnterprise('apps/mobile/lib/app/edition_seam.dart'), true);
    assert.equal(mayImportEnterprise('apps/web/src/a.enterprise.test.tsx'), true);
    assert.equal(mayImportEnterprise('apps/mobile/test/a_enterprise_test.dart'), true);
  });

  it('reads the specifiers of TypeScript and of Dart', () => {
    assert.deepEqual(specifiersOf('a.ts', "import a from 'x';\nexport { b } from './y';\nconst c = await import('z');\nconst d = require('w');\n").sort(), ['./y', 'w', 'x', 'z']);
    assert.deepEqual(specifiersOf('a.dart', "import 'package:a/a.dart';\nexport \"b.dart\";\npart 'c.dart';\n// import 'no.dart';\n"), ['package:a/a.dart', 'b.dart', 'c.dart']);
  });

  it('names the enterprise edition by package, folder, alias or relative path', () => {
    assert.equal(namesEnterprise('apps/web/src/a.ts', '@machvon/edition-enterprise'), true);
    assert.equal(namesEnterprise('apps/web/src/a.ts', '@/editions/enterprise/x'), true);
    assert.equal(namesEnterprise('apps/web/src/a.ts', './editions/enterprise'), true);
    assert.equal(namesEnterprise('apps/web/src/a.ts', '../../../packages/edition-enterprise'), true);
    assert.equal(namesEnterprise('apps/web/src/a.ts', './editions/edition'), false);
    assert.equal(namesEnterprise('apps/web/src/a.ts', 'react'), false);
  });
});

describe('the code name in the surfaces of the public edition', () => {
  const PUBLIC_FILE = 'apps/web/src/shell/Brand.tsx';

  it('says it as a name: the word alone, in capitals or in Vietnamese in any case, with or without marks', () => {
    for (const line of ['MACHVON', 'Hệ thống MACHVON mở', 'Machvon', 'MACH VON', 'Mạch Vốn', 'MẠCH VỐN', 'mạch vốn thông suốt', 'Mach Von', "title: 'MACHVON open API'", 'Biểu tượng Mạch Vốn'.normalize('NFD')]) {
      assert.equal(namesCodeName(line), true, line);
    }
  });

  it('does not take an identifier for a name', () => {
    for (const line of ['@machvon/kernel', 'MACHVON_EDITION=enterprise', 'machvon_tokens', 'package:machvon_api_client/x.dart', 'vn.machvon.app', 'machvon.audit_event', 'MACHVON-PVFCCO', 'MachvonApp', "stanza ?? 'machvon'", 'Design/MACHVON_Design/x.json', 'docs/hdsd/machvon/x', 'machvon-api']) {
      assert.equal(namesCodeName(line), false, line);
    }
  });

  it('is found in a source, a catalogue, a resource and a guide of the public edition, with the file and the line', async () => {
    const files = {
      [PUBLIC_FILE]: "export const a = 1;\nexport const NAME = 'Mạch Vốn';\n",
      'apps/web/src/i18n/vi.json': '{ "logo.mark.alt": "Biểu tượng MACHVON" }\n',
      'apps/mobile/android/app/src/main/res/values/strings.xml': '<resources><string name="app_name">Mạch Vốn</string></resources>\n',
      'apps/mobile/ios/Runner/Info.plist': '<string>MACHVON uses the camera</string>\n',
      'apps/mobile/lib/features/x/strings.dart': "const a = 'Mạch vốn thông suốt';\n",
      'apps/api/src/modules/reports/x.ts': "pdf.setProducer('MACHVON');\n",
      'packages/kernel/src/messages/x.ts': "export const T = 'MACHVON';\n",
      'docs/open-api/openapi.json': '{ "info": { "title": "MACHVON open API" } }\n',
      'docs/admin-guide.md': '# Hướng dẫn quản trị hệ thống MACHVON\n',
      'brand/logo/logo-public-icon.svg': '<svg><title>MẠCH VỐN</title></svg>\n',
    };
    const { findings } = await checkEdition({ root: layout(files) });
    const found = findings.filter((entry) => entry.code === 'ENT_CODE_NAME_IN_PUBLIC_SURFACE');
    assert.deepEqual(found.map((entry) => entry.file).sort(), Object.keys(files).sort());
    assert.match(found.find((entry) => entry.file === PUBLIC_FILE).message, /^line 2 /);
  });

  it('is not found in what is not shown: comments, tests, the enterprise files and the files of a build tool', async () => {
    const files = {
      [PUBLIC_FILE]: "// the code name MACHVON stays internal\n/** Mạch Vốn is the enterprise product */\nexport const a = 1;\n",
      'apps/mobile/lib/features/x/strings.dart': "/// The MACHVON API client.\n// Mạch Vốn\nconst a = 1;\n",
      'apps/mobile/android/app/src/main/AndroidManifest.xml': '<!-- the name of MACHVON -->\n<application />\n',
      'apps/web/src/shell/Brand.test.tsx': "expect(x).toBe('Mạch Vốn');\n",
      'apps/web/src/screens/sas/test-support.tsx': "export const T = { name: 'MACHVON' };\n",
      'apps/web/e2e/a.spec.ts': "const a = 'MACHVON';\n",
      'apps/web/src/editions/enterprise/overlay.vi.json': '{ "shell.brand.name.text": "Mạch Vốn" }\n',
      'apps/mobile/lib/editions/enterprise/enterprise_home_strings.dart': "const a = 'Mạch Vốn';\n",
      'apps/mobile/android/app/src/enterprise/res/values/strings.xml': '<string name="app_name">Mạch Vốn</string>\n',
      'brand/logo/logo-enterprise-icon.svg': '<svg><title>MẠCH VỐN</title></svg>\n',
      'docs/integration/hpm-proposal.md': 'MACHVON gọi API của HPM\n',
      'apps/mobile/qa/device/results/walk.json': '{ "heading": "Biểu trưng MACHVON" }\n',
    };
    const { findings } = await checkEdition({ root: layout(files) });
    assert.deepEqual(findings.filter((entry) => entry.code === 'ENT_CODE_NAME_IN_PUBLIC_SURFACE'), []);
  });

  it('is found in a public build, never in a build made as the enterprise edition by this rule', () => {
    const dist = mkdtempSync(join(tmpdir(), 'machvon-dist-'));
    scratch.push(dist);
    writeFileSync(join(dist, 'index.html'), '<title>Hệ thống quản lý đầu tư công</title>\n');
    writeFileSync(join(dist, 'app.js'), 'const a = 1;\nconst brand = "Biểu tượng Mạch Vốn";\n');
    writeFileSync(join(dist, 'app.js.map'), '{"sources":["Mạch Vốn"]}\n');
    const hits = distCodeNameHits(dist);
    assert.equal(hits.length, 1);
    assert.match(hits[0].file, /app\.js$/);
    assert.match(hits[0].line, /Mạch Vốn/);
  });

  it('is reported with its own code by the command line, and the code is a registered one', async () => {
    assert.ok(FINDING_CODES.includes('ENT_CODE_NAME_IN_PUBLIC_SURFACE'));
    assert.ok(FINDING_CODES.includes('ENT_BRAND_DRIFT'));
    const lines = [];
    assert.equal(await main(['--root', layout({ [PUBLIC_FILE]: "export const NAME = 'MACHVON';\n" })], (line) => lines.push(line)), 1);
    assert.match(lines.join('\n'), /ENT_CODE_NAME_IN_PUBLIC_SURFACE: apps\/web\/src\/shell\/Brand\.tsx: line 1 /);
  });
});

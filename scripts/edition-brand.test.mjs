import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ENTERPRISE_DART, PUBLIC_DART, androidText, brandDrift, dartString, generatedFiles, main, staticNames, writeBrand } from './edition-brand.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = [];

const brandOf = (name, launcherEn = name) => `brand: {
    mark: { vi: 'XX', en: 'XX' },
    shortName: { vi: '${name}', en: '${name}' },
    launcherName: { vi: '${name}', en: '${launcherEn}' },
    logoAlt: { vi: 'Biểu tượng ${name}', en: '${name} logo' },
    tagline: { vi: 'Khẩu hiệu', en: "It's the tagline" },
  },`;
const PUBLIC_MANIFEST = `export const PUBLIC_EDITION_MANIFEST = {
  edition: 'public',
  productName: { vi: 'Sản phẩm công', en: 'Public product' },
  ${brandOf('Công', 'Public')}
};
`;
const ENTERPRISE_MANIFEST = `export const ENTERPRISE_EDITION_MANIFEST = {
  edition: 'enterprise',
  productName: { vi: 'Sản phẩm doanh nghiệp', en: 'Enterprise product' },
  ${brandOf('Doanh')}
};
`;
const PLIST = '<dict>\n\t<key>CFBundleDisplayName</key>\n\t<string>Cũ</string>\n</dict>\n';

function layout(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'machvon-brand-'));
  scratch.push(root);
  const files = {
    'package.json': '{"type":"module"}\n',
    'packages/kernel/src/edition.ts': PUBLIC_MANIFEST,
    'packages/edition-enterprise/src/manifest.ts': ENTERPRISE_MANIFEST,
    'apps/mobile/ios/Runner/Info.plist': PLIST,
    'apps/web/index.html': '<html><head><title>Sản phẩm công</title></head><body><p class="boot-name">Sản phẩm công</p></body></html>\n',
    'apps/web/src/pwa/sw-texts.json': JSON.stringify({ vi: { appName: 'Sản phẩm công' }, en: { appName: 'Public product' } }),
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

after(() => {
  for (const root of scratch) rmSync(root, { recursive: true, force: true });
});

describe('the names of the product, from the edition manifests', () => {
  it('are current in the repository: the generated phone files and the static web names equal the manifests', async () => {
    assert.deepEqual(await brandDrift(REPO), []);
    const lines = [];
    assert.equal(await main([], (line) => lines.push(line)), 0);
    assert.match(lines.join('\n'), /equal the edition manifests/);
  });

  it('read the public names the way the owner decided: the system name, the launcher name and the logo label', async () => {
    const dart = (await generatedFiles(REPO)).find((file) => file.path === PUBLIC_DART).text;
    assert.match(dart, /kPublicProductNameVi = 'Hệ thống quản lý đầu tư công'/);
    assert.match(dart, /kPublicProductNameEn = 'Public Investment Management System'/);
    assert.match(dart, /kPublicLauncherNameVi = 'Đầu tư công'/);
    assert.match(dart, /kPublicLauncherNameEn = 'Public Investment'/);
    assert.match(dart, /kPublicLogoAltVi = 'Biểu tượng Hệ thống quản lý đầu tư công'/);
    const android = (await generatedFiles(REPO)).filter((file) => file.path.startsWith('apps/mobile/android/app/src/main/'));
    assert.deepEqual(android.map((file) => file.path).sort(), ['apps/mobile/android/app/src/main/res/values-en/strings.xml', 'apps/mobile/android/app/src/main/res/values/strings.xml']);
    assert.match(android.find((file) => file.path.endsWith('values/strings.xml')).text, /<string name="app_name">Đầu tư công<\/string>/);
    assert.match(android.find((file) => file.path.endsWith('values-en/strings.xml')).text, /<string name="app_name">Public Investment<\/string>/);
    assert.equal(staticNames(REPO).plistDisplayName, 'Đầu tư công');
  });

  it('keep the enterprise identity in the enterprise files only', async () => {
    const files = await generatedFiles(REPO);
    const enterprise = files.filter((file) => file.path.includes('enterprise'));
    assert.deepEqual(enterprise.map((file) => file.path).sort(), [ENTERPRISE_DART, 'apps/mobile/android/app/src/enterprise/res/values/strings.xml', 'apps/mobile/android/app/src/enterprise/res/values-en/strings.xml'].sort());
    assert.match(enterprise.find((file) => file.path === ENTERPRISE_DART).text, /kEnterpriseLauncherNameVi = 'Mạch Vốn'/);
    for (const file of files.filter((entry) => !entry.path.includes('enterprise'))) assert.doesNotMatch(file.text, /Mạch Vốn|MACHVON/i, file.path);
  });

  it('escape what Dart and Android do not take as it is', () => {
    assert.equal(dartString("it's $5 \\ a\nb"), "'it\\'s \\$5 \\\\ a\\nb'");
    assert.equal(androidText(`Tom & "Jerry" <it's>`), `Tom &amp; \\"Jerry\\" &lt;it\\'s&gt;`);
  });
});

describe('a layout with its own manifests', () => {
  it('is out of date until it is written, then current, in every file it generates', async () => {
    const root = layout();
    const before = await brandDrift(root);
    assert.ok(before.some((entry) => entry.file === PUBLIC_DART && /missing/.test(entry.message)));
    assert.ok(before.some((entry) => entry.file === 'apps/mobile/ios/Runner/Info.plist' && /CFBundleDisplayName/.test(entry.message)));
    const written = await writeBrand(root);
    assert.ok(written.includes(PUBLIC_DART) && written.includes(ENTERPRISE_DART) && written.includes('apps/mobile/ios/Runner/Info.plist'));
    assert.deepEqual(await brandDrift(root), []);
    assert.match(readFileSync(join(root, 'apps/mobile/ios/Runner/Info.plist'), 'utf8'), /<string>Công<\/string>/);
    assert.match(readFileSync(join(root, PUBLIC_DART), 'utf8'), /kPublicTaglineEn = 'It\\'s the tagline'/);
    assert.ok(existsSync(join(root, 'apps/mobile/android/app/src/main/res/values-en/strings.xml')), 'the English launcher name differs, so it has its own resource');
    assert.ok(existsSync(join(root, 'apps/mobile/android/app/src/enterprise/res/values-en/strings.xml')), 'the enterprise build overrides the English name of the main resources even when its two names are equal');
    assert.deepEqual(await writeBrand(root), [], 'a second write changes nothing');
  });

  it('sees a generated file that was edited by hand, and a static name that is not the product name', async () => {
    const root = layout();
    await writeBrand(root);
    writeFileSync(join(root, PUBLIC_DART), readFileSync(join(root, PUBLIC_DART), 'utf8').replace('Công', 'Khác'));
    writeFileSync(join(root, 'apps/web/index.html'), readFileSync(join(root, 'apps/web/index.html'), 'utf8').replace('<title>Sản phẩm công', '<title>Tên khác'));
    writeFileSync(join(root, 'apps/web/src/pwa/sw-texts.json'), JSON.stringify({ vi: { appName: 'Sai' }, en: { appName: 'Wrong' } }));
    const drift = await brandDrift(root);
    assert.ok(drift.some((entry) => entry.file === PUBLIC_DART && /not what the edition manifest says/.test(entry.message)));
    assert.ok(drift.some((entry) => entry.file === 'apps/web/index.html' && /the title/.test(entry.message)));
    assert.ok(drift.some((entry) => entry.file === 'apps/web/src/pwa/sw-texts.json' && /application name/.test(entry.message)));
    assert.ok(drift.some((entry) => entry.file === 'apps/web/src/pwa/sw-texts.json' && /English/.test(entry.message)));
    const lines = [];
    assert.equal(await main([], (line) => lines.push(line), root), 1);
    assert.match(lines.join('\n'), /BRAND_DRIFT: .*edition_brand\.g\.dart/);
  });

  it('keeps the line endings of a file it rewrites', async () => {
    const root = layout();
    await writeBrand(root);
    const target = join(root, PUBLIC_DART);
    writeFileSync(target, readFileSync(target, 'utf8').replace(/\n/g, '\r\n').replace('Công', 'Khác'));
    assert.deepEqual(await brandDrift(root), [{ file: PUBLIC_DART, message: 'is not what the edition manifest says; run node scripts/edition-brand.mjs --write' }]);
    await writeBrand(root);
    const text = readFileSync(target, 'utf8');
    assert.ok(text.includes('\r\n') && !/[^\r]\n/.test(text), 'still CRLF');
    assert.deepEqual(await brandDrift(root), []);
  });

  it('says nothing when a manifest is absent: a layout without editions has nothing to hold', async () => {
    const root = mkdtempSync(join(tmpdir(), 'machvon-brand-'));
    scratch.push(root);
    assert.deepEqual(await generatedFiles(root), []);
    assert.deepEqual(await brandDrift(root), []);
    assert.deepEqual(await writeBrand(root), []);
    const lines = [];
    assert.equal(await main(['--write'], (line) => lines.push(line), root), 0);
    assert.match(lines.join('\n'), /current/);
  });
});

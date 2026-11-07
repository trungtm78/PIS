import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { architectureCheck, main } from './architecture-check.mjs';

function layout(files) {
  const root = mkdtempSync(join(tmpdir(), 'machvon-arch-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const BASE = {
  'packages/kernel/src/index.ts': 'export const KERNEL = 1;\n',
  'packages/db/src/index.ts': "import { KERNEL } from '@machvon/kernel';\nexport const DB = KERNEL;\n",
  'packages/contracts/src/index.ts': 'export const CONTRACTS = 1;\n',
  'apps/api/src/main.ts': "import { DB } from '@machvon/db';\nexport const API = DB;\n",
};

test('a clean layout returns no violations', async () => {
  const root = layout(BASE);
  try {
    assert.deepEqual(await architectureCheck(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('kernel importing another package is reported with file and specifier (AC-ST-KERNEL-010-1)', async () => {
  const root = layout({ ...BASE, 'packages/kernel/src/bad.ts': "import '@machvon/db';\n" });
  try {
    assert.deepEqual(await architectureCheck(root), ['packages/kernel/src/bad.ts -> @machvon/db']);
    rmSync(join(root, 'packages/kernel/src/bad.ts'));
    assert.deepEqual(await architectureCheck(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('kernel importing a package by relative path is reported', async () => {
  const root = layout({ ...BASE, 'packages/kernel/src/bad.ts': "import { DB } from '../../db/src/index';\nexport const X = DB;\n" });
  try {
    assert.deepEqual(await architectureCheck(root), ['packages/kernel/src/bad.ts -> ../../db/src/index']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a package importing an app is reported (AC-ST-KERNEL-010-1)', async () => {
  const root = layout({ ...BASE, 'packages/contracts/src/bad.ts': "import '@machvon/api';\n" });
  try {
    assert.deepEqual(await architectureCheck(root), ['packages/contracts/src/bad.ts -> @machvon/api']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('type-only imports count as dependencies', async () => {
  const root = layout({ ...BASE, 'packages/kernel/src/bad.ts': "import type { Foo } from '@machvon/contracts';\nexport type Bar = Foo;\n" });
  try {
    assert.deepEqual(await architectureCheck(root), ['packages/kernel/src/bad.ts -> @machvon/contracts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main prints violations and returns exit code 1, or 0 when clean', async () => {
  const bad = layout({ ...BASE, 'packages/kernel/src/bad.ts': "import '@machvon/db';\n" });
  const good = layout(BASE);
  try {
    const lines = [];
    assert.equal(await main(['--root', bad, '--locale', 'en'], { log: (line) => lines.push(line) }), 1);
    assert.ok(lines.some((line) => line.includes('packages/kernel/src/bad.ts -> @machvon/db')));
    const clean = [];
    assert.equal(await main(['--root', good, '--locale', 'en'], { log: (line) => clean.push(line) }), 0);
    assert.equal(clean.length, 1);
    const vi = [];
    assert.equal(await main(['--root', good], { log: (line) => vi.push(line) }), 0);
    assert.notEqual(vi[0], clean[0]);
  } finally {
    rmSync(bad, { recursive: true, force: true });
    rmSync(good, { recursive: true, force: true });
  }
});

test('a root without apps or packages directories has nothing to check', async () => {
  const root = layout({ 'README.md': 'empty\n' });
  try {
    assert.deepEqual(await architectureCheck(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const forbidden of ['@machvon/db', '@machvon/kernel', '@machvon/api']) {
  test(`apps/web importing ${forbidden} is reported`, async () => {
    const root = layout({ ...BASE, 'apps/web/src/bad.ts': `import '${forbidden}';\n` });
    try {
      assert.deepEqual(await architectureCheck(root), [`apps/web/src/bad.ts -> ${forbidden}`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('apps/web importing the api app by relative path is reported', async () => {
  const root = layout({ ...BASE, 'apps/web/src/bad.ts': "import { API } from '../../api/src/main';\nexport const X = API;\n" });
  try {
    assert.deepEqual(await architectureCheck(root), ['apps/web/src/bad.ts -> ../../api/src/main']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the design tokens package may import nothing from other workspaces', async () => {
  for (const forbidden of ['@machvon/kernel', '@machvon/contracts', '@machvon/api-client', '@machvon/db']) {
    const root = layout({ ...BASE, 'packages/design-tokens/src/bad.ts': `import '${forbidden}';\n` });
    try {
      assert.deepEqual(await architectureCheck(root), [`packages/design-tokens/src/bad.ts -> ${forbidden}`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('the api client may import contracts but not the kernel, the database, the tokens or an app', async () => {
  for (const forbidden of ['@machvon/kernel', '@machvon/db', '@machvon/design-tokens', '@machvon/web']) {
    const root = layout({ ...BASE, 'packages/api-client/src/bad.ts': `import '${forbidden}';\n` });
    try {
      assert.deepEqual(await architectureCheck(root), [`packages/api-client/src/bad.ts -> ${forbidden}`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('kernel importing the new packages, and a package importing the web app, are reported', async () => {
  const root = layout({
    ...BASE,
    'packages/kernel/src/bad.ts': "import '@machvon/api-client';\nimport '@machvon/design-tokens';\n",
    'packages/contracts/src/bad.ts': "import '@machvon/web';\n",
  });
  try {
    assert.deepEqual((await architectureCheck(root)).sort(), [
      'packages/contracts/src/bad.ts -> @machvon/web',
      'packages/kernel/src/bad.ts -> @machvon/api-client',
      'packages/kernel/src/bad.ts -> @machvon/design-tokens',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the api app importing the web app is reported', async () => {
  const root = layout({ ...BASE, 'apps/api/src/bad.ts': "import '@machvon/web';\n" });
  try {
    assert.deepEqual(await architectureCheck(root), ['apps/api/src/bad.ts -> @machvon/web']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the web may read the edition file of the kernel and no other file of it (ENT-0)', async () => {
  const root = layout({
    ...BASE,
    'packages/kernel/src/edition.ts': 'export const EDITION = 1;\n',
    'apps/web/src/ok.ts': "import '@machvon/kernel/src/edition.ts';\n",
    'apps/web/src/bad.ts': "import '@machvon/kernel';\nimport '@machvon/kernel/src/index.ts';\n",
  });
  try {
    assert.deepEqual((await architectureCheck(root)).sort(), ['apps/web/src/bad.ts -> @machvon/kernel', 'apps/web/src/bad.ts -> @machvon/kernel/src/index.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the enterprise edition is imported only from its homes, the loaders and the tests named for it (ENT-0)', async () => {
  const root = layout({
    ...BASE,
    'packages/edition-enterprise/src/index.ts': 'export const ENTERPRISE = 1;\n',
    'apps/web/src/editions/enterprise/index.ts': "import '@machvon/edition-enterprise';\n",
    'apps/web/src/editions/load.ts': "export const load = () => import('./enterprise/index');\n",
    'apps/web/src/editions/overlay.enterprise.test.ts': "import './enterprise/index';\n",
    'apps/api/src/editions/load-enterprise.ts': "import '@machvon/edition-enterprise';\n",
    'apps/web/src/bad.ts': "import './editions/enterprise/index';\n",
    'apps/api/src/bad.ts': "import '@machvon/edition-enterprise';\n",
    'packages/db/src/bad.ts': "import '@machvon/edition-enterprise';\n",
  });
  try {
    assert.deepEqual((await architectureCheck(root)).sort(), [
      'apps/api/src/bad.ts -> @machvon/edition-enterprise',
      'apps/web/src/bad.ts -> ./editions/enterprise/index',
      'packages/db/src/bad.ts -> @machvon/edition-enterprise',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the kernel does not import the enterprise package', async () => {
  const root = layout({ ...BASE, 'packages/edition-enterprise/src/index.ts': 'export const ENTERPRISE = 1;\n', 'packages/kernel/src/bad.ts': "import '@machvon/edition-enterprise';\n" });
  try {
    // Two rules say no: the kernel imports nothing from the packages, and only the homes and the loaders name the enterprise edition.
    assert.deepEqual(await architectureCheck(root), ['packages/kernel/src/bad.ts -> @machvon/edition-enterprise', 'packages/kernel/src/bad.ts -> @machvon/edition-enterprise']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
